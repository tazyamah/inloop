import type { Answer, Verdict } from "./types.js";

export const VERDICTS: readonly Verdict[] = ["ok", "fix", "ask", "hold"];

/** 回答を、AIに返す1行1件の形式にする。例: R13 fix src/a.ts#login "401で返す" */
export function formatAnswerLine(a: Answer): string {
  const parts: string[] = [a.id, a.verdict];
  if (a.ref) parts.push(a.ref);
  if (a.comment) parts.push(JSON.stringify(a.comment));
  return parts.join(" ");
}

/** 回答のメッセージの先頭の1行。AIに次の行動を示す。 */
export const ANSWER_HEADER = "[inloop] レビュー回答。fixは修正後にrequest_reviewのfollowsで再依頼、askは会話で答える:";

/** 会話へ送るメッセージ。 */
export function formatAnswerMessage(answers: Answer[]): string {
  return [ANSWER_HEADER, ...answers.map(formatAnswerLine)].join("\n");
}

/** AIの文脈へ入る文字列の大きさを記録する（stderrはクライアントのログへ出る）。 */
export function logModelBound(kind: string, text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  process.stderr.write(`[inloop] model-bound kind=${kind} chars=${text.length} bytes=${bytes}\n`);
}
