# claude-review-bot

Claude APIでPull Requestをレビューし、行単位のコメントとして投稿するGitHub Appです。

- PRに`/review`とコメントするとレビューします(自動レビューは既定でOFF)
- 指摘は重要度(critical / major / minor / nit)付きのインラインコメント。総評はレビュー本文
- レビューは常に`COMMENT`。ApproveやRequest changesはしません
- lockfileや生成物は除外。サイズ上限で対象外になったファイルは本文に一覧を出します

## `/review`を使える人

| 人                                  | 対象         | 同じコミットの再レビュー   | draft |
| ----------------------------------- | ------------ | -------------------------- | ----- |
| メンテナ(`MAINTAINER_ASSOCIATIONS`) | 任意のPR     | できる                     | 対象  |
| PR作成者本人                        | 自分のPRのみ | できない(pushすると再度可) | 対象  |
| それ以外                            | -            | -                          | -     |

PR作成者がレビュー済みのコミットで`/review`を実行すると、botがその旨を返信します。
`AUTO_REVIEW=true`にすると、メンテナが作成したPRはオープン・push・draft解除のたびに自動でレビューされます。

## 仕組み

```
GitHub ──webhook──> server.ts ──> reviewer.ts
                                     │ 1. PRとファイル一覧を取得
                                     │ 2. 除外・サイズ上限を適用
                                     │ 3. diffに行番号を付けてClaudeへ(構造化出力)
                                     │ 4. diff外の行への指摘は本文へ移す
                                     └ 5. pulls.createReview(event: COMMENT)
```

## セットアップ

### 1. GitHub Appを作る

GitHubの Settings > Developer settings > GitHub Apps > New GitHub App で作成します。

| 項目                   | 値                                                                           |
| ---------------------- | ---------------------------------------------------------------------------- |
| Webhook URL            | `https://<公開URL>/api/github/webhooks`                                      |
| Webhook secret         | 任意の文字列(`GITHUB_WEBHOOK_SECRET`に同じ値を設定)                          |
| Repository permissions | Pull requests: Read & write / Contents: Read / Issues: Read / Metadata: Read |
| Subscribe to events    | Pull request / Issue comment                                                 |

作成後、App IDを控え、Private keyを生成してダウンロードします。
最後に、Install Appから対象のリポジトリへインストールします。

ローカルで動かす場合は、[smee.io](https://smee.io)やCloudflare Tunnelなどでwebhookを転送してください。

### 2. 起動

```bash
npm install
cp .env.example .env   # 値を埋める
npm run build
npm start             # node --env-file=.env dist/server.js
```

開発時は`npm run dev`(tsx watch)で起動できます。

## 環境変数

| 変数                      | 既定値                      | 説明                                                                |
| ------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `GITHUB_APP_ID`           | 必須                        | GitHub AppのID                                                      |
| `GITHUB_PRIVATE_KEY`      | 必須                        | PEM形式の秘密鍵。改行は`\n`で1行に書いてもよい                      |
| `GITHUB_WEBHOOK_SECRET`   | 必須                        | Webhookの署名検証用シークレット                                     |
| `ANTHROPIC_API_KEY`       | -                           | 未設定ならSDKの既定の認証情報解決に従う                             |
| `CLAUDE_MODEL`            | `claude-opus-5-5`           | 使用モデル                                                          |
| `CLAUDE_EFFORT`           | `medium`                    | `low` / `medium` / `high` / `xhigh` / `max`                         |
| `CLAUDE_MAX_TOKENS`       | `32000`                     | 応答の最大トークン数                                                |
| `REVIEW_LANGUAGE`         | `Japanese`                  | レビューコメントの言語                                              |
| `MAX_DIFF_CHARS`          | `200000`                    | 1回のレビューでClaudeへ送るpatchの合計文字数                        |
| `EXCLUDE_GLOBS`           | なし                        | 追加で除外するglob(カンマ区切り)                                    |
| `MAINTAINER_ASSOCIATIONS` | `OWNER,MEMBER,COLLABORATOR` | メンテナとして扱う関係。任意のPRで`/review`と強制再レビューができる |
| `AUTO_REVIEW`             | `false`                     | `true`でメンテナのPRをイベント時に自動レビュー                      |
| `REVIEW_COMMAND`          | `/review`                   | レビューのコマンド                                                  |

## 安全性

- Webhookは署名(`X-Hub-Signature-256`)を検証します
- APIクレジットの消費は、PR作成者本人による「1コミット1回」とメンテナの実行に限られます。第三者が他人のPRで`/review`を打っても無視します
- PRの内容はプロンプトインジェクションの入力になり得ます。モデルにツールは渡しておらず、できるのは`COMMENT`レビューの投稿だけです
- 安全分類器による拒否は、サーバー側フォールバック(`fallbacks: "default"`)で別モデルが引き継ぎます。それでも拒否された場合は、その旨をレビュー本文に書きます

## 開発

```bash
npm test            # vitest
npm run typecheck
npm run format
```

## 制限

- 毎回PR全体のdiffをレビューします(前回からの差分だけを見る機能はありません)
- 変更ファイル以外のコード(呼び出し元など)は参照しません
- 指摘への返信には応答しません
