#!/usr/bin/env bash
# このリポの単一検証コマンド。hook を揃えてから scripts/run-checks.ts を exec し、hook の段の結果を引数で渡す。引数の値は次のどれか:
# - 0: 揃えた。
# - 1: 揃えられなかったか、写す途中の一時ファイルの rm -f が落ちた。
# 検査の規則の本文は scripts/run-checks.ts の先頭にある。
# 事前条件 (外れれば exit 1。PATH の道具が無いときは下の「PATH にあるもの」、git の失敗は下の「git の失敗」):
# - OS は Linux か macOS (uname -s が Linux か Darwin)。
# - bash 3.2 以降。
# - git 2.32 以降。
#   - rev-parse --path-format は 2.31 から (canon: facts/git/rev-parse-path-format-since-2-31)、テストが使う GIT_CONFIG_GLOBAL・GIT_CONFIG_SYSTEM は 2.32 から (canon: facts/git/config-sources-and-scopes)。
#   - 次は git 2.43.0 で測った (git 2.32〜2.42: 測っていない)。
#     - hook の判定が読む config -z --show-origin の並び (canon: facts/git/config-sources-and-scopes)。
#     - run-checks.ts が読む ls-files -s -t の形 (canon: facts/git/repository-shapes)。
#   - verify.sh と run-checks.ts が読む rev-parse --local-env-vars の一覧 (canon: facts/git/local-env-vars-and-hook-env)。測った版での出方:
#     - git 2.43.0: GIT_DIR に存在しないパスを入れても、同じ 15 個を同じ順で出した。測ったのは GIT_DIR だけ。
#     - git 2.55.0 (macOS): 値を変えずに一覧を出した。
#   - 一覧の各行が ^GIT_[A-Z_]+$ (A-Z は ASCII の大文字だけ) に合わなければ落ちる。リポの中の git は、知らない option を名前のまま出して exit 0 で終わる (同じ canon の「知らない option」)。
# - このファイルの dir の状態ごとの扱い (canon: facts/git/repository-shapes の「スクリプトを置いた dir の位置」):
#   - 本体の作業ツリーのルート: 回す。
#   - linked worktree のルート: 回す。hook は common git dir に写す (下の「hook」)。
#   - 親のリポの subdirectory (git が追跡するディレクトリに展開した写しなど): 落ちる。そのまま回すと git は親のリポを見て、hook を親のリポに写し、検査の対象も subdirectory の下に限られる。
#   - git の作業ツリーでない: 落ちる。次のどれか (リポの外と持ち主の違いは、理由を git rev-parse が出す):
#     - リポの外。
#     - git dir の中。
#     - bare のリポ。
#     - safe.directory が要る持ち主の違い。
# - PATH にあるもの。無いものは前もって確かめず、使う所で外れる:
#   - bash: 1 行目の env が見つけられず exit 127 (canon: facts/shell/env-utility-not-found-exit-127)。
#   - uname・dirname・git: その行で exit 127 で止まる (set -e。canon: facts/shell/bash-command-not-found-exit-127)。hook に触れる前。
#   - mkdir・install・ln: hook を写すときだけ使う。無ければ写せないので、hook を揃えられないとする (下の「写せない」)。
#   - rm: 写す途中の一時ファイルを rm -f で消す。写せたときも、写す前に落ちたときも消す。rm -f が落ちたとき (rm が無いときを含む):
#     - 一時ファイルが残りうることと、消すコマンドを出す。
#     - hook の段の結果を 1 にする (写せていれば、hook はそのまま)。
#   - cmp: 写す先に通常ファイルの pre-push が在るときだけ使う。無ければ hook を揃えられないとする (下の写す先の表)。
#   - chmod: 写す先の pre-push が同じ中身で実行可能でないときだけ使う。無ければ hook を揃えられないとする (同じ表)。
#   - deno: 無ければ、hook を揃えた後の最後の exec が exit 127 で終わる (canon: facts/shell/bash-exec-missing-command-exit-status)。
#   - shellcheck: run-checks.ts が確かめる。
#   - deno test の段のテストが使うもの:
#     - sh・env・printenv・sleep・mkfifo・find。
#     - Linux では次のもの。Ubuntu 以外の distribution の package は確かめていない。
#       - localedef と、それが読む locale の定義 en_US と charmap UTF-8 (canon: facts/glibc/localedef-and-locpath-inputs)。Ubuntu では package locales が置く (同じ canon の「観測」)。
#       - C.UTF-8 の locale。Ubuntu では package libc-bin が置く (同じ canon の「観測」)。
# - git の失敗: git が非 0 で終われば、その行で git の終了コードで止まる (set -e)。除くのは、作業ツリーの判定 (上の「このファイルの dir の状態」) と core.hooksPath の読み (下の「hook」)。
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
#   - git config --get-all の終了コード (canon: facts/git/config-sources-and-scopes の「--get・--get-all の終了コード」): 0 は設定あり、1 は設定なし、他は読めないので揃えられないとする。
#   - 出どころは file だけ (command scope の変数は上で消した。canon の同じページの「--show-origin の出力の形」)。file でなければ想定外として exit 1。
#   - 示すコマンドは、出どころのファイルごとの git config --file <絶対パス> --unset-all core.hooksPath。
# - 置き方: 一時ファイルに写し、ln -n で写す先に置く。
#   - ln は写す先に何か在れば置かずに失敗する。ディレクトリだけはその中に作るので、置く前の分類で拒否する (canon: facts/shell/ln-hard-link-existing-destination)。
#   - 置けなければ、もう一度下の写す先の表で分類する。分類の後に置かれたものも、その行の扱いになる。
#   - 同じ common dir で並行に走る verify.sh にも、書きかけは見えない。
#   - SIGKILL では EXIT trap が回らず、一時ファイル $hook.verify-$$ (写す先の pre-push の名前に .verify-<pid> を足したもの) が残りうる (canon: facts/shell/bash-exit-trap-skipped-on-sigkill)。git はこれを hook として呼ばない (canon: facts/git/hook-found-by-exact-name)。
# - 写す元 (作業ツリーの hooks/pre-push) の状態ごとの扱いと、示すコマンド。写す先を扱う前に分類し、写す先へ進まないものは写す先に触れない:
#   - 通常ファイル (それへの symlink を含む) で、読める: 下の写す先の表へ進む。
#   - 通常ファイル (それへの symlink を含む) で、読めない: 落ちる。chmod u+r。
#   - 無い: 落ちる。git -C <リポ> checkout -- hooks/pre-push。
#   - 他 (壊れた symlink・ディレクトリ・FIFO など): 落ちる。git -C <リポ> checkout -- hooks/pre-push。ディレクトリなら中のものごと置き換える (canon: facts/git/checkout-path-restores-any-worktree-kind)。
# - 写す先 ($GIT_COMMON_DIR/hooks/pre-push) の状態ごとの扱いと、示すコマンド:
#   - hooks が無い: 作って写す。
#   - hooks がディレクトリでない (通常ファイル・壊れた symlink・FIFO など): 落ちる。rm -f・mkdir・install。
#   - hooks がディレクトリ (それへの symlink を含む) で、pre-push が:
#     - 無い: 写す。
#     - 写す元と同じ中身の通常ファイル (それへの symlink を含む): 実行可能でなければ chmod +x する。chmod が落ちれば落ちる。chmod +x。
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
# - 在る、入れるディレクトリ (symlink を含む): symlink を解決した絶対パスにする。
#   - それが `,` を含む: --allow-write の区切りと読まれる (canon: facts/deno/allow-flag-comma-separates-values) ので落ちる。deno が --allow-write の値の `,` を escape できるようになったら外せる。
#   - 書けるかは、`.ts` があるときだけ、段の一時ディレクトリを作れるかで run-checks.ts が判定する (作れなければ、それを使う段が落ちる)。
set -euo pipefail
# $2 は終了コード (既定は 1)
die() {
  echo "verify.sh: $1" >&2
  exit "${2:-1}"
}
if [ $# -ne 0 ]; then
  die "引数は受けない ($*)。./verify.sh だけで回す" 2
fi
if [ -L "$0" ]; then
  die "$0 は symlink で、その dir はリポでない。リポの verify.sh を直に起動する" 2
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
dir=$(dirname -- "$0")
# dirname が - だけのとき、/. が無いと cd は OLDPWD に移る (canon: facts/shell/cd-operand-inputs)
CDPATH='' cd -- "$dir/."
git_version=$(git --version)
version_re='^git version ([0-9]+)\.([0-9]+)'
if ! [[ $git_version =~ $version_re ]] || [ "${BASH_REMATCH[1]}" -lt 2 ] ||
  { [ "${BASH_REMATCH[1]}" -eq 2 ] && [ "${BASH_REMATCH[2]}" -lt 32 ]; }; then
  die "git が 2.32 以降でない ($git_version)。git 2.32 以降を PATH の先に置く"
fi
local_env=$(git rev-parse --local-env-vars)
# 範囲 (A-Z) は locale で ASCII の外の大文字を含みうるので、文字を並べる (canon: facts/shell/bash-regex-range-locale)
name_re='^GIT_[ABCDEFGHIJKLMNOPQRSTUVWXYZ_]+$'
while IFS= read -r v; do
  [[ $v =~ $name_re ]] ||
    die "git rev-parse --local-env-vars の出力に、変数の名前でない行がある ($v)。git の版を確かめる"
  unset "$v"
done <<<"$local_env"
worktree=$(git rev-parse --is-inside-work-tree --show-prefix) ||
  die "$PWD を git の作業ツリーとして読めない (理由は上の git)。リポの verify.sh を、git が読めるようにしてから回す"
# ルートでは true と空の行、subdirectory では true と <prefix>/ を出す
case $worktree in
true) ;;
true?*) die "$PWD は作業ツリーのルートでなく、親のリポの ${worktree#true?} にある。リポのルートの verify.sh を回す" ;;
*) die "$PWD は git の作業ツリーでない (git dir の中か bare のリポ)。リポの作業ツリーのルートの verify.sh を回す" ;;
esac
common=$(git rev-parse --path-format=absolute --git-common-dir)

hook_failed=0
fail() {
  echo "$1" >&2
  hook_failed=1
}
# 理由と、その状態で実行すれば直るコマンドを出す
fix_by() {
  fail "$1。Execute: $2"
}
# 利用者のものを消しうるコマンドで直すとき
refuse() {
  fail "$1。消すものの中身を確かめ、よければ Execute: $2"
}

hooks=$common/hooks
hook=$hooks/pre-push
hooks_path_shown=
unset_cmd=
config_exit=
# git config -z の出力は (scope, origin, value) の 3 つ組の列 (canon: facts/git/config-sources-and-scopes の「--show-origin の出力の形」)
while IFS= read -r -d '' scope; do
  case $scope in
  exit\ *)
    config_exit=${scope#exit }
    break
    ;;
  esac
  IFS= read -r -d '' origin
  IFS= read -r -d '' value
  hooks_path_shown="${hooks_path_shown:+$hooks_path_shown; }$scope $origin $value"
  case $origin in
  file:/*) file=${origin#file:} ;;
  file:*) file=$PWD/${origin#file:} ;;
  *) die "core.hooksPath の出どころ ($scope $origin) が file でない。想定外。verify.sh の不具合として報告する" ;;
  esac
  one="git config --file $(printf %q "$file") --unset-all core.hooksPath"
  case $unset_cmd in
  *"$one"*) ;;
  *) unset_cmd=${unset_cmd:+$unset_cmd && }$one ;;
  esac
done < <(
  # 置換の中にも set -e が効くので、終了コードは || で受ける (canon: facts/shell/bash-process-substitution-inherits-errexit)
  status=0
  # -z でないと、origin のパスの特殊な文字が C の quote で出る (canon: facts/git/config-sources-and-scopes の「--show-origin の出力の形」)
  git config -z --show-origin --show-scope --get-all core.hooksPath || status=$?
  # 子が書けたときは、git の終了コードを exit の項目で渡す
  printf 'exit %s\0' "$status"
)
case $config_exit in
0) refuse "core.hooksPath が設定されている ($hooks_path_shown)。消す" "$unset_cmd" ;;
1) ;;
'') fail "core.hooksPath が設定されているかを読めない (読み取りが途中で終わった)。回し直す" ;;
*) fail "core.hooksPath が設定されているかを読めない (git config が exit $config_exit。理由は上の git)。直してから回し直す" ;;
esac

src=$PWD/hooks/pre-push
q_hooks=$(printf %q "$hooks")
q_hook=$(printf %q "$hook")
install_cmd="install -m 755 $(printf %q "$src") $q_hook"
replace_cmd="rm -f $q_hook && $install_cmd"
# 写す元を分類する。写す先へ進めるなら 0
check_source() {
  local restore
  restore="git -C $(printf %q "$PWD") checkout -- hooks/pre-push"
  if [ -f "$src" ]; then
    [ -r "$src" ] && return 0
    fix_by "$src: 読めない。写す先には触れていない" "chmod u+r $(printf %q "$src")"
  elif [ -e "$src" ] || [ -L "$src" ]; then
    refuse "$src: 通常のファイルでない。写す先には触れていない" "$restore"
  else
    fix_by "$src: 無い。写す先には触れていない" "$restore"
  fi
  return 1
}
# 写す先に在るものを分類して扱う。在れば 0、何も無ければ 1
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
      # 実行可能なら chmod しない: 他の uid が持つファイルへの chmod は EPERM で落ちる (canon: facts/shell/chmod-non-owner-eperm)
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
  return 0
}
# 写す先に何も無いときだけ置く。在れば ln が失敗する
place() {
  tmp=$hook.verify-$$
  # bash は SIGHUP・SIGINT・SIGTERM で終わるときも EXIT trap を回す (canon: facts/shell/bash-exit-trap-runs-on-fatal-signal)
  trap 'rm -f "$tmp"' EXIT
  placed=0
  { mkdir -p "$hooks" && install -m 755 "$src" "$tmp" && ln -n -- "$tmp" "$hook"; } || placed=1
  if ! rm -f "$tmp"; then
    fix_by "$tmp: 写す途中の一時ファイルの rm -f が落ち、残っているかもしれない (理由は上の rm)" "rm -f $(printf %q "$tmp")"
  fi
  trap - EXIT
  return "$placed"
}
if check_source && ! handle_existing; then
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
case $TMPDIR in
*,*) die "TMPDIR ($TMPDIR) が , を含む。, を含まないディレクトリを TMPDIR に設定する" ;;
esac
export TMPDIR
# 段の子の deno は別のプロセスで、下の 4 つの flags を受けない (run-checks.ts の先頭の規則。canon: facts/deno/child-process-permissions)
flags=(
  # Deno.kill で段のプロセスグループに送るには、パスを付けない --allow-run が要る (canon: facts/deno/command-spawn の「Deno.kill」)。パスで絞った --allow-run で通るようになったら、段が起動するもの (git・shellcheck・deno) に絞る。
  --allow-run
)
# 段の子の環境から変数を消すには、Deno.env.toObject で環境を丸ごと写す。それには変数を絞らない --allow-env が要る (canon: facts/deno/env-to-object-requires-unscoped-allow-env)。
flags+=(--allow-env)
# 段の一時ディレクトリを作って消す
flags+=("--allow-write=$TMPDIR")
# deno.json の imports を読む
flags+=(--allow-read=deno.json)
exec deno run "${flags[@]}" scripts/run-checks.ts "$hook_failed"
