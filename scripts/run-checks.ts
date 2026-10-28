/**
 * run-checks.ts — verify.sh の検査の段を並行に回す。verify.sh が hook を揃えた後に exec で起動する。
 *
 * 流れ:
 * 1. 段より前の確かめ。外れたものを全部出して、段の前で exit 1 する。
 *    - git が知る項目と、その種類と名前 (下の「名前」と「拡張子」)。
 *    - 作業ツリーに無い追跡ファイル (`git ls-files --deleted`)。deno lint はその名前を黙って飛ばす (canon: facts/deno/missing-file-args)。deno lint が存在しない引数を error にするようになったら外せる。
 *    - deno と shellcheck の版 (下の「版」)。
 *    - deno test の段の TMPDIR を作れること (下の「deno test の段の TMPDIR」)。
 * 2. 段 (下の steps) を回し、全部を待つ。段が共有して書くのは deno の cache (DENO_DIR) だけ。
 *    - deno.lock は読むだけ。deno.json の lock.frozen による (canon: facts/deno/lock-frozen-config):
 *      - lock を読む subcommand (check・test・run): deno.lock が deno.json と食い違えば落ち、書き換えない。
 *      - fmt・lint: lock を読まない。
 *    - 前提: リポの祖先に、このリポを workspace の member に含む deno.json が無い (在るときは下の「入力と環境の定義域」の deno)。
 * 3. 段の出力を steps の順に出す。
 *    - 通った段: 見出しと標準出力を stdout へ、標準エラーを stderr へ。
 *    - 落ちた段: 見出しと両方を stderr へ。
 *    - 書き込みは 1 つずつ行い、失敗しても残りを出す。
 *      - BrokenPipe (`./verify.sh | head`。canon: facts/deno/stdout-broken-pipe): 終了コードを変えない。
 *      - 他の失敗 (`/dev/full`、ファイルの大きさの上限など。canon: facts/deno/stdout-write-error-kinds): 理由を stderr に出し、exit 1。
 * 4. どれかの段が落ちたか、引数が 1 (下の「入力と環境の定義域」) なら exit 1。exit はどれも下の「終了」の経路を通る。
 *
 * 段の子のプロセスグループ:
 * - 子は各自のプロセスグループで起動し (Deno.Command の detached。canon: facts/deno/command-spawn)、exec は戻る前にグループに SIGTERM と SIGKILL を送る (emptyGroup)。中断では、下の「終了」の経路が exit の前に空にする。
 *   - 先頭が終わった後に残る孫も、段が終わる前に止まる。
 *   - 自分で setsid してグループを抜けた子孫は止めない。
 *   - Linux では、この uid で送れない子孫 (別の uid のもの) は止まらない。グループの中に送れたものが 1 つでもあれば kill は通るので、残ったことも検出しない (canon: facts/deno/command-spawn の「別の uid のグループへの kill」)。
 * - グループを空にできない (kill が投げる。別の uid のものだけが残ったグループなど) とき: emptyGroup が pgid と止め方 (`kill -KILL -- -<pgid>`) を含むエラーを投げ、exec はそれを呼び出し元へ投げる。
 *   - 本流では、その段 (段より前なら段より前の失敗) がその文言で落ちる (deno test の段は、TMPDIR を消せないことも足す)。
 *   - そのグループの記録は、失敗を出した側が消す (下の「終了」)。
 * - exec が待つものと、その上限:
 *   - 先頭の終わり: 段の実行そのものを待つ。中断では終了の経路の emptyGroup の SIGKILL で終わる。
 *   - emptyGroup: SIGTERM の後、先頭の終わりと出力の pipe が閉じるのを graceMs まで待つ。SIGKILL の後の先頭の回収は、SIGKILL を捕まえられないので返る。
 *   - 出力の pipe: emptyGroup の後、graceMs まで待つ。閉じなければ読み端を cancel し (読めた分が返る。canon: facts/deno/command-spawn の「出力の pipe を持ったまま残る子孫と、読み端の cancel」)、その子を「pipe が閉じない」の失敗にする。
 * - pipe の書き端を持ちうるもの:
 *   - 先頭: 終われば閉じる。
 *   - グループの中の子孫: emptyGroup が止める。
 *   - グループを抜けた子孫: 止めない。
 * - 状態 (groups):
 *   - 対象: exec が起動した子のプロセスグループ。起動から、emptyGroup が成功するか、空にできない失敗を出すまで記録する。
 *   - 鍵: pgid (子の pid)。
 *   - 等しいとみなす条件: 同じ exec の呼び出し。
 *
 * 終了:
 * - このプロセスが終わる経路は finish の 1 つだけ。次のどれも finish を通る:
 *   - 本流の exit:
 *     - 引数の誤り。
 *     - 段より前の失敗。
 *     - 段の後。
 *   - 中断 (SIGHUP・SIGINT・SIGTERM)。
 * - 後始末の記録は groups と testTmp (上と下の「状態」)。失敗を出した側が、出すのと同じ同期の区間で記録を消す:
 *   - 本流: 段より前の失敗か段の結果を出した直後に、groups と testTmp を消す。そのときには、どの exec も戻っている。
 *   - finish: 残る記録を全部後始末して、その失敗を理由と手で直す方法つきで stderr に出してから exit する。
 *     1. 記録しているグループを同時に空にする。
 *     2. deno test の段の TMPDIR が残っていれば消す。失敗するのは、消せないものがあるとき (グループを抜けた子孫が書き続けているなど)。
 * - 中断が来る時点ごとの、失敗 (グループを空にできない、deno test の段の TMPDIR を消せない) の報告:
 *
 *   | 中断が来る時点 | 出す側 | 回数 |
 *   | --- | --- | --- |
 *   | exec が投げる前・denoTest が消し終える前 | finish (同じ emptyGroup・同じ消去の結果を待つ) | 1 |
 *   | exec が投げた後・denoTest が結果に足した後で、本流が出す前 | finish (記録が残る) | 1 |
 *   | 本流が出した後 | 本流 (finish の前に記録は消えている) | 1 |
 *   | 中断なし | 本流 | 1 |
 *
 * - 終了コードは最初の finish の呼び出しのもの。中断なら 128 + シグナルの番号 (下の signals)。
 * - 後の呼び出し (2 回目以降のシグナル、中断の後の本流) は何もせず、最初の経路の exit を待つ。
 * - finish が始まった後は、本流は何も出さず、exec は子を起動せずに待つ。
 * - SIGKILL では finish を通らず、子のグループと deno test の段の TMPDIR が残る。
 * - 中断の時点ごとの扱い (run-checks_test.ts が固定する):
 *   - 段より前 (git rev-parse・git ls-files などの最中): その子のグループを空にして終わる。
 *   - 先頭は SIGTERM で終わったが、孫が残っている: 孫は猶予の後の SIGKILL で止まる。
 *   - SIGTERM を無視するもの: 猶予の後の SIGKILL で止まる。
 *
 * deno test の段の TMPDIR:
 * - TMPDIR の下にこのプロセスが作ったディレクトリを段の TMPDIR にし、段の後に消す。中断で終わるときは、終了の経路が消す。
 *   - 作るのは test (`*_test.ts`) があるときだけ。作れなければ、理由を出して段の前で exit 1。
 *   - 段の後に消せなければ、段の結果 (exec の例外ならその文言) に、消せないことと手で消すことを足して段を落とす。文言は終了の経路と同じ。
 * - 状態 (testTmp):
 *   - 対象: このプロセスが作った段の TMPDIR。作ってから、本流か finish がその消去の結果を出すまで記録する。
 *   - 鍵: 無し (1 つだけ)。
 *   - 等しいとみなす条件: 同じ run-checks.ts の起動。
 * - test が中断で消さずに終わる一時ディレクトリ (canon: facts/deno/test-signal-listeners) を、これで消す。
 * - 外せる条件: deno test が SIGTERM で finally を回し、SIGINT でも test の後始末を終えてから終わるようになったとき。
 *   - 確かめ方: canon の facts/deno/test-signal-listeners の観測を、その版で回す。
 *   - 外すときに消すもの:
 *     - 段の TMPDIR の作成と testTmp。
 *     - denoTest の消去。
 *     - finish の消去。
 *     - それを確かめるテスト (run-checks_test.ts の、中断の「deno test の段」の行と、段が普通に終わる test の TMPDIR の確かめ)。
 *
 * 入力と環境の定義域:
 * - 引数は 1 つで、verify.sh が hook を揃えた結果。外れていれば理由を出して exit 2。
 *   - 0: 揃えた。
 *   - 1: 揃えられなかった (理由は verify.sh が出した)。段は回し、最後に exit 1。
 * - 環境変数 TMPDIR: deno test の段があるとき (test があるとき) だけ使い、その下に段の TMPDIR を作る。verify.sh は絶対パスにした値を渡す。次のときは段の前で exit 1:
 *   - 未設定。
 *   - 空。
 *   - 絶対パスでない (`/` で始まらない)。
 *   - その下に作れない (無い・書けないなど)。
 * - cwd はリポのルート。読むファイルは deno.json だけ。書くのは TMPDIR の下だけ。許可は verify.sh が渡す。
 * - 環境はそのまま段の子に渡す。差し替えるのは次だけ:
 *   - git (git()): git の場所を決める変数 (git rev-parse --local-env-vars の一覧。canon: facts/git/local-env-vars-and-hook-env) を消す。git は cwd のリポを見る。
 *     - 一覧は、このプロセスの環境のまま聞く。
 *     - 一覧の各行の形は verify.sh が確かめる。
 *     - git を起動できないか、git が非 0 で終わるときは、理由を出して段の前で exit 1。
 *   - deno (deno()):
 *     - 消すもの: 検査の結果を変える変数 (canon: facts/deno/environment-and-config-inputs の「結果を変える」)。
 *     - 残すもの: 同じ canon の「取得だけを変える」「出力の形だけ」の変数。
 *     - 渡すもの: DENO_NO_PACKAGE_JSON=1。
 *     - deno test の段だけ: TMPDIR を段の TMPDIR にする。
 *     - リポの祖先に、このリポを workspace の member に含む deno.json があると、deno はその設定を読む。flag で止められず、検出もしない。変わるもの:
 *       - lint の規則 (同じ canon の「設定ファイル」)。
 *       - lock: このリポの lock.frozen と deno.lock は使われず、workspace のルートの設定と deno.lock になる。--frozen-lockfile もルートの deno.lock と比べる (canon: facts/deno/lock-frozen-config の「祖先の workspace の member のとき」)。
 *   - shellcheck (shellcheck()。段と版の確かめ): SHELLCHECK_OPTS を消し、`--norc` を付ける。
 *     - shellcheck は引数の他に SHELLCHECK_OPTS と .shellcheckrc を読み (canon: facts/shellcheck/environment-and-config-inputs)、利用者の指定で手元と CI の結果が分かれる。
 *     - リポの .shellcheckrc も読まないので、directive は各 script に書く。
 * - 版:
 *   - deno: 2.<denoMinor>.<patch> で、patch が denoPatches (下の定数) のどれか。denoPatches は、このファイルが引く canon の事実と recommended の lint を測った版だけを持つ。このプロセスを動かす deno を見る (段の子も同じ PATH で引く)。
 *   - shellcheck: shellcheckVersion だけ。版で出す指摘が違う (canon: facts/shellcheck/sc2015-version-difference)。
 *   - git: verify.sh の事前条件 (verify.sh が確かめる)。
 *   - 版を足す・上げるときは、次を済ませてから、その道具の版の定数 (deno は denoMinor・denoPatches、shellcheck は shellcheckVersion) を変える:
 *     1. 次を新しい版で測り直す。このファイルが引く canon の事実と、deno info --json の形 (下の「deno.json の imports」)。
 *     2. deno: deno lint の recommended に増えた規則の指摘を直す。
 *     3. 同じ commit で .github/workflows/verify.yml を合わせる:
 *        - deno: deno-version を denoPatches に入る版にする。
 *        - shellcheck: SHELLCHECK_VERSION と、取る tar.xz の sha256 を shellcheckVersion の版のものにする。
 * - 名前: git が知る項目を -z で受ける (canon: facts/git/path-output-quoting)。
 *   - 追跡された項目は `git ls-files -s -t --cached` で種類も受け、次の全部を満たすものだけを処理する (canon: facts/git/repository-shapes の「作業ツリーの項目」)。
 *     - 項目が `<tag> <mode> <object> <stage>\t<名前>` の形 (tag は 1 文字、mode は 6 桁の 8 進、stage は 0〜3)。
 *     - 通常ファイル (mode 100644・100755)。mode ごとの扱い:
 *
 *       | mode | 扱い (直し方) |
 *       | --- | --- |
 *       | 100644・100755 | 処理する |
 *       | 120000 (symlink) | 段の前で落ちる。deno がリンク先 (ディレクトリならその中の git の知らない .ts) まで検査するため (通常ファイルにするか git rm --cached する) |
 *       | 160000 (gitlink) | 段の前で落ちる。サブモジュールで、検査する対象でない (git rm --cached する) |
 *       | 他 | 段の前で落ちる。想定外 (git の版を確かめる) |
 *
 *     - skip-worktree でない (tag が S でない)。作業ツリーから消えていても `--deleted` に出ない。
 *     - 解決していない merge の項目でない (stage が 0)。
 *   - 未追跡の項目は `git ls-files --others --exclude-standard` で名前だけを受ける。種類は受けないので、下の名前の述語だけで決める (未追跡の symlink は通る)。
 *   - 名前は次の全部を満たすこと。
 *     - UTF-8 として正しい。不正な名前はコマンドへ渡す引数 (文字列) で表せない (canon: facts/deno/strings-encode-lone-surrogates-as-replacement)。
 *     - 改行を含まない。
 *     - `*`・`?` を含まない。deno check・fmt・lint・test は引数の `*`・`?` を glob として展開し、git が知らないファイルまで検査する (canon: facts/deno/check-file-args-glob、facts/deno/lint-file-args-and-rules)。deno がファイルの引数を文字どおりに受ける手段を持てば、この述語は外せる。
 *     - `/` で終わらない。未追跡の入れ子のリポジトリは `nested/` の形で出る (canon: facts/git/untracked-entry-kinds)。
 *   - 外れる項目が 1 つでもあれば、項目ごとに名前 (バイトを escape したもの) と理由を出して、段の前で落ちる。
 * - 名前の渡し方:
 *   - shellcheck・git・deno (check-json-md.ts を除く): 名前に `./` を前置する。先頭の `-` (option)・`!` (deno の除外)・`npm:` など (deno の URL) が名前として読まれる。deno check は `--` の後の名前を無視して cwd 全体を検査する (canon: facts/deno/check-double-dash)。
 *   - check-json-md.ts: 名前を全部、そのまま渡す (canon: facts/deno/run-args-passthrough)。
 * - 拡張子: 検査する拡張子は exts (`.sh`・`.ts`・`.json`・`.md`) で、名前の末尾の綴り (大文字小文字を含む) で対象を決める。
 *   - 段の対象:
 *     - shellcheck: `*.sh`。
 *     - deno fmt・deno lint・deno check・deno.json の imports: `*.ts`。
 *     - deno test: `*_test.ts`。
 *     - JSON と Markdown: 名前の全部を check-json-md.ts に渡し、check-json-md.ts が `*.json`・`*.md` を選ぶ (リンク先として在るかの判定には全部の名前を使う)。
 *   - 対象が無い段は通す (shellcheck は引数が無いと落ちる。canon: facts/shellcheck/no-files-argument)。
 *   - 名前の拡張子の類ごとの扱い (「落ちる」は、処理できない項目として段の前で落ちること):
 *
 *     | 名前の拡張子 | 追跡 (mode 100644) | 追跡 (mode 100755、実行可能) | 未追跡 |
 *     | --- | --- | --- | --- |
 *     | 検査する拡張子 (綴りが一致) | その段で検査する | `.sh`・`.ts` はその段で検査する。`.json`・`.md` は落ちる | その段で検査する |
 *     | 大文字小文字だけ違う (`.SH`・`.Md` など) | 落ちる | 落ちる | 落ちる |
 *     | 他の拡張子 | 検査しない | 落ちる | 検査しない |
 *     | 拡張子なし | 検査しない | 落ちる (hooks/pre-push を除く) | 検査しない |
 *
 *   - 大文字小文字だけ違う名前を落とすのは、どの段も検査せずに通さないため。
 *   - 実行ファイルを落とすのは、拡張子の無い shell を検査せずに通さないため。実行ファイルを検査する段は shellcheck と deno だけ。
 *   - hooks/pre-push は、名前を git が決め、agent-sync が置く。検査は配る側 (ikeyan/agent-files の verify) が受け持つ。
 *   - 未追跡の項目は mode を受けないので、実行可能かを見ない。
 * - deno lint は recommended の規則で回し、cwd の deno.json の lint 設定を読む (canon: facts/deno/lint-file-args-and-rules)。
 * - deno test の許可:
 *   - write: 段の TMPDIR だけ (canon: facts/deno/make-temp-dir-permissions)。
 *   - read・env・run: 絞らない。test は次をする:
 *     - リポのファイル (verify.sh・hooks/pre-push など) を読む。
 *     - 環境を丸ごと子に渡す。
 *     - verify.sh・run-checks.ts・check-json-md.ts と、PATH を差し替えた fake を起動する。
 *   - 外せる条件: `--allow-run=deno` で、差し替えた PATH の dir の deno を起動できるようになったら (canon: facts/deno/allow-run-name-with-child-path)、run を起動するものに絞る。
 * - deno.json の imports の各キー (importKeys 段):
 *   - 指定子を集める: git が知る .ts のそれぞれに `deno info --json` を回し (canon: facts/deno/info-json-dependencies)、graph の module (相対 import で辿った先を含む) の dependencies[].specifier を集める。
 *   - キーが使われているとみなすのは、次のどれか (import map の当て方と、deno.json の imports の展開。canon: facts/deno/import-map-prefix-keys):
 *     - 集めた指定子のどれかと一致する。
 *     - 末尾が / のキーで、集めた指定子のどれかがその接頭辞で始まる。
 *     - 末尾が / でないキーで、値が `npm:`・`jsr:` で始まり / で終わらず、キー + / が imports に無い。集めた指定子のどれかがキー + / で始まる。
 *   - キーと指定子は書かれた文字列のまま比べる。正規化 (相対パス・URL の形のキーの解決) はしないので、そういうキーは指定子と同じ綴りでしか使われているとみなさない。
 *   - 指定子に入る構文:
 *     - 静的 import (`import x from "a"`・`import "a"`・`import { type W } from "a"`)。
 *     - `export … from "a"`。
 *     - `import type`。
 *     - リテラルの動的 import (`import("a")`)。
 *     - 文より前の `/// <reference types="a" />`。
 *   - 入らないもの:
 *     - コメント・文字列の中。
 *     - 文の後の `/// <reference>`。
 *     - JSDoc の `@import`。
 *     - リテラルでない動的 import。
 *   - deno info --json の形 (modules[].dependencies[].specifier・modules[].error) は canon の実測。この段の試験が固定し、deno の版を上げたら測り直す。
 *   - deno info は、ネットワークに出ず、deno.json と deno.lock を読み書きしないフラグで回す。指定子は書かれた文字列のまま出る (canon: facts/deno/info-json-dependencies)。
 *   - 落ちる (未使用の判定をしない) とき:
 *     - deno.json の最上位か imports がオブジェクトでない。
 *     - deno info が非 0 で終わる。
 *     - graph の file: の module に error がある (ファイルが無い、構文が壊れている、相対 import 先が無い。deno info は exit 0。canon: facts/deno/info-json-dependencies)。npm: などの file: でない module の error (--no-npm で取らないもの) は見ない。
 *   - 数える参照は .ts の import の指定子だけ。
 */

const self = "run-checks.ts";
const dec = new TextDecoder();
const enc = new TextEncoder();

const tmpdir = Deno.env.get("TMPDIR");

interface Run {
  code: number;
  out: Uint8Array;
  err: Uint8Array;
}

const fail = (message: string): Run => ({
  code: 1,
  out: new Uint8Array(),
  err: enc.encode(`${message}\n`),
});
const pass = (message: string): Run => ({
  code: 0,
  out: enc.encode(`${message}\n`),
  err: new Uint8Array(),
});

const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);
const describe = (e: unknown) =>
  e instanceof Error ? e.stack ?? String(e) : String(e);
const exited = (command: string, r: Run) =>
  `${command} が exit ${r.code}。下のエラーを直す\n${dec.decode(r.err)}`;

/** 受けるシグナルと、それで終わるときの終了コード。 */
const signals: [Deno.Signal, number][] = [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
];
/** 記録しているグループ (上の「状態 (groups)」)。pgid → そのグループを空にする関数。 */
const groups = new Map<number, () => Promise<void>>();
const killGroup = (child: Deno.ChildProcess, signal: Deno.Signal) => {
  try {
    Deno.kill(-child.pid, signal);
  } catch (e) {
    // ESRCH: グループに誰も残っていない
    if (e instanceof Deno.errors.NotFound) return;
    /*
     * EPERM: macOS の、終わりかけのものだけのグループで観測した (canon: facts/deno/command-spawn の「Deno.kill」)。機構は未確認。
     * - 前提が崩れて、生きたものが残るグループでも EPERM が出るなら、残ったものを検出しない。pipe を持つものは exec の pipe の待ちが検出し、pipe を持たないものは止まらずに残る。
     * - 外す判定:
     *   1. canon の表の測定 (先頭に SIGKILL を送った直後に、この関数と同じ Deno.kill(-pid) でグループへ送る) を、macOS の新しい版ごとに 1000 回回す。
     *   2. EPERM が 0 回の版から外す。
     */
    if (
      Deno.build.os === "darwin" && e instanceof Deno.errors.PermissionDenied
    ) return;
    throw e;
  }
};
/** emptyGroup の SIGTERM の後の待ちと、exec の出力の pipe の待ちの上限 (同じ値を使う)。 */
const graceMs = 2000;
/** p が graceMs 以内に決着すれば true。 */
async function settlesWithin(p: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true, () => true),
      new Promise<boolean>((r) => timer = setTimeout(() => r(false), graceMs)),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function emptyGroup(
  child: Deno.ChildProcess,
  outputs: Promise<unknown>,
) {
  try {
    // SIGTERM の送信が投げても SIGKILL を送る
    try {
      killGroup(child, "SIGTERM");
      // SIGTERM で終わるものに、後始末の猶予を与える
      await settlesWithin(Promise.allSettled([child.status, outputs]));
    } finally {
      try {
        killGroup(child, "SIGKILL");
      } finally {
        await child.status;
      }
    }
  } catch (e) {
    throw new Error(
      `段のプロセスグループ (pgid ${child.pid}) を空にできない。残ったものを手で止める (kill -KILL -- -${child.pid}) — ${
        messageOf(e)
      }`,
    );
  }
}

/** deno test の段の TMPDIR。消すのは remove で、並行に呼んでも 1 回だけ消す。 */
let testTmp: { path: string; remove: () => Promise<void> } | undefined;
/** testTmp を消せないときの文言。段の結果と終了の経路で同じものを出す。 */
const testTmpLeft = (path: string, e: unknown) =>
  `${self}: deno test の段の TMPDIR (${path}) を消せない。手で消す — ${
    messageOf(e)
  }`;

/** 終了の経路が始まっていれば、その経路 (解決しない)。 */
let finishing: Promise<never> | undefined;
/** 終了の経路 (上の「終了」)。後の呼び出しは最初の経路を返す。 */
const finish = (code: number): Promise<never> =>
  finishing ??= (async () => {
    const emptied = await Promise.allSettled(
      [...groups.values()].map((empty) => empty()),
    );
    for (const r of emptied) {
      if (r.status === "rejected") {
        console.error(`${self}: ${messageOf(r.reason)}`);
      }
    }
    if (testTmp) {
      try {
        await testTmp.remove();
      } catch (e) {
        console.error(testTmpLeft(testTmp.path, e));
      }
    }
    Deno.exit(code);
  })();
for (const [signal, code] of signals) {
  Deno.addSignalListener(signal, () => void finish(code));
}
/** 出した失敗の記録を消す (上の「終了」)。呼ぶ側は失敗を出した後に、await を挟まずに呼ぶ。 */
const dropReportedRecords = () => {
  groups.clear();
  testTmp = undefined;
};
/** 段より前の失敗を出して終わる。終了の経路が始まっていれば、何も出さずにそれを待つ。 */
const failBeforeSteps = async (problems: string[]): Promise<never> => {
  await finishing;
  console.error(
    problems.map((p) => `${self}: ${p}`).join("\n") +
      "\n検査の段は回していない",
  );
  dropReportedRecords();
  return finish(1);
};

const [state] = Deno.args;
if (Deno.args.length !== 1 || (state !== "0" && state !== "1")) {
  console.error(
    `${self}: 引数は hook を揃えた結果 (0 か 1) の 1 つだけ。./verify.sh から起動する (${
      Deno.args.join(" ")
    })`,
  );
  await finish(2);
}

/** 子の環境の、このプロセスの環境からの差分。 */
interface EnvChange {
  set?: Record<string, string>;
  unset?: string[];
}

const concat = (chunks: Uint8Array[]) => {
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let i = 0;
  for (const c of chunks) {
    all.set(c, i);
    i += c.length;
  }
  return all;
};

/** 閉じるか cancel されるまで読む。Response の読みは cancel できない (canon: facts/deno/command-spawn の「出力の pipe を持ったまま残る子孫と、読み端の cancel」)。 */
async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concat(chunks);
    chunks.push(value);
  }
}

/** 子を自分のプロセスグループで起動し、終わってグループを空にするまで待つ。 */
async function exec(
  cmd: string,
  args: string[],
  { set = {}, unset = [] }: EnvChange = {},
): Promise<Run> {
  await finishing;
  const env = Deno.env.toObject();
  for (const name of unset) delete env[name];
  const child = new Deno.Command(cmd, {
    args,
    env: { ...env, ...set },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    detached: true,
  }).spawn();
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const outputs = Promise.all(readers.map(readAll));
  // 待つまでに reject すると unhandled rejection でこのプロセスが落ち、グループが残る (canon: facts/deno/unhandled-rejection-exits)
  outputs.catch(() => {});
  let emptied: Promise<void> | undefined;
  // 終了の経路と exec の finally の両方が呼ぶ。グループに kill を 2 度送らないよう、1 つの emptyGroup を共有する
  const empty = () =>
    emptied ??= emptyGroup(child, outputs).then(() => {
      groups.delete(child.pid);
    });
  groups.set(child.pid, empty);
  try {
    const { code } = await child.status;
    await empty();
    // グループの外に残った子孫が pipe を持っていれば閉じないので、上限を置く
    const closed = await settlesWithin(outputs);
    if (!closed) await Promise.all(readers.map((r) => r.cancel()));
    const [out, err] = await outputs;
    return closed ? { code, out, err } : {
      code: 1,
      out,
      err: concat([
        err,
        enc.encode(
          `${self}: ${cmd} の出力の pipe が、${cmd} が終わっても閉じない (${graceMs} ms 待った)。pipe を持つプロセスを ps -eo pid,ppid,pgid,args で探して止める\n`,
        ),
      ]),
    };
  } finally {
    await empty();
  }
}

/** git の場所を決める変数 (上の「入力と環境の定義域」)。 */
const localEnvVars = await exec("git", ["rev-parse", "--local-env-vars"]).then(
  (r) =>
    r.code === 0
      ? dec.decode(r.out).split("\n").filter(Boolean)
      : failBeforeSteps([exited("git rev-parse --local-env-vars", r)]),
  (e) =>
    failBeforeSteps([
      e instanceof Deno.errors.NotFound
        ? `git rev-parse --local-env-vars を起動できない。git を PATH に置く — ${
          messageOf(e)
        }`
        : describe(e),
    ]),
);
const git = (args: string[]) => exec("git", args, { unset: localEnvVars });

/** 検査の結果を変える deno の変数。deno 2.9.8 の --help が挙げるもののうちの分類で、文書に無い変数は分類していない (canon: facts/deno/environment-and-config-inputs)。 */
const denoResultVars = [
  "DENO_COMPAT",
  "DENO_CONDITIONS",
  "DENO_COVERAGE_DIR",
  "DENO_TSC_BIN",
  "DENO_V8_FLAGS",
];
/** deno を args で、上の「入力と環境の定義域」の deno の環境で起動する。tmp があれば子の TMPDIR にする。 */
const deno = (args: string[], tmp?: string) =>
  exec("deno", args, {
    set: {
      DENO_NO_PACKAGE_JSON: "1",
      ...(tmp === undefined ? {} : { TMPDIR: tmp }),
    },
    unset: denoResultVars,
  });

/** 印字できる ASCII (空白と \ を除く) の他のバイトを \xHH にする。 */
const escapeBytes = (b: Uint8Array) =>
  Array.from(
    b,
    (c) =>
      c > 0x20 && c < 0x7f && c !== 0x5c
        ? String.fromCharCode(c)
        : `\\x${c.toString(16).padStart(2, "0")}`,
  ).join("");

const splitNul = (b: Uint8Array): Uint8Array[] => {
  const names: Uint8Array[] = [];
  for (let i = 0; i < b.length;) {
    const end = b.indexOf(0, i);
    const name = b.subarray(i, end < 0 ? b.length : end);
    names.push(name);
    i += name.length + 1;
  }
  return names;
};

/** 段より前の確かめの、外れたものの理由。 */
type Problems = string[];

/** 検査する拡張子 (上の「拡張子」) と、その名前の実行ファイルを検査する段があるか。 */
const exts = {
  // shellcheck の段の対象もここから取る
  sh: { ext: ".sh", executable: true },
  // deno の段の対象もここから取る
  ts: { ext: ".ts", executable: true },
  // 段より前の規則だけが使う
  json: { ext: ".json", executable: false },
  // 段より前の規則だけが使う
  md: { ext: ".md", executable: false },
};
const checkedExts = Object.values(exts).map((e) => e.ext);
const executableExts = Object.values(exts).filter((e) => e.executable).map((
  e,
) => e.ext);
const endsWithAny = (f: string, list: string[]) =>
  list.some((e) => f.endsWith(e));

/** git が知る項目のうち処理するものの名前と、処理できない項目の理由。 */
async function gitFiles(): Promise<{ files: string[]; problems: Problems }> {
  // 並べた exec は全部待ち、投げたものを全部出す
  const [cachedRun, othersRun] = await Promise.allSettled([
    git(["ls-files", "-z", "-s", "-t", "--cached"]),
    git(["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  if (cachedRun.status === "rejected" || othersRun.status === "rejected") {
    return {
      files: [],
      problems: [cachedRun, othersRun].flatMap((r) =>
        r.status === "rejected" ? [describe(r.reason)] : []
      ),
    };
  }
  const cached = cachedRun.value;
  const others = othersRun.value;
  if (cached.code !== 0) {
    return { files: [], problems: [exited("git ls-files --cached", cached)] };
  }
  if (others.code !== 0) {
    return { files: [], problems: [exited("git ls-files --others", others)] };
  }
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const files: string[] = [];
  const rejected = new Set<string>();
  const rename = "名前を変えるか、消す (未追跡なら .gitignore に足してもよい)";
  /** kind は種類で決まる理由。executable は追跡された実行ファイルか。 */
  const accept = (
    name: Uint8Array,
    kind: string | undefined,
    executable: boolean,
  ) => {
    let reason = kind;
    if (reason === undefined) {
      try {
        const f = utf8.decode(name);
        reason = f.includes("\n")
          ? `名前が改行を含む。${rename}`
          : /[*?]/.test(f)
          ? `名前が、deno が glob として展開する * か ? を含む。${rename}`
          : f.endsWith("/")
          ? "未追跡の入れ子のリポジトリ (/ で終わる)。消すか .gitignore に足す"
          : !endsWithAny(f, checkedExts) &&
              endsWithAny(f.toLowerCase(), checkedExts)
          ? `拡張子が ${
            checkedExts.join("・")
          } と大文字小文字だけ違う。小文字にする`
          : executable && !endsWithAny(f, executableExts) &&
              f !== "hooks/pre-push"
          ? `実行ファイルで、名前が ${
            executableExts.join("・")
          } でない (実行ファイルを検査する段が無い)。shell なら .sh と名付け、他は git update-index --chmod=-x する`
          : undefined;
        if (reason === undefined) files.push(f);
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        reason = `名前が UTF-8 として不正。${rename}`;
      }
    }
    if (reason !== undefined) rejected.add(`${escapeBytes(name)}: ${reason}`);
  };
  // 各項目は `<tag> <mode> <object> <stage>\t<名前>` (git ls-files の --stage と -t)
  const shape = /^(\S) ([0-7]{6}) [0-9a-f]+ ([0-3])$/;
  for (const entry of splitNul(cached.out)) {
    const tab = entry.indexOf(0x09);
    const head = tab < 0
      ? null
      : dec.decode(entry.subarray(0, tab)).match(shape);
    if (head === null) {
      accept(
        tab < 0 ? entry : entry.subarray(tab + 1),
        "git ls-files -s -t の項目の形でない。git の版を確かめる",
        false,
      );
      continue;
    }
    const [, tag, mode, stage] = head;
    accept(
      entry.subarray(tab + 1),
      mode === "120000"
        ? "追跡された symlink (deno がリンク先まで検査する)。通常ファイルにするか git rm --cached する"
        : mode === "160000"
        ? "gitlink (サブモジュール)。git rm --cached する"
        : mode !== "100644" && mode !== "100755"
        ? `想定外の mode (${mode})。git の版を確かめる`
        : tag === "S"
        ? "skip-worktree の項目。git update-index --no-skip-worktree する"
        : stage !== "0"
        ? "解決していない merge の項目。解決して git add する"
        : undefined,
      mode === "100755",
    );
  }
  for (const name of splitNul(others.out)) accept(name, undefined, false);
  return {
    files,
    problems: rejected.size
      ? [
        `処理できない項目がある:\n${
          [...rejected].map((r) => `- ${r}`).join("\n")
        }`,
      ]
      : [],
  };
}

async function deletedFiles(): Promise<Problems> {
  const r = await git(["ls-files", "-z", "--deleted"]);
  if (r.code !== 0) return [exited("git ls-files --deleted", r)];
  const names = splitNul(r.out);
  return names.length
    ? [
      `作業ツリーに無い追跡ファイルがある。戻すか git rm する: ${
        names.map(escapeBytes).join(" ")
      }`,
    ]
    : [];
}

const denoMinor = 9;
const denoPatches = [7, 8];
function denoVersion(): Promise<Problems> {
  const v = Deno.version.deno;
  const accepted = denoPatches.map((p) => `2.${denoMinor}.${p}`);
  return Promise.resolve(
    accepted.includes(v) ? [] : [
      `deno の版が ${v} で、受ける版 (${
        accepted.join("・")
      }) でない。.github/workflows/verify.yml の deno-version の版を入れる: deno upgrade --version <その版>`,
    ],
  );
}

const shellcheckVersion = "0.11.0";
const shellcheck = (args: string[]) =>
  exec("shellcheck", ["--norc", ...args], { unset: ["SHELLCHECK_OPTS"] });
const shellcheckInstall = [
  `shellcheck ${shellcheckVersion} を PATH の先に置き、shellcheck --version で確かめる。置き方は次のどれか:`,
  "- release の tar.xz:",
  `  1. https://github.com/koalaman/shellcheck/releases/tag/v${shellcheckVersion} から、OS と CPU に合う shellcheck-v${shellcheckVersion}.<os>.<arch>.tar.xz を取る。`,
  "  2. Linux の x86_64 なら、.github/workflows/verify.yml の sha256 と合うことを確かめる (sha256sum -c)。",
  "  3. 展開した shellcheck を PATH の先のディレクトリ (~/.local/bin など) に置く。",
  "- Homebrew (macOS):",
  `  1. brew info shellcheck で、入る版が ${shellcheckVersion} かを確かめる。違えば release の tar.xz で置く。`,
  "  2. brew install shellcheck。",
].join("\n");
async function shellcheckProbe(): Promise<Problems> {
  const problem = (message: string): Problems => [
    `${message}\n${shellcheckInstall}`,
  ];
  let probe: Run;
  try {
    probe = await shellcheck(["--version"]);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    return problem("shellcheck が PATH に無い。");
  }
  // 版は version: の行にある (canon: facts/shellcheck/version-output-form)
  const actual = probe.code === 0
    ? dec.decode(probe.out).match(/^version: (.*)$/m)?.[1]
    : undefined;
  if (actual === undefined) {
    return problem(
      `shellcheck --version から版が読めない (exit ${probe.code})\n${
        dec.decode(probe.out)
      }${dec.decode(probe.err)}`,
    );
  }
  if (actual !== shellcheckVersion) {
    return problem(
      `shellcheck の版が ${actual} で、${shellcheckVersion} でない。`,
    );
  }
  return [];
}

const [listing, others] = await Promise.all([
  gitFiles().catch((e) => ({ files: [], problems: [describe(e)] })),
  Promise.all(
    [deletedFiles, denoVersion, shellcheckProbe].map((check) =>
      check().catch((e): Problems => [describe(e)])
    ),
  ),
]);
await finishing;
const files = listing.files;
const withExt = (ext: string) => files.filter((f) => f.endsWith(ext));
const dotSlash = (f: string) => `./${f}`;
const ts = withExt(exts.ts.ext);
const tests = ts.filter((f) => f.endsWith("_test.ts"));
const preProblems = [...listing.problems, ...others.flat()];
const setWritableTmpdir = "書けるディレクトリを TMPDIR に設定する";
if (tests.length) {
  if (!tmpdir) {
    preProblems.push(
      `TMPDIR が未設定か空で、deno test の段の TMPDIR を作る場所が無い。${setWritableTmpdir}`,
    );
  } else if (!tmpdir.startsWith("/")) {
    preProblems.push(
      `TMPDIR (${tmpdir}) が絶対パスでない。絶対パスの、${setWritableTmpdir}`,
    );
  } else if (preProblems.length === 0) {
    try {
      // 終了の経路が作りかけを見落とさないように、同期で作る
      const path = Deno.makeTempDirSync({
        dir: tmpdir,
        prefix: "run-checks-",
      });
      let removal: Promise<void> | undefined;
      testTmp = {
        path,
        remove: () => removal ??= Deno.remove(path, { recursive: true }),
      };
    } catch (e) {
      preProblems.push(
        `deno test の段の TMPDIR を、TMPDIR (${tmpdir}) の下に作れない。${setWritableTmpdir} — ${
          messageOf(e)
        }`,
      );
    }
  }
}
if (preProblems.length) await failBeforeSteps(preProblems);

const noTargets = "対象のファイルが無い";
/** targets があれば、`./` を前置した名前を run に渡す。無ければ段を通す。 */
const onFiles = (
  targets: string[],
  run: (names: string[]) => Promise<Run>,
) =>
  targets.length
    ? run(targets.map(dotSlash))
    : Promise.resolve(pass(noTargets));
/** 名前を取る deno の subcommand の入口。args の後に targets を置く。 */
const denoFiles = (args: string[], targets: string[]) =>
  onFiles(targets, (names) => deno([...args, ...names]));

/** deno.json の imports の各キーが、.ts の import の指定子から使われていること。 */
async function importKeys(): Promise<Run> {
  const config = JSON.parse(await Deno.readTextFile("deno.json"));
  if (
    typeof config !== "object" || config === null || Array.isArray(config)
  ) {
    return fail(
      `deno.json: 最上位がオブジェクトでない。オブジェクトにする — ${
        JSON.stringify(config)
      }`,
    );
  }
  const { imports = {} } = config;
  if (
    typeof imports !== "object" || imports === null || Array.isArray(imports)
  ) {
    return fail(
      `deno.json: imports がオブジェクトでない。指定子から依存への対応のオブジェクトにする — ${
        JSON.stringify(imports)
      }`,
    );
  }
  const keys = Object.keys(imports);
  // 並べた exec は全部待ち、投げたものを全部出す
  const infos = await Promise.all(ts.map((f) =>
    deno([
      "info",
      "--json",
      "--no-config",
      "--no-lock",
      "--no-npm",
      "--no-remote",
      dotSlash(f),
    ]).then((r) => ({ f, r }), (reason: unknown) => ({ f, reason }))
  ));
  const problems: string[] = [];
  const specifiers = new Set<string>();
  for (const info of infos) {
    const { f } = info;
    if ("reason" in info) {
      problems.push(`${f}: ${describe(info.reason)}`);
      continue;
    }
    const { r } = info;
    if (r.code !== 0) {
      problems.push(`${f}: ${exited("deno info", r)}`);
      continue;
    }
    for (const m of JSON.parse(dec.decode(r.out)).modules) {
      if (m.error && m.specifier.startsWith("file:")) {
        problems.push(`${f}: ${m.specifier}: ${m.error}`);
      }
      for (const d of m.dependencies ?? []) specifiers.add(d.specifier);
    }
  }
  if (problems.length) {
    problems.push(
      "deno.json: imports の未使用の判定をしていない。上を直してから回す",
    );
    return fail(problems.join("\n"));
  }
  /** キーが接頭辞として当たる形。無ければ undefined。 */
  const prefixOf = (key: string) => {
    if (key.endsWith("/")) return key;
    const value = imports[key];
    return typeof value === "string" && /^(?:npm|jsr):/.test(value) &&
        !value.endsWith("/") && !(`${key}/` in imports)
      ? `${key}/`
      : undefined;
  };
  const unused = keys.filter((key) => {
    const prefix = prefixOf(key);
    return ![...specifiers].some((s) =>
      s === key || (prefix !== undefined && s.startsWith(prefix))
    );
  });
  return unused.length
    ? fail(
      unused.map((key) =>
        `deno.json: imports の "${key}" が、どの .ts の静的な import・export・リテラルの動的 import の指定子にも見つからない。使うか deno.json から消す`
      ).join("\n"),
    )
    : pass(`ok: imports ${keys.length} 件、.ts ${ts.length} 件`);
}

async function denoTest(): Promise<Run> {
  if (tests.length === 0) return pass(noTargets);
  if (testTmp === undefined) throw new Error("deno test の段の TMPDIR が無い");
  const { path, remove } = testTmp;
  // 段の結果を先に決め、TMPDIR を消せなければそれに足す
  const r = await deno([
    "test",
    "--allow-read",
    `--allow-write=${path}`,
    "--allow-env",
    "--allow-run",
    ...tests.map(dotSlash),
  ], path).catch((e) => fail(describe(e)));
  try {
    await remove();
    return r;
  } catch (e) {
    return {
      code: 1,
      out: r.out,
      err: concat([r.err, enc.encode(`${testTmpLeft(path, e)}\n`)]),
    };
  }
}

const steps: [string, () => Promise<Run>][] = [
  ["shellcheck", () => onFiles(withExt(exts.sh.ext), shellcheck)],
  ["deno fmt", () => denoFiles(["fmt", "--check"], ts)],
  ["deno lint", () => denoFiles(["lint"], ts)],
  ["deno check", () => denoFiles(["check"], ts)],
  ["deno test", denoTest],
  ["deno.json の imports", importKeys],
  [
    "JSON と Markdown",
    () =>
      deno([
        "run",
        "--allow-read=.",
        import.meta.resolve("./check-json-md.ts"),
        ...files,
      ]),
  ],
];

/** 段が通ったか。出力の先と終了コードの両方がこれで決まる。 */
const passed = (r: Run) => r.code === 0;
const results = await Promise.all(
  steps.map(async ([name, run]) => ({
    name,
    ...await run().catch((e): Run => fail(describe(e))),
  })),
);
await finishing;

const writeErrors = new Set<string>();
const write = (
  name: string,
  w: { writeSync(p: Uint8Array): number },
  data: Uint8Array,
) => {
  try {
    for (let i = 0; i < data.length;) i += w.writeSync(data.subarray(i));
  } catch (e) {
    if (e instanceof Deno.errors.BrokenPipe) return;
    writeErrors.add(
      `${name} に書けない。書ける先に出して回し直す — ${messageOf(e)}`,
    );
  }
};
const out = (data: Uint8Array) => write("stdout", Deno.stdout, data);
const err = (data: Uint8Array) => write("stderr", Deno.stderr, data);
for (const r of results) {
  if (passed(r)) {
    out(enc.encode(`== ${r.name}: 通った\n`));
    out(r.out);
    err(r.err);
  } else {
    err(enc.encode(`== ${r.name}: 落ちた (exit ${r.code})\n`));
    err(r.out);
    err(r.err);
  }
}
for (const message of writeErrors) err(enc.encode(`${self}: ${message}\n`));
dropReportedRecords();
await finish(
  state === "1" || writeErrors.size > 0 || !results.every(passed) ? 1 : 0,
);
