# protonmail-api-client

Reusable Proton Mail client package with two layers:

1. `ProtonMailClient` for REST/API access when you already have a valid cookie session store
2. `ProtonMailBrowserClient` for Playwright-based login, saved-session reuse, plaintext inbox/message extraction, and OTP retrieval

The browser client is the canonical dependency surface when other local projects need to log into Proton Mail and read email content programmatically.

## Browser Client Usage

```js
import { ProtonMailBrowserClient } from "protonmail-api-client";

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

### Browser Client Methods

- `loginAndSaveSession(options)`
- `getInboxMessages(options)`
- `getLatestMessage(options)`
- `extractOtpCode(options)`

### Browser Client Runtime Notes

- Fresh automated logins can trigger Proton CAPTCHA or other human-verification challenges.
- Accounts with 2FA/TOTP enabled require manual completion. The browser client detects Proton's 2FA/TOTP step and returns a structured failure such as `{ success: false, twoFactor: true, manualRequired: true }`; it does not generate or submit TOTP codes.
- The durable operational model is:
  1. automatic login when Proton allows it
  2. saved-session reuse for normal programmatic runs
- For accounts with 2FA, run a headful/manual capture once, complete the challenge in the browser, and reuse the saved session file for automation.
- `envFile` should be an absolute path to a trusted credentials file when used.
- Session files contain secret-bearing browser state and should stay untracked.

## REST/API Usage

```js
import { ProtonMailClient, Labels } from "protonmail-api-client";

const client = new ProtonMailClient({
  sessionStore: mySessionStore,
  baseUrl: "https://mail.proton.me/api",
});

const { messages, total } = await client.getMessageMetadata({ LabelID: Labels.INBOX });
const message = await client.getMessage("MESSAGE_ID");
await client.markMessagesRead(["MESSAGE_ID"]);
const attachmentBytes = await client.getAttachment("ATTACHMENT_ID");
const labels = await client.getLabels();
const newLabel = await client.createLabel("Important", "#ff0000");
const calendars = await client.api("GET", "/calendar/v1");
```

## Session Store Interface

Your session store must implement at minimum:

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
  index.js
  browser-client.js
  client.js
  http.js
  errors.js
  constants.js
```

## Debug Mode

For troubleshooting login failures, CAPTCHA issues, or selector problems, use the built-in debug mode:

```bash
PROTONMAIL_DEBUG=1 node scripts/debug-login.mjs
```

This opens a headful Chromium browser with CDP enabled, keeps it open on failure, and suppresses cooldown writes. See [DEBUG.md](DEBUG.md) for full documentation including Playwright MCP attach instructions.

## CI/CD

Pull requests run offline gates for every contributor. Same-repository pull requests, including Dependabot branches, also run live Proton login regression with the cached test-account session. Fork pull requests stay offline-only so repository secrets are never exposed to untrusted code.

See [docs/ci.md](docs/ci.md) for the full gate contract, local commands, live-test secrets, and drift policy.

## Related

- [ProtonMail/go-proton-api](https://github.com/ProtonMail/go-proton-api)
- [proton-calendar-api](../proton-calendar-api)
