The limited web version of Picocrypt-NG.

https://picocrypt-ng.github.io/

## Building

`index.html` is generated, not hand-edited. The static UI/glue lives in
`index.template.html`; `build.sh` compiles the Picocrypt-NG WebAssembly crypto
engine from upstream and injects it (plus the matching Go `wasm_exec.js`) into
the template to produce a single self-contained `index.html`:

```sh
./build.sh          # latest Picocrypt-NG release
./build.sh 2.14     # a specific release tag
```

Requires `go`, `curl`, `tar`, `awk`, and GNU `base64`.
