# CCUsage Monitor for VSCode

VSCodeのステータスバーでClaude Codeの5時間ブロック使用量とコストをリアルタイムで監視する拡張機能です。

## 機能

- 📊 **リアルタイム監視**: 現在の5時間ブロックの残り時間と消費金額を表示
- 🔄 **自動更新**: 30秒間隔で最新の使用状況に更新
- ⚙️ **カスタマイズ可能**: 更新間隔とコスト表示のオン/オフを設定可能
- 🎯 **ステータスバー統合**: VSCodeの右下に常時表示

## インストール

### VS Code Marketplace

1. VSCodeの拡張機能タブを開く
2. "Bonjinnorenka CCUsage Monitor"を検索
3. インストールボタンをクリック

または、コマンドラインから：
```bash
code --install-extension bonjinnorenka.bonjinnorenka-ccusage-vscode
```

## 設定

拡張機能の設定は`settings.json`または設定画面から変更できます：

```json
{
  "ccusage.updateInterval": 30,
  "ccusage.showCost": true
}
```

### 設定項目

- `ccusage.updateInterval`: 更新間隔（秒）- デフォルト: 30秒
- `ccusage.showCost`: コスト表示のオン/オフ - デフォルト: true

## 表示内容

ステータスバーには以下の形式で表示されます：

- **フル表示**: `⏱️ 3h 45m | 💰 $2.15`
- **時間のみ**: `⏱️ 3h 45m`（`showCost: false`の場合）
- **エラー時**: `⚠️ CCUsage Error`

ホバーすると詳細情報（残り時間、コスト、トークン数）が表示されます。

## 前提条件

- Claude Codeが正常にインストールされ、使用データが保存されていること
- Node.js環境でccusageライブラリが利用可能であること

## トラブルシューティング

### 「CCUsage Error」が表示される場合

1. Claude Codeが正しくインストールされているか確認
2. `~/.claude`ディレクトリにアクセス権限があるか確認
3. 最近Claude Codeを使用したか確認（データが存在しない場合もエラーになります）

### データが更新されない場合

- 設定で`updateInterval`を短く設定してみてください
- VSCodeを再起動してみてください

## 依存関係

この拡張機能は [ccusage](https://github.com/ryoppippi/ccusage) ライブラリを使用しています。ccusageは@ryopippiによって開発されたClaude Code使用量分析ツールです。

## ライセンス

ISC License

## デプロイメント

この拡張機能はGitHub Actionsを使用して自動デプロイされます。

### リリース手順

1. バージョンを更新: `npm version patch|minor|major`
2. タグをプッシュ: `git push origin --tags`
3. GitHub Actionsが自動的にVS Code Marketplaceに公開します

### 必要なシークレット

GitHubリポジトリに以下のシークレットを設定してください：

- `VSCE_PAT`: Visual Studio Code Marketplace Personal Access Token

## 貢献

バグ報告や機能要望は[Issues](https://github.com/bonjinnorenka/ccusage-vscode/issues)にお願いします。

## 関連プロジェクト

- [ccusage](https://github.com/ryoppippi/ccusage) - Claude Code使用量分析CLI
- [Claude Code](https://claude.ai/code) - Anthropic Claude Code

---

**注意**: この拡張機能はClaude Codeの公式拡張機能ではありません。