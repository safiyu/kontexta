import type { ToolDef } from "@/components/docs/tool-form-modal";

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
];
