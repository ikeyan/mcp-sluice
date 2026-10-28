# mcp-sluice 設計

mcp-sluice は、複数の子 MCP サーバーを 1 つのエンドポイントに束ねる MCP サーバー。次の機能を持つ。

- 認証: authentik (OIDC) で利用者を認証する。
- 権限: 利用者のグループとツールごとに allow/ask/deny を掛ける。
- Code Mode: TypeScript でツールを呼ぶスクリプトを実行する。
- 観測: OpenTelemetry で trace・metrics・log を送る。

この文書の読者は、mcp-sluice を実装・変更する人。この文書が仕様の正本になる。

外部依存の事実は、一次情報で確かめたものを根拠に書き、各出典に確認した日を添える。外部の契約が今も成り立つかを、後でその日から判定するため。確かめられなかったものは「未確認」と書き、選定の根拠にしない。一次情報は次のもの:

- 仕様の repo
- ソース
- 公式 docs

「将来」と書いた節は、最初の公開に含めない。最初の版のデータの持ち方が、それを後から足せる形になるように書いてある。

## 0. 前提

- 公開リポ (OSS) として作る。
  - 認証は OIDC の一般の仕組みで書く。設定例と手順は authentik で示す。
- 利用者は複数人。
  - authentik の application の policy を通った人が、利用者になれる。
  - 利用者ごとの権限は、トークンの `groups` で分ける。
- 対象のクライアント:
  - Claude Code
  - claude.ai (Claude Desktop と mobile を含む)
  - Codex
  - ChatGPT

  claude.ai に含まれるものは、どれも同じ callback の URL で接続する (`claude.com/docs/connectors/building/authentication` の Callback URLs、2026-10-28)。
- 守るもの:
  - エージェントの誤り。プロンプトインジェクションで書かれたスクリプトが外部へ持ち出すことも含む。
  - 誤った相手への送信。利用者 A の資格情報や承認が、利用者 B の要求に使われることも含む。
  - 平文でホストの外へ出すこと。
  - トークンの残存と流用。
- 信頼するもの:
  - ゲートウェイが動くホスト
  - 管理者が登録した子サーバー
  - authentik
  - 観測の基盤

## 1. 全体の構成

```
 MCP クライアント (Claude Code / claude.ai / Codex / ChatGPT)      ブラウザ (承認のページ)
        │ Streamable HTTP + Bearer (authentik の JWT)                    │ OIDC ログイン (同じ authentik)
        ▼                                                                  ▼
 ┌──────────────────────────── mcp-sluice (1 プロセス, Deno) ─────────────────────────────┐
 │ HTTP 層    : /mcp, /.well-known/oauth-protected-resource, /i/<id> (利用者の操作のページ) │
 │ 認証       : JWT 検証 (JWKS)、ブラウザのセッション                                     │
 │ カタログ   : 子のツールを名前空間つきで合成し、利用者ごとに policy で絞る               │
 │ Policy     : allow / ask / deny (グループつきの規則)                                    │
 │ 利用者の操作: 承認を elicitation か URL で利用者に求め、中断した要求を再開する           │
 │ Code Mode  : 型検査と変換 (typescript) → QuickJS-WASM (worker で実行)                   │
 │ 子の管理   : 子への接続、list_changed の受信                                            │
 │ 観測       : OpenTelemetry (trace / metrics / log) を OTLP で送る                         │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
        │ stdio (共有の子プロセス) / Streamable HTTP (共有の資格情報)
        ▼
 子 MCP サーバー群

 観測 (compose に同梱): Tempo (trace) / Loki (log) / Prometheus (metrics) / Grafana (UI, authentik でログイン)
```

- 実行時:
  - Deno 2.x を使う。
  - 公式 TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0) を使う。README は、次で動くと書く (https://github.com/modelcontextprotocol/typescript-sdk の README、2026-10-28):
    - Node.js
    - Bun
    - Deno
- 持つ状態:
  - メモリだけに持つ: 中断した要求 (承認待ちの Code Mode の実行など)。
  - メモリの状態があるので、レプリカは 1 つにする。
  - 将来の `per_user` (3.3 節) で、利用者ごとの子のトークンを SQLite のファイルに暗号化して持つ。
- 配る形: コンテナイメージ。docker compose の例も付ける (ゲートウェイと観測の基盤)。

## 2. プロトコルの版

- 2 つの世代を両方受ける。
  - 2026-07-28 (最新):
    - `initialize` もセッションも無い。
    - サーバーからクライアントへの要求は、`tools/call` の結果として `input_required` を返し、クライアントが再送する形 (Multi Round-Trip Requests。以下 MRTR) だけになった。
  - 2025-11-25 まで:
    - `initialize` とセッションがある。
    - POST の SSE の流れの中で `elicitation/create` を送れる。
- 両方を受ける理由:
  - claude.ai の connector の docs が挙げる authorization の仕様は 2025-11-25 まで (https://claude.com/docs/connectors/building/index.md の Specification version、2026-10-28)。
  - Claude Code は 2026-07-28 に対応している (https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md の 2.1.281 に、2026-07-28 の接続での URL mode の elicitation がある。2026-10-28)。
- SDK v2 は 1 つの handler で両世代を受けられる (`docs/protocol-versions.md`・`examples/dual-era`)。
- 2025-11-25 の経路を外せる条件: 対象のクライアント (0 節) が、どれも 2026-07-28 で接続するようになったとき。
  - 確かめ方: 11 節の実測 3。
  - 追跡先: anthropics/claude-ai-mcp#153 (claude.ai の elicitation の対応の要望)。
- 子へは、SDK v2 の client を `versionNegotiation: { mode: 'auto' }` で使う。
- `tools/list` の結果:
  - 利用者ごとに絞るので、`cacheScope: "private"` を付ける (2026-07-28 の caching)。
  - `ttlMs` は短めにし、`list_changed` を併用する。

## 3. 認証

### 3.1 authentik でできること・できないこと

authentik 2026.8.5 と main のソースで確認した。

機能の有無:

| 機能 | 状態 | 影響 |
| --- | --- | --- |
| Dynamic Client Registration (DCR) | 有り。ただし `goauthentik.io/oidc/dcr` scope を持つ Bearer が要る | 匿名で登録しにくる MCP クライアントは 401 で失敗する |
| Client ID Metadata Documents (CIMD) | 無し | 使えない |
| RFC 8707 `resource` | 読まない | `aud` をゲートウェイに向けられない |
| RFC 8414 のメタデータ | 無し。OIDC discovery (`/application/o/<slug>/.well-known/openid-configuration`) だけ | クライアントが OIDC discovery に落ちる必要がある |
| refresh token | `offline_access` のときだけ出る。既定で rotation する | claude.ai の要件 (公開クライアントの rotation) を満たす |
| 非対称の署名と JWKS | 署名鍵を設定すれば有り | 非対称の署名鍵を必ず設定する |

トークンと登録の値:

| 項目 | 既定・値 | このゲートウェイの扱い |
| --- | --- | --- |
| `aud` | provider の client_id | client_id で検証する |
| `sub` | 既定は `hashed_user_id` (authentik の設置ごとに違う) | 利用者の鍵は (`iss`, `sub`) にする |
| redirect URI | strict か regex (`fullmatch`) | loopback の任意のポートを regex で通す |
| `groups` | 既定の `profile` の scope mapping に入る。access token にも入る (`include_claims_in_id_token` の既定は true) | policy にそのまま使う |

### 3.2 方式: 事前登録した公開クライアント 1 つ

- authentik に作るもの:
  - application と OAuth2 provider を 1 組作る。
  - client type は public、署名鍵は非対称にする。
  - redirect URI (regex) を登録する。

    | クライアント | redirect URI |
    | --- | --- |
    | claude.ai | `https://claude\.ai/api/mcp/auth_callback` |
    | Claude Code | `http://(localhost\|127\.0\.0\.1):\d+/callback` |
    | Codex | 上と同じ形で、末尾に `/<id>` が付くことがある (未確認。実測で決める) |
    | mcp-sluice 自身 (ブラウザのページ) | `https://<公開ホスト>/auth/callback` |

  - scope: `openid profile email offline_access`
  - 誰が使えるかは、application に結ぶ policy で決める。
- ゲートウェイの役割 (resource server):
  - `/.well-known/oauth-protected-resource` (RFC 9728) を出す。
    - `resource` = 公開 URL
    - `authorization_servers` = [issuer]
  - 未認証には 401 と `WWW-Authenticate: Bearer resource_metadata="…"` を返す。claude.ai は 401 でしか認証を始めない (claude.com の connector の docs の authentication の節。200 に付けた `WWW-Authenticate` は無視されると書いてある)。
  - JWT は次を検証する (署名と期限の検証は JOSE のライブラリに任せる):
    - JWKS での署名
    - `iss`
    - `exp`・`nbf`
    - `aud` == 設定の client_id
- ブラウザのページ (`/i/<id>`):
  - provider は 1 つ。同じ client で authorization code + PKCE のログインをし、セッションの cookie を発行する。
- 設定は 2 つの値だけにする: `issuer` と `client_id`。authentik 以外の IdP でも同じ形で動く。
- 退けた方式: ゲートウェイ自身を OAuth の AS にし、ログインだけ IdP に任せる。
  - 退けた理由: トークンの発行・保存・失効を自前で抱えることになる。対象のクライアントは、どれも事前登録の client_id を受ける。
  - ただし、クライアントが OIDC discovery に落ちなければ、この方式が要る。メタデータを代わりに出すだけでは済まない (クライアントは `issuer` と discovery の URL の一致を検査する)。実測で決める。

### 3.3 子サーバーへの資格情報

- 受け取ったトークンを子へ流さない。MCP の仕様は token passthrough を禁止している。
- 子の資格情報は、管理者が env の名前で渡す固定のものだけ。全利用者で共有する (以下 `shared`)。種類:
  - Bearer
  - ヘッダ
  - stdio の env
- `shared` の子は誰の要求でも同じ身元で動く。誰がその子を使えるかは、policy のグループで絞る。
- 資格情報の持ち方を選ぶ設定は、将来の `per_user` を足すときに設定へ加える。

#### 将来: `per_user`

利用者ごとに、ゲートウェイが子の OAuth の client になってトークンを得る。HTTP の子だけで使える。

- 手順: 仕様の URL mode elicitation の節が定める形に従う。
  1. 利用者がまだ接続していない子のツールを呼んだら、「接続」の操作 (6 節) を作る。
  2. ページ (`/i/<id>`) で、ログインのセッションの (`iss`, `sub`) が要求の (`iss`, `sub`) と一致することを確かめる。一致すれば、子の AS へ送る。仕様は、URL を開いた人の確認を求めている。
  3. 戻ってきたトークンを、次のように保存する:
     - (`iss`, `sub`, server id) に結ぶ。
     - 保存のたびに、新しいトークンの id (128 bit の乱数) を振る。
     - 暗号化して保存する。
- 子の AS へのクライアント登録は、次の順で試す。CIMD を使う場合、ゲートウェイは自分のメタデータの文書を公開する。
  1. 事前登録
  2. CIMD
  3. DCR
- 暗号化の鍵は env で渡す。鍵を失ったら、保存したトークンは全部無効になり、利用者は再接続する。
- 子が返すツールの定義は、利用者によって違いうる。鍵は、4.4 節の表の「(将来) `per_user` の子の定義」の行に従う。
- 定義は、利用者が子に接続したときに取る。
- 定義を捨てるとき:
  - 子との接続が切れた。
  - 子のトークンが失効した。
  - 子のトークンが差し替わった (トークンの id が変わる)。
- 定義の古さは、server id ごとの世代番号で表す。
  - 子の `list_changed` を受けたら、その server id の世代番号を 1 つ増やす。
  - 定義は、取ったときの世代番号を持つ。今の世代番号と違えば古い。
  - 古い定義は、`tools/call` の判定にも `.d.ts` (7.2 節) にも使わない。
  - `tools/list` と `tools/call` (`gateway__run_code` を含む) を受けたら、その要求が使う定義のうち古いものを、先に取り直す。
  - 同時に取り直す数には、全利用者を通した上限を置く。上限は固定値で、値は実装で計測して決める。
- 利用者に見せる一覧は、`tools/list` のたびに、その利用者の定義と接続の状態から作る。まだ接続していない利用者の一覧には、`gateway__connect` を載せる。

## 4. 子サーバーの登録と名前

### 4.1 設定ファイル

1 つの宣言的なファイル (YAML) にする。JSON Schema で検証し、変えたら再起動で反映する。

```yaml
auth:
  issuer: https://auth.example.com/application/o/mcp-sluice/
  client_id: mcp-sluice
default: ask                        # どの規則にも当たらないとき
servers:
  github:
    transport: { type: http, url: https://api.githubcopilot.com/mcp/ }
    auth: { bearer_env: GITHUB_TOKEN }   # 秘密は env の名前で参照する
    groups: [dev]                   # この子を使える人 (5.1 節)
    rules:                          # 評価の順は 5.1 節
      - { tools: "delete_*", groups: [admins], decision: ask }
      - { tools: "delete_*", groups: ["*"], decision: deny }
      - { tools: ["get_*", "list_*", "search_*"], groups: ["*"], decision: allow }
  fs:
    transport: { type: stdio, command: /usr/local/bin/fs-mcp, args: [--root, /data] }
    env: { }                        # 子へ渡す env は明示したものだけ
    groups: [dev]
    rules:
      - { tools: "write_*", groups: ["*"], decision: ask }
      - { tools: "*", groups: ["*"], decision: allow }
gateway:                            # ゲートウェイ自身のツールにも同じ規則を掛ける
  rules:
    - { tools: "*", groups: ["*"], decision: allow }
```

- 起動時の設定の検査で、次のどれかに当たれば起動を失敗させる:
  - どこかの階層に、JSON Schema に無いキーがある (`additionalProperties: false`)。綴りを誤ったキーが、黙って無視されないため。
  - 空の配列がある (`minItems: 1`)。対象:
    - server の `groups`
    - rule の `groups`
    - rule の `tools`
  - server か rule に `groups` が無い。全員に当てるなら、`groups` に `"*"` を書く (5.1 節)。
  - server id が 4.2 節の形に外れる。
  - rule の `tools` の文字列が 5.1 節の形に外れる。
  - rule の `tools` の文字列が、その server の公開名の接頭辞 `<server id>__` で始まる。照合は子の名前で行うので、公開名で書いた記述はどのツールにも当たらない (5.1 節)。
  - `auth.issuer` が `https:` でない。平文でホストの外へ出さないため (0 節)。
  - HTTP の子の `url` が `https:` でない。例外として、loopback (`127.0.0.1`・`[::1]`・`localhost`) の `http:` だけは許す。平文でホストの外へ出さないため (0 節)。
  - `bearer_env` が指す環境変数が無い。
- stdio の `env` を省略したときは、子の環境を空にする。

### 4.2 名前

- 公開する名前は `<server>__<tool>`。
  - 区切りは `__` にする。Messages API のツール名は `^[a-zA-Z0-9_-]{1,128}$` で、`.` を含められない (`platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools`、2026-10-26)。
- server id は `^(?=.{1,16}$)[a-z][a-z0-9]*(?:_[a-z0-9]+)*$`。
  - 公開名の区切りは最初の `__` に決まる。
  - JS の識別子として使える。
  - `gateway` は予約する。
- 合成した名前が `^[A-Za-z0-9_-]{1,64}$` に収まらないツールは公開しない。そのときは警告を log に出す。
  - 64 の根拠: OpenAI の function 名の上限。
  - Claude Code (v2.1.292 以降) は名前の前に `mcp__<登録名>__` を足し、128 文字を超えたツールを落とす (`code.claude.com/docs/en/mcp` の「tools with names longer than 128 characters」)。
- Code Mode からは `tools.<server>.<tool>(args)` で呼ぶ。名前に `-` や `.` があれば `tools.github["create-issue"]` の形にする。

### 4.3 子の管理

- 起動時に接続する。切れたら、指数バックオフで再接続する (SDK v2 の client が再接続を持てば、それを使う)。
- ツールの一覧は、子への接続の中に持つ:
  - 接続したら取る。子から `list_changed` が来たら取り直し、クライアントへも `list_changed` を出す。
  - 接続が切れたら、接続と一緒に捨てる。再接続するまで、その子のツールは公開しない。
- stdio の子は全利用者で共有する 1 プロセスにする。利用者ごとに分けるのは範囲外。

### 4.4 同一性の表

| 対象 | 鍵 | 等しいとみなす条件 | 寿命 |
| --- | --- | --- | --- |
| 利用者 | (`iss`, `sub`) | 両方が一致 | — |
| 子への接続 | server id | 設定の項目が同じ | プロセス |
| 公開名 | (server id, tool 名) | 最初の `__` で分けた結果が一致 | 子への接続と同じ |
| `shared` の子のツールの一覧 | server id | 子が返した定義 | 子への接続と同じ (4.3) |
| 中断した要求 | 要求 id (128 bit の乱数) | 6.2 節の確かめを全部通る。承認の根拠 (公開名・引数・クライアント) は記録のものに固定する。policy の判定は記録に固定せず、再開の直前にやり直す (6.3 節) | 完了・期限切れ・取り消しまで |
| 利用者の操作 (承認) | 操作 id (128 bit の乱数) | id が一致し、ページのログインの利用者が要求の利用者と一致 | 中断した要求と同じ |
| 実行中の承認 | (run id, 公開名) | 「この実行の間は許可」を選んだ run で、2 つが一致 | その run の間 |
| ブラウザのセッション | cookie の値 | 署名が正しく、期限内 | 8 時間 |
| (将来) 利用者ごとの子のトークン | (`iss`, `sub`, server id) | 3 つが一致 | 失効か、利用者が切るまで (SQLite) |
| (将来) `per_user` の子の定義 | (`iss`, `sub`, server id, 子のトークンの id) | 4 つが一致し、取ったときの世代番号が今の世代番号と同じ (3.3 節) | 取る・捨てる・取り直すときは 3.3 節 |

## 5. Policy (allow / ask / deny)

### 5.1 判定

1. 利用者が server の `groups` のどれにも入っていなければ、その server のツールは全部 deny。`groups` は必須 (4.1 節の起動時の検査)。
2. server の `rules` を上から見て、次の 2 つを両方満たす最初の規則の `decision` を採る:
   - `tools` (下の形の文字列か、その配列。配列なら、どれか 1 つが当たれば当たる) が当たる。
   - `groups` に利用者が入っている (`"*"` を含む)。`groups` は必須 (4.1 節の起動時の検査)。
3. 当たる規則が無ければ、全体の `default` (既定は ask) を採る。

- `groups` の `"*"` は全員に当たる。
- rule の `tools` の文字列:
  - 形は `^[A-Za-z0-9_*-]+$`。形に外れる記述は、起動時に拒否する (4.1 節)。
  - `*` だけを任意の文字の並び (0 文字を含む) として扱い、他の文字はそのまま比べる。
  - 照合は子の名前 (子が報告した名前。例: `create_issue`) で行う。公開名 (例: `github__create_issue`) では当たらない。公開名の接頭辞で始まる記述は、起動時に拒否する (4.1 節)。
- 上から順に評価する理由: 「admins だけ ask、他は deny」のような例外を、否定を使わずに書ける。
- 判定は `groups` と `rules` だけで行う。仕様は tool annotations (`readOnlyHint` など) を信頼しない入力として扱うよう求めている。annotations はそのままクライアントへ渡す。

### 5.2 効果

| 判定 | `tools/list` | 直接の呼び出し | Code Mode の中 |
| --- | --- | --- | --- |
| allow | 載せる | 子へ中継する | 子へ中継する |
| ask | 載せる | 承認されたら中継する。拒否・期限切れなら `isError` で理由を返す | 承認されたら中継する。拒否・期限切れなら例外 |
| deny | 載せない | 「ツールが無い」と同じエラーにする | 型定義に載せない。呼べば例外にする |

判定は、一覧を作るときと、呼び出しのたびの両方で行う。

## 6. 利用者の操作

### 6.1 操作の種類

| 種類 | 起きるとき | 利用者が見るもの |
| --- | --- | --- |
| 承認 | ask のツールが呼ばれた | server、tool、引数、呼んだクライアント。Code Mode なら run id と深さ、スクリプトの全文 |
| (将来) 接続 | `per_user` の子に、利用者のトークンが無い | 子の名前と、送られる先の AS のドメイン |

承認の選択肢:

- 今回だけ許可
- この実行の間は許可 (Code Mode のときだけ出す。範囲は承認した run だけ。4.4 節)
- 拒否

form で聞くときの既定の選択は「拒否」。

### 6.2 届け方

クライアントの能力ごとに、上の行から使えるものを選ぶ。

| クライアントの能力 | 承認 | (将来) 接続 |
| --- | --- | --- |
| elicitation の form と url | form で聞く | url で `/i/<id>` を開かせる |
| elicitation の form だけ | form で聞く | 結果に URL を返す (下) |
| elicitation の url だけ | 結果に URL を返す (下) | url で `/i/<id>` を開かせる |
| form も url も持たない | 結果に URL を返す (下) | 結果に URL を返す (下) |

- elicitation で聞く場合:
  - 2025 系: その場で送って待つ。
  - 2026 系:
    1. `input_required` を返す。
    2. `requestState` には、要求 id と、その署名だけを入れる。仕様は `requestState` の改ざん防止を求めている。
    3. 再送を受けたら、`requestState` の要求 id で、中断した要求の記録 (6.3 節) を引く。
    4. 次を全部確かめる。どれかが外れれば、`isError: true` と理由 `unknown` を返す。
       - 要求 id の記録がある。
       - 再送の利用者が、記録の利用者と一致する。
       - 再送の `name`・`arguments` が、記録のものと JSON として等しい。
    5. 6.3 節の「再開の直前の判定」を通してから、記録の要求を実行する (Code Mode なら、中断した worker を再開する)。
- 結果に URL を返す場合:
  - 要求を中断し、ツールの結果として次を返す:
    - 何が必要か (承認か接続か)
    - `/i/<操作 id>` の URL
    - 再開に使う `request_id` (要求 id。URL の操作 id とは別の値)
    - 再開の仕方
  - モデルがチャットで URL を示し、利用者はブラウザで authentik にログインして操作する。
  - そのあと、モデルが `gateway__resume({ request_id })` を呼ぶと、中断した要求の続きを返す。承認が済んでいれば、6.3 節の「再開の直前の判定」を通してから、記録の要求を実行する。`gateway__resume` の結果:

    | 状態 | 結果 |
    | --- | --- |
    | 操作が済み、要求が終わった | 元の要求の結果 |
    | まだ操作が済んでいない | `isError: false` で、`status: "pending"` と、最初と同じ案内 (URL と再開の仕方) を返す。元の要求は未完了として示す |
    | 拒否された (再開の直前の判定で deny になったものを含む)・取り消された | `isError: true` と理由 (`denied`・`cancelled`) |
    | id が無い (期限切れで消えたものを含む)、または別の利用者のもの | `isError: true` と理由 `unknown` |
  - 安全性:
    - ページは、ログインした利用者が要求の利用者と一致するときだけ操作を受ける。
    - 送信には CSRF の対策をする。
    - URL を持つだけでは何もできない。
    - モデルが URL を伝えなければ何も起きない (閉じる側に倒れる)。
- 対象のクライアント (0 節) のうち、claude.ai (Claude Desktop を含む) と ChatGPT は、「form も url も持たない」の行に当たると見込む (2026-10-27 の時点。claude.ai は anthropics/claude-ai-mcp#153 で対応が要望されている。確かめ方は 11 節の実測 3)。対応したら、上の表で form の行が自動で選ばれる。

### 6.3 中断の扱い

- 中断した要求は、メモリに記録として持つ。記録が持つもの:
  - 利用者・期限・操作 id・クライアント
  - 元の `tools/call` の `name`・`arguments`。中継する server と tool は、`name` を 4.2 節の最初の `__` で分けて得る。
  - Code Mode の実行なら、Promise を待ったまま止めた worker
- 再開の直前の判定: 中断した要求を実行する直前に、5.1 節の判定をやり直す。
  - 経路 (2026 系の再送・`gateway__resume`) によらず同じに扱う。
  - 判定する対象は、承認を待つツール呼び出し。直接の呼び出しなら記録の `name` で、Code Mode なら worker の中で承認を待つ呼び出し。
  - 判定に使うのは、再開を求めた要求 (再送か、`gateway__resume` の呼び出し) のトークンの `groups`。中断の後に利用者が groups から外れれば、その変化が判定に効く。
  - 結果ごとの扱い:
    - deny: 実行しない (Code Mode なら worker を止める)。`isError: true` と理由 `denied` を返し、記録を消す。
    - ask・allow: 記録した承認で実行する。
- 期限は 15 分の固定値。過ぎたら、止めて記録ごと消す。消えた id は、`gateway__resume` で `unknown` になる (6.2 節)。
- 承認を待つ間は、Code Mode の CPU の時間に数えない。
- Code Mode の中で ask が同時に起きたら、1 つの操作にまとめる。
  - elicitation の場合: 1 つの `inputRequests` に入れる。
  - URL の場合: 1 つのページに並べる。

### 6.4 ゲートウェイ自身のツール

| ツール | 役割 |
| --- | --- |
| `gateway__run_code` | Code Mode (7 節) |
| `gateway__resume` | 引数 `request_id` で、中断した要求を再開する (6.2 節) |
| (将来) `gateway__connect` | `per_user` の子に接続する。まだ接続していない子があるときだけ出す |

## 7. Code Mode

### 7.1 `gateway__run_code`

- 入力: `{ code: string }`。上限は 64 KiB。
  - async 関数の本体として書き、`return` した値が結果になる。
- 使えるもの:
  - `tools.<server>.<tool>(args): Promise<結果>`
    - 引数はそのツールの `inputSchema` に従う。
    - 戻り値は `outputSchema` があれば `structuredContent`、無ければ `{ content }`。
    - 子が `isError` を返したら、例外 (`ToolError`) にする。
  - `console.log` など: 出力を集めて、結果に入れる。
  - 言語の組み込み。例:
    - `JSON`
    - `Math`
    - `Date`
    - `Promise`
- 使えないもの:
  - ネットワーク
  - ファイル
  - env
  - 子プロセス
  - タイマー
  - `import`
  - 実行をまたいで残る記憶域
- ゲートウェイは、スクリプトを保存する機能を持たない。スクリプトを残せるのは、保存のできる子ツールを使ったときだけ。
- 結果: `structuredContent` に `{ result, logs, calls }` を入れる。
  - `calls` には、呼んだツールと、それぞれが成功・失敗・拒否のどれだったかを入れる。
  - 失敗したときも `calls` を返す。どの副作用が起きたかを、モデルが知るため。
- description には、呼び方の規則だけを書く。個々のツールの schema は `tools/list` で読ませる。

### 7.2 実行の流れ

1. 静的な検査: typescript 6.x の API を、プロセスの中で仮想のファイルシステムを使って呼ぶ。
   - `import`・`export`・`require` があれば拒否する。
   - 利用者から見えるツール (deny を除く) の `.d.ts` を、JSON Schema から生成して型検査する。型エラーがあれば実行せずに返す (副作用の前に、引数の誤りを直させる)。
     - `.d.ts` は、各実行のためだけに、その時点の一覧と policy (利用者の groups と設定) から作る。一覧 (`list_changed`) と利用者の groups は実行の間に変わりうるので、前の実行の `.d.ts` は、その時点の一覧と policy に合う保証が無い。
     - 生成と型検査にかかる時間は未測定。11 節の spike で測る。
   - typescript は 6.x に固定する。7.0.2 (2026-10 の npm の latest) の API は `transpileModule` を持たない。外せる条件: 7.x の API が、仮想のファイルシステムでの型検査と JS への変換を提供したとき。
2. TS を JS に変換する (同じ compiler で)。
3. 実行: QuickJS-WASM (quickjs-emscripten) で、実行ごとに新しい context を作り、worker thread で回す。
   - 実行の基盤の比較。物差し:
     - 何もしないときに IO を持つか
     - 閉じるのに要る手当て
     - 依存の状態

     | 候補 | 何もしないときの IO | 閉じるのに要る手当て | 依存の状態 | 採否 |
     | --- | --- | --- | --- | --- |
     | QuickJS-WASM (quickjs-emscripten) | 無い (下の実測)。README は「By default, no host functionality is exposed to code running inside QuickJS」と書く | 無し。渡すのは `tools` と `console` だけ | 版は 1.0 未満。README は「has not been audited」と書く | 採る。IO が無く、手当ても要らない。依存の状態には難がある |
     | Deno の子プロセス (許可フラグ無し) | 有る (下の実測の 3 つ) | `--no-remote`・`--no-npm`・実行ごとの `DENO_DIR`・スクリプトを文字列で評価すること | Deno は実行時 (1 節) で、足す依存は無い | 採らない。IO が有り、閉じるのに手当てが要る。依存の状態に難は無い |
     | Deno の Worker (`deno.permissions: "none"`) | 有る (下の実測の 2 つ目と 3 つ目) | 上と同じ | `deno.permissions` は unstable の API で、`--unstable-worker-options` が要る | 採らない。IO が有り、閉じるのに手当てが要る。依存は unstable の API |
     | isolated-vm | 無い | 別のプロセスに置くこと。README は、V8 は普通の JS で落とされうるので、重要な基盤とは別の node のプロセスに置くよう勧める | README は maintenance mode と書く | 採らない。IO は無いが、別のプロセスが要る。依存の状態には難がある |
     | Cloudflare の Dynamic Worker (`@cloudflare/codemode` が使う形) | `globalOutbound: null` で外へ出ない | Workers の `worker_loaders` の binding が要る | `@cloudflare/codemode` の README は Experimental と書く | 採らない。外へは出ないが、手当てに Workers の基盤が要り、自前のホストで動かす前提に合わない。依存は Experimental |

     - 依存の状態は、QuickJS (1.0 未満・未監査) と isolated-vm (maintenance mode) の両方に難がある。IO と手当てで QuickJS を採る。
     - 依存の状態から残るリスクは、実行の基盤を 1 つの interface の裏に置くことで受ける。基盤を差し替えるときに、その裏だけを替えれば済む。

     実測 (deno 2.9.8、Linux。手順と結果は canon):
     - Deno の子プロセス (許可フラグ無し) に、次の IO がある (canon: facts/deno/io-without-permission-flags):
       - `localStorage` が実行をまたいで残る。
       - 文字列リテラルの `import("file:///…")` が、読み取りの許可なしに通る。
       - `npm:` のモジュールが、ネットワークの許可なしに取れる。
     - `deno.permissions: "none"` の Worker では、2 つ目と 3 つ目が同じく通り、`localStorage` は定義されない (同じ canon)。
     - QuickJS-WASM (quickjs-emscripten 0.32.0) で、新しい context に同じ試験を回すと、どれも通らない (canon: facts/quickjs-emscripten/no-host-io-by-default):
       - 文字列リテラルの `import("file:///…")` と `import("npm:…")` は、モジュールを読めずに失敗する。
       - 次は定義されない:
         - `localStorage` などの記憶域
         - fs の API (`Deno`・`require` など)
         - `fetch`
       - 前の context の `globalThis` への書き込みは、新しい context に残らない。

     出典 (2026-10-28 に確認):
     - QuickJS-WASM: https://github.com/justjake/quickjs-emscripten の README
     - Deno の Worker:
       - `deno.permissions`: https://github.com/denoland/deno/blob/main/cli/tsc/dts/lib.deno.unstable.d.ts の `WorkerOptions`
       - `--unstable-worker-options`: https://github.com/denoland/deno/blob/main/runtime/features/data.rs の `worker-options`
     - isolated-vm: https://github.com/laverdet/isolated-vm の README
     - Dynamic Worker: https://github.com/cloudflare/agents/tree/main/packages/codemode の README
   - 非同期の橋渡しは、`newPromise` と `executePendingJobs` で行う (`Promise.all` で並行に呼べる)。
   - 上限は固定値で、値は実装で計測して決める:
     - メモリ
     - スタック
     - CPU の時間
     - ツール呼び出しの数と同時数
     - log と結果の大きさ
4. ツール呼び出しの橋渡し: サンドボックスから来たものは、全部信頼しない入力として扱う。
   1. 引数を JSON として検証する。
   2. policy を判定する。
   3. ask なら、承認を待つ。
   4. 子へ中継する。
   5. 結果を JSON で戻す。

### 7.3 自分自身の呼び出し

- `tools.gateway.run_code({ code })` で、入れ子の実行を作る。
  - 入れ子の実行は新しい context で動く。型検査も policy も観測も、同じ経路を通る。
  - 期限と呼び出しの予算は、根の実行と共有する。
  - 深さの上限は 3 の固定値。
  - 入れ子の run の ask は、その run のスクリプトの全文を付けて、新しく承認を求める。
- 使い道: 保存のできる子ツールから読んだスクリプトを、実行する。

### 7.4 進捗

クライアントが `progressToken` を付けていれば、ツール呼び出しが終わるたびに `notifications/progress` を出す。Claude Code の docs (4.2 節に挙げたもの) は、progress の通知が idle timeout を延ばすと書く (実測していない)。

## 8. 観測

### 8.1 送るもの

- trace:
  - span 名と属性は、OpenTelemetry の MCP の semantic conventions (`open-telemetry/semantic-conventions-genai` の `docs/gen-ai/mcp.md`、Development) に従う。
    - span 名: `{mcp.method.name} {gen_ai.tool.name}`
    - 必須の属性: `mcp.method.name`
    - 条件つきの属性:
      - `gen_ai.tool.name`
      - `error.type` (`isError` のときは `tool_error`)
      - `jsonrpc.request.id`
    - 推奨: `mcp.protocol.version`、`gen_ai.operation.name` (`execute_tool`)
  - 規約に無いものは `sluice.*` の属性で足す:
    - `sluice.policy.decision`
    - `sluice.interaction.kind`
    - `sluice.interaction.channel`。値:
      - `form`
      - `url`
      - 結果の URL
    - `sluice.run.id`・`sluice.run.depth`・`sluice.code.sha256`・`sluice.code.bytes`
    - `user.id` (= `sub`)・`sluice.client_id`
  - span の入れ子:
    - `mcp.request`
      - 直接の呼び出し:
        - `policy.decide`
        - `interaction.wait`
        - 子への `tools/call` (CLIENT)
      - Code Mode:
        - `codemode.run`
          - `policy.decide`
          - `interaction.wait`
          - 子への `tools/call` (CLIENT)
          - 入れ子の実行 (7.3 節) の `codemode.run`
- 伝播:
  - 受け取る (次のどちらか):
    - `_meta` の `traceparent`・`tracestate`・`baggage` (SEP-414、2026-07-28 で予約)
    - HTTP ヘッダ
  - 子へ渡す: 両方に入れる。
- metrics:
  - 規約のもの: `mcp.server.operation.duration`・`mcp.client.operation.duration`
  - 足すもの:
    - 判定ごとの呼び出しの数
    - 操作の待ち時間
    - Code Mode の実行時間と、1 回あたりのツール呼び出しの数
    - 子の接続状態
- log (構造化):
  - 監査: 呼び出しごとに 1 件出す。中身:
    - 利用者
    - クライアント
    - tool
    - 判定
    - 操作の結果
    - 成否
    - 時間
    - 引数の hash と大きさ
  - Code Mode のソース: 実行ごとに全文を 1 件出し、`trace_id`・`span_id` で trace とつなぐ。
    - span の属性に入れない理由: Tempo は 2048 バイトを超える属性を既定で切り詰め (`max_attribute_bytes`)、上限を上げると querier が out-of-memory になりうると docs が警告している (grafana/tempo の `docs/sources/tempo/configuration/_index.md`、2026-10-27)。
    - Loki の 1 行の上限が 64 KiB の入力を受けられるかは、未確認 (実装の前に確かめる)。
  - 引数と結果の本文は、既定では記録しない。

### 8.2 基盤と UI

compose に、Grafana・Tempo・Loki・Prometheus を同梱する。

比べる物差し:

- 可動部品の数: 次の機能をそろえるのに要るコンテナの数。
  - trace
  - log
  - metrics
  - UI のログイン
- 依存する契約の安定性: ゲートウェイが送る OTLP の受け口と、UI のログインについて、一次情報が書く状態。

| 候補 | コンテナの数 | 依存する契約の安定性 | 扱い |
| --- | --- | --- | --- |
| **Grafana + Tempo + Loki + Prometheus** | 4 | Tempo の README は OpenTelemetry 互換と書く。Loki の docs は `/otlp` で OpenTelemetry の log を native に受けると書く。Prometheus は通常のフラグ `--web.enable-otlp-receiver` で受ける。UI のログインは、Grafana の generic OAuth の docs が書く | 選ぶ。確かめた事実は表の下 |
| grafana/otel-lgtm | 1 | README が、開発・デモ・テスト用と書く | 退ける。コンテナの数では 4 対 1 で負けるが、README が書く用途 (開発・デモ・テスト) が運用に合わないので採らない |
| Jaeger v2 | trace だけなら 1 (README の all-in-one。保存はメモリ)。log と metrics の送り先を足すと 3 (log と metrics を見る UI は含まない) | OTLP (gRPC と HTTP) を受ける。README は trace の基盤と書く。UI の認証の有無は未確認 | 退ける。log と metrics の送り先に加えて、それを見る UI も別に要り、数で Grafana の案に勝たない |
| OpenObserve | 1 (README は single binary と書く) | README は native OTLP と書く。OIDC を含む SSO は Enterprise の機能 | 退ける。Enterprise でないと authentik でログインできない |
| SigNoz | 未確認 (コンテナの数と community 版の SSO) | 未確認 | 保留 (一次情報で確かめてから判断する) |
| Langfuse | 6 (compose の service) | OTLP の受け口は traces と metrics で、metrics の handler は中身が空。logs の受け口は無い | 退ける。metrics と log を受けない |

Grafana + Tempo + Loki + Prometheus で確かめた事実:

- Tempo の span から Loki の log へ飛べる (trace to logs)。
- Grafana の generic OAuth で authentik にログインでき、authentik に Grafana の連携文書がある。
- Loki は単体の形 (`-target=all`) とローカルのファイルシステムで動く。
- Tempo はローカルのディスクに書ける。単体の形で動くかは未確認。

送り方と運用:

- ゲートウェイは、信号ごとの OTLP のエンドポイントへ直接送る。Collector は置かない。送り先が 3 つに決まっていて、振り分けの役が要らないため。
  - trace → Tempo
  - log → Loki の `/otlp`
  - metrics → Prometheus の `--web.enable-otlp-receiver`
  - 設定は標準の `OTEL_EXPORTER_OTLP_*_ENDPOINT` で行う。
- Grafana:
  - ログインは authentik に任せる。
  - 見られるのは、管理者のグループだけ。generic OAuth の `role_attribute_path` と `allowed_groups` で絞る。`allowed_groups` には `groups_attribute_path` の設定も要る (表の出典の generic OAuth)。
  - trace・ソース・監査の log には、利用者の操作が全部載る。
- リポに入れるもの:
  - Grafana のデータソースとダッシュボードの provisioning。ダッシュボードは 3 枚:
    - 全体
    - 利用者ごとの監査
    - Code Mode の実行 (ソースと trace)
  - Tempo・Loki・Prometheus の最小の設定。
- 自前の基盤を持つ運用者は、OTLP の送り先を変えるだけで使える。同梱の 4 つは compose の profile で分ける。
- ライセンス: 次は AGPL-3.0 (2026-10-28 に確認)。同梱は compose から image を参照するだけで、mcp-sluice のコードには入らない。
  - Grafana: https://github.com/grafana/grafana/blob/main/LICENSE
  - Tempo: README
  - Loki: README

表の出典 (2026-10-28 に確認):

- Grafana:
  - generic OAuth: https://github.com/grafana/grafana/blob/main/docs/sources/setup-grafana/configure-access/configure-authentication/generic-oauth/index.md
  - trace to logs: https://github.com/grafana/grafana/blob/main/docs/sources/datasources/tempo/configure-tempo-data-source/configure-trace-to-logs.md
- authentik の Grafana の連携文書 (「Integrate with Grafana」): https://github.com/goauthentik/authentik/blob/main/website/integrations/monitoring/grafana/index.mdx
- Loki:
  - 単体の形: https://github.com/grafana/loki/blob/main/docs/sources/get-started/deployment-modes.md
  - ファイルシステム: https://github.com/grafana/loki/blob/main/docs/sources/configure/storage.md
  - `/otlp`: https://github.com/grafana/loki/blob/main/docs/sources/shared/otel.md
- Tempo: https://github.com/grafana/tempo の README
- Prometheus の `--web.enable-otlp-receiver`: https://github.com/prometheus/prometheus/blob/main/docs/command-line/prometheus.md
- grafana/otel-lgtm: https://github.com/grafana/docker-otel-lgtm の README
- Jaeger: https://github.com/jaegertracing/jaeger の README
- OpenObserve: https://github.com/openobserve/openobserve の README
- Langfuse:
  - service の数: https://github.com/langfuse/langfuse/blob/main/docker-compose.yml
  - OTLP の受け口: https://github.com/langfuse/langfuse/tree/main/web/src/pages/api/public/otel/v1

## 9. 配備

- 前段の reverse proxy で TLS を終端する。
- claude.ai から使う場合:
  - ゲートウェイと authentik の両方が、インターネットから届く必要がある。
  - claude.ai の docs (`claude.com/docs/connectors/building/authentication`、2026-10-26) は、AS が `160.79.104.0/21` から届くことを求めている。
- stdio の子は、ゲートウェイのコンテナの中で子プロセスとして動く。子は信頼する前提なので、子の IO は制限しない。
- 秘密は env で渡す。設定ファイルには env の名前だけを書く。秘密は次の 2 つ (将来の `per_user` で、トークンの暗号化の鍵が加わる):
  - 子の資格情報
  - cookie と `requestState` の署名の鍵

## 10. 利用者向けの文書

README に、セキュリティモデルとして次の節の要約を書く:

- 0 節
- 3.3 節
- 6.2 節
- 7 節

そのほか、英語で次を書く:

- authentik の設定手順。対象:
  - provider
  - redirect URI
  - Grafana の連携
- クライアントごとの登録手順 (0 節の対象のクライアント)
- 設定ファイルの reference

## 11. 作る順番

1. 実測 (spike):
   1. authentik と各クライアントの OAuth。3.2 節の方式で足りるかが、ここで決まる。確かめること:
      - OIDC discovery に落ちるか
      - redirect の regex
      - `aud`
   2. QuickJS-WASM を Deno の worker で動かす。確かめること:
      - 非同期の橋渡し
      - interrupt
      - メモリの上限
   3. elicitation:
      - Claude Code で 2025 系と 2026 系。
      - claude.ai で、結果に URL を返す経路。
      - Claude Desktop と ChatGPT が、elicitation の form と url に対応するか (6.2 節の表のどの行に当たるか)。
   4. Code Mode の静的な検査 (7.2 節) で、`.d.ts` の生成と型検査にかかる時間。
2. 中継と allow/deny と認証 (MVP)
3. 利用者の操作。対象:
   - 承認の届け方: elicitation・URL・`gateway__resume`
   - 試験:
     - 2026 系の再送の引数だけを変えた入力で、承認が使われない (6.2 節)。
     - 中断の後に利用者を groups から外した入力で、承認が使われず実行されない (6.3 節)。
4. Code Mode。対象:
   - 型検査
   - QuickJS
   - 入れ子
5. 観測。対象:
   - OpenTelemetry
   - compose の観測の基盤
   - ダッシュボード

最初の公開の後に、`per_user` の子 (接続、暗号化した保存) を足す。

## 12. 既存のもの

近い既存の実装と、mcp-sluice との違い:

| 名前 | 近い点 | 使わない理由 |
| --- | --- | --- |
| agentgateway | CEL の policy による RBAC と、OpenTelemetry の metrics・log・trace | README に、承認 (ask) と Code Mode の記載が無い |
| IBM mcp-context-forge | 複数の MCP サーバーを束ねる。JWT などの認証と、OpenTelemetry | README に、承認と Code Mode の記載が無い |
| Docker MCP Gateway (Go) | 複数のサーバーを束ね、profile ごとにツールを `<server>.<tool>` で指して有効・無効にする | README の OAuth は子への接続のためで、クライアントの利用者の認証の記載が無い。承認と OpenTelemetry の記載も無い |
| Cloudflare の `@cloudflare/codemode` | Code Mode の参照実装。Dynamic Worker (`WorkerLoader`) で動き、`globalOutbound: null` で外へ出さない | Workers の `worker_loaders` の binding が要る。自前のホストで動かす前提に合わない。README は Experimental と書く |

出典 (2026-10-28 に確認。いずれも README):

- agentgateway: https://github.com/agentgateway/agentgateway
- IBM mcp-context-forge: https://github.com/IBM/mcp-context-forge
- Docker MCP Gateway: https://github.com/docker/mcp-gateway
- `@cloudflare/codemode`: https://github.com/cloudflare/agents/tree/main/packages/codemode
