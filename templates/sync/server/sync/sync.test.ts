import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RoomStore, authContext, LIMITS, type Ctx, type Out, type Sql } from "../../relay/src/room.ts";
import { createApp } from "../app.ts";
import { openDb } from "../db.ts";
import { syncTables } from "../sync-tables.ts";
import { confirmDigits, deviceId, groupKeys, inviteProof, newGroupKey, newIdentity, newInvite, parseInvite, unwrapGroupKey, verify, verifyInviteProof, wrapGroupKey } from "./crypto.ts";
import { Sync, validateRow, type SocketLike } from "./engine.ts";
import { deviceOf, makeRecord, recordHash, verifyChain } from "./membership.ts";

// ── 中継の代わり（メモリ上）。本物の中継と同じ RoomStore と認証を使う ──
function sqlOf(db: DatabaseSync): Sql {
  return { run: (q, ...p) => void db.prepare(q).run(...p), all: <T>(q: string, ...p: (string | number | null)[]) => db.prepare(q).all(...p) as unknown as T[] };
}

class FakeRelay {
  rooms = new Map<string, { store: RoomStore; sockets: Set<FakeSocket> }>();
  up = true;
  clock = { t: 1_000_000 };
  open = (url: string): SocketLike => {
    const u = new URL(url);
    const room = u.pathname.split("/room/")[1]!;
    const socket = new FakeSocket(this, room);
    setTimeout(async () => {
      const ctx = this.up ? await authContext(u.searchParams.get("a") ?? "", room, verify, deviceId, this.clock.t) : null;
      if (!ctx) return socket.fail();
      if (!this.rooms.has(room)) this.rooms.set(room, { store: new RoomStore(sqlOf(new DatabaseSync(":memory:")), () => this.clock.t), sockets: new Set() });
      socket.ctx = ctx;
      socket.connected();
    }, 0);
    return socket;
  };
  down() {
    this.up = false;
    for (const r of this.rooms.values()) for (const s of [...r.sockets]) s.fail();
  }
  async deliver(room: string, from: FakeSocket, outs: Out[], close: string[] | undefined) {
    const r = this.rooms.get(room)!;
    for (const o of outs) {
      const data = JSON.stringify(o.msg);
      if (o.to === "self") from.onmessage?.({ data });
      else if (typeof o.to === "object") {
        for (const s of r.sockets) if (s.ctx?.id === o.to.device) s.onmessage?.({ data });
      } else {
        for (const s of r.sockets) {
          if (s === from || !s.ctx) continue;
          const role = await r.store.roleOf(s.ctx.id);
          if (role === null || (o.to === "owner" && role !== "owner")) continue;
          s.onmessage?.({ data });
        }
      }
    }
    for (const id of close ?? []) for (const s of [...r.sockets]) if (s.ctx?.id === id) s.fail();
  }
}

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ctx: Ctx | null = null;
  private closed = false;
  constructor(private relay: FakeRelay, private room: string) {}
  connected() {
    if (this.closed) return;
    this.relay.rooms.get(this.room)!.sockets.add(this);
    this.onopen?.();
  }
  fail() {
    if (this.closed) return;
    this.closed = true;
    this.relay.rooms.get(this.room)?.sockets.delete(this);
    this.onclose?.();
  }
  send(data: string) {
    if (this.closed || !this.ctx) return;
    const room = this.relay.rooms.get(this.room)!;
    setTimeout(async () => {
      if (this.closed) return;
      const res = await room.store.handle(this.ctx!, data);
      await this.relay.deliver(this.room, this, res.out, res.close);
    }, 0);
  }
  close() {
    this.closed = true;
    this.relay.rooms.get(this.room)?.sockets.delete(this);
  }
}

// ── 端末の代わり ──
function device(relay: FakeRelay, label = "端末") {
  const db = openDb(":memory:");
  const now = () => ++relay.clock.t;
  const sync = new Sync(db, { url: "wss://relay.test", tables: syncTables, open: relay.open, now, backoffMs: [5, 10] });
  const app = createApp(db, now, sync);
  const req = (path: string, body?: unknown, method = "POST") => app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    label, db, sync, app, req,
    addNote: async (body: string) => ((await (await req("/api/notes", { body })).json()) as { uid: string }).uid,
    notes: async () => ((await (await app.request("/api/notes")).json()) as { uid: string; body: string }[]).map((n) => n.body).sort(),
    status: () => sync.status(),
  };
}
type Dev = ReturnType<typeof device>;

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`時間内に満たされなかった: ${what}`);
}

/** オーナーが部屋を作り、参加者を招待して承認するところまで。 */
async function room(relay: FakeRelay, ...names: string[]): Promise<{ owner: Dev; members: Dev[] }> {
  const owner = device(relay, "オーナー");
  await owner.sync.createRoom("オーナーの端末");
  await until(() => owner.status().state === "online", "オーナーがつながる");
  const members: Dev[] = [];
  for (const name of names) {
    const m = device(relay, name);
    const { code } = await owner.sync.invite();
    await m.sync.join(code, name);
    await until(() => owner.status().requests.length === 1 && m.status().joiningDigits !== null, "申し込みが届く");
    assert.equal(owner.status().requests[0]!.digits, m.status().joiningDigits, "確認の数字が同じ");
    await owner.sync.approve(owner.status().requests[0]!.id);
    await until(() => m.status().state === "online" && m.status().role === "member", `${name}が参加する`);
    members.push(m);
  }
  return { owner, members };
}

// ── 暗号 ──
test("招待コード: 作って読み戻せる。秘密を知っている証明と、確認の数字", async () => {
  const roomId = "ab".repeat(16);
  const inv = await newInvite(roomId);
  assert.match(inv.code, /^[A-Za-z0-9_-]{35}$/);
  const parsed = await parseInvite(inv.code);
  assert.equal(parsed?.roomId, roomId);
  assert.equal(parsed?.secret, inv.secret);
  assert.equal(parsed?.verifier, inv.verifier);
  assert.equal(await parseInvite("短い"), null);
  assert.notEqual(inv.secret, inv.verifier); // 中継に渡す値から、秘密は分からない
  const proof = await inviteProof(inv.verifier, "n1", "S", "E");
  assert.ok(await verifyInviteProof(inv.verifier, "n1", "S", "E", proof));
  assert.equal(await verifyInviteProof(inv.verifier, "n2", "S", "E", proof), false); // 別の接続では使えない
  assert.equal(await verifyInviteProof(inv.verifier, "n1", "S2", "E", proof), false); // 別の端末では使えない
  const a = await confirmDigits("os", "oe", "as", "ae", inv.secret);
  assert.match(a, /^\d{4}$/);
  assert.equal(a, await confirmDigits("os", "oe", "as", "ae", inv.secret));
  // 中継が鍵をすり替えると（招待の秘密を知らないので）数字が合わない。
  assert.notEqual(a, await confirmDigits("os", "oe", "evil", "ae", inv.secret));
});

test("グループ鍵: 暗号化と復号、別の鍵では読めない。端末の鍵で包んで渡せる", async () => {
  const k = newGroupKey();
  const a = await groupKeys(k);
  const b = await groupKeys(k);
  const other = await groupKeys(newGroupKey());
  assert.equal(await a.rid("notes", "u1"), await b.rid("notes", "u1"));
  assert.notEqual(await a.rid("notes", "u1"), await a.rid("tasks", "u1"));
  const blob = await a.encrypt({ x: 1 });
  assert.deepEqual(await b.decrypt(blob), { x: 1 });
  await assert.rejects(other.decrypt(blob));

  const owner = await newIdentity();
  const member = await newIdentity();
  const wrapped = await wrapGroupKey(owner, member.ecdh, k, "room|1");
  assert.equal(await unwrapGroupKey(member, owner.ecdh, wrapped, "room|1"), k);
  await assert.rejects(unwrapGroupKey(member, owner.ecdh, wrapped, "room|2")); // 別の世代では開けない
  await assert.rejects(unwrapGroupKey(await newIdentity(), owner.ecdh, wrapped, "room|1")); // 別の端末では開けない
});

// ── 参加者の記録（鎖）──
test("鎖: オーナーの署名つきの記録を検証し、改ざん・別の署名・分岐を見つける", async () => {
  const owner = await newIdentity();
  const m1 = await newIdentity();
  const m2 = await newIdentity();
  const root = await makeRecord(owner, { ver: 1, prev: "", type: "root", device: await deviceOf(owner, "親"), ts: 1 });
  const add1 = await makeRecord(owner, { ver: 2, prev: await recordHash(root), type: "add", device: await deviceOf(m1, "子1"), ts: 2 });
  const add2 = await makeRecord(owner, { ver: 3, prev: await recordHash(add1), type: "add", device: await deviceOf(m2, "子2"), ts: 3 });
  const ok = await verifyChain([root, add1, add2]);
  assert.ok(ok.ok && ok.chain.members.length === 3 && ok.chain.owner.name === "親");
  const rm = await makeRecord(owner, { ver: 4, prev: await recordHash(add2), type: "remove", device: await deviceOf(m1, "子1"), ts: 4 });
  const after = await verifyChain([root, add1, add2, rm]);
  assert.ok(after.ok && after.chain.members.map((d) => d.name).sort().join() === "子2,親");

  // 改ざん
  assert.equal((await verifyChain([root, { ...add1, device: { ...add1.device, name: "偽" } }])).ok, false);
  // オーナー以外の署名（別のオーナーがいる可能性）
  const other = await newIdentity();
  const forged = await makeRecord(other, { ver: 2, prev: await recordHash(root), type: "add", device: await deviceOf(m1, "子1"), ts: 2 });
  const r1 = await verifyChain([root, forged]);
  assert.ok(!r1.ok && /別のオーナー/.test(r1.reason));
  // 2つ目のroot（オーナーが2つ）
  const root2 = await makeRecord(other, { ver: 2, prev: await recordHash(root), type: "root", device: await deviceOf(other, "別"), ts: 2 });
  const r2 = await verifyChain([root, root2]);
  assert.ok(!r2.ok && /オーナーが2つ/.test(r2.reason));
  // 番号が飛ぶ、つながりが合わない、オーナーを外す
  assert.equal((await verifyChain([root, { ...add1, ver: 3 }])).ok, false);
  assert.equal((await verifyChain([root, { ...add1, prev: "x" }])).ok, false);
  const rmOwner = await makeRecord(owner, { ver: 2, prev: await recordHash(root), type: "remove", device: await deviceOf(owner, "親"), ts: 2 });
  assert.equal((await verifyChain([root, rmOwner])).ok, false);
  // 参加時に確かめたオーナーの鍵と違う
  assert.equal((await verifyChain([root], other.sign)).ok, false);
  assert.equal((await verifyChain([root], owner.sign)).ok, true);
});

// ── 中継の部屋 ──
test("中継: 部屋を作れるのは最初の1回だけ。参加者以外は、行を読み書きできない", async () => {
  const store = new RoomStore(sqlOf(new DatabaseSync(":memory:")));
  const owner = await newIdentity();
  const ctxOf = async (id: Awaited<ReturnType<typeof newIdentity>>): Promise<Ctx> => ({ id: await deviceId(id.sign), sign: id.sign, nonce: "n" });
  const root = await makeRecord(owner, { ver: 1, prev: "", type: "root", device: await deviceOf(owner, "親"), ts: 1 });
  const stranger = await ctxOf(await newIdentity());
  assert.equal((await store.handle(stranger, JSON.stringify({ t: "hello", since: 0, ver: 0, epoch: 1 }))).out[0]!.msg.t, "error");
  // 他人の鍵の記録では作れない
  assert.equal((await store.handle(stranger, JSON.stringify({ t: "create", rec: root }))).out[0]!.msg.t, "error");
  const octx = await ctxOf(owner);
  assert.equal((await store.handle(octx, JSON.stringify({ t: "create", rec: root }))).out[0]!.msg.t, "created");
  assert.equal((await store.handle(octx, JSON.stringify({ t: "create", rec: root }))).out[0]!.msg.t, "error"); // 2回目は不可
  for (const msg of [{ t: "hello", since: 0, ver: 0, epoch: 1 }, { t: "put", rid: "r", ts: 1, blob: "x", epoch: 1 }]) {
    const r = await store.handle(stranger, JSON.stringify(msg));
    assert.deepEqual(r.out[0]!.msg, { t: "error", code: "not-member", re: msg.t });
  }
  // 参加者は、新しいtsが勝つ。上限もある。
  const put = async (rid: string, ts: number) => store.handle(octx, JSON.stringify({ t: "put", rid, ts, blob: "x", epoch: 1 }));
  assert.deepEqual((await put("r", 10)).out[0]!.msg, { t: "ack", rid: "r", ts: 10, seq: 1, applied: true });
  assert.equal(((await put("r", 5)).out[0]!.msg as { applied: boolean }).applied, false);
  assert.deepEqual((await store.handle(octx, JSON.stringify({ t: "put", rid: "r", ts: 20, blob: "x".repeat(LIMITS.blobChars + 1), epoch: 1 }))).out[0]!.msg, { t: "error", code: "bad-message", re: "put" });
  assert.deepEqual((await store.handle(octx, JSON.stringify({ t: "put", rid: "r", ts: 20, blob: "x", epoch: 2 }))).out[0]!.msg, { t: "error", code: "epoch", re: "put" });
  for (let i = 0; i < LIMITS.rows; i++) await put(`k${i}`, 1);
  assert.deepEqual((await put("over", 1)).out[0]!.msg, { t: "error", code: "full", re: "put" });
});

test("中継: 招待は1回だけ、期限つき。証明が違う申し込みは断る", async () => {
  const relay = new FakeRelay();
  const clock = relay.clock;
  const owner = device(relay);
  await owner.sync.createRoom("親");
  await until(() => owner.status().state === "online", "つながる");
  const { code } = await owner.sync.invite();
  const a = device(relay);
  await a.sync.join(code, "A");
  await until(() => owner.status().requests.length === 1, "Aの申し込み");
  // 同じコードの2回目（使用済み）
  const b = device(relay);
  await b.sync.join(code, "B");
  await until(() => b.status().error !== null, "Bは断られる");
  assert.match(b.status().error!, /招待コードが無効/);
  assert.equal(owner.status().requests.length, 1);
  // 期限切れ
  const { code: old } = await owner.sync.invite();
  clock.t += 16 * 60 * 1000;
  const c = device(relay);
  await c.sync.join(old, "C");
  await until(() => c.status().error !== null, "期限切れで断られる");
});

// ── 同期 ──
test("オーナー1人と参加者2人: 追加・削除がそれぞれに届く", async () => {
  const relay = new FakeRelay();
  const { owner, members: [m1, m2] } = await room(relay, "妻", "子");
  assert.equal(owner.status().members.length, 3);
  assert.equal(m1!.status().members.length, 3);
  await owner.addNote("牛乳");
  await until(async () => (await m1!.notes()).length === 1 && (await m2!.notes()).length === 1, "全員に届く");
  const uid = await m1!.addNote("卵");
  await until(async () => (await owner.notes()).length === 2 && (await m2!.notes()).length === 2, "参加者の追加が届く");
  assert.equal((await m2!.req(`/api/notes/${uid}`, undefined, "DELETE")).status, 204);
  await until(async () => (await owner.notes()).length === 1 && (await m1!.notes()).length === 1, "削除が届く");
  for (const d of [owner, m1!, m2!]) await d.sync.leave();
});

test("参加前のメモも、参加後に共有される。参加者の端末も、あとから参加できる", async () => {
  const relay = new FakeRelay();
  const { owner, members: [m1] } = await room(relay, "妻");
  await owner.addNote("O1");
  await until(async () => (await m1!.notes()).length === 1, "届く");
  const late = device(relay, "遅れて参加");
  await late.addNote("L1");
  const { code } = await owner.sync.invite();
  await late.sync.join(code, "遅れて参加");
  await until(() => owner.status().requests.length === 1, "申し込み");
  await owner.sync.approve(owner.status().requests[0]!.id);
  await until(async () => (await late.notes()).length === 2 && (await owner.notes()).length === 2 && (await m1!.notes()).length === 2, "全員に2件");
});

test("オフライン中の変更は端末に溜まり、中継が戻ると送られる", async () => {
  const relay = new FakeRelay();
  const { owner, members: [m] } = await room(relay, "妻");
  relay.down();
  await until(() => owner.status().state === "offline" && m!.status().state === "offline", "オフラインになる");
  await owner.addNote("オフラインで");
  assert.equal(owner.status().pending, 1);
  assert.equal((await owner.notes()).length, 1);
  relay.up = true;
  await until(async () => (await m!.notes()).length === 1, "戻ると届く");
  await until(() => owner.status().pending === 0, "溜まりが空になる");
});

test("参加者を外すと、その端末は止まり、鍵が新しくなり、残りの端末は同期を続ける", async () => {
  const relay = new FakeRelay();
  const { owner, members: [m1, m2] } = await room(relay, "外す人", "残る人");
  await owner.addNote("外す前");
  await until(async () => (await m1!.notes()).length === 1 && (await m2!.notes()).length === 1, "届く");
  const target = owner.status().members.find((x) => x.name === "外す人")!;
  await owner.sync.remove(target.id);
  await until(() => m1!.status().alert !== null, "外された端末が止まる");
  assert.match(m1!.status().alert!, /外されました|存在しません/);
  assert.equal(owner.status().members.length, 2);
  // 外した後の変更は、外された端末に届かず、残る端末には届く。
  await owner.addNote("外した後");
  await until(async () => (await m2!.notes()).length === 2, "残る端末に届く");
  assert.equal((await m1!.notes()).length, 1);
  // 残る端末が追加しても、オーナーに届く。
  await m2!.addNote("残る人の");
  await until(async () => (await owner.notes()).length === 3, "オーナーに届く");
});

test("同じメモを同時に変えたら、新しいほうが勝つ（古い変更は上書きされない）", async () => {
  const relay = new FakeRelay();
  const { owner, members: [m] } = await room(relay, "妻");
  const uid = await owner.addNote("x");
  await until(async () => (await m!.notes()).length === 1, "届く");
  relay.down();
  await until(() => owner.status().state === "offline" && m!.status().state === "offline", "両方オフライン");
  owner.db.prepare("UPDATE notes SET body = ?, updated_at = ?, dirty = 1 WHERE uid = ?").run("古い", relay.clock.t + 1, uid);
  m!.db.prepare("UPDATE notes SET body = ?, updated_at = ?, dirty = 1 WHERE uid = ?").run("新しい", relay.clock.t + 1000, uid);
  relay.up = true;
  await until(async () => (await owner.notes())[0] === "新しい" && (await m!.notes())[0] === "新しい", "新しいほうに揃う");
});

test("オーナーの鍵が複製されて、別の端末が記録を足すと、オーナーがアラートを出して止まる", async () => {
  const relay = new FakeRelay();
  const { owner } = await room(relay);
  // 複製した別の端末（同じ鍵）が、勝手に参加者を足す（中継に直接送る）。
  const clone = device(relay, "複製");
  const stolen = JSON.parse(owner.db.prepare("SELECT value FROM sync_state WHERE key = 'identity'").get()!.value as string);
  clone.db.prepare("INSERT INTO sync_state (key, value) VALUES ('identity', ?)").run(JSON.stringify(stolen));
  const roomId = owner.db.prepare("SELECT value FROM sync_state WHERE key = 'room'").get()!.value as string;
  const chain = JSON.parse(owner.db.prepare("SELECT value FROM sync_state WHERE key = 'chain'").get()!.value as string);
  const intruder = await newIdentity();
  const add = await makeRecord(stolen, { ver: 2, prev: await recordHash(chain[0]), type: "add", device: await deviceOf(intruder, "侵入"), ts: 5 });
  // 中継の部屋に、侵入者の申し込みを作ってから、複製したオーナー鍵で承認する。
  const store = relay.rooms.get(roomId)!.store;
  const iid = await deviceId(intruder.sign);
  const inv = await newInvite(roomId);
  const octx = { id: await deviceId(stolen.sign), sign: stolen.sign, nonce: "n" };
  await store.handle(octx, JSON.stringify({ t: "invite", id: inv.id, verifier: inv.verifier, exp: relay.clock.t + 1000 }));
  const device1 = await deviceOf(intruder, "侵入");
  await store.handle({ id: iid, sign: intruder.sign, nonce: "n2" }, JSON.stringify({ t: "apply", inviteId: inv.id, proof: await inviteProof(inv.verifier, "n2", device1.sign, device1.ecdh), device: device1 }));
  const res = await store.handle(octx, JSON.stringify({ t: "approve", rec: add, welcome: { wrapped: "w", from: stolen.ecdh } }));
  assert.equal(res.out[0]!.msg.t, "ok");
  // オーナー本人が、つなぎ直したとき（helloで、自分が作っていない記録が見える）。
  relay.down();
  await until(() => owner.status().state === "offline", "切れる");
  relay.up = true;
  await until(() => owner.status().alert !== null, "アラートが出る");
  assert.match(owner.status().alert!, /オーナー鍵|オーナーが2つ/);
  assert.equal(owner.status().state, "stopped");
});

test("参加者の端末には、別のオーナーの署名がある記録が来たら、止まる", async () => {
  const relay = new FakeRelay();
  const { owner, members: [m] } = await room(relay, "妻");
  const roomId = owner.db.prepare("SELECT value FROM sync_state WHERE key = 'room'").get()!.value as string;
  const chain = JSON.parse(owner.db.prepare("SELECT value FROM sync_state WHERE key = 'chain'").get()!.value as string);
  const evil = await newIdentity();
  const rec = await makeRecord(evil, { ver: chain.length + 1, prev: await recordHash(chain[chain.length - 1]), type: "add", device: await deviceOf(evil, "偽オーナー"), ts: 9 });
  // 中継が（侵害されて）偽の記録を送ってきたとして、参加者の端末が自分で検証して止まる。
  const mine = m!.status().members.find((x) => x.isMe)!.id;
  for (const sock of relay.rooms.get(roomId)!.sockets) {
    if (sock.ctx?.id === mine) sock.onmessage?.({ data: JSON.stringify({ t: "state", chain: [rec], epoch: 1, welcome: null, requests: [] }) });
  }
  await until(() => m!.status().alert !== null, "アラートが出る");
  assert.match(m!.status().alert!, /別のオーナー|オーナー以外/);
});

test("参加を断られると、参加の申し込みは消える。確認の数字は、すり替えると合わない", async () => {
  const relay = new FakeRelay();
  const owner = device(relay);
  await owner.sync.createRoom("親");
  await until(() => owner.status().state === "online", "つながる");
  const { code } = await owner.sync.invite();
  const m = device(relay);
  await m.sync.join(code, "知らない人");
  await until(() => owner.status().requests.length === 1, "申し込み");
  await owner.sync.reject(owner.status().requests[0]!.id);
  await until(() => m.status().error === "参加が断られました", "断られる");
  assert.equal(m.status().state, "off");
  assert.equal(owner.status().members.length, 1);
});

test("同期のURLがなければ、同期は使えないが、アプリは動く", async () => {
  const db = openDb(":memory:");
  const sync = new Sync(db, { url: undefined, tables: syncTables });
  const app = createApp(db, Date.now, sync);
  assert.equal(sync.status().state, "unavailable");
  assert.equal((await app.request("/api/sync/create-room", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) })).status, 400);
  assert.equal((await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "x" }) })).status, 201);
});

test("届いた行の検証: 形の合わない行は捨てる", () => {
  const table = syncTables[0]!;
  const good = { table: "notes", uid: "11111111-1111-1111-1111-111111111111", body: "ok", deleted: 0, created_at: 1, updated_at: 2 };
  assert.ok(validateRow(table, good));
  for (const bad of [{ ...good, table: "other" }, { ...good, uid: "../x" }, { ...good, body: "" }, { ...good, body: "x".repeat(1001) }, { ...good, deleted: 2 }, { ...good, updated_at: -1 }, null, "x"]) {
    assert.equal(validateRow(table, bad), null);
  }
});
