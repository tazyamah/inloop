// 回答を待つ（ADR-0012、ADR-0016）。get_review_resultのwaitと、inloop waitが同じものを使う。
import { formatAnswerLine } from "./format.js";
import type { ReviewStore } from "./store.js";

const POLL_MS = 300;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * 指定した依頼の回答を返す。秒数を渡すと、すべて回答されるまで待つ。
 * 待ち始めに未回答の依頼がなく、保留・回答待ちの依頼があれば、人が未回答に戻して答え直すまで待ち、
 * 新しい回答がなければ`no change`を返す。時間切れのとき、未回答の依頼は`R2 pending`として示す。
 * 秒数を渡さなければ待たず、回答がなければ`none`を返す。
 */
export async function answersOf(store: ReviewStore, ids: string[], wait?: number, signal?: AbortSignal): Promise<string> {
  const pending = () => ids.filter((id) => store.statusOf(id) === "pending");
  if (wait) {
    const until = Date.now() + wait * 1000;
    const reopenable = (id: string) => store.statusOf(id) === "held" || store.statusOf(id) === "answering";
    const rounds = () => ids.reduce((n, id) => n + store.history(id).length, 0);
    const before = rounds();
    const awaitingNew = pending().length === 0 && ids.some(reopenable);
    const done = () => pending().length === 0 && (!awaitingNew || rounds() > before);
    while (!done() && Date.now() < until && !signal?.aborted) await sleep(POLL_MS, signal);
    if (awaitingNew && rounds() === before) return "no change";
  }
  const lines = store.answered(ids).map(formatAnswerLine);
  // 待った場合は、まだ回答のない依頼も示す。待ち直すかどうかをAIが決められるように。
  if (wait) lines.push(...pending().map((id) => `${id} pending`));
  return lines.length > 0 ? lines.join("\n") : "none";
}
