#!/usr/bin/env bash
# このリポの単一検証コマンド。引数は受けない (渡されたら exit 2)。hook を揃えてから scripts/run-checks.ts を exec する (検査の段・出力の順・終了コード・シグナルの扱い・版の範囲はその先頭)。
# 事前条件:
# - OS は Linux か macOS (CI は ubuntu-latest)。
# - bash 3.2 以降。
# - git 2.31 以降 (rev-parse --path-format。canon: facts/git/rev-parse-path-format-since-2-31)。外れれば理由を出して exit 1。
# - shellcheck・deno が PATH にあること。ネットワークは、deno が依存 (npm) を未取得のときだけ要る。
# 消す環境変数: git の場所を決めるもの (git rev-parse --local-env-vars の一覧。canon: facts/git/local-env-vars-and-hook-env)。git はこのファイルのあるリポだけを見る。一覧に無い設定の差し替え (GIT_CONFIG_GLOBAL など) は残る。
# TMPDIR の値ごとの扱い (deno の --allow-write と run-checks.ts に渡す):
# - 未設定・空: /tmp として下の行で扱う。
# - 絶対パスのディレクトリ (symlink を含む): symlink を解決した絶対パスにする。
# - 相対パス: 理由を出して exit 1。
# - 無い・ディレクトリでない・入れない: cd の理由を見るよう示して exit 1。
# - 解決したパスが `,` を含む: --allow-write の区切りと読まれるので、理由を出して exit 1。deno が --allow-write の値の `,` を escape できるようになったら外せる。
# hook:
# - git は hook を $GIT_COMMON_DIR/hooks から呼ぶ (linked worktree も共有し、checkout で変わらない。canon: facts/git/hookspath-relative-resolves-per-worktree)。
# - core.hooksPath が (どの scope でも) 設定されていれば、既定の置き場を指していても落ちる。git rev-parse --git-path は hooks の symlink を解決したパスを出し、既定の置き場と比べられない (canon: facts/git/rev-parse-absolute-path-resolves-symlinks)。
# - hook は検査より先に揃える (検査や TMPDIR の確かめが落ちても hook は揃う)。
# - 写す元 (hooks/pre-push) と写す先 ($GIT_COMMON_DIR/hooks/pre-push) の状態ごとの扱い。落ちるときは理由と、中身を確かめてから実行するコマンド (絶対パス。その状態で実行すれば直る) を示す:
#   - hooks が無い: 作って写す。
#   - hooks がディレクトリでない (通常ファイル・壊れた symlink・FIFO など): 落ちる。示すのは rm -f・mkdir・install。
#   - hooks がディレクトリ (それへの symlink を含む) で、pre-push が:
#     - 無い・壊れた symlink: 写す。
#     - 同じ中身の通常ファイル (それへの symlink を含む): 実行可能でなければ chmod +x。できなければ落ちる。示すのは chmod +x。
#     - 違う中身 (旧版、利用者の別の hook、手を入れた写し): このリポのものかを中身から決められないので落ちる。示すのは rm -f・install。
#     - 読めない (cmp が比べられない): 落ちる。示すのは rm -f・install。
#     - ディレクトリ: 落ちる。示すのは rm -rf・install。
#     - 通常ファイルでもディレクトリでもない (FIFO など。cmp が読むと止まる): 落ちる。示すのは rm -f・install。
#   - 写せない (書けないなど): 落ちる。示すのは mkdir -p・install。
# - 判定は verify.sh を走らせた環境 (GIT_CONFIG_GLOBAL などの設定の差し替えを含む) についてのものなので、push する環境で走らせる。
set -euo pipefail
if [ $# -ne 0 ]; then
  echo "verify.sh: 引数は受けない ($*)。./verify.sh だけで回す" >&2
  exit 2
fi
cd "$(dirname "$0")"
git_version=$(git --version)
version_re='^git version ([0-9]+)\.([0-9]+)'
if ! [[ $git_version =~ $version_re ]] || [ "${BASH_REMATCH[1]}" -lt 2 ] ||
  { [ "${BASH_REMATCH[1]}" -eq 2 ] && [ "${BASH_REMATCH[2]}" -lt 31 ]; }; then
  echo "verify.sh: git が 2.31 以降でない ($git_version)。git 2.31 以降を PATH の先に置く" >&2
  exit 1
fi
local_env=$(git rev-parse --local-env-vars)
while IFS= read -r v; do unset "$v"; done <<<"$local_env"

status=0
common=$(git rev-parse --path-format=absolute --git-common-dir)
if hooks_path=$(git config --show-origin --show-scope --get-all core.hooksPath); then
  echo "core.hooksPath が設定されている ($(printf '%s' "$hooks_path" | tr '\t\n' ' ;'))。hook は $common/hooks に置くので消す。 Execute: git config --file <その file> --unset-all core.hooksPath" >&2
  status=1
fi
src=$PWD/hooks/pre-push
hooks=$common/hooks
hook=$hooks/pre-push
install_cmd="install -m 755 $(printf %q "$src") $(printf %q "$hook")"
refuse() {
  echo "$1。中身を確かめ、置き換えてよければ Execute: $2" >&2
  status=1
}
if [ ! -d "$hooks" ] && { [ -e "$hooks" ] || [ -L "$hooks" ]; }; then
  refuse "$hooks: ディレクトリでない" "rm -f $(printf %q "$hooks") && mkdir $(printf %q "$hooks") && $install_cmd"
elif [ -d "$hook" ]; then
  refuse "$hook: ディレクトリ" "rm -rf $(printf %q "$hook") && $install_cmd"
elif [ -f "$hook" ]; then
  # 違いは stdout に出るので捨て、比べられない理由 (stderr) だけを見せる
  compared=0
  cmp "$src" "$hook" >/dev/null || compared=$?
  case $compared in
  0)
    if [ ! -x "$hook" ] && ! chmod +x "$hook"; then
      echo "$hook: 実行可能にできない。 Execute: chmod +x $(printf %q "$hook")" >&2
      status=1
    fi
    ;;
  1) refuse "$hook: hooks/pre-push と中身が違う" "rm -f $(printf %q "$hook") && $install_cmd" ;;
  *) refuse "$hook: hooks/pre-push と比べられない (理由は上の cmp)" "rm -f $(printf %q "$hook") && $install_cmd" ;;
  esac
elif [ -e "$hook" ]; then
  refuse "$hook: 通常のファイルでない" "rm -f $(printf %q "$hook") && $install_cmd"
else
  # 一時ファイルに写してから mv -f で置くので、同じ common dir で並行に走る verify.sh にも書きかけは見えない
  tmp=$hook.verify-$$
  # bash は SIGHUP・SIGINT・SIGTERM で終わるときも EXIT trap を回す (canon: facts/shell/bash-exit-trap-runs-on-fatal-signal)
  trap 'rm -f "$tmp"' EXIT
  if mkdir -p "$hooks" && install -m 755 "$src" "$tmp" && mv -f "$tmp" "$hook"; then
    echo "$hook: hooks/pre-push を写した"
  else
    rm -f "$tmp"
    echo "$hook: hooks/pre-push を写せない (理由は上)。 Execute: mkdir -p $(printf %q "$hooks") && $install_cmd" >&2
    status=1
  fi
  trap - EXIT
fi

tmpdir_in=${TMPDIR:-/tmp}
case $tmpdir_in in
/*) ;;
*)
  echo "verify.sh: TMPDIR ($tmpdir_in) が相対パス。絶対パスを TMPDIR に設定する" >&2
  exit 1
  ;;
esac
# deno の --allow-write はパスの綴りで照合する (canon: facts/deno/permission-paths-not-resolved) ので、exec の環境の TMPDIR と同じ綴りで渡す。
if ! tmpdir=$(cd "$tmpdir_in" && pwd -P); then
  echo "verify.sh: TMPDIR ($tmpdir_in) に cd できない (理由は上の cd)。在る、入れるディレクトリを TMPDIR に設定する" >&2
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
