// TypeScriptの解析（ADR-0015）。TypeScript 7の`typescript/unstable/sync`を使う部分は、このファイルに閉じ込める。
// APIは不安定とされているので、版を固定し、差し替えるときはこのファイルだけを直す。
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import type { Node, SourceFile } from "typescript/unstable/ast";
import { API, SymbolFlags } from "typescript/unstable/sync";
import type { Checker, Project, Symbol as TsSymbol } from "typescript/unstable/sync";
import { looksLikeSql } from "./sql.js";

/** シンボルの宣言。IDは`リポジトリからのパス#名前`、クラスのメンバーは`.`でつなぐ（ADR-0015）。 */
export interface Declaration {
  id: string;
  /** リポジトリからのパス（区切りは/） */
  file: string;
  node: Node;
  /** 宣言の始まり（JSDocを含む）と終わりの位置 */
  start: number;
  end: number;
  /** 1始まりの行 */
  startLine: number;
  endLine: number;
  code: string;
}

/** 使い方の種類（ADR-0020）。呼び出し、new、型としての参照、継承・実装。 */
export type UseKind = "call" | "new" | "type" | "inherit";

/** 呼び出しや型の参照のうち、宣言までたどれたもの・たどれなかったもの。 */
export interface References {
  /** 同じリポジトリの宣言のID（自分自身は含まない） */
  internal: string[];
  /** internalのそれぞれを、どう使っているか。同じ宣言を別の使い方でも使えば、別の項目になる。 */
  uses: { to: string; kind: UseKind }[];
  /** 解決できなかった呼び出し（`file:line 式`） */
  unresolved: string[];
}

/** importした名前と、リポジトリの外の名前の使用（信頼境界ルールの判定に使う、ADR-0022）。 */
export interface Uses {
  /**
   * importした名前。名前付きimportは元の名前。名前空間・既定のimportは、`x.名前`と使えばその名前、
   * そのまま使えば`*`・`default`。動的import（`import("m")`）は`*`。
   */
  imports: { module: string; name: string }[];
  /** リポジトリの外で宣言された、または宣言までたどれない名前。プロパティの連なりは`.`でつなぐ（`process.env`）。 */
  globals: string[];
}

/** ファイルの最上位の文のうち、宣言でもimport・exportの宣言でもないもの（ADR-0022）。 */
export interface TopLevel {
  nodes: Node[];
  /** 文が占める行（1始まり） */
  lines: Set<number>;
}

export class TsProject {
  private readonly api: API;
  private readonly project: Project;
  private readonly checker: Checker;
  /** 小文字にしたパスから、元の綴りのパス。APIが返すパスは小文字のことがある。 */
  private readonly files = new Map<string, string>();
  private readonly declarations = new Map<string, Declaration[]>();

  constructor(private readonly repo: string) {
    const config = join(repo, "tsconfig.json");
    if (!existsSync(config)) throw new Error(`${repo}: tsconfig.json がない（TypeScriptのプロジェクトとして解析できない）`);
    this.api = new API({ cwd: repo });
    const project = this.api.updateSnapshot({ openProject: config }).getProjects()[0];
    if (!project) { this.api.close(); throw new Error(`${config}: プロジェクトを読めない`); }
    this.project = project;
    this.checker = project.checker;
    for (const f of project.program.getSourceFileNames()) {
      if (!f.split(/[\\/]/).includes("node_modules") && this.inRepo(f)) this.files.set(f.toLowerCase(), f);
    }
  }

  close(): void {
    this.api.close();
  }

  private inRepo(file: string): boolean {
    const r = relative(this.repo, file);
    return r !== "" && !r.startsWith("..") && !r.startsWith(sep);
  }

  private rel(file: string): string {
    return relative(this.repo, file).split(sep).join("/");
  }

  /** プロジェクトに含まれる、リポジトリのファイルか。 */
  has(relFile: string): boolean {
    return this.files.has(join(this.repo, relFile).toLowerCase());
  }

  /** リポジトリのファイルの宣言の一覧。トップレベルの宣言と、クラスのメンバー。 */
  declarationsOf(relFile: string): Declaration[] {
    const cached = this.declarations.get(relFile);
    if (cached) return cached;
    const sf = this.sourceOf(relFile);
    const out: Declaration[] = [];
    if (sf) {
      const add = (name: string, node: Node) => {
        const start = node.getStart(sf, true);
        out.push({
          id: `${relFile}#${name}`,
          file: relFile,
          node,
          start,
          end: node.end,
          startLine: sf.getLineAndCharacterOfPosition(start).line + 1,
          endLine: sf.getLineAndCharacterOfPosition(node.end).line + 1,
          code: sf.text.slice(start, node.end),
        });
      };
      sf.forEachChild((n) => {
        const name = nameOf(n);
        if (n.kind === SyntaxKind.VariableStatement) {
          // const a = ..., b = ... はそれぞれを宣言とする。1つだけなら、文全体（export const ...）を示す。
          const decls = (n as unknown as { declarationList: { declarations: Node[] } }).declarationList.declarations;
          for (const d of decls) {
            const dn = nameOf(d);
            if (dn) add(dn, decls.length === 1 ? n : d);
          }
          return;
        }
        if (!name || !DECLARATION_KINDS.has(n.kind)) return;
        add(name, n);
        if (n.kind === SyntaxKind.ClassDeclaration) {
          for (const m of (n as unknown as { members: Node[] }).members) {
            const mn = m.kind === SyntaxKind.Constructor ? "constructor" : nameOf(m);
            if (mn && MEMBER_KINDS.has(m.kind)) add(`${name}.${mn}`, m);
          }
        }
      });
    }
    this.declarations.set(relFile, out);
    return out;
  }

  /**
   * ファイルの最上位の文のうち、宣言として一覧に出ないもの（`serve(...)`、`export default app`など）。
   * import・exportの宣言（`export { a } from`）は、それ自体では何も実行しないので含めない。
   */
  topLevel(relFile: string): TopLevel {
    const sf = this.sourceOf(relFile);
    const out: TopLevel = { nodes: [], lines: new Set() };
    if (!sf) return out;
    const decls = this.declarationsOf(relFile);
    sf.forEachChild((n) => {
      if (n.kind === SyntaxKind.EndOfFile || NOT_CODE.has(n.kind)) return;
      if (decls.some((d) => d.node === n || (n.kind === SyntaxKind.VariableStatement && d.node.pos >= n.pos && d.end <= n.end))) return;
      out.nodes.push(n);
      const first = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const last = sf.getLineAndCharacterOfPosition(n.end).line + 1;
      for (let l = first; l <= last; l++) out.lines.add(l);
    });
    return out;
  }

  /** リポジトリのファイル（node_modulesを除く）。リポジトリからのパスの順。 */
  repoFiles(): string[] {
    return [...this.files.values()].map((f) => this.rel(f)).sort();
  }

  /** シンボルIDから宣言を探す。なければundefined。 */
  find(id: string): Declaration | undefined {
    const i = id.indexOf("#");
    if (i <= 0) return undefined;
    return this.declarationsOf(id.slice(0, i)).find((d) => d.id === id);
  }

  /**
   * 呼び出し・`new`でたどれる同じリポジトリの宣言を、depth段まで集める（ADR-0030）。skipの宣言には入らず、その先へも進まない。
   * `via`は、起点の次の宣言から、その宣言までのシンボルID。未解決の参照は、たどった宣言のものを返す（先にSQLがあるか分からないため）。
   */
  reachByCalls(from: Declaration, depth: number, skip: ReadonlySet<string> = new Set()): { decl: Declaration; via: string[]; unresolved: string[] }[] {
    const out: { decl: Declaration; via: string[]; unresolved: string[] }[] = [];
    const seen = new Set<string>([from.id]);
    let frontier: { decl: Declaration; via: string[] }[] = [{ decl: from, via: [] }];
    for (let level = 0; level < depth; level++) {
      const next: { decl: Declaration; via: string[] }[] = [];
      for (const f of frontier) {
        for (const u of this.references(f.decl).uses) {
          if ((u.kind !== "call" && u.kind !== "new") || seen.has(u.to) || skip.has(u.to)) continue;
          const d = this.find(u.to);
          if (!d) continue;
          seen.add(u.to);
          const via = [...f.via, d.id];
          out.push({ decl: d, via, unresolved: this.references(d).unresolved });
          next.push({ decl: d, via });
        }
      }
      frontier = next;
    }
    return out;
  }

  /** 位置を含む宣言のうち、いちばん内側のもの。 */
  private enclosing(relFile: string, pos: number): Declaration | undefined {
    let best: Declaration | undefined;
    for (const d of this.declarationsOf(relFile)) {
      if (d.node.pos <= pos && pos < d.end && (!best || d.end - d.start < best.end - best.start)) best = d;
    }
    return best;
  }

  /**
   * 宣言の中の呼び出し・new・型の参照・継承を、宣言までたどる。
   * 同じリポジトリの宣言はIDで返し、宣言が見つからない呼び出しは「未解決」として返す。
   * リポジトリの外（node_modules、標準ライブラリ）の宣言は、どちらにも含めない。
   */
  references(decl: Declaration): References {
    return this.referencesIn(decl.file, [decl.node], decl);
  }

  /** 最上位の文（topLevel）など、宣言ではないノードの中の参照。 */
  referencesIn(relFile: string, nodes: Node[], self?: Declaration): References {
    // nodeは宣言をたどる名前、shownは未解決のときに示す式。
    const sites: { node: Node; shown: Node; call: boolean; construct?: boolean; inherit?: boolean }[] = [];
    const walk = (n: Node) => {
      if (n.kind === SyntaxKind.CallExpression || n.kind === SyntaxKind.NewExpression) {
        const e = (n as unknown as { expression: Node }).expression;
        sites.push({ node: e.kind === SyntaxKind.PropertyAccessExpression ? (e as unknown as { name: Node }).name : e, shown: e, call: true, construct: n.kind === SyntaxKind.NewExpression });
      } else if (n.kind === SyntaxKind.TypeReference) {
        const t = (n as unknown as { typeName: Node }).typeName;
        sites.push({ node: t, shown: t, call: false });
      } else if (n.kind === SyntaxKind.ExpressionWithTypeArguments) {
        const x = (n as unknown as { expression: Node }).expression;
        sites.push({ node: x, shown: x, call: false, inherit: true });
      }
      n.forEachChild(walk);
    };
    for (const node of nodes) {
      if (self) node.forEachChild(walk);
      else walk(node);
    }
    const targets = sites.map((s) => (s.node.kind === SyntaxKind.QualifiedName ? (s.node as unknown as { right: Node }).right : s.node));
    const symbols = targets.length > 0 ? this.checker.getSymbolAtLocation(targets) : [];
    const sf = this.sourceOf(relFile)!;
    const internal = new Set<string>();
    const uses = new Map<string, { to: string; kind: UseKind }>();
    const unresolved: string[] = [];
    symbols.forEach((sym, i) => {
      let s = sym;
      if (s && s.flags & SymbolFlags.Alias) s = this.checker.getAliasedSymbol(s);
      const handle = s?.declarations?.[0];
      if (!handle) {
        if (sites[i]!.call) {
          const at = sites[i]!.shown.getStart(sf);
          const text = sf.text.slice(at, sites[i]!.shown.end).replace(/\s+/g, " ");
          unresolved.push(`${relFile}:${sf.getLineAndCharacterOfPosition(at).line + 1} ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
        }
        return;
      }
      const abs = this.files.get(String(handle.path).toLowerCase());
      if (!abs) return;
      const node = handle.resolve();
      if (!node) return;
      let target = this.enclosing(this.rel(abs), node.pos + 1);
      if (!target || (self && (target.id === self.id || inside(target, self)))) return;
      if (target.node.kind === SyntaxKind.ClassDeclaration) {
        // クラスは大きいので、丸ごとは並べない。newならコンストラクター、型としての参照なら並べない。
        // 使うメソッドは、呼び出しから個別に並ぶ。
        if (!sites[i]!.construct) return;
        target = this.find(`${target.id}.constructor`);
        if (!target) return;
      }
      internal.add(target.id);
      const site = sites[i]!;
      const kind: UseKind = site.construct ? "new" : site.call ? "call" : site.inherit ? "inherit" : "type";
      uses.set(`${target.id}\n${kind}`, { to: target.id, kind });
    });
    // 出てきた順（同じ入力からは同じ順）。上限で省くときは、後に出てきたものから省く。
    return { internal: [...internal], uses: [...uses.values()], unresolved: [...new Set(unresolved)] };
  }

  /**
   * ノードの中の`prepare(...)`・`exec(...)`の引数のSQL（ADR-0026）。文字列として読めるSQLらしいものは`statements`、
   * `prepare`の引数が文字列として読めないものは`dynamic`（`file:line 式`）に入れる。
   */
  sqlIn(relFile: string, nodes: Node[]): { statements: string[]; dynamic: string[] } {
    const statements: string[] = [];
    const dynamic: string[] = [];
    const sf = this.sourceOf(relFile);
    const walk = (n: Node) => {
      if (n.kind === SyntaxKind.CallExpression) {
        const c = n as unknown as { expression: Node; arguments: Node[] };
        const name = c.expression.kind === SyntaxKind.PropertyAccessExpression ? (c.expression as unknown as { name: { text: string } }).name.text : undefined;
        const arg = c.arguments[0];
        if ((name === "prepare" || name === "exec") && arg) {
          const text = stringOf(arg);
          if (text !== undefined) { if (looksLikeSql(text)) statements.push(text); }
          else if (name === "prepare" && sf) {
            const at = arg.getStart(sf);
            const shown = sf.text.slice(at, arg.end).replace(/\s+/g, " ");
            dynamic.push(`${relFile}:${sf.getLineAndCharacterOfPosition(at).line + 1} 動的なSQL ${shown.length > 60 ? `${shown.slice(0, 60)}…` : shown}`);
          }
        }
      }
      n.forEachChild(walk);
    };
    for (const node of nodes) walk(node);
    return { statements, dynamic };
  }

  /**
   * ノードの中で使っている、importした名前と、リポジトリの外の名前（ADR-0022）。
   * importかどうかは型の解決でたどり、同じ名前の別の変数とは区別する。
   */
  uses(nodes: Node[]): Uses {
    const roots: { id: Node; chain: string[] }[] = [];
    const imports: { module: string; name: string }[] = [];
    const walk = (n: Node) => {
      if (n.kind === SyntaxKind.CallExpression) {
        const c = n as unknown as { expression: Node; arguments: Node[] };
        const arg = c.arguments[0];
        if (c.expression.kind === SyntaxKind.ImportKeyword && arg && stringOf(arg) !== undefined) imports.push({ module: stringOf(arg)!, name: "*" });
      }
      if (n.kind === SyntaxKind.Identifier || n.kind === SyntaxKind.PropertyAccessExpression || n.kind === SyntaxKind.ElementAccessExpression || n.kind === SyntaxKind.QualifiedName) {
        const c = chainOf(n);
        if (c) roots.push(c);
        // プロパティの名前（a.fetchのfetch）は、それだけでは名前の使用として数えない。
        if (n.kind === SyntaxKind.PropertyAccessExpression) { walk((n as unknown as { expression: Node }).expression); return; }
        if (n.kind === SyntaxKind.QualifiedName) { walk((n as unknown as { left: Node }).left); return; }
        if (n.kind === SyntaxKind.Identifier) return;
      }
      n.forEachChild(walk);
    };
    for (const node of nodes) walk(node);
    const ids = [...new Set(roots.map((r) => r.id))];
    const symbols = ids.length > 0 ? this.checker.getSymbolAtLocation(ids) : [];
    const symbolOf = new Map(ids.map((id, i) => [id, symbols[i]]));
    const globals = new Set<string>();
    // 同じ名前の位置からは、連なりの長さの違うもの（fs.readFileSyncとfs）が出る。importには最も長いものを使う。
    const longest = new Map<Node, number>();
    for (const r of roots) longest.set(r.id, Math.max(longest.get(r.id) ?? 0, r.chain.length));
    for (const r of roots) {
      const s = symbolOf.get(r.id);
      if (s && s.flags & SymbolFlags.Alias) {
        if (r.chain.length < longest.get(r.id)!) continue;
        const imp = importOf(s);
        if (imp) imports.push({ module: imp.module, name: imp.name ?? r.chain[1] ?? imp.whole });
        continue;
      }
      const handle = s?.declarations?.[0];
      // リポジトリの中で宣言された名前（ローカル変数、引数、自分の関数）は、外の名前ではない。
      if (handle && this.files.has(String(handle.path).toLowerCase())) continue;
      globals.add(r.chain.join("."));
    }
    const seen = new Set<string>();
    return {
      imports: imports.filter((i) => { const k = `${i.module}\0${i.name}`; if (seen.has(k)) return false; seen.add(k); return true; }),
      globals: [...globals],
    };
  }

  /** ファイルの行数。 */
  lineCount(relFile: string): number {
    return (this.sourceOf(relFile)?.text.split("\n").length) ?? 0;
  }

  /** ファイルの中身。プロジェクトにないファイルならundefined。 */
  text(relFile: string): string | undefined {
    return this.sourceOf(relFile)?.text;
  }

  private sourceOf(relFile: string): SourceFile | undefined {
    const abs = this.files.get(join(this.repo, relFile).toLowerCase());
    return abs ? this.project.program.getSourceFile(abs) : undefined;
  }
}

const DECLARATION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
]);
const MEMBER_KINDS = new Set<SyntaxKind>([
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);
/** 最上位の文のうち、コードとして扱わないもの（ADR-0022）。 */
const NOT_CODE = new Set<SyntaxKind>([
  SyntaxKind.ImportDeclaration,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.ExportDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EmptyStatement,
]);

function nameOf(n: Node): string | undefined {
  const name = (n as unknown as { name?: { kind: SyntaxKind; text?: string } }).name;
  return name && name.kind === SyntaxKind.Identifier ? name.text : undefined;
}

/** aがbの中にある（クラスの中のメソッドなど）。 */
function inside(a: Declaration, b: Declaration): boolean {
  return a.file === b.file && a.start >= b.start && a.end <= b.end;
}

/** 文字列のリテラルなら、その値。 */
function stringOf(n: Node): string | undefined {
  return n.kind === SyntaxKind.StringLiteral || n.kind === SyntaxKind.NoSubstitutionTemplateLiteral ? (n as unknown as { text: string }).text : undefined;
}

/** `a.b["c"]`の形なら、根の名前と連なり。そうでなければundefined。 */
function chainOf(n: Node): { id: Node; chain: string[] } | undefined {
  if (n.kind === SyntaxKind.Identifier) return { id: n, chain: [(n as unknown as { text: string }).text] };
  if (n.kind === SyntaxKind.PropertyAccessExpression) {
    const p = n as unknown as { expression: Node; name: Node };
    const inner = chainOf(p.expression);
    return inner && p.name.kind === SyntaxKind.Identifier ? { id: inner.id, chain: [...inner.chain, (p.name as unknown as { text: string }).text] } : inner;
  }
  if (n.kind === SyntaxKind.ElementAccessExpression) {
    const e = n as unknown as { expression: Node; argumentExpression: Node };
    const inner = chainOf(e.expression);
    const key = stringOf(e.argumentExpression);
    return inner && key !== undefined ? { id: inner.id, chain: [...inner.chain, key] } : inner;
  }
  if (n.kind === SyntaxKind.QualifiedName) {
    const q = n as unknown as { left: Node; right: Node };
    const inner = chainOf(q.left);
    return inner ? { id: inner.id, chain: [...inner.chain, (q.right as unknown as { text: string }).text] } : undefined;
  }
  return undefined;
}

/** importの宣言にたどれる名前なら、モジュールと元の名前。 */
function importOf(s: TsSymbol): { module: string; name?: string; whole: string } | undefined {
  const node = s.declarations?.[0]?.resolve();
  if (!node) return undefined;
  let name: string | undefined;
  let whole = "*";
  if (node.kind === SyntaxKind.ImportSpecifier) {
    const sp = node as unknown as { propertyName?: Node; name: Node };
    name = ((sp.propertyName ?? sp.name) as unknown as { text: string }).text;
  } else if (node.kind === SyntaxKind.ImportClause) {
    whole = "default";
  } else if (node.kind === SyntaxKind.ImportEqualsDeclaration) {
    const ref = (node as unknown as { moduleReference: Node }).moduleReference;
    const m = ref.kind === SyntaxKind.ExternalModuleReference ? stringOf((ref as unknown as { expression: Node }).expression) : undefined;
    return m === undefined ? undefined : { module: m, whole };
  } else if (node.kind !== SyntaxKind.NamespaceImport) {
    return undefined;
  }
  let p: Node | undefined = node;
  while (p && p.kind !== SyntaxKind.ImportDeclaration) p = p.parent;
  const m = p ? stringOf((p as unknown as { moduleSpecifier: Node }).moduleSpecifier) : undefined;
  return m === undefined ? undefined : { module: m, name, whole };
}
