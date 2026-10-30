import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createOpsRouter } from "../src/routes/ops.js";
import { createBrainsRouter } from "../src/routes/brains.js";
import { randomBytes } from "node:crypto";
import { defaultPepperRefusal } from "../src/server.js";

const SCHEMA_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "db", "schema.sql"), "utf-8");
const ENVELOPE = { e: 1, n: "AAAAAAAAAAAAAAAA", c: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const M1 = "1111111111111111";
const M2 = "2222222222222222";
const M3 = "3333333333333333";

let db: Database.Database;
let app: Hono;

function build(opts: { enrollSecret?: string; allowOpenCreate?: boolean } = { enrollSecret: "s3cret" }): Hono {
  const a = new Hono();
  a.route("/", createOpsRouter(db));
  a.route("/", createBrainsRouter(db, opts));
  return a;
}
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  app = build();
});

const share = () => randomBytes(32).toString("hex");
const joinAs = (a: Hono, shareId: string, machine: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  a.request("/brains/join", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ route_id: shareId, machine_id: machine, hostname: "box", ...extra }),
  });
const SECRET = { "x-enroll-secret": "s3cret" };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const tok = async (r: Response) => ((await r.json()) as { token: string }).token;
const op = (machine: string, gid: string, kind = "file.create", base: number | null = null, payload: Record<string, unknown> = ENVELOPE, seq = 1) => ({
  gid, kind, origin: machine, base_version: base, payload, created_at: 1, client_seq: seq,
});
const post = (token: string, ops: unknown[]) =>
  app.request("/ops", { method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify(ops) });

describe("POST /brains/join", () => {
  it("creates a brain with the enroll secret and returns a token once", async () => {
    const s = share();
    const res = await joinAs(app, s, M1, SECRET, { name: "Mine" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: boolean; name: string; token: string };
    expect(body).toMatchObject({ created: true, name: "Mine" });
    expect(body.token).toHaveLength(64);
    expect((db.prepare("SELECT share_hash FROM brains").get() as { share_hash: string }).share_hash).not.toContain(s);
  });

  it("joins an existing brain with the share id alone", async () => {
    const s = share();
    await joinAs(app, s, M1, SECRET);
    const res = await joinAs(app, s, M2);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { created: boolean }).created).toBe(false);
    expect((db.prepare("SELECT COUNT(*) n FROM clients").get() as { n: number }).n).toBe(2);
  });

  it("re-join rotates the token and the old token stops working (a retried create converges, never a second brain)", async () => {
    const s = share();
    const first = await tok(await joinAs(app, s, M1, SECRET));
    const second = await tok(await joinAs(app, s, M1));
    expect(second).not.toBe(first);
    expect((await app.request("/ops", { headers: auth(first) })).status).toBe(401);
    expect((await app.request("/ops", { headers: auth(second) })).status).toBe(200);
    expect((db.prepare("SELECT COUNT(*) n FROM brains").get() as { n: number }).n).toBe(1);
  });

  it("without the secret, an unknown share id is 403 and leaks nothing", async () => {
    const res = await joinAs(app, share(), M1);
    expect(res.status).toBe(403);
    expect((db.prepare("SELECT COUNT(*) n FROM brains").get() as { n: number }).n).toBe(0);
  });

  it("creating is closed with 503 when no secret is configured and open create is off", async () => {
    const closed = build({});
    expect((await joinAs(closed, share(), M1)).status).toBe(503);
    const open = build({ allowOpenCreate: true });
    expect((await joinAs(open, share(), M1)).status).toBe(201);
  });

  it("rejects a malformed route id or machine id", async () => {
    expect((await joinAs(app, "nope", M1, SECRET)).status).toBe(400);
    expect((await joinAs(app, share(), "xyz", SECRET)).status).toBe(400);
  });
});

describe("brain isolation and machine routes", () => {
  it("brain A's token never reads brain B's ops, snapshot, machines or revocation", async () => {
    const ta = await tok(await joinAs(app, share(), M1, SECRET));
    const tb = await tok(await joinAs(app, share(), M2, SECRET));
    await post(ta, [op(M1, "1@aaaaaaaaaaaaaaaa")]);
    const bOps = (await (await app.request("/ops?since=0", { headers: auth(tb) })).json()) as { ops: unknown[] };
    expect(bOps.ops).toEqual([]);
    const bSnap = (await (await app.request("/brains/snapshot", { headers: auth(tb) })).json()) as { gids: unknown[] };
    expect(bSnap.gids).toEqual([]);
    const bMe = (await (await app.request("/brains/me", { headers: auth(tb) })).json()) as { machines: Array<{ machine_id: string }> };
    expect(bMe.machines.map((m) => m.machine_id)).toEqual([M2]);
    expect((await app.request(`/brains/me/machines/${M1}`, { method: "DELETE", headers: auth(tb) })).status).toBe(404);
  });

  it("lists machines, renames the brain and revokes a machine", async () => {
    const s = share();
    const t1 = await tok(await joinAs(app, s, M1, SECRET));
    const t2 = await tok(await joinAs(app, s, M2));
    const me = (await (await app.request("/brains/me", { headers: auth(t1) })).json()) as { machines: unknown[] };
    expect(me.machines).toHaveLength(2);
    const patched = await app.request("/brains/me", { method: "PATCH", headers: { ...auth(t1), "content-type": "application/json" }, body: JSON.stringify({ name: "Renamed" }) });
    expect(((await patched.json()) as { name: string }).name).toBe("Renamed");
    expect((await app.request(`/brains/me/machines/${M2}`, { method: "DELETE", headers: auth(t1) })).status).toBe(204);
    expect((await app.request("/ops", { headers: auth(t2) })).status).toBe(401);
  });
});

describe("snapshot", () => {
  it("pages by gid and includes unresolved conflicts", async () => {
    const t = await tok(await joinAs(app, share(), M1, SECRET));
    await post(t, [op(M1, "1@aaaaaaaaaaaaaaaa", "file.create", null, ENVELOPE, 1), op(M1, "2@aaaaaaaaaaaaaaaa", "file.create", null, ENVELOPE, 2)]);
    await post(t, [op(M1, "1@aaaaaaaaaaaaaaaa", "file.update", 1, ENVELOPE, 3)]);
    await post(t, [op(M1, "1@aaaaaaaaaaaaaaaa", "file.update", 1, ENVELOPE, 4)]);
    const p1 = (await (await app.request("/brains/snapshot?limit=1", { headers: auth(t) })).json()) as { gids: Array<{ gid: string; records: unknown[]; conflicts: unknown[] }>; next: string | null };
    expect(p1.gids[0].gid).toBe("1@aaaaaaaaaaaaaaaa");
    expect(p1.gids[0].records).toHaveLength(2);
    expect(p1.gids[0].conflicts).toHaveLength(1);
    const p2 = (await (await app.request(`/brains/snapshot?limit=1&after=${p1.next}`, { headers: auth(t) })).json()) as { gids: Array<{ gid: string }> };
    expect(p2.gids[0].gid).toBe("2@aaaaaaaaaaaaaaaa");
  });
});

describe("default pepper guard still applies", () => {
  it("refuses the default pepper on a public bind", () => {
    expect(defaultPepperRefusal(true, "0.0.0.0", {})).toMatch(/KXTA_BRAIN_PEPPER/);
  });
});
