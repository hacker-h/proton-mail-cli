import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemorySessionStore } from "../examples/memory-session-store.js";

describe("MemorySessionStore example", () => {
  it("builds cookie headers for matching Proton URLs", async () => {
    const store = new MemorySessionStore({
      uid: "uid-1",
      cookies: [
        { name: "AUTH-uid-1", value: "token", domain: ".proton.me", path: "/" },
        { name: "ignored", value: "value", domain: "example.com", path: "/" },
      ],
    });

    assert.equal(await store.getCookieHeader("https://mail.proton.me/api/core/v4/users"), "AUTH-uid-1=token");
    assert.deepEqual(await store.getUIDCandidates(), ["uid-1"]);
    assert.equal(await store.getUID(), "uid-1");
  });

  it("persists Set-Cookie headers in memory", async () => {
    const store = new MemorySessionStore({ uid: "uid-1" });

    await store.applySetCookieHeaders("https://mail.proton.me/api", [
      "AUTH-uid-1=updated; Domain=.proton.me; Path=/; Secure; HttpOnly; SameSite=Lax",
    ]);

    assert.equal(await store.getCookieHeader("https://mail.proton.me/api"), "AUTH-uid-1=updated");
    assert.equal(store.snapshot().cookies[0].httpOnly, true);
  });
});
