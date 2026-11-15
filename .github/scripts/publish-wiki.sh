#!/usr/bin/env bash
# publish-wiki.sh SRC_DIR WIKI_CHECKOUT BLOB_BASE
# Copies docs/wiki/*.md into a checkout of the GitHub Wiki, rewriting links for the wiki:
#   ](Page.md#x)     -> ](Page#x)                 (wiki pages have no .md)
#   ](../../path)    -> ](BLOB_BASE/path)         (repo files, from docs/wiki)
#   ](../path)       -> ](BLOB_BASE/docs/path)
# Pages deleted from SRC_DIR are deleted from the wiki. Prints what changed.
set -euo pipefail
src=$1 wiki=$2 base=$3

find "$wiki" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
for f in "$src"/*.md; do
  sed -E \
    -e "s#\]\(\.\./\.\./#](${base}/#g" \
    -e "s#\]\(\.\./#](${base}/docs/#g" \
    -e 's|\]\(([A-Za-z0-9_-]+)\.md(#[^)]*)?\)|](\1\2)|g' \
    "$f" > "$wiki/$(basename "$f")"
done
git -C "$wiki" add -A
git -C "$wiki" status --short
