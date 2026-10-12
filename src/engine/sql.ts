// SQL文字列から、読む・書くテーブルを取り出す（ADR-0026）。構文を完全には解析せず、
// 文を字句に分けて、FROM・JOIN・INTO・UPDATE・CREATE TABLEなどの直後の名前を拾う。読み取れない形は拾わない。
export type TableAccess = "read" | "write" | "schema";
export interface TableUse { table: string; access: TableAccess }

/** SQLらしい文字列か。普通の文字列（正規表現の`exec`の引数など）をSQLとみなさないための入口。 */
export const looksLikeSql = (s: string): boolean => /^\s*(?:--[^\n]*\n\s*)*(?:select|insert|update|delete|replace|create|drop|alter|pragma|with|begin|commit|rollback|vacuum)\b/i.test(s);

/** コメントと文字列リテラルを空にしたうえで、語に分ける。引用符つきの名前（"t"、`t`、[t]）は中身を1語にする。 */
function tokens(sql: string): string[] {
  const out: string[] = [];
  const re = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"((?:[^"]|"")*)"|`([^`]*)`|\[([^\]]*)\]|[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?|[(),;]|\S/g;
  for (const m of sql.matchAll(re)) {
    const t = m[0];
    if (t.startsWith("--") || t.startsWith("/*") || t.startsWith("'")) { out.push("''"); continue; }
    const quoted = m[1] ?? m[2] ?? m[3];
    out.push(quoted !== undefined ? `\u0000${quoted}` : t);
  }
  return out;
}

const ident = (t: string | undefined): string | undefined => {
  if (t === undefined) return undefined;
  if (t.startsWith("\u0000")) return t.slice(1);
  return /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?$/.test(t) ? t : undefined;
};
const isWord = (t: string | undefined, ...w: string[]) => t !== undefined && !t.startsWith("\u0000") && w.includes(t.toLowerCase());
/** 名前の位置に置けない語（FROMの後ろの副問い合わせ以外の語など）。 */
const RESERVED = new Set(["select", "values", "with", "where", "set", "default", "from", "join", "on", "group", "order", "limit", "returning"]);

/**
 * 読む・書くテーブル。CTE（WITH x AS）で作った名前は除く。
 * 順序は出てきた順で、同じ（テーブル, 種類）は1回にする。
 */
export function tablesOf(sql: string): TableUse[] {
  const t = tokens(sql);
  const cte = new Set<string>();
  const out = new Map<string, TableUse>();
  const add = (name: string | undefined, access: TableAccess) => {
    if (name === undefined || (!name.includes(".") && RESERVED.has(name.toLowerCase()))) return;
    out.set(`${name}\n${access}`, { table: name, access });
  };
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!.toLowerCase();
    if (t[i]!.startsWith("\u0000")) continue;
    const next = t[i + 1];
    if (w === "with") {
      // WITH [RECURSIVE] a AS (...), b AS (...)
      let j = isWord(next, "recursive") ? i + 2 : i + 1;
      for (;;) {
        const name = ident(t[j]);
        if (name === undefined) break;
        cte.add(name.toLowerCase());
        let k = j + 1;
        if (t[k] === "(") { k = t.indexOf(")", k) + 1; if (k === 0) break; } // 列名
        if (!isWord(t[k], "as")) break;
        k++;
        if (isWord(t[k], "not")) k++;
        if (isWord(t[k], "materialized")) k++;
        if (t[k] !== "(") break;
        let depth = 0;
        for (; k < t.length; k++) { if (t[k] === "(") depth++; else if (t[k] === ")" && --depth === 0) break; }
        if (t[k + 1] !== ",") break;
        j = k + 2;
      }
    } else if ((w === "from" && !isWord(t[i - 1], "delete")) || w === "join") {
      // FROM a, b JOIN c: FROMの後のカンマ区切りも読む。副問い合わせ（括弧）は中を別に読むので飛ばす。
      add(ident(next), "read");
      if (w === "from") {
        let j = i + 2;
        for (; j < t.length; j++) {
          if (t[j] === "(") { let d = 0; for (; j < t.length; j++) { if (t[j] === "(") d++; else if (t[j] === ")" && --d === 0) break; } continue; }
          if (t[j] === ",") { add(ident(t[j + 1]), "read"); continue; }
          if (isWord(t[j], "where", "group", "order", "limit", "having", "union", "except", "intersect", "window", "join", "left", "right", "inner", "outer", "cross", "natural", "full") || t[j] === ";" || t[j] === ")") break;
        }
      }
    } else if (w === "into") {
      add(ident(next), "write");
    } else if (w === "update") {
      // UPDATE [OR ROLLBACK|ABORT|REPLACE|FAIL|IGNORE] t。ON CONFLICT ... DO UPDATE SET のupdateは名前を取らない。
      let j = i + 1;
      if (isWord(t[j], "or")) j += 2;
      if (!isWord(t[i - 1], "do")) add(ident(t[j]), "write");
    } else if (w === "delete" && isWord(next, "from")) {
      add(ident(t[i + 2]), "write");
    } else if ((w === "create" || w === "drop" || w === "alter") && i + 1 < t.length) {
      let j = i + 1;
      while (isWord(t[j], "temp", "temporary", "virtual", "unique")) j++;
      if (isWord(t[j], "table", "index", "view", "trigger")) {
        j++;
        if (isWord(t[j], "if")) j += isWord(t[j + 1], "not") ? 3 : 2;
        add(ident(t[j]), "schema");
      }
    }
  }
  return [...out.values()].filter((u) => u.access === "schema" || !cte.has(u.table.toLowerCase()));
}
