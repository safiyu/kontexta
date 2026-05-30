export type HandsRunStatus = "ok" | "fail" | "pending";

export interface HandsRun {
  id: string;
  label: string;
  status: HandsRunStatus;
  children?: HandsRun[];
}

export interface HandsRunTraceProps {
  run: HandsRun;
}

const ROW_HEIGHT = 28;
const NODE_X = 20;
const LABEL_X = 40;
const RADIUS = 3;

function nodeColor(status: HandsRunStatus): string {
  if (status === "ok") return "var(--accent)";
  if (status === "fail") return "var(--danger, #C05656)";
  return "var(--border)";
}

function statusText(status: HandsRunStatus): string {
  if (status === "ok") return "ok";
  if (status === "fail") return "fail";
  return "pending";
}

export function HandsRunTrace({ run }: HandsRunTraceProps) {
  const children = run.children ?? [];
  const totalRows = 1 + children.length;
  const height = totalRows * ROW_HEIGHT + 12;
  const spineTop = ROW_HEIGHT / 2;
  const spineBottom = (totalRows - 0.5) * ROW_HEIGHT;

  return (
    <svg
      role="img"
      aria-label={`Hands run trace: ${run.label}`}
      viewBox={`0 0 320 ${height}`}
      width="100%"
      style={{ display: "block" }}
    >
      {/* spine */}
      <line
        x1={NODE_X}
        x2={NODE_X}
        y1={spineTop}
        y2={spineBottom}
        stroke="var(--border)"
        strokeWidth={1}
      />

      {/* root node */}
      <circle cx={NODE_X} cy={spineTop} r={RADIUS} fill={nodeColor(run.status)} />
      <text
        x={LABEL_X}
        y={spineTop + 4}
        fill="var(--text-primary)"
        fontFamily="ui-monospace, monospace"
        fontSize={12}
      >
        {run.label} · {statusText(run.status)}
      </text>

      {/* children */}
      {children.map((child, i) => {
        const y = (i + 1.5) * ROW_HEIGHT;
        return (
          <g key={child.id}>
            <line
              x1={NODE_X}
              x2={LABEL_X - 4}
              y1={y}
              y2={y}
              stroke="var(--accent)"
              strokeWidth={1.5}
            />
            <circle cx={LABEL_X - 4} cy={y} r={RADIUS} fill={nodeColor(child.status)} />
            <text
              x={LABEL_X + 4}
              y={y + 4}
              fill="var(--text-primary)"
              fontFamily="ui-monospace, monospace"
              fontSize={12}
            >
              {child.label} · {statusText(child.status)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
