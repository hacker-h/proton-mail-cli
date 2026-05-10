# proton-mail-cli

Automation-friendly Proton Mail CLI and reusable client package with two layers:

1. `ProtonMailClient` for REST/API access when you already have a valid cookie session store
2. `ProtonMailBrowserClient` for Playwright-based login, saved-session reuse, plaintext inbox/message extraction, and OTP retrieval

The browser client is the canonical dependency surface when other local projects need to log into Proton Mail and read email content programmatically.

## CLI Usage

This package installs a `pm` binary for automation-friendly Proton Mail commands. It also exports the underlying client classes for scripts that need direct integration. `pm ls`, `pm mail search`, `pm mail latest`, and `pm read browser:index:N` are browser-backed in the installed binary and use saved-session reuse.

Local workspace usage:

```bash
pnpm node bin/pm.js --help
pnpm node bin/pm.js version
pnpm node bin/pm.js ls --json
```

Installed package usage:

```bash
pm --help
pm version
pm ls
pm ls --match github --limit 5 --json
pm mail latest
pm mail search --match github --json
pm read browser:index:0
pm otp --match openai --json
pm otp --provider github --poll-interval 2 --timeout 60 --require-match
```

Global flags:

| Flag | Purpose |
|------|---------|
| `--json` | Emits the stable JSON envelope. Equivalent to `--format json`. |
| `--format <human\|json\|table>` | Selects human output, table output, or JSON output. |
| `--timeout <seconds>` | Passes a positive integer timeout to injected clients. |
| `--config <path>` | Reads CLI config from a JSON file. Overrides `PROTONMAIL_CONFIG_FILE`. |
| `--session <path>` | Uses a Proton session state path. Overrides env and config files. |
| `--quiet` | Suppresses human success output. Errors still go to stderr. |
| `--verbose` | Passes verbose mode to injected clients. |

### Mail Listing and Latest Message

`pm ls` / `pm mail list` scan Proton Mail through the browser backend. `pm mail search` filters browser message previews and requires `--match`. `pm mail latest` opens the latest matching message and returns safe metadata in JSON while omitting body text, browser handles, and debug events. `pm read` accepts the explicit `browser:index:N` refs returned by list/search and intentionally includes `bodyText`.

```bash
pm ls --limit 10
pm ls --format table
pm ls --match '/github/i' --folder all-mail --json
pm mail search --match github --require-match --json
pm mail latest --match openai --require-match --json
pm read browser:index:0 --json
```

Command-specific mail flags:

| Flag | Purpose |
|------|---------|
| `--match <text\|/re/i>` | Select messages whose preview contains text or matches a regex literal. |
| `--folder <name>` | Select browser scan folder, for example `inbox` or `all-mail`. |
| `--label <id>` / `--label-id <id>` | Adds a Proton REST metadata `LabelID` filter for injected REST clients. |
| `--subject <text>` | Adds a Proton REST metadata subject filter for injected REST clients. |
| `--from <text>` / `--sender <text>` | Adds a Proton REST metadata sender filter for injected REST clients. |
| `--to <text>` | Adds a Proton REST metadata recipient filter for injected REST clients. |
| `--read` / `--unread` | Adds a Proton REST metadata read-state filter for injected REST clients. |
| `--after <date\|timestamp>` / `--before <date\|timestamp>` | Adds Proton REST metadata time bounds for injected REST clients. |
| `--limit <count>` | Limit how many message previews are scanned. |
| `--require-match` | Exit non-zero when no matching message is found. |

The installed `pm` binary remains browser-backed for mail commands; REST metadata filters are surfaced in injected client options as `metadataFilter` for callers that wire `ProtonMailClient.getMessageMetadata()`. Mail JSON uses `status`, `source`, `sessionValid`, `inboxMessageCount`, `count`, and sanitized `messages`/`message` fields. List/search output includes preview snippets because listing mail is the command purpose; it never includes full message bodies. Read output is the only mail command that includes `bodyText`. Use `--format table` when you want the same tabular human output explicitly.

### OTP and Link Extraction

`pm otp` scans Proton Mail through the browser backend, using the configured saved session from `--session` / `PROTONMAIL_SESSION_FILE` or the OS cache default. It prints only the extracted code or link in human mode; JSON mode uses the standard envelope.

```bash
pm otp --match openai --json
pm otp --provider github --poll-interval 2 --timeout 60 --require-match
pm otp --match '/github/i' --pattern '\\b(?<code>[A-Z0-9]{4}-[A-Z0-9]{4})\\b'
pm otp --provider magic-link --link-pattern 'https://example.com/\\S+' --json
```

Command-specific flags:

| Flag | Purpose |
|------|---------|
| `--provider <name>` | Use a provider preset such as `generic`, `github`, or `magic-link`. |
| `--match <text\|/re/i>` | Select the latest email whose preview contains text or matches a regex literal. |
| `--pattern <pattern>` | Override the OTP extraction regex. Named capture group `code` is preferred. |
| `--otp-pattern <pattern>` | Alias for an explicit OTP extraction regex. |
| `--link-pattern <pattern>` | Extract a matching URL; named capture group `link` or `url` is preferred. |
| `--folder <name>` | Select the browser scan folder, for example `inbox` or `all-mail`. |
| `--limit <count>` | Limit how many message previews are scanned. |
| `--poll-interval <seconds>` | Retry no-match and matched-without-token results until `--timeout` elapses. |
| `--require-match` | Exit non-zero when no matching email/token/link is found. |

Default no-match behavior is a successful empty result in JSON, suitable for scripts that poll externally. `--poll-interval` enables built-in polling and uses `--timeout` as the total wait budget, defaulting to 60 seconds if no timeout is configured. `--require-match` turns no match, matched-without-token, timeout, session expiry, and auth/setup failures into CI-friendly failures. OTP JSON intentionally omits message bodies, previews, browser handles, and debug events. OTP values and magic links are command output by design; do not run this command with public logs unless those outputs are masked or captured privately.

Alias policy:

- `pm ls`, `pm list`, `pm inbox`, and `pm mail list` all dispatch to `mail:list`.
- `pm read <messageId>` dispatches to `mail:read`.
- Long-form feature commands remain available under `pm mail ...` as they land.

JSON output uses a single envelope convention for follow-up commands:

```json
{
  "ok": true,
  "command": "version",
  "data": { "version": "0.1.0" },
  "error": null,
  "meta": { "version": "0.1.0", "envelope": "pm.v1" }
}
```

JSON errors keep the same shape with `ok: false`, `data: null`, and a stable `error.code` plus human-readable `error.message`. Success output goes to stdout. Errors, including JSON envelopes for failed commands, go to stderr.

Future CLI command PRs should follow the shared contract in [docs/conventions.md](docs/conventions.md).

Exit codes:

| Code | Meaning |
|------|---------|
| `0` | Success, help, or version. |
| `1` | Usage error such as unknown commands, invalid flags, or missing arguments. |
| `2` | Command contract exists, but no injected client implementation is available. |
| `3` | Unexpected runtime failure. |

### Non-Interactive Configuration

Configuration resolves in this order: CLI flags, environment variables, JSON config file, then OS defaults. The default config file is `~/Library/Application Support/proton-mail-cli/config.json` on macOS, `$XDG_CONFIG_HOME/proton-mail-cli/config.json` on Linux when set, or `~/.config/proton-mail-cli/config.json`. The default browser session file is stored under the user cache directory, not repo-local `data/`.

Supported variables are documented in [Environment Variables](#environment-variables).

Secret precedence is direct env var, then `*_FILE`, then `*_COMMAND`. Doctor output reports whether secrets are configured and where they came from, but never prints secret values.

Example CI setup:

```bash
export PROTONMAIL_SESSION_FILE="$RUNNER_TEMP/protonmail-auth.json"
export PROTONMAIL_USERNAME_FILE="$RUNNER_TEMP/protonmail-username"
export PROTONMAIL_PASSWORD_FILE="$RUNNER_TEMP/protonmail-password"
pm doctor config --json
pm doctor session --json
```

`pm doctor config --json` explains config, path, secret, and timeout sources. `pm doctor session --json` reports stable statuses such as `missing_session`, `session_ready`, `session_unreadable`, `expired_session`, `manual_required`, `upstream_failure`, and `auth_ready`.

## Browser Client Usage

```js
import { ProtonMailBrowserClient } from "proton-mail-cli";

const client = new ProtonMailBrowserClient({
  headless: true,
  envFile: "/absolute/path/to/env.env",
  sessionFile: "/absolute/path/to/protonmail-auth.json",
});

const login = await client.loginAndSaveSession({
  headless: true,
  manualFallback: false,
});

if (!login.success) {
  throw new Error(login.error);
}

const latest = await client.getLatestMessage({
  matchText: /openai|noreply@openai\.com/i,
  limit: 10,
});

if (!latest.success) {
  throw new Error(latest.error);
}

console.log(latest.message.subject);
console.log(latest.message.bodyText);

const otp = await client.extractOtpCode();
if (otp.success) {
  console.log(otp.code);
}
```

### Configurable OTP and Link Extraction

`extractOtpCode()` defaults to the existing OpenAI email match plus a generic 6-digit OTP pattern. Callers can override extraction with `pattern` / `otpPattern`, use named capture group `code`, or select a provider preset.

```js
const githubOtp = await client.extractOtpCode({ provider: "github" });
console.log(githubOtp.code); // e.g. WDJB-MJHT

const auth0Otp = await client.extractOtpCode({
  matchText: /auth0|no-reply@auth0\.com/i,
  pattern: /verification code:\s*(?<code>[A-Z0-9]{8})/i,
});
console.log(auth0Otp.code);

const magicLink = await client.extractOtpCode({
  matchText: /sign in|login/i,
  provider: "magic-link-url",
});
console.log(magicLink.link);
```

Pure helpers are exported for already-loaded message bodies. String patterns are treated as regular expression source strings or `/source/flags` literals.

```js
import { extractFirstLink, extractFirstOtpCode } from "proton-mail-cli";

const code = extractFirstOtpCode(bodyText, { provider: "generic" });
const link = extractFirstLink(bodyText, { linkPattern: "Sign in: (?<link>https://\\S+)" });
```

### Browser Client Methods

- `loginAndSaveSession(options)`
- `getInboxMessages(options)`
- `getLatestMessage(options)`
- `extractOtpCode(options)`

### Browser Client Runtime Notes

- `proton-mail-cli` imports `playwright-core` at runtime. `playwright-core` provides the API but does not install browser binaries.
- In this repo, local development uses the `playwright` dev dependency; run `pnpm exec playwright install chromium` if Chromium is missing.
- Package consumers should either install a compatible Chromium and pass `debug.executablePath` / `PROTONMAIL_DEBUG_CHROMIUM`, or depend on `playwright` and run its browser installer as part of setup.
- Fresh automated logins can trigger Proton CAPTCHA or other human-verification challenges.
- Accounts with 2FA/TOTP enabled require manual completion. The browser client detects Proton's 2FA/TOTP step and returns a structured failure such as `{ success: false, twoFactor: true, manualRequired: true }`; it does not generate or submit TOTP codes.
- The durable operational model is:
  1. automatic login when Proton allows it
  2. saved-session reuse for normal programmatic runs
- For accounts with 2FA, run a headful/manual capture once, complete the challenge in the browser, and reuse the saved session file for automation.
- `envFile` should be an absolute path to a trusted credentials file when used.
- Session files contain secret-bearing browser state and should stay untracked.
- Saved sessions are reusable but not permanent. For long-running bots, treat `SessionExpiredError` or result code `SESSION_EXPIRED` as the signal to rotate the session file before retrying work.

## Security

This repo handles secret-bearing browser session state (Playwright storage state). Read `SECURITY.md` before using CI secrets or sharing logs.

## REST/API Usage

```js
import { ProtonMailClient, Labels } from "proton-mail-cli";
import { buildMailMetadataFilter } from "proton-mail-cli";

const client = new ProtonMailClient({
  sessionStore: mySessionStore,
  baseUrl: "https://mail.proton.me/api",
  rateLimit: {
    maxRetries: 2,
    baseDelayMs: 200,
    maxDelayMs: 3000,
  },
});

const { messages, total } = await client.getMessageMetadata({ LabelID: Labels.INBOX });
const unreadInvoices = await client.getMessageMetadata(buildMailMetadataFilter({
  labelId: Labels.INBOX,
  subject: "Invoice",
  unread: true,
}));
const message = await client.getMessage("MESSAGE_ID");
await client.markMessagesRead(["MESSAGE_ID"]);
const attachmentBytes = await client.getAttachment("ATTACHMENT_ID");
const labels = await client.getLabels();
const newLabel = await client.createLabel("Important", "#ff0000");
const calendars = await client.api("GET", "/calendar/v1");
```

HTTP 429 responses respect `Retry-After` when Proton sends it. Without that header, retries use exponential back-off with jitter until the `rateLimit.maxRetries` budget is exhausted, then throw `RateLimitError` with `retryAfter` and `retryAfterMs` fields.

## Session Store Interface

Your REST/API session store must implement at minimum:

```js
{
  getCookieHeader(url: string): Promise<string>
  getUIDCandidates(): Promise<string[]>

  getUID(): string | Promise<string>
  applySetCookieHeaders(url, headers): Promise<any[]>
  getRefreshPayload(uid): Promise<object | null>
  invalidate(): Promise<void>
}
```

See [docs/session-store.md](docs/session-store.md) for the full method contract, stored-session schema, browser session expiry signal, rotation strategy, and a runnable in-memory reference implementation.

## Implemented

| Area | Methods |
|------|---------|
| Browser automation | `ProtonMailBrowserClient.loginAndSaveSession`, `getInboxMessages`, `getLatestMessage`, `extractOtpCode` |
| Auth/User | `getUser`, `getAddresses`, `getKeySalts` |
| Messages (read) | `getMessage`, `getMessageMetadata`, `getAllMessageMetadata`, `getMessageIds`, `getAllMessageIds`, `getMessageCount` |
| Messages (actions) | `deleteMessages`, `markMessagesRead`, `markMessagesUnread`, `labelMessages`, `unlabelMessages`, `markMessagesForwarded`, `markMessagesUnforwarded` |
| Attachments | `getAttachment` |
| Labels/Folders | `getLabels`, `createLabel`, `updateLabel`, `deleteLabel` |
| Conversations | `getConversation`, `getConversations` |
| Events | `getLatestEventId`, `getEvents` |
| Passthrough | `api(method, path, options)` |

## Not Yet Implemented

- SRP authentication
- Draft creation / update / send via encrypted REST payloads
- Attachment decryption
- REST message body decryption
- Key management
- Contacts
- Automated 2FA/TOTP completion during auth
- FIDO2/WebAuthn during auth
- Import messages
- Undo actions
- Search
- Filters/Rules
- Settings
- Guaranteed fresh-login success when Proton presents CAPTCHA/human verification

2FA/TOTP challenge detection is implemented for the browser login path. Automated 2FA/TOTP completion is intentionally unsupported; CI and other unattended jobs must use a pre-captured saved session instead of trying to solve 2FA during fresh login.

## Architecture

```
src/
  cli.js
  index.js
  browser-client.js
  client.js
  http.js
  errors.js
  constants.js
bin/
  pm.js
```

## Debug Mode

For troubleshooting login failures, CAPTCHA issues, selector problems, or cooldown lockouts, use the built-in debug mode:

```bash
PROTONMAIL_DEBUG=1 node scripts/debug-login.mjs
```

This opens a headful Chromium browser with CDP enabled, keeps it open on failure, and suppresses cooldown writes. See [DEBUG.md](DEBUG.md) for full debug-mode documentation and [docs/troubleshooting.md](docs/troubleshooting.md) for CAPTCHA, selector drift, cooldown reset, and bug-report runbooks.

Debug mode records structured `debugEvents` for selector fallbacks, navigation timeouts, CAPTCHA detection, and message extraction failures. Events redact secret-bearing fields and email-like values before they are returned or printed.

## Environment Variables

This project uses a small set of `PROTONMAIL_*` environment variables for live tests, session seeding, and debug mode.

Notes:

- Values marked **Secret** must never be committed or printed (see `SECURITY.md`).
- When `PROTONMAIL_ENV_FILE` is not set, the browser client will also try `./env.env` and `./.env` at repo root.
- Session file paths are not secrets themselves, but the referenced files typically are.

| Variable | Purpose | Secret | Values / Defaults | Used by |
|---|---|---:|---|---|
| `PROTONMAIL_CONFIG_FILE` | Config JSON path when `--config` is not provided | No | Default: OS config path | `src/config.js`, README CLI examples |
| `PROTONMAIL_USERNAME` | Proton test account username for fresh login | Yes | Required for credential login; typically an email address; no default | `src/browser-client.js`, `scripts/capture-session.mjs`, `scripts/probe-login-state.mjs`, `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js`, `docs/ci.md` |
| `PROTONMAIL_USERNAME_FILE` | File containing the Proton username | Yes | Used when direct username env is unset | `src/config.js` secret resolution |
| `PROTONMAIL_USERNAME_COMMAND` | Command that prints the Proton username | Yes | Used when direct and file username sources are unset | `src/config.js` secret resolution |
| `PROTONMAIL_PASSWORD` | Proton test account password for fresh login | Yes | Required for credential login; no default | `src/browser-client.js`, `scripts/capture-session.mjs`, `scripts/probe-login-state.mjs`, `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js`, `docs/ci.md` |
| `PROTONMAIL_PASSWORD_FILE` | File containing the Proton password | Yes | Used when direct password env is unset | `src/config.js` secret resolution |
| `PROTONMAIL_PASSWORD_COMMAND` | Command that prints the Proton password | Yes | Used when direct and file password sources are unset | `src/config.js` secret resolution |
| `PROTONMAIL_ENV_FILE` | Absolute path to an env file containing credentials | No | Default: unset; if unset, tries `./env.env` then `./.env` | `src/browser-client.js`, `scripts/debug-login.mjs` |
| `PROTONMAIL_SESSION_FILE` | Override path to the Playwright session JSON file for scripts | No | Default (script behavior): `data/protonmail-auth.json` | `scripts/capture-session.mjs`, `scripts/debug-login.mjs`, `scripts/set-session-secret.mjs` |
| `PROTONMAIL_TIMEOUT_SECONDS` | Positive integer timeout for injected CLI clients | No | Default: command-specific or unset | `src/config.js`, CLI tests |
| `PROTONMAIL_SESSION_JSON` | Seed session JSON (minimized Playwright storage state) for CI/live tests | Yes | Default: unset; when set, CI writes it to an isolated session file before running live tests | `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js`, `docs/ci.md`, `scripts/capture-session.mjs`, `scripts/set-session-secret.mjs`, `DEBUG.md` |
| `PROTONMAIL_SESSION_CACHE_KEY` | Encryption key for short-lived cached session payloads (`.ci-proton/session.enc`) | Yes | Default: unset; when unset, workflow skips saving cache; if a cache exists, decryption requires this key. Recommended: ≥32 random bytes (see `SECURITY.md`) | `.github/workflows/live-proton.yml`, `scripts/session-cache.mjs`, `docs/ci.md` |
| `PROTONMAIL_LIVE_TEST` | Enable live Proton regression tests | No | `1` enables; default is disabled (`0`/unset) | `package.json` (`pnpm test:live`), `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js`, `docs/ci.md` |
| `PROTONMAIL_LIVE_SESSION_FILE` | Path to the live-test session file used by `pnpm test:live` | No | Default (workflow): `.ci-proton/session.json`; when set and file exists, live tests reuse it | `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js` |
| `PROTONMAIL_LIVE_HEADLESS` | Control headless mode for live tests | No | Default behavior: headless unless set to `0` | `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js` |
| `PROTONMAIL_ALLOW_FRESH_LOGIN` | Allow fresh username/password login in live tests when no session is seeded | No | `1` allows; default is `0`/unset (live tests prefer seeded session) | `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js` |
| `PROTONMAIL_DEBUG` | Enable debug mode (headful, verbose, keep browser open on error) | No | `1` or `true` enables; default disabled | `src/debug-config.js`, `src/browser-client.js`, `scripts/debug-login.mjs`, `test/debug-config.test.js`, `test/browser-client.test.js`, `README.md`, `DEBUG.md` |
| `PROTONMAIL_DEBUG_CDP_PORT` | Override Chrome DevTools Protocol port in debug mode | No | Default `9222` | `src/debug-config.js`, `scripts/debug-login.mjs`, `DEBUG.md` |
| `PROTONMAIL_DEBUG_PROFILE_DIR` | Override the debug browser profile directory | No | Default `<repo>/data/debug-profile` | `src/debug-config.js`, `scripts/debug-login.mjs`, `scripts/capture-session.mjs`, `DEBUG.md` |
| `PROTONMAIL_DEBUG_CHROMIUM` | Override Chromium executable path for debug runs | No | Default: auto (Playwright-managed Chromium unless overridden) | `src/debug-config.js`, `scripts/debug-login.mjs`, `DEBUG.md` |
| `PROTONMAIL_DEBUG_MANUAL_TIMEOUT_SECONDS` | Override manual debug/login wait timeout | No | Default: debug config default | `src/debug-config.js`, debug config tests |
| `PROTONMAIL_DEBUG_TIMEOUT_SECONDS` | Legacy manual debug/login wait timeout override | No | Default: unset; superseded by `PROTONMAIL_DEBUG_MANUAL_TIMEOUT_SECONDS` | `src/debug-config.js` |

## CI/CD

Required pull-request gates are offline only: install, typecheck, unit tests, and package smoke. Proton-facing checks are isolated in a separate workflow that requires repository secrets and can report Proton-side drift such as CAPTCHA, selector changes, or backend auth changes without becoming the deterministic merge gate.

Releases are automated by semantic-release on pushes to `main` after the offline gate passes. Because the package is currently private, releases publish GitHub Releases with attached npm tarballs instead of publishing to the npm registry.

See [docs/ci.md](docs/ci.md) for the full gate contract, local commands, live-test secrets, and drift policy. See [docs/RELEASING.md](docs/RELEASING.md) for release behavior and the npm-publishing checklist.

## Related

- [ProtonMail/go-proton-api](https://github.com/ProtonMail/go-proton-api)
- [proton-calendar-api](../proton-calendar-api)
