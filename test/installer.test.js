import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(ROOT, "install.sh");

describe("install.sh", () => {
  it("installs latest release asset with checksum verification", async () => {
    const fixture = createReleaseFixture();
    const server = await serveReleaseFixture(fixture);
    try {
      const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "pm-install-prefix-"));
      const result = await runInstaller({
        PREFIX: prefix,
        PROTON_MAIL_CLI_INSTALL_API_BASE: server.apiBase,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Installed pm/u);

      const pm = path.join(prefix, "bin", "pm");
      assert.equal(fs.existsSync(pm), true);
      const help = spawnSync(pm, ["--help"], { encoding: "utf8" });
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /fixture help/u);
    } finally {
      await server.close();
    }
  });

  it("supports explicit tag without hitting the latest endpoint", async () => {
    const fixture = createReleaseFixture({ tag: "v9.9.8", version: "9.9.8" });
    const server = await serveReleaseFixture(fixture, { failLatest: true });
    try {
      const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "pm-install-prefix-"));
      const result = await runInstaller({
        PREFIX: prefix,
        TAG: "v9.9.8",
        PROTON_MAIL_CLI_INSTALL_API_BASE: server.apiBase,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(path.join(prefix, "bin", "pm")), true);
    } finally {
      await server.close();
    }
  });

  it("fails clearly when release assets are missing or checksum mismatches", async () => {
    const missingAssetServer = await serveReleaseFixture(createReleaseFixture(), { omitTarballAsset: true });
    try {
      const missing = await runInstaller({ PROTON_MAIL_CLI_INSTALL_API_BASE: missingAssetServer.apiBase });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /expected exactly one proton-mail-cli-\*\.tgz asset/u);
    } finally {
      await missingAssetServer.close();
    }

    const badChecksum = createReleaseFixture({ checksum: `${"0".repeat(64)}  proton-mail-cli-9.9.9.tgz\n` });
    const badChecksumServer = await serveReleaseFixture(badChecksum);
    try {
      const mismatch = await runInstaller({ PROTON_MAIL_CLI_INSTALL_API_BASE: badChecksumServer.apiBase });
      assert.notEqual(mismatch.status, 0);
      assert.match(mismatch.stderr, /checksum verification failed/u);
    } finally {
      await badChecksumServer.close();
    }
  });
});

function runInstaller(env) {
  const child = spawn("sh", [INSTALLER], {
    cwd: ROOT,
    env: { ...process.env, ...env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "pm-install-home-")) },
    encoding: "utf8",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function createReleaseFixture({ tag = "v9.9.9", version = "9.9.9", checksum = "" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-install-fixture-"));
  const pkg = path.join(root, "pkg");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "proton-mail-cli", version, bin: { pm: "./bin/pm.js" }, type: "module" }));
  fs.writeFileSync(path.join(pkg, "bin", "pm.js"), "#!/usr/bin/env node\nif (process.argv.includes('--help')) console.log('fixture help'); else if (process.argv.includes('--version')) console.log('pm 9.9.9'); else console.log('fixture');\n");
  fs.chmodSync(path.join(pkg, "bin", "pm.js"), 0o755);

  const pack = spawnSync("npm", ["pack", "--pack-destination", root], { cwd: pkg, encoding: "utf8" });
  assert.equal(pack.status, 0, pack.stderr);
  const tarballName = `proton-mail-cli-${version}.tgz`;
  const tarballPath = path.join(root, tarballName);
  const hash = createHash("sha256").update(fs.readFileSync(tarballPath)).digest("hex");
  fs.writeFileSync(path.join(root, "SHA256SUMS"), checksum || `${hash}  ${tarballName}\n`);
  return { root, tag, tarballName };
}

function serveReleaseFixture(fixture, options = {}) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (options.failLatest && url.pathname.endsWith("/releases/latest")) return respond(response, 404, "not found");
    if (url.pathname.endsWith("/releases/latest") || url.pathname.endsWith(`/releases/tags/${fixture.tag}`)) {
      const origin = `http://127.0.0.1:${server.address().port}`;
      return respondJson(response, {
        tag_name: fixture.tag,
        assets: [
          ...(options.omitTarballAsset ? [] : [{ name: fixture.tarballName, browser_download_url: `${origin}/assets/${fixture.tarballName}` }]),
          { name: "SHA256SUMS", browser_download_url: `${origin}/assets/SHA256SUMS` },
        ],
      });
    }
    if (url.pathname === `/assets/${fixture.tarballName}`) return respondFile(response, path.join(fixture.root, fixture.tarballName));
    if (url.pathname === "/assets/SHA256SUMS") return respondFile(response, path.join(fixture.root, "SHA256SUMS"));
    return respond(response, 404, "not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        apiBase: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((closeResolve) => server.close(closeResolve)),
      });
    });
  });
}

function respondJson(response, data) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

function respondFile(response, filePath) {
  response.writeHead(200, { "content-type": "application/octet-stream" });
  fs.createReadStream(filePath).pipe(response);
}

function respond(response, status, body) {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(body);
}
