These public compatibility fixtures are copied unchanged from
`Picocrypt-NG/src/testdata/golden/` at core commit
`b1fc9b794ae3d611ee8ca95a03016d7efc69fb77`. Their independent plaintext oracle is
`There is a test file for Picocrypt validation.\n`.

The v1/v2 password is the public string `test`. The keyfile-only v2 fixture uses
an empty password and `keyfile_alpha.bin`. Tests must not regenerate these
volumes with the implementation being tested.
