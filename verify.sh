#!/usr/bin/env bash
# このリポの単一検証コマンド。hook を揃えてから scripts/run-checks.ts を exec する。検査の規則の本文は scripts/run-checks.ts の先頭にある。
# 流れ:
# 1. 引数・$0・事前条件を確かめる。外れれば理由を出して終わる。
# 2. git の場所を決める環境変数を消す (下の「入力」)。
# 3. hook を揃える (下の「hook」)。揃えられなくても次へ進む。
# 4. TMPDIR を確かめて揃える (下の「TMPDIR」)。外れれば exit 1。
# 5. run-checks.ts を exec し、hook を揃えた結果 (0: 揃えた、1: 揃えられなかった) を渡す。1 なら run-checks.ts は段を回し、最後に exit 1 する。
# 事前条件 (外れれば exit 1):
# - OS は Linux か macOS (uname -s が Linux か Darwin)。
# - bash 3.2 以降。
# - git 2.32 以降。rev-parse --path-format は 2.31 から (canon: facts/git/rev-parse-path-format-since-2-31)、テストが使う GIT_CONFIG_GLOBAL・GIT_CONFIG_SYSTEM は 2.32 から (canon: facts/git/config-sources-and-scopes)。
# - cmp・shellcheck・deno が PATH にあること。cmp が無ければ hook を揃えられないとし、shellcheck と deno は run-checks.ts と exec が確かめる。
# - ネットワークは、deno が依存 (npm) を未取得のときだけ要る。
# 入力:
# - 引数: 受けない。渡されたら exit 2。
# - $0: このファイルへのパス (相対でも絶対でもよい)。
#   - その dir に移るときは CDPATH を引かない (canon: facts/shell/cd-operand-inputs)。
#   - 最後の成分が symlink なら、その dir はリポでないので exit 2。
# - 環境変数:
#   - git の場所を決めるもの (git rev-parse --local-env-vars の一覧。canon: facts/git/local-env-vars-and-hook-env) は消す。git はこのファイルのあるリポだけを見る。
#   - 設定の差し替え (GIT_CONFIG_GLOBAL など) は一覧に無いので残る。hook の判定は、それを含めたこの環境についてのもの。
#   - TMPDIR: 下の「TMPDIR」。
# hook:
# - git は hook を $GIT_COMMON_DIR/hooks から呼ぶ (linked worktree も共有し、checkout で変わらない。canon: facts/git/hookspath-relative-resolves-per-worktree)。
# - 写しが揃うのは verify.sh を回したときだけ。作業ツリーの hooks/pre-push が変わっても (checkout を含む)、次の verify.sh まで写しは前のまま。
# - 揃えられないとき: 理由と、その状態で実行すれば直るコマンド (絶対パス) を stderr に出す。消すコマンドには、消すものの中身を確かめるよう添える。
# - core.hooksPath が (どの scope でも) 設定されていれば、揃えられないとする。写す先は既定の置き場のままで、下の表どおりに写す。
#   - 既定の置き場を指していても同じ。git rev-parse --git-path は hooks の symlink を解決したパスを出し、既定の置き場と比べられない (canon: facts/git/rev-parse-absolute-path-resolves-symlinks)。
#   - 示すコマンドは出どころ (canon: facts/git/config-sources-and-scopes の「--show-origin の出力の形」) ごとに決める:
#     - file: git config --file <絶対パス> --unset-all core.hooksPath。
#     - file でない (command line など): 示すコマンドは無く、出どころを示す。
# - 置き方: 一時ファイルに写し、ln -n で写す先に置く。
#   - ln は写す先に何か在れば置かずに失敗する。ディレクトリだけはその中に作るので、置く前の分類で拒否する (canon: facts/shell/ln-hard-link-existing-destination)。
#   - 置けなければ、もう一度下の表で分類する。分類の後に置かれたものも、上書きせずにその行の扱いになる。
#   - 同じ common dir で並行に走る verify.sh にも、書きかけは見えない。
# - 写す元 (hooks/pre-push) と写す先 ($GIT_COMMON_DIR/hooks/pre-push) の状態ごとの扱いと、示すコマンド:
#   - hooks が無い: 作って写す。
#   - hooks がディレクトリでない (通常ファイル・壊れた symlink・FIFO など): 落ちる。rm -f・mkdir・install。
#   - hooks がディレクトリ (それへの symlink を含む) で、pre-push が:
#     - 無い: 写す。
#     - 同じ中身の通常ファイル (それへの symlink を含む): 実行可能でなければ chmod +x。chmod が落ちれば落ちる。chmod +x。
#     - 違う中身 (旧版、利用者の別の hook、手を入れた写し): このリポのものかを中身から決められないので落ちる。rm -f・install。
#     - 比べられない (読めないなど。cmp が 0・1・127 以外で終わる): 落ちる。rm -f・install。
#     - 比べられない (cmp が PATH に無い): 落ちる。示すのは cmp を入れること。
#     - ディレクトリ (それへの symlink を含む): 落ちる。rm -rf・install。
#     - 通常ファイルでもディレクトリでもない (FIFO など。cmp が読むと止まる): 落ちる。rm -f・install。
#     - 壊れた symlink: ln が置けないので落ちる。rm -f・install。
#   - 写せない (書けないなど): 落ちる。mkdir -p・install。
# TMPDIR の値ごとの扱い (deno の --allow-write と run-checks.ts に渡す。外れれば exit 1):
# - 未設定・空: /tmp として下の行で扱う。
# - 相対パス: 落ちる。
# - 無い・ディレクトリでない・入れない: 落ちる。理由は cd が出す。
# - 書けない ([ -w ] が偽): 落ちる。
# - 在る、入れる、書けるディレクトリ (symlink を含む): symlink を解決した絶対パスにする。
#   - それが `,` を含む: --allow-write の区切りと読まれる (canon: facts/deno/allow-flag-comma-separates-values) ので落ちる。deno が --allow-write の値の `,` を escape できるようになったら外せる。
set -euo pipefail
die() {
  echo "verify.sh: $1" >&2
  exit 1
}
if [ $# -ne 0 ]; then
  echo "verify.sh: 引数は受けない ($*)。./verify.sh だけで回す" >&2
  exit 2
fi
if [ -L "$0" ]; then
  echo "verify.sh: $0 は symlink で、その dir はリポでない。リポの verify.sh を直に起動する" >&2
  exit 2
fi
os=$(uname -s)
case $os in
Linux | Darwin) ;;
*) die "OS が Linux でも macOS でもない ($os)。Linux か macOS で回す" ;;
esac
if [ "${BASH_VERSINFO[0]}" -lt 3 ] ||
  { [ "${BASH_VERSINFO[0]}" -eq 3 ] && [ "${BASH_VERSINFO[1]}" -lt 2 ]; }; then
  die "bash が 3.2 以降でない ($BASH_VERSION)。bash 3.2 以降で回す"
fi
# dirname が - だけのとき、/. が無いと cd は OLDPWD に移る
CDPATH='' cd -- "$(dirname -- "$0")/."
git_version=$(git --version)
version_re='^git version ([0-9]+)\.([0-9]+)'
if ! [[ $git_version =~ $version_re ]] || [ "${BASH_REMATCH[1]}" -lt 2 ] ||
  { [ "${BASH_REMATCH[1]}" -eq 2 ] && [ "${BASH_REMATCH[2]}" -lt 32 ]; }; then
  die "git が 2.32 以降でない ($git_version)。git 2.32 以降を PATH の先に置く"
fi
local_env=$(git rev-parse --local-env-vars)
while IFS= read -r v; do unset "$v"; done <<<"$local_env"

hook_failed=0
fail() {
  echo "$1" >&2
  hook_failed=1
}
# 理由と、その状態で実行すれば直るコマンドを出す。$3 はコマンドの前に添える文
fix_by() {
  fail "$1。${3:-}Execute: $2"
}
# 利用者のものを消しうるコマンドで直すとき
refuse() {
  fix_by "$1" "$2" "消すものの中身を確かめ、よければ "
}

common=$(git rev-parse --path-format=absolute --git-common-dir)
hooks=$common/hooks
hook=$hooks/pre-push
# -z でないと、origin のパスの特殊な文字が C の quote で出る (canon: facts/git/config-sources-and-scopes の「--show-origin の出力の形」)
hooks_path_shown=
unset_cmd=
not_file=
while IFS= read -r -d '' scope && IFS= read -r -d '' origin && IFS= read -r -d '' value; do
  hooks_path_shown="${hooks_path_shown:+$hooks_path_shown; }$scope $origin $value"
  case $origin in
  file:/*) file=${origin#file:} ;;
  file:*) file=$PWD/${origin#file:} ;;
  *)
    not_file="${not_file:+$not_file、}$scope の $origin"
    continue
    ;;
  esac
  one="git config --file $(printf %q "$file") --unset-all core.hooksPath"
  case $unset_cmd in
  *"$one"*) ;;
  *) unset_cmd=${unset_cmd:+$unset_cmd && }$one ;;
  esac
done < <(git config -z --show-origin --show-scope --get-all core.hooksPath)
if [ -n "$hooks_path_shown" ]; then
  reason="core.hooksPath が設定されている ($hooks_path_shown)。hook は $hooks に置くので消す"
  if [ -n "$not_file" ]; then
    reason="$reason。file でない出どころ ($not_file) からは、その出どころで外す"
  fi
  if [ -n "$unset_cmd" ]; then
    refuse "$reason" "$unset_cmd"
  else
    fail "$reason"
  fi
fi

src=$PWD/hooks/pre-push
q_hooks=$(printf %q "$hooks")
q_hook=$(printf %q "$hook")
install_cmd="install -m 755 $(printf %q "$src") $q_hook"
replace_cmd="rm -f $q_hook && $install_cmd"
# 写す先に在るものを分類して扱う。何も無ければ 1 を返す
handle_existing() {
  if [ ! -d "$hooks" ] && { [ -e "$hooks" ] || [ -L "$hooks" ]; }; then
    refuse "$hooks: ディレクトリでない" "rm -f $q_hooks && mkdir $q_hooks && $install_cmd"
  elif [ -d "$hook" ]; then
    refuse "$hook: ディレクトリ" "rm -rf $q_hook && $install_cmd"
  elif [ -f "$hook" ]; then
    # 違いは stdout に出るので捨て、比べられない理由 (stderr) だけを見せる
    compared=0
    cmp "$src" "$hook" >/dev/null || compared=$?
    case $compared in
    0)
      # 実行可能なら chmod しない: 他の uid が持つファイルへの chmod は EPERM で落ちる
      if [ ! -x "$hook" ] && ! chmod +x "$hook"; then
        fix_by "$hook: 実行可能にできない (理由は上の chmod)" "chmod +x $q_hook"
      fi
      ;;
    1) refuse "$hook: hooks/pre-push と中身が違う" "$replace_cmd" ;;
    127) fail "$hook: cmp が PATH に無く、hooks/pre-push と比べられない。cmp を入れてから回し直す" ;;
    *) refuse "$hook: hooks/pre-push と比べられない (理由は上の cmp)" "$replace_cmd" ;;
    esac
  elif [ -e "$hook" ]; then
    refuse "$hook: 通常のファイルでない" "$replace_cmd"
  elif [ -L "$hook" ]; then
    refuse "$hook: 壊れた symlink" "$replace_cmd"
  else
    return 1
  fi
}
# 写す先に何も無いときだけ置く。在れば ln が失敗する
place() {
  tmp=$hook.verify-$$
  # bash は SIGHUP・SIGINT・SIGTERM で終わるときも EXIT trap を回す (canon: facts/shell/bash-exit-trap-runs-on-fatal-signal)
  trap 'rm -f "$tmp"' EXIT
  placed=0
  { mkdir -p "$hooks" && install -m 755 "$src" "$tmp" && ln -n -- "$tmp" "$hook"; } || placed=1
  rm -f "$tmp"
  trap - EXIT
  return "$placed"
}
if ! handle_existing; then
  if place; then
    echo "$hook: hooks/pre-push を写した"
  elif ! handle_existing; then
    fix_by "$hook: hooks/pre-push を写せない (理由は上)" "mkdir -p $q_hooks && $install_cmd"
  fi
fi

TMPDIR=${TMPDIR:-/tmp}
case $TMPDIR in
/*) ;;
*) die "TMPDIR ($TMPDIR) が相対パス。絶対パスを TMPDIR に設定する" ;;
esac
# deno の --allow-write はパスの綴りで照合する (canon: facts/deno/permission-paths-not-resolved) ので、exec の環境の TMPDIR と同じ綴りで渡す。
TMPDIR=$(cd "$TMPDIR" && pwd -P) ||
  die "TMPDIR に cd できない (値と理由は上の cd)。在る、入れるディレクトリを TMPDIR に設定する"
if [ ! -w "$TMPDIR" ]; then
  die "TMPDIR ($TMPDIR) に書けない。書けるディレクトリを TMPDIR に設定する"
fi
case $TMPDIR in
*,*) die "TMPDIR ($TMPDIR) が , を含む。, を含まないディレクトリを TMPDIR に設定する" ;;
esac
export TMPDIR
# Deno.kill で段のプロセスグループに送るには、パスを付けない --allow-run が要る (canon: facts/deno/command-spawn の「Deno.kill」)。パスで絞った --allow-run で通るようになったら、段が起動するもの (git・shellcheck・deno) に絞る。
# 段の子の環境から変数を消すには、Deno.env.toObject で環境を丸ごと写す。それには変数を絞らない --allow-env が要る (canon: facts/deno/env-to-object-requires-unscoped-allow-env)。
exec deno run --frozen-lockfile --allow-run --allow-env --allow-write="$TMPDIR" --allow-read=deno.json scripts/run-checks.ts "$hook_failed"
