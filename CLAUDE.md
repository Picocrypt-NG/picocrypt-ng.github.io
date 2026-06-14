# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Web version of Picocrypt - a simple file encryption tool. Static site hosted on GitHub Pages.

- Live: https://picocrypt.github.io/
- Main Picocrypt repo: https://github.com/Picocrypt/Picocrypt

## Architecture

Single generated `index.html` file (~5MB) containing everything:
- HTML/CSS for UI
- Go WASM runtime (`wasm_exec.js`, from the Go toolchain used to build)
- Base64-encoded WebAssembly binary (the actual crypto engine)
- JavaScript glue code for file handling and WASM communication

`index.html` is built by `build.sh` from `index.template.html` (the static
UI/glue, with `__WASM_EXEC_JS__` and `__WASM_BASE64__` placeholders).

## Constraints

- 512 MiB file size limit (browser memory constraints)
- `.pcv` file extension for encrypted files
- Requires WebAssembly and crypto.getRandomValues support

## Development

To update the WASM crypto engine to a new Picocrypt-NG release, run the
generator (do NOT hand-edit the embedded WASM/`wasm_exec.js` in `index.html`):

```sh
./build.sh          # latest Picocrypt-NG release
./build.sh 2.14     # a specific release tag
```

It compiles `cmd/wasm` with `GOOS=js GOARCH=wasm`, pulls the matching
`wasm_exec.js` from the Go toolchain, and regenerates `index.html` from
`index.template.html`. Edit UI/glue in the template, not in `index.html`.
Test by serving the dir (`python3 -m http.server`) and opening it; `file://`
blocks WASM in some browsers.
