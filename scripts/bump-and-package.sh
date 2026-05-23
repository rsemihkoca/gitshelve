#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LATEST_VSIX=$(ls -t gitshelve-*.vsix 2>/dev/null | head -1 || true)
if [ -n "$LATEST_VSIX" ]; then
  CHANGED=$(find src package.json -type f -newer "$LATEST_VSIX" 2>/dev/null | head -1 || true)
  if [ -z "$CHANGED" ]; then
    exit 0
  fi
fi

npm run compile >/dev/null 2>&1 || { echo "[gitshelve] compile failed" >&2; exit 1; }

npm version patch --no-git-tag-version --silent >/dev/null
VERSION=$(node -p "require('./package.json').version")

npx --silent @vscode/vsce package >/dev/null 2>&1 || { echo "[gitshelve] package failed" >&2; exit 1; }

find . -maxdepth 1 -name 'gitshelve-*.vsix' ! -name "gitshelve-${VERSION}.vsix" -delete 2>/dev/null || true

echo "[gitshelve] v${VERSION} -> gitshelve-${VERSION}.vsix"
