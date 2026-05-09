const EVENT_BUFFER = Symbol.for("protonmail.browserDebugEvents");
const SECRET_KEY_RE = /(password|secret|token|cookie|authorization|storage|session|auth)/iu;

export function isDebugLoggingEnabled(envObject = process.env) {
  return envObject.PROTONMAIL_DEBUG === "1" || envObject.PROTONMAIL_DEBUG === "true";
}

export function debugLog(message, error, envObject = process.env) {
  if (!isDebugLoggingEnabled(envObject)) {
    return;
  }
  const suffix = error?.message ? `: ${error.message}` : "";
  console.warn(`[protonmail-debug] ${message}${suffix}`);
}

export function ignoreWithDebug(message, fallback) {
  return (error) => {
    debugLog(message, error);
    return fallback;
  };
}

export function recordDebugEvent(target, type, details = {}, error = null) {
  const event = sanitizeDebugEvent({
    type,
    at: new Date().toISOString(),
    details,
    error: error
      ? {
          name: error.name || "Error",
          message: error.message || String(error),
        }
      : undefined,
  });

  if (target && typeof target === "object") {
    target[EVENT_BUFFER] ||= [];
    target[EVENT_BUFFER].push(event);
  }

  if (isDebugLoggingEnabled()) {
    console.warn(`[protonmail-debug] ${JSON.stringify(event)}`);
  }

  return event;
}

export function getDebugEvents(target) {
  return Array.isArray(target?.[EVENT_BUFFER]) ? [...target[EVENT_BUFFER]] : [];
}

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

function sanitizeDebugEvent(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDebugEvent(item));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactString(value) : value;
  }

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

function redactString(value) {
  return value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "[email]")
    .replace(/\b(password|secret|token|cookie|authorization)=\S+/giu, "$1=[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gu, "$1 [redacted]");
}
