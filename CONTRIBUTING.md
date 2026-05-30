# Contributing to Kontexta

Thank you for your interest in contributing to Kontexta! This project aims to provide the most reliable, deterministic context-management layer for AI coding agents. By contributing, you're helping build a smarter, local-first future for agentic workflows.

## Architecture: Brain, Hands, Eyes

Kontexta is built around a closed-loop feedback system:
- **Brain (Context Engine)**: Managing the markdown knowledge vault and surgical context retrieval.
- **Hands (Action Engine)**: Orchestrating project-defined commands via the `kontexta.json` sandbox.
- **Eyes (Feedback Engine)**: Documenting session outcomes and learning from past turns.

When contributing new features, consider how they fit into this loop and prioritize **token economy** and **determinism**.

## Project Structure

This is a monorepo managed by `pnpm` and `turbo`.

- `packages/core`: The underlying logic for database management, file indexing, and git operations.
- `apps/mcp`: The MCP (Model Context Protocol) server that exposes the Brain and Hands to AI agents.
- `apps/web`: The Next.js-based dashboard for visual context management and configuration.

## Getting Started

### Prerequisites
- **Node.js**: v20 or higher.
- **pnpm**: v9 or higher.

### Local Setup
1. Clone the repository:
   ```bash
   git clone https://github.com/safiyu/kontexta.git
   cd kontexta
   ```
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Build the project:
   ```bash
   pnpm build
   ```

## Development Workflow

### Developing the MCP Server
To work on the MCP server logic:
```bash
cd apps/mcp
pnpm dev
```
You can then link this to your AI client (like Claude Desktop or Cursor) by pointing to the absolute path of `apps/mcp/dist/index.js`.

### Developing the Web Dashboard
To work on the UI:
```bash
cd apps/web
pnpm dev
```
The dashboard will be available at `http://localhost:3000`.

### Running Tests
We use `vitest` for unit tests and a custom smoke-test harness for the MCP tools.
```bash
# Run all tests
pnpm test

# Run specific package tests
pnpm -C packages/core test
pnpm -C apps/mcp test
```

## Coding Standards

### 1. Token Awareness
Every new MCP tool should return an estimated token count (`est_tokens`) in its response. This allows agents to budget their context window effectively.

### 2. Surgical Edits
Favor tools that work on specific file sections or line ranges rather than full-file replacements whenever possible.

### 3. Security (Hands)
All "Hand" tools (command orchestration) must run in the established sandbox. Never use `shell: true` when spawning processes, and ensure all inputs are validated against the `re2` regex engine.

### 4. Security Review Checklist (all tools)
Before merging any PR that adds an MCP tool, web route, or core helper, verify each item that applies:

- **Outbound HTTP** — must call `assertPublicHost()` (in `packages/core/src/clip/extract.ts`) on the parsed URL **before every hop**. Use `redirect: "manual"` and re-validate after each `Location` header. Never use `redirect: "follow"` with untrusted input — a public URL can 302 into the cloud-metadata service. Cap response size with a streaming reader (see `readBodyWithCap`); never call `res.text()` on an unbounded body.
- **Directory walks** — use `lstatSync`, not `statSync`, and `continue` on `isSymbolicLink()`. Following symlinks can loop forever and can leak content from outside the intended root.
- **FTS index writes** — always `DELETE FROM fts_index WHERE rowid = ?` before `INSERT INTO fts_index`, even on the "new file" path. A stale row left by a crashed transaction will otherwise UNIQUE-fail the insert and abort the whole batch.
- **Paths read from DB rows** — do not trust `fileRecord.path` (or any stored path) as still being inside its current project/KB base. Re-validate with `assertPathInside` (or the same `resolve()` + `startsWith(base + sep)` pattern) on **both** source and destination.
- **HTTP response headers** — any value derived from file content, DB rows, or user input that ends up in a header (`Content-Disposition`, `Location`, etc.) must have CR/LF and control characters stripped. Use the `filename*` (RFC 5987) form for non-ASCII.
- **Spawned processes** — `shell: false`, literal `argv[0]` (no `{{...}}` substitutions), `re2` patterns on every string param.
- **External URLs in tool descriptions** — must be HTTPS and stable; the description text ships to every agent and is not editable per-install.

### 5. Conventional Commits
We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:
- `feat:` for new features.
- `fix:` for bug fixes.
- `docs:` for documentation changes.
- `chore:` for maintenance (version bumps, dependency updates).

## Pull Request Process

1. Create a new branch for your feature or fix.
2. Ensure all tests pass (`pnpm test`).
3. Add a CHANGELOG entry. We do not maintain an "Unreleased" section — add your bullet directly under the heading of the version that will ship your change (the maintainer will create the heading on bump if it doesn't exist yet). Group entries under `### Security`, `### Reliability`, `### Added`, `### Changed`, or `### Fixed` as appropriate.
4. Submit your PR with a clear description of the problem solved and the architectural impact.

## Releasing (maintainers)

Kontexta publishes from `main`. To cut a release:

1. Edit the **root** `package.json` `version` field — this is the single source of truth.
2. Run `pnpm version:sync` (alias for `node scripts/sync-versions.js`). It propagates the root version to:
   - `apps/mcp/package.json`
   - `apps/web/package.json`
   - `packages/core/package.json`
   - `glama.json`
   Never hand-edit these — drift between them is what `version:sync` exists to prevent.
3. Add the dated heading and grouped bullets to `CHANGELOG.md`.
4. Commit (`chore: release vX.Y.Z`), tag, push, then `pnpm -C apps/mcp publish` for the npm package.
5. The MCP server reads its advertised version at runtime by walking up from the bundled module to find `kontexta-mcp/package.json` — no rebuild step is required when only the version changes, but you do need to rebuild for the published artifact.

## License
By contributing to Kontexta, you agree that your contributions will be licensed under the project's [Apache-2.0 License](LICENSE).
