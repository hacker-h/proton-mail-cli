# Compose, Draft, Send, And Attachment Plan

This note scopes future compose/send support. It is research and architecture only; no user-facing send command is added here.

## Recommendation

Keep the existing browser UI send live test as the current end-to-end send regression. For productized send support, implement native REST send only after the native backend plan in [native-backend.md](native-backend.md) has delivered SRP/session handling and address-key unlock.

Recommended order:

1. Native key unlock and message body crypto from `docs/native-backend.md`.
2. Draft create/update with encrypted body and no attachments.
3. Attachment upload with encrypted data packets and session-key tracking.
4. Recipient preference lookup and package construction.
5. Native send command and two-account live send/receive regression.

Do not add a public `pm send` command until steps 1-4 have fixture tests and live tests. Sending bad encrypted payloads can create undecryptable drafts, leak plaintext, or stress provider anti-abuse controls.

## Feasible Send Paths

| Path | Feasible now | Pros | Cons | Recommendation |
|---|---:|---|---|---|
| Browser UI automation | Yes, test-only | Already live-tested with two accounts; no native crypto needed | UI selectors drift; not suitable for a stable automation command | Keep as drift regression only. |
| Proton Bridge SMTP | Externally feasible | Proton-maintained send pipeline and crypto | Requires user-installed Bridge, local account setup, and a different operational model | Document as an external workaround, not an embedded backend. |
| Native REST draft/send | Feasible after native key unlock | Direct package API; testable; no UI dependency | Requires SRP/session, private key unlock, recipient prefs, OpenPGP packets, attachment key packets | Target long-term implementation. |

## Public References

These references define behavior and endpoint shape. Do not copy GPL code into this MIT-licensed package without license review.

| Reference | What it proves |
|---|---|
| `ProtonMail/go-proton-api/message_draft_types.go` | Draft payload shape: `DraftTemplate`, `CreateDraftReq`, `UpdateDraftReq`, parent/action fields, and attachment key packet arrays. |
| `ProtonMail/go-proton-api/message_send.go` | Endpoint order: create draft with `POST /mail/v4/messages`, update draft with `PUT /mail/v4/messages/:id`, send draft with `POST /mail/v4/messages/:draftID`. |
| `ProtonMail/go-proton-api/message_send_types.go` | Send package shape: per-recipient `BodyKeyPacket`, `AttachmentKeyPackets`, clear session-key fallbacks, MIME/encryption scheme, and signature type. |
| `ProtonMail/go-proton-api/attachment.go` | Attachment upload shape: `POST /mail/v4/attachments` multipart fields for `KeyPackets`, `DataPacket`, and `Signature`. |
| `ProtonMail/proton-bridge/internal/services/smtp/smtp.go` | End-to-end send order used by Bridge: parse message, validate sender, create draft, upload attachments, resolve recipients, create packages, send draft. GPL reference only. |
| `ProtonMail/go-proton-api/keys.go` | Recipient public-key lookup shape through `GetPublicKeys`. |

## Native REST Flow

### 1. Compose Model

Add an internal compose model before CLI UX:

- sender address ID/email
- `To`, `Cc`, `Bcc`
- subject
- plain text or HTML body
- optional reply/forward parent metadata
- optional attachments with filename, MIME type, content ID, disposition, and bytes

Normalize and validate email addresses locally, but leave deliverability and recipient preference decisions to Proton APIs.

### 2. Draft Create And Update

Draft creation uses `POST /mail/v4/messages` with a `CreateDraftReq`-like body. The body is not plaintext: `go-proton-api` encrypts `DraftTemplate.Body` with the sender address key, armors it, and then submits it. Draft update uses `PUT /mail/v4/messages/:draftID` and encrypts a non-empty updated body the same way.

Minimum first implementation:

- Require an unlocked sender address key.
- Support `text/plain` and `text/html` only.
- Return draft ID and metadata.
- Do not upload attachments or send in the same PR.

### 3. Attachment Upload

Attachment upload is draft-scoped. `go-proton-api` signs the attachment bytes, encrypts them with the sender address key, and uploads multipart fields:

- `MessageID`
- `Filename`
- `MIMEType`
- `Disposition`
- `ContentID`
- binary `KeyPackets`
- binary `DataPacket`
- binary `Signature`

The returned attachment metadata includes `KeyPackets`; Bridge decodes those packets and decrypts the attachment session key with the sender key so send packages can include per-recipient attachment key packets.

Minimum first implementation:

- Upload attachments only for a draft created by this run.
- Track attachment IDs and decrypted attachment session keys in memory.
- Clean up failed drafts/attachments where Proton exposes safe delete paths.

### 4. Recipient Preferences And Packages

Sending a draft requires `SendDraftReq.Packages`, not just a draft ID. Package construction needs recipient preferences:

- internal vs external recipient type
- recipient public key when encrypting
- signature type
- encryption scheme
- MIME type compatibility
- contact settings when available

For each recipient, package construction encrypts the body session key and attachment session keys to the recipient public key when encryption is required. For clear recipients, the package carries clear session-key material in fields such as `BodyKey`/`AttachmentKeys`, matching the Proton API's expected shape.

Minimum first implementation:

- Start with two internal test-account recipients only.
- Require encrypted internal packages and detached signatures.
- Add external clear/PGP behavior later after recipient preference fixtures exist.

### 5. Send Draft

Send uses `POST /mail/v4/messages/:draftID` with the packages. Bridge deletes superseded local draft references only after send succeeds; this package should similarly avoid destructive cleanup until send success is confirmed.

Minimum first implementation:

- Send only a draft created by this run.
- Poll recipient account through existing browser read helpers to verify delivery in live tests.
- Keep current browser UI send test as independent coverage while native send matures.

## Test Strategy

Offline tests:

- fixture tests for compose model normalization
- encryption fixture tests for draft body armor/decrypt round-trip
- attachment packet fixture tests using local bytes only
- recipient package fixture tests for internal encrypted recipients
- error tests for missing sender key, missing recipient public key, unsupported MIME type, missing checksum/key packet, and unsupported external preference

Live tests:

- create draft with test-prefixed subject/body, verify metadata, then delete/trash safely
- update draft body and verify metadata changed
- upload small attachment to draft, then delete draft
- native send from account 1 to account 2 after package construction is fixture-proven
- keep destructive cleanup guarded by test-data prefix checks

## Security And Operational Caveats

- Never log plaintext body, attachment bytes, private keys, session keys, key packets, recipient package keys, cookies, tokens, or passwords.
- Keep decrypted body/attachment/session-key material in memory only.
- Live tests must use dedicated test accounts and test-prefixed subjects/attachments.
- Native send must remain opt-in until error handling can distinguish project bugs from Proton backend drift.
- Bridge and proton-shared references include GPL code; use them to understand behavior, not as copied implementation.

## Proposed One-PR Follow-Ups

Draft future issues in this order:

1. `feat(compose): add internal compose model and validation`
   - Pure offline model/validation; no Proton network.
2. `feat(drafts): create and update encrypted native drafts`
   - Depends on native key unlock from `docs/native-backend.md`.
3. `feat(attachments): upload encrypted draft attachments`
   - Depends on encrypted draft support and address-key crypto.
4. `feat(send): build internal-recipient send packages`
   - Depends on recipient public-key lookup and attachment session-key tracking.
5. `feat(send): send native drafts between test accounts`
   - Depends on package construction and adds two-account live verification.
6. `feat(send): expand external recipient and PGP/MIME behavior`
   - Depends on internal native send and recipient preference fixtures.
