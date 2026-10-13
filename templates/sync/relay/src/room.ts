// 同期の中継の1つの部屋の処理。Cloudflare（Durable Object）にも、テストにも、同じコードを使う。
// 中継は内容を読めない: 行の本体（blob）は暗号化されていて、不透明な文字列として保管する。
// 参加者の記録（鎖）はオーナーが署名したものを検証して保管し、承認された端末だけをつなぐ。
import { verifyChain, extendChain, type Device, type MemberRecord } from "../../server/sync/membership.ts";
import { sha256, verifyInviteProof, hex, unb64 } from "../../server/sync/crypto.ts";

export interface Sql {
  run(sql: string, ...params: (string | number | null)[]): void;
  all<T>(sql: string, ...params: (string | number | null)[]): T[];
}

export interface Row { rid: string; ts: number; seq: number; blob: string }
export interface Welcome { epoch: number; wrapped: string; from: string }

/** 上限。大きな入力や大量の部屋・参加者で、保管領域を使い切られないようにする。 */
export const LIMITS = { blobChars: 4096, rows: 5000, members: 20, requests: 20, invites: 5, inviteSeconds: 15 * 60, name: 40 } as const;

/** 認証済みの接続元。署名つきの接続の証明から、中継（Worker）が確かめた値。 */
export interface Ctx { id: string; sign: string; nonce: string }

export type Target = "self" | "others" | "owner" | { device: string };
export interface Out { to: Target; msg: ServerMessage }
export interface Result { out: Out[]; close?: string[] }

export type ServerMessage =
  | { t: "created" }
  | { t: "state"; chain: MemberRecord[]; epoch: number; welcome: Welcome | null; requests: Request[] }
  | { t: "rows"; epoch: number; rows: Row[]; seq: number }
  | { t: "ack"; rid: string; ts: number; seq: number; applied: boolean }
  | { t: "applied"; root: MemberRecord }
  | { t: "request"; request: Request }
  | { t: "welcome"; chain: MemberRecord[]; welcome: Welcome }
  | { t: "epoch"; chain: MemberRecord[]; epoch: number; welcome: Welcome | null }
  | { t: "rejected" }
  | { t: "ok"; re?: string }
  | { t: "error"; code: string; re?: string };

export interface Request { device: Device; inviteId: string }

type Msg = Record<string, unknown>;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const err = (code: string): Result => ({ out: [{ to: "self", msg: { t: "error", code } }] });
const ok = (): Result => ({ out: [{ to: "self", msg: { t: "ok" } }] });

export class RoomStore {
  constructor(private readonly sql: Sql, private readonly now: () => number = Date.now) {
    sql.run("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    sql.run("CREATE TABLE IF NOT EXISTS chain (ver INTEGER PRIMARY KEY, json TEXT NOT NULL)");
    sql.run("CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, verifier TEXT NOT NULL, exp INTEGER NOT NULL)");
    sql.run("CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
    sql.run("CREATE TABLE IF NOT EXISTS welcomes (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
    sql.run("CREATE TABLE IF NOT EXISTS rows (rid TEXT PRIMARY KEY, ts INTEGER NOT NULL, seq INTEGER NOT NULL, blob TEXT NOT NULL)");
  }

  private meta(k: string): string | null {
    return this.sql.all<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)[0]?.v ?? null;
  }
  private setMeta(k: string, v: string): void {
    this.sql.run("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, v);
  }
  private records(): MemberRecord[] {
    return this.sql.all<{ json: string }>("SELECT json FROM chain ORDER BY ver").map((r) => JSON.parse(r.json) as MemberRecord);
  }
  private epoch(): number {
    return Number(this.meta("epoch") ?? "1");
  }
  private maxSeq(): number {
    return this.sql.all<{ m: number | null }>("SELECT MAX(seq) AS m FROM rows")[0]?.m ?? 0;
  }
  private requests(): Request[] {
    return this.sql.all<{ json: string }>("SELECT json FROM requests").map((r) => JSON.parse(r.json) as Request);
  }
  private welcomeFor(id: string): Welcome | null {
    const r = this.sql.all<{ json: string }>("SELECT json FROM welcomes WHERE id = ?", id)[0];
    return r ? (JSON.parse(r.json) as Welcome) : null;
  }

  /** 端末が参加者（オーナーを含む）か。 */
  async roleOf(id: string): Promise<"owner" | "member" | null> {
    const records = this.records();
    if (records.length === 0) return null;
    const v = await verifyChain(records);
    if (!v.ok) return null;
    if (v.chain.owner.id === id) return "owner";
    return v.chain.members.some((m) => m.id === id) ? "member" : null;
  }

  /** 受け取ったメッセージを処理する。ok と error には、何への答えかを re に付ける。 */
  async handle(ctx: Ctx, raw: string): Promise<Result> {
    const result = await this.dispatch(ctx, raw);
    let re = "";
    try { re = String((JSON.parse(raw) as Msg).t ?? ""); } catch { /* 読めないメッセージ */ }
    for (const o of result.out) if (o.to === "self" && (o.msg.t === "ok" || o.msg.t === "error")) o.msg.re = re;
    return result;
  }

  private async dispatch(ctx: Ctx, raw: string): Promise<Result> {
    let m: Msg;
    try {
      const p = JSON.parse(raw) as unknown;
      if (typeof p !== "object" || p === null) return err("bad-message");
      m = p as Msg;
    } catch {
      return err("bad-message");
    }
    const records = this.records();
    if (records.length === 0) return m.t === "create" ? this.create(ctx, m) : err("no-room");

    const role = await this.roleOf(ctx.id);
    if (role === null) return m.t === "apply" ? this.apply(ctx, m) : err("not-member");
    switch (m.t) {
      case "hello": return this.hello(ctx, m, role);
      case "put": return this.put(m);
      case "invite": return role === "owner" ? this.invite(m) : err("owner-only");
      case "approve": return role === "owner" ? this.approve(m, records) : err("owner-only");
      case "reject": return role === "owner" ? this.reject(m) : err("owner-only");
      case "remove": return role === "owner" ? this.remove(m, records) : err("owner-only");
      default: return err("bad-message");
    }
  }

  private async create(ctx: Ctx, m: Msg): Promise<Result> {
    const rec = m.rec as MemberRecord | undefined;
    if (!rec || rec.type !== "root" || rec.device?.id !== ctx.id || rec.device?.sign !== ctx.sign) return err("bad-message");
    const v = await verifyChain([rec]);
    if (!v.ok) return err("bad-record");
    this.sql.run("INSERT INTO chain (ver, json) VALUES (1, ?)", JSON.stringify(rec));
    this.setMeta("epoch", "1");
    return { out: [{ to: "self", msg: { t: "created" } }] };
  }

  private async hello(ctx: Ctx, m: Msg, role: "owner" | "member"): Promise<Result> {
    if (!isInt(m.since) || !isInt(m.ver) || !isInt(m.epoch)) return err("bad-message");
    const records = this.records();
    const epoch = this.epoch();
    const since = m.epoch === epoch ? m.since : 0;
    const rows = this.sql.all<Row>("SELECT rid, ts, seq, blob FROM rows WHERE seq > ? ORDER BY seq", since);
    return {
      out: [
        { to: "self", msg: { t: "state", chain: records.slice(m.ver), epoch, welcome: this.welcomeFor(ctx.id), requests: role === "owner" ? this.requests() : [] } },
        { to: "self", msg: { t: "rows", epoch, rows, seq: this.maxSeq() } },
      ],
    };
  }

  private put(m: Msg): Result {
    if (!isStr(m.rid, 128) || !isInt(m.ts) || !isStr(m.blob, LIMITS.blobChars) || !isInt(m.epoch)) return err("bad-message");
    if (m.epoch !== this.epoch()) return err("epoch");
    const existing = this.sql.all<Row>("SELECT rid, ts, seq, blob FROM rows WHERE rid = ?", m.rid)[0];
    if (existing && existing.ts >= m.ts) {
      return { out: [{ to: "self", msg: { t: "ack", rid: m.rid, ts: m.ts, seq: existing.seq, applied: false } }, { to: "self", msg: { t: "rows", epoch: this.epoch(), rows: [existing], seq: this.maxSeq() } }] };
    }
    if (!existing && this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM rows")[0]!.n >= LIMITS.rows) return err("full");
    const seq = this.maxSeq() + 1;
    this.sql.run("INSERT OR REPLACE INTO rows (rid, ts, seq, blob) VALUES (?, ?, ?, ?)", m.rid, m.ts, seq, m.blob);
    return {
      out: [
        { to: "self", msg: { t: "ack", rid: m.rid, ts: m.ts, seq, applied: true } },
        { to: "others", msg: { t: "rows", epoch: this.epoch(), rows: [{ rid: m.rid, ts: m.ts, seq, blob: m.blob }], seq } },
      ],
    };
  }

  private invite(m: Msg): Result {
    const now = this.now();
    this.sql.run("DELETE FROM invites WHERE exp < ?", now);
    if (!isStr(m.id, 32) || !isStr(m.verifier, 64) || !isInt(m.exp) || m.exp > now + LIMITS.inviteSeconds * 1000) return err("bad-message");
    if (this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM invites")[0]!.n >= LIMITS.invites) return err("too-many-invites");
    this.sql.run("INSERT OR REPLACE INTO invites (id, verifier, exp) VALUES (?, ?, ?)", m.id, m.verifier, m.exp);
    return ok();
  }

  private async apply(ctx: Ctx, m: Msg): Promise<Result> {
    const device = m.device as Device | undefined;
    if (!device || !isStr(m.inviteId, 32) || !isStr(m.proof, 64) || !isStr(device.ecdh, 128) || !isStr(device.name, LIMITS.name) || device.sign !== ctx.sign || device.id !== ctx.id) return err("bad-message");
    const inv = this.sql.all<{ verifier: string; exp: number }>("SELECT verifier, exp FROM invites WHERE id = ?", m.inviteId)[0];
    if (!inv || inv.exp < this.now()) return err("invalid-invite");
    if (!(await verifyInviteProof(inv.verifier, ctx.nonce, device.sign, device.ecdh, m.proof))) return err("invalid-invite");
    if (this.requests().length >= LIMITS.requests) return err("too-many-requests");
    // 招待は1回だけ使える。
    this.sql.run("DELETE FROM invites WHERE id = ?", m.inviteId);
    const request: Request = { device: { id: device.id, sign: device.sign, ecdh: device.ecdh, name: device.name }, inviteId: m.inviteId };
    this.sql.run("INSERT OR REPLACE INTO requests (id, json) VALUES (?, ?)", device.id, JSON.stringify(request));
    return { out: [{ to: "self", msg: { t: "applied", root: this.records()[0]! } }, { to: "owner", msg: { t: "request", request } }] };
  }

  private async approve(m: Msg, records: MemberRecord[]): Promise<Result> {
    const rec = m.rec as MemberRecord | undefined;
    const w = m.welcome as { wrapped?: unknown; from?: unknown } | undefined;
    if (!rec || rec.type !== "add" || !isStr(w?.wrapped, 512) || !isStr(w?.from, 128)) return err("bad-message");
    const pending = this.sql.all<{ json: string }>("SELECT json FROM requests WHERE id = ?", rec.device?.id ?? "")[0];
    if (!pending) return err("no-request");
    const req = JSON.parse(pending.json) as Request;
    if (req.device.sign !== rec.device.sign || req.device.ecdh !== rec.device.ecdh) return err("bad-record");
    const members = (await verifyChain(records)) as { ok: true; chain: { members: Device[] } };
    if (members.chain.members.length >= LIMITS.members) return err("too-many-members");
    const v = await extendChain(records, rec);
    if (!v.ok) return err("bad-record");
    this.sql.run("INSERT INTO chain (ver, json) VALUES (?, ?)", rec.ver, JSON.stringify(rec));
    this.sql.run("DELETE FROM requests WHERE id = ?", rec.device.id);
    const welcome: Welcome = { epoch: this.epoch(), wrapped: w.wrapped as string, from: w.from as string };
    this.sql.run("INSERT OR REPLACE INTO welcomes (id, json) VALUES (?, ?)", rec.device.id, JSON.stringify(welcome));
    const chain = this.records();
    return { out: [{ to: "self", msg: { t: "ok" } }, { to: { device: rec.device.id }, msg: { t: "welcome", chain, welcome } }, { to: "others", msg: { t: "state", chain: [rec], epoch: this.epoch(), welcome: null, requests: [] } }] };
  }

  private reject(m: Msg): Result {
    if (!isStr(m.id, 64)) return err("bad-message");
    this.sql.run("DELETE FROM requests WHERE id = ?", m.id);
    return { out: [{ to: "self", msg: { t: "ok" } }, { to: { device: m.id }, msg: { t: "rejected" } }], close: [m.id] };
  }

  private async remove(m: Msg, records: MemberRecord[]): Promise<Result> {
    const rec = m.rec as MemberRecord | undefined;
    const ws = m.welcomes as { id?: unknown; wrapped?: unknown }[] | undefined;
    if (!rec || rec.type !== "remove" || !isInt(m.epoch) || m.epoch !== this.epoch() + 1 || !Array.isArray(ws) || !isStr(m.from, 128)) return err("bad-message");
    const v = await extendChain(records, rec);
    if (!v.ok) return err("bad-record");
    // 残る参加者（オーナー以外）全員に、新しい鍵が包んであること。
    const need = v.chain.members.filter((d) => d.id !== v.chain.owner.id).map((d) => d.id).sort();
    const got = ws.map((x) => x.id).filter((x): x is string => typeof x === "string").sort();
    if (need.length !== got.length || need.some((id, i) => id !== got[i]) || ws.some((x) => !isStr(x.wrapped, 512))) return err("bad-welcomes");
    this.sql.run("INSERT INTO chain (ver, json) VALUES (?, ?)", rec.ver, JSON.stringify(rec));
    this.setMeta("epoch", String(m.epoch));
    this.sql.run("DELETE FROM rows");
    this.sql.run("DELETE FROM welcomes");
    const chain = this.records();
    const out: Out[] = [{ to: "self", msg: { t: "ok" } }];
    for (const x of ws) {
      const welcome: Welcome = { epoch: m.epoch, wrapped: x.wrapped as string, from: m.from as string };
      this.sql.run("INSERT OR REPLACE INTO welcomes (id, json) VALUES (?, ?)", x.id as string, JSON.stringify(welcome));
      out.push({ to: { device: x.id as string }, msg: { t: "epoch", chain, epoch: m.epoch, welcome } });
    }
    return { out, close: [rec.device.id] };
  }
}

/** 接続の証明（署名つきのトークン）の検証。Workerが、部屋に入る前に使う。 */
export interface AuthToken { room: string; sign: string; nonce: string; ts: number }
export const AUTH_WINDOW_MS = 2 * 60 * 1000;
export async function authContext(token: string, room: string, verifyFn: (pub: string, data: string, sig: string) => Promise<boolean>, deviceIdFn: (pub: string) => Promise<string>, now: number): Promise<Ctx | null> {
  try {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64(payload))) as AuthToken;
    if (p.room !== room || typeof p.sign !== "string" || typeof p.nonce !== "string" || p.nonce.length > 64 || !isInt(p.ts) || Math.abs(now - p.ts) > AUTH_WINDOW_MS) return null;
    if (!(await verifyFn(p.sign, payload, sig))) return null;
    return { id: await deviceIdFn(p.sign), sign: p.sign, nonce: p.nonce };
  } catch {
    return null;
  }
}
export { sha256, hex };
