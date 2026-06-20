#!/usr/bin/env bash
#
# Regenerate index.html with the Picocrypt-NG WebAssembly crypto engine.
#
# Builds the WASM engine and embeds it -- together with the matching Go
# `wasm_exec.js` shim -- into index.template.html. The template holds the static
# UI/glue; only the two machine-generated parts (wasm_exec.js + the base64 WASM)
# are injected here, so the published page stays a single self-contained
# index.html.
#
# Usage:
#   ./build.sh                 # latest Picocrypt-NG RELEASE (default; reproducible)
#   ./build.sh 2.14            # a specific release tag (reproducible)
#   ./build.sh --local         # DEV preview from sibling ../Picocrypt-NG (NOT reproducible)
#   ./build.sh --local PATH    # DEV preview from a Picocrypt-NG checkout at PATH
#
# Release builds fetch source from a public tag, so anyone can reproduce the
# exact index.html from that tag -- the trust model for a crypto tool. The
# --local mode builds from a working tree for in-browser testing BEFORE a release
# is cut; its output is version-tagged `-dev` and MUST NOT be published.
#
# Requires: go, GNU Awk (gawk), base64 (GNU coreutils); curl + tar for release mode.

set -euo pipefail

REPO="Picocrypt-NG/Picocrypt-NG"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/index.template.html"
OUT="$HERE/index.html"

# gawk is mandatory: the embedded WASM is a single multi-MB base64 line, and
# mawk/busybox awk truncate over-long lines, silently corrupting the binary.
if ! awk --version 2>/dev/null | grep -qi "GNU Awk"; then
  echo "error: GNU Awk (gawk) is required; other awk variants truncate the base64 line" >&2
  exit 1
fi
command -v go >/dev/null || { echo "error: go not found in PATH" >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "error: $TEMPLATE not found" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Resolve the source tree (SRC) and the version string (VERSION).
if [ "${1:-}" = "--local" ]; then
  LOCAL_REPO="${2:-$HERE/../Picocrypt-NG}"
  SRC="$LOCAL_REPO/src"
  [ -d "$SRC/cmd/wasm" ] || { echo "error: $SRC/cmd/wasm not found (bad --local path?)" >&2; exit 1; }
  base_ver="0.0.0"
  [ -f "$LOCAL_REPO/VERSION" ] && base_ver="$(tr -d '[:space:]' < "$LOCAL_REPO/VERSION")"
  VERSION="${base_ver}-dev"
  echo "DEV build from local source: $SRC"
  echo "  version $VERSION -- NOT reproducible, do NOT publish this index.html"
else
  VERSION="${1:-}"
  if [ -z "$VERSION" ]; then
    echo "Resolving latest Picocrypt-NG release..."
    VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | sed -nE 's/.*"tag_name": *"([^"]+)".*/\1/p' | head -n1)"
    [ -n "$VERSION" ] || { echo "error: could not resolve latest release tag" >&2; exit 1; }
  fi
  echo "Building web bundle for Picocrypt-NG release $VERSION"
  echo "Fetching source tarball..."
  curl -fsSL "https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz" | tar -xz -C "$WORK"
  SRC="$WORK/Picocrypt-NG-$VERSION/src"
  [ -d "$SRC/cmd/wasm" ] || { echo "error: $SRC/cmd/wasm missing in $VERSION" >&2; exit 1; }
fi

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

# Fail loud if injection left a placeholder behind or truncated the WASM: a
# silently broken index.html is worse than no build.
for ph in __WASM_EXEC_JS__ __WASM_BASE64__ __PICOCRYPT_VERSION__; do
  if grep -q "$ph" "$OUT"; then
    echo "error: placeholder $ph still present in $OUT (injection failed)" >&2
    exit 1
  fi
done
b64_len="$(wc -c < "$WORK/wasm.b64")"
emb_len="$(awk -F'"' '/const wasmBase64 = "/{ print length($2); exit }' "$OUT")"
if [ -z "$emb_len" ] || [ "$emb_len" -lt "$b64_len" ]; then
  echo "error: embedded base64 (${emb_len:-0}) shorter than source ($b64_len) -- truncated" >&2
  exit 1
fi

echo "Wrote $OUT ($(wc -c < "$OUT") bytes) for Picocrypt-NG $VERSION."
