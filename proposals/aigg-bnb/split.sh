#!/usr/bin/env bash
# Turn this staging directory into the standalone aigg-bnb repository.
#   ./split.sh /path/to/aigg-bnb [aigg-porw git url] [aigg-porw commit]
# Result: a fresh git repo with this directory's content at its root, aigg-porw as a pinned submodule under
# contracts/lib/aigg-porw, forge-std as a submodule under contracts/lib/forge-std, remappings rewritten. Then:
#   cd /path/to/aigg-bnb && git remote add origin git@github.com:jianmliu/aigg-bnb.git && git push -u origin main
set -euo pipefail
DEST="${1:?destination directory}"; SRC_URL="${2:-https://github.com/jianmliu/aigg-porw.git}"; HERE="$(cd "$(dirname "$0")" && pwd)"
PARENT="$(cd "$HERE/../.." && pwd)"; PIN="${3:-$(git -C "$PARENT" rev-parse HEAD)}"
mkdir -p "$DEST"; (cd "$HERE" && tar --exclude=./contracts/out --exclude=./contracts/cache --exclude=./contracts/broadcast --exclude=node_modules -cf - .) | (cd "$DEST" && tar -xf -)
cd "$DEST"; git init -q -b main
git submodule add -q "$SRC_URL" contracts/lib/aigg-porw; git -C contracts/lib/aigg-porw checkout -q "$PIN"
git submodule add -q https://github.com/foundry-rs/forge-std contracts/lib/forge-std
FS_PIN="$(git -C "$PARENT/contracts/evm/lib/forge-std" rev-parse HEAD 2>/dev/null || true)"; [ -n "$FS_PIN" ] && git -C contracts/lib/forge-std checkout -q "$FS_PIN" || true
sed -i '/^allow_paths = /d; s|"forge-std/=../../../contracts/evm/lib/forge-std/src/"|"forge-std/=lib/forge-std/src/"|; s|"aigg-porw/=../../../contracts/evm/src/"|"aigg-porw/=lib/aigg-porw/contracts/evm/src/"|' contracts/foundry.toml
sed -i 's|"../../../web/porw-browser/|"../contracts/lib/aigg-porw/web/porw-browser/|g' js/greenfield.js js/test_greenfield.mjs
sed -i 's|(staging layout, inside aigg-porw)|(standalone layout)|; s|remappings point at ../../../contracts/evm (the neutral contracts)|remappings point at contracts/lib/aigg-porw (pinned submodule)|' README.md
rm -f split.sh
git add -A; git -c user.name="${GIT_AUTHOR_NAME:-aigg}" -c user.email="${GIT_AUTHOR_EMAIL:-aigg@localhost}" commit -q -m "aigg-bnb: BNB Chain deployment of the PoRW fly-brain mesh (split from aigg-porw @ ${PIN:0:12})"
echo "created $DEST (aigg-porw pinned at $PIN). Next: git remote add origin <url> && git push -u origin main"
