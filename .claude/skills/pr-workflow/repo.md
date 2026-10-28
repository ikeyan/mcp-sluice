# PR / ブランチ運用: このリポの値

[SKILL.md](SKILL.md) が読む、このリポ固有の値。SKILL.md と手段のファイルは agent-sync で ikeyan/agent-files からそのまま写すので、リポごとに違うものはこのファイルだけに書く。

## 値

- push 先: `origin`
- 寄稿規約 (このリポで通っているもの。文書にはしていない):
  - 既定ブランチは `main`。
  - コミットメッセージと PR の本文は英語で書く (公開リポなので、外の読者が読める言語にする)。コミットメッセージの 1 行目は「対象: 何をしたか」の形 (例: `verify: check JSON syntax`) にし、本文で理由を述べる。
- CI: `verify` (`.github/workflows/verify.yml`)

## 手段の実測

なし

## 方針の差分

- **PR コメントの watch**: PR を作った・push したら常に回す。cc-web では `subscribe_pr_activity`、それ以外は手段ファイルの「PR の watch」を使う。
