import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DEBUG_PROFILE_DIR = path.join(ROOT_DIR, "data", "debug-profile");

/**
 * @typedef {{ enabled: false }} DisabledDebugConfig
 * @typedef {{
 *   enabled: true,
 *   headless: false,
 *   cdpPort: number,
 *   profileDir: string,
 *   executablePath: string,
 *   manualTimeoutSeconds: number,
 *   suppressCooldown: boolean,
 *   keepOpenOnError: boolean,
 *   slowMo: number,
 *   verbose: boolean,
 *   persistProfile: boolean
 * }} EnabledDebugConfig
 * @typedef {DisabledDebugConfig | EnabledDebugConfig} DebugConfig
 * @typedef {{ debug?: boolean | Partial<EnabledDebugConfig> }} DebugOptions
 */

/**
 * Resolve debug configuration from constructor options and environment variables.
 *
 * Precedence: explicit constructor option > env var > safe default (disabled)
 *
 * @param {DebugOptions} options - Raw constructor options (may have options.debug)
 * @param {Record<string, string | undefined>} env - Environment variables object (e.g. process.env or a mock)
 * @returns {DebugConfig}
 */
export function resolveDebugConfig(options, env) {
  const debugOption = options.debug;

  if (debugOption === false) {
    return { enabled: false };
  }

  const envEnabled =
    env.PROTONMAIL_DEBUG === "1" || env.PROTONMAIL_DEBUG === "true";
  const optionEnabled =
    debugOption === true || (debugOption !== null && typeof debugOption === "object");

  if (!optionEnabled && !envEnabled) {
    return { enabled: false };
  }

  /** @type {Partial<EnabledDebugConfig>} */
  const overrides = typeof debugOption === "object" && debugOption !== null ? debugOption : {};

  return {
    enabled: true,
    headless: false,
    cdpPort:
      overrides.cdpPort !== undefined
        ? overrides.cdpPort
        : env.PROTONMAIL_DEBUG_CDP_PORT
        ? Number(env.PROTONMAIL_DEBUG_CDP_PORT)
        : 9222,
    profileDir:
      overrides.profileDir !== undefined
        ? overrides.profileDir
        : env.PROTONMAIL_DEBUG_PROFILE_DIR || DEFAULT_DEBUG_PROFILE_DIR,
    executablePath:
      overrides.executablePath !== undefined
        ? overrides.executablePath
        : env.PROTONMAIL_DEBUG_CHROMIUM || "",
    manualTimeoutSeconds: parsePositiveInt(
      overrides.manualTimeoutSeconds ?? env.PROTONMAIL_DEBUG_MANUAL_TIMEOUT_SECONDS ?? env.PROTONMAIL_DEBUG_TIMEOUT_SECONDS,
      1800
    ),
    suppressCooldown: true,
    keepOpenOnError: true,
    slowMo: overrides.slowMo !== undefined ? overrides.slowMo : 0,
    verbose: true,
    persistProfile:
      overrides.persistProfile !== undefined ? overrides.persistProfile : false,
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
