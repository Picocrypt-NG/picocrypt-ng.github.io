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
#   ./build.sh                 # latest release; requires a supported 3.x core
#   ./build.sh 3.0             # a specific published 3.x release tag
#   ./build.sh --local         # DEV preview from sibling ../Picocrypt-NG (NOT reproducible)
#   ./build.sh --local PATH    # DEV preview from a Picocrypt-NG checkout at PATH
#
# Release builds fetch source from a public tag, so anyone can reproduce the
# exact index.html from that tag -- the trust model for a crypto tool. The
# --local mode builds from a working tree for in-browser testing BEFORE a release
# is cut; its output is version-tagged `-dev` and MUST NOT be published.
#
# Add --output PATH to write a preview without replacing the published bundle.
# Requires: go, GNU Awk (gawk), base64/sha256sum (GNU coreutils); curl + tar for release mode.

set -euo pipefail

REPO="Picocrypt-NG/Picocrypt-NG"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/index.template.html"
OUT="$HERE/index.html"
LOCAL_REPO=""
VERSION=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --local)
      LOCAL_REPO="$HERE/../Picocrypt-NG"
      shift
      if [ "$#" -gt 0 ] && [[ "$1" != --* ]]; then LOCAL_REPO="$1"; shift; fi
      ;;
    --output)
      [ "$#" -ge 2 ] || { echo "error: --output needs a path" >&2; exit 1; }
      OUT="$2"
      shift 2
      ;;
    --*) echo "error: unknown option $1" >&2; exit 1 ;;
    *)
      [ -z "$VERSION" ] || { echo "error: only one release tag is allowed" >&2; exit 1; }
      VERSION="$1"
      shift
      ;;
  esac
done
[ -z "$LOCAL_REPO" ] || [ -z "$VERSION" ] || { echo "error: --local cannot select a release tag" >&2; exit 1; }

# gawk is mandatory: the embedded WASM is a single multi-MB base64 line, and
# mawk/busybox awk truncate over-long lines, silently corrupting the binary.
if ! awk --version 2>/dev/null | grep -qi "GNU Awk"; then
  echo "error: GNU Awk (gawk) is required; other awk variants truncate the base64 line" >&2
  exit 1
fi
command -v go >/dev/null || { echo "error: go not found in PATH" >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "error: $TEMPLATE not found" >&2; exit 1; }

WORK="$(mktemp -d)"
TEMP_OUT=""
trap 'rm -rf "$WORK"; [ -z "$TEMP_OUT" ] || rm -f "$TEMP_OUT"' EXIT
OUT_DIR="$(cd "$(dirname "$OUT")" && pwd)"
OUT="$OUT_DIR/$(basename "$OUT")"
TEMP_OUT="$(mktemp "$OUT_DIR/.picocrypt-build.XXXXXX")"
SOURCE="release"
REVISION="unknown"
DIRTY="false"
SOURCE_HASH="none"

# Resolve the source tree (SRC) and the version string (VERSION).
if [ -n "$LOCAL_REPO" ]; then
  SRC="$LOCAL_REPO/src"
  [ -d "$SRC/cmd/wasm" ] || { echo "error: $SRC/cmd/wasm not found (bad --local path?)" >&2; exit 1; }
  base_ver="0.0.0"
  [ -f "$LOCAL_REPO/VERSION" ] && base_ver="$(tr -d '[:space:]' < "$LOCAL_REPO/VERSION")"
  VERSION="${base_ver}-dev"
  SOURCE="local"
  REVISION="$(git -C "$LOCAL_REPO" rev-parse HEAD 2>/dev/null || printf unknown)"
  [ -z "$(git -C "$LOCAL_REPO" status --porcelain 2>/dev/null)" ] || DIRTY="true"
  echo "DEV build from local source: $SRC"
  echo "  version $VERSION -- NOT reproducible, do NOT publish this index.html"
else
  if [ -z "$VERSION" ]; then
    echo "Resolving latest Picocrypt-NG release..."
    VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | sed -nE 's/.*"tag_name": *"([^"]+)".*/\1/p' | head -n1)"
    [ -n "$VERSION" ] || { echo "error: could not resolve latest release tag" >&2; exit 1; }
  fi
  [[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]] || { echo "error: invalid release tag" >&2; exit 1; }
  echo "Building web bundle for Picocrypt-NG release $VERSION"
  echo "Fetching source tarball..."
  curl -fsSL "https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz" -o "$WORK/source.tar.gz"
  SOURCE_HASH="$(sha256sum "$WORK/source.tar.gz" | cut -d' ' -f1)"
  tar -xzf "$WORK/source.tar.gz" -C "$WORK"
  SRC="$WORK/Picocrypt-NG-$VERSION/src"
  [ -d "$SRC/cmd/wasm" ] || { echo "error: $SRC/cmd/wasm missing in $VERSION" >&2; exit 1; }
fi
[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]] || { echo "error: invalid version" >&2; exit 1; }

# The template's creation and credential controls require the PCV3 API 3 contract.
CORE_VERSION=""
[ ! -f "$SRC/../VERSION" ] || CORE_VERSION="$(tr -d '[:space:]' < "$SRC/../VERSION")"
[[ "$CORE_VERSION" =~ ^3\.[0-9]+([.+-][A-Za-z0-9.+-]+)?$ ]] || {
  echo "error: this template requires a Picocrypt-NG 3.x core with browser API 3 (source VERSION: ${CORE_VERSION:-missing})" >&2
  exit 1
}

echo "Compiling WASM (GOOS=js GOARCH=wasm)..."
( cd "$SRC" && GOOS=js GOARCH=wasm go build -trimpath -buildvcs=false -ldflags="-s -w" -o "$WORK/picocrypt.wasm" ./cmd/wasm )

# wasm_exec.js MUST come from the same toolchain that built the WASM: the shim
# and the Go runtime in the binary share an ABI that changes between releases.
# Evaluate Go's automatic toolchain selection in the same module as go build.
TOOLCHAIN_ROOT="$(cd "$SRC" && go env GOROOT)"
GO_VERSION="$(cd "$SRC" && go env GOVERSION)"
WASM_EXEC="$TOOLCHAIN_ROOT/lib/wasm/wasm_exec.js"
[ -f "$WASM_EXEC" ] || WASM_EXEC="$TOOLCHAIN_ROOT/misc/wasm/wasm_exec.js"
[ -f "$WASM_EXEC" ] || { echo "error: wasm_exec.js not found under GOROOT" >&2; exit 1; }
echo "Using shim: $WASM_EXEC ($GO_VERSION)"
WASM_HASH="$(sha256sum "$WORK/picocrypt.wasm" | cut -d' ' -f1)"
BUILD_INFO="version=$VERSION; source=$SOURCE; revision=$REVISION; dirty=$DIRTY; go=$GO_VERSION; wasm-sha256=$WASM_HASH; source-archive-sha256=$SOURCE_HASH"
RELEASE_URL="https://github.com/$REPO/releases"
[ "$SOURCE" = local ] || RELEASE_URL="$RELEASE_URL/tag/$VERSION"

base64 -w0 "$WORK/picocrypt.wasm" > "$WORK/wasm.b64"

echo "Injecting into template..."
awk -v exec_file="$WASM_EXEC" -v b64_file="$WORK/wasm.b64" -v version="$VERSION" -v build_info="$BUILD_INFO" -v release_url="$RELEASE_URL" '
  /__WASM_EXEC_JS__/ { while ((getline line < exec_file) > 0) print line; close(exec_file); next }
  /__WASM_BASE64__/  { getline b64 < b64_file; close(b64_file); print "\t\t\tconst wasmBase64 = \"" b64 "\";"; next }
  { gsub(/__PICOCRYPT_VERSION__/, version); gsub(/__PICOCRYPT_BUILD__/, build_info); gsub(/__PICOCRYPT_RELEASE_URL__/, release_url); print }
' "$TEMPLATE" > "$TEMP_OUT"

# Fail loud if injection left a placeholder behind or truncated the WASM: a
# silently broken index.html is worse than no build.
for ph in __WASM_EXEC_JS__ __WASM_BASE64__ __PICOCRYPT_VERSION__ __PICOCRYPT_BUILD__ __PICOCRYPT_RELEASE_URL__; do
  if grep -q "$ph" "$TEMP_OUT"; then
    echo "error: placeholder $ph still present in $OUT (injection failed)" >&2
    exit 1
  fi
done
b64_len="$(wc -c < "$WORK/wasm.b64")"
emb_len="$(awk -F'"' '/const wasmBase64 = "/{ print length($2); exit }' "$TEMP_OUT")"
if [ -z "$emb_len" ] || [ "$emb_len" -ne "$b64_len" ]; then
  echo "error: embedded base64 (${emb_len:-0}) shorter than source ($b64_len) -- truncated" >&2
  exit 1
fi
chmod 644 "$TEMP_OUT"
mv -f "$TEMP_OUT" "$OUT"
TEMP_OUT=""

echo "Wrote $OUT ($(wc -c < "$OUT") bytes) for Picocrypt-NG $VERSION."
