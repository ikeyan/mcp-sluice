#!/bin/bash
# ikeyan/agent-files の部品のうち、このリポの .agent-sync/archetype が合成するものを描画し、作業ツリーに当てる。当てた結果は人が git diff で確かめてコミットする。
#
# 使い方: .agent-sync/sync.sh (引数なし)。対象はカレントディレクトリの git の作業ツリーで、このスクリプトはその作業ツリーのルートの .agent-sync/ にあるものでなければならない (違えば最初に落ちる。ルートは cwd から、render.sb はこのスクリプトのディレクトリから決めるので、別のリポのものを起動すると食い違う)。
# 標準出力は最後の `git status --short` だけ。archetect の標準出力は標準エラーへ回す。
# 入力 (作業ツリーのルートの .agent-sync/ の下):
#   archetype/archetype.yaml  `source: https://<host>/<path>/<名前>.git#<40 桁の小文字 16 進の sha>` の形の行がちょうど 1 つ (名前は A-Z a-z 0-9 . _ - で、. と .. でない)。この sha が上流の固定で、書き換えが更新。
#   archetype/archetype.lua   catalog.render で上流の部品を合成する。
#   answers.yaml              全ての問いの答え。
#   generated                 前回の sync が置いたものの一覧。1 行 1 件 `<パス><TAB><置いたバイトの id>`、パスは LC_ALL=C の順で重複なし。初回は空のファイル。id は `git hash-object --no-filters` (git が使うオブジェクトの形式のハッシュで、sha1 のリポは 40 桁・sha256 のリポは 64 桁の小文字 16 進。改行・変換を通さないバイトそのもの。canon: facts/git/checkout-filters-vs-raw-blob)。
#   描画に渡すのは archetype/ と answers.yaml のうち、追跡しているか無視されていないファイルの写しだけ。
# 読む環境: PATH (git・archetect・realpath・awk・find と、macOS では sandbox-exec と otool、Linux では bwrap と ldd)・TMPDIR・GIT_CONFIG_*。取り出し用の作業リポジトリは `git init --object-format=sha1 --template=` で作るので、GIT_DEFAULT_HASH・init.defaultObjectFormat・GIT_TEMPLATE_DIR・init.templateDir は結果に効かない (上流の固定は 40 桁の SHA-1。canon: facts/git/local-env-vars-and-hook-env)。
#   sandbox-exec (macOS) か bwrap (Linux) が PATH に無ければ、手順 2 の最初に固定の文言 `agent-sync: 描画を起動できない` で落ちる (起動前に `command -v` で確かめる。描画の終了状態 127 では、sandbox 内の archetect の終了と区別できない)。
#   awk は POSIX の awk で、正規表現の区間 `{n}` に頼らない (mawk 1.3.4-20200724 より前は既定で区間が無い。canon: facts/shell/awk-interval-expressions)。
#   archetect は `archetect --version` が `archetect 3.6.1` (canon: facts/archetect と CI の verify.yml が固定する版) のものだけ。違えば落ちる。
#   TMPDIR は書き込める既存のディレクトリの絶対パス (未設定は /tmp。相対パスだと作業ディレクトリが cwd のリポの中にできるので、最初に落ちる)。その下に作る作業ディレクトリの解決済みのパスは、A-Z a-z 0-9 . _ / - だけ (archetect の設定の YAML と render.sb に引用せずに書くため)。違えば落ちる。
#   git は GIT_CONFIG_*・GIT_CONFIG_PARAMETERS・GIT_CONFIG_GLOBAL・GIT_CONFIG_SYSTEM と設定 (url.<base>.insteadOf など) を読む。ただし core.autocrlf・core.eol・属性 (.gitattributes・info/attributes・core.attributesFile) は読まない: 手順 1 は上流の中身を blob のバイトのまま作り、生成物の id は --no-filters で取る (checkout はそれらで中身を変える。canon: facts/git/checkout-filters-vs-raw-blob)。
#   リポジトリの場所を決める GIT_* は読まない: `git rev-parse --local-env-vars` が挙げる変数のうち GIT_CONFIG・GIT_CONFIG_PARAMETERS・GIT_CONFIG_COUNT 以外が 1 つでも設定されていれば、起動の最初に落ちる (git の hook や `git rebase --exec` から起動すると、`git -C` は GIT_DIR などに勝てず、手順 1 の init・fetch・checkout が利用者のリポジトリに当たる。canon: facts/git/local-env-vars-and-hook-env)。
#   LANG・LC_* は読まない: 起動の最初に LC_ALL=C を export する (bash 3.2 の glob の範囲は UTF-8 の locale で非 ASCII の文字を通す。canon: facts/shell/locale-dependent-ranges)。
#   archetect は空の環境に HOME (作業ディレクトリの下) だけを足して起動するので、ARCHETECT_*・XDG_*・git の global config は描画に届かない (canon: facts/archetect/inputs)。
# ネットワーク: 手順 1 の git fetch だけ。上流は対話的な資格情報なしで取れること (公開の https)。fetch には GIT_TERMINAL_PROMPT=0 を付け、端末で問い合わせて排他を握ったまま待たない。プロキシ・CA・credential helper・GIT_ASKPASS は利用者の環境のもので、git が読む (GIT_ASKPASS が設定されていれば GIT_TERMINAL_PROMPT=0 でも askpass は問い合わせうる。canon: facts/git/fetch-credential-prompts-and-env)。
# 排他: 作業ツリーごとに `$(git rev-parse --absolute-git-dir)/agent-sync.lock` を mkdir で取り、同じ作業ツリーの同時の起動は 2 つ目が落ちる。終わるとき (落ちるときも) 消す。kill -9 などで残ったら、起動中の sync.sh が無いことを確かめて手で消す。
#
# 手順:
#   1. 取得: 固定した sha を git で浅く取り、tree の通常のファイル (mode 100644・100755) を、blob のバイトのまま `git ls-tree -r -z` と `git cat-file blob` で作る (mode は tree の値)。symlink (120000) と submodule (160000) は作らない (一覧が指せば手順 3 で通常のファイルでないとして落ちる)。パスに . .. .git (大文字小文字によらない) の名前か改行があれば落ちる。上流のパスは非 ASCII でもよい (日本語の名前など)。tree のパスは互いに別だが、ファイルシステムが別のパスを同じものとみなす (APFS の既定は大文字小文字と Unicode の正規化を同一視する。`README.md` と `readme.md`、KELVIN SIGN U+212A の `K` と ASCII の `K`、NFC と NFD の `é`) と、後の blob が先のものを黙って上書きして一覧が指した中身が別のものになる。この別名を綴りの規則 (大文字小文字の畳み込み) の再現で探さず、ファイルシステム自身の答えで見つける: ディレクトリは 1 つずつ作って綴りのまま覚え、覚えていないのに在る成分 (途中のディレクトリ) があれば別名と見て落ちる。blob を置く前に置き先のパスが既に在れば、同じく落ちる (取り出し先は空で、tree のパスは互いに別なので、在るのは別名だけ)。ディレクトリ同士の別名 (`Docs/a.md` と `docs/b.md`) も落ちる (合わせると、描画が 2 つの git のディレクトリのファイルを 1 つのディレクトリの中身として混ぜて読む)。区別するファイルシステムでは別名が無く、`README.md` と `readme.md` は両方置かれる。上流のパス・置き先・古いパスの名前は `-` で始まってもよい: 外部コマンドへ渡すパスは、絶対パスの基点を前置するか、パラメータ展開で扱うか、`--` の後に置き、裸の相対パスをオペランドにしない (canon: facts/shell/string-input-categories の先頭の `-`)。上流のコードは実行しない。
#   2. 描画: archetect を OS の sandbox (macOS は sandbox-exec と render.sb、Linux は bwrap) で動かす。ネットワーク無し。読めるのは入力の写し・取得した上流・archetect とその共有ライブラリだけ、書けるのは空の出力ディレクトリだけ。
#   3. 計画: 下の定義域を全て検査する。違反があれば作業ツリーに触れずに終わる。
#   4. 適用: 古いパスを消し、新しい・変わったファイルを置き、mode を揃え、generated を書き換える。古いパスの削除は記録したファイルだけで、ディレクトリは消さない (generated はファイルしか記録せず、git は空のディレクトリを追跡しないので、空になったものが前回の出力か利用者のものか区別できない)。
#
# 描画の出力の定義域:
#   - 通常のファイルとディレクトリだけ。
#   - 通常のファイルのパス (一覧を含む) は、全て下のパスの定義域に入る。違えば手順 3 の最初に落ちる (一覧の - の行の突き合わせも、一覧の読み出しも、パスを改行区切りで扱うため。出力の走査は NUL 区切り)。
#   - .agent-sync/files/<部品名> (直下の通常のファイル) は置くファイルの一覧で、1 行 1 件 `<上流のパス><TAB><置き先のパス><TAB><mode>`。一覧そのものは作業ツリーに置かない。
#     - 上流のパス: 取得した上流の中の通常のファイル (それも途中のディレクトリも symlink でない)。バイトをそのまま置き先に写す。`-` なら、描画の出力の置き先と同じパスのファイルを置く。
#     - 置き先のパス: 作業ツリーのルートからの相対パス。
#     - mode: 644 か 755。
#   - パスは / で区切った 1 つ以上の名前。名前は POSIX の可搬なファイル名の文字 (A-Z a-z 0-9 . _ -) だけで、. と .. でない。置き先は大文字小文字によらず .git の名前を含まない。
#   - 置き先は全ての一覧を通して、大文字小文字によらず 1 回だけ (後勝ちにしない)。別の置き先の親のディレクトリと同じ (`foo` と `foo/bar`) 置き先も許さない (大文字小文字によらない。mkdir が失敗するか、`foo` が `foo/` の中へ入る)。
#   - 大文字小文字によらず等しいディレクトリの成分は、全ての置き先で同じ綴り (`Docs/b.md` と `docs/a.md` は落ちる。大文字小文字を区別しないファイルシステムでは 1 つのディレクトリに入り、以後の起動が手順 3 の綴りの検査で落ち続ける)。
#   - 置き先の最初の名前が .agent-sync (大文字小文字によらない) なら、`.agent-sync/sync.sh` と `.agent-sync/render.sb` (agent-sync の部品が置くもの) だけを許す。archetype/・answers.yaml・generated は sync.sh の入力で、上流に書かせない。
#   - 一覧の外の描画の出力は、`-` の行の置き先と 1 対 1 に対応する。
#   - 置き先の中に、.agent-sync/sync.sh がある (agent-sync の部品を合成している。描画が一覧を 1 つも出さなくても成功するので、無ければ generated の全てが古いパスになり sync.sh 自身まで消える)。
# 作業ツリーの定義域 (置き先と、generated にあって置き先に無い古いパス。generated も上のパスと .agent-sync/ の規則に従う):
#   - 途中のディレクトリは、無いか symlink でないディレクトリ。
#   - 既存の成分 (途中のディレクトリも最後の名前も) の綴りは、要求した綴りと完全に等しい。大文字小文字・Unicode の正規化を同一視するファイルシステム (macOS の APFS の既定) では、`[ -e ]` も open も別の綴りの既存のものに当たる (`readme.md` に利用者の `README.md`、`docs/` に `Docs/`、ASCII の `K` に KELVIN SIGN)。綴りの規則は再現せず、親の一覧に要求した綴りと完全に等しい名前が在るかをファイルシステムに聞き、無ければ別名として落ちる (別名の項目は、同じファイルに当たる (`-ef`) 一覧の項目から示す。特定できなければ固定の文言)。置き先の名前は ASCII だけなので、完全一致は find の -name (バイトの比較) で足りる。区別するファイルシステムでは別のファイルで、どちらも許す (canon: facts/shell/case-insensitive-filesystem-path-resolution)。
#     - 上流が置き先を綴りだけ改名すると (`README.md` → `readme.md`)、別名を同一視するファイルシステムでは、前回 sync が置いた古い綴りに当たって落ち続ける。古い綴りを消してから起動し直す (落ちる文言は、別名の項目が generated にあって中身が記録した id と同じなら、利用者のファイルでなく前回の出力だと示す)。
#   - 成分の親のディレクトリは一覧が取れる (読めないディレクトリは、綴りを突き合わせられないので落ちる)。
#   - generated は 1 行 `<パス><TAB><id>`、パスは LC_ALL=C の順で重複なし、id は 40 桁か 64 桁の小文字 16 進。
#   - 空のディレクトリも含め、ディレクトリが置き先・古いパスにあれば落ちる (利用者のもの。置き先の途中のディレクトリは空でも使う)。
#   - 置き先・古いパスの現在の中身は、無いか、通常のファイル。symlink・ディレクトリ・その他は利用者のもので、generated にあっても落ちる (id が決まらない。symlink は先のものを書き換えさせないためにも置き換えない)。
# 同一性 (これだけが判定。git の状態・HEAD・追跡の有無・core.fileMode は見ない):
#   対象 = 作業ツリーのルートからの相対パスの通常のファイルの中身。鍵 = パス。id = `git hash-object --no-filters` (mode は含めず、置くときに毎回揃える)。
#   等しいとみなす = id が等しい。cur = 現在の中身の id、rec = generated に記録された id、new = 今回置くものの id。
#   | 状態                                                          | 置き先 (今回置くもの)        | 古いパス (generated にあって置き先に無い)       |
#   | 無い                                                          | 置く                         | 何もしない                                       |
#   | 通常のファイルで cur = new                                    | そのまま (mode は揃える)     | (置き先なので該当しない)                         |
#   | 通常のファイルで cur = rec かつ cur != new (前回の結果)       | 置き直す                     | cur = rec: 消す                                  |
#   | 通常のファイルで cur が rec とも new とも違う (利用者の変更。generated に無いパスは rec が無い) | 落ちる | 落ちる                                         |
#   | symlink・ディレクトリ・その他                                 | 落ちる                       | 落ちる                                           |
#   | パスの綴りが既存のものと別 (ファイルシステムは同じものとみなす) | 落ちる (中身が同じでも)    | 落ちる (中身が同じでも)                          |
#   利用者が生成物を編集して commit しても、cur が rec と違えば落ちる (今回置くものと同じなら利用者の変更でない)。前回の結果が未コミットでも cur = rec なので、続けて起動しても、手順 4 の途中で落ちた後に同じ入力で起動し直しても、同じ結果に収束する。
#   手順 4 の途中で落ちた後、入力 (上流の sha など) を変えて起動すると、generated に載っていない置き済みのファイルは今回置くものと違えば落ちる (消すか戻してから起動し直す)。
#   sync は既存の inode を書き換えない (中身も mode も)。手順 4 は新しい inode を rename で置くので、置き先が別のパスとの hard link でも、そのパスのバイトと mode は変わらない。
#   手順 3 を通った置き先は無いか通常のファイルなので、手順 4 の mv が symlink を通して書くことは無く、rm・mv が利用者の別の綴りのファイルに当たることも無い。
# 資源: 取るのは、作業ディレクトリ・ロック・手順 4 が置き先ごとと generated に 1 つずつ作る作業ツリーの一時ファイル (同じディレクトリの `.agent-sync.XXXXXX`。現在の 1 つを wt_tmp が持つ)。全て EXIT trap が解放する (cp・chmod・mv が失敗して落ちるときも、一時ファイルを作業ツリーに残さない)。
# 失敗: 手順 2 の描画が非 0 で終わると終了状態を示して落ちる。OS の sandbox を適用できなかった場合は固定の文言 `agent-sync: OS の sandbox を適用できない` で落ちる。それは描画の終了状態が、macOS では 71 かつ stderr に `sandbox-exec: sandbox_apply:` で始まる行 (canon: facts/claude-code/sandbox-exec-nested-apply-failure)、Linux では stderr に `bwrap: ` で始まる行 (bwrap が設定の失敗を出す書式。未測定) があるとき。手順 1〜3 のどこで落ちても作業ツリーは変わらない。手順 4 は検査済みのパスへの rm・mv・chmod だけだが、ファイルシステムの失敗で途中まで当たることはある (git status に出る)。起動し直せば、同一性の表に従って同じ結果に収束する。
set -euo pipefail

# 置き先と generated のパスの .agent-sync/ の規則 (描画の出力の定義域)。awk の本体の前に連ねる。
AWK_AGENT='
function agent_bad(p,   a) {
  split(p, a, "/")
  return tolower(a[1]) == ".agent-sync" && p != ".agent-sync/sync.sh" && p != ".agent-sync/render.sb"
}
'

main() {
  [ $# -eq 0 ] || { echo "usage: .agent-sync/sync.sh (引数なし)" >&2; exit 2; }
  local v
  for v in $(git rev-parse --local-env-vars); do
    case $v in GIT_CONFIG | GIT_CONFIG_PARAMETERS | GIT_CONFIG_COUNT) continue ;; esac
    [ -z "${!v+x}" ] || { echo "agent-sync: $v が設定されている。git の hook や git rebase --exec の中からは起動しない (git -C は $v に勝てず、利用者のリポジトリに当たる)" >&2; exit 1; }
  done
  export LC_ALL=C
  case ${TMPDIR:-/tmp} in /*) ;; *) echo "agent-sync: TMPDIR ${TMPDIR} が絶対パスでない" >&2; exit 1 ;; esac
  here=$(cd "$(dirname -- "$0")" && pwd -P)
  root=$(git rev-parse --show-toplevel)
  cfg=$root/.agent-sync
  [ "$here" = "$(cd "$root" && pwd -P)/.agent-sync" ] || { echo "agent-sync: このスクリプトの場所 $here が、カレントの作業ツリー $root の .agent-sync/ でない (そのリポの .agent-sync/sync.sh を、そのリポの中で起動する)" >&2; exit 1; }
  [ "$(archetect --version 2>/dev/null)" = "archetect 3.6.1" ] || { echo "agent-sync: archetect 3.6.1 が PATH に無い (見つかった版: $(archetect --version 2>&1 || true))" >&2; exit 1; }
  local f
  for f in archetype/archetype.yaml archetype/archetype.lua answers.yaml generated; do
    [ -f "$cfg/$f" ] || { echo "agent-sync: $cfg/$f が無い" >&2; exit 1; }
  done
  local pins url sha name
  pins=$(sed -nE 's|^[[:space:]]+source:[[:space:]]+(https://[^#[:space:]]+\.git)#([0-9a-f]{40})$|\1 \2|p' "$cfg/archetype/archetype.yaml")
  [ "$(printf '%s\n' "$pins" | grep -c .)" = 1 ] || { echo "agent-sync: $cfg/archetype/archetype.yaml に sha で固定した https の source の行がちょうど 1 つでない" >&2; exit 1; }
  read -r url sha <<<"$pins"
  # archetect の locals は <locals のパス>/<URL のパスのファイル名から .git を除いたもの> を探す (canon: facts/archetect/sources-pinning-and-cache)。
  name=$(basename "$url" .git)
  case $name in . | .. | *[!A-Za-z0-9._-]*) echo "agent-sync: source の URL のファイル名 $name.git が定義域の外" >&2; exit 1 ;; esac

  trap '[ -z "${run:-}" ] || rm -rf "$run"; [ -z "${wt_tmp:-}" ] || rm -f "$wt_tmp"; [ -z "${held:-}" ] || rmdir "$held"' EXIT
  local lock
  lock=$(git -C "$root" rev-parse --absolute-git-dir)/agent-sync.lock
  mkdir "$lock" 2>/dev/null || { echo "agent-sync: $lock がある (別の sync.sh が動いているか、強制終了の跡)。動いていなければ消す" >&2; exit 1; }
  held=$lock
  run=$(mktemp -d "${TMPDIR:-/tmp}/agent-sync.XXXXXX")
  # Seatbelt は解決済みのパスで照合する (macOS の /tmp は /private/tmp)。
  run=$(cd "$run" && pwd -P)
  # このパスを archetect の設定の YAML と render.sb の引数に、引用せずに書く。
  case $run in *[!A-Za-z0-9._/-]*) echo "agent-sync: 作業ディレクトリ $run に A-Z a-z 0-9 . _ / - 以外の文字がある (TMPDIR を変える)" >&2; exit 1 ;; esac
  src=$run/src/$name
  mkdir -p "$src" "$run/obj" "$run/ds" "$run/out" "$run/conf/home"

  # 1. 取得
  git -C "$run/obj" init -q --object-format=sha1 --template=
  GIT_TERMINAL_PROMPT=0 git -C "$run/obj" fetch -q --depth 1 "$url" "$sha"
  [ "$(git -C "$run/obj" rev-parse FETCH_HEAD)" = "$sha" ] || { echo "agent-sync: 取得した commit が $sha でない" >&2; exit 1; }
  git -C "$run/obj" ls-tree -r -z FETCH_HEAD | materialize "$run/obj" "$src"

  local p
  git -C "$root" ls-files -z -c -o --exclude-standard -- .agent-sync/archetype .agent-sync/answers.yaml |
    while IFS= read -r -d '' p; do
      [ -e "$root/$p" ] || [ -L "$root/$p" ] || continue
      mkdir -p "$run/ds/$(dirname "$p")"
      cp -P "$root/$p" "$run/ds/$p"
    done
  printf 'locals:\n  enabled: true\n  paths:\n    - %s\n' "$run/src" >"$run/conf/archetect.yaml"

  # 2. 描画
  local bin rc=0
  bin=$(realpath "$(command -v archetect)")
  local args=(render "$run/ds/.agent-sync/archetype" --destination . --headless --offline
    -c "$run/conf/archetect.yaml" -A "$run/ds/.agent-sync/answers.yaml")
  case $(uname -s) in
  Darwin)
    command -v sandbox-exec >/dev/null || { echo "agent-sync: 描画を起動できない (sandbox-exec が PATH に無い)" >&2; exit 1; }
    local profile=$run/conf/render.sb lib
    cp "$here/render.sb" "$profile"
    otool -L "$bin" | sed -nE '2,$s|^[[:space:]]+(.+) \(compatibility version .*\)$|\1|p' | while IFS= read -r lib; do
      case $lib in /usr/lib/* | /System/*) continue ;; esac
      for p in "$lib" "$(realpath "$lib")"; do
        case $p in *[\"\\]*) echo "agent-sync: profile に書けないパス: $p" >&2; exit 1 ;; esac
        printf '(allow file-read* file-map-executable (literal "%s"))\n' "$p"
      done
    done >>"$profile"
    (cd "$run/out" && env -i HOME="$run/conf/home" \
      "$(command -v sandbox-exec)" -f "$profile" -D BIN="$bin" -D KEG="$(dirname "$(dirname "$bin")")" \
      -D DS="$run/ds" -D SRC="$run/src" -D CONF="$run/conf" -D OUT="$run/out" \
      "$bin" "${args[@]}" </dev/null >&2 2>"$run/render.err") || rc=$?
    ;;
  Linux)
    command -v bwrap >/dev/null || { echo "agent-sync: 描画を起動できない (bwrap が PATH に無い)" >&2; exit 1; }
    # namespace には archetect とその共有ライブラリと入力しか無い。/bin/sh が無いので os.execute・io.popen は何も起動できない。
    # bwrap が作る root は書き込める tmpfs なので、--remount-ro / で外れた書き込みを消えずに失敗させる。
    local b=(--unshare-all --die-with-parent --new-session --clearenv --proc /proc --dev /dev)
    b+=(--ro-bind "$bin" "$bin")
    while IFS= read -r f; do
      b+=(--ro-bind "$f" "$f")
    done < <(ldd "$bin" | sed -nE 's|^[[:space:]]*[^[:space:]]+ => (/.+) \(0x[0-9a-f]+\)$|\1|p; s|^[[:space:]]*(/.+) \(0x[0-9a-f]+\)$|\1|p')
    b+=(--ro-bind "$run/ds" "$run/ds" --ro-bind "$run/src" "$run/src" --ro-bind "$run/conf" "$run/conf"
      --bind "$run/out" "$run/out" --chdir "$run/out" --setenv HOME "$run/conf/home" --remount-ro /)
    bwrap "${b[@]}" "$bin" "${args[@]}" </dev/null >&2 2>"$run/render.err" || rc=$?
    ;;
  *)
    echo "agent-sync: 対応していない OS: $(uname -s)" >&2
    exit 1
    ;;
  esac

  cat "$run/render.err" >&2
  if [ "$rc" != 0 ]; then
    # sandbox の起動が対象 (archetect) を起動する前に失敗したときの、起動側の終了状態と文言。
    if { [ "$(uname -s)" = Darwin ] && [ "$rc" = 71 ] && grep -q '^sandbox-exec: sandbox_apply: ' "$run/render.err"; } ||
      { [ "$(uname -s)" = Linux ] && grep -q '^bwrap: ' "$run/render.err"; }; then
      echo "agent-sync: OS の sandbox を適用できない (exit $rc)。別の sandbox の中などでは入れ子にできないので、その外で起動する。理由は上の出力" >&2
    else
      echo "agent-sync: 描画が exit $rc で終わった (archetect の失敗。理由は上の出力)" >&2
    fi
    exit 1
  fi

  # 3. 計画
  cd "$run/out"
  [ -z "$(find . ! -type f ! -type d)" ] || { echo "agent-sync: 描画が通常のファイルでもディレクトリでもないものを出した" >&2; exit 1; }
  local lists=.agent-sync/files
  if [ -d "$lists" ]; then
    [ -z "$(find "$lists" -mindepth 1 \( ! -type f -o -path "$lists/*/*" \))" ] || { echo "agent-sync: $lists の下に、直下の通常のファイルでないものがある" >&2; exit 1; }
  fi
  : >"$run/rendered.raw"
  : >"$run/lists.raw"
  while IFS= read -r -d '' f; do
    f=${f#./}
    if [[ ! $f =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || case "/$f/" in */./* | */../*) true ;; *) false ;; esac; then
      printf 'agent-sync: 描画の出力のパスが定義域の外 (A-Z a-z 0-9 . _ - の名前だけ。改行を含む): %q\n' "$f" >&2
      exit 1
    fi
    case $f in
    "$lists"/*) printf '%s\n' "$f" >>"$run/lists.raw" ;;
    *) printf '%s\n' "$f" >>"$run/rendered.raw" ;;
    esac
  done < <(find . -type f -print0)
  sort "$run/rendered.raw" >"$run/rendered"
  # records: <置き先>\t<上流のパスか ->\t<mode>\t<一覧>
  sort "$run/lists.raw" | {
    files=()
    while IFS= read -r f; do files+=("$f"); done
    [ ${#files[@]} -eq 0 ] || awk -F '\t' "$AWK_AGENT"'
      function bad_path(p, dest,   n, a, i) {
        n = split(p, a, "/")
        if (n == 0) return 1
        for (i = 1; i <= n; i++) {
          if (a[i] !~ /^[A-Za-z0-9._-]+$/ || a[i] == "." || a[i] == "..") return 1
          if (dest && tolower(a[i]) == ".git") return 1
        }
        return 0
      }
      function fail(msg) { print "agent-sync: " FILENAME ":" FNR ": " msg > "/dev/stderr"; bad = 1 }
      NF != 3 { fail("タブ区切りの 3 つの欄でない"); next }
      $1 != "-" && bad_path($1, 0) { fail("上流のパスが定義域の外: " $1); next }
      bad_path($2, 1) { fail("置き先のパスが定義域の外: " $2); next }
      agent_bad($2) { fail("置き先が .agent-sync/ の下の、置いてよい 2 つ (sync.sh・render.sb) 以外: " $2); next }
      $3 != "644" && $3 != "755" { fail("mode が 644 でも 755 でもない: " $3); next }
      { print $2 "\t" $1 "\t" $3 "\t" FILENAME }
      END { exit bad }
    ' "${files[@]}"
  } >"$run/records"
  awk -F '\t' '
    { k = tolower($1) }
    k in seen { print "agent-sync: 置き先が重複している (大文字小文字によらない): " $1 " (" $4 ") と " seen[k] > "/dev/stderr"; bad = 1; next }
    {
      seen[k] = $1 " (" $4 ")"
      n = split(k, a, "/")
      split($1, o, "/")
      pre = ""
      for (i = 1; i < n; i++) {
        pre = pre (i > 1 ? "/" : "") a[i]
        parent[pre] = $1 " (" $4 ")"
        if (!(pre in spell)) { spell[pre] = o[i]; spelled[pre] = $1 " (" $4 ")" }
        else if (spell[pre] != o[i]) { print "agent-sync: 置き先のディレクトリの綴りが大文字小文字だけ違う: " $1 " (" $4 ") と " spelled[pre] > "/dev/stderr"; bad = 1 }
      }
    }
    END {
      for (k in parent) if (k in seen) { print "agent-sync: 置き先 " seen[k] " が、別の置き先 " parent[k] " の親のディレクトリ (大文字小文字によらない)" > "/dev/stderr"; bad = 1 }
      exit bad
    }
  ' "$run/records"
  awk -F '\t' '$2 == "-" {print $1}' "$run/records" | sort >"$run/declared"
  local errs=0
  while IFS= read -r p; do
    echo "agent-sync: 描画の出力 $p が、どの一覧にも - の行で無い" >&2
    errs=1
  done < <(comm -23 "$run/rendered" "$run/declared")
  while IFS= read -r p; do
    echo "agent-sync: 一覧の - の行の $p を、描画が出していない" >&2
    errs=1
  done < <(comm -13 "$run/rendered" "$run/declared")

  awk -F '\t' "$AWK_AGENT"'
    function bad_path(p,   n, a, i) {
      n = split(p, a, "/")
      if (n == 0) return 1
      for (i = 1; i <= n; i++) if (a[i] !~ /^[A-Za-z0-9._-]+$/ || a[i] == "." || a[i] == ".." || tolower(a[i]) == ".git") return 1
      return 0
    }
    function fail(msg) { print "agent-sync: generated:" NR ": " msg > "/dev/stderr"; bad = 1 }
    NF != 2 { fail("`<パス><TAB><id>` の 2 つの欄でない"); next }
    $2 !~ /^[0-9a-f]+$/ || (length($2) != 40 && length($2) != 64) { fail("id が 40 桁か 64 桁の小文字 16 進でない: " $2); next }
    bad_path($1) { fail("パスが定義域の外: " $1); next }
    agent_bad($1) { fail(".agent-sync/ の下の、置いてよい 2 つ (sync.sh・render.sb) 以外: " $1) }
    END { exit bad }
  ' "$cfg/generated"
  cut -f1 "$cfg/generated" | sort -c -u 2>/dev/null || { echo "agent-sync: $cfg/generated のパスが LC_ALL=C の順で重複なしでない" >&2; exit 1; }
  cut -f1 "$cfg/generated" >"$run/gen_paths"
  cut -f1 "$run/records" | sort >"$run/new_paths"
  comm -23 "$run/gen_paths" "$run/new_paths" >"$run/stale"
  cut -f1 "$run/records" | grep -qxF .agent-sync/sync.sh || { echo "agent-sync: 描画が .agent-sync/sync.sh を置かない (archetype が agent-sync の部品を合成していない)" >&2; errs=1; }

  local dest from mode list t new cur rec actual
  : >"$run/new"
  while IFS=$'\t' read -r dest from mode list; do
    new=
    if [ "$from" != - ]; then
      if ! parents_ok "$src" "$from" || [ -L "$src/$from" ] || [ ! -f "$src/$from" ]; then
        echo "agent-sync: $list: 上流のパス $from が、symlink を通らない通常のファイルでない" >&2
        errs=1
        continue
      fi
    fi
    new=$(id_of "$(content_of "$dest" "$from")")
    printf '%s\t%s\n' "$dest" "$new" >>"$run/new"
    t=$root/$dest
    if ! parents_ok "$root" "$dest"; then
      echo "agent-sync: 置き先 $dest の途中に、symlink かディレクトリでないものがある" >&2
      errs=1
    elif ! actual=$(case_clash "$root" "$dest"); then
      errs=1
    elif [ -n "$actual" ]; then
      rec=$(recorded_id "$actual")
      if [ -n "$rec" ] && [ "$(id_of "$root/$actual")" = "$rec" ]; then
        echo "agent-sync: 置き先 $dest が、前回 sync が置いた $actual と綴りが違う (ファイルシステム上は同じもの)。$actual を消してから起動し直す" >&2
      else
        echo "agent-sync: 置き先 $dest が、綴りの違う既存の $actual に当たる (大文字小文字・Unicode の正規化を同一視するファイルシステム)。移すか綴りを戻してから起動し直す" >&2
      fi
      errs=1
    elif [ -L "$t" ] || [ -e "$t" ]; then
      cur=$(id_of "$t")
      rec=$(recorded_id "$dest")
      if [ -z "$cur" ]; then
        echo "agent-sync: 置き先 $dest が通常のファイルでない (symlink・ディレクトリなど)。消すか移してから起動し直す" >&2
        errs=1
      elif [ "$cur" != "$new" ] && [ "$cur" != "$rec" ]; then
        echo "agent-sync: 置き先 $dest の中身が、前回置いたもの (generated の id) とも今回置くものとも違う (利用者のファイル・変更)。commit 済みでも同じ。移すか戻してから起動し直す" >&2
        errs=1
      fi
    fi
  done <"$run/records"
  while IFS= read -r p; do
    t=$root/$p
    if ! parents_ok "$root" "$p"; then
      echo "agent-sync: 古いパス $p の途中に、symlink かディレクトリでないものがある" >&2
      errs=1
    elif ! actual=$(case_clash "$root" "$p"); then
      errs=1
    elif [ -n "$actual" ]; then
      echo "agent-sync: 古いパス $p が、綴りの違う既存の $actual に当たる (大文字小文字・Unicode の正規化を同一視するファイルシステム)。移すか綴りを戻してから起動し直す" >&2
      errs=1
    elif [ -e "$t" ] || [ -L "$t" ]; then
      cur=$(id_of "$t")
      if [ -z "$cur" ]; then
        echo "agent-sync: 古いパス $p が通常のファイルでない (symlink・ディレクトリなど)" >&2
        errs=1
      elif [ "$cur" != "$(recorded_id "$p")" ]; then
        echo "agent-sync: 古いパス $p の中身が、前回置いたもの (generated の id) と違う (利用者の変更)。移すか戻してから起動し直す" >&2
        errs=1
      fi
    fi
  done <"$run/stale"
  [ "$errs" = 0 ] || exit 1

  # 4. 適用
  while IFS= read -r p; do
    rm -f "$root/$p"
  done <"$run/stale"
  while IFS=$'\t' read -r dest from mode list; do
    t=$root/$dest
    new=$(id_of "$(content_of "$dest" "$from")")
    if [ "$(id_of "$t")" != "$new" ] || [ -z "$(find "$t" -perm "$mode")" ]; then
      mkdir -p "$(dirname "$t")"
      # 新しい inode に書いて rename する。既存の inode は中身も mode も変えない (別のパスとの hard link かもしれず、動いている sync.sh 自身も置き換えるため)。中身か mode が違えば置き直し、同じなら触らない。
      wt_tmp=$(mktemp "$(dirname "$t")/.agent-sync.XXXXXX")
      cp "$(content_of "$dest" "$from")" "$wt_tmp"
      chmod "$mode" "$wt_tmp"
      mv -f "$wt_tmp" "$t"
      wt_tmp=
    fi
  done <"$run/records"
  wt_tmp=$(mktemp "$cfg/.agent-sync.XXXXXX")
  sort "$run/new" >"$wt_tmp"
  chmod 644 "$wt_tmp"
  mv -f "$wt_tmp" "$cfg/generated"
  wt_tmp=
  git -C "$root" status --short
}

id_of() { # <絶対パス>: 通常のファイル (symlink でない) の中身の id。それ以外は空 (hash-object は symlink の先の中身を返すので -L を先に除く)
  if [ -f "$1" ] && [ ! -L "$1" ]; then git -C "$root" hash-object --no-filters -- "$1"; fi
}

recorded_id() { # <パス>: generated に記録された id (無ければ空)
  awk -F '\t' -v p="$1" '$1 == p { print $2 }' "$cfg/generated"
}

materialize() { # <リポ> <先>: stdin の `git ls-tree -r -z` の出力から、通常のファイルを blob のバイトのまま先に作る。mode と名前の検査を済ませてから作り始める (別名の検査は作る途中。取り出し先は捨てる作業ディレクトリ。ディレクトリは dirs に覚えた綴りだけを再利用する)
  local repo=$1 to=$2 e meta p mode oid rest cur rel name dirs=$'\n'
  cat >"$run/tree"
  while IFS= read -r -d '' e; do
    meta=${e%%$'\t'*}
    p=${e#*$'\t'}
    mode=${meta%% *}
    oid=${meta##* }
    case $mode in 120000 | 160000) continue ;; 100644 | 100755) ;; *) echo "agent-sync: 上流の $p の mode $mode が定義域の外" >&2; exit 1 ;; esac
    case /$p/ in */./* | */../* | */[.][Gg][Ii][Tt]/*) echo "agent-sync: 上流のパス $p に . .. .git の名前がある" >&2; exit 1 ;; esac
    case $p in *$'\n'*) echo "agent-sync: 上流のパス $p に改行がある" >&2; exit 1 ;; esac
  done <"$run/tree"
  while IFS= read -r -d '' e; do
    meta=${e%%$'\t'*}
    p=${e#*$'\t'}
    mode=${meta%% *}
    oid=${meta##* }
    case $mode in 120000 | 160000) continue ;; esac
    # 取り出し先は空で、ディレクトリはこの関数が 1 つずつ作る (dirs に綴りのまま覚える)。覚えていないのに在るディレクトリの成分は、ファイルシステムが同じものとみなす別の綴りのもの (別名) か、同じ綴りのファイル。
    rest=$p
    cur=$to
    rel=
    while [ "${rest#*/}" != "$rest" ]; do
      name=${rest%%/*}
      rest=${rest#*/}
      cur=$cur/$name
      rel=$rel$name/
      case $dirs in *$'\n'"$rel"$'\n'*) continue ;; esac
      if [ -e "$cur" ] || [ -L "$cur" ]; then
        echo "agent-sync: 上流のパス $p の途中のディレクトリが、ファイルシステム上で別のパスと同じものに当たる" >&2
        exit 1
      fi
      mkdir "$cur" || { echo "agent-sync: 上流のパス $p の途中のディレクトリ $rel を作れない (ファイルシステムの失敗)" >&2; exit 1; }
      dirs=$dirs$rel$'\n'
    done
    if [ -e "$to/$p" ] || [ -L "$to/$p" ]; then
      echo "agent-sync: 上流のパス $p がファイルシステム上で別のパスと同じものに当たる" >&2
      exit 1
    fi
    git -C "$repo" cat-file blob "$oid" >"$to/$p"
    [ "$mode" = 100644 ] || chmod 755 "$to/$p"
  done <"$run/tree"
}

parents_ok() { # <基点> <相対パス>: 途中のディレクトリが、無いか symlink でないディレクトリ
  local cur=$1 rest=$2
  while [ "${rest#*/}" != "$rest" ]; do
    cur=$cur/${rest%%/*}
    rest=${rest#*/}
    if [ -L "$cur" ] || { [ -e "$cur" ] && [ ! -d "$cur" ]; }; then return 1; fi
  done
}

case_clash() { # <基点> <相対パス>: 既存の成分のうち、親の一覧に要求した綴りと完全に等しい名前が無い (ファイルシステムが別の綴りの項目に当てている) ものがあれば、その別名の実際のパスを出す (特定できなければ固定の文言。無ければ空)。親の一覧が取れなければ文言を出して 1 を返す。綴りの規則は再現せず、find の -name (置き先の名前は ASCII で、バイトの比較) と、同じファイルに当たる (-ef) 項目で聞く
  local cur=$1 rest=$2 name exact alias pre=
  while [ -n "$rest" ]; do
    name=${rest%%/*}
    if [ "$name" = "$rest" ]; then rest=; else rest=${rest#*/}; fi
    { [ -e "$cur/$name" ] || [ -L "$cur/$name" ]; } || return 0
    exact=$(find "$cur" -mindepth 1 -maxdepth 1 -name "$name") || { echo "agent-sync: $cur の一覧を取れない" >&2; return 1; }
    if [ -z "$exact" ]; then
      alias=$(find "$cur" -mindepth 1 -maxdepth 1 -exec test {} -ef "$cur/$name" \; -print | awk 'NR == 1 { print }') || { echo "agent-sync: $cur の一覧を取れない" >&2; return 1; }
      alias=${alias#"$cur"/}
      [ -n "$alias" ] || alias=一覧のどれか
      [ -z "$rest" ] || alias=$alias/$rest
      printf '%s\n' "$pre$alias"
      return 0
    fi
    pre=$pre$name/
    cur=$cur/$name
  done
}

content_of() { # <置き先> <上流のパスか ->: 置き先に置く中身のファイル
  if [ "$2" = - ]; then printf '%s\n' "$run/out/$1"; else printf '%s\n' "$src/$2"; fi
}

main "$@"; exit
