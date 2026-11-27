The original compatibility fixtures are copied unchanged from
`Picocrypt-NG/src/testdata/golden/` at core commit
`b1fc9b794ae3d611ee8ca95a03016d7efc69fb77`. Their independent plaintext oracle is
`There is a test file for Picocrypt validation.\n`.

The v1/v2 password is the public string `test`. The keyfile-only v2 fixture uses
an empty password and `keyfile_alpha.bin`. Tests must not regenerate these
volumes with the implementation being tested.

`pico_test_v2_comment.txt.pcv` was created once by `EncryptVolume` in
`Picocrypt-NG/src/internal/wasm` from the public 2.18 release
(`3261587f8b10471a6ed3c5ad132ada0f7c06e4cf`). It uses the same public plaintext
and password, with the comment `Public legacy v2 comment.` and all other
options at their defaults.
