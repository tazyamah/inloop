# ADR-0037: 主なクライアントをClaude Code（デスクトップ）にする

- 状態: Accepted
- 日付: 2026-10-12
- Supersedes: ADR-0006

## 背景

ADR-0006は、2026-10-10の確認で往復の全項目を満たしたClaude Desktopの通常の会話を、当面の主なクライアントにした。その後、Claude Code（デスクトップクライアント）でも、ブラウザで開く経路（ADR-0012）、信頼境界ルール、依存の図、再依頼の畳み、行クリックの位置の挿入（ADR-0032、ADR-0035）を実際の依頼で確認できた（[implementation-log](../implementation-log.md)）。利用者は、日々の開発をClaude Codeで行っており、Claude Desktopや他のクライアントの対応は後でよいとした（2026-10-12）。

## 決定

- 当面の開発と検証は、Claude Code（デスクトップクライアント）を主なクライアントとし、構成は「macOS＋Claude Code＋SQLite」とする。
- ほかのクライアント（Claude Desktop、Claude Code CLI、Codex、VS Code）、他のミドルウェア（DBなど）、他のOSの対応は、この構成でwebアプリとデスクトップアプリを楽に作れるようになってから進める。
- Claude Desktopで確認済みの経路（MCP Appsの埋め込みなど）は壊さずに保つ。設計は、後から他の選択肢を足せるようにし、この構成に固定しない。
- ADR-0006のうち、MCP Appsを表示できないクライアント向けの代替経路を維持することは、そのまま続ける。

## 理由

- 利用者が実際に使っているクライアントで確かめるのが、確認の価値が最も高い。
- 主なクライアントを1つに絞ると、確認と調整の範囲が小さくなる。

## 影響

- UIの確認の基準が、Claude Desktopでの手動確認から、Claude Codeでの確認に移る。Claude Desktopでの再確認は、後回しにした分だけ古くなりうる。
- [handoff](../handoff.md)の次の一手は、Claude Codeで完結する作業を先にする。

## 却下した代替案

- Claude Desktopを主なまま、Claude Codeを補助にする: 利用者の実際の使い方と合わない。

## 検証

- [implementation-log](../implementation-log.md)の「人の確認の途中結果」（Claude Code、`inloop-demo`）。
