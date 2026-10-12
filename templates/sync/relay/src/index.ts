// 同期の中継（Cloudflare Workers + Durable Objects）。端末どうしの暗号化された変更を受け渡すだけで、内容は読めない。
// 部屋は /room/<部屋の名前> ごとに1つ。接続するには、端末の鍵で署名した証明（?a=）が要る。
// 証明のない接続は、部屋（Durable Object）に入る前に、Workerで断る。
import { DurableObject } from "cloudflare:workers";
import { deviceId, verify } from "../../server/sync/crypto.ts";
import { RoomStore, authContext, type Ctx, type Out } from "./room.ts";

interface Env {
  ROOM: DurableObjectNamespace<Room>;
  /** 接続を許す画面のオリジン（カンマ区切り）。 */
  ALLOWED_ORIGINS: string;
}

const ROOM_PATH = /^\/room\/([0-9a-f]{32})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = ROOM_PATH.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    // ブラウザは、WebSocketのOriginを偽れない。許したアプリの画面以外のブラウザからの接続は断る。
    const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(request.headers.get("origin") ?? "")) return new Response("forbidden origin", { status: 403 });
    const ctx = await authContext(url.searchParams.get("a") ?? "", match[1]!, verify, deviceId, Date.now());
    if (!ctx) return new Response("unauthorized", { status: 401 });
    const headers = new Headers(request.headers);
    headers.set("x-inloop-ctx", JSON.stringify(ctx));
    return env.ROOM.get(env.ROOM.idFromName(match[1]!)).fetch(new Request(request, { headers }));
  },
};

const IDLE_EMPTY_MS = 24 * 60 * 60 * 1000;
const IDLE_ROOM_MS = 90 * 24 * 60 * 60 * 1000;

export class Room extends DurableObject<Env> {
  private readonly store: RoomStore;
  private readonly recent = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.store = new RoomStore({
      run: (q, ...p) => void sql.exec(q, ...p),
      all: <T>(q: string, ...p: (string | number | null)[]) => sql.exec(q, ...p).toArray() as T[],
    });
  }

  async fetch(request: Request): Promise<Response> {
    const ctx = JSON.parse(request.headers.get("x-inloop-ctx") ?? "null") as Ctx | null;
    if (!ctx) return new Response("unauthorized", { status: 401 });
    const pair = new WebSocketPair();
    // 休止（ハイバネーション）できる受け付け方。誰も操作しない間は、実行時間が数えられない。
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(ctx);
    // 使われない部屋は、あとで自動で消す（部屋が作られないまま放置されたものは、1日で消す）。
    if ((await this.store.roleOf(ctx.id)) === null) await this.ctx.storage.setAlarm(Date.now() + IDLE_EMPTY_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const ctx = ws.deserializeAttachment() as Ctx | null;
    if (!ctx) return ws.close(1008, "unauthorized");
    // 大きすぎる、または多すぎるメッセージを送る接続は切る。
    const now = Date.now();
    const times = (this.recent.get(ctx.id) ?? []).filter((t) => now - t < 1000);
    times.push(now);
    this.recent.set(ctx.id, times);
    if (typeof message !== "string" || message.length > 64 * 1024 || times.length > 40) return ws.close(1008, "too many or too large messages");
    const result = await this.store.handle(ctx, message);
    await this.deliver(ws, ctx, result.out);
    for (const id of result.close ?? []) for (const s of this.sockets(id)) s.close(1000, "removed");
    if (result.out.some((o) => o.msg.t === "created" || o.msg.t === "state")) await this.ctx.storage.setAlarm(Date.now() + IDLE_ROOM_MS);
  }

  webSocketClose(ws: WebSocket, code: number): void {
    ws.close(code, "closed");
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private sockets(id: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((s) => (s.deserializeAttachment() as Ctx | null)?.id === id);
  }

  private async deliver(self: WebSocket, ctx: Ctx, outs: Out[]): Promise<void> {
    for (const o of outs) {
      const data = JSON.stringify(o.msg);
      if (o.to === "self") self.send(data);
      else if (typeof o.to === "object") for (const s of this.sockets(o.to.device)) s.send(data);
      else {
        for (const s of this.ctx.getWebSockets()) {
          const c = s.deserializeAttachment() as Ctx | null;
          if (!c || c.id === ctx.id) continue;
          const role = await this.store.roleOf(c.id);
          if (role === null || (o.to === "owner" && role !== "owner")) continue;
          s.send(data);
        }
      }
    }
  }
}
