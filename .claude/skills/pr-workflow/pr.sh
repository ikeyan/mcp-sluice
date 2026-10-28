#!/usr/bin/env bash
# gh.md の「PR の watch」と「返信と resolve」を GitHub の REST・GraphQL で行う。gh は sandbox 内で TLS に失敗するので、curl で呼ぶ。
#
# 使い方:
#   pr.sh watch <owner>/<repo> <PR 番号> <状態のディレクトリ> [<間隔の秒数 (1〜900 の整数、既定 60)>]
#     対応が要るものを見つけたら出して終わる (Bash ツールの run_in_background で回す)。同じ <状態のディレクトリ> で二重に起動しない (ロックしないので状態の読み書きが競合する)。
#     初回 (状態が無い): 以後の周期で出す対象が既にあれば、open で出して終わる。無ければ基準にして待つ。出す対象:
#       - コメント
#       - 本文のある COMMENTED の review
#       - レビュアーごとに最後に提出した COMMENTED 以外の review が CHANGES_REQUESTED のもの
#       - unresolved のレビューコメント
#       - head の CI の失敗 (再実行や同じ context の後の status で置き換えられたものを含む)
#       - 閉じた PR
#       - Completed の Codex の summary
#     以後: 前回との差 (コメント・review の追加と編集、タイトル、説明、CI の失敗、PR の close と reopen) を見つけたら、間隔と 10 秒の短いほうだけ待って取り直し、まとめて出して終わる。
#     出さないもの: resolve 済みのスレッドのレビューコメント、本文の無い COMMENTED の review (返信で作られる)、Codex の summary コメントの、今の head の Completed 以外への編集。
#     自分 (トークンの持ち主) の通常のコメントは出す (エージェントの返信とユーザー自身の指示を見分けられない)。
#     Codex のレビューの利用上限のコメント (Codex の bot の、本文が "You have reached your Codex usage limits for code reviews." で始まるもの) は、状態に無く、Codex の summary の最後の編集より新しいか等しく (updated_at は秒精度で、同じ秒は前後を判定できないので現在扱いとする)、PR が open で head に Completed の summary が無いときに扱う (それ以外のものは、その後にレビューが動いたか、閉じた PR のもの)。Codex は窓が明けても自分ではレビューを再開せず、push か "@codex review" のコメントが要る (canon: facts/codex-github/usage-limit-auto-resume)。
#       扱うとは: PR_CODEX_LIMITS を 1 回回し、その周期に扱うコメントごとに codex-usage-limit の行を出す。usedPercent が 100 以上で resetsAt のある窓のうち、resetsAt が最も遅いもの (それが明けるまでレビューは止まる) を上限の窓とし、その resetsAt を reset とする。
#       reset が分かれば、状態に codex-resume<TAB><head の sha><TAB><reset の epoch 秒> を残す。分からなければ消す (上限のコメントを扱うたびに置き換える)。分からないときは、下の「始まったか」の検査が、それの見る PR (open で draft でなく summary がある) で head のレビューが始まっていなければ 300 秒後に要求する。
#       以後の周期で、codex-resume の head が今の head で、PR が open で head に Completed の summary が無く、reset を過ぎていれば、issue comment "@codex review" を 1 件 POST し、codex-review requested の行を出して codex-resume の reset を - にする (その head では要求済み)。POST したコメントは comment の行として出さない。
#       reset が - の head には、上限のコメントを扱っても codex-resume を置き直さない (Codex が要求に上限で応え、読んだ窓は明けている、を繰り返さない)。その head は下の「始まったか」の検査が扱う。
#       それより先に、head が変わる・Completed が付く・PR が閉じる・最新の上限のコメントより新しい "@codex review" で始まる issue comment が付く (他の人の要求や、応答が届かなかった自分の POST。そのコメントは comment の行で出る) のどれかが起きたら、POST せずに codex-resume を消す (reset が - のものは、head が変わるか Completed が付くときだけ消し、PR が閉じても残す)。push でレビューが起動するとは限らない (canon: facts/github/codex-review-pr-flow) ので、新しい head は下の「始まったか」の検査が扱う。まだ上限なら、その要求に Codex が新しい上限のコメントを出し、それをここで扱い直す。
#     PR が open で draft でなく Codex の summary があれば、head のレビューが始まったかを見る (Codex は push でレビューを起動し損ねることがあり、原因は分かっていない。canon: facts/github/codex-review-pr-flow。draft は ready にするまで Codex が起動しないので見ない)。始まった = どれかの summary の Commit 列が head の接頭辞 (Codex は開始時に Commit 列を head にして Running にするので、Running か Completed かを問わない)。
#       始まっていない head について、状態に codex-wait<TAB><head の sha><TAB><起点の epoch 秒か -><TAB><wait・requested・reported> を残す (時刻は周期ごとに 1 回 date +%s で読む)。head のレビューが始まると消し、head が変われば wait で作り直す。検査が見ない間 (PR が閉じた・draft・summary が無い) は、同じ head の行を wait・requested・reported のまま残して起点を - にし、見るようになった周期から計時し直す (draft と ready、close と reopen を行き来しても、その head への POST と通知は 1 回ずつ)。
#       起点は、始まっていないことを見た最初の周期の時刻。検査が見ない間と、上限明けの要求を待つ間 (今の head の codex-resume の reset が - でない間) は起点を - にして止める。
#       起点から 300 秒たっても始まっていなければ、wait なら "@codex review" を 1 件 POST して codex-review requested の行を出し (POST したコメントは comment の行として出さない)、requested にして起点を置き直す。requested なら codex-review not-started の行を出して reported にする (その head では以後何もしない)。
#       step を進めるのはこの検査の POST だけで、issue comment の "@codex review" (他の人の要求、上限明けの POST) からは推さない (どの head への要求かはコメントから決まらない。要求でレビューが始まれば Commit 列で分かる)。POST の応答が切れるとその周期は記録されず wait のままなので、次の周期でも始まっていなければもう 1 件 POST する (応答が切れるたびに 1 件まで)。
#   pr.sh reply-resolve <owner>/<repo> <PR 番号> <スレッド先頭のレビューコメントの id (整数)> <本文>
#     スレッドに返信し、そのスレッドを resolve する。
#   環境変数 PR_CODEX_LIMITS: watch が Codex の利用上限の窓を読むコマンド (既定 <pr.sh のディレクトリ>/codex-limits.sh)。引数なしで直接実行できるファイルのパス。成功は exit 0 で stdout が codex-limits.sh の先頭の形、失敗は exit 0 以外で出力 (stdout と stderr) の 1 行目が理由。
#   環境変数 GITHUB_API_URL: API の基点 (既定 https://api.github.com)。REST と GraphQL (<基点>/graphql) が同じ基点の下にある api.github.com の配置だけを扱い、GHES (REST は /api/v3、GraphQL は /api/graphql) は対象外。受け付ける形は次の 2 つだけで、それ以外 (他ホスト宛ての http:// を含む) は起動時に exit 2 で止まる: https://<host>[:port] (host はホスト名か IPv4 リテラルの形。ホスト名は RFC 1123 のラベル (英数字で始まり英数字で終わる、間にハイフン可) をドットでつないだもので全体は 253 文字以内 (RFC 1035)、IPv6 リテラルは対象外)、と http://127.0.0.1[:port] (トークンを Authorization ヘッダに載せて平文で送るため、http は loopback 宛てだけ許す)。ポートはどちらも 1〜65535、authority のみでパス・クエリ・フラグメント・空白は不可、末尾の / 無し。この構文を満たしながら範囲外の IPv4 (300.1.1.1 など) や存在しないホストは resolve の失敗になり、これは一時的な失敗として扱う (後述)。curl の設定ファイル (~/.curlrc など) は読まない。環境変数 (プロキシの http_proxy・HTTPS_PROXY・ALL_PROXY・NO_PROXY、CURL_CA_BUNDLE など) は curl の文書どおりに効くが、127.0.0.1 宛てはプロキシを通さない (canon: facts/curl/environment-and-config-inputs)。
# 出力 (watch、1 行 1 件): open・new・changed に続けてイベント文。説明の変更は "description changed" の行に unified diff が続く。
#   Codex の利用上限のイベント文は codex-usage-limit <コメントの URL> に続けて、resets <reset の ISO 8601 UTC> <上限の窓> か reset unknown: <理由>。
#     <上限の窓> は windowDurationMins から決める (primary・secondary の名前からは決めない): 300 なら 5h、10080 なら weekly、無ければ unknown、それ以外は <分>m。
#     <理由> は、PR_CODEX_LIMITS の失敗なら出力の 1 行目、成功して該当する窓が無ければ no window at 100% with resetsAt。
#   上限明けと、始まらないレビューの要求は new codex-review requested <POST したコメントの URL>。要求の後も始まらなければ new codex-review not-started <head の sha>。
#   auth で始まる行を出して終わったら、トークンが無いか無効 (401)。error で始まる行なら、PR 番号・リポジトリ・権限・問い合わせの誤り (3xx、401 以外の 4xx、レート制限でない GraphQL の errors、curl 自身の URL・プロトコルの誤り)。3xx はリポジトリの改名・移動で、新しい名前で起動し直す。
# 失敗: 一時的な API の失敗 (ネットワーク・5xx・レート制限の 403・429) は、watch では出さずに間隔を倍にして (上限 900 秒) 再試行し、reply-resolve では止まる。curl 自身の失敗も同じ規則 (相手や経路の状態で結果が変わりうる転送の失敗は一時的、ローカルの設定・引数・TLS の信頼・機能の欠如は再試行しても変わらないので恒久) で分ける: 一時的は curl(1) の EXIT CODES の 5・6・7・16・18・28・52・55・56・89・92・95・96 (名前解決・接続・送受信・途中切断・timeout・HTTP/2・HTTP/3・QUIC の枠組みの失敗。内訳は req() の case の直前を見る)、それ以外 (URL・プロトコル・TLS の設定・CA など) は恒久 (error の行で 3)。
#   reply-resolve は、止まった後にそのままやり直してよい (スレッドに自分の同じ本文の返信があれば返信を重ねない)。同じスレッドに並行に起動しない (返信の有無を見てから返信するまでに割り込まれると、返信が重なる)。
# 事前条件: curl と jq (1.6 以上)。トークンは GH_TOKEN か gh auth token。watch の既定の PR_CODEX_LIMITS は codex を使う (無ければ reset unknown)。
# GraphQL の $cursor と jq の式は、単一引用符で展開させずに渡す
# shellcheck disable=SC2016
set -uo pipefail

[ $# -ge 4 ] || { echo "usage: pr.sh watch <owner>/<repo> <n> <dir> [<interval>] | reply-resolve <owner>/<repo> <n> <comment-id> <body>" >&2; exit 2; }
cmd=$1 repo=$2 pr=$3
# 無いと一時的な失敗と区別できずに再試行し続けるので、先に確かめる
if ! command -v curl > /dev/null || ! command -v jq > /dev/null; then echo "pr.sh: curl と jq が要る" >&2; exit 2; fi
api=${GITHUB_API_URL:-https://api.github.com}
guard_msg="pr.sh: GITHUB_API_URL は https://<host>[:port] か http://127.0.0.1[:port] (authority のみ、ポートは 1〜65535、末尾の / 無し、IPv6 は対象外。トークンを Authorization ヘッダに載せるため平文の http は loopback 宛てだけ): $api"
# ホスト名は RFC 1123 のラベルをドットでつないだもの、全体で 253 文字以内 (RFC 1035)、ポートは 1〜65535、IPv6 は対象外
label='[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
[[ $api =~ ^(https?):// ]] || { echo "$guard_msg" >&2; exit 2; }
if [ "${BASH_REMATCH[1]}" = http ]; then
  # トークンを Authorization ヘッダに載せて平文で送るため、http は loopback (テスト用の fake) 宛てだけ許す (Codex 指摘: PR #18 review comment r4103373730)
  [[ $api =~ ^http://127\.0\.0\.1(:[0-9]{1,5})?$ ]] || { echo "$guard_msg" >&2; exit 2; }
else
  [[ $api =~ ^https://$label(\.$label)*(:[0-9]{1,5})?$ ]] || { echo "$guard_msg" >&2; exit 2; }
fi
host=${api#*://} host=${host%%:*}
[ "${#host}" -le 253 ] || { echo "$guard_msg" >&2; exit 2; }
# curl の --noproxy は NO_PROXY に足すのではなく置き換える (canon: facts/curl/environment-and-config-inputs)
direct=()
[ "$host" != 127.0.0.1 ] || direct=(--noproxy 127.0.0.1)
if [[ $api =~ :([0-9]+)$ ]]; then port=${BASH_REMATCH[1]}; else port=; fi
[ -z "$port" ] || { [ "$((10#$port))" -ge 1 ] && [ "$((10#$port))" -le 65535 ]; } || { echo "$guard_msg" >&2; exit 2; }
token=${GH_TOKEN:-$(gh auth token)}
[ -n "$token" ] || { echo "auth GitHub のトークンが無い。GH_TOKEN を設定するか gh auth login する"; exit 1; }

req() { # <メソッド> <URL> [<JSON の本文>]: 応答の本文を出す。失敗は、一時的 (ネットワーク・5xx・レート制限。GraphQL の 200 の errors がレート制限を示すものを含む) なら 1、401 なら 2、3xx (リダイレクト。リポジトリの改名・移動) とそれ以外の 4xx とレート制限でない GraphQL の errors と curl 自身の URL・プロトコルの誤りなら error の行を出して 3 を返す
  local res tail code remaining retry limited body data=() cc
  [ $# -lt 3 ] || data=(--data "$3")
  res=$(printf 'Authorization: Bearer %s\n' "$token" | curl -q -sS --max-time 30 "${direct[@]}" -X "$1" -H @- -H "Accept: application/vnd.github+json" "${data[@]}" \
    -w '\n%{http_code}\t%header{x-ratelimit-remaining}\t%header{retry-after}' "$2")
  cc=$?
  if [ "$cc" != 0 ]; then
    # curl(1) の EXIT CODES 全体 (man curl) を、単発のコードごとの指摘 (5 → 92/95/96 → 16 と続いた) を止めるため、次の一つの規則で恒久・一時に分ける (Codex 指摘: PR #18 review comment r4102062690):
    #   一時的 = 相手や経路の状態で結果が変わりうる転送の失敗 (名前解決・接続・送受信・途中切断・timeout・HTTP/2/3・QUIC の枠組みの失敗)
    #   恒久   = ローカルの設定・引数・TLS の信頼・機能の欠如 (再試行しても変わらない)
    # 一時的とするコード (man curl での名前):
    #   5  Could not resolve proxy (名前解決)
    #   6  Could not resolve host (名前解決)
    #   7  Failed to connect to host (接続)
    #   16 A problem was detected in the HTTP2 framing layer (HTTP/2 の枠組み)
    #   18 Partial file. Only a part of the file was transferred (途中で切断)
    #   28 Operation timeout (timeout)
    #   52 The server did not reply anything (応答無し)
    #   55 Failed sending network data (送信)
    #   56 Failure in receiving network data (受信)
    #   89 No connection available, the session is queued (timeout まで接続待ち)
    #   92 Stream error in HTTP/2 framing layer (HTTP/2 の枠組み)
    #   95 A problem was detected in the HTTP/3 layer (HTTP/3 の枠組み)
    #   96 QUIC connection error (QUIC の枠組み。SSL ライブラリのエラーが原因のこともある)
    # 恒久側の判断が自明でないもの: 35 (SSL connect error) は「ハンドシェイクの失敗」としか書かれておらずネットワークの状態にも見えるが、URL のスキームの取り違え (TLS を話さない相手に https を向ける) でも同じコードが出る恒久の原因があり、再試行では直らない (test-pr.ts の checkPermanentCurlConfigFailures で固定)。8 (weird server reply)・61 (unrecognized transfer encoding) は受信バイト自体でなく内容の解釈の失敗、47 (too many redirects) はローカルの上限、94 (authentication function error)・97 (proxy handshake error)・99 (poll/select fatal error) はローカルの認証機構・システムコールの失敗で、いずれも転送層の状態には依存しないので恒久。curl の stderr (-sS) はここでは捕らえず、素通しでこのスクリプトの stderr に出ているので、error の行には code と URL だけ出す
    case $cc in
      5 | 6 | 7 | 16 | 18 | 28 | 52 | 55 | 56 | 89 | 92 | 95 | 96) return 1 ;;
      *) echo "error curl $cc: $2" >&2; return 3 ;;
    esac
  fi
  tail=${res##*$'\n'} body=${res%$'\n'*}
  IFS=$'\t' read -r code remaining retry <<<"$tail"
  # レート制限は、primary なら x-ratelimit-remaining が 0、secondary なら retry-after があるか remaining が 0、無ければ本文が示す (canon: facts/github/rest-rate-limit-responses)
  limited=
  if [ -n "$retry" ] || [ "$remaining" = 0 ] || [[ $body == *"rate limit"* ]]; then limited=1; fi
  case $code in
    2??)
      # GraphQL は失敗も 200 で返し、本文の errors に入れる
      if [[ $2 != */graphql ]] || jq -e '.errors == null' <<<"$body" > /dev/null; then printf '%s\n' "$body"; return 0; fi
      [ -z "$limited" ] || return 1 ;;
    401) return 2 ;;
    429) return 1 ;;
    403) [ -z "$limited" ] || return 1 ;;
    3?? | 4??) ;;
    *) return 1 ;;
  esac
  echo "error HTTP $code $1 $2: $body" >&2
  return 3
}
fail() { # <終了コード>: 401 (2) なら auth の行、恒久的な失敗 (3) なら error の行を出し、そのコードで終わる
  case $1 in
    2) echo "auth GitHub のトークンが無効 (401)。gh auth login してから起動し直す" ;;
    3) echo "error 引数か権限が誤っている (直前の行が GitHub の応答)" ;;
  esac
  exit "$1"
}
rest() { # <API パス (クエリ可)> <jq フィルタ>: 全ページを取り、各ページに jq を当てる
  local page=1 body sep='?'
  case $1 in *'?'*) sep='&' ;; esac
  while :; do
    body=$(req GET "$api/$1${sep}per_page=100&page=$page") || return
    jq -r "$2" <<<"$body" || return 1
    [ "$(jq 'if type == "array" then length else (.check_runs | length) end' <<<"$body")" -eq 100 ] || return 0
    page=$((page + 1))
  done
}
gql() { # <PR の接続のフィールド (after: $cursor を取る)> <接続のノードごとの jq フィルタ>: 全ページを取る
  local cursor=null body conn
  local q="query(\$owner:String!,\$name:String!,\$pr:Int!,\$cursor:String){repository(owner:\$owner,name:\$name){pullRequest(number:\$pr){$1}}}"
  while :; do
    body=$(req POST "$api/graphql" "$(jq -n --arg q "$q" --arg o "${repo%/*}" --arg n "${repo#*/}" --argjson p "$pr" --argjson c "$cursor" '{query: $q, variables: {owner: $o, name: $n, pr: $p, cursor: $c}}')") || return
    conn=$(jq '.data.repository.pullRequest | to_entries[0].value' <<<"$body") || return 1
    jq -r ".nodes[] | $2" <<<"$conn" || return 1
    [ "$(jq -r .pageInfo.hasNextPage <<<"$conn")" = true ] || return 0
    cursor=$(jq .pageInfo.endCursor <<<"$conn")
  done
}

if [ "$cmd" = reply-resolve ]; then
  [ $# -eq 5 ] || { echo "usage: pr.sh reply-resolve <owner>/<repo> <n> <comment-id> <body>" >&2; exit 2; }
  id=$4 text=$5
  # jq のフィルタに埋め込むので、整数に限る
  [[ $id =~ ^[0-9]+$ ]] || { echo "pr.sh: コメントの id は整数: $id" >&2; exit 2; }
  thread=$(gql 'reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id comments(first:1){nodes{databaseId}}}}' \
    "select(.comments.nodes[0].databaseId == $id) | .id") || fail $?
  [ -n "$thread" ] || { echo "pr.sh: レビューコメント $id を先頭に持つスレッドが無い" >&2; exit 1; }
  # 返信の後の resolve が失敗してやり直しても返信を重ねないように、スレッドに自分の同じ本文の返信があれば返信しない (間に他の返信があっても見つける)
  me=$(req POST "$api/graphql" '{"query":"{viewer{login}}"}' | jq -r .data.viewer.login) || fail $?
  if [ -z "$me" ] || [ "$me" = null ]; then echo "error トークンの持ち主 (GraphQL の viewer) が分からないので、返信の重複を判定できない"; exit 3; fi
  posted=$(rest "repos/$repo/pulls/$pr/comments" \
    ".[] | select(.in_reply_to_id == $id and .user.login == $(jq -n --arg m "$me" '$m') and .body == $(jq -n --arg t "$text" '$t')) | .id") || fail $?
  if [ -z "$posted" ]; then
    req POST "$api/repos/$repo/pulls/$pr/comments/$id/replies" "$(jq -n --arg b "$text" '{body: $b}')" > /dev/null || fail $?
  fi
  res=$(req POST "$api/graphql" "$(jq -n --arg t "$thread" '{query: "mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}", variables: {t: $t}}')") || fail $?
  jq -e '.data.resolveReviewThread.thread.isResolved' <<<"$res" > /dev/null || { echo "pr.sh: resolve できない: $res" >&2; exit 1; }
  exit 0
fi
[ "$cmd" = watch ] || { echo "pr.sh: 知らないサブコマンド: $cmd" >&2; exit 2; }

dir=$4 interval=${5:-60}
# バックオフで倍にする (上限 900) ので、整数の算術があふれない 1〜900 に限る
if ! [[ $interval =~ ^[1-9][0-9]{0,2}$ ]] || [ "$interval" -gt 900 ]; then echo "pr.sh: 間隔は 1〜900 の整数の秒数: $interval" >&2; exit 2; fi
state=$dir/state
mkdir -p "$dir" || exit
limits=${PR_CODEX_LIMITS:-$(dirname "$0")/codex-limits.sh}
comment_line='"ic:\(.id)\t\(.updated_at)\tcomment \(.user.login) \(.html_url)"'
poll() { # 現状を「キー<TAB>版<TAB>イベント文」の行で出し、説明を $dir/body.new に置く。イベント文が空の行は版だけを追う
  local pr_json sha roots
  pr_json=$(req GET "$api/repos/$repo/pulls/$pr") || return
  jq -r .body <<<"$pr_json" > "$dir/body.new" || return 1
  jq -r '"pr\t\(.state)\tpr \(.state) merged=\(.merged) \(.html_url)", "title\t\(.title | gsub("\t"; " "))\ttitle \(.title | gsub("\t"; " "))"' <<<"$pr_json" || return 1
  sha=$(jq -r .head.sha <<<"$pr_json") || return 1
  printf 'head\t%s\t\n' "$sha"
  jq -r '"draft\t\(.draft)\t"' <<<"$pr_json" || return 1
  # push の直後は前の commit の Completed が残るので、Commit が今の head のときだけ Completed として出す
  rest "repos/$repo/issues/$pr/comments" "\"$sha\" as \$head | "'.[] |
    if .user.login == "chatgpt-codex-connector[bot]" and (.body | startswith("<!-- codex-pull-request-review-summary -->")) then
      (first(.body | capture("`(?<c>[0-9a-f]{7,40})`").c) // "") as $c |
      (if (.body | test("\\*\\*Completed\\*\\*")) and $c != "" and ($head | startswith($c)) then
        "ic:\(.id)\tcompleted \($c)\tcodex-review completed \($c) \(.html_url)"
      else "ic:\(.id)\tother \($c)\t" end), "summary\t\(.updated_at)\t"
    elif .user.login == "chatgpt-codex-connector[bot]" and (.body | startswith("You have reached your Codex usage limits for code reviews.")) then
      "limit:\(.id)\t\(.updated_at) \(.html_url)\t"
    else '"$comment_line"', (if .body | startswith("@codex review") then "request\t\(.updated_at)\t" else empty end) end' || return
  # resolve の有無は GraphQL にしか無いので、unresolved のスレッドの先頭のコメントの id だけを取り、コメントは REST で全ページ取る (返信の in_reply_to_id は先頭を指す)
  roots=$(gql 'reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{isResolved comments(first:1){nodes{databaseId}}}}' \
    'select(.isResolved | not) | .comments.nodes[0].databaseId') || return
  rest "repos/$repo/pulls/$pr/comments" "[${roots//$'\n'/,}] as \$roots | .[] | select((.in_reply_to_id // .id) as \$r | \$roots | any(. == \$r)) | \"rc:\\(.id)\\t\\(.updated_at)\\treview-comment \\(.user.login) \\(.html_url)\"" || return
  # 本文のある COMMENTED の review と、レビュアーごとに最後に提出した (submittedAt が最大の) COMMENTED 以外の review が CHANGES_REQUESTED ならそれを出す。
  # APPROVED と上書きされた review は出さない。PENDING は提出前の下書きなので、最後の判定に入れない
  gql 'reviews(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{databaseId state body submittedAt updatedAt url author{login}}}' \
    '"\(.state)\t\(.author.login)\t\(.body != "")\t\(.submittedAt)\trv:\(.databaseId)\t\(.state) \(.updatedAt)\treview \(.state) \(.author.login) \(.url)"' |
    awk -F'\t' -v OFS='\t' '
      $1 == "COMMENTED" { if ($3 == "true") print $5, $6, $7; next }
      $1 == "PENDING" { next }
      !($2 in at) || $4 > at[$2] { at[$2] = $4; last[$2] = $5 OFS $6 OFS $7; state[$2] = $1 }
      END { for (a in last) if (state[a] == "CHANGES_REQUESTED") print last[a] }' || return
  rest "repos/$repo/commits/$sha/check-runs?filter=all" '.check_runs[] | select(.conclusion | IN("failure", "timed_out", "cancelled", "action_required", "startup_failure")) | "cr:\(.id)\t\(.conclusion)\tci-failure \(.name) \(.conclusion) \(.html_url)"' || return
  rest "repos/$repo/commits/$sha/statuses" '.[] | select(.state == "failure" or .state == "error") | "st:\(.id)\t\(.state)\tci-failure \(.context) \(.state) \(.target_url)"' || return
}
diff_events() { # <現状>: 状態ファイルとの差をイベントの行で出す
  printf '%s\n' "$1" | awk -F'\t' 'NR == FNR { seen[$1] = $2; next } $3 == "" { next } !($1 in seen) { print "new " $3; next } seen[$1] != $2 { print "changed " $3 }' "$state" -
  if ! cmp -s "$dir/body" "$dir/body.new"; then echo "description changed"; diff -u "$dir/body" "$dir/body.new" | tail -n +3; fi
}
request_review() { # issue comment "@codex review" を POST し、codex-review requested の行を codex_lines に、そのコメントの現状の行を posted に足す。POST の失敗は req の終了コードを返す
  local res
  res=$(req POST "$api/repos/$repo/issues/$pr/comments" '{"body":"@codex review"}') || return
  posted=${posted:+$posted$'\n'}$(jq -r "$comment_line" <<<"$res") || return 1
  codex_lines=${codex_lines:+$codex_lines$'\n'}"new codex-review requested $(jq -r .html_url <<<"$res")"
}
codex_step() { # <現状> <open か new>: 利用上限のコメントと上限明けの要求を扱う (先頭の宣言)。出す行を codex_lines に、状態に残す codex-resume の行を resume に置き、POST したコメントの現状の行を posted に足す。POST の失敗は req の終了コードを返す
  local prev=/dev/null head fresh out reason="no window at 100% with resetsAt" reset="" window when rhead
  [ ! -f "$state" ] || prev=$state
  resume=$(awk -F'\t' '$1 == "codex-resume"' "$prev")
  head=$(printf '%s\n' "$1" | awk -F'\t' '$1 == "head" { print $2 }')
  case $(printf '%s\n' "$1" | awk -F'\t' '$1 ~ /^ic:/ && $2 ~ /^completed / { c = 1 } $1 == "pr" && $2 != "open" { o = 1 } END { print c ? "completed" : o ? "closed" : "open" }') in
    completed) resume=; return 0 ;;
    closed) [ "$resume" = "$(printf 'codex-resume\t%s\t-' "$head")" ] || resume=; return 0 ;;
  esac
  fresh=$(printf '%s\n' "$1" | awk -F'\t' -v prev="$prev" 'BEGIN { while ((getline l < prev) > 0) { split(l, f, "\t"); seen[f[1]] } }
    $1 == "summary" && $2 > last { last = $2 }
    $1 ~ /^limit:/ && !($1 in seen) { split($2, v, " "); at[$1] = v[1]; url[$1] = v[2] }
    END { for (k in at) if (at[k] >= last) print url[k] }' "$prev" -)
  if [ -n "$fresh" ]; then
    if out=$("$limits" 2>&1); then
      read -r reset window < <(awk -F'\t' '($1 == "primary" || $1 == "secondary") && $2 != "-" && $2 >= 100 && $3 != "-" && (r == "" || $3 > r) { r = $3; m = $4 }
        END { if (r != "") print r, (m == 300 ? "5h" : m == 10080 ? "weekly" : m == "-" ? "unknown" : m "m") }' <<<"$out")
    else
      reason=$(head -n 1 <<<"$out")
    fi
    if [ -n "$reset" ]; then when="resets $(jq -rn --argjson t "$reset" '$t | todate') $window"; else when="reset unknown: $reason"; fi
    [ "$resume" = "$(printf 'codex-resume\t%s\t-' "$head")" ] || resume=${reset:+$(printf 'codex-resume\t%s\t%s' "$head" "$reset")}
    codex_lines=$(printf '%s\n' "$fresh" | while IFS= read -r u; do printf '%s codex-usage-limit %s %s\n' "$2" "$u" "$when"; done)
    return 0
  fi
  [ -n "$resume" ] || return 0
  IFS=$'\t' read -r _ rhead reset <<<"$resume"
  if [ "$rhead" != "$head" ]; then resume=; return 0; fi
  [ "$reset" != - ] || return 0
  if printf '%s\n' "$1" | awk -F'\t' '$1 ~ /^limit:/ { split($2, v, " "); if (v[1] > l) l = v[1] }
    $1 == "request" && $2 > r { r = $2 } END { exit !(r > l) }'; then resume=; return 0; fi
  [ "$now" -ge "$reset" ] || return 0
  request_review || return
  resume=$(printf 'codex-resume\t%s\t-' "$head")
}
codex_wait() { # <現状>: 今の head でレビューが始まらないときの要求と通知 (先頭の宣言)。状態に残す codex-wait の行を waiting に置き、出す行を codex_lines に、POST したコメントの現状の行を posted に足す。POST の失敗は req の終了コードを返す
  local prev=/dev/null applies started head whead since step
  waiting=
  [ ! -f "$state" ] || prev=$state
  read -r applies started head whead since step < <(printf '%s\n' "$1" | awk -F'\t' -v prev="$prev" '
    BEGIN { while ((getline l < prev) > 0) { split(l, f, "\t"); if (f[1] == "codex-wait") { wh = f[2]; ws = f[3]; wt = f[4] } } }
    $1 == "pr" { isopen = $2 == "open" }
    $1 == "head" { head = $2 }
    $1 == "draft" { draft = $2 == "true" }
    $1 == "summary" { has = 1 }
    $1 ~ /^ic:/ && $2 ~ /^(completed|other) [0-9a-f]/ { commits[substr($2, index($2, " ") + 1)] }
    END {
      for (c in commits) if (index(head, c) == 1) s = 1
      print isopen && !draft && has, s + 0, head, (wh == "" ? "-" : wh), (ws == "" ? "-" : ws), (wt == "" ? "wait" : wt)
    }')
  [ "$started" = 0 ] || return 0
  if [ "$whead" != "$head" ]; then
    [ "$applies" = 1 ] || return 0
    since=- step=wait
  fi
  if [ "$step" != reported ]; then
    if [ "$applies" = 0 ] || { [ -n "$resume" ] && [ "${resume##*$'\t'}" != - ]; }; then
      since=-
    elif [ "$since" = - ]; then
      since=$now
    elif [ $((now - since)) -ge 300 ]; then
      if [ "$step" = wait ]; then
        request_review || return
        since=$now step=requested
      else
        codex_lines=${codex_lines:+$codex_lines$'\n'}"new codex-review not-started $head" step=reported
      fi
    fi
  fi
  waiting=$(printf 'codex-wait\t%s\t%s\t%s' "$head" "$since" "$step")
}
closed_line() { # <現状>: PR が閉じていれば、その行を出す
  printf '%s\n' "$1" | awk -F'\t' '$1 == "pr" && $2 == "closed" { print "changed " $3 }'
}
delay=$interval
while :; do
  cur=$(poll) && rc=0 || rc=$?
  if [ "$rc" = 0 ] && [ ! -f "$state" ]; then
    # 以後の周期で出す対象は、起動の前からあるものも出す (基準に黙って入れると二度と出ない)。タイトルと説明は変化だけが対象
    events=$(printf '%s\n' "$cur" | awk -F'\t' '$3 != "" && $1 != "pr" && $1 != "title" { print "open " $3 }'; closed_line "$cur")
    prefix=open
  elif [ "$rc" = 0 ]; then
    events=$(diff_events "$cur")
    if [ -n "$events" ]; then
      # レビューコメントと Codex の summary の編集は続けて来るので、窓を置いてまとめる
      sleep $((interval < 10 ? interval : 10))
      # 取り直しが失敗したら、この周期は確定しない (body.new だけが次の版に進んでいる)
      if next=$(poll); then cur=$next events=$(diff_events "$cur"); else rc=$?; fi
    fi
    case $events in *"changed pr closed"*) ;; *) closed=$(closed_line "$cur") && events=${events:+$events$'\n'}$closed ;; esac
    events=${events%$'\n'}
    prefix=new
  fi
  if [ "$rc" = 0 ]; then
    codex_lines='' posted='' now=$(date +%s)
    if codex_step "$cur" "$prefix" && codex_wait "$cur"; then
      cur=$cur${posted:+$'\n'$posted} events=$events${codex_lines:+${events:+$'\n'}$codex_lines}
    else
      rc=$?
    fi
  fi
  if [ "$rc" = 2 ] || [ "$rc" = 3 ]; then
    fail "$rc"
  elif [ "$rc" != 0 ]; then
    delay=$((delay * 2 > 900 ? 900 : delay * 2))
  else
    delay=$interval
    # 出せたときだけ記録する (記録の前に止まれば、次の起動で同じものをもう一度出す)
    if [ -n "$events" ]; then printf '%s\n' "$events" || exit 1; fi
    printf '%s\n' "$cur" ${resume:+"$resume"} ${waiting:+"$waiting"} > "$state"
    mv "$dir/body.new" "$dir/body"
    [ -z "$events" ] || exit 0
  fi
  sleep "$delay"
done
