#!/usr/bin/env bash
# このリポの単一検証コマンド。引数なしで全部を検査する。
# 先に状態 (hook の写し) を揃え、その後に検査の段を scripts/run-checks.ts へ exec する (出力の順・終了コード・シグナルの扱いと、shellcheck・deno・git の版はその先頭)。検査が落ちても状態は揃っているようにするため。
# 事前条件: shellcheck・deno・git が PATH にあること。ネットワークは、deno が依存 (npm) を未取得のときだけ要る。
# 環境:
# - git の場所を決める環境変数 (git rev-parse --local-env-vars の一覧。canon: facts/git/local-env-vars-and-hook-env) は cd の直後に消すので、git はこのファイルのあるリポだけを見る。一覧に無い設定の差し替え (GIT_CONFIG_GLOBAL など) は残る。
# - VERIFY_READONLY は未設定・空か 1 だけを受け、他の値なら落ちる。1 (CI) は作業ツリーを書き換えないことを求める。verify.sh はどちらでも作業ツリーを書き換えない。
# git は hook を $GIT_COMMON_DIR/hooks (linked worktree も共有し、checkout で変わらない。canon: facts/git/hookspath-relative-resolves-per-worktree) から呼ぶので、hooks/pre-push をそこへ写す。core.hooksPath (どの scope でも) が hook をよそへ向けていれば違反にし、設定は書かない。
# 写す先の pre-push の状態ごとの扱い (VERIFY_READONLY によらない。写す先は作業ツリーの外):
# - 無い (壊れた symlink を含む。git が実行できない): 写す
# - hooks/pre-push と同じ実行可能なファイル: 何もしない
# - それ以外 (旧版、利用者が置いた別の hook、手を入れた写し、実行可能でない写し): このリポのものかを中身から決められないので、触らずに置き換えのコマンドを示して落ちる
# 判定は verify.sh を走らせた環境 (GIT_CONFIG_GLOBAL などの設定の差し替えを含む) についてのものなので、push する環境で走らせる。
set -euo pipefail
cd "$(dirname "$0")"
local_env=$(git rev-parse --local-env-vars)
mapfile -t local_env_vars <<<"$local_env"
unset "${local_env_vars[@]}"

case ${VERIFY_READONLY:-} in
  '' | 1) ;;
  *)
    echo "VERIFY_READONLY は未設定・空か 1 ($VERIFY_READONLY)" >&2
    exit 1
    ;;
esac

status=0
common=$(git rev-parse --path-format=absolute --git-common-dir)
hooks_dir=$(git rev-parse --path-format=absolute --git-path hooks)
if [ "$hooks_dir" != "$common/hooks" ]; then
  echo "hook の置き場が $hooks_dir で、$common/hooks でない ($(git config --show-origin --show-scope --get core.hooksPath | tr '\t' ' '))。 Execute: git config --file <その file> --unset core.hooksPath" >&2
  status=1
fi
hook=$common/hooks/pre-push
if [ -x "$hook" ] && cmp -s hooks/pre-push "$hook"; then
  :
elif [ -e "$hook" ]; then
  echo "$hook: hooks/pre-push と同じ実行可能なファイルでない。中身を確かめ、置き換えてよければ Execute: install -m 755 hooks/pre-push '$hook'" >&2
  status=1
elif mkdir -p "$common/hooks" && install -m 755 hooks/pre-push "$hook"; then
  echo "$hook: hooks/pre-push を写した"
else
  echo "$hook: hooks/pre-push を写せない。 Execute: install -m 755 hooks/pre-push '$hook'" >&2
  status=1
fi

# Deno.kill で段のプロセスグループに送るには、パスを付けない --allow-run が要る (canon: facts/deno/command-spawn の「Deno.kill」)。パスで絞った --allow-run で通るようになったら、段が起動するもの (git・shellcheck・deno) に絞る。
# run-checks.ts は TMPDIR (未設定か空なら /tmp) の下に書く。許可はパスの綴りで照合する (canon: facts/deno/permission-paths-not-resolved) ので、同じ綴りで渡す。
tmpdir=${TMPDIR:-/tmp}
exec deno run --frozen-lockfile --allow-run --allow-env=TMPDIR --allow-write="$tmpdir" --allow-read=deno.json,.agent-sync/generated scripts/run-checks.ts "$status"
