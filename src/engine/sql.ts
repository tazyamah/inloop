// SQL文字列から、読む・書くテーブルを取り出す（ADR-0026）。構文を完全には解析せず、
// 文を字句に分けて、FROM・JOIN・INTO・UPDATE・CREATE TABLEなどの直後の名前を拾う。読み取れない形は拾わない。
/** SQLを探して、並べていない宣言を呼び出しでたどる段数（ADR-0030）。 */
export const INDIRECT_DEPTH = 2;
export type TableAccess = "read" | "write" | "schema";
/** `columns`は読み取れた列。`*`は全列、または列を決められないこと。スキーマと、列が読み取れなかったものには付けない（ADR-0031）。 */
export interface TableUse { table: string; access: TableAccess; columns?: string[] }

/** SQLらしい文字列か。普通の文字列（正規表現の`exec`の引数など）をSQLとみなさないための入口。 */
export const looksLikeSql = (s: string): boolean => /^\s*(?:--[^\n]*\n\s*)*(?:select|insert|update|delete|replace|create|drop|alter|pragma|with|begin|commit|rollback|vacuum|truncate|copy)\b/i.test(s);

/** コメントと文字列リテラルを空にしたうえで、語に分ける。引用符つきの名前（"t"、`t`、[t]）は中身を1語にする。 */
function tokens(sql: string): string[] {
  const out: string[] = [];
  // `E'..'`（バックスラッシュのエスケープ）と`$tag$..$tag$`（ドル引用）はPostgreSQLの文字列。`[t]`は、名前らしい中身のときだけ引用符つきの名前にする（`int[]`・`a[1]`を除く）。
  const re = /--[^\n]*|\/\*[\s\S]*?\*\/|[eE]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|(\$(?:[A-Za-z_]\w*)?\$)[\s\S]*?\1|"((?:[^"]|"")*)"|`([^`]*)`|\[([A-Za-z_][^\]]*)\]|[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?|[(),;]|\S/g;
  for (const m of sql.matchAll(re)) {
    const t = m[0];
    if (t.startsWith("--") || t.startsWith("/*") || t.startsWith("'") || m[1] !== undefined || /^[eE]'/.test(t)) { out.push("''"); continue; }
    const quoted = m[2] ?? m[3] ?? m[4];
    out.push(quoted !== undefined ? `\u0000${quoted}` : t);
  }
  return qualify(out);
}

/** `"public"."notes"`・`public."notes"`のように引用符が混ざった修飾名を、`public.notes`の1語にする（名前が単純なときだけ）。 */
function qualify(t: string[]): string[] {
  const part = (x: string | undefined) => (x === undefined ? undefined : x.startsWith("\u0000") ? x.slice(1) : /^[A-Za-z_][\w$]*$/.test(x) ? x : undefined);
  const simple = /^[A-Za-z_][\w$]*$/;
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const a = part(t[i]), b = part(t[i + 2]);
    if (a !== undefined && b !== undefined && t[i + 1] === "." && simple.test(a) && simple.test(b) && (t[i]!.startsWith("\u0000") || t[i + 2]!.startsWith("\u0000"))) {
      out.push(`${a}.${b}`);
      i += 2;
    } else out.push(t[i]!);
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

/** 列の位置に置けない語（演算子の語、節の語、定数など）。引用符つきの名前は対象外。 */
const KEYWORDS = new Set([
  ...RESERVED, "and", "or", "not", "in", "is", "isnull", "notnull", "null", "true", "false", "like", "glob", "regexp", "match", "escape", "between", "case", "when", "then", "else", "end",
  "distinct", "all", "asc", "desc", "by", "as", "using", "exists", "offset", "collate", "cast", "nulls", "first", "last", "having", "union", "except", "intersect", "window", "over", "partition",
  "left", "right", "inner", "outer", "cross", "natural", "full", "current_timestamp", "current_date", "current_time", "into", "insert", "update", "delete", "replace", "conflict", "do", "nothing",
  "rollback", "abort", "fail", "ignore", "indexed", "filter", "rows", "range", "unbounded", "preceding", "following", "current", "row", "recursive", "materialized", "no", "to", "add", "column",
]);

type Keep = (name: string, access: TableAccess, cols: string[], cte: Set<string>) => void;

/**
 * 読む・書くテーブルと、読み取れた列（ADR-0026、ADR-0031）。CTE（WITH x AS）で作った名前は除く。
 * 順序は出てきた順で、同じ（テーブル, 種類）は1回にして、列は合わせる。`;`で文に分けて読む。
 */
export function tablesOf(sql: string): TableUse[] {
  const all = tokens(sql);
  const out = new Map<string, { use: TableUse; cols: Map<string, string> }>();
  const keep: Keep = (name, access, cols, cte) => {
    if (access !== "schema" && cte.has(name.toLowerCase())) return;
    const key = `${name}\n${access}`;
    let e = out.get(key);
    if (!e) out.set(key, e = { use: { table: name, access }, cols: new Map() });
    for (const c of cols) e.cols.set(c.toLowerCase(), c);
  };
  let from = 0;
  for (let i = 0; i <= all.length; i++) {
    if (i < all.length && all[i] !== ";") continue;
    if (i > from) statementTables(all.slice(from, i), keep);
    from = i + 1;
  }
  return [...out.values()].map((e) => {
    const cols = [...e.cols.values()];
    if (e.use.access === "schema" || cols.length === 0) return e.use;
    return { ...e.use, columns: [...cols.filter((c) => c === "*"), ...cols.filter((c) => c !== "*").sort()] };
  });
}

function statementTables(t: string[], keep: Keep): void {
  const cte = new Set<string>();
  const uses: { name: string; access: TableAccess; cols: string[] }[] = [];
  const named = new Set<number>(); // 名前・別名・書く列として読んだ位置。読む列の候補から外す。
  const alias = new Map<string, string>(); // 別名（小文字）→テーブル
  let insertTarget: { cols: string[] } | undefined;
  let hasUpdate = false;
  const copyStmt = isWord(t[0], "copy") && t[1] !== "(";
  const add = (idx: number, access: TableAccess): { name: string; cols: string[] } | undefined => {
    if (isWord(t[idx], "only") && ident(t[idx + 1]) !== undefined) idx++; // FROM ONLY t（PostgreSQL）
    const raw = ident(t[idx]);
    const name = raw !== undefined && /^public\./i.test(raw) ? raw.slice("public.".length) : raw; // 既定のスキーマは付けても付けなくても同じテーブル
    if (name === undefined || (!name.includes(".") && RESERVED.has(name.toLowerCase()))) return undefined;
    named.add(idx);
    const u = { name, access, cols: [] as string[] };
    uses.push(u);
    // 別名: テーブル名 [AS] 別名
    let a = idx + 1;
    if (isWord(t[a], "as")) a++;
    const al = ident(t[a]);
    if (access !== "schema" && al !== undefined && !al.includes(".") && (t[a]!.startsWith("\u0000") || !KEYWORDS.has(al.toLowerCase()))) {
      alias.set(al.toLowerCase(), name);
      named.add(a);
    }
    return u;
  };
  /** SET a = ..., b = ... の左辺の列を、位置jから集める。 */
  const setColumns = (start: number, into: string[]) => {
    let depth = 0;
    let expectCol = true;
    for (let j = start; j < t.length; j++) {
      const w = t[j]!;
      if (w === "(") { if (expectCol && depth === 0) { into.push("*"); expectCol = false; } depth++; continue; }
      if (w === ")") { if (--depth < 0) break; continue; }
      if (depth > 0) continue;
      if (isWord(w, "where", "from", "returning", "order", "limit")) break;
      if (w === ",") { expectCol = true; continue; }
      if (expectCol) {
        const c = ident(w);
        if (c !== undefined && t[j + 1] === "=") { into.push(c.includes(".") ? c.slice(c.indexOf(".") + 1) : c); named.add(j); }
        else into.push("*");
        expectCol = false;
      }
    }
  };
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!.toLowerCase();
    if (t[i]!.startsWith("\u0000")) continue;
    const next = t[i + 1];
    if (w === "with" && isWord(next, "time", "ordinality") ) continue; // timestamp with time zone
    if (w === "with") {
      // WITH [RECURSIVE] a AS (...), b AS (...)
      let j = isWord(next, "recursive") ? i + 2 : i + 1;
      for (;;) {
        const name = ident(t[j]);
        if (name === undefined) break;
        cte.add(name.toLowerCase());
        named.add(j);
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
    } else if ((w === "from" && !isWord(t[i - 1], "delete") && !copyStmt) || w === "join") {
      // FROM a, b JOIN c: FROMの後のカンマ区切りも読む。副問い合わせ（括弧）は中を別に読むので飛ばす。
      add(i + 1, "read");
      if (w === "from") {
        for (let j = i + 2; j < t.length; j++) {
          if (t[j] === "(") { let d = 0; for (; j < t.length; j++) { if (t[j] === "(") d++; else if (t[j] === ")" && --d === 0) break; } continue; }
          if (t[j] === ",") { add(j + 1, "read"); continue; }
          if (isWord(t[j], "where", "group", "order", "limit", "having", "union", "except", "intersect", "window", "join", "left", "right", "inner", "outer", "cross", "natural", "full") || t[j] === ";" || t[j] === ")") break;
        }
      }
    } else if (w === "into") {
      const u = add(i + 1, "write");
      if (u) {
        if (t[i + 2] === "(") {
          for (let j = i + 3; j < t.length && t[j] !== ")"; j++) { const c = ident(t[j]); if (c !== undefined) { u.cols.push(c); named.add(j); } }
        } else u.cols.push("*");
        insertTarget = u;
      }
    } else if (w === "update") {
      // UPDATE [OR ROLLBACK|ABORT|REPLACE|FAIL|IGNORE] t SET ... 。ON CONFLICT ... DO UPDATE SET のupdateは名前を取らず、挿入先の列を足す。
      if (isWord(t[i - 1], "do")) {
        if (insertTarget && isWord(next, "set")) setColumns(i + 2, insertTarget.cols);
      } else {
        hasUpdate = true;
        let j = i + 1;
        if (isWord(t[j], "or")) j += 2;
        const u = add(j, "write");
        if (u) {
          let k = j + 1;
          while (k < t.length && !isWord(t[k], "set")) k++;
          setColumns(k + 1, u.cols);
        }
      }
    } else if (w === "copy" && i === 0 && t[1] !== "(") {
      // COPY t [(列)] FROM ... は書く、TO ... は読む。COPY (SELECT ...) TO ... は中の文を読む。
      const dir = t.slice(2).findIndex((x) => isWord(x, "from", "to"));
      const writes = dir >= 0 && isWord(t[2 + dir], "from");
      const u = add(1, writes ? "write" : "read");
      if (u) {
        if (t[2] === "(") for (let j = 3; j < t.length && t[j] !== ")"; j++) { const c = ident(t[j]); if (c !== undefined) { u.cols.push(c); named.add(j); } }
        else u.cols.push("*");
      }
    } else if (w === "truncate" && i === 0) {
      // TRUNCATE [TABLE] [ONLY] a, b
      let j = isWord(next, "table") ? 2 : 1;
      for (;;) {
        const u = add(j, "write");
        if (!u) break;
        u.cols.push("*");
        j += isWord(t[j], "only") ? 2 : 1;
        j += isWord(t[j], "*") ? 1 : 0;
        if (t[j] !== ",") break;
        j++;
      }
    } else if (w === "delete" && isWord(next, "from")) {
      const u = add(i + 2, "write");
      if (u) u.cols.push("*");
    } else if ((w === "create" || w === "drop" || w === "alter") && i + 1 < t.length) {
      let j = i + 1;
      if (isWord(t[j], "or") && isWord(t[j + 1], "replace")) j += 2;
      while (isWord(t[j], "temp", "temporary", "virtual", "unique", "unlogged", "materialized", "recursive", "global", "local")) j++;
      if (isWord(t[j], "table", "index", "view", "trigger")) {
        j++;
        if (isWord(t[j], "concurrently")) j++;
        if (isWord(t[j], "if")) j += isWord(t[j + 1], "not") ? 3 : 2;
        if (isWord(t[j], "only")) j++;
        add(j, "schema");
      }
    }
  }
  // 読む列。`x.col`と`x.*`は、別名かテーブル名で結び付く先が決まる。付いていない列は、読むテーブルが1つだけ（CTEとUPDATEがない）ならそのテーブルの列、
  // 決められないときは読むテーブルすべての`*`にする。
  const reads = uses.filter((u) => u.access === "read" && !cte.has(u.name.toLowerCase()));
  if (reads.length > 0) {
    const byName = new Map(reads.map((u) => [u.name.toLowerCase(), u] as const));
    const target = (q: string) => byName.get((alias.get(q.toLowerCase()) ?? q).toLowerCase());
    const single = reads.length === 1 && cte.size === 0 && !hasUpdate ? reads[0] : undefined;
    for (let i = 0; i < t.length; i++) {
      const w = t[i]!;
      if (named.has(i)) continue;
      if (w === "*") {
        if (t[i - 1] === "." && ident(t[i - 2]) !== undefined) target(ident(t[i - 2])!)?.cols.push("*");
        else if (i === 0 || isWord(t[i - 1], "select", "distinct", "all") || t[i - 1] === ",") for (const u of reads) u.cols.push("*");
        continue;
      }
      const name = ident(w);
      if (name === undefined || isWord(t[i - 1], "as") || [".", ":", "@", "$"].includes(t[i - 1] ?? "") || t[i + 1] === "(" || (t[i + 1] === "." && t[i + 2] === "*")) continue;
      if (name.includes(".") && !w.startsWith("\u0000")) {
        const dot = name.indexOf(".");
        target(name.slice(0, dot))?.cols.push(name.slice(dot + 1));
        continue;
      }
      if (!w.startsWith("\u0000") && (KEYWORDS.has(name.toLowerCase()) || cte.has(name.toLowerCase()))) continue;
      if (single) single.cols.push(name);
      else for (const u of reads) u.cols.push("*");
    }
  }
  for (const u of uses) keep(u.name, u.access, u.cols, cte);
}
