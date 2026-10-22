import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { atomicWriteFile } from "../src/atomic-fs.js";

async function fixture(t: test.TestContext, platform = "win32") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cvg-atomic-retry-"));
  const destination = path.join(root, "state.json");
  await fs.writeFile(destination, "original");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", descriptor);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, destination };
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`Windows ${code} retries the same synced temporary file without removing the destination`, async (t) => {
    const { root, destination } = await fixture(t);
    const rename = fs.rename;
    const remove = fs.rm;
    const calls: Array<[unknown, unknown]> = [];
    const removed: unknown[] = [];
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      removed.push(args[0]);
      return remove(...args);
    });
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      calls.push(args);
      assert.equal(await fs.readFile(destination, "utf8"), "original");
      assert.equal(await fs.readFile(args[0], "utf8"), "replacement");
      assert.deepEqual(args, calls[0]);
      if (calls.length < 3) throw Object.assign(new Error("sharing violation"), { code });
      return rename(...args);
    });
    syncBuiltinESMExports();
    await atomicWriteFile(destination, "replacement");
    assert.equal(calls.length, 3);
    assert.equal(await fs.readFile(destination, "utf8"), "replacement");
    assert.deepEqual(removed, [calls[0]![0]]);
    assert.deepEqual(await fs.readdir(root), ["state.json"]);
  });
}

test("Windows exhausted retries preserve destination and throw the first error", async (t) => {
  const { root, destination } = await fixture(t);
  const first = Object.assign(new Error("original sharing violation"), { code: "EPERM" });
  const calls: Array<[unknown, unknown]> = [];
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    calls.push(args);
    assert.deepEqual(args, calls[0]);
    throw calls.length === 1 ? first : Object.assign(new Error("later violation"), { code: "EBUSY" });
  });
  syncBuiltinESMExports();
  await assert.rejects(atomicWriteFile(destination, "replacement"), error => error === first);
  assert.equal(calls.length, 6);
  assert.equal(await fs.readFile(destination, "utf8"), "original");
  assert.deepEqual(await fs.readdir(root), ["state.json"]);
});

for (const [platform, code] of [["linux", "EPERM"], ["win32", "ENOENT"], ["win32", "EXDEV"]]) {
  test(`${platform} ${code} fails immediately without retry`, async (t) => {
    const { root, destination } = await fixture(t, platform);
    const failure = Object.assign(new Error("not retryable"), { code });
    let calls = 0;
    t.mock.method(fs, "rename", async () => { calls++; throw failure; });
    syncBuiltinESMExports();
    await assert.rejects(atomicWriteFile(destination, "replacement"), error => error === failure);
    assert.equal(calls, 1);
    assert.equal(await fs.readFile(destination, "utf8"), "original");
    assert.deepEqual(await fs.readdir(root), ["state.json"]);
  });
}
