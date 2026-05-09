import { getDebugEvents, recordDebugEvent } from "./browser-debug.js";
import {
  completeAppsPageIfNeeded,
  dismissModals,
  getAlertTexts,
  hasAuthChallenge,
  hasInboxIndicators,
  locateLoginEmailField,
  locateLoginPasswordField,
  locateSignInButton,
  locateStaySignedInCheckbox,
  waitForInboxOrLogin,
} from "./browser-selectors.js";
import { clearCooldown, resultWithError, saveSession, writeCooldown } from "./browser-session.js";
import { delay } from "./browser-utils.js";

const MAIL_HOME_URL = "https://mail.proton.me";

export async function performLogin({ page, context, username, password, sessionFile, suppressCooldown = false }) {
  if (!page.url().includes("account.proton.me")) {
    await page.goto(MAIL_HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  const emailField = await locateLoginEmailField(page, 15000);
  if (!emailField) {
    return resultWithError("Proton login form did not appear", { manualRequired: true, debugEvents: getDebugEvents(page) });
  }
  await emailField.fill(username);

  const passwordField = await locateLoginPasswordField(page, 10000);
  if (!passwordField) {
    return resultWithError("Proton password field did not appear", { manualRequired: true, debugEvents: getDebugEvents(page) });
  }
  await passwordField.fill(password);

  const staySignedIn = await locateStaySignedInCheckbox(page);
  if (staySignedIn) {
    try {
      const checked = await staySignedIn.isChecked().catch(() => true);
      if (!checked) {
        await staySignedIn.check({ force: true });
      }
    } catch (error) {
      recordDebugEvent(page, "selector.failure", { area: "staySignedInCheck" }, error);
    }
  }

  const signInButton = await locateSignInButton(page, 10000);
  if (!signInButton) {
    return resultWithError("Proton sign-in button did not appear", { manualRequired: true, debugEvents: getDebugEvents(page) });
  }
  await signInButton.click();

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    const currentUrl = page.url();
    if (await hasAuthChallenge(page)) {
      if (!suppressCooldown) {
        writeCooldown(sessionFile, "CAPTCHA detected during Proton Mail login");
      }
      return resultWithError("CAPTCHA detected during Proton Mail login", { captcha: true, manualRequired: true, debugEvents: getDebugEvents(page) });
    }

    if (/\/two-factor|\/totp/i.test(currentUrl)) {
      if (!suppressCooldown) {
        writeCooldown(sessionFile, "Two-factor authentication required");
      }
      return resultWithError("Two-factor authentication required", { twoFactor: true, manualRequired: true, debugEvents: getDebugEvents(page) });
    }

    const wrongPassword = (await getAlertTexts(page)).find((text) => /incorrect login credentials|wrong password|invalid password/i.test(text));
    if (wrongPassword) {
      if (!suppressCooldown) {
        writeCooldown(sessionFile, "Incorrect login credentials");
      }
      return resultWithError("Incorrect login credentials", { debugEvents: getDebugEvents(page) });
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
  recordDebugEvent(page, "auth.login.timeout", { timeoutMs: 30000 });
  return resultWithError("Automatic login timed out", { manualRequired: true, debugEvents: getDebugEvents(page) });
}

export async function waitForManualLoginCompletion({ page, context, mailUrl, sessionFile, timeoutSeconds, navigateToInbox }) {
  const startedAt = Date.now();
  const timeoutMs = Math.max(5, timeoutSeconds) * 1000;
  while (Date.now() - startedAt <= timeoutMs) {
    const state = await waitForInboxOrLogin(page, 1500);
    if (state.state === "inbox") {
      const navigation = await navigateToInbox(page, mailUrl);
      if (navigation.state !== "inbox") {
        return resultWithError("Manual login completed but target mail folder was not reachable", { manualRequired: true, debugEvents: getDebugEvents(page) });
      }
      await dismissModals(page);
      await saveSession(context, sessionFile);
      clearCooldown(sessionFile);
      return { success: true, loginMethod: "manual", sessionValid: true };
    }
    await delay(1000);
  }
  recordDebugEvent(page, "auth.manual.timeout", { timeoutMs });
  return resultWithError("Manual login did not reach inbox before timeout", { manualRequired: true, timedOut: true, debugEvents: getDebugEvents(page) });
}
