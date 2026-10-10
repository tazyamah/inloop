/** 依頼票（草案）。docs/review-protocol.md と対応する。 */
export type ReviewKind = "required" | "optional";
export type Verdict = "ok" | "fix" | "ask" | "hold";
export type RequestStatus = "pending" | "approved" | "fixing" | "answering" | "held";

export interface ReviewStep {
  /** 理解順の並び（定義が使用より先） */
  order: number;
  /** シンボルID（file#name 形式の仮表記） */
  symbol: string;
  file: string;
  startLine: number;
  /** レイヤー対応ルールで決まる論理レイヤー */
  layer: string;
  /** 信頼境界ルールに該当した場合のルールID */
  boundaries: string[];
  change: "added" | "modified";
  code: string;
  /** code内で変更された行（1始まり、code内の相対位置） */
  changedLines: number[];
}

export interface Evidence {
  kind: "test" | "static";
  name: string;
  status: "pass" | "fail" | "missing";
}

export interface ReviewPacket {
  id: string;
  /**
   * 依頼が属するまとまり（ADR-0008）。1回のrequest_reviewで作った依頼が同じ値を持ち、
   * 値はその呼び出しで最初に作った依頼のID。UIは、自分の依頼と同じまとまりの依頼だけを
   * 受付箱に出し、回答できる。AIには返さない。
   */
  group: string;
  kind: ReviewKind;
  /** required の場合、依頼を生んだ信頼境界ルール */
  triggeredBy: string[];
  /** AIが書いた問い */
  viewpoint: string;
  /** AIが指定した対象（現在の固定データでは表示のみ） */
  requestedSymbols: string[];
  range: string;
  steps: ReviewStep[];
  /** 解析で解決できなかった参照 */
  unresolved: string[];
  evidence: Evidence[];
  budget: { changedLines: number; limit: number };
  /** 解析エンジン未実装のため固定データであることを示す */
  fixture: true;
}

/**
 * 回答の1行。1つの依頼に対し、ok/holdは単独の1行、fix/askは行ごとに複数行を持てる。
 * ref はシンボルID、またはシンボルIDに行（#L44）か行範囲（#L44-L46）を付けたもの。
 */
export interface Answer {
  id: string;
  verdict: Verdict;
  ref?: string;
  comment?: string;
}

export interface InboxItem {
  id: string;
  kind: ReviewKind;
  viewpoint: string;
  status: RequestStatus;
  /** 依頼票に含まれるシンボル。行コメントの宛先候補を決めるのに使う */
  symbols: string[];
}
