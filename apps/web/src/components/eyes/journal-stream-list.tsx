export interface JournalEntry {
  id: string;
  timestamp: string;
  text: string;
  live?: boolean;
}

export interface JournalStreamListProps {
  entries: JournalEntry[];
}

export function JournalStreamList({ entries }: JournalStreamListProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {entries.map((entry) => {
        const live = entry.live === true;
        const rowStyle: React.CSSProperties = {
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 11,
          padding: "3px 0 3px 10px",
          marginLeft: 4,
          borderLeft: `2px solid ${live ? "var(--accent)" : "var(--border)"}`,
          color: live ? "var(--text-primary)" : "var(--muted)",
          display: "flex",
          gap: 8,
          alignItems: "center",
        };
        const prefixStyle: React.CSSProperties = {
          color: "var(--accent)",
          animation: "journal-stream-blink 1.4s infinite",
        };
        return (
          <div key={entry.id} data-live={live ? "true" : "false"} style={rowStyle}>
            {live && <span style={prefixStyle}>▸</span>}
            <span style={{ color: "var(--text-secondary)" }}>{entry.timestamp}</span>
            <span>·</span>
            <span>{entry.text}</span>
          </div>
        );
      })}
      <style>{`
        @keyframes journal-stream-blink {
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
