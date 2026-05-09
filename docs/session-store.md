# Session Store Contract

`ProtonMailClient` does not own authentication. It expects a caller-provided session store that can supply Proton cookies, a UID, and optional refresh data for an already authenticated browser/API session.

`ProtonMailBrowserClient` uses a Playwright storage-state file instead of this REST session-store interface. That browser session file is documented below because it is the default way to create or refresh the cookies a REST store may later consume.

## REST Session Store Methods

```js
{
  getCookieHeader(url): Promise<string>
  getUIDCandidates(): Promise<string[]>

  getUID(): string | Promise<string>
  applySetCookieHeaders(url, headers): Promise<unknown>
  getRefreshPayload(uid): Promise<object | null>
  invalidate(): Promise<void>
}
```

Required methods:

- `getCookieHeader(url)` returns the HTTP `Cookie` header for the target Proton URL. Return `""` when no valid cookies are available; throw only for store I/O failures.
- `getUIDCandidates()` returns possible Proton UID values when `getUID()` is not implemented. The first value is used.

Optional methods:

- `getUID()` returns the preferred Proton UID directly. When present, it takes precedence over `getUIDCandidates()`.
- `applySetCookieHeaders(url, headers)` persists `Set-Cookie` headers observed after API calls or auth refresh. It may return any value; callers ignore the return value.
- `getRefreshPayload(uid)` returns the refresh request body for the UID, or `null` when refresh is unavailable.
- `invalidate()` is called after a successful auth refresh so the store can drop stale derived state or force a reload from its backing service.

## Error Handling

- Missing cookies should return an empty string from `getCookieHeader()`. The client turns that into `ApiError` with code `AUTH_EXPIRED`.
- Missing UID candidates should return `[]`. The client turns that into `ApiError` with code `UID_MISSING`.
- Store backend failures should throw their native error. The client wraps unexpected transport failures as upstream errors, while explicit `ApiError` instances are preserved.
- `applySetCookieHeaders()` and `invalidate()` failures are not swallowed. If persistence fails, the caller sees the failure so automation does not continue with a stale session by accident.

## Session Expiry Lifecycle

Proton browser sessions are server-controlled. A captured Playwright storage-state file should be treated as a renewable credential, not a permanent login.

Typical expiry triggers:

- inactivity or normal Proton session TTL enforcement
- Proton-side revocation, password change, account security event, or logout from another device
- risk changes such as a new runner IP, datacenter, user agent, or suspicious repeated fresh-login attempts
- browser storage-state truncation, secret corruption, or a session file restored from an old cache bucket

There is no stable public Proton TTL guarantee. In CI, keep reuse windows short; this repository's live workflow uses a six-hour cache bucket and falls back to a repository session secret when a branch bucket misses. For unattended jobs, refresh before each scheduled batch or at least before the current cache bucket closes.

### Browser Expiry Signal

`ProtonMailBrowserClient` detects saved-session expiry when a stored session file is loaded, Proton redirects the mailbox navigation back to the login page, and no inbox indicators are visible.

Browser read methods such as `getInboxMessages()`, `getLatestMessage()`, and `extractOtpCode()` return a structured failure:

```js
{
  success: false,
  error: "Saved Proton Mail session expired; refresh the session file",
  errorName: "SessionExpiredError",
  code: "SESSION_EXPIRED",
  status: 401,
  sessionExpired: true,
  sessionValid: false
}
```

This is distinct from auth challenges:

- CAPTCHA/human verification returns `captcha: true` and `manualRequired: true`.
- 2FA/TOTP returns `twoFactor: true` and `manualRequired: true`.
- Network and Proton backend failures do not use `SESSION_EXPIRED`.

The package also exports `SessionExpiredError` for callers that normalize browser results into thrown errors.

### Rotation Pattern

Use a two-step flow for long-lived bots:

```js
import { ProtonMailBrowserClient, SessionExpiredError } from "proton-mail-cli";

const client = new ProtonMailBrowserClient({
  headless: true,
  sessionFile: process.env.PROTONMAIL_SESSION_FILE,
});

async function readWithRotation() {
  const result = await client.getLatestMessage({ limit: 10 });
  if (result.success) return result.message;

  if (result.code === "SESSION_EXPIRED") {
    const refreshed = await client.loginAndSaveSession({
      headless: true,
      manualFallback: false,
    });
    if (!refreshed.success) {
      throw new SessionExpiredError("Session refresh failed", { refresh: refreshed });
    }
    const retry = await client.getLatestMessage({ limit: 10 });
    if (retry.success) return retry.message;
  }

  throw new Error(result.error);
}
```

Headless rotation only works while Proton accepts an automated login for the account. If Proton presents CAPTCHA, 2FA/TOTP, or another risk challenge, run a headful capture, complete the challenge manually, and persist the new session file.

## Stored Session Shape

A REST store can choose Redis, S3, a secrets manager, memory, or a local file. The stored object should contain enough information to implement the methods above:

```js
{
  uid: "proton-uid",
  cookies: [
    {
      name: "AUTH-proton-uid",
      value: "...",
      domain: ".proton.me",
      path: "/",
      expires: 1760000000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax"
    }
  ],
  refreshPayloads: {
    "proton-uid": {
      ResponseType: "token",
      GrantType: "refresh_token",
      RefreshToken: "...",
      RedirectURI: "https://proton.me"
    }
  }
}
```

Required fields depend on which methods the store implements:

- `uid` is required when `getUID()` returns directly.
- `cookies` is required for `getCookieHeader()`.
- `refreshPayloads` is optional. Without it, expired sessions fail fast instead of refreshing.

Do not log or commit this object. Cookies and refresh payloads are secret-bearing authentication material.

## Reference Implementation

`examples/memory-session-store.js` provides a dependency-free in-memory implementation that is suitable for unit tests and short-lived scripts:

```js
import { MemorySessionStore } from "./examples/memory-session-store.js";
import { ProtonMailClient } from "proton-mail-cli";

const sessionStore = new MemorySessionStore({
  uid: "proton-uid",
  cookies: [
    { name: "AUTH-proton-uid", value: "token", domain: ".proton.me", path: "/" },
  ],
});

const client = new ProtonMailClient({ sessionStore });
await client.getUser();
```

The memory store is intentionally volatile. Use it to validate integrations, not to persist production bot sessions.

## Browser Session File Behavior

`ProtonMailBrowserClient` stores Playwright storage state in `sessionFile`:

- default path: `data/protonmail-auth.json` under the package root
- custom path: `new ProtonMailBrowserClient({ sessionFile: "/absolute/path/protonmail-auth.json" })`
- directory permissions: the parent directory is created with mode `0700` when possible
- file permissions: session JSON is written with mode `0600`
- write strategy: JSON is written to a temporary file in the same directory, then atomically renamed into place

When a saved browser session is stale or Proton demands a manual challenge, run a headful/debug capture, complete the challenge manually, and let the browser client rewrite the session file. A separate REST session store can then ingest the refreshed cookies if your integration needs REST-only access.
