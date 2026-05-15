# proton-mail-cli

Automation-friendly Proton Mail CLI and reusable client package with two layers:

1. `ProtonMailClient` for REST/API access when you already have a valid cookie session store
2. `ProtonMailBrowserClient` for Playwright-based login, saved-session reuse, and plaintext inbox/message extraction

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

The installed `pm ls` uses REST metadata listing when metadata filters are present and `PROTONMAIL_REST_SESSION_FILE` or `restSessionFile` is configured; otherwise mail commands remain browser-backed. REST metadata filters are also surfaced in injected client options as `metadataFilter` for callers that wire `ProtonMailClient.getMessageMetadata()`. Mail JSON uses `status`, `source`, `sessionValid`, `inboxMessageCount`, `count`, and sanitized `messages`/`message` fields. List/search output includes preview snippets because listing mail is the command purpose; it never includes full message bodies. Read output is the only mail command that includes `bodyText`. Use `--format table` when you want the same tabular human output explicitly.

### Mail Actions

REST-backed mail actions mutate explicit Proton message IDs or IDs selected from REST metadata filters. They require `PROTONMAIL_REST_SESSION_FILE` or `restSessionFile` because browser refs such as `browser:index:0` are not stable mutation IDs.

```bash
pm mail mark-read MESSAGE_ID --json
pm mail mark-unread MESSAGE_ID --json
pm mail label --label 10 MESSAGE_ID --json
pm mail unlabel --label 10 MESSAGE_ID --json
pm mail trash MESSAGE_ID --json
pm mail delete MESSAGE_ID --yes --json
```

Selection-based actions are gated. Use `--from-search` with REST metadata filters and either `--dry-run` or `--yes`:

```bash
pm mail mark-read --from-search --subject Invoice --unread --dry-run --json
pm mail mark-read --from-search --subject Invoice --unread --yes --json
```

Action JSON includes `action`, `dryRun`, `requested`, `affected`, `skipped`, and `failed`. Partial failures stay in the success envelope with `status: "partial_failure"` so automation can inspect per-ID results.

### Client-Side OTP Parsing Example

Built-in OTP/link extraction was removed in the v2 major line. Use mail access APIs and parse the message body in your own script. The example supports an artificial fixture for fast e2e-style tests without sending real email or stressing providers.

```bash
node examples/client-side-otp.js --fixture examples/fixtures/otp-message.json --json
```

For real mailbox access, the same script can read the latest message and apply a user-owned parser:

```bash
node examples/client-side-otp.js --match github --session "$PROTONMAIL_SESSION_FILE" --pattern '\b(?<code>\d{6})\b' --json
```

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

```

### Browser Client Methods

- `loginAndSaveSession(options)`
- `getInboxMessages(options)`
- `getLatestMessage(options)`

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

## Feature Support and Live Coverage

This matrix is the source of truth for user-visible Proton Mail capability, package/client support, and upstream live-test coverage. Offline tests prove local contracts only; they do not prove that Proton's current web UI, REST API, auth flow, selectors, rate limits, or anti-abuse controls still accept the workflow. Proton-facing checks follow the [live workflow policy](docs/ci.md#live-proton-regression) and [test-data safety rules](docs/ci.md#live-test-data-safety).

Update this table whenever support or live coverage changes.

| Proton feature | CLI support | Client support | Live-tested | Issue link | Notes |
|---|---|---|---|---|---|
| Browser login and saved-session reuse | Partial: `pm doctor session` inspects configured sessions | Yes: `ProtonMailBrowserClient.loginAndSaveSession` | Yes | #81 | CI covers seeded session reuse, isolated primary fresh login, and isolated secondary fresh login. |
| Mail list, search, latest, and read | Yes: `pm ls`, `pm mail search`, `pm mail latest`, `pm read browser:index:N` | Yes: browser inbox/latest methods | Yes | #80 | Browser-backed reads include only previews except `pm read`, which intentionally returns body text. |
| Two-account UI send/receive | No public send command | No public send API; live test uses Proton browser UI | Yes | #83 | Covers real To, Cc, and Bcc delivery between the two test accounts. Does not imply REST send support. |
| REST message metadata filters | Yes for `pm ls` metadata filters when `PROTONMAIL_REST_SESSION_FILE` is configured | Yes: `getMessageMetadata`, metadata filter builder | Yes | #78 | Live smoke covers metadata reads against a real REST session. |
| REST mail actions | Yes: mark read/unread, label/unlabel, trash/delete by stable message ID | Yes: message mutation methods | Partial | #78 | Default live CI avoids destructive actions; opt-in reversible mutation checks use test-prefixed labels. |
| Auth/user REST endpoints | No dedicated CLI command | Yes: user/address/key-salt methods | No | #79 | Covered offline by client contract tests; live expansion can be tracked from the feature parity issue. |
| Attachments download | No dedicated CLI command | Partial: raw attachment bytes through `getAttachment` | No | #88 | Attachment decryption and send are not implemented. |
| Labels and folders CRUD | No dedicated CLI command | Partial: labels list/create/update/delete | No | #85 | Needs safe live CRUD coverage before claiming upstream behavior. |
| Conversations and events | No dedicated CLI command | Yes: conversation and event methods | No | #86 | REST client support exists; live smoke tests are still pending. |
| Move, archive, star, and spam | No dedicated CLI command | Partial through lower-level label/action methods | No | #82 | Needs stable command UX and live tests. |
| Installed binary live regression | Package smoke only in offline CI | N/A | No | #91, #76 | Existing live checks run from the workspace; installed-tarball live regression is pending. |
| Release installer, update, and checksums | No installer/update command yet | N/A | No | #74, #75, #73 | Release artifact install/update support is tracked separately from Proton behavior. |
| Scheduled session refresh | Workflow support exists | Yes through browser session refresh | Partial | #77 | Live workflow refreshes trusted cached/seeded sessions; issue remains for stronger actionability. |
| Draft lifecycle and native REST send | No | No | No | #84, #5 | Blocked by encrypted Proton payload/SRP/key research. Browser UI send coverage is not native REST send support. |
| Attachment send/decryption | No | No for decryption/send; partial raw download only | No | #88, #95 | Requires native crypto and message decryption work. |
| REST message body decryption, encryption, and PGP | No | No | No | #95, #13 | Message metadata can be read, but encrypted REST body content is not decrypted. |
| Contacts | No | No | No | #87 | Needs API research and live tests. |
| Proton server-side search | No; browser preview filtering and REST metadata filters only | No general server-side search wrapper | No | #89 | Current `--match` is local preview matching, not Proton server-side search. |
| Filters and rules | No | No | No | #90 | Needs API research and live tests. |
| Import/export | No | No | No | #93 | Support matrix/evaluation pending. |
| Mailbox settings | No | No | No | #92 | Support matrix and selected live tests pending. |
| Undo and scheduled send | No | No | No | #94 | Needs product/API evaluation before implementation. |
| Automated 2FA/TOTP and FIDO2/WebAuthn | No | Detection only for 2FA/TOTP challenges | No | #13 | CI must reuse saved sessions; unattended challenge solving is intentionally unsupported. |

## Implemented

| Area | Methods |
|------|---------|
| Browser automation | `ProtonMailBrowserClient.loginAndSaveSession`, `getInboxMessages`, `getLatestMessage` |
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
- Built-in OTP/link extraction
- FIDO2/WebAuthn during auth
- Import messages
- Undo actions
- Proton server-side search beyond browser preview filtering and REST metadata filters
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
| `PROTONMAIL_USERNAME2` | Secondary Proton test account username for two-account live tests | Yes | Required when trusted CI runs fresh-login live tests that cover secondary login or send/receive flows | `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js` |
| `PROTONMAIL_USERNAME_FILE` | File containing the Proton username | Yes | Used when direct username env is unset | `src/config.js` secret resolution |
| `PROTONMAIL_USERNAME_COMMAND` | Command that prints the Proton username | Yes | Used when direct and file username sources are unset | `src/config.js` secret resolution |
| `PROTONMAIL_PASSWORD` | Proton test account password for fresh login | Yes | Required for credential login; no default | `src/browser-client.js`, `scripts/capture-session.mjs`, `scripts/probe-login-state.mjs`, `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js`, `docs/ci.md` |
| `PROTONMAIL_PASSWORD2` | Secondary Proton test account password for two-account live tests | Yes | Required when trusted CI runs fresh-login live tests that cover secondary login or send/receive flows | `.github/workflows/live-proton.yml`, `test/live/proton-login.test.js` |
| `PROTONMAIL_PASSWORD_FILE` | File containing the Proton password | Yes | Used when direct password env is unset | `src/config.js` secret resolution |
| `PROTONMAIL_PASSWORD_COMMAND` | Command that prints the Proton password | Yes | Used when direct and file password sources are unset | `src/config.js` secret resolution |
| `PROTONMAIL_ENV_FILE` | Absolute path to an env file containing credentials | No | Default: unset; if unset, tries `./env.env` then `./.env` | `src/browser-client.js`, `scripts/debug-login.mjs` |
| `PROTONMAIL_SESSION_FILE` | Override path to the Playwright session JSON file for scripts | No | Default (script behavior): `data/protonmail-auth.json` | `scripts/capture-session.mjs`, `scripts/debug-login.mjs`, `scripts/set-session-secret.mjs` |
| `PROTONMAIL_REST_SESSION_FILE` | Override path to a REST session-store JSON file for metadata-filtered CLI listing | Yes | Default: unset; required by installed `pm ls` when REST metadata filters are used | `src/config.js`, `bin/pm.js`, REST metadata CLI docs |
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
