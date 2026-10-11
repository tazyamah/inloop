// 対象のリポジトリを決め、リポジトリごとの記録（ReviewStore）を持つ（ADR-0010）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackets } from "../engine/build.js";
import { LOG_FILE_NAME, ReviewStore } from "./store.js";

export interface TargetOptions {
  /** 起動時の`--repo`。そのプロセスの対象を1つに固定する。 */
  repo?: string;
  /** 起動時の`--allow`。指定があれば、対象はこのどれかの中に限る。 */
  allow?: string[];
  /** 起動時の`--state-dir`。記録先をここに固定する（互換）。 */
  stateFile?: string;
  /** 記録先を固定する記録そのもの（テストと互換のため）。stateFileより優先する。 */
  store?: ReviewStore;
  /** クライアントが知らせた作業フォルダ（roots）を取る。対応していなければundefinedを返す。 */
  roots?: () => Promise<string[] | undefined>;
}

/** 対象を決められない、または許されない場所を指している。 */
export class TargetError extends Error {}

function inside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r) && !r.startsWith(`..${sep}`));
}

/** gitの作業ツリーの最上位。作業ツリーの中でなければTargetError。 */
export function gitTopLevel(dir: string): string {
  let top: string;
  try {
    top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new TargetError(`${dir}: gitの作業ツリーではない`);
  }
  return realpathSync(top);
}

/** rootsのURI（file://...）またはパスを、実在する絶対パスにする。 */
function rootPath(uri: string): string | undefined {
  try {
    const p = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

export class Targets {
  private readonly stores = new Map<string, ReviewStore>();
  private readonly fixed: string | undefined;
  private readonly allow: string[];
  private readonly legacy: ReviewStore | undefined;

  private roots: (() => Promise<string[] | undefined>) | undefined;

  constructor(options: TargetOptions = {}) {
    this.roots = options.roots;
    this.fixed = options.repo ? gitTopLevel(resolve(options.repo)) : undefined;
    this.allow = (options.allow ?? []).map((d) => realpathSync(resolve(d)));
    if (this.fixed) this.check(this.fixed);
    this.legacy = options.store ?? (options.stateFile ? new ReviewStore({ file: options.stateFile }) : undefined);
  }

  /** クライアントの作業フォルダ（roots）の取り方。起動時に渡されていなければ、MCPサーバーが設定する。 */
  useRoots(fn: () => Promise<string[] | undefined>): void {
    this.roots ??= fn;
  }

  /** 起動時に固定した記録先（`--state-dir`）。 */
  get stateLocation(): string | undefined {
    return this.legacy?.location;
  }

  get fixedRepo(): string | undefined {
    return this.fixed;
  }

  private check(top: string): void {
    if (this.allow.length > 0 && !this.allow.some((a) => inside(top, a))) {
      throw new TargetError(`${top}: --allow の外`);
    }
  }

  /**
   * 対象を決めて、その記録を返す。決まらなければTargetError。推測では決めない。
   * 順序: `--repo`、AIの引数`repo`、ちょうど1つのroots。`--state-dir`があれば、決まらないときはそこを使う。
   */
  async resolve(repo: string | undefined): Promise<{ repo: string | undefined; store: ReviewStore }> {
    return this.open(await this.locate(repo));
  }

  /** 決めた対象の記録を開く。記録の置き場所は、ここで初めて作る。 */
  open(target: { repo: string | undefined }): { repo: string | undefined; store: ReviewStore } {
    if (this.legacy) return { repo: target.repo, store: this.legacy };
    return { repo: target.repo, store: this.storeOf(target.repo!) };
  }

  /** 対象を決める。記録の置き場所は作らない。 */
  async locate(repo: string | undefined): Promise<{ repo: string | undefined }> {
    const roots = await this.rootsList();
    let top: string | undefined;
    if (this.fixed) {
      if (repo !== undefined && this.normalize(repo) !== this.fixed) throw new TargetError(`${repo}: --repo と違う対象`);
      top = this.fixed;
    } else if (repo !== undefined) {
      top = this.normalize(repo);
    } else if (roots && roots.length === 1) {
      top = gitTopLevel(roots[0]!);
    }
    if (top === undefined) {
      if (this.legacy) return { repo: undefined };
      throw new TargetError(roots && roots.length > 1 ? "repo がない（作業フォルダが複数ある）" : "repo がない");
    }
    if (roots && roots.length > 0 && !roots.some((r) => inside(top!, r))) throw new TargetError(`${top}: 作業フォルダの外`);
    this.check(top);
    return { repo: top };
  }

  private normalize(repo: string): string {
    if (!isAbsolute(repo)) throw new TargetError(`${repo}: 絶対パスではない`);
    if (!existsSync(repo)) throw new TargetError(`${repo}: 存在しない`);
    return gitTopLevel(repo);
  }

  private async rootsList(): Promise<string[] | undefined> {
    const uris = await this.roots?.();
    if (!uris) return undefined;
    return uris.map(rootPath).filter((p): p is string => p !== undefined);
  }

  /** 対象の記録。`.inloop/`を作るときは、中に自分用の`.gitignore`を置く。 */
  private storeOf(top: string): ReviewStore {
    let store = this.stores.get(top);
    if (!store) {
      const dir = join(top, ".inloop");
      mkdirSync(dir, { recursive: true });
      const ignore = join(dir, ".gitignore");
      if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
      // 依頼票は、このリポジトリのコードから解析エンジンで作る（ADR-0015）。
      store = new ReviewStore({ file: join(dir, LOG_FILE_NAME), build: (reviews, range) => buildPackets(top, reviews, range) });
      this.stores.set(top, store);
    }
    return store;
  }
}
