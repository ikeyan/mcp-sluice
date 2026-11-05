# 振り返り: クライアントの実測 (Claude Code と Codex) (2026-11-05)

対象はブランチ `claude/nifty-allen-aqn0ll` の PR。読者は、このリポで次に実装を進めるセッション。

## 状況

- [docs/design.md](../docs/design.md) の 11 節の実測 1 と 3 のうち、実物のクライアントが要る部分を、この container で動くクライアントで測った:
  - Claude Code 2.1.318 (この session の認証で動いた)。
  - Codex CLI 0.166.0 (OpenAI の認証が無いので、モデルを通さず app-server でツールを直接呼んだ)。
- 相手は、authentik 2026.8.5 と同じ形の偽の AS と、MCP TS SDK 2.4.0 の偽の RS。
- 利用者の Mac のフォルダは、cloud の session に出されていなかった (`not_available`) ので、claude.ai と ChatGPT は測れていない。
- 事実は canon (ikeyan/canon の同名ブランチ) に書いた:
  - `facts/claude-code/mcp-oauth-client-behavior`
  - `facts/claude-code/mcp-elicitation-behavior`
  - `facts/codex/mcp-oauth-and-elicitation`

## 良かったこと

- 3.2 節の方式 (事前登録した公開クライアント 1 つ) が、Claude Code と Codex で通ることを確かめられた。どちらも OIDC の path append に届き、事前登録の client_id を受け、`profile` を要求し、secret 無しで token endpoint に来た。
- scope の出どころを、`WWW-Authenticate` と `scopes_supported` に違う値を置いて測ったので、クライアントごとの違い (Claude Code は `scopes_supported` だけ、Codex は header を優先) が分かった。
- 利用者の設定 (`~/.claude`・`~/.codex`) を変えずに、`CLAUDE_CONFIG_DIR`・`CODEX_HOME` で使い捨ての置き場に向けて測れた。

## 直したこと

- `6e2464f`: 3.2 節・6.2 節・11 節を実測に合わせた。
  - scope の出どころをクライアントごとに書き、両方に同じ値を置く理由にした。
  - Codex の redirect URI の regex を、末尾の 12 文字の id つきの形に決めた。
  - protected resource metadata を、根と path を挿んだ形の両方で出す。
  - 非対話の実行 (`claude -p`・`codex exec`) では、elicitation が即座に `cancel` になることを書いた。
  - 2025 系で期限の後に届いた答えを捨てる。
- `eb97a56`: レビューの指摘 3 件を直した。実測と書いた記述のうち、測った範囲より強いもの (Codex の elicitation、authentik が `authorization_response_iss_parameter_supported` を出さないこと、Claude Code の scope の「だけ」) を、測った範囲に限った。

## 残っていること

- claude.ai と ChatGPT の実測 (メタデータの URL、`profile`、redirect URI、ChatGPT が事前登録の client_id を受けるか、secret 無しの token 要求)。
- claude.ai で、結果に URL を返す経路 (実測 3)。
- Codex をモデル経由で動かしたときの elicitation (TUI のダイアログ、`codex exec` の cancel はソースでだけ確かめた)。
- refresh token での更新と、url mode の elicitation は試していない。
