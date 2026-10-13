// セキュアコードの検査（ADR-0045）。IPAの注意喚起（2026-10-09）から導いた規則のうち、構文だけで決まるものを、
// 違反すると`inloop lint`・`inloop check`・雛形の`npm test`と`npm run build`が失敗する形で検査する。
// 型の解決はしない（importは同じファイルの宣言で追う）。同じコードからは、同じ結果になる。
import { execFileSync } from "node:child_process";
import { SyntaxKind } from "typescript/unstable/ast";
import type { Node, SourceFile } from "typescript/unstable/ast";
import { matchesAny, type SecureAllow } from "./rules.js";
import { TsProject } from "./project.js";
import { USECASE_RULES } from "./usecases.js";

/** 規則のid、IPAの文書のどの対策に当たるか、違反したときに何をするか。 */
export const SECURE_RULES: Record<string, { ipa: string; fix: string }> = {
  "sec-sql-literal": { ipa: "外部公開アプリケーション（外部入力の扱い）", fix: "SQLは固定の文字列にし、値は?のプレースホルダーで渡す" },
  "sec-shell": { ipa: "外部公開アプリケーション（外部入力の扱い）", fix: "exec/execSyncやshell:trueを使わず、execFile/spawnに引数の列で渡す" },
  "sec-eval": { ipa: "外部公開アプリケーション（外部入力の扱い）", fix: "eval、new Function、文字列のsetTimeoutを使わない" },
  "sec-html": { ipa: "外部公開アプリケーション（外部入力の扱い）", fix: "dangerouslySetInnerHTML、innerHTML、document.writeを使わず、テキストとして描く" },
  "sec-secret": { ipa: "認証機能の強化（認証情報の扱い）", fix: "秘密情報をコードに書かず、環境変数などから渡す" },
  "sec-crypto": { ipa: "データの暗号化", fix: "MD5・SHA-1・DES・ECB・createCipherを使わない。パスワードはcrypto.scryptで保存し、トークンはcrypto.randomBytesで作る" },
  "sec-tls": { ipa: "データの暗号化", fix: "証明書の検証を無効にしない" },
  "sec-cleartext": { ipa: "データの暗号化", fix: "外部との通信はhttps://・wss://にする" },
  "sec-bind": { ipa: "外部公開範囲の見直し", fix: "サーバーの待ち受けは127.0.0.1（loopback）に限る。公開するなら、inloop.jsonのsecure.allowに理由を書いて人に承認してもらう" },
  "sec-cors": { ipa: "外部公開範囲の見直し", fix: "CORSの許可元は、決まったオリジンの列にする（*にしない）" },
  "sec-cookie": { ipa: "認証機能の強化（セッションの扱い）", fix: "Cookieにはhttp-onlyとsameSiteを付ける" },
  "sec-log": { ipa: "ログの取得内容の見直し（秘密情報を出さない）", fix: "パスワード・トークン・環境変数の値を、ログに出さない" },
  "sec-stack": { ipa: "外部公開アプリケーション（内部情報を出さない）", fix: "スタックトレースを応答に載せず、ログにだけ出す" },
  "sec-unchecked": { ipa: "追加実装可能なセキュリティ対策（検査の網羅）", fix: "tsconfig.jsonのincludeに入れて、検査の対象にする" },
};

export interface SecureFinding {
  rule: string;
  /** リポジトリからのパス */
  file: string;
  line: number;
  message: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const SECRET_NAME = /(password|passwd|secret|api_?key|private_?key|access_?token|auth_?token|client_?secret|bearer)/i;
const SECRET_IDENT = /(password|passwd|secret|token|api_?key|private_?key|authorization|cookie)/i;
const SECRET_LITERAL = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
];
const WEAK_HASH = /^(md5|md4|sha-?1|ripemd160)$/i;
const WEAK_CIPHER = /(ecb|des|rc4|rc2|bf-|blowfish)/i;
const CLEARTEXT = /^(?:http|ws):\/\/([^/\s:?#]+|\[[^\]]+\])/i;
const CLEARTEXT_OK = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|\[::\]|0\.0\.0\.0|[^.]+\.localhost|(?:www\.)?w3\.org|json-schema\.org|schemas\.[a-z.]+|example\.(?:com|org|net)|.+\.example)$/i;

/** テストのファイルか。秘密情報らしい名前と平文のURLは、テストの値を許す。 */
export function isTestFile(file: string): boolean {
  return /(?:\.test\.|\.spec\.)[cm]?[jt]sx?$/.test(file) || /(?:^|\/)tests?\//.test(file);
}

interface Imp { module: string; name: string }

const strip = (m: string) => m.replace(/^node:/, "");

/** `x`・`(x)`・`x as T`・`x!`の中身。 */
function unwrap(n: Node): Node {
  let c = n;
  for (;;) {
    if (c.kind === SyntaxKind.ParenthesizedExpression || c.kind === SyntaxKind.AsExpression || c.kind === SyntaxKind.SatisfiesExpression || c.kind === SyntaxKind.NonNullExpression) c = (c as unknown as { expression: Node }).expression;
    else return c;
  }
}

function textOf(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  const u = unwrap(n);
  return u.kind === SyntaxKind.StringLiteral || u.kind === SyntaxKind.NoSubstitutionTemplateLiteral ? (u as unknown as { text: string }).text : undefined;
}

/** 固定の文字列（リテラル、置換のないテンプレート、それらの`+`）。 */
function isStatic(n: Node): boolean {
  const u = unwrap(n);
  if (textOf(u) !== undefined) return true;
  if (u.kind === SyntaxKind.BinaryExpression) {
    const b = u as unknown as { left: Node; right: Node; operatorToken: Node };
    return b.operatorToken.kind === SyntaxKind.PlusToken && isStatic(b.left) && isStatic(b.right);
  }
  return false;
}

function nameText(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  if (n.kind === SyntaxKind.Identifier || n.kind === SyntaxKind.StringLiteral || n.kind === SyntaxKind.NoSubstitutionTemplateLiteral || n.kind === SyntaxKind.PrivateIdentifier) return (n as unknown as { text: string }).text;
  return undefined;
}

/** オブジェクトリテラルのプロパティの値。`{ a }`は識別子`a`。なければundefined。 */
function prop(obj: Node | undefined, key: string): Node | undefined {
  if (!obj || unwrap(obj).kind !== SyntaxKind.ObjectLiteralExpression) return undefined;
  for (const p of (unwrap(obj) as unknown as { properties: Node[] }).properties) {
    const name = nameText((p as unknown as { name?: Node }).name);
    if (name !== key) continue;
    if (p.kind === SyntaxKind.PropertyAssignment) return (p as unknown as { initializer: Node }).initializer;
    if (p.kind === SyntaxKind.ShorthandPropertyAssignment) return (p as unknown as { name: Node }).name;
  }
  return undefined;
}

const isTrue = (n: Node | undefined) => !!n && unwrap(n).kind === SyntaxKind.TrueKeyword;
const isFalse = (n: Node | undefined) => !!n && unwrap(n).kind === SyntaxKind.FalseKeyword;

/** `a.b.c`の連なり（`a["b"]`を含む）。式でなければundefined。 */
function chain(n: Node): string[] | undefined {
  const u = unwrap(n);
  if (u.kind === SyntaxKind.Identifier) return [(u as unknown as { text: string }).text];
  if (u.kind === SyntaxKind.PropertyAccessExpression) {
    const p = u as unknown as { expression: Node; name: Node };
    const inner = chain(p.expression);
    return inner && [...inner, (p.name as unknown as { text: string }).text];
  }
  if (u.kind === SyntaxKind.ElementAccessExpression) {
    const e = u as unknown as { expression: Node; argumentExpression: Node };
    const inner = chain(e.expression);
    const key = textOf(e.argumentExpression);
    return inner && key !== undefined ? [...inner, key] : undefined;
  }
  return undefined;
}

/** 呼び出しの相手の最後の名前（`db.prepare`なら`prepare`、`exec`なら`exec`）と、そのimport元。 */
function calleeOf(call: Node, imports: Map<string, Imp>): { name: string; receiver?: string[]; imported?: Imp } {
  const c = chain((call as unknown as { expression: Node }).expression);
  if (!c) return { name: "" };
  if (c.length === 1) return { name: c[0]!, imported: imports.get(c[0]!) };
  const root = imports.get(c[0]!);
  const name = c[c.length - 1]!;
  // `cp.exec`のように、名前空間importの根からたどれる呼び出しは、importした名前として扱う。
  return { name, receiver: c.slice(0, -1), imported: root && root.name === "*" && c.length === 2 ? { module: root.module, name } : undefined };
}

function importsOf(sf: SourceFile): Map<string, Imp> {
  const out = new Map<string, Imp>();
  sf.forEachChild((n) => {
    if (n.kind !== SyntaxKind.ImportDeclaration) return;
    const d = n as unknown as { importClause?: { name?: Node; namedBindings?: Node }; moduleSpecifier: Node };
    const module = strip(textOf(d.moduleSpecifier) ?? "");
    const bind = d.importClause?.namedBindings;
    if (d.importClause?.name) out.set(nameText(d.importClause.name)!, { module, name: "default" });
    if (bind?.kind === SyntaxKind.NamespaceImport) out.set(nameText((bind as unknown as { name: Node }).name)!, { module, name: "*" });
    if (bind?.kind === SyntaxKind.NamedImports) {
      for (const s of (bind as unknown as { elements: Node[] }).elements) {
        const sp = s as unknown as { propertyName?: Node; name: Node };
        out.set(nameText(sp.name)!, { module, name: nameText(sp.propertyName ?? sp.name)! });
      }
    }
  });
  return out;
}

/** 1つのファイルの違反。 */
export function lintSource(file: string, sf: SourceFile): SecureFinding[] {
  const found: SecureFinding[] = [];
  const imports = importsOf(sf);
  const test = isTestFile(file);
  const add = (rule: string, n: Node, message: string) => {
    found.push({ rule, file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, message });
  };
  const ancestorNames = (n: Node): string => {
    const names: string[] = [];
    for (let p = n.parent; p; p = p.parent) {
      const nm = nameText((p as unknown as { name?: Node }).name);
      if (nm) names.push(nm);
    }
    return names.join(" ");
  };
  const isLoopback = (n: Node) => { const t = textOf(n); return t !== undefined && LOOPBACK.has(t); };

  const visit = (n: Node) => {
    switch (n.kind) {
      case SyntaxKind.CallExpression: {
        const call = n as unknown as { expression: Node; arguments: Node[] };
        const args = call.arguments;
        const { name, receiver, imported } = calleeOf(n, imports);
        const mod = imported?.module;
        const fn = imported?.name ?? name;
        const recvText = receiver?.join(".") ?? "";

        // SQLは固定の文字列。`exec`は正規表現にもあるので、dbらしい相手か、明らかな文字列の組み立てだけを見る。
        if ((name === "prepare" || name === "exec") && args[0] && receiver) {
          const a = unwrap(args[0]);
          const built = a.kind === SyntaxKind.TemplateExpression || (a.kind === SyntaxKind.BinaryExpression && !isStatic(a));
          const dbLike = /(?:^|\.)(?:db|database|sql|sqlite|conn|connection|client|tx)$/i.test(recvText);
          if (!isStatic(a) && (name === "prepare" || dbLike || built)) add("sec-sql-literal", n, `${recvText}.${name}に固定でない文字列を渡している（SQL文字列の組み立て）`);
        }
        // シェルを通す実行。
        if (mod === "child_process" && (fn === "exec" || fn === "execSync")) add("sec-shell", n, `child_process.${fn}はシェルを通す`);
        if (mod === "child_process" && /^(spawn|spawnSync|execFile|execFileSync|fork)$/.test(fn)) {
          const opts = args.slice(1).find((a) => unwrap(a).kind === SyntaxKind.ObjectLiteralExpression);
          const shell = prop(opts, "shell");
          if (shell && !isFalse(shell)) add("sec-shell", n, `child_process.${fn}にshellを指定している`);
        }
        // 評価。
        if (name === "eval" && !receiver) add("sec-eval", n, "eval");
        if (name === "Function" && !receiver) add("sec-eval", n, "Function(...)");
        if ((name === "setTimeout" || name === "setInterval") && args[0] && (textOf(args[0]) !== undefined || unwrap(args[0]).kind === SyntaxKind.TemplateExpression)) add("sec-eval", n, `${name}に文字列を渡している`);
        // HTMLの直接の書き込み。
        if (name === "insertAdjacentHTML" || (name === "write" || name === "writeln") && receiver?.join(".") === "document") add("sec-html", n, `${recvText ? `${recvText}.` : ""}${name}`);
        // 暗号。
        if (mod === "crypto" && fn === "createHash") {
          const alg = textOf(args[0]);
          if (alg !== undefined && WEAK_HASH.test(alg)) add("sec-crypto", n, `${alg}は弱いハッシュ`);
        }
        if (mod === "crypto" && (fn === "createCipher" || fn === "createDecipher")) add("sec-crypto", n, `${fn}は鍵と初期値を安全に作らない`);
        if (mod === "crypto" && (fn === "createCipheriv" || fn === "createDecipheriv")) {
          const alg = textOf(args[0]);
          if (alg !== undefined && WEAK_CIPHER.test(alg)) add("sec-crypto", n, `${alg}は弱い暗号方式`);
        }
        // パスワードをただのハッシュにかける。`createHash(...).update(password)`は呼び出しの連なりなので、相手の名前は別に読む。
        const target = unwrap(call.expression);
        if (target.kind === SyntaxKind.PropertyAccessExpression && (target as unknown as { name: { text: string } }).name.text === "update" && args[0]) {
          const inner = unwrap((target as unknown as { expression: Node }).expression);
          if (inner.kind === SyntaxKind.CallExpression && calleeOf(inner, imports).imported?.name === "createHash") {
            const c = chain(args[0]);
            if (c && /pass(word|wd)?/i.test(c[c.length - 1]!)) add("sec-crypto", n, "パスワードを、ただのハッシュにかけている（scryptなど、遅い方式にする）");
          }
        }
        // 予測できる乱数でトークンを作る。
        if (receiver?.join(".") === "Math" && name === "random" && /(token|secret|password|session|nonce|csrf|otp|api_?key)/i.test(ancestorNames(n))) add("sec-crypto", n, "Math.randomで秘密の値を作っている（crypto.randomBytesを使う）");
        // 待ち受け。
        if (imported?.module === "@hono/node-server" && imported.name === "serve") {
          const host = prop(args[0], "hostname");
          if (!host || !isLoopback(host)) add("sec-bind", n, "serveの待ち受けが127.0.0.1に限られていない（hostnameがない、またはloopbackでない）");
        } else if (name === "listen" && receiver) {
          if (!args.some(isLoopback)) add("sec-bind", n, `${recvText}.listenの待ち受けが127.0.0.1に限られていない`);
        }
        // CORS。
        if (name === "cors") {
          const origin = prop(args[0], "origin");
          if (!args[0] || !origin || textOf(origin) === "*" || isTrue(origin)) add("sec-cors", n, "CORSの許可元が*（すべて）");
        }
        if (name === "header" || name === "setHeader" || name === "set") {
          const key = textOf(args[0])?.toLowerCase();
          if (key === "access-control-allow-origin" && textOf(args[1]) === "*") add("sec-cors", n, "Access-Control-Allow-Originが*");
          if (key === "set-cookie" && args[1] && textOf(args[1]) !== undefined && !/httponly/i.test(textOf(args[1])!)) add("sec-cookie", n, "Set-CookieにHttpOnlyがない");
        }
        if (name === "setCookie") {
          const opts = [...args].reverse().find((a) => unwrap(a).kind === SyntaxKind.ObjectLiteralExpression);
          if (!isTrue(prop(opts, "httpOnly"))) add("sec-cookie", n, "setCookieにhttpOnly: trueがない");
          if (!prop(opts, "sameSite")) add("sec-cookie", n, "setCookieにsameSiteがない");
        }
        // ログに秘密情報。
        if (receiver?.join(".") === "console" || /(?:^|\.)(?:logger|log)$/i.test(recvText)) {
          const leak = (a: Node): string | undefined => {
            const c = chain(a);
            if (c) {
              if (c.join(".") === "process.env") return "process.env全体";
              if (c.slice(0, 2).join(".") === "process.env") return c.join(".");
              if (SECRET_IDENT.test(c[c.length - 1]!)) return c.join(".");
              return undefined;
            }
            const u = unwrap(a);
            if (u.kind === SyntaxKind.TemplateExpression) {
              for (const span of (u as unknown as { templateSpans: { expression: Node }[] }).templateSpans) { const r = leak(span.expression); if (r) return r; }
            }
            if (u.kind === SyntaxKind.ObjectLiteralExpression) {
              for (const p of (u as unknown as { properties: Node[] }).properties) {
                const v = p.kind === SyntaxKind.PropertyAssignment ? (p as unknown as { initializer: Node }).initializer : p.kind === SyntaxKind.ShorthandPropertyAssignment ? (p as unknown as { name: Node }).name : undefined;
                const r = v && leak(v);
                if (r) return r;
              }
            }
            return undefined;
          };
          for (const a of args) { const r = leak(a); if (r) { add("sec-log", n, `${r}をログに出している`); break; } }
        }
        // スタックトレースを応答に載せる。
        if (receiver && /^(json|text|html|body|send|end|write)$/.test(name)) {
          let hit: Node | undefined;
          const find = (x: Node) => {
            if (hit) return;
            if (x.kind === SyntaxKind.PropertyAccessExpression && (x as unknown as { name: { text: string } }).name.text === "stack") { hit = x; return; }
            x.forEachChild(find);
          };
          for (const a of args) find(a);
          if (hit) add("sec-stack", hit, "応答にスタックトレースを載せている");
        }
        break;
      }
      case SyntaxKind.NewExpression: {
        const ne = n as unknown as { expression: Node };
        if (chain(ne.expression)?.join(".") === "Function") add("sec-eval", n, "new Function");
        break;
      }
      case SyntaxKind.JsxAttribute: {
        if (nameText((n as unknown as { name: Node }).name) === "dangerouslySetInnerHTML") add("sec-html", n, "dangerouslySetInnerHTML");
        break;
      }
      case SyntaxKind.BinaryExpression: {
        const b = n as unknown as { left: Node; right: Node; operatorToken: Node };
        if (b.operatorToken.kind === SyntaxKind.EqualsToken) {
          const c = chain(b.left);
          const last = c?.[c.length - 1];
          if (last === "innerHTML" || last === "outerHTML") add("sec-html", n, `${c!.join(".")}への代入`);
          if (c?.join(".") === "process.env.NODE_TLS_REJECT_UNAUTHORIZED" && textOf(b.right) === "0") add("sec-tls", n, "NODE_TLS_REJECT_UNAUTHORIZEDを0にしている");
        }
        break;
      }
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.PropertyDeclaration: {
        const d = n as unknown as { name: Node; initializer?: Node };
        const name = nameText(d.name);
        const value = textOf(d.initializer);
        if ((name === "rejectUnauthorized" || name === "strictSSL") && isFalse(d.initializer)) add("sec-tls", n, `${name}: false`);
        if (name && value !== undefined && !test && SECRET_NAME.test(name) && value.length >= 8 && !/^[a-z][a-z\-_. /:]*$/.test(value)) add("sec-secret", n, `${name}に秘密情報らしい文字列を直接書いている`);
        break;
      }
      default:
    }
    // 文字列の中身: 秘密情報の形、平文の通信。
    if (n.kind === SyntaxKind.StringLiteral || n.kind === SyntaxKind.NoSubstitutionTemplateLiteral || n.kind === SyntaxKind.TemplateHead) {
      const t = (n as unknown as { text: string }).text;
      if (SECRET_LITERAL.some((r) => r.test(t))) add("sec-secret", n, "秘密情報の形をした文字列がある");
      const m = CLEARTEXT.exec(t);
      if (m && !test && !CLEARTEXT_OK.test(m[1]!)) add("sec-cleartext", n, `平文の通信 ${m[0]}`);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return found;
}

/** 一覧のうち、許可（inloop.jsonのsecure.allow）に当たるものを除く。 */
export function applyAllow(findings: SecureFinding[], allow: SecureAllow[]): SecureFinding[] {
  return findings.filter((f) => !allow.some((a) => a.rule === f.rule && matchesAny(a.files, f.file)));
}

/** リポジトリのTypeScriptのファイルを検査する。見つかった違反を、ファイル・行の順で返す。 */
export function lintRepo(repo: string, allow: SecureAllow[] = []): SecureFinding[] {
  const listed = execFileSync("git", ["-C", repo, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter((f) => f && !f.split("/").includes("node_modules"));
  // 直下のtsconfig.jsonに加えて、下の階層のtsconfig.json（relay/など）のプロジェクトも検査する。
  const configs = listed.filter((f) => f === "tsconfig.json" || f.endsWith("/tsconfig.json"));
  const found: SecureFinding[] = [];
  const checked = new Set<string>();
  for (const config of configs) {
    let project: TsProject;
    try {
      project = new TsProject(repo, config);
    } catch (e) {
      // 直下のtsconfig.jsonは読めなければ失敗にする。下の階層のものは、TypeScriptのプロジェクトでなければ（Tauriなど）読み飛ばす。
      if (config === "tsconfig.json") throw e;
      continue;
    }
    try {
      for (const file of project.repoFiles()) {
        if (checked.has(file)) continue;
        checked.add(file);
        const sf = project.syntax(file);
        if (sf && !/\.d\.[cm]?ts$/.test(file)) found.push(...lintSource(file, sf));
      }
    } finally {
      project.close();
    }
  }
  // どのtsconfig.jsonにも入っていないTypeScriptのファイルは検査できないので、違反として示す。
  for (const file of listed) {
    if (/\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file) && !checked.has(file)) {
      found.push({ rule: "sec-unchecked", file, line: 1, message: "tsconfig.jsonのincludeに入っておらず、検査できない" });
    }
  }
  const seen = new Set<string>();
  return applyAllow(found, allow)
    .filter((f) => { const k = `${f.rule}\0${f.file}\0${f.line}\0${f.message}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

/** 違反を1行ずつの文字列にする。 */
export function formatFinding(f: SecureFinding): string {
  return `${f.rule}\t${f.file}:${f.line}\t${f.message}\t→ ${(SECURE_RULES[f.rule] ?? USECASE_RULES[f.rule])?.fix ?? ""}`;
}
