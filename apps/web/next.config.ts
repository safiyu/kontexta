import type { NextConfig } from "next";

// Native / server-only packages. `serverExternalPackages` covers turbopack
// and most webpack production paths, but webpack dev (HMR) still
// re-evaluates these and trips "Module did not self-register" on
// better-sqlite3. The webpack callback below adds them to externals so
// they're require()'d at runtime instead of bundled.
const NATIVE_SERVER_ONLY = ["better-sqlite3", "archiver", "jsdom", "oniguruma", "re2", "kontexta-mcp"];

const nextConfig: NextConfig = {
  output: "standalone",
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
    ],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Require at runtime — never bundle or re-evaluate. Critical for
      // native bindings (better-sqlite3, re2) which can only self-register
      // once per process.
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : config.externals ? [config.externals] : []),
        ...NATIVE_SERVER_ONLY,
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
