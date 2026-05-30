import { MCPPipelineRow } from "@/components/mcp/mcp-pipeline-row";
import { JournalStreamList } from "@/components/eyes/journal-stream-list";
import { HandsRunTrace } from "@/components/hands/hands-run-trace";

export default function MotifsPreviewPage() {
  return (
    <main
      style={{
        padding: 32,
        background: "var(--bg-primary)",
        color: "var(--text-primary)",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Protocol-flow motifs</h1>
      <p style={{ color: "var(--text-secondary)", marginBottom: 32 }}>
        Visual preview of the three motif components from the 2026-05-12 webui rebrand.
      </p>

      <Section title="MCP pipeline connectors">
        <MCPPipelineRow label="kxta.search" result="42 hits" status="active" />
        <MCPPipelineRow label="kxta.read_files" result="8 files" status="active" />
        <MCPPipelineRow label="kxta.commit_backup" result="idle" status="idle" />
      </Section>

      <Section title="Journal stream indicator">
        <JournalStreamList
          entries={[
            { id: "1", timestamp: "14:02", text: "hands.run('test') · ok", live: true },
            { id: "2", timestamp: "13:58", text: "update_file_section · README.md" },
            { id: "3", timestamp: "13:51", text: 'search · "rebrand"' },
            { id: "4", timestamp: "13:40", text: "commit_backup · ↑3" },
          ]}
        />
      </Section>

      <Section title="Hands branching trace">
        <HandsRunTrace
          run={{
            id: "root",
            label: "deploy",
            status: "pending",
            children: [
              { id: "build", label: "build", status: "ok" },
              { id: "test", label: "test", status: "ok" },
            ],
          }}
        />
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        marginBottom: 32,
        padding: 18,
        background: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        borderRadius: 8,
      }}
    >
      <h2
        style={{
          fontFamily: "ui-monospace, monospace",
          fontSize: 11,
          letterSpacing: "0.08em",
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          marginBottom: 12,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
