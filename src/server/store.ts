import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { buildFixturePacket } from "./fixture.js";
import type { Answer, InboxItem, RequestStatus, ReviewPacket } from "./types.js";

/** 保存形式の版。読めない版の行があれば起動を拒否する（ADR-0007）。 */
export const LOG_VERSION = 1;

/** 状態ディレクトリの中の、依頼と回答の記録ファイル名。 */
export const LOG_FILE_NAME = "reviews.jsonl";

/** 記録ファイルの1行。追記だけを行い、書き換えない。 */
export type LogEvent =
  | { v: typeof LOG_VERSION; type: "request"; at: string; packet: ReviewPacket }
  | { v: typeof LOG_VERSION; type: "answer"; at: string; answers: Answer[] };

export interface StoreOptions {
  /** 記録ファイルのパス。省略するとプロセス内のメモリにだけ保持する。 */
  file?: string;
  /** 記録に付ける時刻（ISO 8601）。テストで固定するために差し替えられる。 */
  now?: () => string;
}

/**
 * 依頼と回答を保持する。fileを指定すると、追記専用のJSON Linesに保存し、
 * 起動時と各操作の前に、まだ読んでいない行を読み込んで状態を再現する。
 * 同じファイルを複数のプロセスが使ってもよい（同時の依頼作成だけは未対応、ADR-0007）。
 */
export class ReviewStore {
  private seq = 0;
  private readonly packets = new Map<string, ReviewPacket>();
  private readonly status = new Map<string, RequestStatus>();
  private readonly answers = new Map<string, Answer[]>();
  private readonly order: string[] = [];
  private readonly file: string | undefined;
  private readonly now: () => string;
  /** 記録ファイルのうち、読み込み済みのバイト数と行数 */
  private loadedBytes = 0;
  private loadedLines = 0;
  /** 記録を読めなかった場合の原因。以後の操作はすべて同じ理由で拒否する。 */
  private broken: Error | undefined;

  constructor(options: StoreOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? (() => new Date().toISOString());
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, "");
      this.sync();
    }
  }

  /** 保存先。メモリだけに保持している場合はundefined。 */
  get location(): string | undefined {
    return this.file;
  }

  /**
   * 1回の呼び出しで渡された依頼をまとめて作る。同じ呼び出しの依頼は同じまとまりになり、
   * 1つのUIからまとめて回答できる。別の呼び出しの依頼と同じまとまりにする手段はない。
   */
  create(items: { viewpoint: string; symbols: string[] }[], range: string): ReviewPacket[] {
    if (items.length === 0) throw new Error("依頼がない");
    this.sync();
    const group = `R${this.seq + 1}`;
    const at = this.now();
    const events: LogEvent[] = items.map((item, i) => ({
      v: LOG_VERSION,
      type: "request",
      at,
      packet: buildFixturePacket(`R${this.seq + 1 + i}`, group, item.viewpoint, item.symbols, range),
    }));
    this.record(events);
    return events.map((e) => this.packets.get((e as { packet: ReviewPacket }).packet.id)!);
  }

  get(id: string): ReviewPacket | undefined {
    this.sync();
    return this.packets.get(id);
  }

  statusOf(id: string): RequestStatus | undefined {
    this.sync();
    return this.status.get(id);
  }

  /** 指定したまとまりの依頼の一覧。 */
  inbox(group: string): InboxItem[] {
    this.sync();
    return [...this.packets.values()].filter((p) => p.group === group).map((p) => ({
      id: p.id,
      kind: p.kind,
      viewpoint: p.viewpoint,
      status: this.status.get(p.id) ?? "pending",
      symbols: p.steps.map((s) => s.symbol),
    }));
  }

  /** 指定したまとまり以外にある、未回答の依頼の数。 */
  pendingElsewhere(group: string): number {
    this.sync();
    return [...this.packets.values()].filter((p) => p.group !== group && this.status.get(p.id) === "pending").length;
  }

  /**
   * 回答を検証して記録する。不正な行が1つでもあれば何も記録しない。
   * fromは回答を送るUIが開かれた依頼のIDで、その依頼と同じまとまりの依頼にだけ回答できる。
   */
  submit(answers: Answer[], from: string): Answer[] {
    this.sync();
    const group = this.packets.get(from)?.group;
    if (group === undefined) throw new Error(`${from}: 存在しない依頼`);
    const errors: string[] = [];
    const byId = groupById(answers);
    for (const [id, list] of byId) {
      const packet = this.packets.get(id);
      if (!packet) { errors.push(`${id}: 存在しない依頼`); continue; }
      if (packet.group !== group) { errors.push(`${id}: 別に出された依頼には、この画面から回答できない`); continue; }
      if (this.status.get(id) !== "pending") errors.push(`${id}: 回答済み`);
      const decisions = list.filter((a) => a.verdict === "ok" || a.verdict === "hold");
      if (decisions.length > 0 && list.length > 1) errors.push(`${id}: 承認・保留は他の回答と同時に送れない`);
      for (const a of list) {
        if ((a.verdict === "fix" || a.verdict === "ask") && !a.comment?.trim()) {
          errors.push(`${id}: ${a.verdict}にはコメントが必要`);
        }
        if (a.ref && !refInPacket(packet, a.ref)) errors.push(`${id}: 依頼票にない参照 ${a.ref}`);
      }
    }
    if (errors.length > 0) throw new Error(errors.join("\n"));

    // 1回の送信を1行にまとめて書く。依頼ごとに回答が並ぶ順にそろえる。
    const recorded: Answer[] = [];
    for (const list of byId.values()) {
      for (const a of list) {
        const c: Answer = { id: a.id, verdict: a.verdict };
        if (a.ref) c.ref = a.ref;
        if (a.comment?.trim()) c.comment = a.comment.trim();
        recorded.push(c);
      }
    }
    this.record([{ v: LOG_VERSION, type: "answer", at: this.now(), answers: recorded }]);
    return recorded;
  }

  /** 回答済みの回答。idsを指定した場合は、その依頼の分だけを返す。 */
  answered(ids?: string[]): Answer[] {
    this.sync();
    const targets = ids && ids.length > 0 ? this.order.filter((id) => ids.includes(id)) : this.order;
    return targets.flatMap((id) => this.answers.get(id) ?? []);
  }

  /**
   * 記録を追加する。保存先があれば1回の書き込みで追記し、状態はファイルから読み直して反映する。
   * 1回の呼び出しの依頼が、途中まで書かれた状態で残らないようにするため、まとめて書く。
   */
  private record(events: LogEvent[]): void {
    if (!this.file) { for (const e of events) this.apply(e); return; }
    appendFileSync(this.file, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    this.sync();
  }

  /** 記録ファイルの、まだ読んでいない部分を読み込んで状態に反映する。 */
  private sync(): void {
    if (!this.file) return;
    if (this.broken) throw this.broken;
    try {
      this.load(this.file);
    } catch (e) {
      this.broken = e as Error;
      throw e;
    }
  }

  private load(file: string): void {
    const size = statSync(file).size;
    if (size === this.loadedBytes) return;
    if (size < this.loadedBytes) {
      throw new Error(`${file}: 記録が短くなっている（追記専用のファイルが書き換えられた）。サーバーを再起動してください`);
    }
    const buf = Buffer.alloc(size - this.loadedBytes);
    const fd = openSync(file, "r");
    try {
      let read = 0;
      while (read < buf.length) {
        const n = readSync(fd, buf, read, buf.length - read, this.loadedBytes + read);
        if (n === 0) break;
        read += n;
      }
      if (read < buf.length) throw new Error(`${file}: 読み込み中に記録が短くなった`);
    } finally {
      closeSync(fd);
    }
    if (buf[buf.length - 1] !== 0x0a) {
      throw new Error(`${file}: 最後の行が途中で終わっている`);
    }
    for (const line of buf.toString("utf8").slice(0, -1).split("\n")) {
      const lineNo = this.loadedLines + 1;
      let event: LogEvent;
      try {
        event = parseEvent(line);
        this.apply(event);
      } catch (e) {
        throw new Error(`${file}:${lineNo}: ${(e as Error).message}`);
      }
      this.loadedLines = lineNo;
    }
    this.loadedBytes = size;
  }

  /** 記録1件を状態に反映する。記録の内容は検証済みとして扱うが、整合しないものは拒否する。 */
  private apply(event: LogEvent): void {
    if (event.type === "request") {
      const { id } = event.packet;
      if (this.packets.has(id)) throw new Error(`依頼IDが重複している ${id}`);
      this.packets.set(id, event.packet);
      this.status.set(id, "pending");
      this.seq = Math.max(this.seq, Number(id.slice(1)));
      return;
    }
    const byId = groupById(event.answers);
    for (const id of byId.keys()) {
      if (!this.packets.has(id)) throw new Error(`存在しない依頼への回答 ${id}`);
      if (this.status.get(id) !== "pending") throw new Error(`回答済みの依頼への回答 ${id}`);
    }
    for (const [id, list] of byId) {
      this.answers.set(id, list);
      this.order.push(id);
      this.status.set(id, statusAfter(list));
    }
  }
}

function groupById(answers: Answer[]): Map<string, Answer[]> {
  const byId = new Map<string, Answer[]>();
  for (const a of answers) {
    const list = byId.get(a.id) ?? [];
    list.push(a);
    byId.set(a.id, list);
  }
  return byId;
}

const VERDICT_SET = new Set(["ok", "fix", "ask", "hold"]);

/** 記録の1行を読む。形が合わなければ、推測で補わずに拒否する。 */
function parseEvent(line: string): LogEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("JSONとして読めない");
  }
  if (typeof raw !== "object" || raw === null) throw new Error("記録の形が不正");
  const e = raw as Record<string, unknown>;
  if (e.v !== LOG_VERSION) throw new Error(`対応していない版 v=${JSON.stringify(e.v)}（対応: ${LOG_VERSION}）`);
  if (typeof e.at !== "string") throw new Error("atがない");
  if (e.type === "request") {
    const p = e.packet as Partial<ReviewPacket> | undefined;
    if (!p || typeof p.id !== "string" || !/^R[1-9]\d*$/.test(p.id) || typeof p.viewpoint !== "string" || !Array.isArray(p.steps)) {
      throw new Error("依頼票の形が不正");
    }
    // ADR-0008より前の記録にはまとまりがない。その依頼だけのまとまりとして扱う。
    if (p.group === undefined) p.group = p.id;
    else if (typeof p.group !== "string" || !/^R[1-9]\d*$/.test(p.group)) throw new Error("依頼票の形が不正");
    return raw as LogEvent;
  }
  if (e.type === "answer") {
    const list = e.answers;
    if (!Array.isArray(list) || list.length === 0) throw new Error("回答の形が不正");
    for (const a of list as Partial<Answer>[]) {
      if (!a || typeof a.id !== "string" || typeof a.verdict !== "string" || !VERDICT_SET.has(a.verdict)) throw new Error("回答の形が不正");
    }
    return raw as LogEvent;
  }
  throw new Error(`知らない種類 type=${JSON.stringify(e.type)}`);
}

function statusAfter(list: Answer[]): RequestStatus {
  if (list.some((a) => a.verdict === "fix")) return "fixing";
  if (list.some((a) => a.verdict === "ask")) return "answering";
  if (list.some((a) => a.verdict === "hold")) return "held";
  return "approved";
}

/** 参照が依頼票のシンボルと、その表示範囲内の行を指しているか。 */
export function refInPacket(packet: ReviewPacket, ref: string): boolean {
  const m = /^(.*)#L(\d+)(?:-L(\d+))?$/.exec(ref);
  const symbol = m ? m[1] : ref;
  const step = packet.steps.find((s) => s.symbol === symbol);
  if (!step) return false;
  if (!m) return true;
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  const last = step.startLine + step.code.split("\n").length - 1;
  return start >= step.startLine && end <= last && start <= end;
}
