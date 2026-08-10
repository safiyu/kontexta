import type { NextConfig } from "next";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const configDir = dirname(fileURLToPath(import.meta.url));

// Native / server-only packages. `serverExternalPackages` covers turbopack
// and most webpack production paths, but webpack dev (HMR) still
// re-evaluates these and trips "Module did not self-register" on
// better-sqlite3. The webpack callback below adds them to externals so
// they're require()'d at runtime instead of bundled.
const NATIVE_SERVER_ONLY = [
  "better-sqlite3", "archiver", "jsdom", "oniguruma", "re2", "kontexta-mcp",
  // Not a native binding, but must stay unbundled for a different reason:
  // kxta-publish's PDF export (pdfmake -> pdfkit) loads pdfkit's standard-14
  // font metrics (*.afm) via a path built from pdfkit's own __dirname at
  // runtime. Webpack bundling relocates the CODE into the route's single
  // output file but not the co-located .afm files, so __dirname no longer
  // points anywhere near them — every export then fails with ENOENT.
  // require()'ing kxta-publish at runtime instead (like the rest of this
  // list) keeps pdfkit's own module layout — and therefore __dirname —
  // intact. apps/web depends on kxta-publish directly (a real, resolvable
  // workspace symlink), which is why THIS is the right thing to externalize
  // rather than pdfmake/pdfkit themselves, which apps/web can't resolve
  // directly at all (see the outputFileTracingIncludes comment below).
  "kxta-publish",
  "kxta-publish/render/pdf",
];

// pdfkit's *.afm font-metric files (see above) are loaded with a dynamic
// path join at runtime, not a static require() — Next's output-file tracer
// can't follow that, so standalone builds still silently omit them (this is
// a separate problem from bundling: it applies regardless of whether pdfkit
// is externalized or not) unless explicitly listed here.
//
// apps/web doesn't depend on pdfmake/pdfkit directly (only on kxta-publish,
// which exports a strict `exports` map with no `./package.json` subpath),
// so plain require.resolve("pdfkit/...") from here fails. Walk the real
// resolution chain instead — apps/web -> kxta-publish -> pdfmake -> pdfkit —
// via createRequire scoped to each package, so the result is correct
// regardless of pnpm's hoisting/hash-versioned directory names and stays
// correct across version bumps.
const kxtaPublishDir = join(dirname(require.resolve("kxta-publish/render/pdf")), "..", "..");
const publishRequire = createRequire(join(kxtaPublishDir, "package.json"));
const pdfmakeDir = dirname(publishRequire.resolve("pdfmake/package.json"));
const pdfmakeRequire = createRequire(join(pdfmakeDir, "package.json"));
const pdfkitDataDir = dirname(pdfmakeRequire.resolve("pdfkit/js/data/Helvetica.afm"));
const pdfkitDataGlob = "./" + relative(configDir, pdfkitDataDir) + "/*.afm";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the file tracer to the monorepo root. Without this, Next infers a
  // workspace root by walking up for lockfiles; on Windows (notably GitHub
  // runners) that inference can land on the user profile dir, and tracing
  // then scandirs protected junctions like "C:\Users\<u>\Application Data"
  // — failing the whole build with EPERM.
  outputFileTracingRoot: join(configDir, "..", ".."),
  serverExternalPackages: NATIVE_SERVER_ONLY,
  // Cloud Workstations / proxied dev environments serve the page from a
  // hostname different from `localhost`. Next 15 logs a "Cross origin
  // request detected" warning and will block it in a future major. Wildcard
  // matches any port-prefixed workstation hostname; add your own here if
  // you proxy through a different domain.
  allowedDevOrigins: ["*.cloudworkstations.dev", "*.cluster-*.cloudworkstations.dev"],
  outputFileTracingIncludes: {
    "**/*": [
      "../../packages/core/src/agent-rules/rules-block.md",
      "../../packages/core/src/db/migrations/*.sql",
      "../../CHANGELOG.md",
      pdfkitDataGlob,
    ],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Require at runtime — never bundle or re-evaluate. Critical for
      // native bindings (better-sqlite3, re2) which can only self-register
      // once per process.
      //
      // A plain string entry only externalizes an EXACT request match, not
      // subpath imports (e.g. "kxta-publish/render/pdf" would still get
      // bundled with a bare "kxta-publish" string entry, silently — this bit
      // the PDF export route). Match the package name or any subpath of it.
      const externalizeFn = ({ request }: { request?: string }, callback: (err?: null, result?: string) => void) => {
        if (request && NATIVE_SERVER_ONLY.some((name) => request === name || request.startsWith(name + "/"))) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      };
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : config.externals ? [config.externals] : []),
        externalizeFn,
      ];
    } else {
      // On the client, alias to false (empty module) since they can't run in the browser.
      config.resolve.alias = {
        ...config.resolve.alias,
        ...Object.fromEntries(NATIVE_SERVER_ONLY.map((m) => [m, false])),
      };
    }
    return config;
  },
};
export default nextConfig;
