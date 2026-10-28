# 手段: GitHub MCP Server

GitHub 公式の MCP サーバ (github/github-mcp-server)。リモート版は `https://api.githubcopilot.com/mcp/`。2026-09-16 に local CLI から接続して schema を確認した。

- **ツールセット**: CI のログ (`get_job_logs`) やワークフローの操作 (`actions_*`) を使うなら、`https://api.githubcopilot.com/mcp/x/actions` (全部入りは `/x/all`) も MCP サーバとして追加する。既定の URL には無い (`canon: facts/claude-code/cc-web-mcp-servers-and-pr-tools`)。
- **ブランチの push**: 作業ツリーの git で、pr-workflow の「push の手順」で行う。`create_or_update_file` / `push_files` は使わない (GitHub 側でコミットを作り、ローカルの履歴とずれる)。作り直したブランチの上書きは pr-workflow の「ブランチの更新」。
- **PR の作成**: `create_pull_request`
- **PR の説明の更新**: `update_pull_request`
- **コメントの読み取り**: `pull_request_read` の `get_comments` (通常コメント) / `get_review_comments` (スレッド単位。スレッド id `PRRT_…` を含む) / `get_reviews` (approve / request changes の本文)。最後のページまで読む (`get_review_comments` は `after`、他は `page` / `perPage`)。
- **返信**: `add_reply_to_pull_request_comment`。`commentId` は `#discussion_r…` の数値 id (スレッドの `PRRT_…` ではない)。
- **resolve**: `pull_request_review_write` の method `resolve_thread` (`threadId` に `PRRT_…`)。
- **CI**: 成功を見届けるときは、pr-workflow の「CI の確認」どおり必要な check を特定し、push したコミットの SHA を指定して結果を読む。
  - `get_check_runs` では判定しない (結果がどのコミットの run か分からない。`canon: facts/github/github-mcp-server-pull-request-read-fields`)。
  - `gh` があれば gh.md の「CI」の手順で読む。無ければ:
    - push したコミットの SHA を `git ls-remote <remote> "refs/heads/<branch>"` で読み、ref 名が完全一致する行を採る。
    - トークンで `curl` から `https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs` を読む。check 名は `--get --data-urlencode "check_name=<check>"` で、トークンは引数に載せずヘッダー行として標準入力から渡す (`printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -H @- …`。`-H @-` はコロンの無い行を黙って捨てるので、トークンだけを流さない)。
    - 全ページについて、その名前の run が 1 件以上あり全部が `completed` になるまで待つ。
    - トークンが無ければ、確かめられなかったとユーザーに報告する。
  - 旧来の commit status で報告する CI (外部 CI 等) は `get_status` の該当する context で見る。結果の `sha` が push したコミットの SHA と一致するときだけ使い、最上位の `state` は使わない。
  - ログは `actions` ツールセットの `get_job_logs`。
- **イベント**: 購読の仕組みは無い。待つなら gh.md の「PR の watch」を使う。`gh` が無い環境では `GH_TOKEN` を設定する。
