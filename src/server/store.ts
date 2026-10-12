import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { buildFixturePacket } from "./fixture.js";
import type { BoundaryHit } from "../engine/boundaries.js";
import type { PlannedReview } from "../engine/build.js";
import type { Answer, AnswerRound, InboxItem, RequestStatus, ReviewPacket } from "./types.js";

/**
 * 保存形式の版。読めない版の行があれば起動を拒否する（ADR-0007）。
 * 版を上げるのは、すでにある行をそのまま読めなくなるときか、古い実装が新しい行を
 * 拒否せずに別の意味で読んでしまうときに限る（ADR-0009）。
 */
export const LOG_VERSION = 1;

/** 状態ディレクトリの中の、依頼と回答の記録ファイル名。 */
export const LOG_FILE_NAME = "reviews.jsonl";

/** 記録ファイルの1行。追記だけを行い、書き換えない。 */
export type LogEvent =
  | { v: typeof LOG_VERSION; type: "request"; at: string; packet: ReviewPacket }
  | { v: typeof LOG_VERSION; type: "answer"; at: string; answers: Answer[] }
  // 会話での人の指示を受けて、AIが記録した承認・保留（ADR-0017）。古い実装が人の回答と読み違えないよう、別の種類にする。
  | { v: typeof LOG_VERSION; type: "chatAnswer"; at: string; answers: Answer[] }
  | { v: typeof LOG_VERSION; type: "reopen"; at: string; ids: string[] };

/** 1回の呼び出しで渡される依頼。followsがあれば、その依頼の再依頼になる。 */
export interface NewReview {
  viewpoint?: string;
  symbols?: string[];
  /** 再依頼する元の依頼のID。同じ系列のIDならどれでもよい。 */
  follows?: string;
}

/** 依頼ID。`R13`は新しい依頼、`R13-2`はその2回目の再依頼。 */
const ID_PATTERN = /^R([1-9]\d*)(?:-([1-9]\d*))?$/;

function parseId(id: string): { root: string; number: number; branch: number } | undefined {
  const m = ID_PATTERN.exec(id);
  return m ? { root: `R${m[1]}`, number: Number(m[1]), branch: m[2] ? Number(m[2]) : 0 } : undefined;
}

const idOf = (root: string, branch: number) => (branch === 0 ? root : `${root}-${branch}`);

export interface StoreOptions {
  /** 記録ファイルのパス。省略するとプロセス内のメモリにだけ保持する。 */
  file?: string;
  /** 記録に付ける時刻（ISO 8601）。テストで固定するために差し替えられる。 */
  now?: () => string;
  /**
   * 依頼票の作り方。1回の呼び出しの依頼をまとめて受け取る。例外を投げれば、何も記録しない。
   * 省略すると固定データの依頼票を作る（解析エンジンを使わない記録先、ADR-0015）。
   */
  build?: PacketBuilder;
}

/**
 * 依頼票の作り方。requiredは、信頼境界ルールに当たった単位から必須の依頼を決める（ADR-0022）。
 * 解析エンジンは、ルールを当てた結果を渡して呼び、返った依頼の依頼票も作る。固定データでは使わない。
 * 返す依頼票のまとまり（group）は、ReviewStoreが決め直す。
 */
export type PacketBuilder = (reviews: PlannedReview[], range: string, required: (hits: BoundaryHit[]) => PlannedReview[]) => ReviewPacket[];

const fixtureBuilder: PacketBuilder = (reviews, range) =>
  reviews.map((r) => buildFixturePacket(r.id, r.group, r.viewpoint, r.symbols, range));

/**
 * 依頼と回答を保持する。fileを指定すると、追記専用のJSON Linesに保存し、
 * 起動時と各操作の前に、まだ読んでいない行を読み込んで状態を再現する。
 * 同じファイルを複数のプロセスが使ってもよい（同時の依頼作成だけは未対応、ADR-0007）。
 */
export class ReviewStore {
  private seq = 0;
  private readonly packets = new Map<string, ReviewPacket>();
  private readonly status = new Map<string, RequestStatus>();
  /** 現在の状態を決めた回答。未回答に戻すと消える。 */
  private readonly answers = new Map<string, Answer[]>();
  /** 回答がある依頼のID。回答された順。 */
  private order: string[] = [];
  /** これまでに記録した回答のすべて。依頼ごとに、送信された順。 */
  private readonly rounds = new Map<string, Answer[][]>();
  /** 系列（枝番を除いたID）ごとの、最新の枝番。 */
  private readonly heads = new Map<string, number>();
  /** 再依頼済みの依頼と、それを引き継いだ依頼。 */
  private readonly successors = new Map<string, string>();
  private readonly file: string | undefined;
  private readonly now: () => string;
  private readonly build: PacketBuilder;
  /** 記録ファイルのうち、読み込み済みのバイト数と行数 */
  private loadedBytes = 0;
  private loadedLines = 0;
  /** 記録を読めなかった場合の原因。以後の操作はすべて同じ理由で拒否する。 */
  private broken: Error | undefined;

  constructor(options: StoreOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? (() => new Date().toISOString());
    this.build = options.build ?? fixtureBuilder;
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
   * 信頼境界ルールに当たった変更の必須の依頼も、同じまとまりに加わる（ADR-0022）。itemsは空でもよい。
   * followsのある依頼は再依頼で、元の依頼の系列に枝番を足したIDになり、それまでの
   * 最新の依頼は再依頼済みになる。不正な依頼が1つでもあれば何も記録しない。
   */
  create(items: NewReview[], range: string): ReviewPacket[] {
    this.sync();
    const errors: string[] = [];
    const roots = new Set<string>();
    let fresh = 0;
    const planned = items.map((item): PlannedReview | undefined => {
      if (item.follows === undefined) {
        if (!item.viewpoint?.trim()) errors.push("観点がない");
        return { id: `R${this.seq + ++fresh}`, group: "", viewpoint: item.viewpoint ?? "", symbols: item.symbols ?? [] };
      }
      const root = this.packets.has(item.follows) ? parseId(item.follows)!.root : undefined;
      if (root === undefined) { errors.push(`${item.follows}: 存在しない依頼`); return undefined; }
      if (roots.has(root)) { errors.push(`${item.follows}: 同じ依頼への再依頼が重複している`); return undefined; }
      roots.add(root);
      // 元の依頼として系列のどのIDが渡されても、引き継ぐのは最新の依頼になる。
      const branch = this.heads.get(root)!;
      const head = this.packets.get(idOf(root, branch))!;
      const id = idOf(root, branch + 1);
      if (head.kind === "required" && !head.fixture) {
        // 必須の依頼は、種別・根拠のルール・対象・観点を引き継ぎ、AIは変えられない（ADR-0022）。
        if (item.symbols !== undefined && !sameList(item.symbols, head.requestedSymbols)) errors.push(`${item.follows}: 必須の依頼の対象は変えられない`);
        if (item.viewpoint?.trim() && item.viewpoint !== head.viewpoint) errors.push(`${item.follows}: 必須の依頼の観点は変えられない`);
        return { id, group: "", viewpoint: head.viewpoint, symbols: head.requestedSymbols, kind: "required", triggeredBy: head.triggeredBy, ...this.priorOf(head) };
      }
      return {
        id,
        group: "",
        viewpoint: item.viewpoint?.trim() ? item.viewpoint : head.viewpoint,
        symbols: item.symbols ?? head.requestedSymbols,
        ...this.priorOf(head),
      };
    });
    if (errors.length > 0) throw new Error(errors.join("\n"));
    // 信頼境界ルールに当たった単位ごとの必須の依頼（ADR-0022）。同じ単位の必須の系列があり、
    // 最新の依頼票のコードが今と同じなら作らない。違えば、その系列の再依頼にする。
    const required = (hits: BoundaryHit[]): PlannedReview[] => hits.flatMap((h): PlannedReview[] => {
      const head = this.requiredHead(h.symbol);
      if (head === undefined) return [{ id: `R${this.seq + ++fresh}`, group: "", viewpoint: h.question, symbols: [h.symbol], kind: "required", triggeredBy: h.rules }];
      const { root, branch } = parseId(head.id)!;
      if (roots.has(root) || codeOf(head, h.symbol) === h.code) return [];
      roots.add(root);
      const rules = [...new Set([...head.triggeredBy, ...h.rules])].sort();
      const viewpoint = [...new Set([...head.viewpoint.split("\n"), ...h.question.split("\n")])].join("\n");
      return [{ id: idOf(root, branch + 1), group: "", viewpoint: rules.every((r) => h.rules.includes(r)) ? h.question : viewpoint, symbols: [h.symbol], kind: "required", triggeredBy: rules, ...this.priorOf(head) }];
    });
    const at = this.now();
    // 依頼票を作れなければ（見つからないシンボルなど）、ここで例外になり、何も記録しない。
    const built = this.build(planned.map((p) => p!), range, required);
    if (built.length === 0) throw new Error("依頼がない（ルールに当たる変更もない）");
    // まとまりは、その呼び出しで最初に作った依頼のID（ADR-0008）。必須の依頼だけの呼び出しもある。
    const group = built[0]!.id;
    const packets = built.map((p) => ({ ...p, group }));
    const events: LogEvent[] = packets.map((packet) => ({ v: LOG_VERSION, type: "request", at, packet }));
    this.record(events);
    return packets.map((p) => this.packets.get(p.id)!);
  }

  /**
   * 再依頼で、前の依頼票のうち人が読み終えたシンボルのコード（ADR-0029）。
   * 前の依頼に回答があり、保留でも、シンボルの分からない修正・質問でもないときだけ、
   * 修正・質問の対象になったシンボルを除いた全シンボルのコードを返す。それ以外は何も返さない（全部を見せる）。
   */
  private priorOf(head: ReviewPacket): { prior: NonNullable<PlannedReview["prior"]> } | undefined {
    const answers = (this.rounds.get(head.id) ?? []).flat();
    if (answers.length === 0 || answers.some((a) => a.verdict === "hold" || ((a.verdict === "fix" || a.verdict === "ask") && !a.ref))) return undefined;
    const flagged = new Set(answers.filter((a) => a.verdict === "fix" || a.verdict === "ask").map((a) => a.ref!.replace(/#L\d+(?:-L\d+)?$/, "")));
    return { prior: { id: head.id, codes: Object.fromEntries(head.steps.filter((s) => !flagged.has(s.symbol)).map((s) => [s.symbol, s.code])) } };
  }

  /** そのシンボルだけを対象にした、必須の系列の最新の依頼（ADR-0022）。なければundefined。 */
  requiredHead(symbol: string): ReviewPacket | undefined {
    this.sync();
    let found: ReviewPacket | undefined;
    for (const [root, branch] of this.heads) {
      const p = this.packets.get(idOf(root, branch))!;
      if (p.kind === "required" && !p.fixture && p.requestedSymbols.length === 1 && p.requestedSymbols[0] === symbol) {
        if (!found || parseId(p.id)!.number > parseId(found.id)!.number) found = p;
      }
    }
    return found;
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
      ...(this.successors.has(p.id) ? { supersededBy: this.successors.get(p.id)! } : {}),
      ...(this.answers.get(p.id)?.[0]?.by === "chat" ? { by: "chat" as const } : {}),
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
  submit(answers: Answer[], from: string, options: { by?: "chat" } = {}): Answer[] {
    this.sync();
    const group = this.packets.get(from)?.group;
    if (group === undefined) throw new Error(`${from}: 存在しない依頼`);
    const errors: string[] = [];
    const byId = groupById(answers);
    for (const [id, list] of byId) {
      const packet = this.packets.get(id);
      if (!packet) { errors.push(`${id}: 存在しない依頼`); continue; }
      if (packet.group !== group) { errors.push(`${id}: 別に出された依頼には、この画面から回答できない`); continue; }
      const status = this.status.get(id);
      if (status === "superseded") errors.push(`${id}: 再依頼済み（${this.successors.get(id)}に回答する）`);
      else if (status !== "pending") errors.push(`${id}: 回答済み`);
      const decisions = list.filter((a) => a.verdict === "ok" || a.verdict === "hold");
      if (options.by === "chat") {
        // 会話から記録できるのは承認・保留だけ。必須の依頼は、画面で人が答える（ADR-0001、ADR-0017）。
        if (decisions.length !== list.length) errors.push(`${id}: 会話から記録できるのは承認・保留だけ`);
        if (packet.kind === "required") errors.push(`${id}: 必須の依頼は、画面で回答する`);
      }
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
    this.record([{ v: LOG_VERSION, type: options.by === "chat" ? "chatAnswer" : "answer", at: this.now(), answers: recorded }]);
    return recorded;
  }

  /**
   * 保留中・回答待ちの依頼を、同じ依頼票のまま未回答に戻す。戻せない依頼が1つでもあれば
   * 何も記録しない。fromは、submitと同じく、UIが開かれた依頼のID。
   * 修正待ちの依頼は戻せない。依頼票が修正前のものなので、AIの再依頼で引き継ぐ。
   */
  reopen(ids: string[], from: string): void {
    this.sync();
    const group = this.packets.get(from)?.group;
    if (group === undefined) throw new Error(`${from}: 存在しない依頼`);
    if (ids.length === 0) throw new Error("依頼がない");
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const packet = this.packets.get(id);
      if (!packet) { errors.push(`${id}: 存在しない依頼`); continue; }
      if (packet.group !== group) { errors.push(`${id}: 別に出された依頼は、この画面から戻せない`); continue; }
      if (seen.has(id)) errors.push(`${id}: 重複している`);
      seen.add(id);
      const status = this.status.get(id)!;
      if (!REOPENABLE.has(status)) errors.push(`${id}: ${status}の依頼は未回答に戻せない`);
    }
    if (errors.length > 0) throw new Error(errors.join("\n"));
    this.record([{ v: LOG_VERSION, type: "reopen", at: this.now(), ids }]);
  }

  /**
   * その依頼と、同じ系列でそれより前の依頼に、これまで記録された回答。送信された順。
   * 再依頼のUIで、前回の指摘を見せるために使う。AIには返さない。
   */
  history(id: string): AnswerRound[] {
    this.sync();
    const parsed = this.packets.has(id) ? parseId(id) : undefined;
    if (!parsed) return [];
    const out: AnswerRound[] = [];
    for (let b = 0; b <= parsed.branch; b++) {
      const member = idOf(parsed.root, b);
      for (const answers of this.rounds.get(member) ?? []) out.push({ id: member, answers });
    }
    return out;
  }

  /** 回答済みの回答。idsを指定した場合は、その依頼の分だけを返す。未回答に戻した依頼の分は含まない。 */
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
      const { root, number, branch } = parseId(id)!;
      if (this.packets.has(id)) throw new Error(`依頼IDが重複している ${id}`);
      if (branch > 0) {
        // 再依頼。系列の最新の依頼を引き継ぐ。枝番は飛ばさない。
        const head = this.heads.get(root);
        if (head === undefined) throw new Error(`存在しない依頼への再依頼 ${id}`);
        if (branch !== head + 1) throw new Error(`枝番が連続していない ${id}（最新は${idOf(root, head)}）`);
        const previous = idOf(root, head);
        this.status.set(previous, "superseded");
        this.successors.set(previous, id);
      }
      this.packets.set(id, event.packet);
      this.status.set(id, "pending");
      this.heads.set(root, branch);
      this.seq = Math.max(this.seq, number);
      return;
    }
    if (event.type === "reopen") {
      const ids = new Set(event.ids);
      if (ids.size !== event.ids.length) throw new Error("未回答に戻す依頼が重複している");
      for (const id of ids) {
        const status = this.status.get(id);
        if (status === undefined) throw new Error(`存在しない依頼を未回答に戻している ${id}`);
        if (!REOPENABLE.has(status)) throw new Error(`${status}の依頼を未回答に戻している ${id}`);
      }
      for (const id of ids) {
        this.answers.delete(id);
        this.status.set(id, "pending");
      }
      this.order = this.order.filter((id) => !ids.has(id));
      return;
    }
    const by = event.type === "chatAnswer" ? { by: "chat" as const } : {};
    const byId = groupById(event.answers.map((a) => ({ ...a, ...by })));
    for (const id of byId.keys()) {
      if (event.type === "chatAnswer") {
        const packet = this.packets.get(id);
        if (packet?.kind === "required") throw new Error(`必須の依頼への会話からの回答 ${id}`);
        if (byId.get(id)!.some((a) => a.verdict !== "ok" && a.verdict !== "hold")) throw new Error(`会話から承認・保留以外を記録している ${id}`);
      }
      const status = this.status.get(id);
      if (status === undefined) throw new Error(`存在しない依頼への回答 ${id}`);
      if (status === "superseded") throw new Error(`再依頼済みの依頼への回答 ${id}`);
      if (status !== "pending") throw new Error(`回答済みの依頼への回答 ${id}`);
    }
    for (const [id, list] of byId) {
      this.answers.set(id, list);
      this.rounds.set(id, [...(this.rounds.get(id) ?? []), list]);
      this.order.push(id);
      this.status.set(id, statusAfter(list));
    }
  }
}

/** 人が同じ依頼票のまま未回答に戻せる状態。 */
const REOPENABLE: ReadonlySet<RequestStatus> = new Set(["held", "answering"]);

function groupById(answers: Answer[]): Map<string, Answer[]> {
  const byId = new Map<string, Answer[]>();
  for (const a of answers) {
    const list = byId.get(a.id) ?? [];
    list.push(a);
    byId.set(a.id, list);
  }
  return byId;
}

const idSchema = z.string().regex(ID_PATTERN);
const lineNumber = z.number().int().min(1);

/**
 * 記録に保存する依頼票の形（ADR-0009）。UIはこの形を前提に表示するので、読み込みで全体を確かめる。
 * ここにない項目は無視する（捨てた方式が残した項目を含む、古い記録を読めるようにするため）。
 */
const packetSchema = z.object({
  id: idSchema,
  // ADR-0008より前の記録にはまとまりがない。その依頼だけのまとまりとして扱う。
  group: idSchema.optional(),
  kind: z.enum(["required", "optional"]),
  triggeredBy: z.array(z.string()),
  viewpoint: z.string(),
  requestedSymbols: z.array(z.string()),
  range: z.string(),
  steps: z.array(z.object({
    order: z.number().int(),
    symbol: z.string().min(1),
    file: z.string(),
    startLine: lineNumber,
    layer: z.string(),
    boundaries: z.array(z.string()),
    change: z.enum(["added", "modified", "unchanged"]),
    code: z.string(),
    changedLines: z.array(lineNumber),
  })),
  edges: z.array(z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    kind: z.enum(["call", "new", "type", "inherit"]),
  })).optional(),
  callers: z.array(z.object({
    symbol: z.string().min(1),
    file: z.string(),
    startLine: lineNumber,
    code: z.string(),
  })).optional(),
  tables: z.array(z.object({
    symbol: z.string().min(1),
    table: z.string().min(1),
    access: z.enum(["read", "write", "schema"]),
    via: z.array(z.string().min(1)).min(1).optional(),
  })).optional(),
  prior: z.object({ id: idSchema, same: z.array(z.string()) }).optional(),
  unresolved: z.array(z.string()),
  evidence: z.array(z.object({
    kind: z.enum(["test", "static"]),
    name: z.string(),
    status: z.enum(["pass", "fail", "missing"]),
  })),
  budget: z.object({ changedLines: z.number().int().min(0), limit: z.number().int().min(0) }),
  fixture: z.boolean(),
}).superRefine((p, ctx) => {
  // 使われる側は依頼票に並べたシンボル、使う側はそれか呼び出し元に限る（ADR-0020、ADR-0021）。
  const symbols = new Set(p.steps.map((s) => s.symbol));
  const callers = new Set(p.callers?.map((c) => c.symbol));
  p.callers?.forEach((c, i) => {
    if (symbols.has(c.symbol)) ctx.addIssue({ code: "custom", path: ["callers", i], message: "並べたシンボルと重なる" });
  });
  p.prior?.same.forEach((s, i) => {
    if (!symbols.has(s)) ctx.addIssue({ code: "custom", path: ["prior", "same", i], message: "依頼票にないシンボル" });
  });
  p.tables?.forEach((t, i) => {
    if (!symbols.has(t.symbol)) ctx.addIssue({ code: "custom", path: ["tables", i], message: "依頼票にないシンボル" });
  });
  p.edges?.forEach((e, i) => {
    if (!(symbols.has(e.from) || callers.has(e.from)) || !symbols.has(e.to)) ctx.addIssue({ code: "custom", path: ["edges", i], message: "依頼票にないシンボル" });
  });
});

const answerSchema = z.object({
  id: z.string(),
  verdict: z.enum(["ok", "fix", "ask", "hold"]),
  ref: z.string().optional(),
  comment: z.string().optional(),
});

/** 形が合わない場所を、エラーに添える。 */
function shape<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const where = r.error.issues[0]?.path.join(".");
  throw new Error(where ? `${what}の形が不正（${where}）` : `${what}の形が不正`);
}

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
  const head = { v: LOG_VERSION, at: e.at } as const;
  if (e.type === "request") {
    const p = shape(packetSchema, e.packet, "依頼票");
    return { ...head, type: "request", packet: { ...p, group: p.group ?? p.id } };
  }
  if (e.type === "answer" || e.type === "chatAnswer") {
    return { ...head, type: e.type, answers: shape(z.array(answerSchema).min(1), e.answers, "回答") as Answer[] };
  }
  if (e.type === "reopen") {
    return { ...head, type: "reopen", ids: shape(z.array(idSchema).min(1), e.ids, "未回答に戻す依頼") };
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

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** 依頼票の、そのシンボルのコード。なければ空（消したファイル、ADR-0022）。 */
export function codeOf(packet: ReviewPacket, symbol: string): string {
  return packet.steps.find((s) => s.symbol === symbol)?.code ?? "";
}
