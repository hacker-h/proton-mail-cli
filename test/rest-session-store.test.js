import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { FileSessionStore } from "../src/index.js";

describe("FileSessionStore", () => {
  it("builds cookie headers and UID candidates from stored REST sessions", async () => {
    const store = new FileSessionStore("/tmp/rest-session.json", {
      readFile: () => JSON.stringify({
        uid: "uid-1",
        cookies: [
          { name: "AUTH-uid-1", value: "tok", domain: ".proton.me", path: "/", expires: Math.floor(Date.now() / 1000) + 60 },
          { name: "expired", value: "old", domain: ".proton.me", path: "/", expires: 1 },
        ],
      }),
    });

    assert.equal(await store.getCookieHeader("https://mail.proton.me/api/mail/v4/messages"), "AUTH-uid-1=tok");
    assert.deepEqual(await store.getUIDCandidates(), ["uid-1"]);
    assert.equal(await store.getUID(), "uid-1");
  });

  it("persists Set-Cookie updates with private file mode", async () => {
    const writeFile = mock.fn();
    const store = new FileSessionStore("/tmp/rest-session.json", {
      readFile: () => JSON.stringify({ cookies: [{ name: "AUTH-uid-1", value: "old", domain: "mail.proton.me", path: "/" }] }),
      writeFile,
    });

    await store.applySetCookieHeaders("https://mail.proton.me/api/mail/v4/messages", ["AUTH-uid-1=new; Path=/; Secure; HttpOnly"]);

    assert.equal(writeFile.mock.callCount(), 1);
    const [filePath, body, options] = writeFile.mock.calls[0].arguments;
    assert.equal(filePath, "/tmp/rest-session.json");
    assert.equal(options.mode, 0o600);
    assert.match(body, /"value": "new"/u);
  });
});
