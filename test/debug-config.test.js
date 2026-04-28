import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveDebugConfig } from "../src/debug-config.js";

describe("resolveDebugConfig", () => {
  it("returns disabled when no options and no env", () => {
    const result = resolveDebugConfig({}, {});
    assert.deepEqual(result, { enabled: false });
  });

  it("returns enabled when PROTONMAIL_DEBUG=1", () => {
    const result = resolveDebugConfig({}, { PROTONMAIL_DEBUG: "1" });
    assert.equal(result.enabled, true);
    assert.equal(result.headless, false);
    assert.equal(result.cdpPort, 9222);
    assert.equal(result.suppressCooldown, true);
    assert.equal(result.keepOpenOnError, true);
  });

  it("returns enabled when PROTONMAIL_DEBUG=true", () => {
    const result = resolveDebugConfig({}, { PROTONMAIL_DEBUG: "true" });
    assert.equal(result.enabled, true);
  });

  it("returns enabled when options.debug === true", () => {
    const result = resolveDebugConfig({ debug: true }, {});
    assert.equal(result.enabled, true);
  });

  it("explicit false wins over env var", () => {
    const result = resolveDebugConfig({ debug: false }, { PROTONMAIL_DEBUG: "1" });
    assert.deepEqual(result, { enabled: false });
  });

  it("object option enables debug and overrides cdpPort", () => {
    const result = resolveDebugConfig({ debug: { cdpPort: 9333 } }, { PROTONMAIL_DEBUG: "0" });
    assert.equal(result.enabled, true);
    assert.equal(result.cdpPort, 9333);
  });

  it("object option enables debug and overrides slowMo", () => {
    const result = resolveDebugConfig({ debug: { slowMo: 50 } }, {});
    assert.equal(result.enabled, true);
    assert.equal(result.slowMo, 50);
  });

  it("returns disabled when PROTONMAIL_DEBUG=0 and no option", () => {
    const result = resolveDebugConfig({}, { PROTONMAIL_DEBUG: "0" });
    assert.deepEqual(result, { enabled: false });
  });

  it("object option enables debug and overrides executablePath", () => {
    const result = resolveDebugConfig({ debug: { executablePath: "/usr/bin/chromium" } }, {});
    assert.equal(result.enabled, true);
    assert.equal(result.executablePath, "/usr/bin/chromium");
  });

  it("object option enables debug and overrides persistProfile", () => {
    const result = resolveDebugConfig({ debug: { persistProfile: true } }, {});
    assert.equal(result.enabled, true);
    assert.equal(result.persistProfile, true);
  });
});
