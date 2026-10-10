import { buildFixturePacket } from "./fixture.js";
import type { Answer, InboxItem, RequestStatus, ReviewPacket } from "./types.js";

/** 依頼と回答をプロセス内に保持する。永続化は未実装。 */
export class ReviewStore {
  private seq = 0;
  private readonly packets = new Map<string, ReviewPacket>();
  private readonly status = new Map<string, RequestStatus>();
  private readonly answers = new Map<string, Answer[]>();
  private readonly order: string[] = [];

  create(viewpoint: string, symbols: string[], range: string): ReviewPacket {
    const id = `R${++this.seq}`;
    const packet = buildFixturePacket(id, viewpoint, symbols, range);
    this.packets.set(id, packet);
    this.status.set(id, "pending");
    return packet;
  }

  get(id: string): ReviewPacket | undefined {
    return this.packets.get(id);
  }

  statusOf(id: string): RequestStatus | undefined {
    return this.status.get(id);
  }

  inbox(): InboxItem[] {
    return [...this.packets.values()].map((p) => ({
      id: p.id,
      kind: p.kind,
      viewpoint: p.viewpoint,
      status: this.status.get(p.id) ?? "pending",
      symbols: p.steps.map((s) => s.symbol),
    }));
  }

  /** 回答を検証して記録する。不正な行が1つでもあれば何も記録しない。 */
  submit(answers: Answer[]): Answer[] {
    const errors: string[] = [];
    const byId = new Map<string, Answer[]>();
    for (const a of answers) {
      const list = byId.get(a.id) ?? [];
      list.push(a);
      byId.set(a.id, list);
    }
    for (const [id, list] of byId) {
      const packet = this.packets.get(id);
      if (!packet) { errors.push(`${id}: 存在しない依頼`); continue; }
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

    const recorded: Answer[] = [];
    for (const [id, list] of byId) {
      const clean = list.map((a) => {
        const c: Answer = { id: a.id, verdict: a.verdict };
        if (a.ref) c.ref = a.ref;
        if (a.comment?.trim()) c.comment = a.comment.trim();
        return c;
      });
      this.answers.set(id, clean);
      this.order.push(id);
      this.status.set(id, statusAfter(clean));
      recorded.push(...clean);
    }
    return recorded;
  }

  answered(ids?: string[]): Answer[] {
    const targets = ids && ids.length > 0 ? this.order.filter((id) => ids.includes(id)) : this.order;
    return targets.flatMap((id) => this.answers.get(id) ?? []);
  }
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
