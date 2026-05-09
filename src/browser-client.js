import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveDebugConfig } from "./debug-config.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DEFAULT_SESSION_FILE = path.join(DATA_DIR, "protonmail-auth.json");
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const INBOX_URL = "https://mail.proton.me/u/0/inbox";
export const MAIL_ALL_URL = "https://mail.proton.me/u/0/all-mail";
const MAIL_HOME_URL = "https://mail.proton.me";
const OTP_RE = /\b(\d{6})\b/;
const AUTH_CHALLENGE_TEXT_RE = /\b(captcha|hcaptcha|human verification|verify that you are human|verify you are human|security check)\b/iu;
const MESSAGE_ROW_SELECTOR = '[data-testid*="message-item"]';
const POLL_INTERVAL_MS = 5000;
const LOGIN_COOLDOWN_MS = 5 * 60 * 1000;
const PRIVATE_FILE_MODE = 0o600;

/**
 * @typedef {import("playwright-core").Browser} Browser
 * @typedef {import("playwright-core").BrowserContext} BrowserContext
 * @typedef {import("playwright-core").Page} Page
 * @typedef {import("playwright-core").Frame} Frame
 * @typedef {import("playwright-core").BrowserType} BrowserFactory
 * @typedef {NonNullable<import("playwright-core").BrowserContextOptions["storageState"]>} StorageState
 * @typedef {import("./debug-config.js").DebugConfig} DebugConfig
 * @typedef {{ index: number, preview: string }} MessagePreview
 * @typedef {{ success: false, error: string, [key: string]: unknown }} ErrorResult
 * @typedef {{ success: true, loginMethod?: string, sessionValid?: boolean, sessionFileExists?: boolean }} LoginSuccess
 * @typedef {ErrorResult | LoginSuccess} LoginResult
 * @typedef {{ success: true, subject: string, bodyText: string }} ExtractedMessage
 * @typedef {ErrorResult | ExtractedMessage} ExtractMessageResult
 * @typedef {{ browser?: Browser | null, context?: BrowserContext | null, page?: Page | null, debug?: { cdpEndpoint: string } }} SessionHandles
 * @typedef {{ browser: Browser | null, context: BrowserContext, page: Page, debug?: { cdpEndpoint: string }, success: true }} SessionSuccess
 * @typedef {ErrorResult | SessionSuccess} SessionResult
 * @typedef {{ success: true, sessionValid: true, message: { index: number, preview: string, subject: string, bodyText: string } }} LatestMessageSuccess
 * @typedef {ErrorResult | LatestMessageSuccess} LatestMessageResult
 * @typedef {{
 *   headless?: boolean,
 *   timeoutSeconds?: number,
 *   manualLoginTimeoutSeconds?: number,
 *   sessionFile?: string,
 *   envFile?: string,
 *   usernameEnv?: string,
 *   passwordEnv?: string,
 *   userAgent?: string,
 *   viewport?: { width: number, height: number },
 *   browserFactory?: BrowserFactory,
 *   debug?: boolean | Partial<import("./debug-config.js").EnabledDebugConfig>
 * }} BrowserClientOptions
 * @typedef {BrowserClientOptions & {
 *   manualFallback?: boolean,
 *   manualTimeoutSeconds?: number,
 *   mailUrl?: string,
 *   folder?: string,
 *   limit?: number,
 *   matchText?: string | RegExp | ((message: MessagePreview) => boolean)
 * }} BrowserActionOptions
 */

export class ProtonMailBrowserClient {
  #options;
  #envLoaded = false;

  /** @param {BrowserClientOptions} [options] */
  constructor(options = {}) {
    this.#options = {
      headless: Boolean(options.headless),
      timeoutSeconds: parsePositiveInt(options.timeoutSeconds, 90),
      manualLoginTimeoutSeconds: parsePositiveInt(options.manualLoginTimeoutSeconds, 300),
      sessionFile: normalizePath(options.sessionFile) || DEFAULT_SESSION_FILE,
      envFile: normalizeAbsolutePath(options.envFile || process.env.PROTONMAIL_ENV_FILE || ""),
      usernameEnv: options.usernameEnv || "PROTONMAIL_USERNAME",
      passwordEnv: options.passwordEnv || "PROTONMAIL_PASSWORD",
      userAgent: options.userAgent || DEFAULT_USER_AGENT,
      viewport: options.viewport || DEFAULT_VIEWPORT,
      browserFactory: options.browserFactory || chromium,
      debug: resolveDebugConfig(options, process.env),
    };
  }

  get sessionFile() {
    return this.#options.sessionFile;
  }

  loadRuntimeEnv() {
    if (this.#envLoaded) {
      return { loaded: false, file: "" };
    }

    const candidates = [
      this.#options.envFile,
      path.join(ROOT_DIR, "env.env"),
      path.join(ROOT_DIR, ".env"),
    ].filter(Boolean);

    for (const filePath of candidates) {
      const loaded = loadEnvFile(filePath);
      if (loaded) {
        this.#envLoaded = true;
        return { loaded: true, file: filePath };
      }
    }

    this.#envLoaded = true;
    return { loaded: false, file: "" };
  }

  /** @param {BrowserActionOptions} [options] */
  async loginAndSaveSession(options = {}) {
    this.loadRuntimeEnv();
    const mailUrl = resolveMailUrl(options);
    const settings = {
      headless: options.headless ?? this.#options.headless,
      manualFallback: options.manualFallback !== false,
      timeoutSeconds: parsePositiveInt(options.timeoutSeconds, this.#options.manualLoginTimeoutSeconds),
    };
    const storage = loadStorageState(this.#options.sessionFile);
    const credentials = this.#loadCredentials();

    let browser;
    let context;
    let page;

    const debug = this.#options.debug;
    const keepOpenOnError = Boolean(debug?.enabled && debug.keepOpenOnError);

    try {
      ({ browser, context, page } = await this.#launch({
        headless: settings.headless,
        storageState: storage.storageState,
        debug: this.#options.debug,
      }));

      const navigation = await navigateToInbox(page, mailUrl);
      if (navigation.state === "inbox") {
        await dismissModals(page);
        await saveSession(context, this.#options.sessionFile);
        clearCooldown(this.#options.sessionFile);
        return resultWithSession({
          success: true,
          loginMethod: "session",
          sessionValid: true,
          sessionFileExists: storage.exists,
        }, { browser, context, page, debug });
      }

      if (!credentials.ready) {
        return resultWithSession(resultWithError("Missing Proton Mail credentials", {
          envFileLoaded: this.#options.envFile || null,
        }), { browser, context, page, debug });
      }

      const automatic = await performLogin({
        page,
        context,
        username: credentials.username,
        password: credentials.password,
        sessionFile: this.#options.sessionFile,
        suppressCooldown: Boolean(this.#options.debug?.enabled && this.#options.debug.suppressCooldown),
      });
      if (automatic.success) {
        const targetNavigation = await navigateToInbox(page, mailUrl);
        if (targetNavigation.state !== "inbox") {
          return resultWithSession(
            resultWithError("Automatic login completed but target mail folder was not reachable"),
            { browser, context, page, debug }
          );
        }
        return resultWithSession({
          success: true,
          loginMethod: automatic.loginMethod || "automatic",
          sessionValid: true,
          sessionFileExists: storage.exists,
        }, { browser, context, page, debug });
      }

      if (!settings.manualFallback || settings.headless || automatic.manualRequired === false) {
        return resultWithSession(automatic, { browser, context, page, debug });
      }

      const manualResult = await waitForManualLoginCompletion({
        page,
        context,
        mailUrl,
        sessionFile: this.#options.sessionFile,
        timeoutSeconds: settings.timeoutSeconds,
      });
      return resultWithSession(manualResult, { browser, context, page, debug });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (keepOpenOnError) {
        return resultWithSession(
          resultWithError(message || "Unexpected Proton Mail login failure"),
          { browser, context, page, debug }
        );
      }
      return resultWithError(message || "Unexpected Proton Mail login failure");
    } finally {
      if (!(this.#options.debug.enabled ? this.#options.debug.keepOpenOnError : false)) {
        await context?.close().catch(ignoreWithDebug("Failed to close browser context"));
        await browser?.close().catch(ignoreWithDebug("Failed to close browser"));
      }
    }
  }

  /** @param {BrowserActionOptions} [options] */
  async getInboxMessages(options = {}) {
    this.loadRuntimeEnv();
    const session = await this.#ensureLoggedIn(options);
    if (!session.success) {
      return session;
    }

    const { browser, context, page } = session;
    try {
      await dismissModals(page);
      const scan = await scanInboxWithFallback(page, options.limit || 50, resolveMailUrl(options));
      return {
        success: true,
        sessionValid: true,
        inboxMessageCount: scan.inboxMessageCount,
        messages: scan.messages,
      };
    } finally {
      await context.close().catch(ignoreWithDebug("Failed to close browser context"));
      await browser?.close().catch(ignoreWithDebug("Failed to close browser"));
    }
  }

  /**
   * @param {BrowserActionOptions} [options]
   * @returns {Promise<LatestMessageResult>}
   */
  async getLatestMessage(options = {}) {
    this.loadRuntimeEnv();
    const session = await this.#ensureLoggedIn(options);
    if (!session.success) {
      return session;
    }

    const { browser, context, page } = session;
    try {
      await dismissModals(page);
      const scan = await scanInboxWithFallback(page, options.limit || 50, resolveMailUrl(options));
      const target = findMatchingMessage(scan.messages, options.matchText);
      if (!target) {
        return resultWithError("No matching Proton Mail message found", {
          inboxMessageCount: scan.inboxMessageCount,
        });
      }

      await openMessage(page, target.index);
      const extracted = await extractOpenedMessage(page, target.preview);
      if (!extracted.success) {
        return extracted;
      }

      return {
        success: true,
        sessionValid: true,
        message: {
          index: target.index,
          preview: target.preview,
          subject: extracted.subject,
          bodyText: extracted.bodyText,
        },
      };
    } finally {
      await context.close().catch(ignoreWithDebug("Failed to close browser context"));
      await browser?.close().catch(ignoreWithDebug("Failed to close browser"));
    }
  }

  /** @param {BrowserActionOptions} [options] */
  async extractOtpCode(options = {}) {
    const matchText = options.matchText || /openai|noreply@openai\.com/i;
    const result = await this.getLatestMessage({ ...options, matchText });
    if (!result.success) {
      return result;
    }

    const code = extractFirstOtpCode(result.message.bodyText);
    if (!code) {
      return resultWithError("Matching email found, but no 6-digit code was present", {
        message: result.message,
      });
    }

    return {
      success: true,
      sessionValid: true,
      code,
      message: result.message,
    };
  }

  /** @param {BrowserActionOptions} [options] */
  async debugLogin(options = {}) {
    const client = new ProtonMailBrowserClient({
      sessionFile: this.#options.sessionFile,
      envFile: this.#options.envFile,
      usernameEnv: this.#options.usernameEnv,
      passwordEnv: this.#options.passwordEnv,
      userAgent: this.#options.userAgent,
      viewport: this.#options.viewport,
      browserFactory: this.#options.browserFactory,
      manualLoginTimeoutSeconds: options.manualTimeoutSeconds || this.#options.manualLoginTimeoutSeconds,
      ...options,
      debug: options.debug !== false ? (options.debug || true) : false,
    });
    return client.loginAndSaveSession({ manualFallback: true });
  }

  /**
   * @param {BrowserActionOptions} [options]
   * @returns {Promise<SessionResult>}
   */
  async #ensureLoggedIn(options = {}) {
    const headless = options.headless ?? this.#options.headless;
    const mailUrl = resolveMailUrl(options);
    const storage = loadStorageState(this.#options.sessionFile);
    const debug = this.#options.debug;
    const keepOpenOnError = Boolean(debug?.enabled && debug.keepOpenOnError);
    let browser;
    let context;
    let page;

    try {
      ({ browser, context, page } = await this.#launch({
        headless,
        storageState: storage.storageState,
        debug,
      }));

      let navigation = await navigateToInbox(page, mailUrl);
      if (navigation.state === "inbox") {
        return successfulSessionResult({ browser, context, page, debug });
      }

      const cooldown = getCooldownState(this.#options.sessionFile);
      if (cooldown.active) {
        if (keepOpenOnError) {
          return resultWithSession(resultWithError("Login cooldown active; restore the session before retrying", { cooldown: true }), {
            browser,
            context,
            page,
            debug,
          });
        }
        await context.close().catch(ignoreWithDebug("Failed to close browser context"));
        await browser?.close().catch(ignoreWithDebug("Failed to close browser"));
        return resultWithError("Login cooldown active; restore the session before retrying", { cooldown: true });
      }

      const credentials = this.#loadCredentials();
      if (!credentials.ready) {
        if (keepOpenOnError) {
          return resultWithSession(resultWithError("Missing Proton Mail credentials"), { browser, context, page, debug });
        }
        await context.close().catch(ignoreWithDebug("Failed to close browser context"));
        await browser?.close().catch(ignoreWithDebug("Failed to close browser"));
        return resultWithError("Missing Proton Mail credentials");
      }

      const automatic = await performLogin({
        page,
        context,
        username: credentials.username,
        password: credentials.password,
        sessionFile: this.#options.sessionFile,
        suppressCooldown: Boolean(debug?.enabled && debug.suppressCooldown),
      });
      if (!automatic.success) {
        if (keepOpenOnError) {
          return resultWithSession(automatic, { browser, context, page, debug });
        }
        await context.close().catch(ignoreWithDebug("Failed to close browser context"));
        await browser?.close().catch(ignoreWithDebug("Failed to close browser"));
        return automatic;
      }

      navigation = await navigateToInbox(page, mailUrl);
      if (navigation.state !== "inbox") {
        if (keepOpenOnError) {
          return resultWithSession(resultWithError("Automatic login completed but target mail folder was not reachable"), {
            browser,
            context,
            page,
            debug,
          });
        }
        await context.close().catch(ignoreWithDebug("Failed to close browser context"));
        await browser?.close().catch(ignoreWithDebug("Failed to close browser"));
        return resultWithError("Automatic login completed but target mail folder was not reachable");
      }

      return successfulSessionResult({ browser, context, page, debug });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (keepOpenOnError) {
        return resultWithSession(resultWithError(message || "Unexpected Proton Mail browser failure"), {
          browser,
          context,
          page,
          debug,
        });
      }
      await context?.close().catch(ignoreWithDebug("Failed to close browser context"));
      await browser?.close().catch(ignoreWithDebug("Failed to close browser"));
      return resultWithError(message || "Unexpected Proton Mail browser failure");
    }
  }

  #loadCredentials() {
    const username = env(this.#options.usernameEnv);
    const password = env(this.#options.passwordEnv);
    return { username, password, ready: Boolean(username && password) };
  }

  /**
   * @param {{ headless?: boolean, storageState?: StorageState | null, debug?: DebugConfig }} options
   */
  async #launch({ headless, storageState, debug = { enabled: false } }) {
    const launchArgs = ["--disable-blink-features=AutomationControlled"];

    if (!debug?.enabled) {
      const browser = await this.#options.browserFactory.launch({
        headless: Boolean(headless),
        args: launchArgs,
      });
      const context = await browser.newContext({
        userAgent: this.#options.userAgent,
        viewport: this.#options.viewport,
        storageState: storageState || undefined,
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          configurable: true,
          get: () => undefined,
        });
      });
      const page = await context.newPage();
      return { browser, context, page };
    }

    ensurePrivateDir(debug.profileDir);
    const persistentArgs = [...launchArgs, `--remote-debugging-port=${debug.cdpPort}`];
    /** @type {NonNullable<Parameters<BrowserFactory["launchPersistentContext"]>[1]>} */
    const persistentOptions = {
      headless: false,
      args: persistentArgs,
      userAgent: this.#options.userAgent,
      viewport: this.#options.viewport,
    };
    if (debug.slowMo > 0) {
      persistentOptions.slowMo = debug.slowMo;
    }
    if (debug.executablePath) {
      persistentOptions.executablePath = debug.executablePath;
    }

    const context = await this.#options.browserFactory.launchPersistentContext(debug.profileDir, persistentOptions);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        configurable: true,
        get: () => undefined,
      });
    });

    const browser = context.browser();

    console.log(`[protonmail-debug] cdp=http://127.0.0.1:${debug.cdpPort} profile=${debug.profileDir}`);

    const page = context.pages()[0] || (await context.newPage());
    return { browser, context, page };
  }
}

/** @param {unknown} text */
export function extractFirstOtpCode(text) {
  return String(text || "").match(OTP_RE)?.[1] || "";
}

/** @param {unknown} preview */
export function matchOpenAiEmail(preview) {
  return /openai|noreply@openai\.com/i.test(String(preview || ""));
}

export function defaultSessionFile() {
  return DEFAULT_SESSION_FILE;
}

/**
 * @param {string} message
 * @param {unknown} error
 * @param {Record<string, string | undefined>} [envObject]
 */
function debugLog(message, error, envObject = process.env) {
  if (!isDebugLoggingEnabled(envObject)) {
    return;
  }
  const suffix = error instanceof Error && error.message ? `: ${error.message}` : "";
  console.warn(`[protonmail-debug] ${message}${suffix}`);
}

/** @param {Record<string, string | undefined>} [envObject] */
function isDebugLoggingEnabled(envObject = process.env) {
  return envObject.PROTONMAIL_DEBUG === "1" || envObject.PROTONMAIL_DEBUG === "true";
}

/**
 * @template T
 * @param {string} message
 * @param {T} [fallback]
 * @returns {(error: unknown) => T | undefined}
 */
function ignoreWithDebug(message, fallback) {
  return (error) => {
    debugLog(message, error);
    return fallback;
  };
}

/**
 * @param {string} name
 * @param {string} [fallback]
 */
function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** @param {unknown} filePath */
function normalizePath(filePath) {
  return filePath ? path.resolve(String(filePath)) : "";
}

/** @param {unknown} filePath */
function normalizeAbsolutePath(filePath) {
  if (!filePath) {
    return "";
  }
  const candidate = String(filePath).trim();
  return path.isAbsolute(candidate) ? path.resolve(candidate) : "";
}

/** @param {string} dirPath */
function ensureDir(dirPath) {
  if (!dirPath) {
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

/** @param {string} dirPath */
function ensurePrivateDir(dirPath) {
  ensureDir(dirPath);
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch (error) {
    debugLog(`Failed to set private directory permissions for ${dirPath}`, error);
  }
}

/** @param {string} filePath */
function loadEnvFile(filePath) {
  const trustedPath = normalizeAbsolutePath(filePath);
  if (!trustedPath || !fs.existsSync(trustedPath)) {
    return false;
  }
  const lines = fs.readFileSync(trustedPath, "utf8").split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    if (!key || process.env[key]) {
      continue;
    }
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}

/** @param {string} sessionFile */
function loadStorageState(sessionFile) {
  if (!fs.existsSync(sessionFile)) {
    return { exists: false, storageState: null, error: null };
  }
  try {
    return {
      exists: true,
      storageState: JSON.parse(fs.readFileSync(sessionFile, "utf8")),
      error: null,
    };
  } catch (error) {
    return {
      exists: true,
      storageState: null,
      error: error instanceof Error ? error.message : "Session file unreadable",
    };
  }
}

/** @param {string} sessionFile */
function cooldownFile(sessionFile) {
  return path.join(path.dirname(sessionFile), "protonmail-login-cooldown.json");
}

/** @param {string} sessionFile */
function getCooldownState(sessionFile) {
  const filePath = cooldownFile(sessionFile);
  if (!fs.existsSync(filePath)) {
    return { active: false };
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const lastFailedAt = data?.lastFailedAt ? Date.parse(data.lastFailedAt) : Number.NaN;
    if (!Number.isFinite(lastFailedAt)) {
      return { active: false };
    }
    return { active: Date.now() - lastFailedAt < LOGIN_COOLDOWN_MS };
  } catch (error) {
    debugLog(`Failed to read login cooldown file ${filePath}`, error);
    return { active: false };
  }
}

/**
 * @param {string} sessionFile
 * @param {string} reason
 */
function writeCooldown(sessionFile, reason) {
  const filePath = cooldownFile(sessionFile);
  writePrivateJsonFile(filePath, { lastFailedAt: new Date().toISOString(), reason });
}

/** @param {string} sessionFile */
function clearCooldown(sessionFile) {
  const filePath = cooldownFile(sessionFile);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * @param {string} error
 * @param {Record<string, unknown>} [extra]
 * @returns {ErrorResult}
 */
function resultWithError(error, extra = {}) {
  return { success: false, error, ...extra };
}

/**
 * @template {Record<string, unknown>} T
 * @param {T} result
 * @param {{ browser?: Browser | null, context?: BrowserContext | null, page?: Page | null, debug?: DebugConfig }} handles
 * @returns {T & SessionHandles}
 */
function resultWithSession(result, { browser, context, page, debug }) {
  if (!debug?.enabled) {
    return { ...result, browser, context, page };
  }
  return {
    ...result,
    browser,
    context,
    page,
    debug: { cdpEndpoint: `http://127.0.0.1:${debug.cdpPort}` },
  };
}

/**
 * @param {{ browser: Browser | null, context: BrowserContext, page: Page, debug?: DebugConfig }} handles
 * @returns {SessionSuccess}
 */
function successfulSessionResult({ browser, context, page, debug }) {
  if (!debug?.enabled) {
    return { success: true, browser, context, page };
  }
  return {
    success: true,
    browser,
    context,
    page,
    debug: { cdpEndpoint: `http://127.0.0.1:${debug.cdpPort}` },
  };
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {unknown} value */
function normalizeText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

/**
 * @param {unknown} value
 * @param {number} [max]
 */
function truncate(value, max = 200) {
  const text = normalizeText(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** @param {Page} page */
async function hasAuthChallenge(page) {
  const currentUrl = page.url();
  if (/\/(captcha|human-verification|security-check)(\/|$|[?#])/iu.test(currentUrl)) {
    return true;
  }

  if (page.frames().some((frame) => /hcaptcha|recaptcha|arkoselabs|captcha/iu.test(frame.url()))) {
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
        return true;
      }
    } catch (error) {
      debugLog(`Auth challenge selector check failed for ${selector}`, error);
    }
  }

  return hasAuthChallengeText(await getVisiblePageText(page));
}

/** @param {unknown} content */
function hasAuthChallengeText(content) {
  return AUTH_CHALLENGE_TEXT_RE.test(normalizeText(content));
}

/** @param {Page} page */
async function getVisiblePageText(page) {
  try {
    return await page.locator("body").innerText({ timeout: 1000 });
  } catch (error) {
    debugLog("Failed to read visible page text", error);
    return "";
  }
}

/**
 * @param {Pick<BrowserContext, "storageState">} context
 * @param {string} sessionFile
 */
async function saveSession(context, sessionFile) {
  const storageState = await context.storageState();
  writePrivateJsonFile(sessionFile, storageState);
}

/**
 * @param {string} filePath
 * @param {unknown} value
 */
function writePrivateJsonFile(filePath, value) {
  ensurePrivateDir(path.dirname(filePath));
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (cleanupError) {
      debugLog(`Failed to remove temporary private JSON file ${tempFile}`, cleanupError);
    }
    throw error;
  }
}

/** @param {{ mailUrl?: string, folder?: string }} [options] */
function resolveMailUrl(options = {}) {
  const explicitMailUrl = typeof options.mailUrl === "string" ? options.mailUrl.trim() : "";
  if (explicitMailUrl) {
    return explicitMailUrl;
  }
  const folder = String(options.folder || "").trim().toLowerCase();
  if (folder === "all" || folder === "all-mail") {
    return MAIL_ALL_URL;
  }
  return INBOX_URL;
}

/** @param {unknown} url */
function isInboxUrl(url) {
  return String(url || "").includes("/inbox");
}

/**
 * @param {Page} page
 * @param {string} [url]
 */
async function navigateToInbox(page, url = INBOX_URL) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  return waitForInboxOrLogin(page, 15000);
}

/** @param {Page} page */
async function hasInboxIndicators(page) {
  for (const selector of [MESSAGE_ROW_SELECTOR, '[data-testid*="compose"]', '[data-testid*="navigation-link:inbox"]']) {
    try {
      if (await page.locator(selector).first().isVisible({ timeout: 1000 })) {
        return true;
      }
    } catch (error) {
      debugLog(`Inbox indicator selector check failed for ${selector}`, error);
    }
  }
  return false;
}

/** @param {Page} page */
async function getPageContent(page) {
  try {
    return await page.content();
  } catch (error) {
    debugLog("Failed to read page content", error);
    return "";
  }
}

/**
 * @param {Page} page
 * @param {number} [timeout]
 */
async function locateLoginEmailField(page, timeout = 15000) {
  const candidates = [
    page.getByRole("textbox", { name: /email|e-mail|benutzername/i }).first(),
    page.locator('input[id="email"], input[name="email"], input[type="email"], input[autocomplete="username"]').first(),
  ];
  for (const candidate of candidates) {
    try {
      await candidate.waitFor({ state: "visible", timeout });
      return candidate;
    } catch (error) {
      debugLog("Login email field candidate did not become visible", error);
    }
  }
  return null;
}

/**
 * @param {Page} page
 * @param {number} [timeout]
 */
async function locateLoginPasswordField(page, timeout = 10000) {
  const candidates = [
    page.getByRole("textbox", { name: /password|passwort/i }).first(),
    page.locator('input[id="password"], input[name="password"], input[type="password"], input[autocomplete="current-password"]').first(),
  ];
  for (const candidate of candidates) {
    try {
      await candidate.waitFor({ state: "visible", timeout });
      return candidate;
    } catch (error) {
      debugLog("Login password field candidate did not become visible", error);
    }
  }
  return null;
}

/**
 * @param {Page} page
 * @param {number} [timeout]
 */
async function locateSignInButton(page, timeout = 10000) {
  const candidates = [
    page.getByRole("button", { name: /sign in|anmelden/i }).first(),
    page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Anmelden")').first(),
  ];
  for (const candidate of candidates) {
    try {
      await candidate.waitFor({ state: "visible", timeout });
      return candidate;
    } catch (error) {
      debugLog("Sign-in button candidate did not become visible", error);
    }
  }
  return null;
}

/** @param {Page} page */
async function locateStaySignedInCheckbox(page) {
  const candidates = [
    page.getByRole("checkbox", { name: /keep me signed in|angemeldet bleiben/i }).first(),
    page.locator('input[id="staySignedIn"], label:has-text("Keep me signed in") input[type="checkbox"]').first(),
  ];
  for (const candidate of candidates) {
    try {
      if (await candidate.isVisible({ timeout: 1000 })) {
        return candidate;
      }
    } catch (error) {
      debugLog("Stay-signed-in checkbox candidate check failed", error);
    }
  }
  return null;
}

/**
 * @param {Page} page
 * @param {number} timeoutMs
 */
async function waitForInboxOrLogin(page, timeoutMs) {
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
  return { state: "unknown", url: page.url() };
}

/** @param {Page} page */
async function getAlertTexts(page) {
  const alerts = page.locator('[role="alert"]');
  const count = await alerts.count();
  /** @type {string[]} */
  const texts = [];
  for (let index = 0; index < count; index += 1) {
    try {
      const text = normalizeText(await alerts.nth(index).innerText({ timeout: 1000 }));
      if (text) {
        texts.push(text);
      }
    } catch (error) {
      debugLog(`Failed to read alert text at index ${index}`, error);
    }
  }
  return texts;
}

/** @param {Page} page */
async function dismissModals(page) {
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
            if (node instanceof HTMLElement) {
              node.click();
            } else {
              if ("click" in node && typeof node.click === "function") {
        node.click();
        return;
      }
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            }
            return true;
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

/** @param {Page} page */
async function completeAppsPageIfNeeded(page) {
  if (!page.url().includes("account.proton.me/apps")) {
    return false;
  }
  const candidates = [
    page.locator('[data-testid="explore-mail"]').first(),
    page.getByRole("button", { name: /mail/i }).first(),
    page.getByRole("link", { name: /mail/i }).first(),
  ];
  for (const target of candidates) {
    try {
      if (await target.isVisible({ timeout: 1000 })) {
        await target.click({ timeout: 5000 });
        return true;
      }
    } catch (error) {
      debugLog("Apps page mail target candidate check failed", error);
    }
  }
  return false;
}

/**
 * @param {{ page: Page, context: BrowserContext, username: string, password: string, sessionFile: string, suppressCooldown?: boolean }} options
 * @returns {Promise<LoginResult>}
 */
async function performLogin({ page, context, username, password, sessionFile, suppressCooldown = false }) {
  if (!page.url().includes("account.proton.me")) {
    await page.goto(MAIL_HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  const emailField = await locateLoginEmailField(page, 15000);
  if (!emailField) {
    return resultWithError("Proton login form did not appear", { manualRequired: true });
  }
  await emailField.fill(username);

  const passwordField = await locateLoginPasswordField(page, 10000);
  if (!passwordField) {
    return resultWithError("Proton password field did not appear", { manualRequired: true });
  }
  await passwordField.fill(password);

  const staySignedIn = await locateStaySignedInCheckbox(page);
  if (staySignedIn) {
    try {
      const checked = await staySignedIn.isChecked().catch(ignoreWithDebug("Failed to read stay-signed-in checkbox state", true));
      if (!checked) {
        await staySignedIn.check({ force: true });
      }
    } catch (error) {
      debugLog("Failed to enable stay-signed-in checkbox", error);
    }
  }

  const signInButton = await locateSignInButton(page, 10000);
  if (!signInButton) {
    return resultWithError("Proton sign-in button did not appear", { manualRequired: true });
  }
  await signInButton.click();

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    const currentUrl = page.url();
    if (await hasAuthChallenge(page)) {
      if (!suppressCooldown) {
        writeCooldown(sessionFile, "CAPTCHA detected during Proton Mail login");
      }
      return resultWithError("CAPTCHA detected during Proton Mail login", { captcha: true, manualRequired: true });
    }

    if (/\/two-factor|\/totp/i.test(currentUrl)) {
      if (!suppressCooldown) {
        writeCooldown(sessionFile, "Two-factor authentication required");
      }
      return resultWithError("Two-factor authentication required", { twoFactor: true, manualRequired: true });
    }

    const wrongPassword = (await getAlertTexts(page)).find((text) => /incorrect login credentials|wrong password|invalid password/i.test(text));
    if (wrongPassword) {
      if (!suppressCooldown) {
        writeCooldown(sessionFile, "Incorrect login credentials");
      }
      return resultWithError("Incorrect login credentials");
    }

    if (await hasInboxIndicators(page)) {
      await dismissModals(page);
      await saveSession(context, sessionFile);
      clearCooldown(sessionFile);
      return { success: true, loginMethod: "automatic" };
    }

    if (await completeAppsPageIfNeeded(page)) {
      await delay(1500);
    }

    await delay(1000);
  }

  if (!suppressCooldown) {
    writeCooldown(sessionFile, `Login timed out at ${page.url()}`);
  }
  return resultWithError("Automatic login timed out", { manualRequired: true });
}

/**
 * @param {{ page: Page, context: BrowserContext, mailUrl?: string, sessionFile: string, timeoutSeconds: number }} options
 * @returns {Promise<LoginResult>}
 */
async function waitForManualLoginCompletion({ page, context, mailUrl = INBOX_URL, sessionFile, timeoutSeconds }) {
  const startedAt = Date.now();
  const timeoutMs = Math.max(5, timeoutSeconds) * 1000;
  while (Date.now() - startedAt <= timeoutMs) {
    const state = await waitForInboxOrLogin(page, 1500);
    if (state.state === "inbox") {
      const navigation = await navigateToInbox(page, mailUrl);
      if (navigation.state !== "inbox") {
        return resultWithError("Manual login completed but target mail folder was not reachable", { manualRequired: true });
      }
      await dismissModals(page);
      await saveSession(context, sessionFile);
      clearCooldown(sessionFile);
      return { success: true, loginMethod: "manual", sessionValid: true };
    }
    await delay(1000);
  }
  return resultWithError("Manual login did not reach inbox before timeout", { manualRequired: true, timedOut: true });
}

/**
 * @param {Page} page
 * @param {number} [limit]
 */
async function scanInbox(page, limit = 50) {
  await page.waitForSelector('[data-testid="message-list-loaded"]', { timeout: 10000 }).catch(ignoreWithDebug("Message list loaded marker did not appear"));
  let rows = page.locator(MESSAGE_ROW_SELECTOR);
  let count = await rows.count();
  let previousCount = -1;
  let attempts = 0;
  while (count > 0 && count < limit && attempts < 10 && count !== previousCount) {
    previousCount = count;
    await rows.nth(count - 1).scrollIntoViewIfNeeded().catch(ignoreWithDebug(`Failed to scroll message row ${count - 1} into view`));
    await delay(1000);
    rows = page.locator(MESSAGE_ROW_SELECTOR);
    count = await rows.count();
    attempts += 1;
  }

  /** @type {MessagePreview[]} */
  const messages = [];
  for (let index = 0; index < Math.min(count, limit); index += 1) {
    try {
      messages.push({ index, preview: truncate(await rows.nth(index).innerText({ timeout: 1500 }), 240) });
    } catch (error) {
      debugLog(`Failed to read message preview at index ${index}`, error);
    }
  }
  return { inboxMessageCount: count, messages };
}

/**
 * @param {Page} page
 * @param {number} [limit]
 * @param {string} [mailUrl]
 */
async function scanInboxWithFallback(page, limit = 50, mailUrl = INBOX_URL) {
  const scan = await scanInbox(page, limit);
  if (scan.inboxMessageCount > 0 || mailUrl === MAIL_ALL_URL || !isInboxUrl(page.url())) {
    return scan;
  }

  const navigation = await navigateToInbox(page, MAIL_ALL_URL);
  if (navigation.state !== "inbox") {
    return scan;
  }

  await dismissModals(page);
  return scanInbox(page, limit);
}

/**
 * @param {MessagePreview[]} messages
 * @param {BrowserActionOptions["matchText"]} matchText
 */
function findMatchingMessage(messages, matchText) {
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
    if (matchText instanceof RegExp && matchText.test(preview)) {
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
 */
async function openMessage(page, index) {
  const locator = page.locator(MESSAGE_ROW_SELECTOR).nth(index);
  await locator.scrollIntoViewIfNeeded().catch(ignoreWithDebug(`Failed to scroll message row ${index} into view`));
  try {
    await locator.click({ timeout: 5000 });
  } catch (error) {
    debugLog(`Timed click failed for message row ${index}; trying DOM click`, error);
    await locator.evaluate((node) => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }).catch(ignoreWithDebug(`DOM click failed for message row ${index}`));
  }
  await page.waitForSelector('[data-testid="content-iframe"]', { timeout: 10000 });
}

/**
 * @param {Page} page
 * @param {string} fallback
 */
async function getOpenedMessageSubject(page, fallback) {
  for (const candidate of [page.locator('[data-testid*="subject"]').first(), page.locator('[role="region"] h1').first(), page.locator("h1").first()]) {
    try {
      const text = normalizeText(await candidate.innerText({ timeout: 1000 }));
      if (text) {
        return text;
      }
    } catch (error) {
      debugLog("Message subject candidate read failed", error);
    }
  }
  return truncate(fallback, 120);
}

/** @param {Frame} frame */
async function expandOriginalMessageIfNeeded(frame) {
  const trigger = frame.locator('[data-testid="message-view:expand-codeblock"]').first();
  try {
    if (await trigger.isVisible({ timeout: 1000 })) {
      await trigger.click({ timeout: 3000 });
      await delay(1500);
    }
  } catch (error) {
    debugLog("Failed to expand original message content", error);
  }
}

/**
 * @param {Page} page
 * @param {string} fallbackPreview
 * @returns {Promise<ExtractMessageResult>}
 */
async function extractOpenedMessage(page, fallbackPreview) {
  const iframeHandle = await page.$('[data-testid="content-iframe"]');
  if (!iframeHandle) {
    return resultWithError("Message content iframe was not found");
  }
  const frame = await iframeHandle.contentFrame();
  if (!frame) {
    return resultWithError("Message iframe content was unavailable");
  }
  await expandOriginalMessageIfNeeded(frame);
  const bodyText = await frame.innerText("body");
  return {
    success: true,
    subject: await getOpenedMessageSubject(page, fallbackPreview),
    bodyText,
  };
}

export const __internal = {
  defaultSessionFile: DEFAULT_SESSION_FILE,
  extractFirstOtpCode,
  findMatchingMessage,
  hasAuthChallengeText,
  debugLog,
  isDebugLoggingEnabled,
  MAIL_ALL_URL,
  matchOpenAiEmail,
  resolveMailUrl,
  saveSession,
  writeCooldown,
};
