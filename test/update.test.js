import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { inferInstallPrefix, normalizeRequestedTag, runUpdate, UpdateError } from "../src/update.js";

describe("pm update", () => {
  it("normalizes accepted update tags", () => {
    assert.equal(normalizeRequestedTag("latest"), "latest");
    assert.equal(normalizeRequestedTag("v2.2.1"), "v2.2.1");
    assert.equal(normalizeRequestedTag("2.2.1"), "v2.2.1");
    assert.throws(() => normalizeRequestedTag("main"), { code: "INVALID_UPDATE_TAG" });
  });

  it("infers installer prefixes from npm global package paths", () => {
    assert.equal(inferInstallPrefix("/home/user/.local/lib/node_modules/proton-mail-cli"), "/home/user/.local");
    assert.equal(inferInstallPrefix("/repo/proton-mail-cli"), "");
  });

  it("rejects source checkouts unless a prefix is provided", async () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-source-checkout-"));
    fs.writeFileSync(path.join(packageRoot, ".git"), "gitdir: elsewhere\n", "utf8");

    await assert.rejects(() => runUpdate({ packageRoot }), {
      name: "UpdateError",
      code: "UNSUPPORTED_INSTALL_MODE",
    });
  });

  it("downloads and verifies release assets before dry-run update", async () => {
    const fixture = createReleaseFixture("v2.2.1", "fixture package");

    const result = await runUpdate({
      tag: "2.2.1",
      prefix: fixture.prefix,
      packageRoot: fixture.packageRoot,
      dryRun: true,
      fetchJson: async (url) => {
        assert.match(url, /releases\/tags\/v2\.2\.1$/u);
        return fixture.release;
      },
      download: async (url, destination) => {
        fs.copyFileSync(fixture.assets.get(url), destination);
      },
    });

    assert.equal(result.status, "dry_run");
    assert.equal(result.tag, "v2.2.1");
    assert.equal(result.asset, "proton-mail-cli-2.2.1.tgz");
    assert.equal(result.prefix, fixture.prefix);
  });

  it("installs verified release assets into the selected prefix", async () => {
    const fixture = createReleaseFixture("v2.2.1", "fixture package");
    const calls = [];

    const result = await runUpdate({
      tag: "latest",
      prefix: fixture.prefix,
      packageRoot: fixture.packageRoot,
      fetchJson: async (url) => {
        assert.match(url, /releases\/latest$/u);
        return fixture.release;
      },
      download: async (url, destination) => {
        fs.copyFileSync(fixture.assets.get(url), destination);
      },
      run: (command, args) => {
        calls.push([command, args]);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(result.status, "updated");
    assert.deepEqual(calls[0][0], "npm");
    assert.deepEqual(calls[0][1].slice(0, 5), ["install", "--global", "--prefix", fixture.prefix, "--no-audit"]);
    assert.equal(calls[1][0], path.join(fixture.prefix, "bin", process.platform === "win32" ? "pm.cmd" : "pm"));
    assert.deepEqual(calls[1][1], ["--help"]);
  });
});

function createReleaseFixture(tag, tarballContent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-update-fixture-"));
  const prefix = path.join(root, "prefix");
  const packageRoot = path.join(prefix, "lib", "node_modules", "proton-mail-cli");
  const tarballName = `proton-mail-cli-${tag.slice(1)}.tgz`;
  const tarball = path.join(root, tarballName);
  const checksums = path.join(root, "SHA256SUMS");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(tarball, tarballContent, "utf8");
  const digest = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  fs.writeFileSync(checksums, `${digest}  ${tarballName}\n`, "utf8");
  const assets = new Map([
    ["https://download.example.test/package.tgz", tarball],
    ["https://download.example.test/SHA256SUMS", checksums],
  ]);
  return {
    prefix,
    packageRoot,
    assets,
    release: {
      tag_name: tag,
      assets: [
        { name: tarballName, browser_download_url: "https://download.example.test/package.tgz" },
        { name: "SHA256SUMS", browser_download_url: "https://download.example.test/SHA256SUMS" },
      ],
    },
  };
}
