/** 依頼票と回答。docs/review-protocol.md、ADR-0009と対応する。 */
export type ReviewKind = "required" | "optional";
export type Verdict = "ok" | "fix" | "ask" | "hold";
/**
 * 依頼の状態。記録には保存せず、記録を先頭から適用して決める（ADR-0007）。
 * supersededは、再依頼によって枝番の依頼に引き継がれ、もう回答できない状態。
 */
export type RequestStatus = "pending" | "approved" | "fixing" | "answering" | "held" | "superseded";

export interface ReviewStep {
  /** 理解順の並び（定義が使用より先） */
  order: number;
  /** シンボルID。`リポジトリからのパス#名前`、クラスのメンバーは`.`でつなぐ（ADR-0015） */
  symbol: string;
  file: string;
  startLine: number;
  /** レイヤー対応ルールで決まる論理レイヤー */
  layer: string;
  /** 信頼境界ルールに該当した場合のルールID */
  boundaries: string[];
  /** 範囲の基点から、追加・変更されたか。依存として並べた変わっていないシンボルはunchanged（ADR-0015）。 */
  change: "added" | "modified" | "unchanged";
  code: string;
  /** code内で変更された行（1始まり、code内の相対位置） */
  changedLines: number[];
}

/**
 * 依頼票に並べたシンボルどうしの「使う」関係（ADR-0020）。fromがtoを使う。
 * 解析エンジンがコードから決める。toは必ずstepsのシンボル、fromはstepsか呼び出し元（callers）のシンボル。
 */
export interface ReviewEdge {
  from: string;
  to: string;
  /** 呼び出し、new（コンストラクター）、型としての参照、継承・実装 */
  kind: "call" | "new" | "type" | "inherit";
}

/**
 * 依頼票に並べたシンボルを使っている、リポジトリの別のシンボル（呼び出し元、ADR-0021）。1段だけ。
 * stepsには入れない（理解順の対象ではなく、影響範囲として見せる）。使う関係はedgesにfromとして入る。
 */
export interface ReviewCaller {
  symbol: string;
  file: string;
  startLine: number;
  code: string;
}

export interface Evidence {
  kind: "test" | "static";
  name: string;
  status: "pass" | "fail" | "missing";
}

export interface ReviewPacket {
  /**
   * 依頼ID。新しい依頼は`R13`、その再依頼は`R13-1`、`R13-2`と枝番を付ける（ADR-0009）。
   * 1つのIDは、1回の呼び出しで人に見せた1つの依頼票を指し、中身は変わらない。
   */
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
  /**
   * stepsのシンボルどうしの使う関係（ADR-0020）。画面の依存の図はこれだけから描く。
   * この項目がない依頼票（ADR-0020より前の記録）は、関係を記録していないので図を出さない。
   */
  edges?: ReviewEdge[];
  /**
   * 呼び出し元（ADR-0021）。AIが指定したシンボルと変わったシンボルを使っている、stepsにないシンボル。
   * この項目がない依頼票（ADR-0021より前の記録）は、呼び出し元を調べていない。
   */
  callers?: ReviewCaller[];
  /** 解析で解決できなかった参照 */
  unresolved: string[];
  evidence: Evidence[];
  budget: { changedLines: number; limit: number };
  /** 固定データ（解析エンジンを使わない記録先）ならtrue。解析エンジンが作った依頼票はfalse（ADR-0015） */
  fixture: boolean;
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
  /** 会話での人の指示を受けて、AIが記録した承認・保留（ADR-0017）。人が画面で回答したものにはない。 */
  by?: "chat";
}

/** 1回の送信で、1つの依頼に付いた回答。 */
export interface AnswerRound {
  id: string;
  answers: Answer[];
}

export interface InboxItem {
  id: string;
  kind: ReviewKind;
  viewpoint: string;
  status: RequestStatus;
  /** 依頼票に含まれるシンボル。行コメントの宛先候補を決めるのに使う */
  symbols: string[];
  /** 再依頼済みの場合、引き継いだ依頼のID */
  supersededBy?: string;
  /** 今の回答を、会話での指示を受けてAIが記録した場合（ADR-0017） */
  by?: "chat";
}
