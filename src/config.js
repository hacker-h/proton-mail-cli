import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const APP_DIR = "proton-mail-cli";
const SECRET_KEY_RE = /(password|secret|token|cookie|authorization|session|auth|body)/iu;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;

/**
 * @typedef {Record<string, string | undefined>} EnvLike
 * @typedef {(filePath: string, encoding: BufferEncoding) => string} ReadFileLike
 * @typedef {(filePath: string) => boolean} ExistsLike
 * @typedef {(command: string) => string} RunCommandLike
 * @typedef {{ config?: string | null, session?: string | null, timeout?: number | null }} CliGlobalConfig
 * @typedef {{ sessionFile?: unknown, session?: unknown, timeoutSeconds?: unknown, timeout?: unknown }} CliConfigFileValues
 * @typedef {{ value: string, source: string, error?: string }} SecretResult
 * @typedef {{ path: string, exists: boolean, loaded: boolean, error: string | null }} ResolvedConfigFile
 * @typedef {{ sessionFile: string, timeout: number | null, username: string, password: string }} ResolvedConfigValues
 * @typedef {{ config: string, sessionFile: string, timeout: string, username: string, password: string }} ResolvedConfigSources
 * @typedef {{ username: string | null, password: string | null }} ResolvedConfigErrors
 * @typedef {{ configFile: ResolvedConfigFile, values: ResolvedConfigValues, sources: ResolvedConfigSources, errors: ResolvedConfigErrors }} ResolvedCliConfig
 * @typedef {{ exists: boolean, loaded: boolean, config: CliConfigFileValues, error: string | null }} LoadedConfigFile
 * @typedef {{ session?: (...args: unknown[]) => unknown | Promise<unknown>, auth?: (...args: unknown[]) => unknown | Promise<unknown> }} DoctorClient
 * @typedef {{ doctor?: DoctorClient }} DoctorClients
 */

export const CONFIG_ENV = Object.freeze({
  configFile: "PROTONMAIL_CONFIG_FILE",
  sessionFile: "PROTONMAIL_SESSION_FILE",
  timeout: "PROTONMAIL_TIMEOUT_SECONDS",
  username: "PROTONMAIL_USERNAME",
  password: "PROTONMAIL_PASSWORD",
});

/**
 * @param {EnvLike} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function defaultConfigFile(env = process.env, platform = process.platform) {
  return path.join(userConfigDir(env, platform), "config.json");
}

/**
 * @param {EnvLike} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function defaultSessionFilePath(env = process.env, platform = process.platform) {
  return path.join(userCacheDir(env, platform), "protonmail-auth.json");
}

/**
 * @param {{ global?: CliGlobalConfig, env?: EnvLike, readFile?: ReadFileLike, exists?: ExistsLike, runCommand?: RunCommandLike }} [options]
 * @returns {ResolvedCliConfig}
 */
export function resolveCliConfig({ global = {}, env = process.env, readFile = fs.readFileSync, exists = fs.existsSync, runCommand = defaultRunCommand } = {}) {
  const configPath = path.resolve(global.config || env[CONFIG_ENV.configFile] || defaultConfigFile(env));
  const configFile = loadConfigFile(configPath, { readFile, exists });
  const fileConfig = configFile.config;

  const sessionFromFile = stringValue(fileConfig.sessionFile ?? fileConfig.session);
  const timeoutFromFile = positiveInteger(fileConfig.timeoutSeconds ?? fileConfig.timeout, null);

  const username = resolveSecret(CONFIG_ENV.username, { env, readFile, runCommand });
  const password = resolveSecret(CONFIG_ENV.password, { env, readFile, runCommand });

  const sessionFile = path.resolve(
    global.session ||
      stringValue(env[CONFIG_ENV.sessionFile]) ||
      sessionFromFile ||
      defaultSessionFilePath(env)
  );
  const timeout = global.timeout || positiveInteger(env[CONFIG_ENV.timeout], null) || timeoutFromFile;

  return {
    configFile: {
      path: configPath,
      exists: configFile.exists,
      loaded: configFile.loaded,
      error: configFile.error,
    },
    values: {
      sessionFile,
      timeout,
      username: username.value,
      password: password.value,
    },
    sources: {
      config: global.config ? "flag" : env[CONFIG_ENV.configFile] ? "env" : configFile.exists ? "default" : "default-missing",
      sessionFile: global.session ? "flag" : env[CONFIG_ENV.sessionFile] ? "env" : sessionFromFile ? "config" : "default",
      timeout: global.timeout ? "flag" : env[CONFIG_ENV.timeout] ? "env" : timeoutFromFile ? "config" : "default",
      username: username.source,
      password: password.source,
    },
    errors: {
      username: username.error || null,
      password: password.error || null,
    },
  };
}

/**
 * @param {CliGlobalConfig} [global]
 * @param {{ env?: EnvLike, readFile?: ReadFileLike, exists?: ExistsLike, runCommand?: RunCommandLike }} [options]
 */
export function doctorConfig(global = {}, options = {}) {
  const resolved = resolveCliConfig({ global, ...options });
  const secretErrors = Object.values(resolved.errors).filter(Boolean);
  return {
    status: resolved.configFile.error || secretErrors.length ? "config_error" : "ok",
    configFile: resolved.configFile,
    paths: {
      sessionFile: resolved.values.sessionFile,
    },
    sources: resolved.sources,
    credentials: {
      username: secretState(resolved.values.username, resolved.sources.username, resolved.errors.username),
      password: secretState(resolved.values.password, resolved.sources.password, resolved.errors.password),
    },
    timeout: resolved.values.timeout,
  };
}

/**
 * @param {CliGlobalConfig} [global]
 * @param {DoctorClients} [clients]
 * @param {{ env?: EnvLike, readFile?: ReadFileLike, exists?: ExistsLike, runCommand?: RunCommandLike }} [options]
 */
export async function doctorSession(global = {}, clients = {}, options = {}) {
  const resolved = resolveCliConfig({ global, ...options });
  if (resolved.configFile.error) {
    return { status: "config_error", configFile: resolved.configFile };
  }

  const request = {
    config: redactedConfig(resolved),
    sessionFile: resolved.values.sessionFile,
    timeout: resolved.values.timeout,
  };

  if (typeof clients.doctor?.session === "function") {
    return normalizeAuthDoctorResult(await clients.doctor.session(request));
  }
  if (typeof clients.doctor?.auth === "function") {
    return normalizeAuthDoctorResult(await clients.doctor.auth(request));
  }

  return inspectSessionFile(resolved.values.sessionFile, options);
}

/**
 * @param {string} sessionFile
 * @param {{ exists?: ExistsLike, readFile?: ReadFileLike }} [options]
 */
export function inspectSessionFile(sessionFile, { exists = fs.existsSync, readFile = fs.readFileSync } = {}) {
  if (!exists(sessionFile)) {
    return { status: "missing_session", sessionFile, ready: false };
  }

  try {
    const data = JSON.parse(readFile(sessionFile, "utf8"));
    const cookies = Array.isArray(data.cookies) ? data.cookies.length : 0;
    const origins = Array.isArray(data.origins) ? data.origins.length : 0;
    return { status: "session_ready", sessionFile, ready: true, cookies, origins };
  } catch (error) {
    return { status: "session_unreadable", sessionFile, ready: false, error: error instanceof Error && error.message ? error.message : "Session file is unreadable" };
  }
}

/** @param {unknown} [result] */
export function normalizeAuthDoctorResult(result = {}) {
  const record = toRecord(result);
  if (record.status) {
    return redact(record);
  }
  if (record.sessionExpired || record.errorName === "SessionExpiredError" || record.code === "SESSION_EXPIRED") {
    return redact({ ...record, status: "expired_session", ready: false });
  }
  if (record.twoFactor || record.manualRequired || record.captcha) {
    return redact({ ...record, status: "manual_required", ready: false });
  }
  if (record.upstreamFailure || Number(record.statusCode) >= 500) {
    return redact({ ...record, status: "upstream_failure", ready: false });
  }
  if (record.success === true || record.sessionValid === true) {
    return redact({ ...record, status: "auth_ready", ready: true });
  }
  if (record.success === false) {
    return redact({ ...record, status: "upstream_failure", ready: false });
  }
  return redact({ ...record, status: "unknown", ready: false });
}

/**
 * @param {string} name
 * @param {{ env?: EnvLike, readFile?: ReadFileLike, runCommand?: RunCommandLike }} [options]
 * @returns {SecretResult}
 */
export function resolveSecret(name, { env = process.env, readFile = fs.readFileSync, runCommand = defaultRunCommand } = {}) {
  const direct = stringValue(env[name]);
  if (direct) return { value: direct, source: "env" };

  const filePath = stringValue(env[`${name}_FILE`]);
  if (filePath) {
    try {
      return { value: String(readFile(filePath, "utf8")).trim(), source: "file" };
    } catch (error) {
      return { value: "", source: "file", error: error instanceof Error && error.message ? error.message : `Unable to read ${name}_FILE` };
    }
  }

  const command = stringValue(env[`${name}_COMMAND`]);
  if (command) {
    try {
      return { value: runCommand(command).trim(), source: "command" };
    } catch (error) {
      return { value: "", source: "command", error: error instanceof Error && error.message ? error.message : `Unable to run ${name}_COMMAND` };
    }
  }

  return { value: "", source: "missing" };
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function redact(value) {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== "object") return typeof value === "string" ? redactString(value) : value;

  /** @type {Record<string, unknown>} */
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : redact(child);
  }
  return output;
}

/** @param {ResolvedCliConfig} resolved */
function redactedConfig(resolved) {
  return {
    configFile: resolved.configFile,
    sessionFile: resolved.values.sessionFile,
    timeout: resolved.values.timeout,
    sources: resolved.sources,
    credentials: {
      username: secretState(resolved.values.username, resolved.sources.username, resolved.errors?.username),
      password: secretState(resolved.values.password, resolved.sources.password, resolved.errors?.password),
    },
  };
}

/**
 * @param {unknown} value
 * @param {string} source
 * @param {string | null} [error]
 */
function secretState(value, source, error = null) {
  return { configured: Boolean(value), source, error };
}

/**
 * @param {string} configPath
 * @param {{ readFile: ReadFileLike, exists: ExistsLike }} options
 * @returns {LoadedConfigFile}
 */
function loadConfigFile(configPath, { readFile, exists }) {
  if (!exists(configPath)) return { exists: false, loaded: false, config: {}, error: null };
  try {
    const config = JSON.parse(readFile(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return { exists: true, loaded: false, config: {}, error: "Config file must contain a JSON object" };
    }
    return { exists: true, loaded: true, config, error: null };
  } catch (error) {
    return { exists: true, loaded: false, config: {}, error: error instanceof Error && error.message ? error.message : "Config file is unreadable" };
  }
}

/**
 * @param {EnvLike} env
 * @param {NodeJS.Platform} platform
 */
function userConfigDir(env, platform) {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, APP_DIR);
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", APP_DIR);
  if (platform === "win32" && env.APPDATA) return path.join(env.APPDATA, APP_DIR);
  return path.join(os.homedir(), ".config", APP_DIR);
}

/**
 * @param {EnvLike} env
 * @param {NodeJS.Platform} platform
 */
function userCacheDir(env, platform) {
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, APP_DIR);
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Caches", APP_DIR);
  if (platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, APP_DIR);
  return path.join(os.homedir(), ".cache", APP_DIR);
}

/** @param {string} command */
function defaultRunCommand(command) {
  return execFileSync(command, { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * @param {unknown} value
 * @param {number | null} fallback
 */
function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** @param {string} value */
function redactString(value) {
  return value
    .replace(EMAIL_RE, "[email]")
    .replace(/\b(password|secret|token|cookie|authorization)=\S+/giu, "$1=[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gu, "$1 [redacted]");
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function toRecord(value) {
  return value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : {};
}
