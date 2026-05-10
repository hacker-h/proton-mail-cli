# Deprecations and Version Plan

This file records supported deprecations so automation users can plan upgrades.

## Deprecated Now

| Feature | Deprecated in | Removal target | Replacement |
|---------|---------------|----------------|-------------|
| Built-in OTP/link extraction: `pm otp`, `ProtonMailBrowserClient.extractOtpCode()`, `extractOtpCode()`, `extractFirstOtpCode()`, `extractFirstLink()`, and `OTP_PROVIDER_PRESETS` | Unreleased, next 1.x release | Next major version | Use mail list/read APIs, then parse message bodies in user-owned automation. See `examples/client-side-otp.js`. |

## Version Log

### Unreleased

Added:

- `examples/client-side-otp.js`, a user-land OTP parser that can run against artificial message fixtures for fast integration tests.
- `examples/fixtures/otp-message.json`, an artificial message fixture that avoids live email and provider load.

Changed:

- `pm otp` JSON responses include deprecation metadata.
- Human `pm otp` output prints a deprecation warning to stderr.
- README and CLI conventions now describe OTP parsing as user-owned automation.

Removed:

- Nothing yet. Built-in OTP/link extraction remains available until the next major version.

### Next Major Version

Planned removals:

- Remove `pm otp`.
- Remove provider presets and OTP/link extraction helpers from the public package API.
- Remove built-in OTP polling logic.

Stable direction:

- Keep mail access, JSON envelopes, browser-backed plaintext reads, REST metadata listing, and reusable client APIs.
- Keep tests and examples fixture-backed where possible instead of sending real provider emails.
