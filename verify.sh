#!/usr/bin/env bash
# このリポの単一検証コマンド。引数は受けない (渡されたら exit 2)。
# 手順:
# 1. git の場所を決める環境変数 (git rev-parse --local-env-vars の一覧。canon: facts/git/local-env-vars-and-hook-env) を消す。git はこのファイルのあるリポだけを見る。一覧に無い設定の差し替え (GIT_CONFIG_GLOBAL など) は残る。
# 2. pre-push の hook を揃える (下の表)。検査が落ちても hook は揃っているように、検査より先に行う。
# 3. TMPDIR (未設定か空なら /tmp) を symlink を解決した絶対パスにする。
# 4. scripts/run-checks.ts を exec する (検査の段・出力の順・終了コード・シグナルの扱い・版の範囲はその先頭)。
# 事前条件:
# - bash 3.2 以降。
# - shellcheck・deno・git が PATH にあること。ネットワークは、deno が依存 (npm) を未取得のときだけ要る。
# - TMPDIR (未設定か空なら /tmp) が在るディレクトリで、名前に `,` を含まない (--allow-write の区切り)。外れれば理由を出して exit 1。
# hook:
# - git は hook を $GIT_COMMON_DIR/hooks から呼ぶ (linked worktree も共有し、checkout で変わらない。canon: facts/git/hookspath-relative-resolves-per-worktree)。
# - core.hooksPath (どの scope でも) が hook をよそへ向けていれば違反にし、設定は書かない。
# - 写す先の pre-push の状態ごとの扱い:
#   - 無い (壊れた symlink を含む): 同じディレクトリの一時ファイルに写してから mv -f で置く。同じ common dir で並行に走る verify.sh にも、書きかけは見えない。
#   - hooks/pre-push と同じ中身で実行可能: 何もしない。
#   - hooks/pre-push と同じ中身で実行可能でない: chmod +x する。
#   - それ以外 (旧版、利用者が置いた別の hook、手を入れた写し、ディレクトリ): このリポのものかを中身から決められないので、触らずに置き換えのコマンドを示して落ちる。
# - 判定は verify.sh を走らせた環境 (GIT_CONFIG_GLOBAL などの設定の差し替えを含む) についてのものなので、push する環境で走らせる。
set -euo pipefail
if [ $# -ne 0 ]; then
  echo "verify.sh: 引数は受けない ($*)。./verify.sh だけで回す" >&2
  exit 2
fi
cd "$(dirname "$0")"
local_env=$(git rev-parse --local-env-vars)
while IFS= read -r v; do unset "$v"; done <<<"$local_env"

status=0
common=$(git rev-parse --path-format=absolute --git-common-dir)
hooks_dir=$(git rev-parse --path-format=absolute --git-path hooks)
if [ "$hooks_dir" != "$common/hooks" ]; then
  echo "hook の置き場が $hooks_dir で、$common/hooks でない ($(git config --show-origin --show-scope --get core.hooksPath | tr '\t' ' '))。 Execute: git config --file <その file> --unset core.hooksPath" >&2
  status=1
fi
hook=$common/hooks/pre-push
if [ -f "$hook" ] && cmp -s hooks/pre-push "$hook"; then
  if [ ! -x "$hook" ] && ! chmod +x "$hook"; then
    echo "$hook: 実行可能にできない。 Execute: chmod +x '$hook'" >&2
    status=1
  fi
elif [ -e "$hook" ]; then
  echo "$hook: hooks/pre-push と中身が違う。中身を確かめ、置き換えてよければ Execute: install -m 755 hooks/pre-push '$hook'" >&2
  status=1
else
  tmp=$hook.verify-$$
  if mkdir -p "$common/hooks" && install -m 755 hooks/pre-push "$tmp" && mv -f "$tmp" "$hook"; then
    echo "$hook: hooks/pre-push を写した"
  else
    rm -f "$tmp"
    echo "$hook: hooks/pre-push を写せない。 Execute: install -m 755 hooks/pre-push '$hook'" >&2
    status=1
  fi
fi

# deno の --allow-write はパスの綴りで照合する (canon: facts/deno/permission-paths-not-resolved) ので、exec の環境の TMPDIR と同じ綴りで渡す。
if ! tmpdir=$(cd "${TMPDIR:-/tmp}" && pwd -P); then
  echo "verify.sh: TMPDIR (${TMPDIR:-/tmp}) がディレクトリでない。在るディレクトリを TMPDIR に設定する" >&2
  exit 1
fi
case $tmpdir in
*,*)
  echo "verify.sh: TMPDIR ($tmpdir) が , を含む。, を含まないディレクトリを TMPDIR に設定する" >&2
  exit 1
  ;;
esac
# Deno.kill で段のプロセスグループに送るには、パスを付けない --allow-run が要る (canon: facts/deno/command-spawn の「Deno.kill」)。パスで絞った --allow-run で通るようになったら、段が起動するもの (git・shellcheck・deno) に絞る。
# 段の子の環境から変数を消すには環境を丸ごと写すので、変数を絞らない --allow-env が要る。
export TMPDIR=$tmpdir
exec deno run --frozen-lockfile --allow-run --allow-env --allow-write="$tmpdir" --allow-read=deno.json scripts/run-checks.ts "$status"
