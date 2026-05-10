import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("examples", () => {
  it("parses OTP codes client-side from artificial message fixtures", () => {
    const result = spawnSync(process.execPath, [
      "examples/client-side-otp.js",
      "--fixture",
      "examples/fixtures/otp-message.json",
      "--json",
    ], { cwd: ROOT, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      code: "246810",
      subject: "Example verification",
    });
  });
});
