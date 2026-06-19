#!/usr/bin/env bash
#
# Regenerate index.html from a Picocrypt-NG release.
#
# Builds the WebAssembly crypto engine from upstream source and embeds it --
# together with the matching Go `wasm_exec.js` shim -- into index.template.html.
# The template holds the static UI/glue; only the two machine-generated parts
# (wasm_exec.js + the base64 WASM) are injected here, so the published page
# stays a single self-contained index.html.
#
# Usage:
#   ./build.sh           # latest Picocrypt-NG release (default)
#   ./build.sh 2.14      # a specific release tag
#
# Requires: go, curl, tar, awk, base64 (GNU coreutils).

set -euo pipefail

REPO="Picocrypt-NG/Picocrypt-NG"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/index.template.html"
OUT="$HERE/index.html"

command -v go >/dev/null || { echo "error: go not found in PATH" >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "error: $TEMPLATE not found" >&2; exit 1; }

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Resolving latest Picocrypt-NG release..."
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -nE 's/.*"tag_name": *"([^"]+)".*/\1/p' | head -n1)"
  [ -n "$VERSION" ] || { echo "error: could not resolve latest release tag" >&2; exit 1; }
fi
echo "Building web bundle for Picocrypt-NG $VERSION"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching source tarball..."
curl -fsSL "https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz" | tar -xz -C "$WORK"
SRC="$WORK/Picocrypt-NG-$VERSION/src"
[ -d "$SRC/cmd/wasm" ] || { echo "error: $SRC/cmd/wasm missing in $VERSION" >&2; exit 1; }

echo "Compiling WASM (GOOS=js GOARCH=wasm)..."
( cd "$SRC" && GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o "$WORK/picocrypt.wasm" ./cmd/wasm )

# wasm_exec.js MUST come from the same toolchain that built the WASM: the shim
# and the Go runtime in the binary share an ABI that changes between releases.
WASM_EXEC="$(go env GOROOT)/lib/wasm/wasm_exec.js"
[ -f "$WASM_EXEC" ] || WASM_EXEC="$(go env GOROOT)/misc/wasm/wasm_exec.js"
[ -f "$WASM_EXEC" ] || { echo "error: wasm_exec.js not found under GOROOT" >&2; exit 1; }
echo "Using shim: $WASM_EXEC ($(go env GOVERSION))"

base64 -w0 "$WORK/picocrypt.wasm" > "$WORK/wasm.b64"

echo "Injecting into template..."
awk -v exec_file="$WASM_EXEC" -v b64_file="$WORK/wasm.b64" -v version="$VERSION" '
  /__WASM_EXEC_JS__/ { while ((getline line < exec_file) > 0) print line; close(exec_file); next }
  /__WASM_BASE64__/  { getline b64 < b64_file; close(b64_file); print "\t\t\tconst wasmBase64 = \"" b64 "\";"; next }
  { gsub(/__PICOCRYPT_VERSION__/, version); print }
' "$TEMPLATE" > "$OUT"

echo "Wrote $OUT ($(wc -c < "$OUT") bytes) for Picocrypt-NG $VERSION."
