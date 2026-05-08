#!/usr/bin/env node

import { chromium } from "playwright";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: node scripts/probe-login-state.mjs [options]

Options:
  --headful             Run with a visible browser window
  --seconds <number>    Probe duration after submit (default: 20)
  --profile-dir <path>  Use a persistent browser profile
  --help, -h            Show this help

Environment:
  PROTONMAIL_USERNAME
  PROTONMAIL_PASSWORD
`);
  process.exit(0);
}

const username = process.env.PROTONMAIL_USERNAME || "";
const password = process.env.PROTONMAIL_PASSWORD || "";
if (!username || !password) {
  console.error("Missing PROTONMAIL_USERNAME or PROTONMAIL_PASSWORD");
  process.exit(1);
}

const headless = !args.includes("--headful");
const seconds = Number(getArg("--seconds") || 20);
const profileDir = getArg("--profile-dir");
const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

let browser;
let context;

try {
  if (profileDir) {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      userAgent,
    });
    browser = context.browser();
  } else {
    browser = await chromium.launch({ headless });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent });
  }

  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://mail.proton.me", { waitUntil: "domcontentloaded", timeout: 15000 });
  await report(page, "initial");

  const email = await firstVisible(page, [
    'input[id="email"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[autocomplete="username"]',
  ], 5000);
  if (!email) {
    await report(page, "email-field-missing");
    throw new ProbeStop(2);
  }
  await email.fill(username);

  const passwordField = await firstVisible(page, [
    'input[id="password"]',
    'input[name="password"]',
    'input[type="password"]',
    'input[autocomplete="current-password"]',
  ], 5000);
  if (!passwordField) {
    await report(page, "password-field-missing");
    throw new ProbeStop(2);
  }
  await passwordField.fill(password);

  const staySignedIn = await firstVisible(page, [
    'input[id="staySignedIn"]',
    'input[type="checkbox"]',
  ], 1000);
  if (staySignedIn) {
    const checked = await staySignedIn.isChecked().catch(() => true);
    if (!checked) {
      await staySignedIn.check({ force: true }).catch(() => {});
    }
  }

  const submit = await firstVisible(page, ['button[type="submit"]', 'button:has-text("Sign in")', 'button:has-text("Anmelden")'], 5000);
  if (!submit) {
    await report(page, "submit-missing");
    throw new ProbeStop(2);
  }

  await submit.click();
  for (let elapsed = 0; elapsed <= seconds; elapsed += 1) {
    await report(page, `after-submit-${elapsed}s`);
    await page.waitForTimeout(1000);
  }
} catch (error) {
  if (error instanceof ProbeStop) {
    process.exitCode = error.code;
  } else {
    throw error;
  }
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}

class ProbeStop extends Error {
  constructor(code) {
    super("Probe stopped");
    this.code = code;
  }
}

async function firstVisible(page, selectors, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible({ timeout: 100 })) {
          return locator;
        }
      } catch {
        continue;
      }
    }
    await page.waitForTimeout(100);
  }
  return null;
}

async function report(page, phase) {
  const state = await page.evaluate(() => {
    const visible = (selector) => Array.from(document.querySelectorAll(selector)).some((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    });
    const bodyText = document.body?.innerText || "";
    return {
      url: location.href,
      title: document.title,
      emailField: visible('input[type="email"], input[name="email"], input[autocomplete="username"]'),
      passwordField: visible('input[type="password"], input[name="password"], input[autocomplete="current-password"]'),
      submitButton: visible('button[type="submit"]'),
      spinner: visible('[aria-busy="true"], [role="progressbar"], .loader, .spinner, [class*="loading"]'),
      challengeFrame: Array.from(document.querySelectorAll("iframe")).some((frame) => /captcha|hcaptcha|recaptcha|arkoselabs/i.test(frame.src)),
      inboxHints: /Inbox|All Mail|Compose/i.test(bodyText),
      alerts: Array.from(document.querySelectorAll('[role="alert"]')).map((node) => node.textContent.trim()).filter(Boolean).slice(0, 3),
    };
  }).catch((error) => ({ error: error.message }));

  console.log(JSON.stringify({ phase, ...state }));
}

function getArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}
