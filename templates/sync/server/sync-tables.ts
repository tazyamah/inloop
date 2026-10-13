// 同期する表の一覧。表を足したら、ここにも足す（`inloop generate scaffold`は、足す場所の目印を使う）。
// 表には、uid（文字列の主キー）、created_at、updated_at（ミリ秒）、deleted、dirty の列が要る。
import type { SyncTable } from "./sync/engine.ts";

export const syncTables: SyncTable[] = [
  { name: "notes", columns: { body: { type: "text", max: 1000 } } },
  // inloop:sync-tables
];
