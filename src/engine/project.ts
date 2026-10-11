// TypeScriptの解析（ADR-0015）。TypeScript 7の`typescript/unstable/sync`を使う部分は、このファイルに閉じ込める。
// APIは不安定とされているので、版を固定し、差し替えるときはこのファイルだけを直す。
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import type { Node, SourceFile } from "typescript/unstable/ast";
import { API, SymbolFlags } from "typescript/unstable/sync";
import type { Checker, Project } from "typescript/unstable/sync";

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

/** 呼び出しや型の参照のうち、宣言までたどれたもの・たどれなかったもの。 */
export interface References {
  /** 同じリポジトリの宣言のID（自分自身は含まない） */
  internal: string[];
  /** 解決できなかった呼び出し（`file:line 式`） */
  unresolved: string[];
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

  /** リポジトリのファイルの宣言の一覧。トップレベルの宣言と、クラスのメンバー。 */
  declarationsOf(relFile: string): Declaration[] {
    const cached = this.declarations.get(relFile);
    if (cached) return cached;
    const abs = this.files.get(join(this.repo, relFile).toLowerCase());
    const sf = abs ? this.project.program.getSourceFile(abs) : undefined;
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

  /** シンボルIDから宣言を探す。なければundefined。 */
  find(id: string): Declaration | undefined {
    const i = id.indexOf("#");
    if (i <= 0) return undefined;
    return this.declarationsOf(id.slice(0, i)).find((d) => d.id === id);
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
    // nodeは宣言をたどる名前、shownは未解決のときに示す式。
    const sites: { node: Node; shown: Node; call: boolean; construct?: boolean }[] = [];
    const walk = (n: Node) => {
      if (n.kind === SyntaxKind.CallExpression || n.kind === SyntaxKind.NewExpression) {
        const e = (n as unknown as { expression: Node }).expression;
        sites.push({ node: e.kind === SyntaxKind.PropertyAccessExpression ? (e as unknown as { name: Node }).name : e, shown: e, call: true, construct: n.kind === SyntaxKind.NewExpression });
      } else if (n.kind === SyntaxKind.TypeReference) {
        const t = (n as unknown as { typeName: Node }).typeName;
        sites.push({ node: t, shown: t, call: false });
      } else if (n.kind === SyntaxKind.ExpressionWithTypeArguments) {
        const x = (n as unknown as { expression: Node }).expression;
        sites.push({ node: x, shown: x, call: false });
      }
      n.forEachChild(walk);
    };
    decl.node.forEachChild(walk);
    const targets = sites.map((s) => (s.node.kind === SyntaxKind.QualifiedName ? (s.node as unknown as { right: Node }).right : s.node));
    const symbols = targets.length > 0 ? this.checker.getSymbolAtLocation(targets) : [];
    const sf = this.sourceOf(decl.file)!;
    const internal = new Set<string>();
    const unresolved: string[] = [];
    symbols.forEach((sym, i) => {
      let s = sym;
      if (s && s.flags & SymbolFlags.Alias) s = this.checker.getAliasedSymbol(s);
      const handle = s?.declarations?.[0];
      if (!handle) {
        if (sites[i]!.call) {
          const at = sites[i]!.shown.getStart(sf);
          const text = sf.text.slice(at, sites[i]!.shown.end).replace(/\s+/g, " ");
          unresolved.push(`${decl.file}:${sf.getLineAndCharacterOfPosition(at).line + 1} ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
        }
        return;
      }
      const abs = this.files.get(String(handle.path).toLowerCase());
      if (!abs) return;
      const node = handle.resolve();
      if (!node) return;
      let target = this.enclosing(this.rel(abs), node.pos + 1);
      if (!target || target.id === decl.id || inside(target, decl)) return;
      if (target.node.kind === SyntaxKind.ClassDeclaration) {
        // クラスは大きいので、丸ごとは並べない。newならコンストラクター、型としての参照なら並べない。
        // 使うメソッドは、呼び出しから個別に並ぶ。
        if (!sites[i]!.construct) return;
        target = this.find(`${target.id}.constructor`);
        if (!target) return;
      }
      internal.add(target.id);
    });
    // 出てきた順（同じ入力からは同じ順）。上限で省くときは、後に出てきたものから省く。
    return { internal: [...internal], unresolved: [...new Set(unresolved)] };
  }

  /** ファイルの行数。 */
  lineCount(relFile: string): number {
    return (this.sourceOf(relFile)?.text.split("\n").length) ?? 0;
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

function nameOf(n: Node): string | undefined {
  const name = (n as unknown as { name?: { kind: SyntaxKind; text?: string } }).name;
  return name && name.kind === SyntaxKind.Identifier ? name.text : undefined;
}

/** aがbの中にある（クラスの中のメソッドなど）。 */
function inside(a: Declaration, b: Declaration): boolean {
  return a.file === b.file && a.start >= b.start && a.end <= b.end;
}
