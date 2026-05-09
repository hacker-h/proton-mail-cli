import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const APP_DIR = "proton-mail-cli";
const SECRET_KEY_RE = /(password|secret|token|cookie|authorization|session|auth|body)/iu;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;

export const CONFIG_ENV = Object.freeze({
  configFile: "PROTONMAIL_CONFIG_FILE",
  sessionFile: "PROTONMAIL_SESSION_FILE",
  timeout: "PROTONMAIL_TIMEOUT_SECONDS",
  username: "PROTONMAIL_USERNAME",
  password: "PROTONMAIL_PASSWORD",
});

export function defaultConfigFile(env = process.env, platform = process.platform) {
  return path.join(userConfigDir(env, platform), "config.json");
}

export function defaultSessionFilePath(env = process.env, platform = process.platform) {
  return path.join(userCacheDir(env, platform), "protonmail-auth.json");
}

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
    return { status: "session_unreadable", sessionFile, ready: false, error: error?.message || "Session file is unreadable" };
  }
}

export function normalizeAuthDoctorResult(result = {}) {
  if (result.status) {
    return redact(result);
  }
  if (result.sessionExpired || result.errorName === "SessionExpiredError" || result.code === "SESSION_EXPIRED") {
    return redact({ ...result, status: "expired_session", ready: false });
  }
  if (result.twoFactor || result.manualRequired || result.captcha) {
    return redact({ ...result, status: "manual_required", ready: false });
  }
  if (result.upstreamFailure || result.statusCode >= 500) {
    return redact({ ...result, status: "upstream_failure", ready: false });
  }
  if (result.success === true || result.sessionValid === true) {
    return redact({ ...result, status: "auth_ready", ready: true });
  }
  if (result.success === false) {
    return redact({ ...result, status: "upstream_failure", ready: false });
  }
  return redact({ ...result, status: "unknown", ready: false });
}

export function resolveSecret(name, { env = process.env, readFile = fs.readFileSync, runCommand = defaultRunCommand } = {}) {
  const direct = stringValue(env[name]);
  if (direct) return { value: direct, source: "env" };

  const filePath = stringValue(env[`${name}_FILE`]);
  if (filePath) {
    try {
      return { value: String(readFile(filePath, "utf8")).trim(), source: "file" };
    } catch (error) {
      return { value: "", source: "file", error: error?.message || `Unable to read ${name}_FILE` };
    }
  }

  const command = stringValue(env[`${name}_COMMAND`]);
  if (command) {
    try {
      return { value: runCommand(command).trim(), source: "command" };
    } catch (error) {
      return { value: "", source: "command", error: error?.message || `Unable to run ${name}_COMMAND` };
    }
  }

  return { value: "", source: "missing" };
}

export function redact(value) {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== "object") return typeof value === "string" ? redactString(value) : value;

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : redact(child);
  }
  return output;
}

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

function secretState(value, source, error = null) {
  return { configured: Boolean(value), source, error };
}

function loadConfigFile(configPath, { readFile, exists }) {
  if (!exists(configPath)) return { exists: false, loaded: false, config: {}, error: null };
  try {
    const config = JSON.parse(readFile(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return { exists: true, loaded: false, config: {}, error: "Config file must contain a JSON object" };
    }
    return { exists: true, loaded: true, config, error: null };
  } catch (error) {
    return { exists: true, loaded: false, config: {}, error: error?.message || "Config file is unreadable" };
  }
}

function userConfigDir(env, platform) {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, APP_DIR);
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", APP_DIR);
  if (platform === "win32" && env.APPDATA) return path.join(env.APPDATA, APP_DIR);
  return path.join(os.homedir(), ".config", APP_DIR);
}

function userCacheDir(env, platform) {
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, APP_DIR);
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Caches", APP_DIR);
  if (platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, APP_DIR);
  return path.join(os.homedir(), ".cache", APP_DIR);
}

function defaultRunCommand(command) {
  return execFileSync(command, { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "ignore"] });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function redactString(value) {
  return value
    .replace(EMAIL_RE, "[email]")
    .replace(/\b(password|secret|token|cookie|authorization)=\S+/giu, "$1=[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gu, "$1 [redacted]");
}
