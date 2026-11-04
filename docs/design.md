# mcp-sluice 設計

mcp-sluice は、複数の子 MCP サーバーを 1 つのエンドポイントに束ねる MCP サーバー。authentik (OIDC) で利用者を認証し、利用者のグループとツールごとに allow/ask/deny を掛け、TypeScript の Code Mode を提供し、OpenTelemetry で観測できるようにする。

この文書の読者は、mcp-sluice を実装・変更する人。この文書が仕様の正本になる。

外部依存の事実は、2026-10-26〜28 に一次情報 (仕様の repo・ソース・公式 docs) で確かめたものを根拠に書く。確かめられなかったものは「未確認」と書く。

## 0. 前提

- 公開リポ (OSS) として作る。
  - 認証は OIDC の一般の仕組みで書く。設定例と手順は authentik で示す。
- 利用者は複数人。
  - authentik の application の policy を通った人が、利用者になれる。
  - 利用者ごとの権限は、トークンの `groups` で分ける。
- 対象のクライアント:
  - Claude Code
  - claude.ai (Claude Desktop と mobile を含む。どれも同じ callback の URL で接続する。`claude.com/docs/connectors/building/authentication` の Callback URLs、2026-10-28)
  - Codex
  - ChatGPT
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
  - 公式 TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0) を使う。README は、Node.js・Bun・Deno で動くと書く (https://github.com/modelcontextprotocol/typescript-sdk の README、2026-10-28)。
- 持つ状態:
  - メモリだけに持つ: 中断した要求 (承認待ちの Code Mode の実行など)。
  - メモリの状態があるので、レプリカは 1 つにする。
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
- SDK v2 は 1 つの handler で両世代を受けられる (https://github.com/modelcontextprotocol/typescript-sdk の `docs/protocol-versions.md` と `examples/dual-era/README.md`、2026-10-28)。
- 2025-11-25 の経路を外せる条件: 対象のクライアント (0 節) が、どれも 2026-07-28 で接続するようになったとき。
- 子へは、SDK v2 の client を `versionNegotiation: { mode: 'auto' }` で使う。
- `tools/list` の結果:
  - 利用者ごとに絞るので、`cacheScope: "private"` を付ける (2026-07-28 の caching)。
  - `ttlMs` は短めにし、`list_changed` を併用する。
    - 仕様は、クライアントが結果を受けてから `ttlMs` の間、結果を新しいとみなすよう勧める。0 なら、すぐに古いとみなす (https://github.com/modelcontextprotocol/modelcontextprotocol の `schema/2026-07-28/schema.ts` の `CacheableResult`、2026-10-28)。

## 3. 認証

### 3.1 authentik でできること・できないこと

authentik 2026.8.5 と main のソースで確認した (https://github.com/goauthentik/authentik の `authentik/providers/oauth2/` と `blueprints/system/providers-oauth2.yaml`、2026-10-28)。

| 機能 | 状態 | 影響 |
| --- | --- | --- |
| Dynamic Client Registration (DCR) | 有り。ただし `goauthentik.io/oidc/dcr` scope を持つ Bearer が要る | 匿名で登録しにくる MCP クライアントは 401 で失敗する |
| Client ID Metadata Documents (CIMD) | 無し | 使えない |
| RFC 8707 `resource` | 読まない | `aud` をゲートウェイに向けられない |
| `aud` | provider の client_id | client_id で検証する |
| RFC 8414 のメタデータ | 有り。`/.well-known/oauth-authorization-server/application/o/<slug>/` (`urls_root.py`) が、OIDC discovery (`/application/o/<slug>/.well-known/openid-configuration`) と同じ view で返す | クライアントが作る RFC 8414 の URL が末尾の `/` まで一致して届くか、届かなければ OIDC discovery に落ちるかは未確認 (11 節の実測 1) |
| redirect URI | strict か regex (`fullmatch`) | loopback の任意のポートを regex で通せる |
| `groups` | 既定の `profile` の scope mapping に入る。access token にも入る (`include_claims_in_id_token` の既定は true) | policy にそのまま使える |
| `sub` | 既定は `hashed_user_id` (authentik の設置ごとに違う) | 利用者の鍵は (`iss`, `sub`) にする |
| refresh token | `offline_access` のときだけ出る。既定で rotation する | claude.ai の要件 (公開クライアントの rotation) を満たす |
| 署名 | 署名鍵を設定すれば非対称で、JWKS を公開する | 非対称の署名鍵を必ず設定する |

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
    | ChatGPT | 未確認。事前登録の client_id を受けるかも含め、実測で決める |
    | mcp-sluice 自身 (ブラウザのページ) | `<public_url の origin>/auth/callback` (loopback で `http:` の `public_url` なら `http:`) |

  - scope: `openid profile email offline_access`
  - 誰が使えるかは、application に結ぶ policy で決める。
- ゲートウェイの役割 (resource server):
  - `/.well-known/oauth-protected-resource` (RFC 9728) を出す。
    - `resource` = 設定の `public_url` (MCP の endpoint の完全な URL。利用者がクライアントに入れる URL)
    - `authorization_servers` = [issuer]
    - `scopes_supported` = 上の scope
  - 未認証には 401 と `WWW-Authenticate: Bearer resource_metadata="…", scope="openid profile email offline_access"` を返す。`groups` は `profile` の scope で access token に入る (3.1 節) ので、クライアントに `profile` を求めさせる。claude.ai は `WWW-Authenticate` の `scope` を、無ければ `scopes_supported` を要求する (`claude.com/docs/connectors/building/authentication` の PKCE and requested scopes。2026-11-04)。claude.ai は 401 でしか認証を始めない (`claude.com/docs/connectors/building/authentication` の Serve discovery metadata。200 に付けた `WWW-Authenticate` は無視されると書いてある。2026-10-28)。
  - JWT は次を検証する (署名と期限の検証は JOSE のライブラリに任せる):
    - JWKS での署名
    - `iss`
    - `exp`・`nbf`
    - `aud` == 設定の client_id
    - `sub` が空でない文字列で、`groups` が文字列の配列 (claim が無ければ空の配列) であること。外れれば 401。利用者の同一性 (4.4 節) は (`iss`, `sub`) なので、`sub` の無いトークンを通すと別の利用者が同じ利用者になる。
  - authentik は `resource` を読まないので、`aud` は client_id になる。
- ブラウザのページ (`/i/<id>`):
  - 同じ client で authorization code + PKCE のログインをし、セッションの cookie を発行する。
- 設定は 3 つの値だけにする: `issuer`・`client_id`・`public_url`。
  - `public_url` が要るのは、TLS を前段の reverse proxy が終端する (9 節) ので、要求の Host と scheme から公開の URL を決められないため。claude.ai は `resource` が利用者の入れた URL とパスまで一致することを求める (同じ docs の Serve discovery metadata)。
  - `resource_metadata` の URL と、ブラウザのページの redirect URI (`/auth/callback`) は、`public_url` の origin から作る。
- authentik 以外の IdP でも同じ形で動くと見込む。未確認。その IdP で次を確かめる (authentik で確かめた内容は 3.1 節の表):
  - クライアントがメタデータ (RFC 8414 か OIDC discovery) に届く。
  - access token が JWT で、JWKS で署名を検証できる。
  - access token の `aud` が client_id になる。
  - loopback の任意のポートの redirect URI を登録できる。
  - access token に `groups` の claim が入る。
- 退けた方式: ゲートウェイ自身を OAuth の AS にし、ログインだけ IdP に任せる。
  - 退けた理由: トークンの発行・保存・失効を自前で抱えることになる。対象のクライアントのうち、claude.ai・Claude Code・Codex は事前登録の client_id を受ける。
  - ただし、次のどちらかなら、この方式が要る。実測 1 (11 節) で決める:
    - ChatGPT が事前登録の client_id を受けない (3.2 節の表で未確認)。
    - クライアントが authentik のメタデータ (RFC 8414 か OIDC discovery。3.1 節) に届かない。メタデータを代わりに出すだけでは済まない (クライアントは `issuer` と discovery の URL の一致を検査する)。

### 3.3 子サーバーへの資格情報

- 受け取ったトークンを子へ流さない。MCP の仕様は token passthrough を禁止している。
- 子の資格情報は、管理者が env の名前で渡す固定のもの (Bearer・ヘッダ・stdio の env) だけ。全利用者で共有する (以下 `shared`)。
- `shared` の子は誰の要求でも同じ身元で動く。誰がその子を使えるかは、policy のグループで絞る。

## 4. 子サーバーの登録と名前

### 4.1 設定ファイル

1 つの宣言的なファイル (YAML) にする。JSON Schema で検証し、変えたら再起動で反映する。

```yaml
auth:
  issuer: https://auth.example.com/application/o/mcp-sluice/
  client_id: mcp-sluice
  public_url: https://mcp.example.com/mcp
default: ask                        # どの規則にも当たらないとき
servers:
  github:
    transport: { type: http, url: https://api.githubcopilot.com/mcp/ }
    auth: { bearer_env: GITHUB_TOKEN }   # 秘密は env の名前で参照する
    groups: [dev]                   # この子を使える人。無ければ全員
    rules:                          # 上から順に評価し、最初に当たったものを採る
      - { tools: "delete_*", groups: [admins], decision: ask }
      - { tools: "delete_*", decision: deny }
      - { tools: ["get_*", "list_*", "search_*"], decision: allow }
  fs:
    transport: { type: stdio, command: /usr/local/bin/fs-mcp, args: [--root, /data] }
    env: { API_KEY: FS_API_KEY }    # 子での名前: ゲートウェイの環境変数の名前 (下)
    rules:
      - { tools: "write_*", decision: ask }
      - { tools: "*", decision: allow }
gateway:                            # ゲートウェイ自身のツールにも同じ規則を掛ける
  rules:
    - { tools: "*", decision: allow }
```

- 起動時の検査で、次のどれかに当たれば起動を失敗させる:
  - どの階層でも、JSON Schema に無いキーがある (`additionalProperties: false`)。rule の `groups` を綴り誤ると (例: `group`)、`groups` が無い規則として全員に効くため。
  - `auth.issuer`・`auth.public_url`・HTTP の子の `url` のどれかが `https:` でない。ただし、loopback の `http:` は許す。
    - 理由: 平文でホストの外へ出さない (0 節)。HTTP の子へは資格情報 (Bearer・ヘッダ) を載せて送り、issuer からは JWKS を取る。`public_url` へはクライアントが Bearer を、ブラウザが authorization code (`/auth/callback`) を送る。
    - loopback の判定: URL を parse した `hostname` が、`127.0.0.1`・`[::1]`・`localhost` のどれかと等しい。
  - 署名の鍵の環境変数 `MCP_SLUICE_SIGNING_KEY` (9 節) が、無いか、9 節の値の形に外れる。
- 子への資格情報は、どれも値でなくゲートウェイの環境変数の名前で書く (9 節):
  - HTTP の子の `auth`: `bearer_env` (Bearer にする環境変数の名前) か、`headers_env` (ヘッダの名前から環境変数の名前への対応)。
  - stdio の子の `env`: 子での名前から、ゲートウェイの環境変数の名前への対応。
- stdio の子の環境は、SDK の既定の変数 (`HOME`・`LOGNAME`・`PATH`・`SHELL`・`TERM`・`USER`。Windows では別の 18 個) に、`env` で渡すものを重ねたものになる。同じ名前なら `env` で渡す値を使う。SDK の stdio transport は、渡した `env` を既定の変数に重ね、既定の変数を外す形を持たない (canon: facts/mcp-typescript-sdk/stdio-default-env)。既定の変数は、0 節で信頼するホストの環境の値。

### 4.2 名前

- 公開する名前は `<server>__<tool>`。
  - 区切りは `__` にする。Messages API のツール名は `^[a-zA-Z0-9_-]{1,128}$` で、`.` を含められない (`platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools`、2026-10-26)。
- server id は `^(?=.{1,16}$)[a-z][a-z0-9]*(?:_[a-z0-9]+)*$`。
  - `__` を含まず、`_` で終わらない。そのため、公開名は最初の `__` で (server id, tool 名) に 1 通りに分かれる。`__` を含む server id を許すと、`a__b__c` が server `a__b` の tool `c` とも server `a` の tool `b__c` とも読め、別の子へ送りうる。
  - JS の識別子として使える。
  - `gateway` は予約する。
- 合成した名前が `^[A-Za-z0-9_-]{1,64}$` に収まらないツールは公開しない。そのときは警告を log に出す。
  - 64 の根拠: OpenAI の function 名の上限。OpenAI の API の OpenAPI 定義は、Chat Completions の `FunctionObject` の `name` を「a maximum length of 64」と書く (https://github.com/openai/openai-openapi の `openapi.yaml`、2026-10-28)。Responses の `FunctionTool` の `name` には上限の記載が無い。
  - Claude Code (v2.1.292 以降) は名前の前に `mcp__<登録名>__` を足し、128 文字を超えたツールを落とす (`code.claude.com/docs/en/mcp` の「Tools with names longer than 128 characters」と、https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md の 2.1.292。2026-10-28)。v2.1.292 より前は要求ごと失敗した。
- Code Mode からは `tools.<server>.<tool>(args)` で呼ぶ。名前に `-` や `.` があれば `tools.github["create-issue"]` の形にする。

### 4.3 子の管理

- 起動時に接続する。切れたら、指数バックオフで再接続する。
  - SDK v2 の client (2.4.0) の型定義で再接続に当たるのは、Streamable HTTP の SSE の流れの `reconnectionOptions` (既定で 2 回まで) だけ。閉じた接続は、ゲートウェイが transport を作り直して接続し直す (npm の `@modelcontextprotocol/client` 2.4.0 の tarball の `dist/*.d.mts`、2026-10-28)。
- ツールの一覧は、子への接続の中に持つ:
  - 接続したら取る。子から `list_changed` が来たら取り直す。
  - 接続が切れたら、接続と一緒に捨てる。再接続するまで、その子のツールは公開しない。
  - クライアントに見える一覧が変わったら (取り直し・切断・再接続)、クライアントへ `list_changed` を出す。
  - `list_changed` を出さない子の一覧を取り直すかは、実装で決める。
- stdio の子は全利用者で共有する 1 プロセスにする。利用者ごとに分けるのは範囲外。

### 4.4 同一性の表

| 対象 | 鍵 | 等しいとみなす条件 | 寿命 |
| --- | --- | --- | --- |
| 利用者 | (`iss`, `sub`) | 両方が一致 | — |
| 子への接続 | server id | 設定の項目が同じ | プロセス |
| 公開名 | 公開名の文字列 | 文字列が一致。server id と tool 名は、最初の `__` で分けて得る (4.2 節) | 子への接続と同じ |
| ツールの一覧 | server id | 子が返した定義 | 子への接続と同じ (4.3) |
| 中断した要求 | 要求 id (128 bit の乱数) | id と利用者の両方が一致。2026 系の再送では、`name`・`arguments` も記録のものと JSON として等しい (6.2 節) | 再開で結果 (元の要求の結果・`denied`・`cancelled`) を返すか、期限 (15 分) が切れるまで。ページで拒否・取り消しされた要求も、再開でその理由を返すまで持つ |
| 利用者の操作 (承認) | 操作 id (128 bit の乱数) | id が一致し、ページのログインの利用者が要求の利用者と一致 | 中断した要求と同じ |
| 実行中の承認 | (要求 id, server id, tool 名) | 「この実行の間は許可」を選んだもの | その実行の間 |
| ブラウザのセッション | cookie の値 | 署名が正しく、期限内 | 8 時間 |

## 5. Policy (allow / ask / deny)

### 5.1 判定

1. server に `groups` があり、利用者がそのどれにも入っていなければ、その server のツールは全部 deny。`groups` が無ければ、全員がこの段を通る。
2. server の `rules` を上から見て、次の 2 つを両方満たす最初の規則の `decision` を採る:
   - `tools` (`*` だけのグロブか、その配列。配列なら、どれか 1 つが当たれば当たる) が当たる。
   - `groups` が無いか、利用者が入っている。
3. 当たる規則が無ければ、全体の `default` (既定は ask) を採る。

- 上から順に評価する理由: 「admins だけ ask、他は deny」のような例外を、否定を使わずに書ける。
- 判定は `groups` と `rules` だけで行う。仕様は tool annotations (`readOnlyHint` など) を信頼しない入力として扱うよう求めている。annotations はそのままクライアントへ渡す。

### 5.2 効果

| 判定 | `tools/list` | 直接の呼び出し | Code Mode の中 |
| --- | --- | --- | --- |
| allow | 載せる | 子へ中継する | 子へ中継する |
| ask | 載せる | 承認されたら中継する。拒否・取り消しなら `isError` で理由 (6.2 節) を返す | 承認されたら中継する。拒否・取り消しなら例外 |
| deny | 載せない | 「ツールが無い」と同じエラーにする | 型定義に載せない。呼べば例外にする |

判定は、一覧を作るときと、呼び出しのたびの両方で行う。中断した要求を再開するときも、直前にやり直す (6.3 節)。

## 6. 利用者の操作

### 6.1 操作の種類

| 種類 | 起きるとき | 利用者が見るもの |
| --- | --- | --- |
| 承認 | ask のツールが呼ばれた | server、tool、引数、呼んだクライアント。Code Mode なら run id と、スクリプトの全文 |

承認の選択肢:

- 今回だけ許可
- この実行の間は許可 (Code Mode のときだけ出す)
- 拒否

### 6.2 届け方

クライアントの能力ごとに、上の行から使えるものを選ぶ。

| クライアントの能力 | 承認 |
| --- | --- |
| elicitation の form と url | form で聞く |
| elicitation の form だけ | form で聞く |
| elicitation の url だけ | 結果に URL を返す (下) |
| elicitation 無し (claude.ai・ChatGPT と見込む) | 結果に URL を返す (下) |

- elicitation で聞く場合:
  - 2025 系: その場で `elicitation/create` を送って待つ。
    - SDK の server の `elicitInput` で送る。`elicitInput` は `RequestOptions` の `timeout` を受け、渡さなければ 60000 ミリ秒で拒否する。待つ上限は、期限 (6.3 節) 以下の固定値にして `timeout` で渡す。過ぎたら `cancelled` (6.3 節)。
    - `elicitInput` は 2.4.0 の型定義で `@deprecated` で、doc は 2026-07-28 の要求では throw すると書く (npm の `@modelcontextprotocol/server` 2.4.0 の tarball の `dist/*.d.mts`、2026-10-28)。SDK の版を上げるたびに、残っているかを確かめる。
  - 2026 系: `input_required` を返し、`requestState` に要求 id と、その署名だけを入れる。
    - 署名する理由: 仕様は、`requestState` を攻撃者が操る入力として扱い、認可・資源の取得・業務の論理のどれかに効くなら完全性を守って、検証に外れたものを拒否するよう求める。完全性の保護を省いてよいのは、改ざんで起きうる最悪が要求の失敗のときだけ (https://github.com/modelcontextprotocol/modelcontextprotocol の `docs/specification/2026-07-28/basic/patterns/mrtr.mdx` の Server Requirements (Basic Workflow)、2026-10-28)。
    - 利用者・期限・操作 id は、要求 id で中断した要求の記録 (6.3 節) から引く。
    - 再送は、次の両方を満たすときだけ受ける。外れれば `isError: true` と理由 `unknown` を返す:
      - 再送の利用者が、記録の利用者と一致する。
      - 再送の `name`・`arguments` が、記録のものと JSON として等しい。比べないと、引数を差し替えた再送で、承認していない呼び出しが走る。
    - 受けた再送では、記録の呼び出しを実行する。
- 結果に URL を返す場合:
  - 要求を中断し、ツールの結果として次を返す:
    - 承認が要ること
    - `/i/<操作 id>` の URL
    - 再開に使う `request_id` (要求 id。URL の操作 id とは別の値)
    - 再開の仕方
  - モデルがチャットで URL を示し、利用者はブラウザで authentik にログインして操作する。
  - そのあと、モデルが `gateway__resume({ request_id })` を呼ぶと、中断した要求の続きを返す。`gateway__resume` の結果:

    | 状態 | 結果 |
    | --- | --- |
    | 操作が済み、要求が終わった | 元の要求の結果 |
    | まだ操作が済んでいない | `isError` を付けず、`status: "pending"` と同じ案内。元の要求が終わったとは示さない |
    | 拒否された・取り消された (6.3 節) | `isError: true` と理由 (`denied`・`cancelled`) |
    | id が無い (期限で消えたものを含む)・別の利用者のもの | `isError: true` と理由 `unknown` (別の利用者の id があることも明かさない) |
  - 安全性:
    - ページは、ログインした利用者が要求の利用者と一致するときだけ操作を受ける。
    - 送信には CSRF の対策をする。
    - URL を持つだけでは何もできない。
    - モデルが URL を伝えなければ何も起きない (閉じる側に倒れる)。
- claude.ai・ChatGPT は、elicitation 無しの行に当たると見込む (2026-10-27 の時点。claude.ai は anthropics/claude-ai-mcp#153 で対応が要望されている)。対応したら、上の表で form の行が自動で選ばれる。

### 6.3 中断の扱い

- 中断した要求は、メモリに記録として持つ。記録が持つもの:
  - 利用者
  - 元の `tools/call` の `name`・`arguments`。2026 系の再送の確かめ (6.2 節) と、直接の呼び出しの中継に使う。
  - Code Mode の実行なら、Promise を待ったまま止めた worker。
- 期限 (15 分。設定には出さない) を過ぎたら、止めて消す。消えた要求 id は、再開で `unknown` になる (6.2 節)。
  - 再開して実行を始めた要求は、この期限で止めない。止まるのは実行の上限 (7.2 節) でだけ。結果をいつまで持つかは実装で決める。
- 利用者ごとに、同時に持つ Code Mode の実行 (中断したものを含む) と中断した要求の数に上限を置く。上限に達したら、新しい実行は始めずにエラーで、新しい ask は中断せずに拒否として返す。1 人の利用者のエージェントの誤り (0 節) が、止めた worker でゲートウェイのメモリを使い切り、他の利用者の要求を止めないため。値は実装で決める。
- 承認を待つ間は、Code Mode の CPU の時間に数えない。
- Code Mode の中で ask が同時に起きたら、1 つの操作にまとめる。
  - elicitation の場合: 1 つの `inputRequests` に入れる。
  - URL の場合: 1 つのページに並べる。
- 答えの分類:

  | 答え | 分類 |
  | --- | --- |
  | `action: "accept"` で「今回だけ許可」か「この実行の間は許可」。ページの同じ選択肢 | 許可 |
  | `action: "accept"` で「拒否」、`action: "decline"`、ページの「拒否」 | 拒否 (`denied`) |
  | `action: "cancel"` (利用者が選ばずに閉じた) | 取り消し (`cancelled`) |

  `action: "decline"` と `action: "cancel"` は、その elicitation に載せた呼び出しの全部への答えとする。
- 結果を `cancelled` にするもの (これで全部):
  - 取り消しの答え (上の分類)。
  - 2025 系の待ちの上限 (6.2 節)。
  - クライアントによる要求の取り消し。取り消しの形は、仕様が世代と transport ごとに定める:
    - 2025 系: `notifications/cancelled`。Streamable HTTP の切断は、取り消しにしない。
    - 2026 系の Streamable HTTP: 応答の SSE の流れを閉じる。
    - 2026 系の stdio: `notifications/cancelled`。
- 再開の直前の判定: 許可の答えを受けて中断した要求を再開する直前に、5.1 節の判定をやり直す。
  - 判定に使うのは、再開を求めた要求のトークンの `groups`。再開を求めた要求は、2026 系の再送、`gateway__resume` の呼び出し、2025 系のその場の待ちでは元の要求。
  - 判定する対象は、中断した要求の呼び出しの全部 (直接の呼び出しなら記録の `name`、Code Mode なら worker の中で止まっている呼び出し)。
    - どれかが deny: `denied`。
    - deny が無く、承認の無い ask がある: その呼び出しの承認を、6.2 節の手順で求め直す。
    - 他: 実行する。
  - 再開した worker が以後に呼ぶツールの判定も、同じ `groups` を使う。
  - 理由: 中断の前の承認が、グループから外された利用者の呼び出しを通さないため。
  - グループの変化が効くのは、変化の後に発行されたトークンで再開したときからと見込む。変化の前に発行されたトークンは、前の `groups` を持つ。未確認 (11 節の 3 の試験で確かめる)。遅れは access token の寿命で決まる。
  - 退けた案:
    - 記録したときの判定を固定する: グループから外された利用者の承認が通る。
    - 再開ごとに IdP に問い合わせる: 通信が増え、IdP の応答の契約に依存する。
- 出典 (https://github.com/modelcontextprotocol/modelcontextprotocol の `docs/specification/`、2026-10-28):
  - elicitation の 3 つの action: `2025-11-25/client/elicitation.mdx` と `2026-07-28/client/elicitation.mdx` の Response Actions。
  - 2025 系の取り消し: `2025-11-25/basic/utilities/cancellation.mdx`。`2025-11-25/basic/transports.mdx` の Streamable HTTP は、切断を取り消しと解釈すべきでないと書く。
  - 2026 系の取り消し: `2026-07-28/basic/patterns/cancellation.mdx` の Transport-Specific Cancellation。Streamable HTTP の切断を取り消しとして扱うことを求める。

### 6.4 ゲートウェイ自身のツール

| ツール | 役割 |
| --- | --- |
| `gateway__run_code` | Code Mode (7 節) |
| `gateway__resume` | 引数 `request_id` で、中断した要求を再開する (6.2 節) |

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
  - 言語の組み込み (`JSON`・`Math`・`Date`・`Promise` など)
- 使えないもの:
  - ネットワーク
  - ファイル
  - env
  - 子プロセス
  - タイマー
  - `import`
  - 実行をまたいで残る記憶域
- ゲートウェイは、スクリプトを保存する機能を持たない。スクリプトを残せるのは、保存のできる子ツールを使ったときだけ。
- 結果: `structuredContent` に `{ result, logs, calls }` を入れ、`content` には、同じ値を JSON にした text を 1 つ入れる。仕様は、構造化した結果を返すツールに、後方互換のため同じ JSON を TextContent でも返すよう勧める (SHOULD。https://github.com/modelcontextprotocol/modelcontextprotocol の `docs/specification/2025-11-25/server/tools.mdx` と `docs/specification/2026-07-28/server/tools.mdx` の Structured Content、2026-10-28)。
  - `calls` には、呼んだツールと、それぞれが成功・失敗・拒否のどれだったかを入れる。
  - 失敗したときも `calls` を返す。どの副作用が起きたかを、モデルが知るため。
- description には、呼び方の規則だけを書く。個々のツールの schema は `tools/list` で読ませる。

### 7.2 実行の流れ

1. 静的な検査: typescript 6.x の API を、プロセスの中で仮想のファイルシステムを使って呼ぶ。
   - `import`・`export`・`require` があれば拒否する。
   - 利用者から見える子のツール (deny を除く。ゲートウェイ自身のツールは入れない) の `.d.ts` を、JSON Schema から生成して型検査する。型エラーがあれば実行せずに返す (副作用の前に、引数の誤りを直させる)。
     - `.d.ts` は実行ごとに、その時点の一覧と policy (利用者の groups と設定) から作り、保持しない。
   - typescript は 6.x に固定する。7.0.2 (2026-10-28 の npm の dist-tag latest) の package は `transpileModule` を持たない (npm の typescript@7.0.2 の tarball、2026-10-28。canon: facts/typescript/v7-package-lacks-transpile-module)。外せる条件: 7.x の API が、仮想のファイルシステムでの型検査と JS への変換を提供したとき。
2. TS を JS に変換する (同じ compiler で)。
3. 実行: QuickJS-WASM (quickjs-emscripten) で、実行ごとに新しい module・runtime・context を作り、worker thread で回す。
   - 実行の基盤の比較 (物差し: 何もしないときに IO を持つか、閉じるのに要る手当て、依存の状態):

     | 候補 | 何もしないときの IO | 閉じるのに要る手当て | 採否 |
     | --- | --- | --- | --- |
     | QuickJS-WASM (quickjs-emscripten) | 無い。README は「By default, no host functionality is exposed to code running inside QuickJS」と書く。下の実測 | 無し。渡すのは `tools` と `console` だけ | 採る。依存は pre-1.0 で監査されていないので、実行の基盤を 1 つの interface の裏に置く |
     | Deno の子プロセス (許可フラグ無し) | 有る。下の実測 | `--no-remote`・`--no-npm`・実行ごとの `DENO_DIR`・スクリプトを文字列で評価すること | 採らない |
     | Deno の Worker (`deno.permissions: "none"`) | 有る。下の実測 | 上と同じ。加えて `--unstable-worker-options` が要る | 採らない |
     | isolated-vm | 無い | 別のプロセスに置くこと (README が、同じプロセスでは落とされうると書く) | 採らない。README が maintenance mode と書く |
     | Cloudflare の Dynamic Worker | `globalOutbound: null` で外へ出ない | Workers の基盤 | 採らない。自前のホストで動かす前提に合わない |

     実測 (deno 2.9.8、Linux。手順と結果は canon):
     - Deno の子プロセス (許可フラグ無し) に、次の IO がある (canon: facts/deno/io-without-permission-flags):
       - `localStorage` が実行をまたいで残る。
       - 文字列リテラルの `import("file:///…")` が、読み取りの許可なしに通る。
       - `npm:` のモジュールが、ネットワークの許可なしに取れる。
     - `deno.permissions: "none"` の Worker では、2 つ目と 3 つ目が同じく通り、`localStorage` は定義されない (同じ canon)。
     - QuickJS-WASM (quickjs-emscripten 0.32.0) の新しい context では、同じ試験がどれも通らない。`fetch`・fs の API も定義されず、前の context の `globalThis` への書き込みは残らない (canon: facts/quickjs-emscripten/no-host-io-by-default)。
     - worker の中の QuickJS でも、同じ試験と `jsr:`・`https:` の指定子の import がどれも通らない (2026-11-04、同じ canon)。

     出典 (2026-10-28):
     - QuickJS-WASM: https://github.com/justjake/quickjs-emscripten の README
     - Deno の Worker:
       - `deno.permissions`: https://github.com/denoland/deno/blob/main/cli/tsc/dts/lib.deno.unstable.d.ts の `WorkerOptions`
       - `--unstable-worker-options`: https://github.com/denoland/deno/blob/main/runtime/features/data.rs の `worker-options`
     - isolated-vm: https://github.com/laverdet/isolated-vm の README
     - Dynamic Worker: https://github.com/cloudflare/agents/tree/main/packages/codemode の README
   - 非同期の橋渡しは、`newPromise` と `executePendingJobs` で行う (`Promise.all` で並行に呼べる)。
   - 上限 (値は実装で計測して決め、設定には出さない):
     - メモリ: 実行ごとに WASM の module を作り、その `WebAssembly.Memory` に `maximum` を付ける (variant の `wasmMemory`)。`setMemoryLimit` は文字列や TypedArray の合計を止めない (16 MiB の設定で 1〜2 GB まで伸びた)。`maximum` は module 単位なので、module を実行の間で共有しない (canon: facts/quickjs-emscripten/runtime-limits)。
     - スタック: `setMaxStackSize` を必ず置き、ホストの V8 のスタックの閾値より十分小さくする。置かないと、深い再帰がスクリプトの例外でなく、ホストの `RangeError` になる (同じ canon)。
     - CPU の時間: `evalCode` と `executePendingJobs` の中にいた時間だけを足す。壁時計で数えると、ツールの承認待ちや子の応答待ちも数える (同じ canon)。
     - ツール呼び出しの数と同時数
     - log と結果の大きさ
   - 走っているスクリプトを止めるのは、interrupt handler だけ。`Worker.terminate()` は、走っている同期の処理 (QuickJS のループを含む) を止めない (canon: facts/deno/worker-terminate-does-not-stop-sync-code)。そのため、橋渡しのホストの関数は、どれも同期で待たない (待ちは Promise で返す)。
4. ツール呼び出しの橋渡し: サンドボックスから来たものは、全部信頼しない入力として扱う。ゲートウェイ自身のツール (`gateway__run_code` など) の呼び出しは拒否する。入れ子の実行 (新しい worker と新しい上限) を作らせないため。
   1. 引数を JSON として検証する。
   2. policy を判定する。
   3. ask なら、承認を待つ。
   4. 子へ中継する。
   5. 結果を JSON で戻す。

### 7.3 進捗

クライアントが `progressToken` を付けていれば、ツール呼び出しが終わるたびに `notifications/progress` を出す。Claude Code の docs (`code.claude.com/docs/en/mcp`) は、progress の通知が idle timeout を延ばすと書く (実測していない)。

## 8. 観測

### 8.1 送るもの

- trace:
  - span 名と属性は、OpenTelemetry の MCP の semantic conventions (`open-telemetry/semantic-conventions-genai` の `docs/gen-ai/mcp.md`、Development。2026-10-28) に従う。
    - span 名: `{mcp.method.name} {gen_ai.tool.name}`
    - 必須の属性: `mcp.method.name`
    - 条件つき: `gen_ai.tool.name`、`error.type` (`isError` のときは `tool_error`)、`jsonrpc.request.id`
    - 推奨: `mcp.protocol.version`、`gen_ai.operation.name` (`execute_tool`)
  - 規約に無いものは `sluice.*` の属性で足す:
    - `sluice.policy.decision`
    - `sluice.interaction.kind`・`sluice.interaction.channel` (form・url・結果の URL)
    - `sluice.run.id`・`sluice.code.sha256`・`sluice.code.bytes`
    - `user.id` (= `sub`)・`sluice.client_id`
  - 入れ子: `mcp.request` の下に `policy.decide`・`interaction.wait`・子への `tools/call` (CLIENT) を置く。Code Mode では `codemode.run` を挟む。
- 伝播:
  - 受け取る: `_meta` の `traceparent`・`tracestate`・`baggage` (SEP-414、2026-07-28 で予約) か、HTTP ヘッダ。
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

| 候補 | 退けた・選んだ理由 |
| --- | --- |
| **Grafana + Tempo + Loki + Prometheus** (選ぶ) | trace・log・metrics を 1 つの UI で見られ、trace から log へ飛べる。Grafana OSS の generic OAuth で authentik にログインでき、authentik に Grafana の連携文書がある。Loki は単体の形 (`-target=all`) とローカルのファイルシステムで動く。Tempo はローカルのディスクに書ける (単体の形で動くかは未確認)。コンテナは 4 つ |
| grafana/otel-lgtm (1 コンテナ) | README が、開発・デモ・テスト用と明言している |
| Jaeger v2 | README は trace の基盤と書く。log と metrics には、別の送り先とそれを見る UI が要る。UI の認証の有無は未確認 |
| OpenObserve | 1 コンテナだが、OIDC は Enterprise の機能 |
| SigNoz | 保留。コンテナの数と community 版の SSO は未確認で、一次情報で確かめてから判断する |
| Langfuse | コンテナが 6 つ (compose の service)。OTLP の受け口は traces と metrics で、metrics の handler は中身が空。logs の受け口は無い |

表の出典 (2026-10-28):

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

送り方と運用:

- ゲートウェイは、信号ごとの OTLP のエンドポイントへ直接送る。OpenTelemetry Collector は挟まない (コンテナと設定が 1 つずつ増える一方、送り先が 3 つに決まっているので振り分けの役が要らない)。
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
- 自前の基盤を持つ運用者は、OTLP の送り先を変えるだけで使えると見込む。未確認。確かめる項目:
  - 送り先が、trace・log・metrics の OTLP を受ける。
  - 送り先が求める認証を、標準の `OTEL_EXPORTER_OTLP_*_HEADERS` で渡せる。
- 同梱の 4 つは compose の profile で分ける。
- ライセンス: 次は AGPL-3.0 (2026-10-28)。同梱は compose から image を参照するだけで、mcp-sluice のコードには入らない。
  - Grafana: https://github.com/grafana/grafana/blob/main/LICENSE
  - Tempo: README
  - Loki: README

## 9. 配備

- 前段の reverse proxy で TLS を終端する。
- claude.ai から使う場合:
  - ゲートウェイと authentik の両方が、インターネットから届く必要がある。
  - claude.ai の docs (`claude.com/docs/connectors/building/authentication`、2026-10-28) は、AS が `160.79.104.0/21` から届くことを求めている。
- stdio の子は、ゲートウェイのコンテナの中で子プロセスとして動く。子は信頼する前提なので、子の IO は制限しない。
- 秘密は env で渡す。秘密は次の 2 つ:
  - 子の資格情報: 設定ファイルには env の名前だけを書く (4.1 節)。
  - cookie と `requestState` の署名の鍵:
    - 環境変数 `MCP_SLUICE_SIGNING_KEY` で渡す。名前は固定で、設定ファイルには出さない。
    - 既定の鍵は持たず、無ければ起動を失敗させる (4.1 節)。既定の鍵を持つと、渡し忘れた配備が、誰でも知る鍵で署名する。
    - 値は、32 バイト以上の乱数を base64 にしたもの。

## 10. 利用者向けの文書

README にセキュリティモデルを書く (0 節と 3.3 節・6.2 節・7 節の要約)。そのほか、英語で次を書く:
  - authentik の設定手順 (provider・redirect URI・Grafana の連携)
  - クライアントごとの登録手順 (Claude Code・claude.ai・Codex・ChatGPT)
  - 設定ファイルの reference

## 11. 作る順番

1. 実測 (spike):
   1. authentik と各クライアントの OAuth。3.2 節の方式で足りるかが、ここで決まる。確かめること:
      - メタデータの経路 (RFC 8414 の URL に届くか、OIDC discovery に落ちるか。3.1 節)
      - redirect の regex の通り方 (ChatGPT の redirect URI と、事前登録の client_id を受けるかを含む)
      - `aud` の値
      - 各クライアントが `profile` を要求し、access token に `groups` が入ること
   2. QuickJS-WASM を Deno の worker で動かす。済み (2026-11-04、quickjs-emscripten 0.32.0、deno 2.9.8): 結果は 7.2 節 3 と canon (facts/quickjs-emscripten/runtime-limits、facts/deno/worker-terminate-does-not-stop-sync-code)。
   3. elicitation: Claude Code で 2025 系と 2026 系。claude.ai で、結果に URL を返す経路。
2. 中継と allow/deny と認証 (MVP)
3. 利用者の操作 (承認: elicitation・URL・`gateway__resume`)。試験に、グループから外した利用者の、外す前と後に発行されたトークンでの再開 (6.3 節) を含める。
4. Code Mode (型検査、QuickJS)
5. 観測 (OpenTelemetry、compose の観測の基盤、ダッシュボード)

## 12. 既存のもの

近い既存の実装と、mcp-sluice との違い:

| 名前 | 近い点 |
| --- | --- |
| agentgateway (Rust) | CEL によるツールごとの RBAC と、OpenTelemetry。README に、承認と Code Mode の記載が無い |
| IBM mcp-context-forge (Python) | 束ねる、認証、OpenTelemetry |
| Docker MCP Gateway (Go) | `<server>.<tool>` で束ね、ツールを有効・無効にする |
| Cloudflare の `@cloudflare/codemode` | Code Mode の参照実装 (experimental)。Workers の Dynamic Worker と `globalOutbound: null` で動く |

出典 (2026-10-28。いずれも README):

- agentgateway: https://github.com/agentgateway/agentgateway
- IBM mcp-context-forge: https://github.com/IBM/mcp-context-forge
- Docker MCP Gateway: https://github.com/docker/mcp-gateway
- `@cloudflare/codemode`: https://github.com/cloudflare/agents/tree/main/packages/codemode
