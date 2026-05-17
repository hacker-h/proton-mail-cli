import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ name?: string, browser_download_url?: string, url?: string }} ReleaseAsset
 * @typedef {{ tag_name?: string, tagName?: string, assets?: ReleaseAsset[] }} ReleaseMetadata
 * @typedef {{ status?: number | null, stdout?: string, stderr?: string, error?: Error }} CommandResult
 * @typedef {(url: string) => Promise<ReleaseMetadata>} FetchJson
 * @typedef {(url: string, destination: string) => Promise<void>} Download
 * @typedef {(command: string, args: string[]) => CommandResult} Runner
 * @typedef {{ repo?: string, apiBase?: string, tag?: string, version?: string, packageRoot?: string, prefix?: string, dryRun?: boolean, fetchJson?: FetchJson, download?: Download, run?: Runner }} UpdateOptions
 * @typedef {{ success: boolean, status: string, repo: string, tag: string, requestedTag: string, prefix: string, asset: string, pm: string, dryRun: boolean }} UpdateResult
 */

const DEFAULT_REPO = "hacker-h/proton-mail-cli";
const DEFAULT_API_BASE = "https://api.github.com/repos";
const PACKAGE_NAME = "proton-mail-cli";

export class UpdateError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {UpdateOptions} [options]
 * @returns {Promise<UpdateResult>}
 */
export async function runUpdate(options = {}) {
  const repo = options.repo || process.env.PROTON_MAIL_CLI_UPDATE_REPO || DEFAULT_REPO;
  const apiBase = options.apiBase || process.env.PROTON_MAIL_CLI_UPDATE_API_BASE || DEFAULT_API_BASE;
  const requestedTag = normalizeRequestedTag(options.tag || options.version || "latest");
  const packageRoot = path.resolve(options.packageRoot || defaultPackageRoot());
  const inferredPrefix = inferInstallPrefix(packageRoot);
  const explicitPrefix = typeof options.prefix === "string" && options.prefix.length > 0;
  const prefix = path.resolve(options.prefix || inferredPrefix || defaultPrefix());

  if (!explicitPrefix && !inferredPrefix) {
    throw new UpdateError(
      "UNSUPPORTED_INSTALL_MODE",
      "pm update is only supported from installer-managed GitHub Release installs; pass --prefix to update a known installer prefix",
      { packageRoot }
    );
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-update-"));
  try {
    const release = await fetchRelease({ repo, apiBase, tag: requestedTag, fetchJson: options.fetchJson });
    const assets = selectReleaseAssets(release);
    const downloadDir = path.join(tempRoot, "release");
    fs.mkdirSync(downloadDir, { recursive: true });
    const tarballPath = path.join(downloadDir, assets.tarball.name);
    const checksumsPath = path.join(downloadDir, "SHA256SUMS");
    await downloadAsset(assets.tarball.url, tarballPath, options.download);
    await downloadAsset(assets.checksums.url, checksumsPath, options.download);
    verifyDownloadedSha256Sums(downloadDir, assets.tarball.name);

    const result = {
      success: true,
      status: options.dryRun ? "dry_run" : "updated",
      repo,
      tag: release.tagName,
      requestedTag,
      prefix,
      asset: assets.tarball.name,
      pm: pmBin(prefix),
      dryRun: Boolean(options.dryRun),
    };

    if (options.dryRun) return result;

    runChecked("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarballPath], options.run);
    runChecked(result.pm, ["--help"], options.run);
    return result;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** @param {string} value */
export function normalizeRequestedTag(value) {
  const tag = String(value || "latest").trim();
  if (tag === "latest") return tag;
  if (/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(tag)) return tag;
  if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(tag)) return `v${tag}`;
  throw new UpdateError("INVALID_UPDATE_TAG", "--tag/--version must be 'latest', 'vX.Y.Z', or 'X.Y.Z'", { tag });
}

/** @param {string} packageRoot */
export function inferInstallPrefix(packageRoot) {
  const normalized = path.resolve(packageRoot);
  const suffix = path.join("lib", "node_modules", PACKAGE_NAME);
  if (!normalized.endsWith(suffix)) return "";
  return normalized.slice(0, -suffix.length).replace(/[\\/]$/u, "");
}

/**
 * @param {{ repo: string, apiBase: string, tag: string, fetchJson?: FetchJson }} options
 * @returns {Promise<ReleaseMetadata & { tagName: string }>}
 */
async function fetchRelease({ repo, apiBase, tag, fetchJson }) {
  const releaseUrl = tag === "latest"
    ? `${apiBase}/${repo}/releases/latest`
    : `${apiBase}/${repo}/releases/tags/${tag}`;
  const release = fetchJson ? await fetchJson(releaseUrl) : await fetchJsonDefault(releaseUrl);
  const tagName = release?.tag_name || release?.tagName;
  if (!tagName) throw new UpdateError("INVALID_RELEASE_METADATA", "GitHub Release metadata did not include a tag name", { releaseUrl });
  return { ...release, tagName };
}

/**
 * @param {string} url
 * @returns {Promise<ReleaseMetadata>}
 */
async function fetchJsonDefault(url) {
  const response = await fetch(url, { headers: { "user-agent": "proton-mail-cli-update" } });
  if (!response.ok) throw new UpdateError("RELEASE_METADATA_FAILED", `failed to fetch release metadata: ${response.status} ${response.statusText}`, { url });
  return response.json();
}

/** @param {ReleaseMetadata} release */
function selectReleaseAssets(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const tarballs = assets.filter((asset) => /^proton-mail-cli-.+\.tgz$/u.test(asset?.name || ""));
  const checksums = assets.filter((asset) => asset?.name === "SHA256SUMS");
  if (tarballs.length !== 1) throw new UpdateError("UNSUPPORTED_RELEASE_ASSETS", `expected exactly one proton-mail-cli-*.tgz asset, found ${tarballs.length}`);
  if (checksums.length !== 1) throw new UpdateError("MISSING_CHECKSUMS", `expected exactly one SHA256SUMS asset, found ${checksums.length}`);
  return {
    tarball: assetDownload(tarballs[0]),
    checksums: assetDownload(checksums[0]),
  };
}

/**
 * @param {ReleaseAsset} asset
 * @returns {{ name: string, url: string }}
 */
function assetDownload(asset) {
  if (!asset.name) throw new UpdateError("INVALID_RELEASE_METADATA", "release asset is missing a name");
  const url = asset.browser_download_url || asset.url;
  if (!url) throw new UpdateError("INVALID_RELEASE_METADATA", `${asset.name} has no download URL`);
  return { name: asset.name, url };
}

/**
 * @param {string} url
 * @param {string} destination
 * @param {Download | undefined} download
 */
async function downloadAsset(url, destination, download) {
  if (download) {
    await download(url, destination);
    return;
  }
  const response = await fetch(url, { headers: { "user-agent": "proton-mail-cli-update" } });
  if (!response.ok) throw new UpdateError("RELEASE_ASSET_DOWNLOAD_FAILED", `failed to download release asset: ${response.status} ${response.statusText}`, { url });
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
}

/**
 * @param {string} directory
 * @param {string} requiredFile
 */
function verifyDownloadedSha256Sums(directory, requiredFile) {
  const checksumsPath = path.join(directory, "SHA256SUMS");
  if (!fs.existsSync(checksumsPath)) throw new UpdateError("MISSING_CHECKSUMS", "Downloaded release did not include SHA256SUMS");
  const entries = fs.readFileSync(checksumsPath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([a-f0-9]{64})\s+\*?(.+)$/iu.exec(line);
      if (!match) throw new UpdateError("MISSING_CHECKSUMS", `Invalid SHA256SUMS line: ${line}`);
      return { hash: match[1].toLowerCase(), fileName: match[2] };
    });
  const expected = entries.find((entry) => entry.fileName === requiredFile);
  if (!expected) throw new UpdateError("MISSING_CHECKSUMS", `SHA256SUMS does not contain ${requiredFile}`);
  const actual = createHash("sha256").update(fs.readFileSync(path.join(directory, requiredFile))).digest("hex");
  if (actual !== expected.hash) throw new UpdateError("CHECKSUM_FAILED", `Checksum mismatch for ${requiredFile}`);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {Runner | undefined} runner
 */
function runChecked(command, args, runner) {
  const result = runner ? runner(command, args) : spawnSync(command, args, { encoding: "utf8" });
  const status = result?.status ?? 1;
  if (status === 0) return;
  throw new UpdateError("UPDATE_COMMAND_FAILED", `${command} ${args.join(" ")} failed`, {
    command,
    status,
    stderr: result?.stderr || result?.error?.message || "",
  });
}

/** @param {string} prefix */
function pmBin(prefix) {
  return path.join(prefix, "bin", process.platform === "win32" ? "pm.cmd" : "pm");
}

function defaultPrefix() {
  return path.join(os.homedir(), ".local");
}

function defaultPackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
