import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "archiver", "jsdom", "oniguruma", "re2", "kontexta-mcp"],
  experimental: {
    outputFileTracingIncludes: {
      "**/*": [
        "../../packages/core/src/agent-rules/rules-block.md",
        "../../packages/core/src/db/migrations/*.sql",
        "../../CHANGELOG.md",
      ],
    },
  },
  webpack: (config, { isServer }) => {
    // jsdom, oniguruma, and re2 are native server-only modules loaded dynamically at runtime.
    // We must stub them so webpack never tries to bundle or resolve them.
    const nativeExternals = ["jsdom", "oniguruma", "re2"];

    if (isServer) {
      // On the server, mark as externals so they're required at runtime (not bundled)
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : config.externals ? [config.externals] : []),
        ...nativeExternals,
      ];
    } else {
      // On the client, alias to false (empty module) since they can't run in the browser
      config.resolve.alias = {
        ...config.resolve.alias,
        ...Object.fromEntries(nativeExternals.map((m) => [m, false])),
      };
    }
    return config;
  },
};
export default nextConfig;
