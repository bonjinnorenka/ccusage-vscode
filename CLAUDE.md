# CCUsage VSCode Extension - プロジェクトメモリ

## プロジェクト概要

このプロジェクトは、ccusageライブラリを使用してClaude Codeの5時間ブロック使用量とコストをVSCodeのステータスバーに表示するVSCode拡張機能です。

## 技術スタック

- **TypeScript**: 拡張機能の主要言語
- **VSCode Extension API**: ステータスバー操作とUI統合
- **ccusage**: [@ryoppippi](https://github.com/ryoppippi/ccusage)によるClaude Code使用量分析ライブラリ
- **Node.js**: ESM/CommonJSモジュール環境
- **GitHub Actions**: CI/CD自動化

## 重要な技術的決定事項

### TypeScript設定
- `moduleResolution: "node16"` と `module: "Node16"` を使用
- ccusageがESMパッケージのため、dynamic importを使用して統合
- VSCode Extension APIはCommonJS形式で使用

### ccusageライブラリ統合
- `loadSessionBlockData`関数で5時間セッションブロックデータを取得
- `getDefaultClaudePath()`でClaude Codeデータディレクトリを自動検出
- アクティブブロックとエンド時間によるフィルタリングで現在のセッションを特定

### エラーハンドリング
- Claude Codeデータが見つからない場合のフォールバック
- 権限エラー、ファイルアクセスエラーの適切な処理
- ステータスバーでのエラー表示（⚠️アイコン）

## ファイル構造

```
src/
├── extension.ts           # メインの拡張機能エントリーポイント
└── ccusage-service.ts     # ccusageライブラリとの統合サービス

.github/workflows/
├── ci.yml                 # CI/CDパイプライン
└── deploy.yml             # VS Code Marketplace自動デプロイ

配置ファイル:
├── package.json           # VSCode拡張機能の設定とメタデータ
├── tsconfig.json          # TypeScript設定
├── .vscodeignore          # パッケージング時の除外ファイル
└── README.md              # ユーザー向けドキュメント
```

## 開発コマンド

```bash
# 開発環境設定
npm install

# TypeScriptコンパイル
npm run compile

# ウォッチモード（開発時）
npm run watch

# 拡張機能パッケージ作成
npm run package

# VS Code Marketplace公開
npx vsce publish
```

## デプロイメント

### GitHub Actions設定
- **トリガー**: タグプッシュ時（`v*`パターン）または手動実行
- **必要シークレット**: `VSCE_PAT` (VS Code Marketplace Personal Access Token)
- **自動化フロー**: コンパイル → パッケージング → 公開 → GitHub Release作成

### リリースプロセス
1. `npm version patch|minor|major` でバージョンアップ
2. `git push origin --tags` でタグプッシュ
3. GitHub Actionsが自動実行

## 設定可能項目

- `ccusage.updateInterval`: 更新間隔（秒、デフォルト: 30）
- `ccusage.showCost`: コスト表示のオン/オフ（デフォルト: true）

## 表示形式

- **通常**: `⏱️ 3h 45m | 💰 $2.15`
- **時間のみ**: `⏱️ 3h 45m`
- **エラー**: `⚠️ CCUsage Error`

## トラブルシューティング情報

### よくある問題
1. **データが表示されない**: Claude Codeの使用データが存在しない、または`~/.claude`へのアクセス権限がない
2. **ESMモジュールエラー**: dynamic importを使用しているため、TypeScript設定が重要
3. **更新されない**: タイマー設定やVSCodeの再起動で解決することが多い

## 依存関係について

- **ccusage**: Claude Code使用量分析のコア機能を提供
- **@types/vscode**: VSCode Extension API型定義
- **@vscode/vsce**: 拡張機能パッケージング・公開ツール

## 今後の拡張可能性

- クリック時の詳細情報表示
- 使用量グラフの表示
- 通知機能（制限近づき時など）
- 複数プロジェクトサポート
- カスタマイズ可能な表示フォーマット