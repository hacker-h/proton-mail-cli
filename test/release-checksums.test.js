import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHECKSUM_FILE, parseSha256Sums, verifySha256Sums, writeSha256Sums } from "../scripts/release-checksums.mjs";

describe("release checksums", () => {
  it("writes and verifies SHA256SUMS for release artifacts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-checksums-"));
    fs.writeFileSync(path.join(directory, "proton-mail-cli-1.2.3.tgz"), "package bytes");
    fs.writeFileSync(path.join(directory, "future-installer.sh"), "installer bytes");

    const checksumPath = writeSha256Sums(directory);
    assert.equal(checksumPath, path.join(directory, CHECKSUM_FILE));
    const entries = parseSha256Sums(fs.readFileSync(checksumPath, "utf8"));
    assert.deepEqual(entries.map((entry) => entry.fileName), ["future-installer.sh", "proton-mail-cli-1.2.3.tgz"]);
    assert.doesNotThrow(() => verifySha256Sums(directory, ["proton-mail-cli-1.2.3.tgz"]));
  });

  it("fails clearly when checksum data is missing or mismatched", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-checksums-"));
    fs.writeFileSync(path.join(directory, "proton-mail-cli-1.2.3.tgz"), "package bytes");
    assert.throws(() => verifySha256Sums(directory), /Missing SHA256SUMS/u);

    writeSha256Sums(directory);
    fs.writeFileSync(path.join(directory, "proton-mail-cli-1.2.3.tgz"), "changed bytes");
    assert.throws(() => verifySha256Sums(directory), /Checksum mismatch/u);
  });
});
