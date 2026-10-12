// 必須の依頼がすべて承認されているかを確かめる（ADR-0001、ADR-0022）。マージの前に、人やCIが動かす。記録は書かない。
import { evaluate, loadConfig } from "../engine/boundaries.js";
import { baseOf, checkBase } from "../engine/diff.js";
import { TsProject } from "../engine/project.js";
import { codeOf, type ReviewStore } from "./store.js";
import type { RequestStatus } from "./types.js";

export interface CheckLine {
  /** ルールに当たった単位のシンボルID */
  symbol: string;
  rules: string[];
  /**
   * ok: 必須の系列の最新の依頼が承認済みで、そのコードが今と同じ。
   * missing: 必須の依頼がない。changed: 依頼のコードと今のコードが違う（承認後の変更を含む）。
   * それ以外は、承認されていない依頼の状態。
   */
  state: "ok" | "missing" | "changed" | Exclude<RequestStatus, "approved" | "superseded">;
  /** 必須の系列の最新の依頼のID */
  id?: string;
}

export function checkRequired(repo: string, range: string, store: ReviewStore): CheckLine[] {
  const base = baseOf(range);
  checkBase(repo, base);
  const project = new TsProject(repo);
  try {
    const config = loadConfig(repo, base);
    return evaluate(project, repo, base, config.rules, config.layerSets).map((h): CheckLine => {
      const head = store.requiredHead(h.symbol);
      if (!head) return { symbol: h.symbol, rules: h.rules, state: "missing" };
      if (codeOf(head, h.symbol) !== h.code) return { symbol: h.symbol, rules: h.rules, state: "changed", id: head.id };
      const status = store.statusOf(head.id)!;
      return { symbol: h.symbol, rules: h.rules, state: status === "approved" || status === "superseded" ? "ok" : status, id: head.id };
    });
  } finally {
    project.close();
  }
}
