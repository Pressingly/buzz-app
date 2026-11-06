#!/usr/bin/env bash
# Moves every storage name this app owns out of Block's namespace, so the
# Moneta build never reads, moves or locks a Block Buzz install's data or keys.
# Re-run after each upstream rebase; it is idempotent and fails if any Block
# name survives.
#
# xyz.moneta.buzz.foundation, xyz.moneta.buzz.app and the legacy-desktop
# keychain services never shipped: they stand in for Block's earlier releases
# so upstream's migration and import code finds nothing to move or read.
#
# Shared on purpose: ~/.buzz-foundation/credential-providers (the bundled
# block/buzz CLI discovers desktops there; each file is named by app id) and
# the credential-store locks (hashed by service and account).
set -euo pipefail
cd "$(dirname "$0")/.."
command -v cargo >/dev/null || { echo "cargo is required (for cargo fmt)" >&2; exit 1; }
# Biome formats the rewritten JS/TS; set BIOME to a biome binary to override.
read -r -a biome <<<"${BIOME:-pnpm exec biome}"

readonly BLOCK_NAMES='xyz\\?\.block\\?\.buzz\\?\.(desktop|app)|dev\\?\.local\\?\.buzz\\?\.(foundation|agent-ownership)|buzz-foundation-credential-locks|"buzz-desktop(-dev)?(:\{\})?"|join\("\.buzz-foundation"\)\.join\(name\)|\.buzz-foundation/agent-connections'

block_named_files() {
  # gifs.ts: "buzz-desktop" there is a GIF API customer id, not a storage name.
  git grep -lzIE "$BLOCK_NAMES" -- . ':!scripts/moneta-namespace.sh' ':!*.lock' ':!src/features/relay/gifs.ts' || true
}

block_named_files | xargs -0 -r perl -pi -e '
  s/xyz(\\?)\.block(\\?)\.buzz(\\?)\.(desktop|app)/xyz$1.moneta$2.buzz$3.$4/g;
  s/dev(\\?)\.local(\\?)\.buzz(\\?)\.(foundation|agent-ownership)/xyz$1.moneta$2.buzz$3.$4/g;
  s/buzz-foundation-credential-locks/moneta-buzz-credential-locks/g;
  s/"buzz-desktop(-dev)?(:\{\})?"/"xyz.moneta.buzz.legacy-desktop$1$2"/g;
  s/join\("\.buzz-foundation"\)\.join\(name\)/join(".moneta-buzz").join(name)/g;
  s/\.buzz-foundation\/agent-connections/.moneta-buzz\/agent-connections/g;
'
cargo fmt --all
git diff -z --name-only -- '*.ts' '*.tsx' '*.mjs' '*.js' | xargs -0 -r "${biome[@]}" format --write

if git grep -nIE "$BLOCK_NAMES" -- . ':!scripts/moneta-namespace.sh' ':!*.lock' ':!src/features/relay/gifs.ts'; then
  echo "Block names remain (above); extend this script" >&2
  exit 1
fi

# Review any other ~/.buzz-foundation use upstream adds: unless it is one of the
# deliberately shared folders above, it couples this app to Block's again.
git grep -nIE '\.buzz-foundation' -- . ':!scripts/moneta-namespace.sh' ':!*.lock' |
  grep -vE 'credential-providers|credential-locks|nsec-backups|dev-archive' |
  sed 's/^/review: /' >&2 || true
