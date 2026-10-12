// `inloop generate scaffold`（ADR-0038）。資源の定義（名前と列）から、表・API・テスト・画面を決まった形で生成する。
// 生成するコードは固定の文だけで組み立てる（SQLは値を`?`で渡す）ので、解析エンジンが表と列を読める（ADR-0026、ADR-0031）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FieldType = "text" | "int" | "real" | "bool" | "date";
export interface Field { name: string; type: FieldType; optional: boolean }
export interface Resource {
  /** 単数の名前（snake_case）。例: blog_post */
  name: string;
  /** 複数の名前。表名とURLに使う。例: blog_posts */
  plural: string;
  /** 画面に出す名前 */
  label: string;
  fields: Field[];
}

const TYPES: readonly FieldType[] = ["text", "int", "real", "bool", "date"];
const NAME = /^[a-z][a-z0-9_]{0,40}$/;
/** 自動で付く列と、SQLの予約語（表名・列名に使うと引用符が要る語）。 */
const RESERVED = new Set([
  "id", "created_at", "updated_at",
  "select", "insert", "update", "delete", "from", "where", "table", "index", "order", "group", "by", "values", "set", "default", "primary", "key", "references",
  "check", "unique", "null", "not", "and", "or", "as", "on", "join", "limit", "offset", "create", "drop", "alter", "transaction", "begin", "end", "case", "when", "then",
  "else", "in", "is", "like", "between", "exists", "all", "any", "having", "union", "into", "to", "add", "column", "row", "rows", "view", "trigger", "replace", "match", "natural",
]);

export const pascal = (s: string): string => s.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
const camel = (s: string): string => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

/** 英語の単純な複数形。合わなければ`--plural`で指定する。 */
export function pluralOf(name: string): string {
  if (/(s|x|z|ch|sh)$/.test(name)) return `${name}es`;
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

/** `title:text done:bool note:text?`の形の列の定義を読む。 */
export function parseFields(specs: string[]): Field[] {
  if (specs.length === 0) throw new Error("列を1つ以上指定する（例: title:text done:bool）");
  const seen = new Set<string>();
  return specs.map((spec) => {
    // 省略できる列は 名前:型:optional（zshなどで`?`が展開されるので、`?`ではなく語にした）。引用符で囲めば 名前:型? も読む。
    const m = /^([^:]+):([^:?]+)(?::(optional)|(\?))?$/.exec(spec);
    if (!m) throw new Error(`列の定義「${spec}」は読めない（名前:型 または 名前:型:optional）`);
    const [, name, type, word, mark] = m as unknown as [string, string, FieldType, string | undefined, string | undefined];
    const optional = word ?? mark;
    if (!NAME.test(name)) throw new Error(`列の名前「${name}」は使えない（英小文字・数字・_、英字で始める）`);
    if (RESERVED.has(name)) throw new Error(`列の名前「${name}」は使えない（自動で付く列かSQLの予約語）`);
    if (!TYPES.includes(type)) throw new Error(`列「${name}」の型「${type}」は使えない（${TYPES.join("・")}）`);
    if (seen.has(name)) throw new Error(`列の名前「${name}」が重なっている`);
    seen.add(name);
    return { name, type, optional: optional !== undefined };
  });
}

export function defineResource(name: string, specs: string[], opts: { plural?: string; label?: string } = {}): Resource {
  if (!NAME.test(name)) throw new Error(`資源の名前「${name}」は使えない（単数の英小文字・数字・_、英字で始める。例: task、blog_post）`);
  const plural = opts.plural ?? pluralOf(name);
  for (const n of [name, plural]) if (RESERVED.has(n) || n === "notes" || n === "note") throw new Error(`資源の名前「${n}」は使えない（予約語か、最初からあるメモ）`);
  if (!NAME.test(plural)) throw new Error(`複数の名前「${plural}」は使えない`);
  return { name, plural, label: opts.label ?? plural, fields: parseFields(specs) };
}

const sqlType: Record<FieldType, string> = { text: "TEXT", int: "INTEGER", real: "REAL", bool: "INTEGER", date: "TEXT" };
const tsType: Record<FieldType, string> = { text: "string", int: "number", real: "number", bool: "boolean", date: "string" };
const jsStr = (s: string): string => JSON.stringify(s);

/** `CREATE TABLE`の文（`db.ts`の`db.exec`に入れる）。 */
export function createTableSql(r: Resource): string {
  const cols = r.fields.map((f) => `    ${f.name} ${sqlType[f.type]}${f.optional ? "" : " NOT NULL"}`);
  return [
    `CREATE TABLE IF NOT EXISTS ${r.plural} (`,
    "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
    ...cols.map((c) => `${c},`),
    "    created_at TEXT NOT NULL DEFAULT (datetime('now')),",
    "    updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
    "  )",
  ].join("\n  ");
}

/** 列の値を検証して、SQLに渡す値にする式。入力は`input[name]`。 */
function parseExpr(f: Field): string {
  const v = `input.${f.name}`;
  const n = f.name;
  const missing = f.optional ? `${v} === undefined || ${v} === null || ${v} === ""` : "false";
  const body: Record<FieldType, string> = {
    text: `typeof ${v} === "string" && ${v}.trim().length <= 1000 && ${v}.trim() !== "" ? ${v}.trim() : undefined`,
    int: `typeof ${v} === "number" && Number.isSafeInteger(${v}) ? ${v} : undefined`,
    real: `typeof ${v} === "number" && Number.isFinite(${v}) ? ${v} : undefined`,
    bool: `typeof ${v} === "boolean" ? (${v} ? 1 : 0) : undefined`,
    date: `typeof ${v} === "string" && isDate(${v}) ? ${v} : undefined`,
  };
  return f.optional
    ? `const ${n} = ${missing} ? null : ${body[f.type]};\n  if (${n} === undefined) return { error: ${jsStr(`${n} が正しくない`)} };`
    : `const ${n} = ${body[f.type]};\n  if (${n} === undefined) return { error: ${jsStr(`${n} が正しくない`)} };`;
}

export function routeSource(r: Resource): string {
  const T = pascal(r.name);
  const cols = r.fields.map((f) => f.name);
  const colList = ["id", ...cols, "created_at", "updated_at"].join(", ");
  const boolFields = r.fields.filter((f) => f.type === "bool");
  const iface = [
    "  id: number;",
    ...r.fields.map((f) => `  ${f.name}: ${tsType[f.type]}${f.optional ? " | null" : ""};`),
    "  created_at: string;",
    "  updated_at: string;",
  ].join("\n");
  const rowIface = [
    "  id: number;",
    ...r.fields.map((f) => `  ${f.name}: ${f.type === "bool" ? "number" : tsType[f.type]}${f.optional ? " | null" : ""};`),
    "  created_at: string;",
    "  updated_at: string;",
  ].join("\n");
  const toItem = boolFields.length === 0
    ? "const toItem = (row: Row): " + T + " => row;"
    : `const toItem = (row: Row): ${T} => ({ ...row, ${boolFields.map((f) => `${f.name}: ${f.optional ? `row.${f.name} === null ? null : row.${f.name} !== 0` : `row.${f.name} !== 0`}`).join(", ")} });`;
  const placeholders = cols.map(() => "?").join(", ");
  const setList = [...cols.map((c) => `${c} = ?`), "updated_at = datetime('now')"].join(", ");
  return `// ${r.label}（${r.name}）の API。\`inloop generate scaffold\` が作った。独自の検証や処理は、ここに足してよい。
import { Hono } from "hono";
import type { Db } from "../db.ts";

export interface ${T} {
${iface}
}
interface Row {
${rowIface}
}

${toItem}

/** YYYY-MM-DD の実在する日付か。 */
const isDate = (s: string): boolean => /^\\d{4}-\\d{2}-\\d{2}$/.test(s) && !Number.isNaN(Date.parse(\`\${s}T00:00:00Z\`)) && new Date(\`\${s}T00:00:00Z\`).toISOString().startsWith(s);

/** 入力を検証して、SQLに渡す値（列の並び）にする。 */
function parse(raw: unknown): { values: (string | number | null)[] } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "JSON のオブジェクトを送る" };
  const input = raw as Record<string, unknown>;
  ${r.fields.map((f) => parseExpr(f)).join("\n  ")}
  return { values: [${cols.join(", ")}] };
}

/** パスの id を数にする。数でなければ undefined。 */
const idOf = (s: string): number | undefined => (/^\\d{1,15}$/.test(s) ? Number(s) : undefined);

export function ${camel(r.plural)}Routes(db: Db) {
  const app = new Hono();

  app.get("/", (c) => {
    const rows = db.prepare("SELECT ${colList} FROM ${r.plural} ORDER BY id DESC").all() as unknown as Row[];
    return c.json(rows.map(toItem));
  });

  app.get("/:id", (c) => {
    const id = idOf(c.req.param("id"));
    const row = id === undefined ? undefined : (db.prepare("SELECT ${colList} FROM ${r.plural} WHERE id = ?").get(id) as unknown as Row | undefined);
    return row ? c.json(toItem(row)) : c.json({ error: "not found" }, 404);
  });

  app.post("/", async (c) => {
    const parsed = parse(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const result = db.prepare("INSERT INTO ${r.plural} (${cols.join(", ")}) VALUES (${placeholders})").run(...parsed.values);
    return c.json({ id: Number(result.lastInsertRowid) }, 201);
  });

  app.put("/:id", async (c) => {
    const id = idOf(c.req.param("id"));
    if (id === undefined) return c.json({ error: "not found" }, 404);
    const parsed = parse(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const result = db.prepare("UPDATE ${r.plural} SET ${setList} WHERE id = ?").run(...parsed.values, id);
    return result.changes === 0 ? c.json({ error: "not found" }, 404) : c.json({ ok: true });
  });

  app.delete("/:id", (c) => {
    const id = idOf(c.req.param("id"));
    const result = id === undefined ? undefined : db.prepare("DELETE FROM ${r.plural} WHERE id = ?").run(id);
    return result && result.changes > 0 ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  return app;
}
`;
}

/** テストに使う、列ごとの正しい値と正しくない値。 */
function sample(f: Field, n: number): string {
  switch (f.type) {
    case "text": return jsStr(`${f.name} ${n}`);
    case "int": return String(n);
    case "real": return `${n}.5`;
    case "bool": return n % 2 === 1 ? "true" : "false";
    case "date": return jsStr(`2026-01-${String(n).padStart(2, "0")}`);
  }
}
const bad = (f: Field): string => (f.type === "text" || f.type === "date" ? "12345" : jsStr("x"));

export function testSource(r: Resource): string {
  const T = pascal(r.name);
  const obj = (n: number) => `{ ${r.fields.map((f) => `${f.name}: ${sample(f, n)}`).join(", ")} }`;
  const first = r.fields.find((f) => !f.optional);
  const lines = [
    `// ${r.label}（${r.name}）の API のテスト。\`inloop generate scaffold\` が作った。`,
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { createApp } from "./app.ts";',
    'import { openDb } from "./db.ts";',
    `import type { ${T} } from "./routes/${r.plural}.ts";`,
    "",
    "const json = (method: string, body?: unknown) => ({ method, headers: { \"content-type\": \"application/json\" }, body: body === undefined ? undefined : JSON.stringify(body) });",
    "",
    `test(${jsStr(`${r.label}を作って、一覧と1件で取れる`)}, async () => {`,
    "  const app = createApp(openDb(\":memory:\"));",
    `  const created = await app.request("/api/${r.plural}", json("POST", ${obj(1)}));`,
    "  assert.equal(created.status, 201);",
    "  const { id } = (await created.json()) as { id: number };",
    `  const list = (await (await app.request("/api/${r.plural}")).json()) as ${T}[];`,
    "  assert.equal(list.length, 1);",
    `  const one = (await (await app.request(\`/api/${r.plural}/\${id}\`)).json()) as ${T};`,
    ...r.fields.map((f) => `  assert.equal(one.${f.name}, ${sample(f, 1)});`),
    "});",
    "",
    `test(${jsStr(`${r.label}を更新して、削除できる`)}, async () => {`,
    "  const app = createApp(openDb(\":memory:\"));",
    `  const { id } = (await (await app.request("/api/${r.plural}", json("POST", ${obj(1)}))).json()) as { id: number };`,
    `  const updated = await app.request(\`/api/${r.plural}/\${id}\`, json("PUT", ${obj(2)}));`,
    "  assert.equal(updated.status, 200);",
    `  const one = (await (await app.request(\`/api/${r.plural}/\${id}\`)).json()) as ${T};`,
    ...r.fields.map((f) => `  assert.equal(one.${f.name}, ${sample(f, 2)});`),
    `  assert.equal((await app.request(\`/api/${r.plural}/\${id}\`, { method: "DELETE" })).status, 204);`,
    `  assert.equal((await app.request(\`/api/${r.plural}/\${id}\`)).status, 404);`,
    "});",
    "",
    `test(${jsStr("正しくない入力と、ないものは断る")}, async () => {`,
    "  const app = createApp(openDb(\":memory:\"));",
    `  assert.equal((await app.request("/api/${r.plural}", json("POST", {}))).status, ${first ? 400 : 201});`,
    ...(first ? [`  assert.equal((await app.request("/api/${r.plural}", json("POST", { ...${obj(1)}, ${first.name}: ${bad(first)} }))).status, 400);`] : []),
    `  assert.equal((await app.request("/api/${r.plural}/999")).status, 404);`,
    `  assert.equal((await app.request("/api/${r.plural}/abc")).status, 404);`,
    `  assert.equal((await app.request("/api/${r.plural}/999", json("PUT", ${obj(1)}))).status, 404);`,
    `  assert.equal((await app.request("/api/${r.plural}/999", { method: "DELETE" })).status, 404);`,
    "});",
    "",
  ];
  return lines.join("\n");
}

const inputLabel = (f: Field): string => f.name;

export function pageSource(r: Resource): string {
  const T = pascal(r.name);
  const P = pascal(r.plural);
  const empty = (f: Field): string => (f.type === "bool" ? "false" : f.type === "text" || f.type === "date" ? '""' : '""');
  const iface = [
    "  id: number;",
    ...r.fields.map((f) => `  ${f.name}: ${tsType[f.type]}${f.optional ? " | null" : ""};`),
  ].join("\n");
  const formType = r.fields.map((f) => `${f.name}: ${f.type === "bool" ? "boolean" : "string"}`).join("; ");
  const blank = r.fields.map((f) => `${f.name}: ${empty(f)}`).join(", ");
  const fromItem = r.fields
    .map((f) => `${f.name}: ${f.type === "bool" ? `item.${f.name} === true` : `item.${f.name} === null ? "" : String(item.${f.name})`}`)
    .join(", ");
  const toBody = r.fields.map((f) => {
    const v = `form.${f.name}`;
    switch (f.type) {
      case "bool": return `${f.name}: ${v}`;
      case "int":
      case "real": return `${f.name}: ${v} === "" ? null : Number(${v})`;
      default: return `${f.name}: ${v} === "" ? null : ${v}`;
    }
  }).join(", ");
  const input = (f: Field): string => {
    const label = inputLabel(f) + (f.optional ? "（省略可）" : "");
    if (f.type === "bool") {
      return `        <label className="field-check"><input type="checkbox" checked={form.${f.name}} onChange={(e) => setForm({ ...form, ${f.name}: e.target.checked })} /> <span>${label}</span></label>`;
    }
    const type = f.type === "text" ? "text" : f.type === "date" ? "date" : "number";
    const step = f.type === "real" ? ' step="any"' : f.type === "int" ? ' step="1"' : "";
    return `        <label className="field"><span>${label}</span><input type="${type}"${step}${f.optional ? "" : " required"} value={form.${f.name}} onChange={(e) => setForm({ ...form, ${f.name}: e.target.value })} /></label>`;
  };
  const cell = (f: Field): string => (f.type === "bool" ? `{item.${f.name} === null ? "" : item.${f.name} ? "はい" : "いいえ"}` : `{item.${f.name} ?? ""}`);
  return `// ${r.label}（${r.name}）の画面。\`inloop generate scaffold\` が作った。見た目は web/src/style.css の変数とクラスを使う。
import { useEffect, useState } from "react";

interface ${T} {
${iface}
}
type Form = { ${formType} };

const blank: Form = { ${blank} };
const toForm = (item: ${T}): Form => ({ ${fromItem} });
const API = "/api/${r.plural}";

export function ${P}() {
  const [items, setItems] = useState<${T}[]>([]);
  const [form, setForm] = useState<Form>(blank);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState("");

  const load = async () => setItems((await (await fetch(API)).json()) as ${T}[]);
  useEffect(() => { void load(); }, []);

  const reset = () => { setForm(blank); setEditing(null); setError(""); };

  const save = async () => {
    const r = await fetch(editing === null ? API : \`\${API}/\${editing}\`, {
      method: editing === null ? "POST" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ${toBody} }),
    });
    if (!r.ok) { setError(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "保存できなかった"); return; }
    reset();
    await load();
  };

  const remove = async (id: number) => {
    if (!confirm("削除しますか？")) return;
    await fetch(\`\${API}/\${id}\`, { method: "DELETE" });
    if (editing === id) reset();
    await load();
  };

  return (
    <>
      <h2>${r.label}</h2>
      <form className="card form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
${r.fields.map(input).join("\n")}
        {error !== "" && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="submit" className="primary">{editing === null ? "追加" : "更新"}</button>
          {editing !== null && <button type="button" onClick={reset}>キャンセル</button>}
        </div>
      </form>
      <div className="card">
        {items.length === 0 ? (
          <p className="muted">まだありません。</p>
        ) : (
          <table>
            <thead>
              <tr>${r.fields.map((f) => `<th>${inputLabel(f)}</th>`).join("")}<th></th></tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  ${r.fields.map((f) => `<td>${cell(f)}</td>`).join("\n                  ")}
                  <td className="row-actions">
                    <button type="button" onClick={() => { setForm(toForm(item)); setEditing(item.id); setError(""); }}>編集</button>{" "}
                    <button type="button" className="danger" onClick={() => void remove(item.id)}>削除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
`;
}

/** 生成の結果。`write`が実際に書く。 */
export interface Plan { create: { path: string; content: string }[]; edit: { path: string; content: string }[] }

const MARKERS = {
  tables: "// inloop:tables",
  routesImport: "// inloop:imports",
  routes: "// inloop:routes",
  pagesImport: "// inloop:imports",
  pages: "// inloop:pages",
} as const;

/** マーカーの行の直前に、同じ字下げで行を足す。 */
function insertBefore(file: string, text: string, marker: string, lines: string[]): string {
  const idx = text.indexOf(marker);
  if (idx < 0) throw new Error(`${file} に目印「${marker}」がない。雛形の版が古いので、目印の行を手で足す（足す場所は、同じ目印がある新しい雛形の${file}を見る）`);
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  const indent = text.slice(lineStart, idx);
  return `${text.slice(0, lineStart)}${lines.map((l) => (l === "" ? "" : `${indent}${l}`)).join("\n")}\n${text.slice(lineStart)}`;
}

/** 生成の計画を作る（書かない）。既にあるものを壊さないよう、重なりは断る。 */
export function plan(repo: string, r: Resource): Plan {
  const read = (p: string): string => {
    if (!existsSync(join(repo, p))) throw new Error(`${p} がない。inloop new で作ったアプリのリポジトリで動かす`);
    return readFileSync(join(repo, p), "utf8");
  };
  const files = {
    route: `server/routes/${r.plural}.ts`,
    test: `server/${r.plural}.test.ts`,
    page: `web/src/pages/${pascal(r.plural)}.tsx`,
  };
  for (const p of Object.values(files)) if (existsSync(join(repo, p))) throw new Error(`${p} はすでにある（上書きしない）`);
  const db = read("server/db.ts");
  const app = read("server/app.ts");
  const web = read("web/src/App.tsx");
  if (new RegExp(`CREATE TABLE IF NOT EXISTS ${r.plural}\\b`, "i").test(db) || app.includes(`"/api/${r.plural}"`)) throw new Error(`${r.plural} はすでにある`);

  const newDb = insertBefore("server/db.ts", db, MARKERS.tables, [`db.exec(\`${createTableSql(r)}\`);`]);
  const route = `${camel(r.plural)}Routes`;
  const newApp = insertBefore(
    "server/app.ts",
    insertBefore("server/app.ts", app, MARKERS.routesImport, [`import { ${route} } from "./routes/${r.plural}.ts";`]),
    MARKERS.routes,
    [`app.route("/api/${r.plural}", ${route}(db));`],
  );
  const newWeb = insertBefore(
    "web/src/App.tsx",
    insertBefore("web/src/App.tsx", web, MARKERS.pagesImport, [`import { ${pascal(r.plural)} } from "./pages/${pascal(r.plural)}.tsx";`]),
    MARKERS.pages,
    [`{ path: ${jsStr(r.plural)}, label: ${jsStr(r.label)}, Page: ${pascal(r.plural)} },`],
  );
  const edit = [
    { path: "server/db.ts", content: newDb },
    { path: "server/app.ts", content: newApp },
    { path: "web/src/App.tsx", content: newWeb },
  ];
  // レイヤーの定義に、生成した資源のAPIを加える（すでに含まれていれば何もしない）。
  const cfg = join(repo, "inloop.json");
  if (existsSync(cfg)) {
    const json = JSON.parse(readFileSync(cfg, "utf8")) as { layers?: { id: string; files: string[] }[] };
    const http = json.layers?.find((l) => l.id === "http");
    if (http && !http.files.includes("server/routes/*.ts")) {
      http.files.push("server/routes/*.ts");
      edit.push({ path: "inloop.json", content: `${JSON.stringify(json, null, 2)}\n` });
    }
  }
  return {
    create: [
      { path: files.route, content: routeSource(r) },
      { path: files.test, content: testSource(r) },
      { path: files.page, content: pageSource(r) },
    ],
    edit,
  };
}

export function write(repo: string, p: Plan): void {
  for (const f of [...p.create, ...p.edit]) {
    mkdirSync(dirname(join(repo, f.path)), { recursive: true });
    writeFileSync(join(repo, f.path), f.content);
  }
}
