import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Document, isMap, isSeq, isScalar, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import type { Installer, InstallCtx } from "./types.js";
import { emitCommand, isOwned, writeTextConfig } from "./json-config.js";

// Hermes shell hooks live in the profile's config.yaml under `hooks:`; each (event, command) pair is approved by the user on first use.
const EVENTS: Array<{ name: string; matcher?: string }> = [
  { name: "pre_llm_call" },
  { name: "post_llm_call" },
  { name: "post_tool_call", matcher: "terminal" },
  { name: "subagent_stop" },
];

const configPath = (ctx: InstallCtx) => join(ctx.home, ".hermes", "config.yaml");

function load(path: string): Document.Parsed | Document {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (text.trim() === "") return new Document({});
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML (${doc.errors[0].message.split("\n")[0]}); refusing to overwrite it`);
  if (!isMap(doc.contents)) throw new Error(`${path} top level is not a mapping; refusing to overwrite it`);
  return doc;
}

function hooksMap(doc: Document.Parsed | Document, path: string, create: boolean): YAMLMap | null {
  const existing = doc.get("hooks", true);
  if (existing === undefined || (isScalar(existing) && existing.value === null)) {
    if (!create) return null;
    const created = doc.createNode({}) as YAMLMap;
    doc.set("hooks", created);
    return created;
  }
  if (!isMap(existing)) throw new Error(`${path} has a "hooks" key that is not a mapping; refusing to change it`);
  return existing;
}

const isOwnedItem = (item: unknown): boolean => isMap(item) && isOwned(item.get("command"));

// Drop every list item that runs our emitter; emptied events and an emptied hooks block are removed.
function stripOwned(doc: Document.Parsed | Document, path: string): void {
  const hooks = hooksMap(doc, path, false);
  if (!hooks) return;
  for (const pair of [...hooks.items]) {
    const key = isScalar(pair.key) ? String(pair.key.value) : "";
    if (key === "outbound" || !isSeq(pair.value)) continue;
    const seq = pair.value as YAMLSeq;
    if (!seq.items.some(isOwnedItem)) continue;
    seq.items = seq.items.filter((item) => !isOwnedItem(item));
    if (seq.items.length === 0) hooks.delete(key);
  }
  if (hooks.items.length === 0) doc.delete("hooks");
}

export const hermesInstaller: Installer = {
  id: "hermes",
  configPath,
  install(ctx) {
    const path = configPath(ctx);
    const doc = load(path);
    stripOwned(doc, path);
    const hooks = hooksMap(doc, path, true)!;
    for (const e of EVENTS) {
      const item: Record<string, unknown> = {};
      if (e.matcher) item.matcher = e.matcher;
      item.command = emitCommand(ctx, "hermes");
      item.timeout = 5;
      const seq = hooks.get(e.name, true);
      if (seq === undefined) hooks.set(e.name, doc.createNode([item]));
      else if (isSeq(seq)) seq.add(doc.createNode(item));
      else throw new Error(`${path} has a hooks.${e.name} that is not a list; refusing to change it`);
    }
    const changed = writeTextConfig(path, doc.toString({ lineWidth: 0 }), ctx.dryRun);
    return {
      agent: "hermes", path, changed,
      notes: ["Hermes asks you to approve each new hook on first use: approve the kontexta hooks when prompted, or run `hermes hooks list` to check. Gateway and other non-interactive runs need `--accept-hooks`, HERMES_ACCEPT_HOOKS=1 or `hooks_auto_accept: true`.", "Only the default profile's config.yaml is changed."],
    };
  },
  uninstall(ctx) {
    const path = configPath(ctx);
    if (!existsSync(path)) return { agent: "hermes", path, changed: false, notes: [] };
    const doc = load(path);
    stripOwned(doc, path);
    return { agent: "hermes", path, changed: writeTextConfig(path, doc.toString({ lineWidth: 0 }), ctx.dryRun), notes: [] };
  },
  status(ctx) {
    const path = configPath(ctx);
    const notes: string[] = [];
    let installed = false;
    try {
      const hooks = hooksMap(load(path), path, false);
      installed = !!hooks && EVENTS.every((e) => { const seq = hooks.get(e.name, true); return isSeq(seq) && seq.items.some(isOwnedItem); });
    } catch (e) { notes.push((e as Error).message); }
    return { agent: "hermes", path, installed, notes };
  },
};
