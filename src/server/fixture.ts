import type { ReviewPacket, ReviewStep } from "./types.js";

/**
 * 解析エンジンが未実装のため、合成した固定の依頼票を返す。
 * 架空の「注文キャンセルAPIの追加」を題材にしている。
 */
const STEPS: ReviewStep[] = [
  {
    order: 1,
    symbol: "src/domain/order.ts#OrderStatus",
    file: "src/domain/order.ts",
    startLine: 3,
    layer: "型定義",
    boundaries: [],
    change: "modified",
    code: [
      "export type OrderStatus =",
      "  | \"pending\"",
      "  | \"shipped\"",
      "  | \"cancelled\";",
    ].join("\n"),
    changedLines: [4],
  },
  {
    order: 2,
    symbol: "src/db/orders.ts#cancelOrder",
    file: "src/db/orders.ts",
    startLine: 41,
    layer: "DB",
    boundaries: ["boundary.db-write"],
    change: "added",
    code: [
      "export async function cancelOrder(db: Db, orderId: string, userId: string) {",
      "  const result = await db.query(",
      "    \"UPDATE orders SET status = 'cancelled' \" +",
      "      \"WHERE id = $1 AND user_id = $2 AND status = 'pending'\",",
      "    [orderId, userId],",
      "  );",
      "  return result.rowCount === 1;",
      "}",
    ].join("\n"),
    changedLines: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    order: 3,
    symbol: "src/api/orders.ts#postCancel",
    file: "src/api/orders.ts",
    startLine: 88,
    layer: "HTTP入口",
    boundaries: ["boundary.external-input", "boundary.auth"],
    change: "added",
    code: [
      "app.post(\"/orders/:id/cancel\", requireUser, async (c) => {",
      "  const ok = await cancelOrder(c.get(\"db\"), c.req.param(\"id\"), c.get(\"user\").id);",
      "  if (!ok) return c.json({ error: \"not_cancellable\" }, 409);",
      "  events.emit(\"order.cancelled\", c.req.param(\"id\"));",
      "  return c.body(null, 204);",
      "});",
    ].join("\n"),
    changedLines: [1, 2, 3, 4, 5, 6],
  },
];

export function buildFixturePacket(
  id: string,
  viewpoint: string,
  requestedSymbols: string[],
  range: string,
): ReviewPacket {
  return {
    id,
    kind: "required",
    triggeredBy: ["boundary.db-write", "boundary.auth"],
    viewpoint,
    requestedSymbols,
    range,
    steps: STEPS.map((s) => ({ ...s, boundaries: [...s.boundaries], changedLines: [...s.changedLines] })),
    unresolved: [
      "src/api/orders.ts:91 events.emit(\"order.cancelled\") の購読先（動的dispatchのため解決できない）",
    ],
    evidence: [
      { kind: "test", name: "pendingの注文を本人がキャンセルできる", status: "pass" },
      { kind: "test", name: "他人の注文はキャンセルできない", status: "pass" },
      { kind: "test", name: "発送済みの注文はキャンセルできない", status: "missing" },
      { kind: "static", name: "semgrep: no-raw-sql-concat", status: "pass" },
    ],
    budget: { changedLines: 15, limit: 40 },
    fixture: true,
  };
}
