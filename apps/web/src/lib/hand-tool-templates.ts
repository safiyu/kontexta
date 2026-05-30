import type { ToolDef } from "@/components/docs/tool-form";

export interface HandToolTemplate {
  name: string;
  oneLiner: string;
  def: ToolDef;
}

export const HAND_TOOL_TEMPLATES: HandToolTemplate[] = [
  {
    name: "list-files",
    oneLiner: "Lists every git-tracked file. Read-only, no params.",
    def: {
      description: "List files in the repo (no params, completely safe)",
      command: ["git", "ls-files"],
    },
  },
  {
    name: "run-tests",
    oneLiner: "Run vitest with an optional regex-validated filter.",
    def: {
      description: "Run vitest with optional filter (regex-validated)",
      command: ["npx", "vitest", "--reporter=verbose", "{{filter}}"],
      timeout: 120000,
      params: {
        filter: { type: "string", required: false, default: "", pattern: "^[a-zA-Z0-9 _/-]*$" },
      },
    },
  },
  {
    name: "deploy-staging",
    oneLiner: "Deploy to staging Cloud Run. Requires human approval.",
    def: {
      description: "Deploy to staging Cloud Run (requires human approval)",
      command: ["gcloud", "run", "deploy", "my-service", "--region", "us-central1"],
      danger: "moderate",
      confirm: true,
      timeout: 180000,
    },
  },
  {
    name: "remove-temp",
    oneLiner: "Delete a file under tmp/scratch. Strict pattern + argSeparator.",
    def: {
      description: "Delete a temp file under /tmp/scratch (argSeparator guards path)",
      command: ["rm", "{{name}}"],
      argSeparator: true,
      workingDir: "tmp/scratch",
      params: {
        name: { type: "string", required: true, pattern: "^[a-zA-Z0-9._-]+$" },
      },
    },
  },
  {
    name: "npm-install",
    oneLiner: "Safely install a new npm package. Restricted to safe package names.",
    def: {
      description: "Install a new dependency via npm",
      command: ["npm", "install", "{{pkg}}"],
      danger: "moderate",
      params: {
        pkg: { type: "string", required: true, pattern: "^@?[a-z0-9][a-z0-9-._]*$" }
      }
    }
  },
  {
    name: "type-check",
    oneLiner: "Run the TypeScript compiler to catch type errors project-wide.",
    def: {
      description: "Run tsc without emitting files to check for type errors.",
      command: ["npx", "tsc", "--noEmit"],
      timeout: 60000
    }
  },
  {
    name: "lint-fix",
    oneLiner: "Run ESLint to automatically correct code style and auto-fixable errors.",
    def: {
      description: "Auto-fix linting and formatting issues.",
      command: ["npx", "eslint", ".", "--fix"],
      danger: "moderate",
      timeout: 120000
    }
  },
  {
    name: "comprehensive-example",
    oneLiner: "Showcase: params, env, workingDir, confirm, danger, and argSeparator.",
    def: {
      description: "A comprehensive example showing off every kontexta.json capability. Use this to understand how to build complex, secure tools.",
      command: ["./scripts/deploy.sh", "--target", "{{targetEnv}}", "--dry-run={{isDryRun}}", "--retries={{retries}}"],
      workingDir: "backend",
      timeout: 300000,
      danger: "high",
      confirm: true,
      argSeparator: true,
      maxOutputBytes: 1048576,
      env: {
        "FORCE_COLOR": "1",
        "DEBUG": "true"
      },
      params: {
        targetEnv: { type: "string", required: true, pattern: "^(staging|production|qa)$" },
        isDryRun: { type: "boolean", required: false, default: true },
        retries: { type: "number", required: false, default: 3, min: 0, max: 10 }
      },
    },
  },
];
