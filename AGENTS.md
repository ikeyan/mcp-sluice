# コーディング指針

## ワークフロー

- 作業が論理単位に達したら確認を取らず自律的にコミットする。指示待ちしない。
- 実装は subagent に出す (superpowers の subagent-driven-development)。subagent のモデルは役割をこなせる最も弱いものを選び、上限は Opus (`model: opus`)。レビューは review-perspectives の表のモデル。model は毎回明示する (省略すると親のモデルを継ぐ)。
- コミット前にレビューする。判定対象は diff でなく結果のファイル — 変更箇所をファイル全体 (先頭コメント含む) の文脈で、その変更を見ていない初見読者として読み、本 AGENTS.md の指針に沿わなければ修正してからコミットする。
- 人から伝えられた観測や指摘を写すときは、出来事の有無だけでなく修飾語 (自動で・常に・だけ・即時に) も別の命題として検証する。
- レビュー指摘の修正も初回実装と同じ規律を通す (外部依存の契約確認・検証)。レビュー起点のコードは未検証のまま積み上がりやすい。自分のレビューでも外部のレビュー (Codex 等) でも同じ。
  - 指摘が canon の目録の次元に当たるなら、同じ次元の他の値も同じコミットで閉じ、生成器のあるスクリプトでは生成器にも足す (目録に無い次元は先に目録に足す)。閉じる場所は、その次元に触れる操作 (外部依存を呼ぶ行) の側。症状を観測した側 (テストの helper・呼び出し元) で閉じると、製品の呼び出しが開いたまま残る。
  - 同じ箇所へのコードの挙動の指摘は review-perspectives の `findings.md` で数える:
    - 2 回目: 定義域を閉じてから直す。
    - 3 回目以降か、機構の作り直しを要する指摘: 修正の連鎖を止め、契約確認 → 実測 → 再設計に戻る。再設計は同じ機構の別の読み方でなく、機構の種類を変える (プラットフォームが設定無しで提供する形を先に探す)。
- 作ったもの (一時ファイル・ディレクトリ・worktree・ブランチ・タグ) は、それを最後に使う者が消す。subagent が自分のために作ったものは subagent が、subagent より長く生きるもの (親が後で使う worktree・ブランチ・レビューの run ディレクトリなど) は親が消す。他人が消すには中身を精査して不要かを確かめる手間が要る。ゴミが出ない手順、出ても勝手に消える手順を最善とする。
  - 他人が残したものは、中身を確かめて不要と分かったときだけ消す。分からなければ残して報告する。
  - 消したものは報告に書く。
- PR の振り返りは、merge の前に `retrospectives/<日付>-<対象>.md` としてその PR に入れる。close する PR は別の PR で残す。
  - 書くこと: 良かったこと、直したこと (commit を添える)、残っていること。
  - 読者は次の実装セッション。
  - 振り返りの commit へのレビューの指摘も同じ PR で直し、重要なものは振り返りに足す。
- push の前に review-perspectives スキルでレビュー→修正を反復し、終了条件を満たしてから push する。終了条件は「実害シナリオつき correctness 指摘の消滅」。cleanup 指摘のゼロは目指さない (高強度のレビューはゼロに収束しない)。却下した指摘は理由を明文化し、次のレビューへ除外条件として引き継ぐ。修正とレビューが済み、続けて行う作業が無ければ push する。

## 設計

- セキュリティの前提: 利用者の環境 (OS・ネットワーク・環境変数・同じホストの他のプロセス) は信頼する。守るのは利用者とエージェントの誤り (誤った相手への送信、平文でホストの外へ出すこと、トークンの残存)。前提を減らしても得るものは少なく、開発コストだけが上がる。mcp-sluice は複数の利用者を受けるので、「誤った相手」には別の利用者も入る (製品のセキュリティモデルは `docs/design.md` の 0 節)。
- 管理対象の数は保守コストに直結する (管理するリソース・ソース中のコメント・ソース自体の複雑さ)。常に減らす方向を選ぶ。
- 設計時は現在のソース上の対応関係でなく、プラットフォーム自体 (OS・プロトコル・Google 等) の不変制約を第一に考える。最初の問いは「プラットフォームは設定無しで何をするか」。既定を曲げる設定 knob は、その knob の定義域 (scope・優先順位・環境・パスの解決) を丸ごと抱えるので、既定の置き場や挙動で済むなら knob を足さない。OSS が対象なら PR を送って拡張するのも選択肢。
- 外部依存 (自分が書いていないもの — CLI・ライブラリ・カーネル・API) の挙動に依存するコードは、契約を一次情報で確認してから書く。記憶で断定しない。確定済みの契約は canon (`ikeyan/canon` の `facts/<topic>/`) を引く。外部コマンドを呼ぶ行は、そのコマンドが引数の他に読むもの (環境変数・設定ファイル・時刻・locale) の目録を canon で引き、無ければ作ってから書く。指摘で目録の漏れが見つかったら、修正より先に目録を直す。入力と環境の定義域 (OS の版、外部コマンドや依存の版の範囲も含む。版で決まる分岐が不要になったかを後で判定できるように) は仕様 (先頭の宣言) に書き、既定は最も狭いもの (他の CLI が採る形)。テスト用の形 (fake に向ける平文の URL 等) は製品の knob に混ぜず別の変数にする。外部依存の有限の列挙 (exit code、環境変数) は最初の版で全部を規則で分類する。状態を持つ仕組みは、実装の前に同一性の表 (対象・鍵・等しいとみなす条件) を先頭に書く。広げるのは 1 つの操作の契約で全域を覆えるときだけで、値ごとの guard を足さない。定義域が開いた入力 (自由な文字列、外部システムの状態) は canon の目録の次元を生成器で回すテストで固定する。
- リポ全体を検証する単一コマンドを用意し、変更時は必ず通す (テスト・lint・型・フォーマット・各種 validator を 1 つの入口に集約)。何を含めるかはリポごとに一度決める設計判断。単一コマンドの緑は必要条件で十分条件ではない。
- 検査が模擬していない実行時契約 — 実行主体と権限・環境変数・呼び出し元 (orchestrator) — に触れる変更は、その経路を実条件で最低 1 回実測する。全周の再構築でなく変更点に標的を絞った実行プローブでよく、実物が使えなければ同等条件の再現で代替する。実測で確定した契約は可能なら検査として定着させる。

## 初回の準備

- `.claude/settings.json` は ikeyan-skills と superpowers の plugin を宣言する。入り方は環境で違う:
  - Claude Code on the web: 公式 docs (2026-10-28) によると、届くのは claude.ai の account と組織で有効にした plugin。このリポの宣言は手元の Claude Code 向け (canon: facts/claude-code/cloud-session-ignores-repo-declared-plugins)。
  - 手元の Claude Code: 各利用者が shell で入れる (canon: facts/claude-code/external-plugin-requires-per-user-install-trust)。
    - 前提: 公式の marketplace (`claude-plugins-official`) が登録されている。
      - 最初の対話のセッションで Claude Code が足す。
      - 対話のセッションを開いたことのない機械では、先に `claude plugin marketplace add anthropics/claude-plugins-official` で足す。
    - 手順 (cwd はこのリポのルート):
      1. marketplace を足す: `claude plugin marketplace add ikeyan/agent-files` (`ikeyan` の名前で登録される)。
      2. plugin を入れる: `claude plugin install ikeyan-skills@ikeyan --scope project` と `claude plugin install superpowers@claude-plugins-official --scope project`。
    - cwd がリポのルートでなくても、`--scope project` はエラーにならずに cwd の `.claude/settings.json` に書く (リポのルートの `.claude/settings.json` には書かない)。

## このリポの仕様

- 仕様の正本は [docs/design.md](docs/design.md)。実装が設計と食い違ったら、同じ commit でどちらかを直して揃える。
- 設計の根拠にした外部依存の事実は、design.md の各出典に確認した日を添えて書いてある。実装で使う前に、canon に出典つきで足す。

## このリポの検証

- clone したら、まず `./verify.sh` を 1 回回す。pre-push の hook (`PUSH_OK=1` の判定) は、このとき入る。
- 単一検証コマンドは `./verify.sh`。CI も同じものを回す。
- 規則の本文は次のファイルの先頭にある。変えるときはそこを直す:
  - `verify.sh`:
    - 事前条件。
    - 入力:
      - 引数。
      - `$0`。
      - 消す環境変数。
    - hook の状態ごとの扱い。
    - TMPDIR の値ごとの扱い。
  - `scripts/run-checks.ts`:
    - 検査の段と対象。
    - git が知る項目の種類と名前の扱い。
    - 段の子の環境。
    - lint の規則。
    - imports の判定。
    - 出力の順と終了コード。
    - 終了 (中断を含む)。
    - 版の範囲とその上げ方。
  - `scripts/check-json-md.ts`: リンクと anchor の解決。
- 各検査が見るもの:
  - 段より前:
    - git が知る項目の種類と名前。
    - 作業ツリーに無い追跡ファイル。
    - deno と shellcheck の版。
    - deno test の段の TMPDIR を作れること (test があるときだけ)。
  - `shellcheck`: このリポが持つ `*.sh`。
  - 次の 3 つは git が知る `.ts`:
    - `deno fmt --check`
    - `deno lint`
    - `deno check`
  - `deno test`: git が知る `*_test.ts`。
  - `deno.json` の `imports`: 各キーが `.ts` の import 指定子から使われていること。
  - `scripts/check-json-md.ts`: `.json` の構文と、`.md` のリポ内リンク・anchor。
- このリポの `.ts` が export を持つようになったら、未使用の export・module の検査を足す。
- 版の範囲は次の場所に書く。
  - `verify.sh` の事前条件。
  - `scripts/run-checks.ts` の先頭の「版」。
  - CI が使う版: `.github/workflows/verify.yml`。
- 必要なもの:
  - `bash`
  - `cmp`
  - `install`
  - `shellcheck`
  - `deno`
  - `git`
- 依存は `deno.json` に完全な版で書き、`deno.lock` で固定する。新しすぎる版を避ける `minimumDependencyAge` の意味は canon: facts/deno/minimum-dependency-age。
- `deno.lock` が `deno.json` と食い違えば `./verify.sh` が落ちる。直すのは `deno install --frozen=false`。

## このリポの言語

- 製品・テスト・開発用のスクリプトは TypeScript (Deno) で書く。
- shell は次だけ (場所: shell にする理由):
  - `verify.sh`: `scripts/run-checks.ts` に deno の許可を渡して起動する入口で、pre-push の hook も写す。deno で hook を写すと、run-checks.ts の許可に common git dir への write が要る。
  - agent-sync が shell のまま置くもの:
    - `hooks/pre-push`
    - `.agent-sync/sync.sh`
    - `.claude/skills/pr-workflow/` の shell
  - `.github/workflows/verify.yml` の `run`:
    - shellcheck の入手 (sha256 の確かめを含む): `./verify.sh` より前に PATH に置く CI の準備で、step の `run` は shell で回る。
    - `./verify.sh` の起動: CI も手元と同じ入口を回す。
- Lua は `.agent-sync/archetype/archetype.lua` だけ: agent-sync が archetect で描画するときの入力で、archetect が Lua を要る。

## 外部依存の事実

- コードとコメントは、外部依存に依る制約の文の末尾に canon の参照を添える (writing-comments)。
- canon を読めない環境では、一次情報を直接確かめる。一次情報は次のもの:
  - 仕様。
  - ソース。
  - 公式 docs。

## 文書の言語

- 利用者向けの文書 (`README`・`docs/` の利用者向けのもの): 英語。
- 開発者向けの文書: 日本語。
  - `AGENTS.md`
  - `docs/design.md`
  - `retrospectives/`
  - `review-perspectives/`

## コメントの書き方

ikeyan-skills plugin の writing-comments スキルに従う。

## 文書 (Markdown) の書き方

review-perspectives スキルの次の観点に従う。

- ハードラップしない
- 論理構造を散文に埋め込まない
- 読者を想定して書く
