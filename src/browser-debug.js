const EVENT_BUFFER = Symbol.for("protonmail.browserDebugEvents");
const SECRET_KEY_RE = /(password|secret|token|cookie|authorization|storage|session|auth)/iu;

/**
 * @typedef {{ type: string, at: string, details?: unknown, error?: { name: string, message: string } }} DebugEvent
 * @typedef {{ [EVENT_BUFFER]?: DebugEvent[] }} DebugTarget
 * @typedef {{
 *   area: string,
 *   selector?: string,
 *   role?: string,
 *   name?: unknown,
 *   state?: string,
 *   timeout?: number
 * }} SelectorDebugInput
 * @typedef {{ [key: string]: unknown }} JsonObject
 */

/**
 * @param {Record<string, string | undefined>} [envObject]
 * @returns {boolean}
 */
export function isDebugLoggingEnabled(envObject = process.env) {
  return envObject.PROTONMAIL_DEBUG === "1" || envObject.PROTONMAIL_DEBUG === "true";
}

/**
 * @param {string} message
 * @param {unknown} [error]
 * @param {Record<string, string | undefined>} [envObject]
 * @returns {void}
 */
export function debugLog(message, error, envObject = process.env) {
  if (!isDebugLoggingEnabled(envObject)) {
    return;
  }
  const suffix = error instanceof Error ? `: ${error.message}` : "";
  console.warn(`[protonmail-debug] ${message}${suffix}`);
}

/**
 * @param {string} message
 * @param {unknown} [fallback]
 * @returns {(error: unknown) => unknown}
 */
export function ignoreWithDebug(message, fallback) {
  return (error) => {
    debugLog(message, error);
    return fallback;
  };
}

/**
 * @param {unknown} target
 * @param {string} type
 * @param {unknown} [details]
 * @param {unknown} [error]
 * @returns {unknown}
 */
export function recordDebugEvent(target, type, details = {}, error = null) {
  const normalizedError = error instanceof Error
    ? { name: error.name || "Error", message: error.message || String(error) }
    : error
      ? { name: "Error", message: String(error) }
      : undefined;
  const event = sanitizeDebugEvent({
    type,
    at: new Date().toISOString(),
    details,
    error: normalizedError,
  });

  if (target && typeof target === "object") {
    /** @type {DebugTarget} */ (target)[EVENT_BUFFER] ||= [];
    /** @type {DebugTarget} */ (target)[EVENT_BUFFER].push(/** @type {DebugEvent} */ (event));
  }

  if (isDebugLoggingEnabled()) {
    console.warn(`[protonmail-debug] ${JSON.stringify(event)}`);
  }

  return event;
}

/**
 * @param {unknown} target
 * @returns {DebugEvent[]}
 */
export function getDebugEvents(target) {
  if (!target || typeof target !== "object") {
    return [];
  }
  const events = /** @type {DebugTarget} */ (target)[EVENT_BUFFER];
  return Array.isArray(events) ? [...events] : [];
}

/**
 * @param {SelectorDebugInput} input
 * @returns {{ area: string, selector?: string, role?: string, name?: string, state?: string, timeout?: number }}
 */
export function selectorDebugDetails({ area, selector, role, name, state, timeout }) {
  return {
    area,
    selector: selector || undefined,
    role: role || undefined,
    name: name ? String(name) : undefined,
    state: state || undefined,
    timeout: Number.isFinite(timeout) ? timeout : undefined,
  };
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sanitizeDebugEvent(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDebugEvent(item));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactString(value) : value;
  }

  /** @type {JsonObject} */
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = sanitizeDebugEvent(child);
  }
  return output;
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactString(value) {
  return value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "[email]")
    .replace(/\b(password|secret|token|cookie|authorization)=\S+/giu, "$1=[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gu, "$1 [redacted]");
}
