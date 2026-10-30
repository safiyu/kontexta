"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface Machine {
  machine_id: string;
  hostname: string | null;
  last_seen_at: number;
  acked_seq: number;
}

interface BrainStatus {
  connected: boolean;
  name: string | null;
  remote: string | null;
  shareId: string | null;
  machines: Machine[] | null;
  remoteReachable: boolean | null;
  pending: number;
  skipped: number;
  cursor: number;
}

const SAVE_WARNING = "Save this share id somewhere safe. Anyone who has it can join this brain, and Kontexta cannot recover it for you.";

export function BrainClient() {
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [mode, setMode] = useState<"join" | "create">("join");
  const [url, setUrl] = useState("");
  const [shareId, setShareId] = useState("");
  const [name, setName] = useState("");
  const [enrollSecret, setEnrollSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [createdShareId, setCreatedShareId] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [revealPassword, setRevealPassword] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/brain", { cache: "no-store" });
    if (res.ok) setStatus((await res.json()) as BrainStatus);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/brain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, create: mode === "create", shareId: mode === "join" ? shareId : undefined, name, enrollSecret }),
      });
      const data = (await res.json()) as { error?: string; shareId?: string; created?: boolean; name?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to connect");
      if (data.created && data.shareId) setCreatedShareId(data.shareId);
      toast.success(data.created ? `Created brain "${data.name}"` : `Joined brain "${data.name}"`);
      setShareId("");
      setEnrollSecret("");
      await load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to connect");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setConfirmDisconnect(false);
    await fetch("/api/brain", { method: "DELETE" });
    setCreatedShareId(null);
    setRevealed(null);
    await load();
  };

  const removeMachine = async (id: string) => {
    const res = await fetch(`/api/brain/machines/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) toast.success("Machine removed");
    else toast.error("Could not remove that machine");
    await load();
  };

  const reveal = async () => {
    const res = await fetch("/api/brain/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: revealPassword }),
    });
    const data = (await res.json()) as { shareId?: string; error?: string };
    if (!res.ok) toast.error(data.error ?? "Could not show the share id");
    else setRevealed(data.shareId ?? null);
    setRevealPassword("");
  };

  return (
    <main className="max-w-3xl mx-auto p-8 space-y-8">
      <header className="flex items-center gap-3">
        <Brain className="w-7 h-7" />
        <div>
          <h1 className="text-2xl font-semibold">Brain</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Your context lives on this machine. Connect it to a brain on a remote to keep a durable copy and sync your other machines.
          </p>
        </div>
      </header>

      {createdShareId && (
        <section className="rounded-xl border border-amber-accent/40 p-4 space-y-2" role="alert">
          <div className="font-mono text-lg select-all">{createdShareId}</div>
          <p className="text-sm">{SAVE_WARNING}</p>
          <button className="btn-secondary" onClick={() => setCreatedShareId(null)}>I saved it</button>
        </section>
      )}

      {status?.connected ? (
        <section className="space-y-4">
          <div className="rounded-xl border border-[var(--border)] p-4 space-y-1">
            <div className="font-medium">{status.name}</div>
            <div className="text-sm text-[var(--text-secondary)]">{status.remote}{status.remoteReachable === false ? " (unreachable)" : ""}</div>
            {status.shareId && <div className="text-sm font-mono">share id {status.shareId}</div>}
            <div className="text-sm text-[var(--text-secondary)]">
              {status.pending} pending, {status.skipped} skipped, cursor {status.cursor}
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="font-medium">Machines</h2>
            <table className="w-full text-sm">
              <tbody>
                {(status.machines ?? []).map((m) => (
                  <tr key={m.machine_id} className="border-b border-[var(--border)]">
                    <td className="py-2 font-mono">{m.machine_id}</td>
                    <td>{m.hostname ?? "-"}</td>
                    <td>{new Date(m.last_seen_at).toLocaleString()}</td>
                    <td className="text-right">
                      <button className="text-red-500" onClick={() => void removeMachine(m.machine_id)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-2">
            <h2 className="font-medium">Share id</h2>
            {revealed ? (
              <div className="space-y-1">
                <div className="font-mono select-all">{revealed}</div>
                <p className="text-sm">{SAVE_WARNING}</p>
              </div>
            ) : (
              <div className="flex gap-2">
                <input type="password" className="input" placeholder="Master password" value={revealPassword} onChange={(e) => setRevealPassword(e.target.value)} />
                <button className="btn-secondary" onClick={() => void reveal()}>Show share id</button>
              </div>
            )}
          </div>

          <button className="btn-secondary" onClick={() => setConfirmDisconnect(true)}>Disconnect</button>
        </section>
      ) : (
        <section className="space-y-4">
          <div className="flex gap-4 text-sm">
            <label><input type="radio" checked={mode === "join"} onChange={() => setMode("join")} /> Join with a share id</label>
            <label><input type="radio" checked={mode === "create"} onChange={() => setMode("create")} /> Create a new brain</label>
          </div>
          <input className="input w-full" placeholder="Remote URL, e.g. https://brain.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          {mode === "join" ? (
            <input className="input w-full font-mono" placeholder="Share id" value={shareId} onChange={(e) => setShareId(e.target.value)} />
          ) : (
            <>
              <input className="input w-full" placeholder="Brain name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
              <input type="password" className="input w-full" placeholder="Remote enrollment secret" value={enrollSecret} onChange={(e) => setEnrollSecret(e.target.value)} />
            </>
          )}
          <button className="btn-primary" disabled={busy || !url || (mode === "join" && !shareId)} onClick={() => void connect()}>
            {busy ? "Connecting..." : mode === "create" ? "Create brain" : "Join brain"}
          </button>
        </section>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect from this brain?"
        message="Syncing stops. Everything stays on this machine, and you can reconnect with the same share id."
        confirmLabel="Disconnect"
        onConfirm={() => void disconnect()}
        onClose={() => setConfirmDisconnect(false)}
      />
    </main>
  );
}
