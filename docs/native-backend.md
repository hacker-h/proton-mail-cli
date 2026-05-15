# Native Proton Backend Plan

This note scopes a future native backend that can authenticate to Proton without browser storage state and decrypt REST message data locally. It is a design plan only; no production native auth code is introduced here.

## Recommendation

Build the native backend in this order:

1. Native SRP session login and refresh.
2. User/address key discovery and private-key unlock.
3. Message body decryption for existing REST `getMessage()` payloads.
4. Attachment decryption using attachment `KeyPackets` plus downloaded bytes.
5. Native draft/send only after read-side decryption is stable.

Keep the browser backend as the supported plaintext path until steps 1-4 are live-tested. Native auth and decryption should be opt-in at first and should not replace saved browser sessions until it can rotate sessions, report 2FA/human-verification states, and decrypt messages/attachments with clear errors.

## Current Project Baseline

The existing REST client can already fetch user data, addresses, key salts, message metadata, message payloads, attachments, labels, conversations, and events through a caller-provided session store. It cannot create a session from username/password, unlock private keys, decrypt encrypted message bodies, decrypt encrypted attachments, or create encrypted draft/send payloads.

The existing browser client remains the only implementation that returns plaintext mailbox content. Its live tests prove login, saved-session reuse, read flows, REST metadata/actions, and two-account browser UI send/receive. Those tests should remain separate from native backend tests because native behavior will exercise different API and crypto surfaces.

## Public References

These references are useful for behavior and API sequencing. Do not copy GPL code into this MIT-licensed package without an explicit license review.

| Reference | Use |
|---|---|
| `ProtonMail/pm-srp` | SRP proof generation, auth-version fallback, and `computeKeyPassword(password, salt)`. The repository is archived but documents the browser-client SRP contract. |
| `ProtonMail/proton-shared/lib/srp.ts` | Shows `/auth/info` SRP input, `ClientProof`, `ClientEphemeral`, `SRPSession`, optional `TwoFactorCode`, and server-proof validation. |
| `ProtonMail/proton-shared/lib/authentication/loginWithFallback.ts` | Shows auth-version fallback around wrong-password responses. |
| `ProtonMail/proton-shared/lib/keys/keys.ts` | Shows matching user key IDs to key salts and deriving private-key passphrases with `computeKeyPassword`. |
| `ProtonMail/pmcrypto` | Proton's OpenPGP wrapper. Its README says `init()` configures OpenPGP.js behavior; current versions track OpenPGP.js v6/RFC9580 compatibility work. |
| `ProtonMail/go-proton-api` | MIT-licensed Go reference for auth, 2FA, refresh, message send types, attachment key packets, and Proton API shapes. |
| `ProtonMail/proton-bridge/pkg/message/decrypt.go` | Shows read-side attachment decryption shape: decode attachment `KeyPackets`, prepend key packets to encrypted attachment bytes, then decrypt with an unlocked key ring. GPL reference only. |

## Design Sequence

### 1. Native SRP Session

Goal: produce a `FileSessionStore`-compatible session from username/password without Playwright.

Expected flow:

1. `GET /auth/info` with username.
2. Use `pm-srp`-compatible logic to compute `ClientEphemeral`, `ClientProof`, and expected server proof.
3. `POST /auth` with `Username`, `ClientEphemeral`, `ClientProof`, `SRPSession`, and optional `TwoFactorCode`.
4. Validate `ServerProof` before trusting returned tokens/cookies.
5. Persist UID, access/refresh data, and cookies in the existing session-store format or a versioned extension of it.
6. Refresh through the existing `ProtonHttp` refresh path, then invalidate on refresh failure.

Constraints:

- 2FA/TOTP can be submitted only when the caller explicitly provides a current code. This project should not generate TOTP from secrets in CI.
- FIDO2/WebAuthn and human-verification challenges should return structured `manualRequired`/`auth_challenge` results, not browser automation fallbacks.
- SRP version fallback must be tested with deterministic fixtures before any live credential test.

### 2. User And Address Key Unlock

Goal: return unlocked OpenPGP private keys for the authenticated user/address set.

Expected flow:

1. Fetch `/core/v4/users`, `/core/v4/addresses`, and `/core/v4/keys/salts`.
2. Match `KeySalts` to user/address key IDs.
3. Derive key passphrases with `computeKeyPassword(password, KeySalt)` when a salt exists; fall back only for documented old auth/key formats.
4. Read and decrypt private keys with a Proton-compatible OpenPGP layer.
5. Return a keyring object that separates user keys, address keys, public keys, primary address key, and locked-key failures.

Recommended crypto choice:

- Prefer `pmcrypto` if it is consumable in this package without license/package-manager friction, because Proton clients use it to configure OpenPGP.js behavior.
- If `pmcrypto` is unsuitable, use the existing `openpgp` dependency only after fixture tests prove it can read/decrypt current Proton key material and message packets.

### 3. Message Body Decryption

Goal: decrypt REST `Message.Body` from `getMessage(messageId)`.

Expected flow:

1. Fetch message payload through the existing REST client.
2. Select candidate private keys from recipient/address metadata.
3. Decrypt the armored or binary body with the unlocked private keys.
4. Verify signatures when sender public keys are available, but do not make missing sender verification block plaintext extraction initially.
5. Return structured output: plaintext body, MIME type, verification status, key IDs used, and warnings.

Non-goals for the first PR:

- Full RFC822 reconstruction.
- MIME sanitization beyond returning decrypted bytes/text.
- Contacts/trust model integration.

### 4. Attachment Decryption

Goal: decrypt downloaded attachment bytes.

Expected flow:

1. Fetch message metadata and attachment metadata.
2. Fetch raw attachment bytes through existing `getAttachment(attachmentId)`.
3. Decode attachment `KeyPackets` from metadata.
4. Decrypt by combining key packets and encrypted attachment bytes, matching Bridge's read-side shape.
5. Return bytes plus content metadata without writing to disk by default.

### 5. Native Draft And Send

Goal: create encrypted Proton draft/send payloads only after read-side crypto is proven.

Expected flow:

1. Research current recipient preferences and message package payloads in `go-proton-api` send/draft types.
2. Generate body session keys and attachment key packets per recipient.
3. Sign/encrypt with the sender address key.
4. Create/update/send drafts through REST.
5. Live-test between the two dedicated accounts, while keeping browser UI send coverage as an independent regression.

Do not start native send before SRP, key unlock, body decrypt, and attachment decrypt have live tests. Send has the highest risk of corrupt payloads, leaking plaintext, or creating provider-abuse noise.

## Proposed One-PR Follow-Ups

Draft these as separate issues or PRs in dependency order:

1. `feat(native-auth): add SRP login session store`
   - Adds native auth module, SRP fixtures, session persistence, refresh coverage, and structured 2FA/manual-required results.
   - Depends on no native crypto work except `pm-srp`-compatible proof generation.
2. `feat(native-auth): unlock user and address keys`
   - Adds key-salt matching, key-password derivation, private-key decrypt fixtures, and no message decryption yet.
   - Depends on native SRP session or an injected password/session fixture.
3. `feat(native-read): decrypt REST message bodies`
   - Adds `decryptMessageBody()` and CLI opt-in plumbing only after fixture and live read tests pass.
   - Depends on unlocked keys.
4. `feat(native-read): decrypt REST attachments`
   - Adds attachment key-packet decrypt support and byte-returning API.
   - Depends on unlocked keys and raw attachment download.
5. `feat(native-send): create encrypted drafts and send messages`
   - Adds draft/send payload construction and two-account live send/receive tests.
   - Depends on native body and attachment crypto.

## Security And Support Caveats

- Proton's API is unofficial for this package. Field names and challenge behavior can drift without notice.
- Native auth must not log passwords, SRP secrets, private key material, decrypted message bodies, attachment bytes, refresh tokens, cookies, or session JSON.
- Passwords, TOTP codes, and unlocked keys should stay in memory only and should not be serialized.
- CI should not perform unattended 2FA/TOTP or FIDO2/WebAuthn. Live native-auth CI should use dedicated test accounts and skip when Proton presents human verification.
- GPL references are for behavior research only. Copying code from GPL projects would require a licensing decision before implementation.
- Native decryption expands the package's security surface. Add targeted unit fixtures before live tests, and treat live tests as drift detection rather than exhaustive crypto proof.
