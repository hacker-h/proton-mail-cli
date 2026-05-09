import path from "node:path";
import { chromium } from "playwright-core";
import { performLogin, waitForManualLoginCompletion } from "./browser-auth.js";
import { debugLog, getDebugEvents, ignoreWithDebug, isDebugLoggingEnabled } from "./browser-debug.js";
import { extractFirstOtpCode, findMatchingMessage, matchOpenAiEmail, openMessage, scanInboxWithFallback, extractOpenedMessage } from "./browser-messages.js";
import { dismissModals, hasAuthChallengeText, hasInboxIndicators, locateLoginEmailField, waitForInboxOrLogin } from "./browser-selectors.js";
import {
  DEFAULT_SESSION_FILE,
  ROOT_DIR,
  clearCooldown,
  ensurePrivateDir,
  env,
  getCooldownState,
  isExpiredSavedSession,
  loadEnvFile,
  loadStorageState,
  normalizeAbsolutePath,
  normalizePath,
  resultWithError,
  saveSession,
  sessionExpiredResult,
  writeCooldown,
} from "./browser-session.js";
import { resolveDebugConfig } from "./debug-config.js";
import { parsePositiveInt } from "./browser-utils.js";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const INBOX_URL = "https://mail.proton.me/u/0/inbox";
export const MAIL_ALL_URL = "https://mail.proton.me/u/0/all-mail";

/**
 * @typedef {import("playwright-core").Browser | null} Browser
 * @typedef {import("playwright-core").BrowserContext | null} BrowserContext
 * @typedef {import("playwright-core").Page | null} Page
 * @typedef {import("./debug-config.js").DebugConfig} DebugConfig
 * @typedef {import("./debug-config.js").EnabledDebugConfig} EnabledDebugConfig
 * @typedef {string | RegExp | ((message: { index: number, preview: string }) => boolean)} MessageMatcher
 * @typedef {{
 *   headless?: boolean,
 *   timeoutSeconds?: unknown,
 *   manualTimeoutSeconds?: unknown,
 *   manualLoginTimeoutSeconds?: unknown,
 *   manualFallback?: boolean,
 *   sessionFile?: unknown,
 *   envFile?: unknown,
 *   usernameEnv?: string,
 *   passwordEnv?: string,
 *   userAgent?: string,
 *   viewport?: import("playwright-core").ViewportSize,
 *   browserFactory?: typeof chromium,
 *   debug?: boolean | Partial<EnabledDebugConfig>,
 *   matchText?: MessageMatcher,
 *   mailUrl?: string,
 *   folder?: string,
 *   limit?: number
 * }} BrowserClientOptions
 * @typedef {{
 *   headless: boolean,
 *   timeoutSeconds: number,
 *   manualLoginTimeoutSeconds: number,
 *   sessionFile: string,
 *   envFile: string,
 *   usernameEnv: string,
 *   passwordEnv: string,
 *   userAgent: string,
 *   viewport: import("playwright-core").ViewportSize,
 *   browserFactory: typeof chromium,
 *   debug: DebugConfig
 * }} ResolvedBrowserClientOptions
 * @typedef {{
 *   success: boolean,
 *   browser?: Browser,
 *   context?: BrowserContext,
 *   page?: Page,
 *   message?: { bodyText: string, [key: string]: unknown },
 *   [key: string]: unknown
 * }} BrowserResult
 * @typedef {{ browser?: Browser, context?: BrowserContext, page?: Page, debug?: DebugConfig, keepOpenOnError?: boolean }} SessionRuntime
 * @typedef {{ headless: boolean, storageState: unknown, debug?: DebugConfig }} LaunchInput
 */

export class ProtonMailBrowserClient {
  /** @type {ResolvedBrowserClientOptions} */
  #options;
  #envLoaded = false;

  /**
   * @param {BrowserClientOptions} [options]
   */
  constructor(options = {}) {
    const debug = resolveDebugConfig(options, process.env);
    const manualLoginTimeoutSeconds = parsePositiveInt(
      options.manualLoginTimeoutSeconds ?? (debug.enabled ? debug.manualTimeoutSeconds : 300),
      debug.enabled ? debug.manualTimeoutSeconds : 300
    );

    this.#options = {
      headless: Boolean(options.headless),
      timeoutSeconds: parsePositiveInt(options.timeoutSeconds, 90),
      manualLoginTimeoutSeconds,
      sessionFile: normalizePath(options.sessionFile) || DEFAULT_SESSION_FILE,
      envFile: normalizeAbsolutePath(options.envFile || process.env.PROTONMAIL_ENV_FILE || ""),
      usernameEnv: options.usernameEnv || "PROTONMAIL_USERNAME",
      passwordEnv: options.passwordEnv || "PROTONMAIL_PASSWORD",
      userAgent: options.userAgent || DEFAULT_USER_AGENT,
      viewport: options.viewport || DEFAULT_VIEWPORT,
      browserFactory: options.browserFactory || chromium,
      debug,
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

  /**
   * @param {BrowserClientOptions} [options]
   * @returns {Promise<BrowserResult>}
   */
  async loginAndSaveSession(options = {}) {
    this.loadRuntimeEnv();
    const mailUrl = resolveMailUrl(options);
    const settings = {
      headless: options.headless ?? this.#options.headless,
      manualFallback: options.manualFallback !== false,
      timeoutSeconds: parsePositiveInt(
        options.timeoutSeconds ?? options.manualTimeoutSeconds,
        this.#options.manualLoginTimeoutSeconds
      ),
    };
    const storage = loadStorageState(this.#options.sessionFile);
    const credentials = this.#loadCredentials();
    const debug = this.#options.debug;
    const keepOpenOnError = Boolean(debug.enabled && debug.keepOpenOnError);
    let browser;
    let context;
    let page;

    try {
      ({ browser, context, page } = await this.#launch({
        headless: settings.headless,
        storageState: storage.storageState,
        debug,
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
          debugEvents: getDebugEvents(page),
        }), { browser, context, page, debug });
      }

      const automatic = await performLogin({
        page,
        context,
        username: credentials.username,
        password: credentials.password,
        sessionFile: this.#options.sessionFile,
        suppressCooldown: Boolean(debug?.enabled && debug.suppressCooldown),
      });
      if (automatic.success) {
        const targetNavigation = await navigateToInbox(page, mailUrl);
        if (targetNavigation.state !== "inbox") {
          return resultWithSession(
            resultWithError("Automatic login completed but target mail folder was not reachable", { debugEvents: getDebugEvents(page) }),
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
        navigateToInbox,
      });
      return resultWithSession(manualResult, { browser, context, page, debug });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected Proton Mail login failure";
      const result = resultWithError(message, { debugEvents: getDebugEvents(page) });
      if (keepOpenOnError) {
        return resultWithSession(result, { browser, context, page, debug });
      }
      return result;
    } finally {
      if (!(debug.enabled && debug.keepOpenOnError)) {
        await context?.close().catch(ignoreWithDebug("Failed to close browser context"));
        await browser?.close().catch(ignoreWithDebug("Failed to close browser"));
      }
    }
  }

  /**
   * @param {BrowserClientOptions} [options]
   * @returns {Promise<BrowserResult>}
   */
  async getInboxMessages(options = {}) {
    this.loadRuntimeEnv();
    const session = await this.#ensureLoggedIn(options);
    if (!session.success) {
      return session;
    }

    const { browser, context, page } = session;
    if (!context || !page) {
      return resultWithError("Proton Mail browser session was unavailable");
    }
    try {
      await dismissModals(page);
      const scan = await scanInboxWithFallback(page, scanOptions(options));
      return {
        success: true,
        sessionValid: true,
        inboxMessageCount: scan.inboxMessageCount,
        messages: scan.messages,
        debugEvents: scan.debugEvents,
      };
    } finally {
      await context.close().catch(ignoreWithDebug("Failed to close browser context"));
      await browser?.close().catch(ignoreWithDebug("Failed to close browser"));
    }
  }

  /**
   * @param {BrowserClientOptions} [options]
   * @returns {Promise<BrowserResult>}
   */
  async getLatestMessage(options = {}) {
    this.loadRuntimeEnv();
    const session = await this.#ensureLoggedIn(options);
    if (!session.success) {
      return session;
    }

    const { browser, context, page } = session;
    if (!context || !page) {
      return resultWithError("Proton Mail browser session was unavailable");
    }
    try {
      await dismissModals(page);
      const scan = await scanInboxWithFallback(page, scanOptions(options));
      const target = findMatchingMessage(scan.messages, options.matchText);
      if (!target) {
        return resultWithError("No matching Proton Mail message found", {
          inboxMessageCount: scan.inboxMessageCount,
          debugEvents: getDebugEvents(page),
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

  /**
   * @param {BrowserClientOptions} [options]
   * @returns {Promise<BrowserResult>}
   */
  async extractOtpCode(options = {}) {
    const matchText = options.matchText || /openai|noreply@openai\.com/i;
    const result = await this.getLatestMessage({ ...options, matchText });
    if (!result.success) {
      return result;
    }

    const message = result.message;
    const code = extractFirstOtpCode(message?.bodyText);
    if (!code) {
      return resultWithError("Matching email found, but no 6-digit code was present", {
        message,
      });
    }

    return {
      success: true,
      sessionValid: true,
      code,
      message,
    };
  }

  /**
   * @param {BrowserClientOptions} [options]
   * @returns {Promise<BrowserResult>}
   */
  async debugLogin(options = {}) {
    const manualLoginTimeoutSeconds = parsePositiveInt(
      options.manualTimeoutSeconds ?? options.timeoutSeconds,
      this.#options.manualLoginTimeoutSeconds
    );
    const client = new ProtonMailBrowserClient({
      sessionFile: this.#options.sessionFile,
      envFile: this.#options.envFile,
      usernameEnv: this.#options.usernameEnv,
      passwordEnv: this.#options.passwordEnv,
      userAgent: this.#options.userAgent,
      viewport: this.#options.viewport,
      browserFactory: this.#options.browserFactory,
      ...options,
      manualLoginTimeoutSeconds,
      debug: options.debug !== false ? (options.debug || true) : false,
    });
    return client.loginAndSaveSession({
      manualFallback: true,
      timeoutSeconds: manualLoginTimeoutSeconds,
    });
  }

  /**
   * @param {BrowserClientOptions} [options]
   * @returns {Promise<BrowserResult>}
   */
  async #ensureLoggedIn(options = {}) {
    const headless = options.headless ?? this.#options.headless;
    const mailUrl = resolveMailUrl(options);
    const storage = loadStorageState(this.#options.sessionFile);
    const debug = this.#options.debug;
    const keepOpenOnError = Boolean(debug.enabled && debug.keepOpenOnError);
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
        return resultWithSession({ success: true }, { browser, context, page, debug });
      }

      if (isExpiredSavedSession(storage, navigation)) {
        return await this.#closeOrKeep(sessionExpiredResult({
          sessionFile: this.#options.sessionFile,
          url: navigation.url,
        }), { browser, context, page, debug, keepOpenOnError });
      }

      const cooldown = getCooldownState(this.#options.sessionFile);
      if (cooldown.active) {
        return await this.#closeOrKeep(resultWithError("Login cooldown active; restore the session before retrying", {
          cooldown: true,
          debugEvents: getDebugEvents(page),
        }), { browser, context, page, debug, keepOpenOnError });
      }

      const credentials = this.#loadCredentials();
      if (!credentials.ready) {
        return await this.#closeOrKeep(resultWithError("Missing Proton Mail credentials", {
          debugEvents: getDebugEvents(page),
        }), { browser, context, page, debug, keepOpenOnError });
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
        return await this.#closeOrKeep(automatic, { browser, context, page, debug, keepOpenOnError });
      }

      navigation = await navigateToInbox(page, mailUrl);
      if (navigation.state !== "inbox") {
        return await this.#closeOrKeep(resultWithError("Automatic login completed but target mail folder was not reachable", {
          debugEvents: getDebugEvents(page),
        }), { browser, context, page, debug, keepOpenOnError });
      }

      return resultWithSession({ success: true }, { browser, context, page, debug });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected Proton Mail browser failure";
      return await this.#closeOrKeep(resultWithError(message, {
        debugEvents: getDebugEvents(page),
      }), { browser, context, page, debug, keepOpenOnError });
    }
  }

  /**
   * @param {BrowserResult} result
   * @param {SessionRuntime} runtime
   * @returns {Promise<BrowserResult>}
   */
  async #closeOrKeep(result, { browser, context, page, debug, keepOpenOnError }) {
    if (keepOpenOnError) {
      return resultWithSession(result, { browser, context, page, debug });
    }
    await context?.close().catch(ignoreWithDebug("Failed to close browser context"));
    await browser?.close().catch(ignoreWithDebug("Failed to close browser"));
    return result;
  }

  /**
   * @returns {{ username: string, password: string, ready: boolean }}
   */
  #loadCredentials() {
    const username = env(this.#options.usernameEnv);
    const password = env(this.#options.passwordEnv);
    return { username, password, ready: Boolean(username && password) };
  }

  /**
   * @param {LaunchInput} input
   * @returns {Promise<{ browser: import("playwright-core").Browser | null, context: import("playwright-core").BrowserContext, page: import("playwright-core").Page }>}
   */
  async #launch({ headless, storageState, debug = { enabled: false } }) {
    const launchArgs = ["--disable-blink-features=AutomationControlled"];

    if (!debug.enabled) {
      const browser = await this.#options.browserFactory.launch({
        headless: Boolean(headless),
        args: launchArgs,
      });
      const storageStateOption = /** @type {import("playwright-core").BrowserContextOptions["storageState"] | undefined} */ (storageState || undefined);
      const context = await browser.newContext({
        userAgent: this.#options.userAgent,
        viewport: this.#options.viewport,
        storageState: storageStateOption,
      });
      await addNavigatorPatch(context);
      const page = await context.newPage();
      return { browser, context, page };
    }

    const enabledDebug = debug;
    ensurePrivateDir(enabledDebug.profileDir);
    const persistentOptions = {
      headless: false,
      args: [...launchArgs, `--remote-debugging-port=${enabledDebug.cdpPort}`],
      userAgent: this.#options.userAgent,
      viewport: this.#options.viewport,
      storageState: /** @type {import("playwright-core").BrowserContextOptions["storageState"] | undefined} */ (storageState || undefined),
    };
    if (enabledDebug.slowMo > 0) {
      Object.assign(persistentOptions, { slowMo: enabledDebug.slowMo });
    }
    if (enabledDebug.executablePath) {
      Object.assign(persistentOptions, { executablePath: enabledDebug.executablePath });
    }

    const context = await this.#options.browserFactory.launchPersistentContext(enabledDebug.profileDir, persistentOptions);
    await addNavigatorPatch(context);
    const browser = context.browser();

    console.log(`[protonmail-debug] cdp=http://127.0.0.1:${enabledDebug.cdpPort} profile=${enabledDebug.profileDir}`);

    const page = context.pages()[0] || (await context.newPage());
    return { browser, context, page };
  }
}

export { extractFirstOtpCode, matchOpenAiEmail };

export function defaultSessionFile() {
  return DEFAULT_SESSION_FILE;
}

/**
 * @param {BrowserClientOptions} [options]
 * @returns {string}
 */
export function resolveMailUrl(options = {}) {
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

/**
 * @param {unknown} url
 * @returns {boolean}
 */
export function isInboxUrl(url) {
  return String(url || "").includes("/inbox");
}

/**
 * @param {import("playwright-core").Page} page
 * @param {string} [url]
 * @returns {Promise<{ state: string, url: string }>}
 */
export async function navigateToInbox(page, url = INBOX_URL) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  return waitForInboxOrLogin(page, 15000);
}

/**
 * @param {BrowserClientOptions} options
 * @returns {import("./browser-messages.js").ScanFallbackOptions}
 */
function scanOptions(options) {
  return {
    limit: options.limit || 50,
    mailUrl: resolveMailUrl(options),
    mailAllUrl: MAIL_ALL_URL,
    isInboxUrl,
    navigateToInbox,
  };
}

/**
 * @param {BrowserResult} result
 * @param {SessionRuntime} runtime
 * @returns {BrowserResult}
 */
function resultWithSession(result, { browser, context, page, debug }) {
  const debugEvents = result.debugEvents || getDebugEvents(page);
  if (!debug?.enabled) {
    return { ...result, debugEvents, browser, context, page };
  }
  return {
    ...result,
    debugEvents,
    browser,
    context,
    page,
    debug: { cdpEndpoint: `http://127.0.0.1:${debug.cdpPort}` },
  };
}

/**
 * @param {import("playwright-core").BrowserContext} context
 * @returns {Promise<void>}
 */
async function addNavigatorPatch(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      configurable: true,
      get: () => undefined,
    });
  });
}

export const __internal = {
  defaultSessionFile: DEFAULT_SESSION_FILE,
  extractFirstOtpCode,
  findMatchingMessage,
  hasAuthChallengeText,
  hasInboxIndicators,
  isDebugLoggingEnabled,
  isExpiredSavedSession,
  debugLog,
  MAIL_ALL_URL,
  matchOpenAiEmail,
  resolveMailUrl,
  saveSession,
  writeCooldown,
};
