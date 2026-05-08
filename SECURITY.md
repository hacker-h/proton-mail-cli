# Security Policy

## Threat Model

This project automates Proton Mail through browser state and HTTP cookies. Treat every session file, browser profile, encrypted cache payload before decryption, and CI secret as credential material.

Primary risks:

- disclosure of Playwright `storageState` JSON
- disclosure of `data/debug-profile/` browser profiles
- disclosure of Proton username/password CI secrets
- disclosure or weak generation of `PROTONMAIL_SESSION_CACHE_KEY`
- accidental logging of message bodies, email addresses, cookies, or session JSON

## Session Files

Session files contain cookies and origin storage that can allow account access without re-entering the password. Keep them out of git and artifacts.

Required handling:

- store session files under ignored paths such as `data/*.json`
- write session files with `0600` permissions
- keep parent directories private where possible
- rotate the Proton test account/session if a session file appears in logs, issues, pull requests, or artifacts

## GitHub Actions Secrets

Live Proton checks use these repository secrets:

- `PROTONMAIL_SESSION_JSON`: minimized Playwright storage state for scheduled/session-first login checks
- `PROTONMAIL_SESSION_CACHE_KEY`: encryption key for short-lived branch session caches
- `PROTONMAIL_USERNAME` and `PROTONMAIL_PASSWORD`: fallback credentials for explicit manual fresh-login runs only

`PROTONMAIL_SESSION_CACHE_KEY` must contain at least 32 bytes of entropy. Generate it with a cryptographic random source, for example:

```bash
openssl rand -base64 32
```

Do not reuse this key outside this repository.

## CI Session Cache

The live workflow caches only encrypted session payloads at `.ci-proton/session.enc`. Raw session JSON must not be stored in Actions cache or uploaded as an artifact.

Fork pull requests must not receive Proton secrets or the cache key. The live workflow is guarded so fork PRs run offline CI only.

## `GITHUB_ENV` Handling

Avoid writing decrypted session JSON to `GITHUB_ENV`. The workflow should pass session state through a temporary file referenced by `PROTONMAIL_LIVE_SESSION_FILE` instead. GitHub masks registered secrets, but transformed or decrypted values are not guaranteed to be masked automatically.

If a future workflow must derive a sensitive value at runtime, mask it explicitly with `::add-mask::` before any possible logging and avoid printing it to stdout/stderr.

## Reporting Security Issues

Do not open public issues with credentials, cookies, session JSON, browser profile contents, or private message content. Report privately to the repository owner and rotate affected secrets immediately.
