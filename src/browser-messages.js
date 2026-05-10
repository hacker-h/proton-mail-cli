import { getDebugEvents, ignoreWithDebug, recordDebugEvent, selectorDebugDetails } from "./browser-debug.js";
import { MESSAGE_ROW_SELECTOR, dismissModals } from "./browser-selectors.js";
import { resultWithError } from "./browser-session.js";
import { delay, normalizeText, truncate } from "./browser-utils.js";

/**
 * @typedef {import("playwright-core").Frame} Frame
 * @typedef {import("playwright-core").Page} Page
 * @typedef {{ index: number, preview: string }} MessagePreview
 * @typedef {{
 *   limit?: number,
 *   mailUrl: string,
 *   mailAllUrl: string,
 *   isInboxUrl: (url: string) => boolean,
 *   navigateToInbox: (page: Page, url?: string) => Promise<{ state: string, url?: string }>
 * }} ScanFallbackOptions
 * @typedef {string | RegExp | ((message: MessagePreview) => boolean)} MessageMatcher
 * @typedef {string | RegExp} ExtractionPattern
 * @typedef {{ matchText?: MessageMatcher, otpPattern?: RegExp, linkPattern?: RegExp }} OtpProviderPreset
 * @typedef {{ provider?: string, pattern?: ExtractionPattern, otpPattern?: ExtractionPattern, linkPattern?: ExtractionPattern, matchText?: MessageMatcher }} OtpExtractionOptions
 * @typedef {{ providerPreset: OtpProviderPreset | null, matchText?: MessageMatcher, otpPattern: RegExp, linkPattern?: RegExp }} ResolvedOtpExtractionOptions
 */

const OPENAI_MATCH_RE = /openai|noreply@openai\.com/i;
const OTP_RE = /\b(?<code>\d{6})\b/u;
const GITHUB_DEVICE_AUTH_RE = /\b(?<code>[A-Z0-9]{4}-[A-Z0-9]{4})\b/iu;
const MAGIC_LINK_RE = /(?<link>https?:\/\/[^\s"'<>]+)/iu;

/**
 * @deprecated Built-in OTP/link extraction is deprecated. Use mail read/list APIs and parse message bodies in user-owned automation. Removal is planned for the next major version.
 * @type {Readonly<Record<string, OtpProviderPreset>>}
 */
export const OTP_PROVIDER_PRESETS = Object.freeze({
  generic: Object.freeze({ otpPattern: OTP_RE }),
  github: Object.freeze({ matchText: /github|noreply@github\.com/i, otpPattern: GITHUB_DEVICE_AUTH_RE }),
  magicLink: Object.freeze({ linkPattern: MAGIC_LINK_RE }),
});

/** @type {Readonly<Record<string, string>>} */
const OTP_PROVIDER_ALIASES = Object.freeze({
  "generic-6-digit": "generic",
  "github-device-auth": "github",
  "magic-link": "magicLink",
  "magic-link-url": "magicLink",
  magiclink: "magicLink",
});

/**
 * @deprecated Built-in OTP/link extraction is deprecated. Use mail read/list APIs and parse message bodies in user-owned automation. Removal is planned for the next major version.
 * @param {unknown} text
 * @param {OtpExtractionOptions} [options]
 * @returns {string}
 */
export function extractOtpCode(text, options = {}) {
  return extractFirstOtpCode(text, options);
}

/**
 * @deprecated Built-in OTP/link extraction is deprecated. Use mail read/list APIs and parse message bodies in user-owned automation. Removal is planned for the next major version.
 * @param {unknown} text
 * @param {OtpExtractionOptions} [options]
 * @returns {string}
 */
export function extractFirstOtpCode(text, options = {}) {
  const extractionOptions = resolveOtpExtractionOptions(options);
  return extractFirstPatternValue(text, extractionOptions.otpPattern, ["code"]);
}

/**
 * @deprecated Built-in OTP/link extraction is deprecated. Use mail read/list APIs and parse message bodies in user-owned automation. Removal is planned for the next major version.
 * @param {unknown} text
 * @param {OtpExtractionOptions} [options]
 * @returns {string}
 */
export function extractFirstLink(text, options = {}) {
  const extractionOptions = resolveOtpExtractionOptions(options);
  const value = extractFirstPatternValue(text, extractionOptions.linkPattern || MAGIC_LINK_RE, ["link", "url"]);
  return trimTrailingUrlPunctuation(value);
}

/**
 * @param {unknown} preview
 * @returns {boolean}
 */
export function matchOpenAiEmail(preview) {
  return testPattern(OPENAI_MATCH_RE, String(preview || ""));
}

/**
 * @param {OtpExtractionOptions} [options]
 * @returns {ResolvedOtpExtractionOptions}
 */
export function resolveOtpExtractionOptions(options = {}) {
  const providerPreset = resolveProviderPreset(options.provider);
  /** @param {string} key */
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(options, key);
  const otpPatternInput = hasOwn("otpPattern")
    ? options.otpPattern
    : hasOwn("pattern")
      ? options.pattern
      : providerPreset?.otpPattern ?? OTP_RE;
  const linkPatternInput = hasOwn("linkPattern") ? options.linkPattern : providerPreset?.linkPattern;

  return {
    providerPreset,
    matchText: options.matchText ?? providerPreset?.matchText,
    otpPattern: normalizeExtractionPattern(otpPatternInput),
    linkPattern: linkPatternInput === undefined ? undefined : normalizeExtractionPattern(linkPatternInput),
  };
}

/**
 * @param {unknown} provider
 * @returns {OtpProviderPreset | null}
 */
function resolveProviderPreset(provider) {
  if (!provider) return null;
  const providerName = String(provider).trim();
  const presetName = OTP_PROVIDER_PRESETS[providerName]
    ? providerName
    : OTP_PROVIDER_ALIASES[providerName.toLowerCase()];
  if (!presetName || !OTP_PROVIDER_PRESETS[presetName]) {
    throw new Error(`Unknown OTP provider preset: ${providerName}`);
  }
  return OTP_PROVIDER_PRESETS[presetName];
}

/**
 * @param {unknown} pattern
 * @returns {RegExp}
 */
function normalizeExtractionPattern(pattern) {
  if (pattern instanceof RegExp) {
    return cloneStatelessRegExp(pattern);
  }
  if (typeof pattern === "string") {
    const trimmed = pattern.trim();
    if (!trimmed) {
      throw new Error("OTP extraction pattern must be a RegExp or non-empty string");
    }
    const literalMatch = /^\/([\s\S]+)\/([a-z]*)$/u.exec(trimmed);
    if (literalMatch) {
      const [, source, flags] = literalMatch;
      return new RegExp(source, normalizeExtractionFlags(flags));
    }
    return new RegExp(trimmed, "u");
  }
  throw new Error("OTP extraction pattern must be a RegExp or non-empty string");
}

/** @param {RegExp} pattern */
function cloneStatelessRegExp(pattern) {
  return new RegExp(pattern.source, normalizeExtractionFlags(pattern.flags));
}

/** @param {string} flags */
function normalizeExtractionFlags(flags) {
  /** @type {string[]} */
  const output = [];
  for (const flag of String(flags || "")) {
    if (!"dgimsuvy".includes(flag) || flag === "g" || flag === "y" || output.includes(flag)) continue;
    output.push(flag);
  }
  if (!output.includes("u") && !output.includes("v")) output.push("u");
  return output.join("");
}

/**
 * @param {unknown} text
 * @param {RegExp} pattern
 * @param {string[]} groupNames
 * @returns {string}
 */
function extractFirstPatternValue(text, pattern, groupNames) {
  const match = cloneStatelessRegExp(pattern).exec(String(text || ""));
  if (!match) return "";

  for (const groupName of groupNames) {
    const value = match.groups?.[groupName];
    if (value) return value;
  }

  for (let index = 1; index < match.length; index += 1) {
    if (match[index]) return match[index];
  }

  return match[0] || "";
}

/** @param {string} value */
function trimTrailingUrlPunctuation(value) {
  return String(value || "").replace(/[.,;:!?]+$/u, "");
}

/**
 * @param {RegExp} pattern
 * @param {string} value
 */
function testPattern(pattern, value) {
  return cloneStatelessRegExp(pattern).test(value);
}

/**
 * @param {Page} page
 * @param {number} [limit]
 * @returns {Promise<{ inboxMessageCount: number, messages: MessagePreview[], debugEvents: import("./browser-debug.js").DebugEvent[] }>}
 */
export async function scanInbox(page, limit = 50) {
  await page.waitForSelector('[data-testid="message-list-loaded"]', { timeout: 10000 }).catch((error) => {
    recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "messageListLoaded", selector: '[data-testid="message-list-loaded"]', timeout: 10000 }), error);
  });
  let rows = page.locator(MESSAGE_ROW_SELECTOR);
  let count = await rows.count();
  let previousCount = -1;
  let attempts = 0;
  while (count > 0 && count < limit && attempts < 10 && count !== previousCount) {
    previousCount = count;
    await rows.nth(count - 1).scrollIntoViewIfNeeded().catch((error) => {
      recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "messageRowScroll", selector: MESSAGE_ROW_SELECTOR }), error);
    });
    await delay(1000);
    rows = page.locator(MESSAGE_ROW_SELECTOR);
    count = await rows.count();
    attempts += 1;
  }

  const messages = [];
  for (let index = 0; index < Math.min(count, limit); index += 1) {
    try {
      messages.push({ index, preview: truncate(await rows.nth(index).innerText({ timeout: 1500 }), 240) });
    } catch (error) {
      recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "messagePreview", selector: MESSAGE_ROW_SELECTOR, timeout: 1500 }), error);
    }
  }
  return { inboxMessageCount: count, messages, debugEvents: getDebugEvents(page) };
}

/**
 * @param {Page} page
 * @param {ScanFallbackOptions} options
 * @returns {Promise<{ inboxMessageCount: number, messages: MessagePreview[], debugEvents: import("./browser-debug.js").DebugEvent[] }>}
 */
export async function scanInboxWithFallback(page, { limit = 50, mailUrl, mailAllUrl, isInboxUrl, navigateToInbox }) {
  const scan = await scanInbox(page, limit);
  if (scan.inboxMessageCount > 0 || mailUrl === mailAllUrl || !isInboxUrl(page.url())) {
    return scan;
  }

  recordDebugEvent(page, "message_scan.empty_inbox_fallback", { from: "inbox", to: "all-mail" });
  const navigation = await navigateToInbox(page, mailAllUrl);
  if (navigation.state !== "inbox") {
    return scan;
  }

  await dismissModals(page);
  return scanInbox(page, limit);
}

/**
 * @param {MessagePreview[]} messages
 * @param {MessageMatcher | undefined} matchText
 * @returns {MessagePreview | null}
 */
export function findMatchingMessage(messages, matchText) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  if (!matchText) {
    return messages[0];
  }
  for (const message of messages) {
    const preview = message.preview || "";
    if (typeof matchText === "string" && preview.includes(matchText)) {
      return message;
    }
    if (matchText instanceof RegExp && testPattern(matchText, preview)) {
      return message;
    }
    if (typeof matchText === "function" && matchText(message)) {
      return message;
    }
  }
  return null;
}

/**
 * @param {Page} page
 * @param {number} index
 * @returns {Promise<void>}
 */
export async function openMessage(page, index) {
  const locator = page.locator(MESSAGE_ROW_SELECTOR).nth(index);
  await locator.scrollIntoViewIfNeeded().catch((error) => {
    recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "messageRowScroll", selector: MESSAGE_ROW_SELECTOR }), error);
  });
  try {
    await locator.click({ timeout: 5000 });
  } catch (error) {
    recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "messageRowClick", selector: MESSAGE_ROW_SELECTOR, timeout: 5000 }), error);
    await locator.evaluate((/** @type {HTMLElement} */ node) => node.click()).catch(ignoreWithDebug(`DOM click failed for message row ${index}`));
  }
  try {
    await page.waitForSelector('[data-testid="content-iframe"]', { timeout: 10000 });
  } catch (error) {
    recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "messageContentIframe", selector: '[data-testid="content-iframe"]', timeout: 10000 }), error);
    throw error;
  }
}

/**
 * @param {Page} page
 * @param {string} fallbackPreview
 * @returns {Promise<{ success: false, [key: string]: unknown } | { success: true, subject: string, bodyText: string }>}
 */
export async function extractOpenedMessage(page, fallbackPreview) {
  const iframeHandle = await page.$('[data-testid="content-iframe"]');
  if (!iframeHandle) {
    recordDebugEvent(page, "selector.not_found", selectorDebugDetails({ area: "messageContentIframe", selector: '[data-testid="content-iframe"]' }));
    return resultWithError("Message content iframe was not found", { debugEvents: getDebugEvents(page) });
  }
  const frame = await iframeHandle.contentFrame();
  if (!frame) {
    recordDebugEvent(page, "selector.not_found", { area: "messageContentFrame" });
    return resultWithError("Message iframe content was unavailable", { debugEvents: getDebugEvents(page) });
  }
  await expandOriginalMessageIfNeeded(frame);
  const bodyText = await frame.innerText("body");
  return {
    success: true,
    subject: await getOpenedMessageSubject(page, fallbackPreview),
    bodyText,
  };
}

/**
 * @param {Page} page
 * @param {string} fallback
 * @returns {Promise<string>}
 */
async function getOpenedMessageSubject(page, fallback) {
  for (const candidate of [
    { description: { selector: '[data-testid*="subject"]' }, locator: page.locator('[data-testid*="subject"]').first() },
    { description: { selector: '[role="region"] h1' }, locator: page.locator('[role="region"] h1').first() },
    { description: { selector: "h1" }, locator: page.locator("h1").first() },
  ]) {
    try {
      const text = normalizeText(await candidate.locator.innerText({ timeout: 1000 }));
      if (text) {
        return text;
      }
    } catch (error) {
      recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "messageSubject", ...candidate.description, timeout: 1000 }), error);
    }
  }
  return truncate(fallback, 120);
}

/**
 * @param {Frame} frame
 * @returns {Promise<void>}
 */
async function expandOriginalMessageIfNeeded(frame) {
  const trigger = frame.locator('[data-testid="message-view:expand-codeblock"]').first();
  try {
    if (await trigger.isVisible({ timeout: 1000 })) {
      await trigger.click({ timeout: 3000 });
      await delay(1500);
    }
  } catch {
    // This affordance is optional; message extraction still works without it.
  }
}
