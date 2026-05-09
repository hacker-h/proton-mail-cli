# Troubleshooting Proton Login

This runbook covers the browser-client failures that usually need operator action:
CAPTCHA or human verification, Proton UI selector drift, and temporary cooldown
lockout after repeated failed login attempts.

Keep credentials, cookies, session JSON, message bodies, and full email addresses
out of bug reports and logs.

## CAPTCHA or Human Verification

### Symptoms

- `loginAndSaveSession()` returns `success: false` with `captcha: true` and
  `manualRequired: true`.
- The error contains `CAPTCHA detected during Proton Mail login`.
- A headful debug browser shows a CAPTCHA, hCaptcha, risk check, or "verify you
  are human" page.
- Live CI classifies the failure as an auth challenge instead of an offline gate
  failure.

### Diagnosis

Run a visible debug login so the browser stays open on failure:

```bash
PROTONMAIL_DEBUG=1 pnpm debug:login -- --timeout 1800
```

Use a custom CDP port if `9222` is already in use:

```bash
PROTONMAIL_DEBUG=1 pnpm debug:login -- --port 9223 --timeout 1800
```

Then inspect the page with `chrome://inspect` or open the printed CDP endpoint.
Look for challenge iframes, CAPTCHA text, risk-check copy, or a verification page
before the mailbox appears.

### Fix or Workaround

- Complete the challenge manually in the debug browser and wait until Proton Mail
  reaches the inbox. The client saves the refreshed session file and clears any
  cooldown file after a successful login.
- Prefer saved-session reuse for automation. Fresh unattended logins are more
  likely to trigger challenges.
- For CI or scheduled jobs, provide a pre-captured session file or secret rather
  than expecting the runner to solve a challenge.
- If Proton repeatedly challenges the same account, pause retries and refresh the
  session from a trusted local machine with a headful browser.

## Selector Drift

### Symptoms

- Login fails with `Proton login form did not appear`, `Proton password field did
  not appear`, `Proton sign-in button did not appear`, or `Automatic login timed
  out`.
- A saved session reaches Proton Mail, but mailbox reads return no messages even
  though the account has mail.
- Debug logs mention candidate selectors not becoming visible.
- `probe-login-state` output shows missing `emailField`, `passwordField`, or
  `submitButton`, or the URL/title no longer matches the expected Proton login
  flow.

### Diagnosis

First run the login-state probe. It prints one JSON line per phase with URL,
title, field visibility, challenge detection, inbox hints, and alert text.

```bash
PROTONMAIL_USERNAME='user@example.com' \
PROTONMAIL_PASSWORD='app-or-account-password' \
pnpm login:probe -- --headful --seconds 30
```

Use an isolated persistent profile when comparing behavior across attempts:

```bash
PROTONMAIL_USERNAME='user@example.com' \
PROTONMAIL_PASSWORD='app-or-account-password' \
pnpm login:probe -- --headful --seconds 45 --profile-dir data/probe-profile
```

If the probe confirms the login form changed, run the full debug login and attach
to CDP to inspect the live DOM:

```bash
PROTONMAIL_DEBUG=1 pnpm debug:login -- --port 9222 --json
```

Check whether Proton changed accessible names, input attributes, button text,
`data-testid` values, message-row markers, or interstitial pages between login
and inbox.

### Fix or Workaround

- If the page is still usable manually, complete login in debug mode to refresh
  the session and keep automation running from saved session state.
- If a selector changed, update the browser-client selector candidates and add or
  adjust unit coverage where the change can be represented offline.
- If mailbox selectors drifted, capture the new row/list markers without exposing
  message content.
- Do not retry aggressively while diagnosing drift. Repeated attempts can create
  a cooldown lockout or trigger human verification.

## Cooldown Lockout

### Symptoms

- Browser read methods return `success: false` with `cooldown: true`.
- The error is `Login cooldown active; restore the session before retrying`.
- A previous login attempt failed with CAPTCHA, 2FA/TOTP, incorrect credentials,
  or timeout.
- A file named `protonmail-login-cooldown.json` exists next to the configured
  browser session file.

### Diagnosis

Find the session file in use:

- default: `data/protonmail-auth.json`
- custom: `PROTONMAIL_SESSION_FILE` or `new ProtonMailBrowserClient({ sessionFile })`

The cooldown file is stored in the same directory:

```bash
cat data/protonmail-login-cooldown.json
```

It contains:

```json
{
  "lastFailedAt": "2026-05-09T12:34:56.000Z",
  "reason": "CAPTCHA detected during Proton Mail login"
}
```

`lastFailedAt` is the ISO timestamp used to decide whether the five-minute
cooldown is still active. `reason` records the failure that created the cooldown.
Unreadable JSON or a missing `lastFailedAt` is ignored.

### Reset Procedure

1. Confirm the underlying cause is fixed: solve the challenge, correct
   credentials, refresh the saved session, or patch selector drift.
2. Wait at least five minutes from `lastFailedAt`, or remove only the cooldown
   file for the affected session directory:

```bash
rm data/protonmail-login-cooldown.json
```

3. Run a headful debug login and let it reach the inbox:

```bash
PROTONMAIL_DEBUG=1 pnpm debug:login -- --timeout 1800
```

A successful login rewrites the session file and clears the cooldown file. Debug
mode suppresses new cooldown writes while you inspect failures, so it is the
preferred path for recovery.

## Bug Reports for Proton UI Changes

When reporting confirmed Proton UI drift, include:

- package version or commit SHA
- command used, with credentials and paths redacted
- whether the run used a saved session, fresh login, debug login, or probe
- sanitized `probe-login-state` JSON lines for the failing phases
- failure result fields such as `error`, `captcha`, `twoFactor`,
  `manualRequired`, `cooldown`, and `sessionExpired`
- current URL path and page title from the debug/probe output
- changed selectors or DOM attributes, redacted screenshots, or short DOM
  snippets with secrets removed
- cooldown file `reason` and relative age of `lastFailedAt`, not the full session
  JSON

Do not include Proton credentials, cookies, storage-state JSON, message bodies,
OTP codes, full email addresses, or unredacted screenshots of private mailbox
content.
