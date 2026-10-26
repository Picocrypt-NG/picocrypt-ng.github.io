import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const htmlPath = process.env.PICOCRYPT_TEST_HTML;
assert.ok(htmlPath, "Set PICOCRYPT_TEST_HTML to the generated bundle under test");
let browser, server, url, directory;

before(async () => {
  const html = await readFile(htmlPath);
  directory = await mkdtemp(join(tmpdir(), "picocrypt-web-test-"));
  server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    // Exercise a genuinely uninstantiable embedded WASM artifact, without
    // replacing the Go bridge or its result with a JavaScript double.
    response.end(request.url === "/corrupted-engine" ? html.toString().replace(/const wasmBase64 = "[^"]+";/, 'const wasmBase64 = "AA==";') : html);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.PICOCRYPT_CHROMIUM || undefined,
    headless: true
  });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("a removed selected file clears credentials and permits another attempt without publishing output", async () => {
  const page = await browser.newPage();
  const errors = [], downloads = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("download", download => downloads.push(download));
  try {
    const file = join(directory, "removed.pcv");
    await writeFile(file, "A public test fixture, removed before reading.");
    await page.goto(url);
    await page.locator("#fin").setInputFiles(file);
    await page.locator("#password").fill("public-test-password");
    await page.waitForFunction(() => !document.querySelector("#start").classList.contains("disabled"));
    await unlink(file);
    await page.locator("#start").click();
    await page.waitForFunction(() => /read|unavailable|could not/i.test(document.querySelector("#status").textContent), null, { timeout: 5000 });
    assert.equal(await page.locator("#password").inputValue(), "");
    assert.equal(await page.locator("#cpassword").inputValue(), "");
    assert.equal(await page.locator("#fin").isDisabled(), false);
    assert.equal(await page.locator("#start").isDisabled(), true);
    assert.deepEqual(downloads, []);
    assert.deepEqual(errors, []);
    await writeFile(file, "The reselected file must be available for a retry.");
    await page.locator("#fin").setInputFiles(file);
    await page.locator("#password").fill("retry-password");
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    assert.doesNotMatch(await page.locator("#status").textContent(), /loading/i);
  } finally {
    await page.close();
  }
});

test("keyboard users cannot edit credentials or start an operation before selecting a file", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    assert.equal(await page.locator("#password").isDisabled(), true);
    assert.equal(await page.locator("#cpassword").isDisabled(), true);
    assert.equal(await page.locator("#start").isDisabled(), true);
  } finally {
    await page.close();
  }
});

test("keyboard activation of the file button opens the real picker and enables credentials", async () => {
  const page = await browser.newPage();
  try {
    const file = join(directory, "keyboard-selection.txt");
    await writeFile(file, "Public keyboard file-selection fixture.");
    await page.goto(url);
    await page.locator("#chooseFile").focus();
    const selected = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (await selected).setFiles(file);
    assert.equal(await page.locator("#fileLabel").textContent(), "keyboard-selection.txt");
    assert.equal(await page.locator("#password").isDisabled(), false);
  } finally {
    await page.close();
  }
});

test("an empty plaintext remains selected and can start PCV3 creation", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    await page.locator("#fin").setInputFiles({ name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) });
    assert.equal(await page.locator("#password").isDisabled(), false, "PCV3 permits empty plaintext; selection must not discard it");
    await page.locator("#password").fill("public-empty-file-password");
    await page.locator("#cpassword").fill("public-empty-file-password");
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
  } finally {
    await page.close();
  }
});

test("an oversized file is rejected on selection and clears the previous credential", async () => {
  const page = await browser.newPage();
  try {
    const file = join(directory, "oversized.pcv");
    await writeFile(file, "");
    // A sparse real file exercises browser file metadata without allocating or
    // reading a GiB-sized JavaScript buffer.
    await truncate(file, 1024 * 1024 * 1024 + 1);
    await page.goto(url);
    await page.locator("#fin").setInputFiles({ name: "first.pcv", mimeType: "application/octet-stream", buffer: Buffer.from("PCV\0") });
    await page.locator("#password").fill("public-unused-password");
    await page.locator("#fin").setInputFiles(file);
    assert.equal(await page.locator("#password").inputValue(), "");
    assert.equal(await page.locator("#password").isDisabled(), true);
    assert.equal(await page.locator("#start").isDisabled(), true);
    assert.match(await page.locator("#status").textContent(), /at most 1 GiB/);
  } finally {
    await page.close();
  }
});

test("a missing second keyfile fails closed after the first keyfile was read", async () => {
  const page = await browser.newPage();
  const downloads = [], errors = [];
  page.on("download", download => downloads.push(download));
  page.on("pageerror", error => errors.push(error.message));
  try {
    const first = join(directory, "first-keyfile.bin"), second = join(directory, "removed-keyfile.bin");
    await writeFile(first, "public first keyfile");
    await writeFile(second, "public removed keyfile");
    await page.goto(url);
    await page.locator("#fin").setInputFiles({ name: "claimed.pcv", mimeType: "application/octet-stream", buffer: Buffer.from("PCV\0") });
    await page.locator("#advanced summary").click();
    await page.locator("#keyfilesDec").setInputFiles([first, second]);
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    await unlink(second);
    await page.locator("#start").click();
    await page.waitForFunction(() => /could not read/i.test(document.querySelector("#status").textContent));
    assert.equal(await page.locator("#keyfilesDec").inputValue(), "");
    assert.equal(await page.locator("#fin").isDisabled(), false);
    assert.equal(await page.locator("#start").isDisabled(), true);
    assert.deepEqual(downloads, []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("an unavailable WebAssembly API shows a handled unsupported-browser state", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(() => { delete globalThis.WebAssembly; });
    await page.goto(url);
    await page.waitForFunction(() => /unsupported/i.test(document.body.textContent));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("an invalid embedded engine fails visibly without enabling an operation", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${url}/corrupted-engine`);
    await page.waitForFunction(() => /unable to load/i.test(document.querySelector("#status").textContent));
    assert.equal(await page.locator("#start").isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("malformed claimed PCV input never starts a plaintext download", async () => {
  const page = await browser.newPage();
  const downloads = [], errors = [];
  page.on("download", download => downloads.push(download));
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(url);
    await page.locator("#fin").setInputFiles({ name: "claimed.pcv", mimeType: "application/octet-stream", buffer: Buffer.from([0x50, 0x43, 0x56, 0]) });
    await page.locator("#password").fill("public-unused-password");
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    await page.locator("#start").click();
    await page.waitForFunction(() => /unsupported|corrupt|invalid/i.test(document.querySelector("#status").textContent), null, { timeout: 5000 });
    assert.equal(await page.locator("#password").inputValue(), "");
    assert.equal(await page.locator("#fin").isDisabled(), false);
    assert.deepEqual(downloads, []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("a deniable volume can be selected for decryption without relying on its filename", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    await page.locator("#fin").setInputFiles({ name: "ordinary-looking.bin", mimeType: "application/octet-stream", buffer: Buffer.from("public file fixture") });
    await page.locator("#operation").selectOption("decrypt");
    await page.locator("#advanced summary").click();
    await page.locator("#pcv3D1").check();
    await page.locator("#password").fill("public-test-password");
    await page.waitForFunction(() => !/^Loading/.test(document.querySelector("#status").textContent));
    assert.equal(await page.locator("#start").isDisabled(), false);
    assert.equal(await page.locator("#cpassword").isVisible(), false);
    assert.equal(await page.locator("#keyfilesDec").isVisible(), true);
  } finally {
    await page.close();
  }
});

test("PCV3 creation accepts a keyfile-only credential and D1 requires a chosen output filename", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    await page.locator("#fin").setInputFiles({ name: "plain.txt", mimeType: "text/plain", buffer: Buffer.from("public file fixture") });
    await page.locator("#advanced summary").click();
    await page.locator("#keyfilesEnc").setInputFiles({ name: "public-keyfile.bin", mimeType: "application/octet-stream", buffer: Buffer.from("public keyfile fixture") });
    await page.waitForFunction(() => !/^Loading/.test(document.querySelector("#status").textContent));
    assert.equal(await page.locator("#start").isDisabled(), false);
    assert.equal(await page.locator("#password").inputValue(), "");
    await page.locator("#deniability").check();
    assert.equal(await page.locator("#start").isDisabled(), true);
    await page.locator("#outputName").fill("chosen-output.bin");
    assert.equal(await page.locator("#start").isDisabled(), false);
  } finally {
    await page.close();
  }
});

test("an over-limit PCV3 plaintext is refused before attempting to read a now-missing file", async () => {
  const page = await browser.newPage();
  const downloads = [], errors = [];
  page.on("download", download => downloads.push(download));
  page.on("pageerror", error => errors.push(error.message));
  try {
    const workerPromise = page.waitForEvent("worker");
    await page.goto(url);
    const worker = await workerPromise;
    await page.waitForFunction(() => !/^Loading/.test(document.querySelector("#status").textContent));
    const { maxPlaintextBytes } = await worker.evaluate(() => picocryptCapabilities());
    assert.ok(Number.isSafeInteger(maxPlaintextBytes) && maxPlaintextBytes > 0 && maxPlaintextBytes < 1024 * 1024 * 1024);
    const file = join(directory, "over-pcv3-plaintext-limit.txt");
    await writeFile(file, "");
    await truncate(file, maxPlaintextBytes + 1);
    await page.locator("#fin").setInputFiles(file);
    await page.locator("#password").fill("public-unused-password");
    await page.locator("#cpassword").fill("public-unused-password");
    await unlink(file);
    await page.locator("#start").click();
    await page.waitForFunction(() => /browser limit/i.test(document.querySelector("#status").textContent));
    assert.equal(await page.locator("#password").inputValue(), "");
    assert.deepEqual(downloads, []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("keyfile admission checks the aggregate size before reading any selected keyfile", async () => {
  const page = await browser.newPage();
  const downloads = [], errors = [];
  page.on("download", download => downloads.push(download));
  page.on("pageerror", error => errors.push(error.message));
  try {
    const workerPromise = page.waitForEvent("worker");
    await page.goto(url);
    const worker = await workerPromise;
    await page.waitForFunction(() => !/^Loading/.test(document.querySelector("#status").textContent));
    const { maxKeyfileBytes } = await worker.evaluate(() => picocryptCapabilities());
    assert.ok(Number.isSafeInteger(maxKeyfileBytes) && maxKeyfileBytes >= 2);
    const first = join(directory, "aggregate-first.bin"), second = join(directory, "aggregate-second.bin");
    await writeFile(first, "");
    await writeFile(second, "");
    await truncate(first, Math.floor(maxKeyfileBytes / 2));
    await truncate(second, maxKeyfileBytes - Math.floor(maxKeyfileBytes / 2) + 1);
    await page.locator("#fin").setInputFiles({ name: "claimed.pcv", mimeType: "application/octet-stream", buffer: Buffer.from("PCV\0") });
    await page.locator("#advanced summary").click();
    await page.locator("#keyfilesDec").setInputFiles([first, second]);
    // Chromium resolves disk-backed File metadata lazily. Cache the selected
    // sizes while files exist; otherwise unlinking them can report size zero
    // and correctly exercise the separate read-error path instead of admission.
    const sizes = await page.locator("#keyfilesDec").evaluate(input => Array.from(input.files, file => file.size));
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), maxKeyfileBytes + 1);
    await unlink(first);
    await unlink(second);
    await page.locator("#start").click();
    await page.waitForFunction(() => /browser limit/i.test(document.querySelector("#status").textContent));
    assert.equal(await page.locator("#keyfilesDec").inputValue(), "");
    assert.deepEqual(downloads, []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("implicit CGJ passwords fail closed in Normal and D1 and release the Worker for a retry", async () => {
  const page = await browser.newPage();
  const downloads = [], errors = [];
  page.on("download", download => downloads.push(download));
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(url);
    await page.locator("#advanced summary").click();
    for (const d1 of [false, true]) {
      for (const unit of ["\u0300", "\u1161"]) {
        await page.locator("#fin").setInputFiles({ name: "plain.txt", mimeType: "text/plain", buffer: Buffer.from("Public CGJ refusal fixture.") });
        await page.locator("#deniability").setChecked(d1);
        if (d1) await page.locator("#outputName").fill("chosen-output.bin");
        await page.locator("#password").fill(unit.repeat(31));
        await page.locator("#cpassword").fill(unit.repeat(31));
        await page.waitForFunction(() => !document.querySelector("#start").disabled);
        const oldWorker = page.workers()[0];
        const closed = new Promise(resolve => oldWorker.once("close", resolve));
        await page.locator("#start").click();
        await page.waitForFunction(() => /invalid input/i.test(document.querySelector("#status").textContent), null, { timeout: 5000 });
        await closed;
        assert.equal(page.workers().includes(oldWorker), false, "Rejected credentials must not retain the operation's WASM heap");
        assert.equal(await page.locator("#password").inputValue(), "");
        assert.equal(await page.locator("#cpassword").inputValue(), "");
        assert.equal(await page.locator("#fin").isDisabled(), false);
        assert.deepEqual(downloads, [], "Profile rejection must not publish an encrypted or plaintext artifact");
      }
    }
    await page.locator("#password").fill("public-retry-password");
    await page.locator("#cpassword").fill("public-retry-password");
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("a file exactly at the PCV3 plaintext cap reaches reading without allocating its contents", async () => {
  const page = await browser.newPage();
  const downloads = [];
  page.on("download", download => downloads.push(download));
  try {
    await page.goto(url);
    const file = join(directory, "at-plaintext-limit.txt");
    await writeFile(file, "");
    await truncate(file, 128 * 1024 * 1024);
    await page.locator("#fin").setInputFiles(file);
    assert.equal(await page.locator("#fin").evaluate(input => input.files[0].size), 128 * 1024 * 1024);
    await page.locator("#password").fill("public-boundary-password");
    await page.locator("#cpassword").fill("public-boundary-password");
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    await unlink(file);
    await page.locator("#start").click();
    await page.waitForFunction(() => /could not read/i.test(document.querySelector("#status").textContent));
    assert.deepEqual(downloads, []);
  } finally {
    await page.close();
  }
});

for (const d1 of [false, true]) {
  test(`an over-limit PCV3 ${d1 ? "D1" : "Normal"} volume is refused without a download`, async () => {
    const page = await browser.newPage();
    const downloads = [];
    page.on("download", download => downloads.push(download));
    try {
      const file = join(directory, d1 ? "over-d1-limit.bin" : "over-normal-limit.pcv");
      await writeFile(file, "PCV\0");
      await truncate(file, 256 * 1024 * 1024 + 1);
      await page.goto(url);
      await page.locator("#fin").setInputFiles(file);
      if (d1) {
        await page.locator("#operation").selectOption("decrypt");
        await page.locator("#advanced summary").click();
        await page.locator("#pcv3D1").check();
      }
      await page.locator("#password").fill("public-boundary-password");
      await page.waitForFunction(() => !document.querySelector("#start").disabled);
      await page.locator("#start").click();
      await page.waitForFunction(() => /browser limit/i.test(document.querySelector("#status").textContent), null, { timeout: 5000 });
      assert.equal(await page.locator("#password").inputValue(), "");
      assert.deepEqual(downloads, []);
      await unlink(file);
    } finally {
      await page.close();
    }
  });
}
