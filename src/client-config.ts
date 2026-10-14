// Codex向けの登録（ADR-0047）。既存の設定とコメントはそのまま残す。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

export const CODEX_MCP = '[mcp_servers.inloop]\ncommand = "inloop"\nargs = ["mcp", "--ui", "browser"]\n';

/** 書く前にTOMLを検証する。既存のinloop登録は利用者の設定として維持する。 */
export function planCodexConfig(repo: string): { file: string; content?: string; preserved: boolean } {
  const file = join(repo, ".codex", "config.toml");
  const source = existsSync(file) ? readFileSync(file, "utf8") : "";
  try {
    const config = parse(source, { integersAsBigInt: "asNeeded" });
    const servers = config.mcp_servers;
    if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
      throw new Error("mcp_servers はテーブルで指定する");
    }
    if (servers && Object.hasOwn(servers, "inloop")) return { file, preserved: true };
    const content = source + (source ? (source.endsWith("\n") ? "\n" : "\n\n") : "") + CODEX_MCP;
    // インラインテーブルなど、追記できない形式も、既存ファイルに書く前に拒否する。
    parse(content, { integersAsBigInt: "asNeeded" });
    return { file, content, preserved: false };
  } catch {
    // パーサーのエラーには設定本文が入ることがあるので出さない。
    throw new Error(".codex/config.toml に inloop を追加できません。TOMLの構文と mcp_servers の形式を確認してください（既存ファイルは変更していません）");
  }
}
