export type Danger = "safe" | "moderate" | "high";
export type ParamType = "string" | "number" | "boolean";

export interface ParamDef {
  type: ParamType;
  required?: boolean;
  default?: string | number | boolean;
  pattern?: string;
  min?: number;
  max?: number;
}

export interface HandToolDef {
  description: string;
  command: string[];
  workingDir?: string;
  timeout?: number;
  danger?: Danger;
  confirm?: boolean;
  disabled?: boolean;
  argSeparator?: boolean;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  params?: Record<string, ParamDef>;
}

export interface HandsConfig {
  version: "1";
  tools: Record<string, HandToolDef>;
}

export interface LoadResult {
  found: boolean;
  tools: Record<string, HandToolDef>;
  disabled: string[];
  warnings: string[];
  errors: string[];
}

export type ExecStatus = "success" | "failed" | "timeout" | "rejected";

export interface ExecResult {
  status: ExecStatus;
  exitCode: number | null;
  durationMs: number;
  workingDir: string;
  stdout: string;
  stderr: string;
  resolvedArgv: string[];
  rejectionReason?: string;
  truncated?: { stdout: number; stderr: number };
}

