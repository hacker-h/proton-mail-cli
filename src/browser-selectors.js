import { debugLog, ignoreWithDebug, recordDebugEvent, selectorDebugDetails } from "./browser-debug.js";
import { delay, normalizeText } from "./browser-utils.js";

/**
 * @typedef {import("playwright-core").Frame} Frame
 * @typedef {import("playwright-core").Locator} Locator
 * @typedef {import("playwright-core").Page} Page
 * @typedef {{ selector?: string, role?: string, name?: string }} CandidateDescription
 * @typedef {{ description: CandidateDescription, locator: Locator }} LocatorCandidate
 */

export const MESSAGE_ROW_SELECTOR = '[data-testid*="message-item"]';

const AUTH_CHALLENGE_TEXT_RE = /\b(captcha|hcaptcha|human verification|verify that you are human|verify you are human|security check)\b/iu;

/**
 * @param {unknown} content
 * @returns {boolean}
 */
export function hasAuthChallengeText(content) {
  return AUTH_CHALLENGE_TEXT_RE.test(normalizeText(content));
}

/**
 * @param {Page} page
 * @returns {Promise<boolean>}
 */
export async function hasAuthChallenge(page) {
  const currentUrl = page.url();
  if (/\/(captcha|human-verification|security-check)(\/|$|[?#])/iu.test(currentUrl)) {
    recordDebugEvent(page, "auth.challenge.url", { urlState: "challenge" });
    return true;
  }

  if (page.frames().some((frame) => /hcaptcha|recaptcha|arkoselabs|captcha/iu.test(frame.url()))) {
    recordDebugEvent(page, "auth.challenge.frame", { frameUrlState: "challenge" });
    return true;
  }

  const challengeSelectors = [
    'iframe[src*="hcaptcha"]',
    'iframe[src*="recaptcha"]',
    '[data-testid*="captcha"]',
    '[data-testid*="challenge"]',
    '[class*="captcha"]',
    '[id*="captcha"]',
    '[class*="hcaptcha"]',
    '[id*="hcaptcha"]',
  ];

  for (const selector of challengeSelectors) {
    try {
      if (await page.locator(selector).first().isVisible({ timeout: 250 })) {
        recordDebugEvent(page, "selector.match", selectorDebugDetails({ area: "authChallenge", selector }));
        return true;
      }
    } catch (error) {
      recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "authChallenge", selector, timeout: 250 }), error);
    }
  }

  return hasAuthChallengeText(await getVisiblePageText(page));
}

/**
 * @param {Page} page
 * @returns {Promise<string>}
 */
export async function getVisiblePageText(page) {
  try {
    return await page.locator("body").innerText({ timeout: 1000 });
  } catch (error) {
    recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "visiblePageText", selector: "body", timeout: 1000 }), error);
    return "";
  }
}

/**
 * @param {Page} page
 * @returns {Promise<boolean>}
 */
export async function hasInboxIndicators(page) {
  for (const selector of [MESSAGE_ROW_SELECTOR, '[data-testid*="compose"]', '[data-testid*="navigation-link:inbox"]']) {
    try {
      if (await page.locator(selector).first().isVisible({ timeout: 1000 })) {
        recordDebugEvent(page, "selector.match", selectorDebugDetails({ area: "inboxIndicator", selector }));
        return true;
      }
    } catch (error) {
      recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "inboxIndicator", selector, timeout: 1000 }), error);
    }
  }
  return false;
}

/**
 * @param {Page} page
 * @param {number} [timeout]
 * @returns {Promise<Locator | null>}
 */
export async function locateLoginEmailField(page, timeout = 15000) {
  return firstVisibleCandidate(page, "loginEmail", [
    {
      description: { role: "textbox", name: "/email|e-mail|benutzername/i" },
      locator: page.getByRole("textbox", { name: /email|e-mail|benutzername/i }).first(),
    },
    {
      description: { selector: 'input[id="email"], input[name="email"], input[type="email"], input[autocomplete="username"]' },
      locator: page.locator('input[id="email"], input[name="email"], input[type="email"], input[autocomplete="username"]').first(),
    },
  ], timeout);
}

/**
 * @param {Page} page
 * @param {number} [timeout]
 * @returns {Promise<Locator | null>}
 */
export async function locateLoginPasswordField(page, timeout = 10000) {
  return firstVisibleCandidate(page, "loginPassword", [
    {
      description: { role: "textbox", name: "/password|passwort/i" },
      locator: page.getByRole("textbox", { name: /password|passwort/i }).first(),
    },
    {
      description: { selector: 'input[id="password"], input[name="password"], input[type="password"], input[autocomplete="current-password"]' },
      locator: page.locator('input[id="password"], input[name="password"], input[type="password"], input[autocomplete="current-password"]').first(),
    },
  ], timeout);
}

/**
 * @param {Page} page
 * @param {number} [timeout]
 * @returns {Promise<Locator | null>}
 */
export async function locateSignInButton(page, timeout = 10000) {
  return firstVisibleCandidate(page, "signInButton", [
    {
      description: { role: "button", name: "/sign in|anmelden/i" },
      locator: page.getByRole("button", { name: /sign in|anmelden/i }).first(),
    },
    {
      description: { selector: 'button[type="submit"], button:has-text("Sign in"), button:has-text("Anmelden")' },
      locator: page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Anmelden")').first(),
    },
  ], timeout);
}

/**
 * @param {Page} page
 * @param {number} [timeout]
 * @returns {Promise<Locator | null>}
 */
export async function locateProtonHomeLoginTarget(page, timeout = 5000) {
  return firstVisibleCandidate(page, "protonHomeLogin", [
    {
      description: { role: "link", name: "/sign in|log in|login|anmelden/i" },
      locator: page.getByRole("link", { name: /sign in|log in|login|anmelden/i }).first(),
    },
    {
      description: { role: "button", name: "/sign in|log in|login|anmelden/i" },
      locator: page.getByRole("button", { name: /sign in|log in|login|anmelden/i }).first(),
    },
    {
      description: { selector: 'a[href*="account.proton.me"], a[href*="/login"], a:has-text("Sign in"), a:has-text("Log in"), button:has-text("Sign in"), button:has-text("Log in")' },
      locator: page.locator('a[href*="account.proton.me"], a[href*="/login"], a:has-text("Sign in"), a:has-text("Log in"), button:has-text("Sign in"), button:has-text("Log in")').first(),
    },
  ], timeout);
}

/**
 * @param {Page} page
 * @returns {Promise<Locator | null>}
 */
export async function locateStaySignedInCheckbox(page) {
  const candidates = [
    {
      description: { role: "checkbox", name: "/keep me signed in|angemeldet bleiben/i" },
      locator: page.getByRole("checkbox", { name: /keep me signed in|angemeldet bleiben/i }).first(),
    },
    {
      description: { selector: 'input[id="staySignedIn"], label:has-text("Keep me signed in") input[type="checkbox"]' },
      locator: page.locator('input[id="staySignedIn"], label:has-text("Keep me signed in") input[type="checkbox"]').first(),
    },
  ];
  for (const candidate of candidates) {
    try {
      if (await candidate.locator.isVisible({ timeout: 1000 })) {
        recordDebugEvent(page, "selector.match", selectorDebugDetails({ area: "staySignedIn", ...candidate.description }));
        return candidate.locator;
      }
    } catch (error) {
      recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "staySignedIn", ...candidate.description, timeout: 1000 }), error);
    }
  }
  return null;
}

/**
 * @param {Page} page
 * @param {number} timeoutMs
 * @returns {Promise<{ state: string, url: string }>}
 */
export async function waitForInboxOrLogin(page, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const currentUrl = page.url();
    if (/\/two-factor|\/totp/i.test(currentUrl)) {
      return { state: "twoFactor", url: currentUrl };
    }
    if (await hasInboxIndicators(page)) {
      return { state: "inbox", url: currentUrl };
    }
    if (currentUrl.includes("account.proton.me")) {
      if (await hasAuthChallenge(page)) {
        return { state: "captcha", url: currentUrl };
      }
      if (await locateLoginEmailField(page, 500)) {
        return { state: "login", url: currentUrl };
      }
    }
    await delay(500);
  }
  recordDebugEvent(page, "navigation.timeout", { timeoutMs, urlState: classifyUrl(page.url()) });
  return { state: "unknown", url: page.url() };
}

/**
 * @param {Page} page
 * @returns {Promise<string[]>}
 */
export async function getAlertTexts(page) {
  const alerts = page.locator('[role="alert"]');
  const count = await alerts.count();
  const texts = [];
  for (let index = 0; index < count; index += 1) {
    try {
      const text = normalizeText(await alerts.nth(index).innerText({ timeout: 1000 }));
      if (text) {
        texts.push(text);
      }
    } catch (error) {
      recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "alertText", selector: '[role="alert"]', timeout: 1000 }), error);
    }
  }
  return texts;
}

/**
 * @param {Page} page
 * @returns {Promise<boolean>}
 */
export async function dismissModals(page) {
  const modalSelector = '[data-testid*="modal"], [role="dialog"], .modal, .modal-two';
  let dismissed = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await page.locator(modalSelector).count())) {
      return dismissed;
    }

    const clicked = await page.evaluate((selector) => {
      const dialogs = Array.from(document.querySelectorAll(selector));
      for (const dialog of dialogs) {
        for (const node of Array.from(dialog.querySelectorAll('button, [role="button"], [aria-label]'))) {
          const text = String(node.textContent || node.getAttribute("aria-label") || "").toLowerCase().trim();
          if (!text) continue;
          if (["close", "dismiss", "not now", "later", "cancel", "schließen", "später", "got it", "accept"].some((term) => text.includes(term))) {
            if ("click" in node && typeof node.click === "function") {
              node.click();
              return true;
            }
          }
        }
      }
      return false;
    }, modalSelector).catch(ignoreWithDebug("Failed to evaluate modal dismissal", false));

    if (!clicked) {
      await page.keyboard.press("Escape").catch(ignoreWithDebug("Failed to dismiss modal with Escape"));
    }
    dismissed = true;
    await delay(400);
  }
  return dismissed;
}

/**
 * @param {Page} page
 * @returns {Promise<boolean>}
 */
export async function completeAppsPageIfNeeded(page) {
  if (!page.url().includes("account.proton.me/apps")) {
    return false;
  }
  const candidates = [
    { description: { selector: '[data-testid="explore-mail"]' }, locator: page.locator('[data-testid="explore-mail"]').first() },
    { description: { role: "button", name: "/mail/i" }, locator: page.getByRole("button", { name: /mail/i }).first() },
    { description: { role: "link", name: "/mail/i" }, locator: page.getByRole("link", { name: /mail/i }).first() },
  ];
  for (const target of candidates) {
    try {
      if (await target.locator.isVisible({ timeout: 1000 })) {
        await target.locator.click({ timeout: 5000 });
        recordDebugEvent(page, "selector.match", selectorDebugDetails({ area: "appsMailTarget", ...target.description }));
        return true;
      }
    } catch (error) {
      recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area: "appsMailTarget", ...target.description, timeout: 1000 }), error);
    }
  }
  return false;
}

/**
 * @param {Page} page
 * @returns {Promise<string>}
 */
export async function getPageContent(page) {
  try {
    return await page.content();
  } catch (error) {
    debugLog("Failed to read page content", error);
    return "";
  }
}

/**
 * @param {Page} page
 * @param {string} area
 * @param {LocatorCandidate[]} candidates
 * @param {number} timeout
 * @returns {Promise<Locator | null>}
 */
async function firstVisibleCandidate(page, area, candidates, timeout) {
  for (const candidate of candidates) {
    try {
      await candidate.locator.waitFor({ state: "visible", timeout });
      recordDebugEvent(page, "selector.match", selectorDebugDetails({ area, ...candidate.description, timeout }));
      return candidate.locator;
    } catch (error) {
      recordDebugEvent(page, "selector.failure", selectorDebugDetails({ area, ...candidate.description, state: "visible", timeout }), error);
    }
  }
  recordDebugEvent(page, "selector.not_found", { area, attempts: candidates.map((candidate) => selectorDebugDetails({ area, ...candidate.description, state: "visible", timeout })) });
  return null;
}

/**
 * @param {unknown} url
 * @returns {string}
 */
function classifyUrl(url) {
  const text = String(url || "");
  if (text.includes("account.proton.me")) return "account";
  if (text.includes("mail.proton.me")) return "mail";
  if (text === "about:blank") return "blank";
  return "other";
}
