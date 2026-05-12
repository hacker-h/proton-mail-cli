import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveLiveSecretPolicy } from "../scripts/live-secret-policy.mjs";

describe("live Proton secret policy", () => {
  it("allows scheduled CI to refresh expired sessions with stored credentials", () => {
    assert.deepEqual(resolveLiveSecretPolicy({
      eventName: "schedule",
      actor: "hacker-h",
      repositoryOwner: "hacker-h",
      repository: "hacker-h/proton-mail-cli",
    }), {
      trusted: true,
      allowFreshLogin: true,
    });
  });

  it("allows owner pushes to refresh sessions", () => {
    assert.deepEqual(resolveLiveSecretPolicy({
      eventName: "push",
      actor: "hacker-h",
      repositoryOwner: "hacker-h",
    }), {
      trusted: true,
      allowFreshLogin: true,
    });
  });

  it("does not expose fresh-login secrets to untrusted pull requests", () => {
    assert.deepEqual(resolveLiveSecretPolicy({
      eventName: "pull_request",
      actor: "stranger",
      repositoryOwner: "hacker-h",
      repository: "hacker-h/proton-mail-cli",
      prHeadRepo: "stranger/proton-mail-cli",
      prUser: "stranger",
    }), {
      trusted: false,
      allowFreshLogin: false,
    });
  });

  it("allows same-repository Dependabot pull requests to use Dependabot-scoped secrets", () => {
    assert.deepEqual(resolveLiveSecretPolicy({
      eventName: "pull_request",
      actor: "dependabot[bot]",
      repositoryOwner: "hacker-h",
      repository: "hacker-h/proton-mail-cli",
      prHeadRepo: "hacker-h/proton-mail-cli",
      prUser: "dependabot[bot]",
    }), {
      trusted: true,
      allowFreshLogin: true,
    });
  });
});
