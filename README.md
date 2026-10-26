The limited web version of Picocrypt-NG.

https://picocrypt-ng.github.io/

## Building

`index.html` is generated, not hand-edited. The static UI/glue lives in
`index.template.html`; `build.sh` compiles the Picocrypt-NG WebAssembly crypto
engine from upstream and injects it (plus the matching Go `wasm_exec.js`) into
the template to produce a single self-contained `index.html`:

```sh
./build.sh          # latest Picocrypt-NG release
./build.sh 3.0      # the 3.0 release tag, once published
./build.sh --local --output /tmp/picocrypt-web-preview.html
```

Release builds require `go`, `curl`, `tar`, GNU Awk, and GNU coreutils.
This template requires a 3.x core with browser API 3. Until a supported release
is published, the default latest-release build refuses 2.x and preserves the
previous output. Unsupported core major versions are rejected before compilation.
The Go runtime shim is selected inside the source module, using the same
toolchain as the WASM build. The generated HTML records the core version,
source revision or release archive hash, toolchain, and WASM SHA-256. Reproducing
a release also requires the recorded Go version. Builds replace the destination
atomically only after successful compilation and injection checks.

`--local` builds are development previews, marked `-dev`; do not publish them.
Use `--output` to preserve the tracked release bundle while testing local changes.

## Browser checks

Install the pinned browser test dependency with `npm ci`, then install Chromium
with `npx playwright install chromium` or set `PICOCRYPT_CHROMIUM` to an existing
Chromium executable. Tests serve the explicitly selected generated bundle over
loopback HTTP and use an isolated browser profile:

```sh
./build.sh --local --output /tmp/picocrypt-web-preview.html
PICOCRYPT_TEST_HTML=/tmp/picocrypt-web-preview.html npm test
PICOCRYPT_TEST_HTML=/tmp/picocrypt-web-preview.html npm run test:crypto
```

The fast lane exercises real file-read failures, browser capability and engine
startup failures, credential/UI state, implicit-CGJ password refusal, size admission,
and fail-closed unsupported-volume handling.
The separate build check protects preview destination and atomic replacement
policy; it is not encryption coverage. No test replaces the Go bridge with a mock.
The crypto lane serially checks frozen PCV1/PCV2 reads, legacy Force refusal and
unverified output, PCV3 Normal combined credentials, and PCV3 D1 Paranoid
keyfile-only creation/decryption and authenticated recovery. Literal password
cases cover Unicode 18, composition at an intervening starter, and composition
after Hangul in both Normal and D1. It compares real downloads with independent
plaintext expectations, checks incorrect factors and final-tag damage refuse
output, checks empty plaintext round-trips, and checks UI responsiveness during a
production KDF. Worker termination is observed on completion, refusal, and page
exit. Run both lanes before a release.
Allow at least 4 GiB RAM for the browser process group and avoid concurrent KDF
tests; production Argon2 parameters are never reduced by the test harness.

The UI consumes the engine's API 3 capabilities: 128 MiB plaintext input, 256 MiB
PCV3 ciphertext, 1 GiB legacy ciphertext, and 64 MiB aggregate keyfile input
(up to 64 files). Sparse-file boundary tests check admission without promising
that a full-size round-trip will fit every browser or device. D1 reads require
explicit selection; D1 comment creation, ordered keyfiles, and forensic raw
recovery are not exposed by this UI. Normal PCV3 comments are public plaintext.

Crypto operations run in a dedicated Worker to keep the UI responsive. Each
operation releases its Worker and WASM heap; owned JavaScript byte arrays are
wiped best-effort. Browser/runtime copies and immutable password strings cannot
be guaranteed wiped. A download being started does not prove a file was saved.
