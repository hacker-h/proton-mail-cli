import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { browserTestOptions, createBrowserClient, formatLiveFailure, loginAndAssertSession, prepareSessionFile, pureLoginTestOptions } from "./helpers.js";

let tmpDir = "";

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

describe("live Proton login", browserTestOptions, () => {
  it("logs in automatically and reuses the saved browser session", async () => {
    const session = prepareSessionFile();
    tmpDir = session.tmpDir;
    const client = createBrowserClient(session.sessionFile);
    await loginAndAssertSession(client);
    assert.equal(fs.existsSync(session.sessionFile), true);

    const savedSession = JSON.parse(fs.readFileSync(session.sessionFile, "utf8"));
    assert.ok(Array.isArray(savedSession.cookies));
    assert.ok(savedSession.cookies.length > 0);

    const reuse = await client.loginAndSaveSession({
      manualFallback: false,
      timeoutSeconds: 120,
    });

    assert.equal(reuse.success, true, formatLiveFailure(reuse));
    assert.equal(reuse.sessionValid, true);
    assert.equal(reuse.loginMethod, "session");
  });

  it("logs in from scratch with username and password", pureLoginTestOptions, async () => {
    const session = prepareSessionFile({ seed: false });
    tmpDir = session.tmpDir;
    const client = createBrowserClient(session.sessionFile);

    const login = await client.loginAndSaveSession({
      manualFallback: false,
      timeoutSeconds: 120,
    });

    assert.equal(login.success, true, formatLiveFailure(login));
    assert.equal(login.sessionValid, true);
    assert.notEqual(login.loginMethod, "session", "Pure login must not pass only by reusing a saved session");
    assert.equal(fs.existsSync(session.sessionFile), true);

    const savedSession = JSON.parse(fs.readFileSync(session.sessionFile, "utf8"));
    assert.ok(Array.isArray(savedSession.cookies));
    assert.ok(savedSession.cookies.length > 0);
  });
});
