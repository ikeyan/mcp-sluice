---
name: pr-workflow
description: Use when pushing a branch, creating a pull request or editing its description, responding to review comments, or checking CI.
---

# PR / ブランチ運用

## このリポの値

push 先・寄稿規約・手段の実測・方針の差分は、同じディレクトリの [repo.md](repo.md) にある。先に読む。repo.md の方針の差分は、下の方針より優先する。repo.md が無い (またはテンプレートの `<…>` が残っている) なら、push も PR の作成もせず、repo.md を埋めるようユーザーに伝えて止まる。

## 手段

使うものだけ読む。`gh` が使える環境では `gh` を既定にする。

- [gh.md](gh.md)
- [github-mcp-server.md](github-mcp-server.md) — GitHub 公式の MCP サーバ (`api.githubcopilot.com`)
- [cc-web-github-mcp.md](cc-web-github-mcp.md) — Claude Code on the web に組み込まれた GitHub MCP

## 方針

- **作業の開始**: 既定ブランチの最新を取得し、差分がない状態でこのリポの単一検証コマンド (AGENTS.md) を通す。成功を確認してから作業を始める。
- **ブランチの作成**: 既定ブランチの最新から切る。命名は寄稿規約に従う。既定ブランチに直接コミットしない。
- **push の手順**: どの手段でも、作業ツリーの git で、コマンドに `PUSH_OK=1` を前置して push する: `PUSH_OK=1 git push <push の引数>`。リポの `hooks/pre-push` は `PUSH_OK=1` の無い push を止めるので、push は毎回意図して付けたときだけ通る。許可はそのコマンドの環境変数なので、push が中断されても残らない。`export PUSH_OK=1` はしない (以後の全ての push が通る)。
- **ブランチの更新**: push 先の作業ブランチへ push する。他人のブランチの履歴は書き換えない (base の取り込みは merge)。マージ済み PR のブランチには積まず、既定ブランチから同名で作り直す。
  - 作り直したブランチは remote に残る旧ブランチと衝突し、push が non-fast-forward で拒否される。`git fetch <remote> <branch>` した oid が、そのブランチを head とするマージ済み PR の head SHA と一致する (= マージ後に何も積まれていない) ことを PR 情報で確認してから、「push の手順」の push の引数を `--force-with-lease=<branch>:<fetch した oid> <remote> <branch>` にして上書きする。値を省いた `--force-with-lease` は拒否される。
  - コミットの祖先関係 (`merge-base --is-ancestor`) はマージ済みの判定に使えない (squash / rebase マージでは旧 tip が既定ブランチの祖先にならない)。
  - 根拠と実測: `canon: facts/git/force-with-lease-recreated-branch`
- **push の単位**: コミットごとには push しない。作業の区切り (レビュー依頼・指示された時点) でまとめる。
- **PR の作成**: 頼まれたときだけ作る。寄稿規約に従う。
- **merge の後**: PR の head の sha を PR から読み (merged であることも確かめ)、`<このスキルのディレクトリ>/cleanup-branch.sh <branch> <PR の head の sha>` でローカルの作業ブランチを消す。squash merge では先端が既定ブランチの祖先にならず `git branch -d` が使えないので、先端が PR の head と一致することをスクリプトが確かめて `-D` する。checkout 中の worktree の扱いなどはスクリプトの先頭に書いてある。手段ファイルの「PR の watch」の `<dir>` を作っていれば、それも消す。
- **PR の説明**: 最新の HEAD に関連することだけを書く。push するたびに更新するので、計測結果を書くなら計測スクリプトを用意する。
  - 書くこと (寄稿規約に PR テンプレートがあればその構成に収め、無ければ次の 3 つを見出しにする):
    - Purpose: 何を達成しようとして、何を期待し、実際に何が起きたか。
    - Assumptions: レビュアーが知っておくべき前提 (例: 文書化されていない機能の存在に依存する)。
    - Verifications:
      - 実行した検証コマンド。
      - 追加・変更したテストの目的 (手順ではなく)。
      - 全てのテストが成功したかどうか。
      - ベースブランチで検証が失敗していることをユーザーが認識している場合は、その旨。
  - 書かないこと:
    - diff を読めば分かるファイル単位の説明。
    - エージェント環境固有の事情。その環境自体が PR の主題でなければ、PR でなくユーザーに説明する。
    - HEAD に直接関連しない過去の行為 (「試した」「最初は〜にしていた」「入れてから消した」)。システムを主語にした現在形の制約に書き直せない文は不要な情報。
  - 目的と diff からレビュアーが確実に抱く疑問には答える。それ以上は予測で先回りせず、レビュアーが聞いたらスレッドで答える。
  - 読者が canon を読めない PR 先 (公開リポ等) では canon を参照せず、その fact の内容を説明に写す。
  - 本文の主張と diff を一致させる。
  - 正確にしすぎて冗長になっている表現は、リポオーナーやレビュアーがすっと分かる範囲で丸めてよい。
  - 列挙はカンマ区切りでなく箇条書きにする。
  - コードブロックが GitHub 上で意図どおり描画されるかをプレビューで確認する (heredoc 内のバックスラッシュ等のエスケープが本文に残ることがある)。
- **コメントの読み方**: 通常コメントとレビューコメントで取得経路と resolved 状態の持ち方が違う (`canon: facts/github/pr-comments-retrieval-and-resolved-state`)。どの経路でもコレクションは最後のページまで読み切る。1 ページ目だけでは未対応の指摘を見落とす。
  - 未対応の指摘 = `isResolved: false` のスレッド全部 (outdated でも) + 対応を求める内容を持ち、まだ返信していない通常コメントと review 本文。
  - 各レビュアーについて、`COMMENTED` を除いた最新の review が `CHANGES_REQUESTED` ならその本文は必ず含む (スレッドを持たない指摘はここにしか現れない)。
  - 情報だけの bot コメントと `APPROVED` の本文は含まない。
- **Codex Review (chatgpt-codex-connector)**: 使っているリポでは、現在の head に対して完了しているかを確かめてから読む。
  - 完了 = 進捗コメント (先頭が `<!-- codex-pull-request-review-summary -->`) の状態表が ✅ Completed で、その Commit 列が現在の head と一致していること。push 直後は前の commit の Completed と前の review が残っているので、head の一致を見ずに完了と判断しない。
  - Codex の指摘は review decision を動かさない (review は `COMMENTED`) ので、未対応かどうかはスレッドの `isResolved` で見る。
  - 観察の全体: `canon: facts/github/codex-review-pr-flow`
- **コメント対応後**: 対応したスレッドに返信 (対応コミットの SHA と要点。却下なら理由) してから resolve する。通常コメントは返信のみ。
- **CI の確認**: 既定は失敗の検知だけ。
  - 成功を見届けるのは理由があるときだけ (ユーザーに指示された、CI 自体を変更していて成功時のログが要る等)。その理由から必要な check を特定し、それが現在の head に現れて終端状態になるまで有界に待つ。打ち切ったらユーザーに報告する。待ち続けない。
  - 「全部緑」は確認対象にしない。check run は GitHub App が任意の時点で任意の commit に作れるので集合が閉じず、「もう増えない」の判定は決定不能 (`canon: facts/github/check-runs-set-is-open`)。
  - 同じ理由で、走る check の一覧は CI 設定や required checks からは導けない。現在の head に現れているものを読む。
- **PR コメントの watch**: 既定ではしない。待つときは、cc-web では `subscribe_pr_activity`、それ以外は手段ファイルの「PR の watch」を使う。
