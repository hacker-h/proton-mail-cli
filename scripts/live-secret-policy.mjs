#!/usr/bin/env node

/**
 * @typedef {{
 *   eventName?: string,
 *   actor?: string,
 *   repositoryOwner?: string,
 *   repository?: string,
 *   prHeadRepo?: string,
 *   prUser?: string,
 *   dispatchAllowFreshLogin?: string | boolean,
 * }} LiveSecretPolicyInput
 * @typedef {{ trusted: boolean, allowFreshLogin: boolean }} LiveSecretPolicy
 */

/**
 * @param {LiveSecretPolicyInput} input
 * @returns {LiveSecretPolicy}
 */
export function resolveLiveSecretPolicy(input) {
  const eventName = input.eventName || "";
  const actor = input.actor || "";
  const repositoryOwner = input.repositoryOwner || "";
  const repository = input.repository || "";
  const prHeadRepo = input.prHeadRepo || "";
  const prUser = input.prUser || "";
  const dispatchAllowFreshLogin = input.dispatchAllowFreshLogin === true || input.dispatchAllowFreshLogin === "1" || input.dispatchAllowFreshLogin === "true";

  let trusted = false;
  if (eventName === "schedule") {
    trusted = true;
  } else if (eventName === "push" || eventName === "workflow_dispatch") {
    trusted = actor === repositoryOwner;
  } else if (eventName === "pull_request") {
    trusted = prHeadRepo === repository && (
      actor === repositoryOwner ||
      actor === "dependabot[bot]" ||
      prUser === repositoryOwner ||
      prUser === "dependabot[bot]"
    );
  }

  const ownerDispatchedRefresh = eventName === "workflow_dispatch" && dispatchAllowFreshLogin && actor === repositoryOwner;
  return {
    trusted,
    allowFreshLogin: eventName === "schedule" ? false : eventName === "workflow_dispatch" ? ownerDispatchedRefresh : trusted,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const policy = resolveLiveSecretPolicy({
    eventName: process.env.EVENT_NAME,
    actor: process.env.ACTOR,
    repositoryOwner: process.env.REPOSITORY_OWNER,
    repository: process.env.REPOSITORY,
    prHeadRepo: process.env.PR_HEAD_REPO,
    prUser: process.env.PR_USER,
    dispatchAllowFreshLogin: process.env.DISPATCH_ALLOW_FRESH_LOGIN,
  });
  process.stdout.write(`trusted=${policy.trusted ? 1 : 0}\n`);
  process.stdout.write(`allow_fresh_login=${policy.allowFreshLogin ? 1 : 0}\n`);
}
