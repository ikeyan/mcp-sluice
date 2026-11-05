# 振り返り: 実測 (QuickJS-WASM と authentik) (2026-11-04)

対象はブランチ `claude/nifty-allen-aqn0ll` の PR。読者は、このリポで次に実装を進めるセッション。

## 状況

- [docs/design.md](../docs/design.md) の 11 節「作る順番」の実測のうち、この環境でできる 2 つを行った:
  - 実測 2: QuickJS-WASM (quickjs-emscripten 0.32.0) を Deno 2.9.8 の Worker で動かす。
  - 実測 1 の authentik の側: authentik 2026.8.5 を docker で立てる。
- 実物のクライアント (claude.ai・ChatGPT・Codex・Claude Code) の挙動と、実測 3 (elicitation) は、この環境では測れない。
- 事実は canon (ikeyan/canon の同名ブランチ) に書いた:
  - `facts/quickjs-emscripten/runtime-limits`
  - `facts/deno/worker-terminate-does-not-stop-sync-code`
  - `facts/authentik/oauth2-metadata-routes`
  - `facts/authentik/oauth2-provider-tokens`
  - `facts/mcp-typescript-sdk/as-metadata-discovery-order`

## 良かったこと

- 実装の前に測ったので、仕様の前提の誤りが 3 つ見つかった。どれも実装してからなら、上限が効かないことに気づきにくい。
  - `setMemoryLimit` は文字列と TypedArray の合計を止めない (16 MiB の設定で 1〜2 GB)。
  - `Worker.terminate()` は走っている同期の処理を止めない (Deno のソースと型の記述が食い違う)。
  - `setMaxStackSize` を置かないと、深い再帰がホストの V8 の例外になる。
- authentik は実物を立てて測ったので、ソースの読みだけでは分からなかった 2 つが分かった (RFC 8414 の route の末尾 `/`、API で作る provider の `grant_types` が空)。

## 直したこと

- `59f0d4b`: 7.2 節の上限を実測に合わせた (メモリは実行ごとの WASM module の `maximum`、スタックは必ず置く、CPU の時間は QuickJS の中にいた時間、止め手は interrupt handler だけ)。
- `9a047fb`: 3.1 節と 3.2 節を authentik の実測に合わせた (メタデータの経路、grant type、`nbf` が無いこと、refresh で `groups` が作り直されること、`none` が無いメタデータ)。11 節の実測の残りを、実物のクライアントが要る項目に絞った。
- `7a34f96`: レビューの指摘 3 件を直した。
  - grant type の記述で、実測とソースの読みを分けた。
  - await の待ちの間は interrupt が呼ばれないので、承認待ちを除く実行全体の壁時計の上限を足した。
  - interrupt handler が効かない場合の止め手 (子プロセスに置くか) を未決として書いた。

- `bcca55e`: Codex の指摘を受け、承認待ちと子の応答待ちが重なる間も壁時計が進むと決めた (止まるのは承認だけを待つ間)。

## 残っていること

- 実測 1 の残り (実物のクライアント): どのメタデータの URL を試すか、`profile` を要求するか、redirect URI の実際の形、`none` が無いメタデータで secret 無しで token endpoint に来るか。RFC 8414 の URL しか試さないクライアントがあれば、3.2 節の「ゲートウェイを AS にする方式」が要る。
- 実測 3 (elicitation) は手つかず。
- interrupt handler が効かない場合の止め手を、Code Mode の実装で決める。
- RFC 8414 の本文は、この環境の proxy で読めなかった (規則は MCP の仕様と SDK から間接に確かめた)。
