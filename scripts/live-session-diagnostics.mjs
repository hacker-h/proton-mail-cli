#!/usr/bin/env node

import fs from "node:fs";

/**
 * @typedef {{
 *   eventName?: string,
 *   liveTestOutcome?: string,
 *   allowFreshLogin?: string | boolean,
 *   hasSessionJson?: string | boolean,
 *   hasSessionCache?: string | boolean,
 *   hasSessionCacheKey?: string | boolean,
 *   hasPrimaryCredentials?: string | boolean,
 *   hasSecondaryCredentials?: string | boolean,
 *   liveTestLog?: string,
 * }} LiveSessionDiagnosticInput
 */

/** @param {LiveSessionDiagnosticInput} input */
export function resolveLiveSessionDiagnostic(input) {
  const outcome = input.liveTestOutcome || "unknown";
  const allowFreshLogin = flag(input.allowFreshLogin);
  const hasSessionJson = flag(input.hasSessionJson);
  const hasSessionCache = flag(input.hasSessionCache);
  const hasSessionCacheKey = flag(input.hasSessionCacheKey);
  const hasPrimaryCredentials = flag(input.hasPrimaryCredentials);
  const hasSecondaryCredentials = flag(input.hasSecondaryCredentials);
  const hasReusableSession = hasSessionJson || hasSessionCache;
  const liveFailure = classifyLiveTestLog(input.liveTestLog || "");

  let category = "unknown_live_failure";
  if (outcome === "success") {
    category = "healthy";
  } else if (liveFailure === "auth_challenge") {
    category = liveFailure;
  } else if (liveFailure === "selector_or_backend_drift") {
    category = liveFailure;
  } else if (!hasReusableSession && !allowFreshLogin) {
    category = "missing_session_json";
  } else if (hasSessionCache && !hasSessionCacheKey && !hasSessionJson) {
    category = "missing_session_cache_key";
  } else if (allowFreshLogin && (!hasPrimaryCredentials || !hasSecondaryCredentials)) {
    category = "missing_fresh_login_credentials";
  } else if (!allowFreshLogin && hasReusableSession) {
    category = "expired_or_invalid_saved_session";
  } else if (allowFreshLogin && hasPrimaryCredentials) {
    category = "auth_challenge_or_backend_drift";
  }

  return {
    category,
    eventName: input.eventName || "unknown",
    outcome,
    allowFreshLogin,
    sessionJson: hasSessionJson ? "configured" : "missing",
    encryptedCache: hasSessionCache ? "restored" : "missing",
    cacheKey: hasSessionCacheKey ? "configured" : "missing",
    primaryCredentials: hasPrimaryCredentials ? "available-to-job" : "not-available-to-job",
    secondaryCredentials: hasSecondaryCredentials ? "available-to-job" : "not-available-to-job",
    action: actionFor(category),
  };
}

/** @param {ReturnType<typeof resolveLiveSessionDiagnostic>} diagnostic */
export function renderLiveSessionSummary(diagnostic) {
  return [
    "## Live Proton Session",
    "",
    `- outcome: ${diagnostic.outcome}`,
    `- category: ${diagnostic.category}`,
    `- event: ${diagnostic.eventName}`,
    `- fresh login: ${diagnostic.allowFreshLogin ? "enabled" : "disabled"}`,
    `- session seed: ${diagnostic.sessionJson}`,
    `- encrypted cache: ${diagnostic.encryptedCache}`,
    `- cache key: ${diagnostic.cacheKey}`,
    `- primary credentials: ${diagnostic.primaryCredentials}`,
    `- secondary credentials: ${diagnostic.secondaryCredentials}`,
    "",
    `Action: ${diagnostic.action}`,
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const diagnostic = resolveLiveSessionDiagnostic({
    eventName: process.env.EVENT_NAME,
    liveTestOutcome: process.env.LIVE_TEST_OUTCOME,
    allowFreshLogin: process.env.ALLOW_FRESH_LOGIN,
    hasSessionJson: process.env.HAS_SESSION_JSON,
    hasSessionCache: process.env.HAS_SESSION_CACHE,
    hasSessionCacheKey: process.env.HAS_SESSION_CACHE_KEY,
    hasPrimaryCredentials: process.env.HAS_PRIMARY_CREDENTIALS,
    hasSecondaryCredentials: process.env.HAS_SECONDARY_CREDENTIALS,
    liveTestLog: process.env.LIVE_TEST_LOG,
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(diagnostic, null, 2));
  } else {
    console.log(renderLiveSessionSummary(diagnostic));
  }
}

function actionFor(category) {
  switch (category) {
    case "healthy":
      return "No operator action needed.";
    case "missing_session_json":
      return "Configure PROTONMAIL_SESSION_JSON or run the maintainer-only Refresh Proton Session Secret workflow.";
    case "missing_session_cache_key":
      return "Configure PROTONMAIL_SESSION_CACHE_KEY, or remove the unusable encrypted cache and seed PROTONMAIL_SESSION_JSON.";
    case "missing_fresh_login_credentials":
      return "Fresh login was enabled, but one or both test-account credential pairs were not available to the job.";
    case "expired_or_invalid_saved_session":
      return "Refresh PROTONMAIL_SESSION_JSON with the maintainer workflow or a headful local capture.";
    case "auth_challenge":
      return "Proton requires CAPTCHA, 2FA, or manual interaction; use headful local capture.";
    case "selector_or_backend_drift":
      return "Investigate Proton UI selector drift, backend drift, or a project regression in the redacted live test output.";
    case "auth_challenge_or_backend_drift":
      return "Check live test output: auth_challenge means CAPTCHA/2FA/manual login required; project_or_proton_drift means selector or backend drift.";
    default:
      return "Inspect the redacted live test output and docs/ci.md failure table.";
  }
}

function flag(value) {
  return value === true || value === "1" || value === "true" || value === "yes";
}

function classifyLiveTestLog(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  const text = fs.readFileSync(filePath, "utf8");
  if (/auth_challenge|captcha|twoFactor|manualRequired/u.test(text)) return "auth_challenge";
  if (/sessionValid"?\s*:\s*false/u.test(text)) return "";
  if (/project_or_proton_drift|selector_or_backend_drift/u.test(text)) return "selector_or_backend_drift";
  return "";
}
