# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Web version of Picocrypt - a simple file encryption tool. Static site hosted on GitHub Pages.

- Live: https://picocrypt-ng.github.io/
- Main Picocrypt-NG repo: https://github.com/Picocrypt-NG/Picocrypt-NG

## Architecture

Single generated `index.html` file (~5MB) containing everything:
- HTML/CSS for UI
- Go WASM runtime (`wasm_exec.js`, from the Go toolchain used to build)
- Base64-encoded WebAssembly binary (the actual crypto engine)
- JavaScript glue code for file handling and WASM communication

`index.html` is built by `build.sh` from `index.template.html` (the static
UI/glue, with `__WASM_EXEC_JS__` and `__WASM_BASE64__` placeholders).

## Constraints

- 1 GiB file size limit (whole-file in-memory model; see `maxVolumeBytes` in `cmd/wasm`)
- `.pcv` file extension for encrypted files
- Requires WebAssembly and crypto.getRandomValues support

## Development

To update the WASM crypto engine to a new Picocrypt-NG release, run the
generator (do NOT hand-edit the embedded WASM/`wasm_exec.js` in `index.html`):

```sh
./build.sh             # latest Picocrypt-NG release (reproducible; for publishing)
./build.sh 2.14        # a specific release tag (reproducible)
./build.sh --local     # DEV preview from sibling ../Picocrypt-NG (NOT reproducible)
./build.sh --local DIR # DEV preview from a Picocrypt-NG checkout at DIR
```

Release builds fetch source from a public tag, so the exact `index.html` can be
reproduced from that tag — the trust model for a crypto tool. `--local` builds
from a working tree for in-browser testing BEFORE a release is cut; its output is
version-tagged `-dev` and MUST NOT be published. Only commit an `index.html` built
from a release tag.

It compiles `cmd/wasm` with `GOOS=js GOARCH=wasm`, pulls the matching
`wasm_exec.js` from the Go toolchain, and regenerates `index.html` from
`index.template.html`. Edit UI/glue in the template, not in `index.html`.
GNU Awk (gawk) is required; other awk variants truncate the multi-MB base64 line.
Test by serving the dir (`python3 -m http.server`) and opening it; `file://`
blocks WASM in some browsers.
