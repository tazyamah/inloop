// 信頼境界ルールを、範囲の変更に当てる（ADR-0001、ADR-0022）。同じコード・範囲・ルールからは、同じ結果になる。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { changedFiles, changedLines, fileAtBase } from "./diff.js";
import type { Declaration, TsProject } from "./project.js";
import { type Config, type SecureAllow, CONFIG_FILE, CONFIG_QUESTION, columnsMatch, CONFIG_RULE, type EvidenceSpec, LAYER_RULE, type Layer, layerOf, matchesAny, mayUseLayer, mergeRules, parseFullConfig, type Rule, sameModule, tableMatches, versionLess } from "./rules.js";
import { INDIRECT_DEPTH, type TableUse, tablesOf } from "./sql.js";

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
export function loadConfig(repo: string, base: string): { rules: Rule[]; layers: Layer[]; layerSets: Layer[][]; evidence: EvidenceSpec[]; secure: SecureAllow[] } {
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
  // 向きの検査（ADR-0027）には基点と作業ツリーのレイヤーの両方を使い、どちらかに反すれば当てる（ルールの和と同じ考え方）。
  const layerSets = [fromBase?.layers, fromTree?.layers].filter((l): l is Layer[] => l !== undefined && l.length > 0);
  return { rules: mergeRules(fromBase?.rules ?? [], fromTree?.rules ?? []), layers: (fromTree ?? fromBase)?.layers ?? [], layerSets, evidence: (fromTree ?? fromBase)?.evidence ?? [], secure: (fromTree ?? fromBase)?.secure ?? [] };
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
export function evaluate(project: TsProject, repo: string, base: string, rules: Rule[], layerSets: Layer[][] = []): BoundaryHit[] {
  const questions = new Map(rules.map((r) => [r.id, r.question]));
  questions.set(CONFIG_RULE, CONFIG_QUESTION);
  const hits: BoundaryHit[] = [];
  // notesは、問いに足す説明（レイヤーの向きの違反、動的なSQLなど）。ルールの問いの後ろに付ける。
  const hit = (symbol: string, ids: string[], code: string, notes: string[] = []) => {
    if (ids.length === 0) return;
    const sorted = [...new Set(ids)].sort();
    hits.push({ symbol, rules: sorted, question: [...sorted.map((id) => questions.get(id) ?? LAYER_QUESTION), ...notes].join("\n"), code });
  };
  const needTables = rules.some((r) => r.match.some((m) => "table" in m));
  /** 宣言・最上位の文のコードと、それが直接使う宣言のコードのSQL（ADR-0028）。表のルールがなければ調べない。 */
  const sqlOf = (file: string, nodes: Declaration["node"][], internal: string[]): SqlUse => {
    if (!needTables) return { tables: [], dynamic: false };
    const tables: TableUse[] = [];
    let dynamic = false;
    const scan = (f: string, ns: Declaration["node"][]) => {
      const sql = project.sqlIn(f, ns);
      dynamic ||= sql.dynamic.length > 0;
      for (const st of sql.statements) tables.push(...tablesOf(st));
    };
    scan(file, nodes);
    for (const id of internal) {
      const d = project.find(id);
      if (!d) continue;
      scan(d.file, [d.node]);
      for (const r of project.reachByCalls(d, INDIRECT_DEPTH)) scan(r.decl.file, [r.decl.node]);
    }
    return { tables, dynamic };
  };
  /** レイヤーの向きに反する使い方（ADR-0027）。`使う側→使われる側`の列。 */
  const layerViolations = (file: string, internal: string[]): string[] => {
    const out = new Set<string>();
    for (const layers of layerSets) {
      const from = layerOf(layers, file);
      for (const id of internal) {
        const to = layerOf(layers, id.split("#")[0]!);
        if (!mayUseLayer(layers, from, to)) out.add(`${from}→${to}`);
      }
    }
    return [...out].sort();
  };
  const layerNote = (v: string[]) => (v.length ? [`レイヤーの向きに反する使い方: ${v.join(", ")}`] : []);
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
      const refs = project.references(d).internal;
      const sql = sqlOf(d.file, [d.node], refs);
      const notes: string[] = [];
      const violations = layerViolations(d.file, refs);
      hit(d.id, [...matched(rules, d.id, refs, project.uses([d.node]), sql, notes), ...(violations.length ? [LAYER_RULE] : [])], d.code, [...layerNote(violations), ...notes]);
    }
    // ファイルが`files`に当たるか、最上位の文が変わってルールに当たれば、ファイル全体を1つの単位にする。
    const top = project.topLevel(path);
    const topNotes: string[] = [];
    let topRules: string[] = [];
    if (changed.some((l) => top.lines.has(l))) {
      const refs = project.referencesIn(path, top.nodes).internal;
      const violations = layerViolations(path, refs);
      topRules = [...matched(rules, path, refs, project.uses(top.nodes), sqlOf(path, top.nodes, refs), topNotes), ...(violations.length ? [LAYER_RULE] : [])];
      topNotes.unshift(...layerNote(violations));
    }
    hit(path, [...byFiles(path), ...topRules], fileCode(Buffer.from(project.text(path) ?? "")), topNotes);
  }
  return hits;
}

const LAYER_QUESTION = "レイヤーの依存の向きは、inloop.jsonのlayersの決めたとおりか。違反なら、向きを直すか、設計を見直す";

/** 単位のコードと、直接使う宣言のコードが触るテーブル。dynamicは、テーブルを決められないSQLを含む。 */
interface SqlUse { tables: TableUse[]; dynamic: boolean }

/**
 * 宣言・最上位の文に当たるルールのid。`files`の当て方は、ファイル全体の単位で判定する。
 * `table`は、動的なSQLを含む単位にも当てる（触るテーブルを決められないので、見落とさない側に倒す）。そのときは`notes`に理由を足す。
 */
function matched(rules: Rule[], symbol: string, refs: string[], uses: ReturnType<TsProject["uses"]>, sql: SqlUse, notes: string[]): string[] {
  return rules.filter((r) => r.match.some((m) => {
    if ("files" in m) return false;
    if ("table" in m) {
      if (sql.tables.some((t) => tableMatches(m.table, t.table) && (!m.access || m.access.includes(t.access)) && columnsMatch(m.columns, t))) return true;
      if (sql.dynamic) {
        const note = `${r.id}: 動的なSQLを含み、触るテーブルを決められない（${m.table}に触れるか分からないので当てた）`;
        if (!notes.includes(note)) notes.push(note);
        return true;
      }
      return false;
    }
    if ("symbols" in m) return matchesAny(m.symbols, symbol) || refs.some((id) => matchesAny(m.symbols, id));
    if ("global" in m) return uses.globals.includes(m.global);
    // 名前空間・既定のimportをそのまま使った場合（`*`・`default`）は、どの名前を使うか決まらないので当てる。
    return uses.imports.some((i) => sameModule(i.module, m.import) && (!m.names || i.name === "*" || i.name === "default" || m.names.includes(i.name)));
  })).map((r) => r.id);
}
