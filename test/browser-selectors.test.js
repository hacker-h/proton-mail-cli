import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getDebugEvents } from "../src/browser-debug.js";
import { scanInbox } from "../src/browser-messages.js";
import { locateLoginEmailField, locateProtonHomeLoginTarget, locateSignInButton } from "../src/browser-selectors.js";

function fakeLocator({ visible = false, label = "locator", errorMessage = "not visible" } = {}) {
  return {
    label,
    first() {
      return this;
    },
    async waitFor() {
      if (!visible) {
        throw new Error(errorMessage);
      }
    },
    async isVisible() {
      return visible;
    },
  };
}

function fakePage({ roleLocators = {}, selectorLocators = {} } = {}) {
  return {
    getByRole(role) {
      return roleLocators[role] || fakeLocator();
    },
    locator(selector) {
      return selectorLocators[selector] || fakeLocator();
    },
  };
}

describe("browser selector contracts", () => {
  it("falls back from role-based login email lookup to stable input selectors", async () => {
    const fallback = fakeLocator({ visible: true, label: "email-css" });
    const page = fakePage({
      roleLocators: {
        textbox: fakeLocator({ errorMessage: "role lookup failed password=supersecret user@example.com" }),
      },
      selectorLocators: {
        'input[id="email"], input[name="email"], input[type="email"], input[autocomplete="username"]': fallback,
      },
    });

    const field = await locateLoginEmailField(page, 10);

    assert.equal(field, fallback);
    const events = getDebugEvents(page);
    assert.equal(events.some((event) => event.type === "selector.failure" && event.details.area === "loginEmail"), true);
    assert.equal(events.some((event) => event.type === "selector.match" && event.details.area === "loginEmail"), true);
    assert.equal(JSON.stringify(events).includes("supersecret"), false);
    assert.equal(JSON.stringify(events).includes("user@example.com"), false);
  });

  it("records all attempted sign-in button selectors when none match", async () => {
    const page = fakePage();

    const button = await locateSignInButton(page, 10);

    assert.equal(button, null);
    const events = getDebugEvents(page);
    const notFound = events.find((event) => event.type === "selector.not_found" && event.details.area === "signInButton");
    assert.ok(notFound);
    assert.equal(notFound.details.attempts.length, 2);
    assert.equal(notFound.details.attempts.some((attempt) => attempt.role === "button"), true);
    assert.equal(notFound.details.attempts.some((attempt) => attempt.selector?.includes("button")), true);
  });

  it("locates Proton home login targets before credential fields", async () => {
    const fallback = fakeLocator({ visible: true, label: "home-login" });
    const page = fakePage({
      roleLocators: {
        link: fakeLocator(),
        button: fakeLocator(),
      },
      selectorLocators: {
        'a[href*="account.proton.me"], a[href*="/login"], a:has-text("Sign in"), a:has-text("Log in"), button:has-text("Sign in"), button:has-text("Log in")': fallback,
      },
    });

    const target = await locateProtonHomeLoginTarget(page, 10);

    assert.equal(target, fallback);
    const events = getDebugEvents(page);
    assert.equal(events.some((event) => event.type === "selector.match" && event.details.area === "protonHomeLogin"), true);
  });

  it("extracts message previews when the loaded marker selector drifts", async () => {
    const row = {
      async scrollIntoViewIfNeeded() {},
      async innerText() {
        return " Inbox preview text ";
      },
    };
    const rows = {
      async count() {
        return 1;
      },
      nth() {
        return row;
      },
    };
    const page = {
      async waitForSelector() {
        throw new Error("marker drift token=abc123");
      },
      locator(selector) {
        assert.equal(selector, '[data-testid*="message-item"]');
        return rows;
      },
    };

    const scan = await scanInbox(page, 1);

    assert.equal(scan.inboxMessageCount, 1);
    assert.deepEqual(scan.messages, [{ index: 0, preview: "Inbox preview text" }]);
    const events = getDebugEvents(page);
    assert.equal(events.some((event) => event.type === "selector.failure" && event.details.area === "messageListLoaded"), true);
    assert.equal(JSON.stringify(events).includes("abc123"), false);
  });
});
