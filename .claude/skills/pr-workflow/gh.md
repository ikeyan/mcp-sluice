# 手段: gh

gh 2.98.0 で `--help` と実行を確認したもの。「未実測」と書いたものだけ確認していない。

- **ブランチの push**: pr-workflow の「push の手順」。作り直したブランチの上書きは pr-workflow の「ブランチの更新」。
- **PR の作成**: `gh pr create --base <既定ブランチ> --title <title> --body-file <file>`。下書きは `--draft`、作らずに内容を確かめるなら `--dry-run`。
- **PR の説明の更新**: `gh pr edit <n> --body-file <file>`。draft の切り替えは `gh pr edit` でなく `gh pr ready` (`--undo` で draft へ戻す)。
- **コメントの読み取り**:
  - `gh pr view <n> --comments` — PR 本文とコメント。
  - `gh api --paginate <endpoint>` — REST。
  - `gh api graphql` — スレッドの `isResolved` / `isOutdated` はここでしか取れない。
- **返信と resolve**: `<このスキルのディレクトリ>/pr.sh reply-resolve <owner>/<repo> <n> <id> <本文>`。`<id>` はスレッド先頭のレビューコメントの数値 id (`#discussion_r…` の数字)。返信してからそのスレッドを resolve する (返信への返信はできない)。却下も同じく理由を返信して resolve する。
- **CI**:
  - 現れている check の一覧: `gh pr checks <n> --json name,bucket,link`
  - `gh pr checks` は check が 1 件も無いと `no checks reported` で exit 1 になる (`--json` / `--watch` でも)。CI の失敗とも完了とも扱わない (CI が無いのか未登録なのか区別できない。`canon: facts/gh/pr-checks-zero-checks-and-exit-codes`)。
  - 現れている check が全部終端になるまで待つ: `gh pr checks <n> --watch` (待ち時間は有界にする。push 直後は前のコミットの check を見ることがある。後から登録された check を拾うかは未実測)
  - 特定の check が push したコミットで終端になるまで待つ。`gh pr checks` は push 直後に前のコミットの check を返すことがあるので、SHA を指定して Checks API を読む:

    ```sh
    refs=$(git ls-remote <remote> "refs/heads/<branch>") || exit 1
    sha=$(printf '%s\n' "$refs" | awk -v r="refs/heads/<branch>" '$2 == r { print $1 }')
    [ -n "$sha" ] || { echo "<remote> に <branch> が無い"; exit 1; }
    end=$((SECONDS + <秒数>))
    until statuses=$(gh api --paginate -X GET "repos/<owner>/<repo>/commits/$sha/check-runs" -f check_name='<check>' --jq '.check_runs[].status') &&
      [ -n "$statuses" ] && ! command grep -qvx completed <<<"$statuses"; do
      [ $SECONDS -lt $end ] || { echo "timeout"; exit 1; }
      sleep 15
    done
    gh api --paginate -X GET "repos/<owner>/<repo>/commits/$sha/check-runs" -f check_name='<check>' --jq '.check_runs[] | "\(.name) \(.app.slug) \(.conclusion) \(.html_url)"'
    ```

    - SHA は `git ls-remote` で読み、ref 名が完全一致する行を採る。ローカルの `HEAD`・remote-tracking ref・API の PR の head からは取らない。自分が push していない PR も、その head ブランチを同じように読む (fork なら fork 側の remote)。
    - 同じ名前の run は全部が `completed` になるまで待つ。
    - 判定の `command grep` を `grep` に戻さない (Bash ツールの `grep` は `-q` と `-v` の併用で終了コードが逆になる)。
    - 旧来の commit status で報告する CI は、この API でなく `gh api repos/<owner>/<repo>/commits/$sha/status` の該当する context を見る。
    - 根拠: `canon: facts/gh/pr-checks-zero-checks-and-exit-codes`、`canon: facts/claude-code/bash-tool-grep-wrapper-qv-exit-code`
  - ログ: Actions の check は `link` の URL から `<jobId>` を取って `gh run view --job <jobId> --log-failed` (`canon: facts/gh/pr-checks-link-to-run-logs`)。Actions 以外の check は `link` の URL を見る。
- **PR の watch** (対応が要るものを待つ): `<このスキルのディレクトリ>/pr.sh watch <owner>/<repo> <n> <dir>` を Bash ツールの `run_in_background` で回す。何を出し、何を出さないかは `pr.sh` の先頭に書いてある。`curl` と `jq` (1.6 以上) が要る。
  - `<dir>` は PR ごとに 1 つ作り、その PR の間は使い続ける: `mktemp -d -p "${TMPDIR:-/tmp}" watch-pr.XXXXXX`。共有の `/tmp` に固定名で置かない (`canon: facts/shell/mktemp-tmpdir-handling-bsd-vs-gnu`)。
  - 出力は終わったときにまとめて届く。終わったら次のとおりにする。
    - `open`・`new`・`changed` の行: 対応してから、同じ `<dir>` で起動し直す。止まっていた間の変化は、起動し直した最初の周期で出る。
    - `codex-usage-limit` の行 (Codex のレビューの利用上限。行の形は `pr.sh` の先頭): 次のとおりにしてから起動し直す。reset が分かっていれば、それを過ぎると watch が `@codex review` を出す。
      - `resets <時刻> 5h`: 何もしない。
      - `resets <時刻>` でほかの窓 (`weekly` など): PushNotification で reset の時刻をユーザーに知らせる。
      - `reset unknown: <理由>`: PushNotification で理由をユーザーに知らせる (PR が draft でなく、Codex の summary があり、head のレビューが始まっていなければ、watch が 300 秒後に `@codex review` を 1 回出す。draft の間は ready にするまでレビューは来ない)。
    - `codex-review requested` の行 (watch が `@codex review` を出した): 起動し直すだけ。
    - `codex-review not-started` の行 (`@codex review` の後も head のレビューが始まらない): PushNotification でユーザーに知らせてから起動し直す。
    - PR の close (merge を含む): 起動し直さず、`<dir>` を消す (`rm -r -- <dir>`)。
    - `auth` の行 (トークンが無いか無効): PushNotification でユーザーに gh auth login を頼み、済んだら起動し直す。
  - 起動した shell は Bash ツールの時間の上限に縛られない (900 秒の sleep が最後まで走ることを実測)。
  - HTTP を `gh api` に書き換えない、トークンを `curl` の引数に載せない、CI の失敗の取得から `filter=all` を外さない。根拠: `canon: facts/claude-code/monitor-runs-in-sandbox-gh-tls`、`canon: facts/shell/process-args-visible-via-ps`、`canon: facts/github/check-runs-filter-latest-hides-reruns`
