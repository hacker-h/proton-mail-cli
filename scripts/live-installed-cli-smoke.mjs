#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string, error?: Error }} CommandResult
 * @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv, maxBuffer?: number }} CommandOptions
 * @typedef {(command: string, args: string[], options?: CommandOptions) => CommandResult} CommandRunner
 * @typedef {{ appDir: string, root?: string, exists?: (filePath: string) => boolean, realpath?: (filePath: string) => string }} InstalledPathOptions
 * @typedef {{ env?: NodeJS.ProcessEnv, homeDir: string, sessionFile?: string, baseDir?: string }} SmokeEnvOptions
 * @typedef {{ root?: string, packDir: string, run?: CommandRunner }} PackOptions
 * @typedef {{ tarball: string, appDir: string, run?: CommandRunner }} InstallOptions
 * @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv, run?: CommandRunner }} RunJsonOptions
 * @typedef {{ root?: string, tempRoot?: string, tarball?: string, pm?: string, sessionFile?: string, env?: NodeJS.ProcessEnv, run?: CommandRunner }} SmokeOptions
 */
export function redact(value) {
  return String(value)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "[email]")
    .replace(/("\b(?:password|token|cookie|session|authorization|bodyText|messageBody)\b"\s*:\s*)"[^"]*"/giu, "$1\"[redacted]\"")
    .replace(/(\b(?:password|token|cookie|session|authorization)\b\s*=\s*)[^\r\n]+/giu, "$1[redacted]")
    .replace(/(\b(?:bodyText|messageBody)\b\s*=\s*)[^\r\n]+/giu, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gu, "$1 [redacted]")
    .replace(/("?\b(?:password|token|cookie|session|authorization|bodyText|messageBody)\b"?\s*[:=]\s*)("?)[^,"}\s]+\2/giu, "$1$2[redacted]$2");
}

export function parsePackOutput(stdout) {
  const jsonStart = stdout.indexOf("[");
  const jsonEnd = stdout.lastIndexOf("]");
  assert.notEqual(jsonStart, -1, "npm pack did not emit JSON output");
  assert.ok(jsonEnd >= jsonStart, "npm pack JSON output was incomplete");
  const [packed] = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
  assert.ok(packed?.filename, "npm pack should return a tarball filename");
  return String(packed.filename);
}

/** @param {string} pmPath @param {InstalledPathOptions} options */
export function assertInstalledPmPath(pmPath, { appDir, root = ROOT, exists = fs.existsSync, realpath = defaultRealpath }) {
  assert.equal(exists(pmPath), true, `installed package should expose node_modules/.bin/pm at ${pmPath}`);
  const realPm = realpath(pmPath);
  const realApp = realpath(appDir);
  const realRoot = realpath(root);
  assert.ok(isInside(realPm, realApp), `installed pm resolved outside smoke app: ${realPm}`);
  assert.equal(isInside(realPm, realRoot), false, `installed pm resolved to workspace source: ${realPm}`);
}

/** @param {SmokeEnvOptions} options */
export function buildSmokeEnv({ env = process.env, homeDir, sessionFile, baseDir = process.cwd() }) {
  const output = { ...env };
  const resolvedSessionFile = resolveOptionalPath(sessionFile || env.PROTONMAIL_LIVE_SESSION_FILE || "", baseDir);
  const playwrightBrowsersPath = env.PLAYWRIGHT_BROWSERS_PATH || defaultPlaywrightBrowsersPath(env);
  delete output.NODE_PATH;
  delete output.INIT_CWD;
  output.HOME = homeDir;
  output.XDG_CONFIG_HOME = path.join(homeDir, ".config");
  output.XDG_CACHE_HOME = path.join(homeDir, ".cache");
  output.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  output.PROTONMAIL_CONFIG_FILE = path.join(homeDir, "config.json");
  output.PROTONMAIL_SESSION_FILE = resolvedSessionFile;
  output.PROTONMAIL_LIVE_SESSION_FILE = output.PROTONMAIL_SESSION_FILE;
  output.PROTONMAIL_LIVE_HEADLESS = env.PROTONMAIL_LIVE_HEADLESS || "1";
  return output;
}

export function searchNeedle(message) {
  const subject = String(message?.subject || message?.Subject || "").trim();
  if (subject.length >= 6) return subject;

  const preview = String(message?.preview || "");
  const token = preview
    .split(/\s+/u)
    .map((value) => value.replace(/[^\p{L}\p{N}@._-]+/gu, ""))
    .filter((value) => value.length >= 6 && !/^unterhaltung$/iu.test(value) && !/^kennzeichnen$/iu.test(value))
    .sort((a, b) => b.length - a.length)[0];
  return token || preview.slice(0, 30).trim();
}

/** @param {string} command @param {string[]} args @param {CommandResult} result */
export function commandError(command, args, result) {
  const output = `${result.stdout || ""}${result.stderr || ""}${result.error?.message || ""}`.trim();
  return `${redact(`${command} ${redactCommandArgs(args).join(" ")}`)} failed with status ${result.status}: ${redact(output)}`;
}

/** @param {string[]} args */
function redactCommandArgs(args) {
  return args.map((arg, index) => {
    if (arg === "--match") return arg;
    if (args[index - 1] === "--match") return "[redacted]";
    if (arg.startsWith("--match=")) return "--match=[redacted]";
    return arg;
  });
}

/** @type {CommandRunner} */
export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
    error: result.error,
  };
}

/** @param {string} command @param {string[]} args @param {RunJsonOptions} [options] */
export function runJson(command, args, options = {}) {
  const result = (options.run || runCommand)(command, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, commandError(command, args, result));
  return JSON.parse(result.stdout);
}

/** @param {PackOptions} options */
export function packCurrentPackage({ root = ROOT, packDir, run = runCommand }) {
  fs.mkdirSync(packDir, { recursive: true });
  const result = run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: root });
  assert.equal(result.status, 0, commandError("npm", ["pack", "--json"], result));
  const filename = parsePackOutput(result.stdout);
  const tarball = path.join(packDir, filename);
  assert.equal(fs.existsSync(tarball), true, `missing packed tarball: ${tarball}`);
  return tarball;
}

/** @param {InstallOptions} options */
export function installPackage({ tarball, appDir, run = runCommand }) {
  fs.mkdirSync(appDir, { recursive: true });
  const result = run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: appDir });
  assert.equal(result.status, 0, commandError("npm", ["install", tarball], result));
  return path.join(appDir, "node_modules", ".bin", process.platform === "win32" ? "pm.cmd" : "pm");
}

/** @param {string} pm @param {string[]} args @param {{ env: NodeJS.ProcessEnv, appDir: string, run?: CommandRunner }} options */
export function runInstalledPmJson(pm, args, { env, appDir, run = runCommand }) {
  return runJson(pm, [...args, "--json", "--timeout", "120"], { cwd: appDir, env, run });
}

export function assertJsonOk(result, label) {
  assert.equal(result.ok, true, `${label}: ${redact(JSON.stringify(result.error || result))}`);
}

/** @param {SmokeOptions} [options] */
export async function runInstalledCliSmoke(options = {}) {
  const root = options.root || ROOT;
  const tempRoot = options.tempRoot || fs.mkdtempSync(path.join(os.tmpdir(), "pm-live-installed-"));
  const ownsTempRoot = !options.tempRoot;
  const packDir = path.join(tempRoot, "pack");
  const appDir = path.join(tempRoot, "app");
  const homeDir = path.join(tempRoot, "home");
  try {
    fs.mkdirSync(homeDir, { recursive: true });

    const tarball = options.tarball || packCurrentPackage({ root, packDir, run: options.run });
    const pm = options.pm || installPackage({ tarball, appDir, run: options.run });
    assertInstalledPmPath(pm, { appDir, root });

    const env = buildSmokeEnv({ env: options.env || process.env, homeDir, sessionFile: options.sessionFile, baseDir: root });

    const config = runInstalledPmJson(pm, ["doctor", "config"], { env, appDir, run: options.run });
    assertJsonOk(config, "doctor config");
    assert.equal(config.command, "doctor:config");

    const session = runInstalledPmJson(pm, ["doctor", "session"], { env, appDir, run: options.run });
    assertJsonOk(session, "doctor session");
    assert.equal(session.command, "doctor:session");
    assert.match(session.data.status, /session_ready|auth_ready/u, redact(JSON.stringify(session.data)));

    const list = runInstalledPmJson(pm, ["ls", "--limit", "5"], { env, appDir, run: options.run });
    assertJsonOk(list, "mail list");
    assert.equal(list.data.source, "browser");
    assert.equal(list.data.status, "matched");
    assert.ok(Array.isArray(list.data.messages));
    assert.ok(list.data.messages.length > 0, "test account must contain at least one readable message");

    const target = list.data.messages.find((message) => typeof message.ref === "string" && typeof message.preview === "string") || list.data.messages[0];
    const needle = env.PROTONMAIL_LIVE_READ_MATCH || searchNeedle(target);
    assert.ok(needle, "installed live smoke needs a searchable preview token");

    const search = runInstalledPmJson(pm, ["mail", "search", "--match", needle, "--limit", "5", "--require-match"], { env, appDir, run: options.run });
    assertJsonOk(search, "mail search");
    assert.equal(search.data.source, "browser");
    assert.equal(search.data.status, "matched");
    assert.ok(search.data.messages.length > 0);

    const latest = runInstalledPmJson(pm, ["mail", "latest", "--match", needle, "--require-match"], { env, appDir, run: options.run });
    assertJsonOk(latest, "mail latest");
    assert.equal(latest.data.source, "browser");
    assert.equal(latest.data.status, "matched");
    assert.equal(typeof latest.data.message.ref, "string");
    assert.ok(latest.data.message.ref.length > 0, "latest ref must be non-empty");
    assert.equal(Object.hasOwn(latest.data.message, "bodyText"), false, "latest must not expose body text");

    const readRef = latest.data.message.ref;
    const read = runInstalledPmJson(pm, ["read", readRef], { env, appDir, run: options.run });
    assertJsonOk(read, "mail read");
    assert.equal(read.data.source, "browser");
    assert.equal(read.data.status, "matched");
    assert.equal(read.data.message.ref, readRef);
    assert.equal(typeof read.data.message.bodyText, "string");
    assert.ok(read.data.message.bodyText.trim().length > 0, "read command must return decrypted browser body text");

    return {
      tarball: path.basename(tarball),
      appDir,
      messages: list.data.messages.length,
      readRef,
    };
  } finally {
    if (ownsTempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const summary = await runInstalledCliSmoke();
    console.log(`OK: installed ${summary.tarball} pm binary read ${summary.readRef} from ${summary.messages} listed message(s)`);
  } catch (error) {
    console.error(redact(error instanceof Error && error.stack ? error.stack : error));
    process.exitCode = 1;
  }
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function defaultRealpath(filePath) {
  return fs.realpathSync(filePath);
}

function resolveOptionalPath(filePath, baseDir) {
  return filePath ? path.resolve(baseDir, filePath) : "";
}

function defaultPlaywrightBrowsersPath(env) {
  const home = env.HOME || os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright");
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "ms-playwright");
}
