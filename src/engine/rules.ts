// 信頼境界ルール（ADR-0020）。リポジトリ直下のinloop.jsonに書き、commitする。
import { z } from "zod";

/** inloopの設定ファイル。リポジトリ直下に置く。 */
export const CONFIG_FILE = "inloop.json";
/** 設定ファイルの形式の版。 */
export const CONFIG_FORMAT = 1;
/** 設定ファイルそのものを変えたときに当たる、組み込みのルール。inloop.jsonでは使えない。 */
export const CONFIG_RULE = "inloop-config";
export const CONFIG_QUESTION = "inloopの設定（inloop.json）の変更。信頼境界ルールを消したり弱めたりしていないか、基点の内容と比べて確かめる";

const patterns = z.array(z.string().min(1).max(300)).min(1);

/** 当て方。1つの項目に1種類だけを書く。 */
const matcherSchema = z.union([
  z.strictObject({ import: z.string().min(1).max(200), names: z.array(z.string().min(1).max(100)).min(1).optional() }),
  z.strictObject({ global: z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/) }),
  z.strictObject({ files: patterns }),
  z.strictObject({ symbols: patterns }),
]);

const ruleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  question: z.string().trim().min(1).max(500),
  match: z.array(matcherSchema).min(1),
});

const configSchema = z.strictObject({
  format: z.literal(CONFIG_FORMAT),
  boundaries: z.array(ruleSchema),
});

export type Matcher = z.infer<typeof matcherSchema>;
export type Rule = z.infer<typeof ruleSchema>;

/**
 * inloop.jsonを読む。形が合わない、知らない項目がある、idが重なる、組み込みのidを使う、のどれかなら拒否する。
 * 綴りを誤ったルールが黙って効かなくなるのを防ぐため、推測で読み飛ばさない。
 */
export function parseConfig(text: string, where: string): Rule[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${where}: JSONとして読めない`);
  }
  const r = configSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue?.path.join(".");
    throw new Error(`${where}: 形が不正${path ? `（${path}）` : ""}${issue?.message ? `: ${issue.message}` : ""}`);
  }
  const seen = new Set<string>();
  for (const rule of r.data.boundaries) {
    if (rule.id === CONFIG_RULE) throw new Error(`${where}: ${CONFIG_RULE} は組み込みのルールのidで、使えない`);
    if (seen.has(rule.id)) throw new Error(`${where}: ルールのidが重なっている ${rule.id}`);
    seen.add(rule.id);
  }
  return r.data.boundaries;
}

/**
 * 範囲の基点と作業ツリーのルールの和（ADR-0020）。同じidなら当て方を合わせ、問いは先に渡したほう（基点）を使う。
 * AIがルールを消したり弱めたりしても、その範囲では消す前のルールも働く。idの順に並べる。
 */
export function mergeRules(...lists: Rule[][]): Rule[] {
  const byId = new Map<string, Rule>();
  for (const list of lists) {
    for (const r of list) {
      const prev = byId.get(r.id);
      byId.set(r.id, prev ? { id: r.id, question: prev.question, match: [...prev.match, ...r.match] } : r);
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `*`は`/`を含まない任意の文字列、`**`は任意の文字列（`**\/`は0個以上のディレクトリ）。 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((p) => globToRegExp(p).test(value));
}

/** `node:fs`と`fs`を同じとみなす。 */
export function sameModule(a: string, b: string): boolean {
  return a.replace(/^node:/, "") === b.replace(/^node:/, "");
}
