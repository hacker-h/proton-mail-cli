import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { debugLog } from "./browser-debug.js";
import { SessionExpiredError } from "./errors.js";

/**
 * @typedef {{ exists: boolean, storageState?: unknown, error?: string | null }} StorageLoadResult
 * @typedef {{ state?: string }} NavigationState
 * @typedef {{ storageState: () => Promise<unknown> }} StorageContext
 * @typedef {Error & { code?: string, status?: number, details?: unknown }} StructuredError
 */

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
export const DEFAULT_SESSION_FILE = path.join(DATA_DIR, "protonmail-auth.json");
const LOGIN_COOLDOWN_MS = 5 * 60 * 1000;
const PRIVATE_FILE_MODE = 0o600;

/**
 * @param {unknown} filePath
 * @returns {string}
 */
export function normalizePath(filePath) {
  return filePath ? path.resolve(String(filePath)) : "";
}

/**
 * @param {unknown} filePath
 * @returns {string}
 */
export function normalizeAbsolutePath(filePath) {
  if (!filePath) {
    return "";
  }
  const candidate = String(filePath).trim();
  return path.isAbsolute(candidate) ? path.resolve(candidate) : "";
}

/**
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * @param {string} dirPath
 * @returns {void}
 */
export function ensureDir(dirPath) {
  if (!dirPath) {
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * @param {string} dirPath
 * @returns {void}
 */
export function ensurePrivateDir(dirPath) {
  ensureDir(dirPath);
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch (error) {
    debugLog(`Failed to set private directory permissions for ${dirPath}`, error);
  }
}

/**
 * @param {unknown} filePath
 * @returns {boolean}
 */
export function loadEnvFile(filePath) {
  const trustedPath = normalizeAbsolutePath(filePath);
  if (!trustedPath || !fs.existsSync(trustedPath)) {
    return false;
  }
  const lines = fs.readFileSync(trustedPath, "utf8").split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    if (!key || process.env[key]) {
      continue;
    }
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}

/**
 * @param {string} sessionFile
 * @returns {{ exists: false, storageState: null, error: null } | { exists: true, storageState: unknown, error: null } | { exists: true, storageState: null, error: string }}
 */
export function loadStorageState(sessionFile) {
  if (!fs.existsSync(sessionFile)) {
    return { exists: false, storageState: null, error: null };
  }
  try {
    return {
      exists: true,
      storageState: JSON.parse(fs.readFileSync(sessionFile, "utf8")),
      error: null,
    };
  } catch (error) {
    return {
      exists: true,
      storageState: null,
      error: error instanceof Error ? error.message : "Session file unreadable",
    };
  }
}

/**
 * @param {StorageLoadResult} storage
 * @param {NavigationState} navigation
 * @returns {boolean}
 */
export function isExpiredSavedSession(storage, navigation) {
  return Boolean(storage?.exists && storage.storageState && navigation?.state === "login");
}

/**
 * @param {string} sessionFile
 * @returns {string}
 */
export function cooldownFile(sessionFile) {
  return path.join(path.dirname(sessionFile), "protonmail-login-cooldown.json");
}

/**
 * @param {string} sessionFile
 * @returns {{ active: boolean }}
 */
export function getCooldownState(sessionFile) {
  const filePath = cooldownFile(sessionFile);
  if (!fs.existsSync(filePath)) {
    return { active: false };
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const lastFailedAt = data?.lastFailedAt ? Date.parse(data.lastFailedAt) : Number.NaN;
    if (!Number.isFinite(lastFailedAt)) {
      return { active: false };
    }
    return { active: Date.now() - lastFailedAt < LOGIN_COOLDOWN_MS };
  } catch (error) {
    debugLog(`Failed to read login cooldown file ${filePath}`, error);
    return { active: false };
  }
}

/**
 * @param {string} sessionFile
 * @param {string} reason
 * @returns {void}
 */
export function writeCooldown(sessionFile, reason) {
  const filePath = cooldownFile(sessionFile);
  writePrivateJsonFile(filePath, { lastFailedAt: new Date().toISOString(), reason });
}

/**
 * @param {string} sessionFile
 * @returns {void}
 */
export function clearCooldown(sessionFile) {
  const filePath = cooldownFile(sessionFile);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * @param {StorageContext} context
 * @param {string} sessionFile
 * @returns {Promise<void>}
 */
export async function saveSession(context, sessionFile) {
  const storageState = await context.storageState();
  writePrivateJsonFile(sessionFile, storageState);
}

/**
 * @param {string} filePath
 * @param {unknown} value
 * @returns {void}
 */
export function writePrivateJsonFile(filePath, value) {
  ensurePrivateDir(path.dirname(filePath));
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch {}
    throw error;
  }
}

/**
 * @param {unknown} error
 * @param {Record<string, unknown>} [extra]
 * @returns {{ success: false, error: unknown, [key: string]: unknown }}
 */
export function resultWithError(error, extra = {}) {
  if (error instanceof Error) {
    const structuredError = /** @type {StructuredError} */ (error);
    return {
      success: false,
      error: error.message,
      errorName: error.name,
      code: structuredError.code,
      status: structuredError.status,
      details: structuredError.details,
      ...extra,
    };
  }
  return { success: false, error, ...extra };
}

/**
 * @param {Record<string, unknown>} [details]
 * @returns {{ success: false, error: unknown, [key: string]: unknown }}
 */
export function sessionExpiredResult(details = {}) {
  return resultWithError(new SessionExpiredError("Saved Proton Mail session expired; refresh the session file", details), {
    sessionExpired: true,
    sessionValid: false,
  });
}
