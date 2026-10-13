# 方向性はあるが未決のこと

決めたらADR（[一覧](decisions/README.md)）にして、ここから消してください。現在地は[handoff.md](handoff.md)にあります。

- 解析エンジンの重い処理を、将来Rust製モジュールへ差し替える可能性。
- TypeScriptの型解決にGo版コンパイラ（TypeScript 7）を使えるか。外部から呼び出すAPIの状況は未確認。
- 手元のアプリで同梱するHonoの実行ファイルの作り方（Bun、Deno、Node.jsの単一実行ファイル）と、Tauriからの起動・終了（ADR-0011）。
- 対象のパスを依頼票とUIにどこまで見せるか（ADR-0010）。
- レイヤー間の依存の向きの検査（ADR-0023）。信頼境界ルールの当て方を特定のファイルに絞る指定。
- [docs/review-protocol.md](../docs/review-protocol.md)の未決事項（レビュー予算の単位、差分だけの再依頼、承認後の変更の検出（必須の依頼以外）、記録の整理）。
