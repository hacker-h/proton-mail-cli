import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("installed pm package smoke", () => {
  it("runs the packed pm binary help, version, and JSON failure path", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-package-smoke-"));
    const packDir = path.join(tempRoot, "pack");
    const appDir = path.join(tempRoot, "app");
    const homeDir = path.join(tempRoot, "home");
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    const pack = run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: ROOT });
    assert.equal(pack.status, 0, pack.stderr);
    const [packed] = JSON.parse(pack.stdout);
    assert.ok(packed.filename, "npm pack should return a tarball filename");
    const tarball = path.join(packDir, packed.filename);
    assert.equal(fs.existsSync(tarball), true, `missing packed tarball: ${tarball}`);

    const install = run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: appDir });
    assert.equal(install.status, 0, install.stderr);

    const pm = path.join(appDir, "node_modules", ".bin", process.platform === "win32" ? "pm.cmd" : "pm");
    assert.equal(fs.existsSync(pm), true, "installed package should expose node_modules/.bin/pm");

    const env = isolatedEnv(homeDir);
    const help = run(pm, ["--help"], { cwd: appDir, env });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/u);
    assert.match(help.stdout, /pm ls/u);
    assert.equal(help.stderr, "");

    const version = run(pm, ["--version"], { cwd: appDir, env });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^pm \d+\.\d+\.\d+/u);
    assert.equal(version.stderr, "");

    const importCheck = run(process.execPath, [
      "--input-type=module",
      "--eval",
      "import { ProtonMailClient, ProtonMailBrowserClient } from 'proton-mail-cli'; console.log(`${typeof ProtonMailClient}:${typeof ProtonMailBrowserClient}`);",
    ], { cwd: appDir, env });
    assert.equal(importCheck.status, 0, importCheck.stderr);
    assert.equal(importCheck.stdout, "function:function\n");
    assert.equal(importCheck.stderr, "");

    const failure = run(pm, ["ls", "--json"], { cwd: appDir, env });
    assert.equal(failure.status, 2, failure.stderr);
    assert.equal(failure.stdout, "");

    const envelope = JSON.parse(failure.stderr);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.command, "mail:list");
    assert.equal(envelope.data, null);
    assert.equal(envelope.error.code, "FEATURE_NOT_IMPLEMENTED");
    assert.equal(envelope.meta.envelope, "pm.v1");
  });
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function isolatedEnv(homeDir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PROTONMAIL_")) delete env[key];
  }
  env.HOME = homeDir;
  env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
  env.XDG_CACHE_HOME = path.join(homeDir, ".cache");
  return env;
}
