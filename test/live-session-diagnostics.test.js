import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderLiveSessionSummary, resolveLiveSessionDiagnostic } from "../scripts/live-session-diagnostics.mjs";

describe("live session diagnostics", () => {
  it("reports healthy runs without exposing secrets", () => {
    const diagnostic = resolveLiveSessionDiagnostic({
      eventName: "workflow_dispatch",
      liveTestOutcome: "success",
      allowFreshLogin: "1",
      hasSessionJson: "1",
      hasPrimaryCredentials: "1",
    });

    assert.equal(diagnostic.category, "healthy");
    assert.equal(diagnostic.sessionJson, "configured");
    assert.equal(diagnostic.primaryCredentials, "available-to-job");
    assert.equal(renderLiveSessionSummary(diagnostic).includes("available-to-job"), true);
  });

  it("distinguishes missing session seed from missing fresh-login credentials", () => {
    assert.equal(resolveLiveSessionDiagnostic({
      liveTestOutcome: "failure",
      allowFreshLogin: "0",
      hasSessionJson: "0",
      hasSessionCache: "0",
    }).category, "missing_session_json");

    assert.equal(resolveLiveSessionDiagnostic({
      liveTestOutcome: "failure",
      allowFreshLogin: "1",
      hasSessionJson: "0",
      hasSessionCache: "0",
      hasPrimaryCredentials: "0",
    }).category, "missing_fresh_login_credentials");
  });

  it("distinguishes expired saved sessions from auth or backend drift", () => {
    assert.equal(resolveLiveSessionDiagnostic({
      liveTestOutcome: "failure",
      allowFreshLogin: "0",
      hasSessionJson: "1",
    }).category, "expired_or_invalid_saved_session");

    assert.equal(resolveLiveSessionDiagnostic({
      liveTestOutcome: "failure",
      allowFreshLogin: "1",
      hasPrimaryCredentials: "1",
    }).category, "auth_challenge_or_backend_drift");
  });
});
