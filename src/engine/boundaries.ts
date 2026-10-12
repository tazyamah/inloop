// 信頼境界ルールを、範囲の変更に当てる（ADR-0001、ADR-0022）。同じコード・範囲・ルールからは、同じ結果になる。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { changedFiles, changedLines, fileAtBase } from "./diff.js";
import type { TsProject } from "./project.js";
import { type Config, CONFIG_FILE, CONFIG_QUESTION, CONFIG_RULE, type EvidenceSpec, type Layer, matchesAny, mergeRules, parseFullConfig, type Rule, sameModule, versionLess } from "./rules.js";

/** ルールに当たった単位。必須の依頼は、この単位ごとに1件作る。 */
export interface BoundaryHit {
  /**
   * シンボルID。TypeScriptの宣言は`パス#名前`、ファイルの最上位の文とTypeScript以外のファイルはパスだけ。
   */
  symbol: string;
  /** 当たったルールのid（idの順） */
  rules: string[];
  /** 当たったルールの問いを、ルールのidの順に改行でつないだもの。必須の依頼の観点になる。 */
  question: string;
  /**
   * 判定したときの、その単位のコード（依頼票の、そのシンボルの`code`と同じもの）。
   * 承認したときのコードと比べて、承認後の変更を検出する。消したファイルは空。
   */
  code: string;
}

/** 今のinloopの版（package.json）。 */
export function inloopVersion(): string {
  const file = fileURLToPath(new URL("../../package.json", import.meta.url));
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

/**
 * 範囲の基点と作業ツリーのinloop.jsonを読む（ADR-0022、ADR-0023）。ルールは和、レイヤーは作業ツリーのもの（なければ基点のもの）。
 * どちらも形が合わない、または`minVersion`が今のinloopより新しければ拒否する。
 */
export function loadConfig(repo: string, base: string): { rules: Rule[]; layers: Layer[]; evidence: EvidenceSpec[] } {
  const atBase = fileAtBase(repo, base, CONFIG_FILE);
  const current = join(repo, CONFIG_FILE);
  const configs: Config[] = [];
  const fromBase = atBase === undefined ? undefined : parseFullConfig(atBase.toString("utf8"), `${base}:${CONFIG_FILE}`);
  const fromTree = existsSync(current) ? parseFullConfig(readFileSync(current, "utf8"), CONFIG_FILE) : undefined;
  if (fromBase) configs.push(fromBase);
  if (fromTree) configs.push(fromTree);
  const have = inloopVersion();
  for (const c of configs) {
    if (c.minVersion && versionLess(have, c.minVersion)) throw new Error(`${CONFIG_FILE}: inloop ${c.minVersion} 以上が必要（今は ${have}）。inloop update で更新する`);
  }
  return { rules: mergeRules(fromBase?.rules ?? [], fromTree?.rules ?? []), layers: (fromTree ?? fromBase)?.layers ?? [], evidence: (fromTree ?? fromBase)?.evidence ?? [] };
}

/** 範囲の基点と作業ツリーのinloop.jsonを読み、ルールの和を返す。 */
export function loadRules(repo: string, base: string): Rule[] {
  return loadConfig(repo, base).rules;
}

/** ファイルの中身を依頼票のコードの形にする（末尾の改行を1つ除く）。読めなければundefined。 */
export function fileCode(content: Buffer): string {
  if (content.includes(0)) return "（バイナリのファイル）";
  const text = content.toString("utf8");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * 範囲の基点から作業ツリーまでの変更に、ルールを当てる（ADR-0022）。
 * TypeScriptのファイルは宣言ごと（内側の宣言に含まれない変わった行を持つもの）に`import`・`global`・`symbols`で判定し、
 * `files`に当たったファイルと、最上位の文が変わってルールに当たったファイルは、ファイル全体を1つの単位にする。
 * TypeScript以外のファイルと消したファイルは、ファイルを1つの単位として`files`の当て方だけで判定する。
 * inloop.jsonの変更には、組み込みのルール`inloop-config`が当たる。消したコード（宣言の削除）は判定しない。
 */
export function evaluate(project: TsProject, repo: string, base: string, rules: Rule[]): BoundaryHit[] {
  const questions = new Map(rules.map((r) => [r.id, r.question]));
  questions.set(CONFIG_RULE, CONFIG_QUESTION);
  const hits: BoundaryHit[] = [];
  const hit = (symbol: string, ids: string[], code: string) => {
    if (ids.length === 0) return;
    const sorted = [...new Set(ids)].sort();
    hits.push({ symbol, rules: sorted, question: sorted.map((id) => questions.get(id)!).join("\n"), code });
  };
  const byFiles = (path: string) => rules.filter((r) => r.match.some((m) => "files" in m && matchesAny(m.files, path))).map((r) => r.id);

  for (const { path, deleted } of changedFiles(repo, base)) {
    if (path === CONFIG_FILE) {
      const abs = join(repo, path);
      hit(path, [CONFIG_RULE, ...byFiles(path)], deleted || !existsSync(abs) ? "" : fileCode(readFileSync(abs)));
      continue;
    }
    if (deleted) {
      hit(path, byFiles(path), "");
      continue;
    }
    if (!project.has(path)) {
      const abs = join(repo, path);
      if (existsSync(abs)) hit(path, byFiles(path), fileCode(readFileSync(abs)));
      continue;
    }
    const texts = (project.text(path) ?? "").split("\n");
    // 空の行は数えない（新しいファイルの末尾、宣言の間の行など）。
    const changed = [...changedLines(repo, base, path, project.lineCount(path))].filter((l) => texts[l - 1]?.trim());
    if (changed.length === 0) continue;
    const decls = project.declarationsOf(path);
    for (const d of decls) {
      // 内側の宣言（クラスのメソッドなど）に含まれない、変わった行があるものを単位にする。
      const inner = decls.filter((x) => x !== d && x.start >= d.start && x.end <= d.end);
      if (!changed.some((l) => l >= d.startLine && l <= d.endLine && !inner.some((x) => l >= x.startLine && l <= x.endLine))) continue;
      hit(d.id, matched(rules, d.id, project.references(d).internal, project.uses([d.node])), d.code);
    }
    // ファイルが`files`に当たるか、最上位の文が変わってルールに当たれば、ファイル全体を1つの単位にする。
    const top = project.topLevel(path);
    const topRules = changed.some((l) => top.lines.has(l)) ? matched(rules, path, project.referencesIn(path, top.nodes).internal, project.uses(top.nodes)) : [];
    hit(path, [...byFiles(path), ...topRules], fileCode(Buffer.from(project.text(path) ?? "")));
  }
  return hits;
}

/** 宣言・最上位の文に当たるルールのid。`files`の当て方は、ファイル全体の単位で判定する。 */
function matched(rules: Rule[], symbol: string, refs: string[], uses: ReturnType<TsProject["uses"]>): string[] {
  return rules.filter((r) => r.match.some((m) => {
    if ("files" in m) return false;
    if ("symbols" in m) return matchesAny(m.symbols, symbol) || refs.some((id) => matchesAny(m.symbols, id));
    if ("global" in m) return uses.globals.includes(m.global);
    // 名前空間・既定のimportをそのまま使った場合（`*`・`default`）は、どの名前を使うか決まらないので当てる。
    return uses.imports.some((i) => sameModule(i.module, m.import) && (!m.names || i.name === "*" || i.name === "default" || m.names.includes(i.name)));
  })).map((r) => r.id);
}
