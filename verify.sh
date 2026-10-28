#!/usr/bin/env bash
# このリポの単一検証コマンド。引数なしで全部を検査する。
# 段は 2 種類で、その場で直す状態 (hooks/pre-push の写し) を先に揃え、検査 (scripts/run-checks.ts) を後に回す。検査が落ちても状態は揃っているようにするため。VERIFY_READONLY=1 では直さず違反にする (CI 用)。
# 事前条件: shellcheck (0.11.0 だけ。.github/workflows/verify.yml が入れる版と同じ)・deno (2.x)・git (2.31 以降。--path-format を持つ版) が PATH にあること。ネットワークは、deno が依存 (npm) を未取得のときだけ要る。
# git は hook を $GIT_COMMON_DIR/hooks (linked worktree も共有し、checkout で変わらない) から呼ぶので、hooks/pre-push をそこへ写す。core.hooksPath (どの scope でも) が hook をよそへ向けていれば違反にし、設定は書かない。
# 写す先の pre-push の状態ごとの扱い:
# - 無い (壊れた symlink を含む。git が実行できない): 写す
# - hooks/pre-push と同じ実行可能なファイル: 何もしない
# - それ以外 (旧版、利用者が置いた別の hook、手を入れた写し): このリポのものかを中身から決められないので、上書きせず落として置き換えのコマンドを示す
# 判定は verify.sh を走らせた環境 (GIT_CONFIG_GLOBAL・GIT_CONFIG_COUNT などの設定の差し替えを含む) についてのものなので、push する環境で走らせる。
set -euo pipefail
cd "$(dirname "$0")"

readonly_mode=${VERIFY_READONLY:-}
status=0
common=$(git rev-parse --path-format=absolute --git-common-dir)
hooks_dir=$(git rev-parse --path-format=absolute --git-path hooks)
if [ "$hooks_dir" != "$common/hooks" ]; then
  echo "hook の置き場が $hooks_dir で、$common/hooks でない ($(git config --show-origin --show-scope --get core.hooksPath | tr '\t' ' '))。 Execute: git config --file <その file> --unset core.hooksPath" >&2
  status=1
fi
hook=$common/hooks/pre-push
if [ ! -x "$hook" ] || ! cmp -s hooks/pre-push "$hook"; then
  if [ -e "$hook" ] || [ -n "$readonly_mode" ]; then
    echo "$hook: hooks/pre-push と同じ実行可能なファイルでない (上書きしない)。中身を確かめ、置き換えてよければ Execute: install -m 755 hooks/pre-push '$hook'" >&2
    status=1
  elif mkdir -p "$common/hooks" && install -m 755 hooks/pre-push "$hook"; then
    echo "$hook: hooks/pre-push を写した"
  else
    echo "$hook: hooks/pre-push を写せない。 Execute: install -m 755 hooks/pre-push '$hook'" >&2
    status=1
  fi
fi

# Deno.kill で段のプロセスグループに送るには、パスを付けない --allow-run が要る (canon: facts/deno/command-spawn の「Deno.kill」)。パスで絞った --allow-run で通るようになったら、段が起動するもの (git・shellcheck・deno) に絞る。
# run-checks.ts は TMPDIR (未設定か空なら /tmp) の下に書く。許可はパスの綴りで照合する (canon: facts/deno/permission-paths-not-resolved) ので、同じ綴りで渡す。
tmpdir=${TMPDIR:-/tmp}
exec deno run --frozen-lockfile --allow-run --allow-env=TMPDIR --allow-write="$tmpdir" --allow-read=deno.json,.agent-sync/generated scripts/run-checks.ts "$status"
