#!/usr/bin/env bash
# squash merge 済みのローカルの作業ブランチを消す。usage: cleanup-branch.sh <branch> <expected-head-sha>
# - <expected-head-sha> は PR の head (40 桁の 16 進数のみ。短縮形・ref 名は断る)。呼び出し側が GitHub (gh / MCP) から PR が merged であることと head を確かめて渡す。このスクリプトはネットワークを使わず、リモートのブランチも消さない。
# - ブランチの先端が <expected-head-sha> と違えば PR に入っていない commit があるので、何も変えずに断る。squash merge では先端が既定ブランチの祖先にならず `git branch -d` が使えないので、先端の一致の確認が -D の代わりの安全装置になる。
# - git は worktree で checkout 中のブランチを -D でも消せない。そのブランチを checkout している worktree (main・linked とも) は `git switch --detach` で HEAD を外し (作業ツリーは同じ commit のまま)、その後 `git branch -D` する。
# - ディレクトリが消えた linked worktree の登録 (prunable) も -D を断るので、先に `git worktree prune` で外す。locked な登録は prune されず、ディレクトリが無ければ detach で落ちる (`git worktree unlock` が要る)。
# 入力・環境: cwd の git リポジトリで動く。GIT_DIR などは呼び出し元から継承し、git の規則どおりに効く。git 以外は使わない。git help worktree (list --porcelain -z は 2.36 以降・prune)、git help switch (--detach)、git help branch (-D)。
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: cleanup-branch.sh <branch> <expected-head-sha>" >&2
  exit 2
fi
branch=$1
expected=$2

if [[ ! $expected =~ ^[0-9a-f]{40}$ ]]; then
  echo "cleanup-branch: expected-head-sha が 40 桁の 16 進数でない: $expected" >&2
  exit 2
fi
tip=$(git rev-parse --verify --quiet "refs/heads/$branch^{commit}") || {
  echo "cleanup-branch: refs/heads/$branch が無い" >&2
  exit 1
}
if [ "$tip" != "$expected" ]; then
  echo "cleanup-branch: $branch の先端 $tip が PR の head $expected と違う (PR に入っていない commit がある)。消さない" >&2
  exit 1
fi

git worktree prune

path=
while IFS= read -r -d '' field; do
  case $field in
    'worktree '*) path=${field#worktree } ;;
    "branch refs/heads/$branch") git -C "$path" switch --detach ;;
  esac
done < <(git worktree list --porcelain -z)

git branch -D "$branch"
