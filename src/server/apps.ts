// アプリの登録簿（ADR-0013）。アプリ名と、そのリポジトリの絶対パスを、利用者ごとに1つのファイルで持つ。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { gitTopLevel } from "./target.js";

/** 画面のサーバーの既定のポート。電話のキーで「INLO」（ADR-0013）。 */
export const DEFAULT_PORT = 4656;
export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** inloopの利用者ごとの置き場所。`INLOOP_HOME`で変えられる（テスト用）。 */
export function inloopHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.INLOOP_HOME || join(homedir(), ".inloop");
}

/** 画面のサーバーのポート。`INLOOP_PORT`で変えられる。 */
export function uiPort(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.INLOOP_PORT;
  if (v === undefined || v === "") return DEFAULT_PORT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`INLOOP_PORT が不正（${v}）`);
  return n;
}

/** ディレクトリ名から、アプリ名の既定値を作る。 */
export function defaultName(dir: string): string {
  return basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

export class AppRegistry {
  readonly file: string;

  constructor(home = inloopHome()) {
    this.file = join(home, "apps.json");
  }

  /** 名前とリポジトリの対応。読むたびにファイルから取り直す（ほかのプロセスの登録を反映する）。 */
  list(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    const data = JSON.parse(readFileSync(this.file, "utf8")) as { apps?: Record<string, string> };
    return { ...(data.apps ?? {}) };
  }

  pathOf(name: string): string | undefined {
    return Object.hasOwn(this.list(), name) ? this.list()[name] : undefined;
  }

  nameOf(repo: string): string | undefined {
    return Object.entries(this.list()).find(([, p]) => p === repo)?.[0];
  }

  /**
   * リポジトリを登録する。名前を省略すれば、ディレクトリ名から作る。
   * 別のリポジトリが使っている名前は拒否する。同じリポジトリを別の名前で登録し直すと、古い名前は消える。
   */
  register(dir: string, name?: string): { name: string; repo: string } {
    const repo = gitTopLevel(dir);
    const n = name ?? defaultName(repo);
    if (!NAME_PATTERN.test(n)) throw new Error(`アプリ名「${n}」は使えない（英小文字・数字・-、先頭と末尾は英数字）。--name で指定する`);
    const apps = this.list();
    if (apps[n] !== undefined && apps[n] !== repo) throw new Error(`アプリ名「${n}」は ${apps[n]} が使っている。--name で別の名前を指定する`);
    for (const [k, p] of Object.entries(apps)) if (p === repo) delete apps[k];
    apps[n] = repo;
    mkdirSync(join(this.file, ".."), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ apps }, null, 2)}\n`);
    renameSync(tmp, this.file);
    return { name: n, repo };
  }
}

/** 依頼票に並べるコードの行数の既定の上限（ADR-0017）。R6（54行）を目安にした。 */
export const DEFAULT_MAX_REVIEW_LINES = 60;

/** 会話でAIに承認・保留を記録させる言葉の既定（ADR-0017）。 */
export const DEFAULT_APPROVE_PHRASE = "承認";
export const DEFAULT_HOLD_PHRASE = "保留";

export interface UserConfig {
  /** 依頼票に並べるコードの行数の上限 */
  maxReviewLines: number;
  /** 人が会話でこの言葉を言ったら、AIが承認を記録できる */
  approvePhrase: string;
  /** 人が会話でこの言葉を言ったら、AIが保留を記録できる */
  holdPhrase: string;
}

/** 利用者ごとの設定（`~/.inloop/config.json`）。読むたびにファイルから取り直す。 */
export function userConfig(home = inloopHome()): UserConfig {
  const file = join(home, "config.json");
  let data: { maxReviewLines?: unknown; approvePhrase?: unknown; holdPhrase?: unknown } = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8")) as typeof data;
    } catch {
      throw new Error(`${file}: JSONとして読めない`);
    }
  }
  const max = data.maxReviewLines ?? DEFAULT_MAX_REVIEW_LINES;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) throw new Error(`${file}: maxReviewLines は1以上の整数`);
  const phrase = (key: "approvePhrase" | "holdPhrase", fallback: string) => {
    const v = data[key] ?? fallback;
    if (typeof v !== "string" || v.trim() === "") throw new Error(`${file}: ${key} は空でない文字列`);
    return v.trim();
  };
  const approvePhrase = phrase("approvePhrase", DEFAULT_APPROVE_PHRASE);
  const holdPhrase = phrase("holdPhrase", DEFAULT_HOLD_PHRASE);
  if (approvePhrase === holdPhrase) throw new Error(`${file}: approvePhrase と holdPhrase が同じ`);
  return { maxReviewLines: max, approvePhrase, holdPhrase };
}
