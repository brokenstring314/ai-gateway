#!/usr/bin/env bash
# Build standalone `ai-gateway` binaries with `bun build --compile` and package
# each with LICENSE, NOTICE, README.md and config.example.yaml.
# Usage: scripts/build-binaries.sh <version> [target ...]
#   targets default to every release target; output goes to dist/.
set -euo pipefail

VERSION="${1:?usage: $0 <version> [target ...]}"
shift
TARGETS=("$@")
if [ "${#TARGETS[@]}" -eq 0 ]; then
  TARGETS=(bun-linux-x64 bun-linux-arm64 bun-darwin-x64 bun-darwin-arm64 bun-windows-x64)
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
mkdir -p "$DIST"

for target in "${TARGETS[@]}"; do
  platform="${target#bun-}"            # linux-x64, darwin-arm64, windows-x64, ...
  name="ai-gateway-$VERSION-$platform"
  stage="$DIST/$name"
  exe="ai-gateway"
  [[ "$platform" == windows-* ]] && exe="ai-gateway.exe"
  rm -rf "$stage" && mkdir -p "$stage"
  echo "==> $target"
  bun build "$ROOT/src/index.ts" --compile --minify --sourcemap \
    --target="$target" --outfile "$stage/$exe"
  rm -f "$stage"/*.map
  cp "$ROOT/LICENSE" "$ROOT/NOTICE" "$ROOT/README.md" "$ROOT/config.example.yaml" "$stage/"
  if [[ "$platform" == windows-* ]]; then
    (cd "$DIST" && rm -f "$name.zip" && zip -qr "$name.zip" "$name")
  else
    tar -C "$DIST" -czf "$DIST/$name.tar.gz" "$name"
  fi
done

shopt -s nullglob
(cd "$DIST" && files=(ai-gateway-"$VERSION"-*.tar.gz ai-gateway-"$VERSION"-*.zip) && sha256sum "${files[@]}" >SHA256SUMS)
cat "$DIST/SHA256SUMS"
