import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { browserTestOptions, cleanupTmpDir, createBrowserClient, loginAndAssertSession, prepareSessionFile, redact, runPmJson } from "./helpers.js";

let tmpDir = "";

afterEach(() => {
  cleanupTmpDir(tmpDir);
  tmpDir = "";
});

describe("live Proton CLI read-only mail flows", browserTestOptions, () => {
  it("lists, searches, selects latest, and reads a browser-backed message", async () => {
    const session = prepareSessionFile();
    tmpDir = session.tmpDir;
    const client = createBrowserClient(session.sessionFile);
    await loginAndAssertSession(client);

    const env = {
      PROTONMAIL_SESSION_FILE: session.sessionFile,
      PROTONMAIL_LIVE_SESSION_FILE: session.sessionFile,
    };

    const list = runPmJson(["ls", "--limit", "5"], env);
    assert.equal(list.ok, true, redact(JSON.stringify(list.error || list)));
    assert.equal(list.data.source, "browser");
    assert.equal(list.data.status, "matched");
    assert.ok(Array.isArray(list.data.messages));
    assert.ok(list.data.messages.length > 0, "test account must contain at least one readable message");

    const target = list.data.messages.find((message) => typeof message.ref === "string" && typeof message.preview === "string") || list.data.messages[0];
    const needle = process.env.PROTONMAIL_LIVE_READ_MATCH || searchNeedle(target);
    assert.ok(needle, "live read test needs a searchable preview token");

    const search = runPmJson(["mail", "search", "--match", needle, "--limit", "5", "--require-match"], env);
    assert.equal(search.ok, true, redact(JSON.stringify(search.error || search)));
    assert.equal(search.data.source, "browser");
    assert.equal(search.data.status, "matched");
    assert.ok(search.data.messages.length > 0);

    const latest = runPmJson(["mail", "latest", "--match", needle, "--require-match"], env);
    assert.equal(latest.ok, true, redact(JSON.stringify(latest.error || latest)));
    assert.equal(latest.data.source, "browser");
    assert.equal(latest.data.status, "matched");
    assert.equal(typeof latest.data.message.ref, "string");
    assert.equal(Object.hasOwn(latest.data.message, "bodyText"), false, "latest must not expose body text");

    const readRef = latest.data.message.ref || search.data.messages[0].ref;
    const read = runPmJson(["read", readRef], env);
    assert.equal(read.ok, true, redact(JSON.stringify(read.error || read)));
    assert.equal(read.data.source, "browser");
    assert.equal(read.data.status, "matched");
    assert.equal(read.data.message.ref, readRef);
    assert.equal(typeof read.data.message.bodyText, "string");
    assert.ok(read.data.message.bodyText.trim().length > 0, "read command must return decrypted browser body text");
  });
});

function searchNeedle(message) {
  const subject = String(message.subject || message.Subject || "").trim();
  if (subject.length >= 6) return subject;

  const preview = String(message.preview || "");
  const token = preview
    .split(/\s+/u)
    .map((value) => value.replace(/[^\p{L}\p{N}@._-]+/gu, ""))
    .filter((value) => value.length >= 6 && !/^unterhaltung$/iu.test(value) && !/^kennzeichnen$/iu.test(value))
    .sort((a, b) => b.length - a.length)[0];
  return token || preview.slice(0, 30).trim();
}
