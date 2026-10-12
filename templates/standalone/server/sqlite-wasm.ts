// ブラウザ向けのビルドで、node:sqlite の代わりに使う。DatabaseSync の使い方（exec、prepare の
// all・get・run）のうち、アプリが使う分だけを、sqlite-wasm（OPFSに保存）で実装している。
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const sqlite3 = await sqlite3InitModule();
// OPFSの保存領域は、同時に1つのWorkerしか開けない。別のタブで開いていると失敗する。
let pool: Awaited<ReturnType<typeof sqlite3.installOpfsSAHPoolVfs>> | undefined;
let poolError = "";
try {
  pool = await sqlite3.installOpfsSAHPoolVfs({ name: "inloop-app" });
} catch (e) {
  poolError = e instanceof Error ? e.message : String(e);
}

type Param = string | number | bigint | null | Uint8Array;

export class DatabaseSync {
  readonly #db;

  constructor(path: string) {
    if (path === ":memory:") {
      this.#db = new sqlite3.oo1.DB(":memory:");
    } else {
      // データが消えるメモリ上のDBに黙って切り替えない。
      if (!pool) throw new Error(`この端末では、データを保存できない（${poolError}）。別のタブで開いていないか確かめてください`);
      this.#db = new pool.OpfsSAHPoolDb(path);
    }
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string) {
    const db = this.#db;
    const rows = (params: Param[]) =>
      db.exec({ sql, bind: params.length > 0 ? params : undefined, rowMode: "object", returnValue: "resultRows" }) as Record<string, unknown>[];
    return {
      all: (...params: Param[]) => rows(params),
      get: (...params: Param[]) => rows(params)[0],
      run: (...params: Param[]) => {
        db.exec({ sql, bind: params.length > 0 ? params : undefined });
        return { changes: db.changes(), lastInsertRowid: sqlite3.capi.sqlite3_last_insert_rowid(db) };
      },
    };
  }
}
