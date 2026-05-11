# Deprecations and Version Plan

This file records supported deprecations so automation users can plan upgrades.

## Deprecated Now

No active deprecations.

## Version Log

### Unreleased Major

Added:

- REST-backed safe mail action commands for mark read/unread, label/unlabel, trash, and delete.
- Selection safety gates with `--dry-run` and `--yes` for `--from-search` mutations.

Changed:

- Mail action JSON reports deterministic `affected`, `skipped`, and `failed` ID lists.

Removed:

- `pm otp`.
- `ProtonMailBrowserClient.extractOtpCode()`.
- Public OTP/link extraction helpers and provider presets.
- Built-in OTP polling logic.

Stable direction:

- Keep mail access, JSON envelopes, browser-backed plaintext reads, REST metadata listing/actions, and reusable client APIs.
- Keep OTP parsing in user-owned automation such as `examples/client-side-otp.js`.
