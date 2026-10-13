// ユースケースの対応（ADR-0046）。HTTPの入口（`app.get("/path", …)`）を1つのユースケースとし、
// そのコードが触るテーブルと、その入口へ要求を送るテスト（`app.request("/path", …)`）を、構文とリテラルだけから結び付ける。
// 値の流れ（どの入力がどの列に入るか）と、テストが何を確かめているかは追わない。結び付けられない形は、推測せず検査（uc-*）で違反にする。
import { SyntaxKind } from "typescript/unstable/ast";
import type { Node } from "typescript/unstable/ast";
import { INDIRECT_DEPTH, tablesOf } from "./sql.js";
import { matchesAny, type UseCaseSpec } from "./rules.js";
import type { Declaration, TsProject } from "./project.js";
import type { ReviewUseCase } from "../server/types.js";

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;
const METHODS = new Set<string>(HTTP_METHODS);

/** 命名規則の検査（`inloop lint`）の規則。違反したときに何をするか。 */
export const USECASE_RULES: Record<string, { fix: string }> = {
  "uc-app-name": { fix: "Honoの変数は`const app = new Hono()`の名前にする（ユースケースの入口を`app.get(…)`で見つけるため）" },
  "uc-route-literal": { fix: "入口の登録は`app.get(\"/path\", …)`・`app.route(\"/prefix\", xxxRoutes(db))`の形にし、パスは文字列のリテラルにする（`app.on`・`app.mount`は使わない）" },
  "uc-route-duplicate": { fix: "同じメソッドと同じパスの入口を2つ作らない（テストの結び付けが決まらない）" },
  "uc-test-request": { fix: "テストの`app.request(…)`は、パスを文字列・テンプレートで書き、メソッドは省略（GET）・`{ method: \"POST\" }`・`json(\"POST\", …)`の形で書く" },
};

export interface UseCaseFinding { rule: string; file: string; line: number; message: string }

/** ユースケース1つ。`touches`は、入口のコードから呼び出しでたどれた宣言のID（依頼票に結び付ける印。記録には残さない）。 */
export interface UseCase extends Omit<ReviewUseCase, "symbol"> {
  method: string;
  path: string;
  /** 入口を登録している宣言のID */
  symbol: string;
  touches: string[];
  /** 入口のコードの中で、行き先を決められなかった呼び出しと動的なSQL */
  unresolved: string[];
}

export interface UseCaseMap {
  usecases: UseCase[];
  /** どのユースケースにも結び付かなかったテストの要求（`メソッド パス`、ファイル:行） */
  unlinked: string[];
  findings: UseCaseFinding[];
}

const text = (n: Node | undefined): string | undefined => {
  if (!n) return undefined;
  const u = unwrap(n);
  return u.kind === SyntaxKind.StringLiteral || u.kind === SyntaxKind.NoSubstitutionTemplateLiteral ? (u as unknown as { text: string }).text : undefined;
};

function unwrap(n: Node): Node {
  let c = n;
  while (c.kind === SyntaxKind.ParenthesizedExpression || c.kind === SyntaxKind.AsExpression || c.kind === SyntaxKind.SatisfiesExpression || c.kind === SyntaxKind.NonNullExpression) c = (c as unknown as { expression: Node }).expression;
  return c;
}

/** テストの要求のパスの、値の決まらない部分（`${id}`）。入口の`:id`とだけ対応させる。 */
const HOLE = ":_";

/**
 * パスの式を文字列にする。リテラル・テンプレート・`+`でつないだ式を読み、式の部分は`HOLE`にする。
 * 先頭がリテラルでなければ（`base + "/x"`のように最初が変数）、パスを決められないのでundefined。
 */
function pathOf(n: Node, top = true): string | undefined {
  const u = unwrap(n);
  const t = text(u);
  if (t !== undefined) return t;
  if (u.kind === SyntaxKind.TemplateExpression) {
    const x = u as unknown as { head: { text: string }; templateSpans: { literal: { text: string } }[] };
    return x.head.text + x.templateSpans.map((s) => HOLE + s.literal.text).join("");
  }
  if (u.kind === SyntaxKind.BinaryExpression) {
    const b = u as unknown as { left: Node; right: Node; operatorToken: Node };
    if (b.operatorToken.kind !== SyntaxKind.PlusToken) return undefined;
    const l = pathOf(b.left, top);
    if (l === undefined) return undefined;
    return l + (pathOf(b.right, false) ?? HOLE);
  }
  return top ? undefined : HOLE;
}

/** 要求のメソッド。省略はGET、`{ method: "POST" }`と`json("POST", …)`（最初の引数がHTTPメソッドの呼び出し）を読む。 */
function methodOf(opts: Node | undefined): string | undefined {
  if (!opts) return "GET";
  const u = unwrap(opts);
  if (u.kind === SyntaxKind.ObjectLiteralExpression) {
    for (const p of (u as unknown as { properties: Node[] }).properties) {
      const name = (p as unknown as { name?: Node }).name;
      const key = name && (name.kind === SyntaxKind.Identifier || name.kind === SyntaxKind.StringLiteral) ? (name as unknown as { text: string }).text : undefined;
      if (key !== "method") continue;
      if (p.kind !== SyntaxKind.PropertyAssignment) return undefined;
      return verb(text((p as unknown as { initializer: Node }).initializer));
    }
    return "GET";
  }
  if (u.kind === SyntaxKind.CallExpression) return verb(text((u as unknown as { arguments: Node[] }).arguments[0]));
  return undefined;
}

const verb = (s: string | undefined): string | undefined => (s !== undefined && METHODS.has(s.toLowerCase()) ? s.toUpperCase() : undefined);

/** 入口のパスを、マウント先の接頭辞とつなぐ。 */
export function joinPath(prefix: string, path: string): string {
  const p = `${prefix}${path === "/" ? "" : path}`;
  return p === "" ? "/" : p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

interface Route { method: string; path: string; call: Node; handlers: Node[]; file: string; line: number; decl: Declaration | undefined }
interface Mount { prefix: string; callee: string; from: Declaration | undefined }
interface Request { method: string; path: string; name: string; file: string; line: number }

const lineOf = (project: TsProject, file: string, n: Node): number => {
  const sf = project.syntax(file)!;
  return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
};

/** 位置を含む宣言のうち、いちばん内側のもの。 */
function enclosing(project: TsProject, file: string, n: Node): Declaration | undefined {
  const sf = project.syntax(file)!;
  const at = n.getStart(sf);
  let best: Declaration | undefined;
  for (const d of project.declarationsOf(file)) {
    if (d.node.getStart(sf) <= at && at < d.end && (!best || d.end - d.start < best.end - best.start)) best = d;
  }
  return best;
}

const nameOf = (id: string) => id.slice(id.indexOf("#") + 1).split(".")[0]!;

/** 入口の登録・マウント・テストの要求を集め、命名規則の違反も見つける。 */
export function usecaseMap(project: TsProject, spec: UseCaseSpec): UseCaseMap {
  const findings: UseCaseFinding[] = [];
  const routes: Route[] = [];
  const mounts: Mount[] = [];
  const requests: Request[] = [];
  const files = project.repoFiles();
  const add = (rule: string, file: string, n: Node, message: string) => findings.push({ rule, file, line: lineOf(project, file, n), message });

  for (const file of files.filter((f) => matchesAny(spec.routes, f))) {
    const sf = project.syntax(file);
    if (!sf) continue;
    const walk = (n: Node) => {
      if (n.kind === SyntaxKind.VariableDeclaration) {
        const d = n as unknown as { name: Node; initializer?: Node };
        const init = d.initializer && unwrap(d.initializer);
        const callee = init?.kind === SyntaxKind.NewExpression ? (init as unknown as { expression: Node }).expression : undefined;
        if (callee?.kind === SyntaxKind.Identifier && (callee as unknown as { text: string }).text === "Hono" && !(d.name.kind === SyntaxKind.Identifier && (d.name as unknown as { text: string }).text === "app")) {
          add("uc-app-name", file, n, "Honoの変数の名前がappではない");
        }
      }
      if (n.kind === SyntaxKind.CallExpression) {
        const c = n as unknown as { expression: Node; arguments: Node[] };
        if (c.expression.kind === SyntaxKind.PropertyAccessExpression) {
          const pa = c.expression as unknown as { expression: Node; name: { text: string } };
          const recv = unwrap(pa.expression);
          const isApp = recv.kind === SyntaxKind.Identifier && (recv as unknown as { text: string }).text === "app";
          const m = pa.name.text;
          if (isApp && (METHODS.has(m) || m === "all") && c.arguments.length >= 2) {
            const path = text(c.arguments[0]);
            if (path === undefined || !path.startsWith("/")) add("uc-route-literal", file, n, `app.${m}の最初の引数が、/で始まる文字列のリテラルではない`);
            else if (m !== "all") routes.push({ method: m.toUpperCase(), path, call: n, handlers: c.arguments.slice(1), file, line: lineOf(project, file, n), decl: enclosing(project, file, n) });
            else add("uc-route-literal", file, n, "app.allは、どのメソッドの入口か決まらない");
          } else if (isApp && m === "route") {
            const prefix = text(c.arguments[0]);
            const made = c.arguments[1] && unwrap(c.arguments[1]);
            const callee = made?.kind === SyntaxKind.CallExpression ? unwrap((made as unknown as { expression: Node }).expression) : undefined;
            if (prefix === undefined || !prefix.startsWith("/") || callee?.kind !== SyntaxKind.Identifier) add("uc-route-literal", file, n, "app.routeは、app.route(\"/prefix\", xxxRoutes(db))の形で書く");
            else mounts.push({ prefix, callee: (callee as unknown as { text: string }).text, from: enclosing(project, file, n) });
          } else if (isApp && (m === "on" || m === "mount" || m === "basePath")) {
            add("uc-route-literal", file, n, `app.${m}は入口の登録として読めない`);
          }
        }
      }
      n.forEachChild(walk);
    };
    walk(sf);
  }

  for (const file of files.filter((f) => matchesAny(spec.tests, f))) {
    const sf = project.syntax(file);
    if (!sf) continue;
    const walk = (n: Node, test: string | undefined) => {
      let name = test;
      if (n.kind === SyntaxKind.CallExpression) {
        const c = n as unknown as { expression: Node; arguments: Node[] };
        const callee = unwrap(c.expression);
        if (callee.kind === SyntaxKind.Identifier && ["test", "it"].includes((callee as unknown as { text: string }).text)) name = text(c.arguments[0]) ?? name;
        if (callee.kind === SyntaxKind.PropertyAccessExpression && (callee as unknown as { name: { text: string } }).name.text === "request") {
          const path = c.arguments[0] && pathOf(c.arguments[0]);
          const method = methodOf(c.arguments[1]);
          if (path === undefined || !path.startsWith("/") || method === undefined) add("uc-test-request", file, n, "app.requestのパスかメソッドが、リテラルから決められない");
          else requests.push({ method, path: path.split(/[?#]/)[0]!, name: name ?? file, file, line: lineOf(project, file, n) });
        }
      }
      n.forEachChild((x) => walk(x, name));
    };
    walk(sf, undefined);
  }

  // マウント先の接頭辞。入口を登録している宣言（xxxRoutes）の名前を`app.route`の呼び出し先から引き、マウントした宣言の接頭辞を重ねる。
  // どこからもマウントされていない宣言は、根（createAppなど）として接頭辞なし。
  const prefixesOf = (decl: Declaration | undefined, seen: string[] = []): string[] => {
    if (!decl || seen.includes(decl.id) || seen.length > 4) return [""];
    const via = mounts.filter((m) => m.callee === nameOf(decl.id));
    if (via.length === 0) return [""];
    return via.flatMap((m) => prefixesOf(m.from, [...seen, decl.id]).map((p) => p + m.prefix));
  };

  const usecases: UseCase[] = [];
  const seen = new Map<string, Route>();
  for (const r of routes) {
    for (const prefix of prefixesOf(r.decl)) {
      const path = joinPath(prefix, r.path);
      const id = `${r.method} ${path}`;
      if (seen.has(id)) { findings.push({ rule: "uc-route-duplicate", file: r.file, line: r.line, message: `${id} の入口が重なっている（先の登録: ${seen.get(id)!.file}:${seen.get(id)!.line}）` }); continue; }
      seen.set(id, r);
      const data = dataOf(project, r);
      usecases.push({ id, method: r.method, path, symbol: r.decl?.id ?? r.file, file: r.file, line: r.line, tables: data.tables, tests: [], touches: data.touches, unresolved: data.unresolved });
    }
  }

  // テストの結び付け。同じ長さの区切りで、リテラルは等しく、入口の`:名前`はどの値にも、テストの値の決まらない部分は`:名前`とだけ対応させる。
  // 複数に当たるときは、リテラルが一致した区切りの数が最大のものだけ（`/tasks/new`と`/tasks/:id`なら前者）。
  const unlinked: string[] = [];
  for (const q of requests) {
    const segs = q.path.split("/");
    const scored = usecases.filter((u) => u.method === q.method).flatMap((u) => {
      const us = u.path.split("/");
      if (us.length !== segs.length) return [];
      let literal = 0;
      for (let i = 0; i < us.length; i++) {
        const param = us[i]!.startsWith(":");
        const hole = segs[i]!.includes(HOLE);
        if (param) continue;
        if (hole || segs[i] !== us[i]) return [];
        literal++;
      }
      return [{ u, literal }];
    });
    const best = Math.max(0, ...scored.map((s) => s.literal));
    const hit = scored.filter((s) => s.literal === best);
    if (hit.length === 0) unlinked.push(`${q.method} ${q.path}\t${q.file}:${q.line}`);
    for (const { u } of hit) if (!u.tests.some((t) => t.name === q.name && t.file === q.file)) u.tests.push({ name: q.name, file: q.file, line: q.line });
  }
  for (const u of usecases) u.tests.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  usecases.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  return { usecases, unlinked, findings };
}

/** 入口のコード（ハンドラー）が触るテーブルと、呼び出しでたどれた宣言。ADR-0026、ADR-0030と同じ読み方。 */
function dataOf(project: TsProject, r: Route): { tables: ReviewUseCase["tables"]; touches: string[]; unresolved: string[] } {
  const tables: ReviewUseCase["tables"] = [];
  const touches = new Set<string>();
  const unresolved: string[] = [];
  const keep = (statements: string[], via?: string[]) => {
    for (const st of statements) {
      for (const t of tablesOf(st)) {
        const found = tables.find((x) => x.table === t.table && x.access === t.access && x.via?.join() === via?.join());
        if (!found) { tables.push({ ...t, ...(via ? { via } : {}) }); continue; }
        if (!t.columns) continue;
        const merged = new Map([...(found.columns ?? []), ...t.columns].map((c) => [c.toLowerCase(), c] as const));
        const cols = [...merged.values()];
        found.columns = [...cols.filter((c) => c === "*"), ...cols.filter((c) => c !== "*").sort()];
      }
    }
  };
  const direct = project.sqlIn(r.file, r.handlers);
  unresolved.push(...direct.dynamic);
  keep(direct.statements);
  const refs = project.referencesIn(r.file, r.handlers);
  unresolved.push(...refs.unresolved);
  for (const id of refs.internal) {
    const d = project.find(id);
    if (!d) continue;
    touches.add(id);
    const inner = project.sqlIn(d.file, [d.node]);
    unresolved.push(...inner.dynamic);
    keep(inner.statements, [id]);
    for (const x of project.reachByCalls(d, INDIRECT_DEPTH - 1)) {
      touches.add(x.decl.id);
      const deep = project.sqlIn(x.decl.file, [x.decl.node]);
      unresolved.push(...deep.dynamic, ...x.unresolved);
      keep(deep.statements, [id, ...x.via]);
    }
  }
  const acc = ["read", "write", "schema"];
  tables.sort((a, b) => acc.indexOf(a.access) - acc.indexOf(b.access) || a.table.localeCompare(b.table));
  return { tables, touches: [...touches], unresolved: [...new Set(unresolved)] };
}

/**
 * 依頼票に付けるユースケース。入口を登録している宣言か、入口が呼び出しでたどれる宣言が、依頼票に並んだものを選ぶ。
 * 画面で押したときに移る先（`symbol`）は、並んだ宣言のうち、入口を登録している宣言を優先する。
 */
export function usecasesForPacket(map: UseCaseMap, shown: ReadonlySet<string>): ReviewUseCase[] {
  const out: ReviewUseCase[] = [];
  for (const u of map.usecases) {
    const target = shown.has(u.symbol) ? u.symbol : u.touches.find((t) => shown.has(t));
    if (!target) continue;
    out.push({ id: u.id, symbol: target, file: u.file, line: u.line, tables: u.tables, tests: u.tests });
  }
  return out;
}
