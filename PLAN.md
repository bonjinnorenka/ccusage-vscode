# CCUsage VSCode拡張機能 作成プラン

## 概要
ccusageパッケージを利用して、VSCodeのステータスバーに5時間制限の残り時間と消費金額を表示する拡張機能を作成します。

## 実装内容

### 1. VSCode拡張機能の基本設定
- `package.json`をVSCode拡張機能として設定
- TypeScript設定ファイルの作成
- 必要な依存関係の追加（@types/vscode等）

### 2. 拡張機能の実装
- `src/extension.ts`でメインロジック実装
- ステータスバーアイテムの作成
- 30秒ごとの自動更新タイマー設定

### 3. ccusageパッケージの統合
- `loadSessionBlockData`で5時間ブロックのデータを読み込み
- `calculateTotals`でコストと使用量を計算
- 残り時間の計算ロジック実装

### 4. 表示機能
- ステータスバーに「残り時間: Xh Ym | コスト: $X.XX」形式で表示
- クリックでより詳細な情報を表示（オプション）

### 5. エラーハンドリング
- Claude Codeデータファイルが見つからない場合の処理
- 権限エラーの処理
- ネットワークエラーの処理

## 必要なファイル構造
```
src/
  extension.ts
  ccusage-service.ts
  types.ts
package.json
tsconfig.json
webpack.config.js (オプション)
```

## 技術要件
- TypeScript
- VSCode Extension API
- ccusage npm パッケージ
- 30秒間隔での自動更新