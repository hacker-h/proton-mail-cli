# protonmail-api-client

Minimal TypeScript/JS client for the Proton Mail REST API. Cookie-session based auth (no SRP login flow built-in — bring your own session cookies via a session store).

## Usage

```js
import { ProtonMailClient, Labels } from "protonmail-api-client";

const client = new ProtonMailClient({
  sessionStore: mySessionStore,  // must implement getCookieHeader(url) & getUIDCandidates()
  baseUrl: "https://mail.proton.me/api",  // optional, this is the default
});

// List inbox messages
const { messages, total } = await client.getMessageMetadata({ LabelID: Labels.INBOX });

// Read a single message (body is PGP-encrypted)
const message = await client.getMessage("MESSAGE_ID");

// Mark as read
await client.markMessagesRead(["MESSAGE_ID"]);

// Download attachment (raw encrypted bytes)
const attachmentBytes = await client.getAttachment("ATTACHMENT_ID");

// Labels/folders
const labels = await client.getLabels();
const newLabel = await client.createLabel("Important", "#ff0000");

// Raw API passthrough for any endpoint
const calendars = await client.api("GET", "/calendar/v1");
```

## Session Store Interface

Your session store must implement at minimum:

```js
{
  getCookieHeader(url: string): Promise<string>  // returns "Cookie: ..." header value
  getUIDCandidates(): Promise<string[]>           // returns possible x-pm-uid values

  // Optional:
  getUID(): string | Promise<string>                    // direct UID if known
  applySetCookieHeaders(url, headers): Promise<any[]>   // persist Set-Cookie from responses
  getRefreshPayload(uid): Promise<object | null>        // for auto auth refresh
  invalidate(): Promise<void>                           // clear caches after refresh
}
```

See `proton-calendar-api` sibling project for a working `CookieSessionStore` implementation.

## Implemented

| Area | Methods |
|------|---------|
| Auth/User | `getUser`, `getAddresses`, `getKeySalts` |
| Messages (read) | `getMessage`, `getMessageMetadata`, `getAllMessageMetadata`, `getMessageIds`, `getAllMessageIds`, `getMessageCount` |
| Messages (actions) | `deleteMessages`, `markMessagesRead`, `markMessagesUnread`, `labelMessages`, `unlabelMessages`, `markMessagesForwarded`, `markMessagesUnforwarded` |
| Attachments | `getAttachment` (raw encrypted bytes) |
| Labels/Folders | `getLabels`, `createLabel`, `updateLabel`, `deleteLabel` |
| Conversations | `getConversation`, `getConversations` |
| Events | `getLatestEventId`, `getEvents` |
| Passthrough | `api(method, path, options)` |

## Not Yet Implemented

- **SRP authentication** (`POST /auth/v4/info` + `/auth/v4` login flow) — requires `@proton/srp` or equivalent big-integer SRP-6a implementation
- **Draft creation** (`POST /mail/v4/messages`) — requires PGP encryption of body with address keyring
- **Draft update** (`PUT /mail/v4/messages/:id`) — same PGP requirement
- **Send message** (`POST /mail/v4/messages/:id`) — requires building `MessagePackage` with per-recipient encryption, session key splitting, etc.
- **Attachment upload** (`POST /mail/v4/attachments`) — requires PGP encryption + multipart upload with KeyPackets/DataPacket/Signature
- **Attachment decryption** — fetching raw bytes is implemented; decrypting with user/address keys is not
- **Message body decryption** — same: raw PGP armored body returned; decrypt-with-keyring not included
- **Key management** — unlocking user key → address keys → deriving key passwords from persisted session blobs
- **Contacts** (`/contacts/v4/contacts`, `/contacts/v4/contacts/emails`)
- **2FA/TOTP** during auth
- **FIDO2/WebAuthn** during auth
- **Import messages** (batch `POST /mail/v4/messages/import`)
- **Undo actions** (`POST /mail/v4/undoactions`)
- **Search** (`GET /mail/v4/messages` with search params)
- **Filters/Rules** (`/mail/v4/filters`)
- **Settings** (`/mail/v4/settings`, `/core/v4/settings`)
- **Human verification** challenge handling

## Architecture

```
src/
  index.js       — public exports
  client.js      — ProtonMailClient (high-level methods)
  http.js        — ProtonHttp (transport, retry, auth refresh)
  errors.js      — ApiError
  constants.js   — labels, flags, config defaults
```

## Related

- [ProtonMail/go-proton-api](https://github.com/ProtonMail/go-proton-api) — official Go reference client
- [proton-calendar-api](../proton-calendar-api) — sibling project for Proton Calendar with cookie-session auth
