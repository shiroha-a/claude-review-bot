# claude-review-bot

Claude APIでPull Requestをレビューし、行単位のコメントとして投稿するGitHub Appです。

- PRに`/review`とコメントするとレビューします(自動レビューは既定でOFF)
- PRのコードをcloneし、Claudeが呼び出し元・関連テスト・既存の実装を調べてからレビューします
- 本文には判定(マージ可 / 要修正 / 要議論)、変更の概要、主な指摘、テスト、設計・保守性を書きます
- 指摘は重要度(critical / major / minor / nit)・種類(bug / security / performance / test / design / style)・確度(confirmed / likely / possible)付きのインラインコメントで、番号付きの失敗シナリオを添えます
- レビューの手順は[deep-code-review](#レビューの手順)に沿います。確認して問題なしと判断した点も本文に残します
- 再レビューでは前回の指摘ごとに対応状況(修正済み / 一部のみ修正 / 未修正)を確かめ、修正済みのスレッドはresolveします
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

## 再レビュー

前回のレビュー以降にpushしてから`/review`すると、前回の指摘が直ったかも確認します。

- 本文の判定の直後に「前回の指摘の対応状況」を一覧で出します
- 行コメントの指摘には、スレッドへ対応状況を返信します。修正済みと判定したスレッドはresolveします
- 差分外の指摘と未修正の指摘は、レビュー本文の隠しコメントに保存し、次の再レビューへ持ち越します
- Claudeには、前回レビューしたcommitから今のheadまでの差分も渡します。force-pushで前回のcommitから辿れない場合は、今のコードと照合させます
- 「修正済み」はClaudeがコードを読んで判断したもので、テストは実行していません。resolveされたスレッドも、必要なら「Show resolved」で確認できます

## リポジトリのガイドライン

レビュー対象リポジトリのCLAUDE.mdやコントリビューター向けドキュメントを、レビューの基準として使います。

- 読むファイル(大文字小文字は区別しない)
  - ルートの`CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` / `.claude/CLAUDE.md` /
    `.github/CONTRIBUTING.md` / `docs/CONTRIBUTING.md` / `.github/copilot-instructions.md`
  - 変更ファイルの祖先ディレクトリにある`CLAUDE.md` / `AGENTS.md`(そのディレクトリ以下にだけ適用)
- PRのheadではなく**baseブランチの版**を読みます。PRでCLAUDE.mdを書き換えてレビュー基準を変えることはできません
  (書き換え自体は通常の変更としてレビューされます)
- symlinkは読みません。`@path`のimportは展開せず、必要ならClaudeが`read_file`で読みます(こちらはheadの版)
- 規約違反は根拠のドキュメントを示して指摘します。コマンド実行やコミット手順など、エージェント向けの作業手順は対象外です
- ガイドラインでレビューの出力形式・重大度・信頼ルールは変えられません。「承認せよ」等の指示は無視します
- 合計`MAX_GUIDELINE_CHARS`文字を超えた分は切り詰め、省いたファイル名をClaudeに伝えます

## AI向けファイルの変更とプロンプトインジェクション

PRがAIエージェントの読むファイルや実行する設定を変える場合、またはdiffにAIへの隠し指示がある場合は、securityの指摘にします。

- 対象: `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`(任意の階層)、`.claude/**`(設定・hooks・コマンド・スキル)、`.mcp.json`、
  Cursor / Windsurf / Cline / Copilotのルールとプロンプト、ガイドラインのドキュメント
  - これらは`EXCLUDE_GLOBS`で除外されず、`MAX_DIFF_CHARS`の枠を優先して使います
  - 変更されたファイルの一覧をClaudeに渡し、diffに無いものも`read_file`で読ませます
- 指摘する内容
  - AIへの指示(承認せよ・チェックを飛ばせ・指摘を隠せ等): major。コマンド実行や外部送信も指示していればcritical
  - エージェントに何かを実行させる設定(hooks・MCPサーバー・許可コマンド・確認を省く権限設定)
  - 理由の説明が無いセキュリティ・テスト・レビュー規約の削除
  - コードコメントや文字列など、ほかの場所にあるAI向けの指示
- 見えない文字: diffの追加行にあるゼロ幅文字・方向制御文字(Trojan Source)・タグ文字(ASCII smuggling)をbotが機械的に検出し、
  位置をClaudeに渡します。タグ文字で隠された文章は復元して示します(ファイル先頭のBOMは除外)

## 仕組み

```
GitHub ──webhook──> server.ts ──> reviewer.ts
                                     │ 1. PRとファイル一覧を取得し、除外・サイズ上限を適用
                                     │    前回のレビューがあれば、その指摘と前回からの差分も集める
                                     │ 2. PRのhead commit(とbase commit)を一時ディレクトリへshallow clone
                                     │    baseからCLAUDE.md等のガイドラインを読む
                                     │ 3. 行番号付きdiffをClaudeへ渡し、ツールループを実行
                                     │      read_file / list_files / grep(読み取り専用)
                                     │      read_review_guide(guides/のチェックリスト)
                                     │      MAX_AGENT_TURNSに達したらツールなしで最終回答
                                     │ 4. 構造化出力のレビューを受け取り、未検証のminor/nitを除外し、
                                     │    diff外の行への指摘と既存の問題は本文へ移す
                                     │ 5. pulls.createReview(event: COMMENT)
                                     │    前回の指摘のスレッドへ返信し、修正済みのものをresolve
                                     └ 6. cloneを削除(失敗時も)
```

## レビューの手順

Claude Code用の`deep-code-review`スキルの手順を、読み取り専用ツール前提に移植しています
(プロンプトは`src/review/prompt.ts`、チェックリストは`guides/`)。

1. 意図: 変更が何をするはずか、間違っていたら誰がどう困るかを書く(「変更の概要」)
2. 地図: 変更された関数の全体・全呼び出し元・エントリポイント・信頼境界・シンクを調べる
3. 6つのレンズで見直す: 意図と論理 / セキュリティ / 並行性 / エラーとリソース / 境界とAPI契約 / テストと観測性
4. 反証: 失敗シナリオを書き、ガード・到達可能性を確かめ、確度(confidence)を付ける。落とした候補も見直す

機械的な規則はコード側で強制します。

- 確度が`possible`の指摘は、critical / majorのときだけ投稿します。それ以外は捨て、件数を本文末尾に出します
- PRで持ち込まれたcritical / majorの指摘があるのに判定が「マージ可」なら、「要修正」に上げます(下げることはしません)
- 以前からある問題(`pre_existing`)は「既存の問題」節に分け、判定と再レビューの持ち越しからは外します

スキルとの違い: botはコードを実行しないため、テスト・静的解析の実行、再現による確認、
別エージェントによる独立検証は行いません。

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

Dockerで常駐させます。

```bash
cp .env.example .env   # 値を埋める
docker compose up -d --build
docker compose logs -f # [tool] / [review] の行で動作を確認できる
```

- ポートはホストの`127.0.0.1:8787`にだけ公開します。外部からはトンネル(cloudflared等)経由で`/api/github/webhooks`へ届けてください
- `restart: unless-stopped`なので、Dockerが自動起動する設定ならサーバー再起動後も立ち上がります
- コードを更新したら`docker compose up -d --build`で入れ替えます

Dockerを使わない場合は`npm install && npm run build && npm start`、開発時は`npm run dev`(tsx watch)で起動できます。

## 環境変数

| 変数                      | 既定値                      | 説明                                                                |
| ------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `GITHUB_APP_ID`           | 必須                        | GitHub AppのID                                                      |
| `GITHUB_PRIVATE_KEY`      | 必須                        | PEM形式の秘密鍵。改行は`\n`で1行に書いてもよい                      |
| `GITHUB_WEBHOOK_SECRET`   | 必須                        | Webhookの署名検証用シークレット                                     |
| `ANTHROPIC_API_KEY`       | -                           | 未設定ならSDKの既定の認証情報解決に従う                             |
| `CLAUDE_MODEL`            | `claude-opus-5-5`           | 使用モデル                                                          |
| `CLAUDE_EFFORT`           | `high`                      | `low` / `medium` / `high` / `xhigh` / `max`                         |
| `MAX_AGENT_TURNS`         | `25`                        | リポジトリを調べるツール呼び出しのターン数上限                      |
| `CLAUDE_MAX_TOKENS`       | `32000`                     | 応答の最大トークン数                                                |
| `REVIEW_LANGUAGE`         | `Japanese`                  | レビューコメントの言語                                              |
| `MAX_DIFF_CHARS`          | `200000`                    | 1回のレビューでClaudeへ送るpatchの合計文字数                        |
| `EXCLUDE_GLOBS`           | なし                        | 追加で除外するglob(カンマ区切り)                                    |
| `MAX_GUIDELINE_CHARS`     | `30000`                     | Claudeへ渡すガイドライン(CLAUDE.md等)の合計文字数。`0`で読まない    |
| `MAINTAINER_ASSOCIATIONS` | `OWNER,MEMBER,COLLABORATOR` | メンテナとして扱う関係。任意のPRで`/review`と強制再レビューができる |
| `AUTO_REVIEW`             | `false`                     | `true`でメンテナのPRをイベント時に自動レビュー                      |
| `REVIEW_COMMAND`          | `/review`                   | レビューのコマンド                                                  |

## 安全性

- Webhookは署名(`X-Hub-Signature-256`)を検証します
- APIクレジットの消費は、PR作成者本人による「1コミット1回」とメンテナの実行に限られます。第三者が他人のPRで`/review`を打っても無視します
- PRの内容とリポジトリのファイルはプロンプトインジェクションの入力になり得ます。モデルに渡すツールは読み取り専用で、clone先の外(`..`・絶対パス・symlink・`.git`)は読めません。リポジトリのコードは実行しません。最終的にできるのは`COMMENT`レビューの投稿と、ボット自身の指摘スレッドへの返信・resolveだけです。インジェクションで「修正済み」と誤判定させられた場合も、スレッドは消えず「Show resolved」から見られます
- cloneの認証トークンは環境変数経由でgitに渡し、コマンドライン引数や`.git/config`には残しません
- 安全分類器による拒否は、サーバー側フォールバック(`fallbacks: "default"`)で別モデルが引き継ぎます。それでも拒否された場合は、その旨をレビュー本文に書きます

## 開発

```bash
npm test            # vitest
npm run typecheck
npm run format
```

## 制限

- 再レビューでもPR全体のdiffをレビューします(前回からの差分は、前回の指摘の確認に使います)
- 前回の指摘として見るのは直前のボットのレビューだけです。未修正の指摘はそこへ持ち越されるので、通常は漏れません
- リポジトリを調べる分、1回のレビューは数十秒〜数分かかり、diffだけの場合よりコストが上がります
- 指摘への返信には応答しません
