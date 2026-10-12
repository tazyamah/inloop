// 端末どうしの同期（クライアント側）。端末のSQLiteが正で、通信は変更の受け渡しだけに使う。
// 中継が止まっていても、アプリは普通に使え、つながったときに、溜まった変更を送り、他の端末の変更を取り込む。
// 参加は、オーナーの承認が要る（招待コード＋確認の数字）。行の中身はグループ鍵で暗号化して送る。
import type { Db } from "../db.ts";
import {
  confirmDigits, deviceId, groupKeys, inviteProof, newGroupKey, newIdentity, newInvite, parseInvite, random, b64, sign, unwrapGroupKey, wrapGroupKey,
  type GroupKeys, type Identity,
} from "./crypto.ts";
import { deviceOf, extendChain, makeRecord, recordHash, verifyChain, type Device, type MemberRecord } from "./membership.ts";

export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** 同期する表。uid（文字列の主キー）、created_at、updated_at（ミリ秒）、deleted、dirty の列が要る。 */
export interface SyncTable {
  name: string;
  columns: Record<string, { type: "text" | "int" | "bool"; max?: number; optional?: boolean }>;
}

export type SyncState = "unavailable" | "off" | "connecting" | "online" | "offline" | "joining" | "stopped";
export interface SyncStatus {
  state: SyncState;
  role: "owner" | "member" | null;
  members: { id: string; name: string; role: "owner" | "member"; isMe: boolean }[];
  /** 参加を求めている端末（オーナーだけに出る）。digits は、相手の画面と見比べる4桁。 */
  requests: { id: string; name: string; digits: string | null }[];
  /** 参加を申し込んだ端末（自分）が、オーナーに見せる4桁。 */
  joiningDigits: string | null;
  /** 不整合などで、同期を止めた理由（別のオーナーがいる可能性など）。 */
  alert: string | null;
  error: string | null;
  pending: number;
  lastSyncAt: number | null;
}

export interface SyncApi {
  status(): SyncStatus;
  createRoom(deviceName: string): Promise<void>;
  invite(): Promise<{ code: string; expiresAt: number }>;
  approve(id: string): Promise<void>;
  reject(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  join(inviteCode: string, deviceName: string): Promise<void>;
  leave(): Promise<void>;
  touch(): void;
}

export interface SyncOptions {
  /** 中継のURL（wss://…）。なければ、同期は使えない。 */
  url: string | undefined;
  tables: SyncTable[];
  open?: (url: string) => SocketLike;
  now?: () => number;
  onChange?: () => void;
  backoffMs?: number[];
}

interface StoredInvite { id: string; verifier: string; secret: string; exp: number }
interface Joining { roomId: string; id: string; verifier: string; secret: string; name: string; ownerPin: string | null; digits: string | null }
interface Request { device: Device; inviteId: string }
interface RowMsg { rid: string; ts: number; seq: number; blob: string }
type Msg = { t: string } & Record<string, unknown>;

const UID = /^[0-9a-f-]{36}$/;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const infoOf = (room: string, epoch: number) => `inloop|${room}|${epoch}`;
const INVITE_MS = 10 * 60 * 1000;

/** 他の端末から届いた行を検証する。合わないものは捨てる（信頼しない）。 */
export function validateRow(table: SyncTable, v: unknown): Record<string, string | number> | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.table !== table.name || typeof o.uid !== "string" || !UID.test(o.uid)) return null;
  const out: Record<string, string | number> = { uid: o.uid };
  const flag = (x: unknown) => (x === true || x === 1 ? 1 : x === false || x === 0 ? 0 : null);
  const deleted = flag(o.deleted);
  if (deleted === null || !isInt(o.created_at) || !isInt(o.updated_at)) return null;
  out.deleted = deleted;
  out.created_at = o.created_at;
  out.updated_at = o.updated_at;
  for (const [name, c] of Object.entries(table.columns)) {
    const x = o[name];
    if (c.type === "text") {
      if (typeof x !== "string" || x.length > (c.max ?? 1000) || (!c.optional && x.trim() === "")) return null;
      out[name] = x;
    } else if (c.type === "int") {
      if (!isInt(x)) return null;
      out[name] = x;
    } else {
      const f = flag(x);
      if (f === null) return null;
      out[name] = f;
    }
  }
  return out;
}

export class Sync implements SyncApi {
  private socket: SocketLike | null = null;
  private state: SyncState;
  private lastSyncAt: number | null = null;
  private error: string | null = null;
  private alert: string | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private nonce = "";
  private inflight = new Map<string, { table: string; uid: string; ts: number }>();
  private requests = new Map<string, Request>();
  private keys: GroupKeys | null = null;
  private identity: Identity | null = null;
  private inbox: Promise<void> = Promise.resolve();
  private command: { re: string; resolve: () => void; reject: (e: Error) => void; onOk?: () => Promise<void> } | null = null;
  private readonly now: () => number;
  private readonly backoff: number[];

  constructor(private readonly db: Db, private readonly opts: SyncOptions) {
    this.state = opts.url ? "off" : "unavailable";
    this.now = opts.now ?? Date.now;
    this.backoff = opts.backoffMs ?? [1000, 2000, 5000, 15000, 30000, 60000];
  }

  // ── 保存 ──
  private get(key: string): string | null {
    return (this.db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as unknown as { value: string } | undefined)?.value ?? null;
  }
  private set(key: string, value: string): void {
    this.db.prepare("INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  private del(...keys: string[]): void {
    for (const k of keys) this.db.prepare("DELETE FROM sync_state WHERE key = ?").run(k);
  }
  private json<T>(key: string): T | null {
    const v = this.get(key);
    return v === null ? null : (JSON.parse(v) as T);
  }
  private chain(): MemberRecord[] {
    return this.json<MemberRecord[]>("chain") ?? [];
  }
  private room(): string | null {
    return this.get("room");
  }
  private async ident(): Promise<Identity> {
    if (this.identity) return this.identity;
    let id = this.json<Identity>("identity");
    if (!id) {
      id = await newIdentity();
      this.set("identity", JSON.stringify(id));
    }
    this.identity = id;
    return id;
  }
  private markAllDirty(): void {
    for (const t of this.opts.tables) this.db.exec(`UPDATE ${t.name} SET dirty = 1`);
  }

  // ── 状態 ──
  async init(): Promise<void> {
    if (!this.opts.url) return;
    this.alert = this.get("alert");
    if (this.alert) return void (this.state = "stopped");
    if (this.get("key") && this.room()) await this.startKeys();
    if (this.room() || this.json<Joining>("joining")) {
      await this.ident();
      await this.refreshChain();
      this.connect();
    }
  }

  status(): SyncStatus {
    let pending = 0;
    for (const t of this.opts.tables) pending += (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t.name} WHERE dirty = 1`).get() as unknown as { n: number }).n;
    const v = this.chainResult;
    const me = this.cachedId;
    const members = v?.ok ? v.chain.members.map((d) => ({ id: d.id, name: d.name, role: d.id === v.chain.owner.id ? ("owner" as const) : ("member" as const), isMe: d.id === me })) : [];
    const role = members.find((m) => m.isMe)?.role ?? null;
    const requests = role === "owner" ? [...this.requests.values()].map((r) => ({ id: r.device.id, name: r.device.name, digits: this.digitsFor(r) })) : [];
    return { state: this.state, role, members, requests, joiningDigits: this.json<Joining>("joining")?.digits ?? null, alert: this.alert, error: this.error, pending, lastSyncAt: this.lastSyncAt };
  }

  // verifyChain は非同期なので、画面用の状態は、検証済みの結果を覚えておく。
  private cachedId: string | null = null;
  private chainResult: Awaited<ReturnType<typeof verifyChain>> | null = null;
  private async refreshChain(): Promise<void> {
    const chain = this.chain();
    this.chainResult = chain.length > 0 ? await verifyChain(chain, this.get("owner_pin") ?? undefined) : null;
    this.cachedId = this.identity ? await deviceId(this.identity.sign) : null;
  }
  private digitsCache = new Map<string, string>();
  private digitsFor(r: Request): string | null {
    return this.digitsCache.get(r.device.id) ?? null;
  }

  // ── 画面からの操作 ──
  async createRoom(deviceName: string): Promise<void> {
    if (!this.opts.url) throw new Error("この版では、同期を使えません");
    if (this.room()) throw new Error("すでに共有しています");
    const id = await this.ident();
    const roomBytes = random(16);
    const room = [...roomBytes].map((x) => x.toString(16).padStart(2, "0")).join("");
    const root = await makeRecord(id, { ver: 1, prev: "", type: "root", device: await deviceOf(id, deviceName), ts: this.now() });
    this.set("room", room);
    this.set("chain", JSON.stringify([root]));
    this.set("owner_pin", id.sign);
    this.set("key", newGroupKey());
    this.set("epoch", "1");
    this.set("last_seq", "0");
    this.set("creating", "1");
    this.markAllDirty();
    await this.startKeys();
    await this.refreshChain();
    this.connect();
  }

  async invite(): Promise<{ code: string; expiresAt: number }> {
    this.requireOwner();
    const inv = await newInvite(this.room()!);
    const stored: StoredInvite = { id: inv.id, verifier: inv.verifier, secret: inv.secret, exp: this.now() + INVITE_MS };
    await this.run({ t: "invite", id: stored.id, verifier: stored.verifier, exp: stored.exp }, async () => {
      this.set("invites", JSON.stringify([...this.invites().filter((i) => i.exp > this.now()), stored]));
    });
    return { code: inv.code, expiresAt: stored.exp };
  }

  async approve(id: string): Promise<void> {
    this.requireOwner();
    const req = this.requests.get(id);
    if (!req) throw new Error("参加の申し込みが見つかりません");
    const me = await this.ident();
    const chain = this.chain();
    const rec = await makeRecord(me, { ver: chain.length + 1, prev: await recordHash(chain[chain.length - 1]!), type: "add", device: req.device, ts: this.now() });
    const wrapped = await wrapGroupKey(me, req.device.ecdh, this.get("key")!, infoOf(this.room()!, Number(this.get("epoch"))));
    await this.run({ t: "approve", rec, welcome: { wrapped, from: me.ecdh } }, async () => {
      this.set("chain", JSON.stringify([...chain, rec]));
      this.requests.delete(id);
      await this.refreshChain();
    });
  }

  async reject(id: string): Promise<void> {
    this.requireOwner();
    await this.run({ t: "reject", id }, async () => void this.requests.delete(id));
  }

  async remove(id: string): Promise<void> {
    this.requireOwner();
    const me = await this.ident();
    const chain = this.chain();
    const v = await verifyChain(chain);
    if (!v.ok) throw new Error("共有の記録が不正です");
    const target = v.chain.members.find((d) => d.id === id);
    if (!target || target.id === v.chain.owner.id) throw new Error("外せない端末です");
    const rec = await makeRecord(me, { ver: chain.length + 1, prev: await recordHash(chain[chain.length - 1]!), type: "remove", device: target, ts: this.now() });
    const epoch = Number(this.get("epoch")) + 1;
    const key = newGroupKey();
    const welcomes = [];
    for (const d of v.chain.members) if (d.id !== v.chain.owner.id && d.id !== id) welcomes.push({ id: d.id, wrapped: await wrapGroupKey(me, d.ecdh, key, infoOf(this.room()!, epoch)) });
    await this.run({ t: "remove", rec, epoch, from: me.ecdh, welcomes }, async () => {
      this.set("chain", JSON.stringify([...chain, rec]));
      this.set("key", key);
      this.set("epoch", String(epoch));
      this.set("last_seq", "0");
      this.markAllDirty();
      await this.startKeys();
      await this.refreshChain();
      await this.pushDirty();
    });
  }

  async join(inviteCode: string, deviceName: string): Promise<void> {
    if (!this.opts.url) throw new Error("この版では、同期を使えません");
    if (this.room()) throw new Error("すでに共有しています");
    const inv = await parseInvite(inviteCode.trim());
    if (!inv) throw new Error("招待コードの形が違います");
    const name = deviceName.trim();
    if (name === "" || name.length > 40) throw new Error("端末の名前は、1〜40文字で入力してください");
    await this.ident();
    this.set("joining", JSON.stringify({ roomId: inv.roomId, id: inv.id, verifier: inv.verifier, secret: inv.secret, name, ownerPin: null, digits: null } satisfies Joining));
    this.error = null;
    this.connect();
  }

  async leave(): Promise<void> {
    await this.stop();
    this.db.exec("DELETE FROM sync_state WHERE key != 'identity'");
    this.keys = null;
    this.requests.clear();
    this.digitsCache.clear();
    this.chainResult = null;
    this.alert = null;
    this.error = null;
    this.state = this.opts.url ? "off" : "unavailable";
    this.opts.onChange?.();
  }

  touch(): void {
    if (this.state === "online") void this.pushDirty();
    else this.opts.onChange?.();
  }

  wake(): void {
    if ((this.room() || this.get("joining")) && !this.alert && (this.state === "offline" || this.state === "connecting") && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.connect();
    }
  }

  // ── 内部 ──
  private invites(): StoredInvite[] {
    return this.json<StoredInvite[]>("invites") ?? [];
  }

  private requireOwner(): void {
    const chain = this.chain();
    if (chain.length === 0 || chain[0]!.device.sign !== this.identity?.sign) throw new Error("オーナーだけができる操作です");
    if (this.state !== "online") throw new Error("オンラインのときだけ、できる操作です");
  }

  /** オーナーの操作を中継に送り、中継の ok を待って、手元の状態を更新する（1つずつ）。 */
  private run(msg: Msg, onOk: () => Promise<void>): Promise<void> {
    if (this.command) return Promise.reject(new Error("前の操作の途中です"));
    return new Promise<void>((resolve, reject) => {
      this.command = { re: msg.t, resolve, reject, onOk };
      this.socket?.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.command?.reject === reject) {
          this.command = null;
          reject(new Error("中継から答えがありませんでした"));
        }
      }, 10000);
    });
  }

  private async startKeys(): Promise<void> {
    const key = this.get("key");
    this.keys = key ? await groupKeys(key) : null;
  }

  private async stop(): Promise<void> {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const s = this.socket;
    this.socket = null;
    this.inflight.clear();
    this.command?.reject(new Error("共有を止めました"));
    this.command = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      s.close();
    }
  }

  private setStatus(state: SyncState, error: string | null = null): void {
    this.state = state;
    this.error = error;
    this.opts.onChange?.();
  }

  private halt(reason: string): void {
    this.alert = reason;
    this.set("alert", reason);
    void this.stop().then(() => this.setStatus("stopped"));
  }

  private connect(): void {
    const joining = this.json<Joining>("joining");
    const room = this.room() ?? joining?.roomId;
    if (!room || !this.opts.url || !this.identity || this.alert) return;
    const gen = ++this.generation;
    this.setStatus(joining ? "joining" : "connecting");
    void (async () => {
      const id = this.identity!;
      this.nonce = b64(random(8));
      const payload = b64(new TextEncoder().encode(JSON.stringify({ room, sign: id.sign, nonce: this.nonce, ts: this.now() })));
      const token = `${payload}.${await sign(id, payload)}`;
      if (gen !== this.generation) return;
      const open = this.opts.open ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
      const socket = open(`${this.opts.url!.replace(/\/$/, "")}/room/${room}?a=${token}`);
      this.socket = socket;
      socket.onopen = () => gen === this.generation && void this.onOpen();
      // 届いた順に、1つずつ処理する（処理の途中で、次のメッセージが割り込まないように）。
      socket.onmessage = (e) => {
        if (gen !== this.generation || typeof e.data !== "string") return;
        const data = e.data;
        this.inbox = this.inbox.then(() => this.receive(data, gen)).catch(() => undefined);
      };
      const lost = () => {
        if (gen !== this.generation) return;
        this.socket = null;
        this.inflight.clear();
        this.command?.reject(new Error("中継との接続が切れました"));
        this.command = null;
        if (this.state !== "joining") this.setStatus("offline");
        const wait = this.backoff[Math.min(this.attempt++, this.backoff.length - 1)]!;
        this.timer = setTimeout(() => { this.timer = null; this.connect(); }, wait);
      };
      socket.onclose = lost;
      socket.onerror = lost;
    })();
  }

  private send(m: Msg): void {
    this.socket?.send(JSON.stringify(m));
  }

  private async onOpen(): Promise<void> {
    const id = await this.ident();
    const joining = this.json<Joining>("joining");
    if (this.get("creating")) {
      this.send({ t: "create", rec: this.chain()[0] });
    } else if (joining) {
      if (joining.digits === null) {
        const device = await deviceOf(id, joining.name);
        this.send({ t: "apply", inviteId: joining.id, proof: await inviteProof(joining.verifier, this.nonce, device.sign, device.ecdh), device });
      } else {
        // 申し込み済みで、承認待ち。承認されていれば、hello で鍵が届く。
        this.send({ t: "hello", since: 0, ver: 0, epoch: 0 });
      }
    } else {
      this.sendHello();
    }
  }

  private sendHello(): void {
    this.send({ t: "hello", since: Number(this.get("last_seq") ?? "0"), ver: this.chain().length, epoch: Number(this.get("epoch") ?? "1") });
  }

  private async receive(data: string, gen: number): Promise<void> {
    let m: Msg;
    try { m = JSON.parse(data) as Msg; } catch { return; }
    if (gen !== this.generation) return;
    switch (m.t) {
      case "created":
        this.del("creating");
        this.sendHello();
        break;
      case "applied": await this.onApplied(m.root as MemberRecord); break;
      case "welcome": await this.onWelcome(m.chain as MemberRecord[], m.welcome as { epoch: number; wrapped: string }); break;
      case "state": await this.onState(m as unknown as { chain: MemberRecord[]; epoch: number; welcome: { epoch: number; wrapped: string } | null; requests: Request[] }); break;
      case "epoch": await this.onState({ chain: m.chain as MemberRecord[], epoch: m.epoch as number, welcome: m.welcome as { epoch: number; wrapped: string } | null, requests: [] }); break;
      case "rows": await this.onRows(m.rows as RowMsg[], m.epoch as number, m.seq as number, gen); break;
      case "ack": this.onAck(m); break;
      case "request": await this.onRequest(m.request as Request); break;
      case "rejected":
        this.del("joining");
        await this.stop();
        this.setStatus("off", "参加が断られました");
        break;
      case "ok": {
        const c = this.command;
        if (c && c.re === m.re) { this.command = null; try { await c.onOk?.(); c.resolve(); } catch (e) { c.reject(e as Error); } }
        break;
      }
      case "error": this.onError(m); break;
    }
  }

  private onError(m: Msg): void {
    const c = this.command;
    if (c && c.re === m.re) {
      this.command = null;
      c.reject(new Error(String(m.code)));
      return;
    }
    if (m.code === "epoch") return void this.sendHello();
    if (m.code === "not-member" && this.json<Joining>("joining")) return; // 承認待ち
    if (m.code === "invalid-invite") {
      this.del("joining");
      void this.stop().then(() => this.setStatus("off", "招待コードが無効です（期限切れ、使用済み、または違います）"));
      return;
    }
    if (m.code === "not-member" || m.code === "no-room") {
      this.halt("この共有から外されたか、共有が存在しません");
      return;
    }
    this.error = m.code === "full" ? "共有の上限に達しました" : `中継のエラー（${String(m.code)}）`;
    this.opts.onChange?.();
  }

  private async onApplied(root: MemberRecord): Promise<void> {
    const j = this.json<Joining>("joining");
    if (!j) return;
    const v = await verifyChain([root]);
    if (!v.ok) return this.halt("共有の記録が不正です");
    const id = await this.ident();
    const digits = await confirmDigits(root.device.sign, root.device.ecdh, id.sign, id.ecdh, j.secret);
    this.set("joining", JSON.stringify({ ...j, ownerPin: root.device.sign, digits } satisfies Joining));
    this.opts.onChange?.();
  }

  /** 承認されたとき。鎖と鍵を受け取り、参加者になる。 */
  private async onWelcome(chain: MemberRecord[], welcome: { epoch: number; wrapped: string }): Promise<void> {
    const j = this.json<Joining>("joining");
    if (!j || !j.ownerPin) return;
    const v = await verifyChain(chain, j.ownerPin);
    const me = await this.ident();
    if (!v.ok || !v.chain.members.some((d) => d.sign === me.sign)) return this.halt(v.ok ? "共有の記録に、自分が含まれていません" : v.reason);
    try {
      const key = await unwrapGroupKey(me, v.chain.owner.ecdh, welcome.wrapped, infoOf(j.roomId, welcome.epoch));
      this.set("room", j.roomId);
      this.set("chain", JSON.stringify(chain));
      this.set("owner_pin", j.ownerPin);
      this.set("key", key);
      this.set("epoch", String(welcome.epoch));
      this.set("last_seq", "0");
      this.del("joining");
      this.markAllDirty();
      await this.startKeys();
      await this.refreshChain();
      this.sendHello();
    } catch {
      this.halt("共有の鍵を受け取れませんでした");
    }
  }

  private async onState(m: { chain: MemberRecord[]; epoch: number; welcome: { epoch: number; wrapped: string } | null; requests: Request[] }): Promise<void> {
    const j = this.json<Joining>("joining");
    if (j) {
      // 承認待ちの端末が、helloで承認を知った。
      if (m.welcome && j.ownerPin) await this.onWelcome(m.chain, m.welcome);
      return;
    }
    const local = this.chain();
    // 受け取った記録のうち、すでに持っているものは、同じ内容か確かめて飛ばす（違えば、鎖が分かれている）。
    const fresh: MemberRecord[] = [];
    for (const r of m.chain) {
      const have = local[r.ver - 1];
      if (!have) fresh.push(r);
      else if ((await recordHash(have)) !== (await recordHash(r))) return this.halt("共有の記録が分かれています（別のオーナーがいる可能性）");
    }
    const next = [...local, ...fresh];
    if (fresh.length > 0) {
      const v = await verifyChain(next, this.get("owner_pin") ?? undefined);
      if (!v.ok) return this.halt(v.reason);
      // 自分がオーナーなのに、自分が作っていない記録が増えた: 鍵が複製されている。
      if (this.identity && local[0]?.device.sign === this.identity.sign) {
        return this.halt("別の端末が、あなたのオーナー鍵で記録を追加しました。オーナーが2つある可能性があります");
      }
      this.set("chain", JSON.stringify(next));
      await this.refreshChain();
      const removed = !(v.chain.members.some((d) => d.sign === this.identity?.sign));
      if (removed) return this.halt("この端末は、共有から外されました");
    }
    const epoch = Number(this.get("epoch") ?? "1");
    if (m.welcome && m.welcome.epoch > epoch) {
      try {
        const v = await verifyChain(this.chain(), this.get("owner_pin") ?? undefined);
        if (!v.ok) return this.halt(v.reason);
        const key = await unwrapGroupKey(this.identity!, v.chain.owner.ecdh, m.welcome.wrapped, infoOf(this.room()!, m.welcome.epoch));
        this.set("key", key);
        this.set("epoch", String(m.welcome.epoch));
        this.set("last_seq", "0");
        this.markAllDirty();
        await this.startKeys();
      } catch {
        return this.halt("共有の鍵を受け取れませんでした");
      }
    }
    for (const r of m.requests) this.requests.set(r.device.id, r);
    await this.refreshDigits();
    this.opts.onChange?.();
  }

  private async onRequest(r: Request): Promise<void> {
    this.requests.set(r.device.id, r);
    await this.refreshDigits();
    this.opts.onChange?.();
  }

  private async refreshDigits(): Promise<void> {
    const owner = this.chain()[0]?.device;
    if (!owner) return;
    for (const r of this.requests.values()) {
      const inv = this.invites().find((i) => i.id === r.inviteId);
      this.digitsCache.set(r.device.id, inv ? await confirmDigits(owner.sign, owner.ecdh, r.device.sign, r.device.ecdh, inv.secret) : "");
    }
  }

  private async onRows(rows: RowMsg[], epoch: number, seq: number, gen: number): Promise<void> {
    if (epoch !== Number(this.get("epoch") ?? "1") || !this.keys) return;
    let bad = 0;
    for (const r of rows) {
      let ok = false;
      try {
        const payload = await this.keys.decrypt(r.blob);
        const table = this.opts.tables.find((t) => t.name === (payload as { table?: unknown })?.table);
        const row = table ? validateRow(table, payload) : null;
        if (table && row) {
          this.upsert(table, row);
          ok = true;
        }
      } catch { /* 読めない */ }
      if (!ok) bad++;
    }
    if (seq >= Number(this.get("last_seq") ?? "0")) this.set("last_seq", String(seq));
    if (gen !== this.generation) return;
    this.error = bad > 0 ? `読めない変更を${bad}件、捨てました` : null;
    if (this.state !== "online") {
      this.attempt = 0;
      this.setStatus("online", this.error);
      await this.pushDirty();
    }
    this.lastSyncAt = this.now();
    this.opts.onChange?.();
  }

  private upsert(table: SyncTable, row: Record<string, string | number>): void {
    const cols = ["uid", ...Object.keys(table.columns), "deleted", "created_at", "updated_at"];
    const sets = cols.filter((c) => c !== "uid").map((c) => `${c} = excluded.${c}`).join(", ");
    this.db.prepare(
      `INSERT INTO ${table.name} (${cols.join(", ")}, dirty) VALUES (${cols.map(() => "?").join(", ")}, 0)
       ON CONFLICT(uid) DO UPDATE SET ${sets}, dirty = 0 WHERE excluded.updated_at > ${table.name}.updated_at`,
    ).run(...cols.map((c) => row[c]!));
  }

  private onAck(m: Msg): void {
    const sent = this.inflight.get(String(m.rid));
    this.inflight.delete(String(m.rid));
    // 送ったあとに手元で変えていなければ、送信済みにする。
    if (sent) this.db.prepare(`UPDATE ${sent.table} SET dirty = 0 WHERE uid = ? AND updated_at = ?`).run(sent.uid, sent.ts);
    this.lastSyncAt = this.now();
    this.opts.onChange?.();
  }

  private async pushDirty(): Promise<void> {
    const keys = this.keys;
    if (!keys || !this.socket || this.state !== "online") return;
    const epoch = Number(this.get("epoch") ?? "1");
    for (const t of this.opts.tables) {
      const rows = this.db.prepare(`SELECT * FROM ${t.name} WHERE dirty = 1`).all() as unknown as Record<string, string | number>[];
      for (const row of rows) {
        const rid = await keys.rid(t.name, String(row.uid));
        if (this.inflight.get(rid)?.ts === row.updated_at) continue;
        this.inflight.set(rid, { table: t.name, uid: String(row.uid), ts: Number(row.updated_at) });
        const { dirty: _dirty, ...payload } = row;
        this.send({ t: "put", rid, ts: row.updated_at, blob: await keys.encrypt({ table: t.name, ...payload }), epoch });
      }
    }
  }
}
