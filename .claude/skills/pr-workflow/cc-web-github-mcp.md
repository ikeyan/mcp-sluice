# 手段: cc-web の GitHub MCP

Claude Code on the web に組み込まれた GitHub MCP (`mcp__github__`)。github-mcp-server とは別の実装で、セッションに紐づいたリポ以外は、`add_repo` で足すまで読めない。2026-09-16 に cc-web のセッションで schema を確認した (`canon: facts/claude-code/cc-web-mcp-servers-and-pr-tools`、`canon: facts/claude-code/cc-web-session-repo-scope`)。

- **ブランチの push**: 作業ツリーの git で、pr-workflow の「push の手順」で行う (保護された ref への push は未検証)。`create_or_update_file` / `push_files` は使わない (GitHub 側でコミットを作り、ローカルの履歴とずれる)。作り直したブランチの上書きは pr-workflow の「ブランチの更新」。
- **PR の作成**: `create_pull_request`
- **PR の説明の更新**: `update_pull_request`
- **コメントの読み取り**: `pull_request_read` の `get_comments` (通常コメント) / `get_review_comments` (スレッド単位。スレッド id `PRRT_…` を含む) / `get_reviews` (approve / request changes の本文)。最後のページまで読む。
- **返信**: `add_reply_to_pull_request_comment`。`commentId` は `#discussion_r…` の数値 id。イベントの `comment_id` はそのまま渡せる。
- **resolve**: `resolve_review_thread` (`owner` / `repo` / `threadId`)、または `pull_request_review_write` の method `resolve_thread`。`PRRT_…` はイベントに無いので `get_review_comments` で取り直す。
- **CI**: 成功を見届けるときは、pr-workflow の「CI の確認」どおり必要な check を特定し、push したコミットの SHA を指定して結果を読む (`send_later` の check-in 等で再読する)。
  - `get_check_runs` と `get_status` では判定しない。`get_check_runs` は結果がどのコミットのものか確かめられない (`canon: facts/github/github-mcp-server-pull-request-read-fields`)。この実装の `get_status` が `sha` を返すかは確かめていない。
  - push したコミットの SHA を `git ls-remote <remote> "refs/heads/<branch>"` で読み、ref 名が完全一致する行を採る。
  - トークンで `curl` から `https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs` を読む。check 名は `--get --data-urlencode "check_name=<check>"` で、トークンは引数に載せずヘッダー行として標準入力から渡す (`printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -H @- …`。`-H @-` はコロンの無い行を黙って捨てるので、トークンだけを流さない)。全ページについて、その名前の run が 1 件以上あり全部が `completed` になるまで待つ。旧来の commit status で報告する CI は `commits/<sha>/status` の該当する context を見る。
  - トークンが無ければ、確かめられなかったとユーザーに報告する。
  - 失敗の詳細は `get_job_logs` を `run_id`・`failed_only=true`・大きめの `tail_lines` で取る (`get_check_run` の `output` は Actions の job では空のことがある)。
- **イベント**: `subscribe_pr_activity` (`owner` / `repo` / `pullNumber`)。配送の実測は `canon: facts/claude-code/subscribe-pr-activity-events`。行動に要るのは次:
  - 届く: CI の失敗、CI の成功 (コミットごとに 1 回まで)、新しいコメント、コメントの編集、review、draft 化・ready・close・reopen。自分のアカウントが書いたコメント (自分の返信を含む) も届くので、書き手を見て自分の返信には反応しない。
  - 届かない: push、label などのメタデータの変更、merge conflict。
  - CI の成功はイベントで待たない。成功のイベントは特定した check を見直すきっかけにすぎない。
  - push は `pull_request_read` の `get` で head の SHA を取り直して比べる。コンフリクトは `get` の `mergeable_state` を見る。
  - close で購読は解除され、reopen で再購読される。PR Steward が watch 中の PR ではイベントが届かない。そのときは tool の結果にその旨が出るので、購読したら結果を読み、出ていればイベントを待たずに `get` と CI を定期的に読み直す。
