// Build/publication policy tests; these are not cryptographic behavior coverage.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a development build writes only the requested preview and preserves it if compilation fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "picocrypt-build-test-"));
  try {
    const website = join(directory, "web"), core = join(directory, "core");
    await mkdir(website);
    await mkdir(join(core, "src", "cmd", "wasm"), { recursive: true });
    await cp(new URL("../build.sh", import.meta.url), join(website, "build.sh"));
    await cp(new URL("../index.template.html", import.meta.url), join(website, "index.template.html"));
    await writeFile(join(website, "index.html"), "previous published bundle");
    await writeFile(join(core, "VERSION"), "3.0\n");
    await writeFile(join(core, "src", "go.mod"), "module fixture\n\ngo 1.27.2\n");
    const entrypoint = join(core, "src", "cmd", "wasm", "main.go");
    await writeFile(entrypoint, "package main\nfunc main() {}\n");
    const output = join(directory, "preview.html");
    const args = [join(website, "build.sh"), "--local", core, "--output", output];
    await promisify(execFile)("bash", args, { maxBuffer: 1024 * 1024 });
    const preview = await readFile(output);
    assert.ok(preview.includes(Buffer.from("3.0-dev")));
    const embedded = preview.toString().match(/const wasmBase64 = "([A-Za-z0-9+/=]+)";/);
    assert.ok(embedded, "The generated artifact must include its WASM engine");
    const digest = createHash("sha256").update(Buffer.from(embedded[1], "base64")).digest("hex");
    assert.match(preview.toString(), new RegExp(`wasm-sha256=${digest};`), "Recorded provenance must describe the actual embedded binary");
    assert.equal(await readFile(join(website, "index.html"), "utf8"), "previous published bundle");
    await writeFile(entrypoint, "package main\nthis is invalid Go\n");
    await assert.rejects(promisify(execFile)("bash", args));
    assert.deepEqual(await readFile(output), preview);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default latest release refuses a legacy core and preserves the published destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "picocrypt-legacy-build-test-"));
  try {
    const website = join(directory, "web"), bin = join(directory, "bin");
    const source = join(directory, "Picocrypt-NG-2.18"), archive = join(directory, "legacy.tar.gz");
    await mkdir(website);
    await mkdir(bin);
    await mkdir(join(source, "src", "cmd", "wasm"), { recursive: true });
    await cp(new URL("../build.sh", import.meta.url), join(website, "build.sh"));
    await cp(new URL("../index.template.html", import.meta.url), join(website, "index.template.html"));
    await writeFile(join(website, "index.html"), "previous published bundle");
    await writeFile(join(source, "VERSION"), "2.18\n");
    await writeFile(join(source, "src", "go.mod"), "module fixture\n\ngo 1.27.2\n");
    await writeFile(join(source, "src", "cmd", "wasm", "main.go"), "package main\nfunc main() {}\n");
    await promisify(execFile)("tar", ["-czf", archive, "-C", directory, "Picocrypt-NG-2.18"]);
    await writeFile(join(bin, "curl"), `#!/bin/sh
case "$*" in
  *api.github.com/*) printf '%s\\n' '{"tag_name":"2.18"}' ;;
  *archive/refs/tags/2.18.tar.gz*)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then cp "$PICOCRYPT_FIXTURE_ARCHIVE" "$2"; exit; fi
      shift
    done
    exit 1 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PICOCRYPT_FIXTURE_ARCHIVE: archive };
    await assert.rejects(promisify(execFile)("bash", [join(website, "build.sh")], { env }), error => {
      assert.match(error.stderr, /requires.*3\.x.*API 3/i);
      return true;
    });
    assert.equal(await readFile(join(website, "index.html"), "utf8"), "previous published bundle");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
