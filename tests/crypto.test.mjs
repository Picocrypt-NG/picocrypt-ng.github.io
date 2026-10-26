import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

assert.ok(process.env.PICOCRYPT_TEST_HTML, "Set PICOCRYPT_TEST_HTML to the generated bundle under test");
let browser, server, url;

before(async () => {
  const html = await readFile(process.env.PICOCRYPT_TEST_HTML);
  server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(html);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.PICOCRYPT_CHROMIUM || undefined, headless: true });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

// Frozen legacy expectations come from the upstream golden fixtures, not from
// encrypting data with the reader under test. Each case uses the production KDF.
for (const fixture of [
  { file: "pico_test_v1.txt.pcv", password: "test", heartbeat: true },
  { file: "pico_test_v2.txt.pcv", password: "test" },
  { file: "pico_test_v2_keyfile_only.txt.pcv", password: "", keyfile: "keyfile_alpha.bin" }
]) {
  test(`the real browser downloads exact frozen plaintext from ${fixture.file}`, { timeout: 180000 }, async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(url);
      await page.locator("#fin").setInputFiles(fileURLToPath(new URL(`fixtures/${fixture.file}`, import.meta.url)));
      if (fixture.password) await page.locator("#password").fill(fixture.password);
      if (fixture.keyfile) {
        await page.locator("#advanced summary").click();
        await page.locator("#keyfilesDec").setInputFiles(fileURLToPath(new URL(`fixtures/${fixture.keyfile}`, import.meta.url)));
      }
      await page.waitForFunction(() => !document.querySelector("#start").disabled);
      if (fixture.heartbeat) {
        await page.evaluate(() => { window.testTicks = 0; setInterval(() => window.testTicks++, 20); });
      }
      const downloadPromise = page.waitForEvent("download", { timeout: 150000 });
      await page.locator("#start").click();
      if (fixture.heartbeat) {
        await page.waitForTimeout(250);
        const state = await page.evaluate(() => ({ ticks: window.testTicks, busy: document.querySelector("#fin").disabled,
          passwordDisabled: document.querySelector("#password").disabled, keyfilesDisabled: document.querySelector("#keyfilesDec").disabled }));
        assert.ok(state.ticks >= 3, "The page must keep scheduling work during the production KDF");
        assert.equal(state.busy, true, "Heartbeat must be observed during the operation, not after KDF completion");
        assert.equal(state.passwordDisabled, true);
        assert.equal(state.keyfilesDisabled, true);
      }
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), fixture.file.slice(0, -4));
      assert.equal(await download.failure(), null);
      assert.equal(await readFile(await download.path(), "utf8"), "There is a test file for Picocrypt validation.\n");
      assert.equal(await page.locator("#password").inputValue(), "");
      assert.equal(await page.locator("#keyfilesDec").inputValue(), "");
      assert.equal(await page.locator("#fin").inputValue(), "");
      assert.equal(await page.locator("#chooseFile").isDisabled(), false);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

async function downloadAfterStart(page) {
  // Attach a rejection handler immediately so closing a failing page cannot
  // leave an unrelated unhandled download waiter behind.
  const pending = page.waitForEvent("download", { timeout: 150000 }).catch(error => ({ error }));
  const oldWorker = page.workers()[0];
  const closed = new Promise(resolve => oldWorker.once("close", resolve));
  await page.locator("#start").click();
  await page.waitForFunction(() => !document.querySelector("#fin").disabled, null, { timeout: 150000 });
  assert.match(await page.locator("#status").textContent(), /Download started|NOT verified/);
  const download = await pending;
  assert.ok(!download.error, download.error?.message);
  assert.equal(await download.failure(), null);
  await closed;
  assert.equal(page.workers().includes(oldWorker), false, "A completed operation must release its Worker and WASM heap");
  return { name: download.suggestedFilename(), data: await readFile(await download.path()) };
}

async function damagedLegacyVolume() {
  const volume = await readFile(new URL("fixtures/pico_test_v2.txt.pcv", import.meta.url));
  volume[volume.length - 1] ^= 1;
  return { name: "damaged.txt.pcv", mimeType: "application/octet-stream", buffer: volume };
}

test("ordinary decryption refuses modified legacy data without publishing output", { timeout: 180000 }, async () => {
  const page = await browser.newPage();
  const downloads = [], errors = [];
  page.on("download", download => downloads.push(download));
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(url);
    await page.locator("#fin").setInputFiles(await damagedLegacyVolume());
    await page.locator("#password").fill("test");
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    await page.locator("#start").click();
    await page.waitForFunction(() => /modified or corrupted/i.test(document.querySelector("#status").textContent), null, { timeout: 150000 });
    assert.deepEqual(downloads, []);
    assert.equal(await page.locator("#password").inputValue(), "");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("explicit Force publishes modified legacy data only with an unverified warning", { timeout: 180000 }, async () => {
  const page = await browser.newPage();
  const downloads = [], errors = [];
  page.on("download", download => downloads.push(download));
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(url);
    await page.locator("#fin").setInputFiles(await damagedLegacyVolume());
    await page.locator("#advanced summary").click();
    await page.locator("#forceDecrypt").check();
    await page.locator("#password").fill("test");
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    const result = await downloadAfterStart(page);
    assert.equal(result.name, "damaged.txt");
    // A bit flip in this non-RS XChaCha20 payload changes only the final LF
    // byte (0x0a) to VT (0x0b); Force must never call that verified plaintext.
    assert.equal(result.data.toString(), "There is a test file for Picocrypt validation.\x0b");
    assert.match(await page.locator("#status").textContent(), /NOT verified/);
    assert.equal(downloads.length, 1);
    assert.equal(await page.locator("#forceDecrypt").isChecked(), false);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

for (const d1 of [false, true]) {
  test(d1 ? "PCV3 D1 Paranoid keyfile-only creation uses the chosen filename and explicit D1 read intent"
    : "PCV3 Normal binds both factors and preserves Unicode18 NFC-equivalent passwords and plaintext comments", { timeout: 300000 }, async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const plaintext = Buffer.from("Picocrypt NG browser PCV3 integration fixture.\n");
    const keyfile = { name: "public-keyfile.bin", mimeType: "application/octet-stream", buffer: Buffer.from("Public browser PCV3 combined keyfile fixture.") };
    try {
      await page.goto(url);
      await page.locator("#fin").setInputFiles({ name: "plain.txt", mimeType: "text/plain", buffer: plaintext });
      await page.locator("#advanced summary").click();
      await page.locator("#keyfilesEnc").setInputFiles(keyfile);
      if (d1) {
        await page.locator("#deniability").check();
        await page.locator("#paranoid").check();
        await page.locator("#outputName").fill("chosen-output.bin");
      } else {
        await page.locator("#password").fill("unicode18-\u20c2-a\u0315\u0300\u05ae\u1adeb");
        await page.locator("#cpassword").fill("unicode18-\u20c2-a\u0315\u0300\u05ae\u1adeb");
        await page.locator("#reedSolomon").check();
        await page.locator("#comments").fill("Public <img src=x onerror=alert(1)> comment.");
      }
      await page.waitForFunction(() => !document.querySelector("#start").disabled);
      const encrypted = await downloadAfterStart(page);
      assert.equal(encrypted.name, d1 ? "chosen-output.bin" : "plain.txt.pcv");
      if (!d1) assert.deepEqual(encrypted.data.subarray(0, 4), Buffer.from("PCV\0"));
      assert.equal(await page.locator("#password").inputValue(), "");
      assert.equal(await page.locator("#keyfilesEnc").inputValue(), "");
      if (!d1) {
        const unexpectedDownloads = [];
        const observeDownload = download => unexpectedDownloads.push(download);
        page.on("download", observeDownload);
        for (const wrongFactor of ["password", "keyfile"]) {
          await page.locator("#fin").setInputFiles({ name: encrypted.name, mimeType: "application/octet-stream", buffer: encrypted.data });
          await page.locator("#password").fill(wrongFactor === "password" ? "wrong-public-password" : "unicode18-\u20c2-\u00e0\u05ae\u1ade\u0315b");
          await page.locator("#keyfilesDec").setInputFiles(wrongFactor === "keyfile" ? { ...keyfile, buffer: Buffer.from("Public incorrect keyfile fixture.") } : keyfile);
          await page.waitForFunction(() => !document.querySelector("#start").disabled);
          await page.locator("#start").click();
          await page.waitForFunction(() => !document.querySelector("#fin").disabled, null, { timeout: 150000 });
          assert.match(await page.locator("#status").textContent(), /incorrect password|incorrect keyfiles/i);
          assert.deepEqual(unexpectedDownloads, [], `${wrongFactor} mismatch must never publish plaintext`);
          assert.equal(await page.locator("#password").inputValue(), "");
          assert.equal(await page.locator("#keyfilesDec").inputValue(), "");
        }
        page.off("download", observeDownload);
      }
      await page.locator("#fin").setInputFiles({ name: encrypted.name, mimeType: "application/octet-stream", buffer: encrypted.data });
      if (d1) {
        await page.locator("#operation").selectOption("decrypt");
        await page.locator("#pcv3D1").check();
      } else {
        await page.locator("#password").fill("unicode18-\u20c2-\u00e0\u05ae\u1ade\u0315b");
      }
      await page.locator("#keyfilesDec").setInputFiles(keyfile);
      await page.waitForFunction(() => !document.querySelector("#start").disabled);
      const decrypted = await downloadAfterStart(page);
      assert.deepEqual(decrypted.data, plaintext);
      assert.equal(decrypted.name, d1 ? "chosen-output.bin.decrypted" : "plain.txt");
      assert.doesNotMatch(await page.locator("#status").textContent(), /NOT verified/);
      if (!d1) {
        assert.equal(await page.locator("#decComments").textContent(), "Comments: Public <img src=x onerror=alert(1)> comment.");
        assert.equal(await page.locator("#decComments img").count(), 0);
      } else {
        // The frozen D1 wire contract stores a 320-byte bootstrap at each end.
        await page.locator("#fin").setInputFiles({ name: encrypted.name, mimeType: "application/octet-stream", buffer: encrypted.data.subarray(0, -320) });
        await page.locator("#operation").selectOption("decrypt");
        await page.locator("#pcv3D1").check();
        await page.locator("#keyfilesDec").setInputFiles(keyfile);
        await page.waitForFunction(() => !document.querySelector("#start").disabled);
        const recovered = await downloadAfterStart(page);
        assert.deepEqual(recovered.data, plaintext);
        assert.match(await page.locator("#status").textContent(), /Recovery was needed; keep the original/i);
        assert.doesNotMatch(await page.locator("#status").textContent(), /NOT verified/);
      }
      assert.equal(await page.locator("#keyfilesDec").inputValue(), "");
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

// Literal NFC expectations cover Unicode 18 and the two upstream composition
// defects; browser String.normalize is deliberately not used as the oracle.
for (const credential of [
  { name: "Unicode18 combining classes", input: "unicode18-\u20c2-a\u0315\u0300\u05ae\u1adeb", canonical: "unicode18-\u20c2-\u00e0\u05ae\u1ade\u0315b", modes: [true] },
  { name: "intervening starter", input: "i\u{113c2}\u0300\u0316", canonical: "i\u{113c2}\u0316\u0300", different: "\u00ec\u{113c2}\u0316", modes: [false, true] },
  { name: "composition after Hangul", input: "\u1100\u1161\u{113c2}\u{113c2}", canonical: "\uac00\u{113c5}", modes: [false, true] }
]) {
  for (const d1 of credential.modes) {
    test(`PCV3 ${d1 ? "D1" : "Normal"} preserves ${credential.name} credential meaning`, { timeout: 300000 }, async () => {
      const page = await browser.newPage();
      const errors = [], downloads = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("download", download => downloads.push(download));
      const plaintext = Buffer.from("Public Unicode credential fixture.\x00\n");
      try {
        await page.goto(url);
        await page.locator("#fin").setInputFiles({ name: "unicode.txt", mimeType: "text/plain", buffer: plaintext });
        await page.locator("#advanced summary").click();
        if (d1) {
          await page.locator("#deniability").check();
          await page.locator("#outputName").fill("chosen-unicode.bin");
        }
        await page.locator("#password").fill(credential.input);
        await page.locator("#cpassword").fill(credential.input);
        await page.waitForFunction(() => !document.querySelector("#start").disabled);
        const encrypted = await downloadAfterStart(page);
        if (credential.different) {
          await page.locator("#fin").setInputFiles({ name: encrypted.name, mimeType: "application/octet-stream", buffer: encrypted.data });
          if (d1) {
            await page.locator("#operation").selectOption("decrypt");
            await page.locator("#pcv3D1").check();
          }
          await page.locator("#password").fill(credential.different);
          await page.waitForFunction(() => !document.querySelector("#start").disabled);
          await page.locator("#start").click();
          await page.waitForFunction(() => !document.querySelector("#fin").disabled, null, { timeout: 150000 });
          assert.match(await page.locator("#status").textContent(), /incorrect password/i);
          assert.equal(downloads.length, 1, "Composition must not merge a different password across a starter");
          assert.equal(await page.locator("#password").inputValue(), "");
        }
        await page.locator("#fin").setInputFiles({ name: encrypted.name, mimeType: "application/octet-stream", buffer: encrypted.data });
        if (d1) {
          await page.locator("#operation").selectOption("decrypt");
          await page.locator("#pcv3D1").check();
        }
        await page.locator("#password").fill(credential.canonical);
        await page.waitForFunction(() => !document.querySelector("#start").disabled);
        assert.deepEqual((await downloadAfterStart(page)).data, plaintext);
        assert.equal(await page.locator("#password").inputValue(), "");
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
}

test("empty PCV3 plaintext round-trips and a damaged final tag exposes no output", { timeout: 300000 }, async () => {
  const page = await browser.newPage();
  const downloads = [], errors = [];
  page.on("download", download => downloads.push(download));
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(url);
    await page.locator("#fin").setInputFiles({ name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) });
    await page.locator("#password").fill("public-empty-file-password");
    await page.locator("#cpassword").fill("public-empty-file-password");
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    const encrypted = await downloadAfterStart(page);
    const damaged = Buffer.from(encrypted.data);
    // The frozen Normal wire layout ends in a 1008-byte suffix after the final tag.
    damaged[damaged.length - 1009] ^= 0x80;
    await page.locator("#fin").setInputFiles({ name: encrypted.name, mimeType: "application/octet-stream", buffer: damaged });
    await page.locator("#password").fill("public-empty-file-password");
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    await page.locator("#start").click();
    await page.waitForFunction(() => !document.querySelector("#fin").disabled, null, { timeout: 150000 });
    assert.match(await page.locator("#status").textContent(), /modified or corrupted/i);
    assert.equal(downloads.length, 1, "Final authentication failure must withhold even empty plaintext");
    assert.equal(await page.locator("#password").inputValue(), "");
    await page.locator("#fin").setInputFiles({ name: encrypted.name, mimeType: "application/octet-stream", buffer: encrypted.data });
    await page.locator("#password").fill("public-empty-file-password");
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    const decrypted = await downloadAfterStart(page);
    assert.equal(decrypted.name, "empty.txt");
    assert.deepEqual(decrypted.data, Buffer.alloc(0));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("leaving the page terminates an in-flight production-KDF Worker without a download", { timeout: 180000 }, async () => {
  const page = await browser.newPage();
  const downloads = [];
  page.on("download", download => downloads.push(download));
  try {
    await page.goto(url);
    await page.locator("#fin").setInputFiles({ name: "public.txt", mimeType: "text/plain", buffer: Buffer.from("Public interrupted operation fixture.") });
    await page.locator("#password").fill("public-interrupted-password");
    await page.locator("#cpassword").fill("public-interrupted-password");
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    const oldWorker = page.workers()[0];
    const closed = new Promise(resolve => oldWorker.once("close", resolve));
    await page.evaluate(() => { window.cancelTicks = 0; setInterval(() => window.cancelTicks++, 20); });
    await page.locator("#start").click();
    await page.waitForTimeout(250);
    assert.ok(await page.evaluate(() => window.cancelTicks) >= 3, "PCV3 work must keep the page responsive before navigation cancels it");
    assert.equal(await page.locator("#fin").isDisabled(), true);
    await page.goto("about:blank");
    await closed;
    assert.equal(page.workers().includes(oldWorker), false);
    assert.deepEqual(downloads, []);
    await page.goto(url);
    await page.waitForFunction(() => /^Ready/.test(document.querySelector("#status").textContent));
    assert.equal(await page.locator("#password").inputValue(), "");
  } finally {
    await page.close();
  }
});
