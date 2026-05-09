# Security Policy

This repository contains code and workflows that handle **secret-bearing browser session state** (Playwright storage state) used to authenticate to Proton Mail for automation and CI regression checks.

Treat **session JSON** with the same care as a password or refresh token.

## Threat Model (Session Files)

The default browser-session file (Playwright storage state) can contain:

- authentication cookies for `*.proton.me`
- origin storage needed for session reuse (localStorage/sessionStorage)
- account identifiers and other metadata

An attacker who obtains this file may be able to **access the mailbox** without knowing the username/password, until the session expires or is revoked.

## Handling Secrets Safely

### Never commit / upload / log

Do **not**:

- commit session files or `.env` files to git
- paste session JSON into issues, PRs, logs, CI output, artifacts, or chat transcripts
- attach session JSON to bug reports or CI logs

This repo’s `.gitignore` already ignores `data/*.json` (the default session path), but you are still responsible for keeping secrets out of commits and logs.

### Store session files locally

- keep session files **untracked** and in a private location
- prefer filesystem permissions `0600` for the session file and `0700` for the parent directory
- rotate (refresh) sessions periodically and immediately after any suspected exposure

See `docs/session-store.md` for the default browser session-file behavior and how it is written.

## CI / GitHub Actions Safety Notes

### Preferred pattern: secrets → env → file

Workflows should pass secrets via `secrets.*` into step environment variables and then write them to files using a safe, non-expanding pattern such as:

- `printf '%s' \"$SECRET\" > file` (not `echo`)
- `chmod 600 file`

Avoid `set -x` or any command that might echo secret values.

### `GITHUB_ENV` / `GITHUB_OUTPUT` injection

`$GITHUB_ENV` and `$GITHUB_OUTPUT` are line-oriented files. Writing **untrusted** or **newline-containing** values to them can allow output/environment injection.

Guidelines:

- do not write secrets to `$GITHUB_ENV` or `$GITHUB_OUTPUT`
- only write sanitized, non-secret values (e.g., a branch slug) to `$GITHUB_OUTPUT`
- if you must write arbitrary values, use the documented multiline-safe format

This repo’s live workflow writes only derived, non-secret values (branch slug + time bucket) to `$GITHUB_OUTPUT` and writes the session JSON to a file with restricted permissions.

## Encrypted Session Cache Key Requirements

`PROTONMAIL_SESSION_CACHE_KEY` is used to encrypt/decrypt the short-lived cached session payload (`.ci-proton/session.enc`) with AES-256-GCM.

Minimum guidance:

- use a **high-entropy** secret; treat it as a long-term encryption key
- recommended floor: **32 random bytes** (or more)
  - example: `openssl rand -base64 32`
  - example: `openssl rand -hex 32`

Even though the implementation derives a 32-byte key via SHA-256, weak inputs (short, guessable strings) reduce real security.

## Rotation / Incident Response

If you suspect exposure of any of the following, rotate immediately:

- `PROTONMAIL_SESSION_JSON` (GitHub secret)
- `PROTONMAIL_SESSION_CACHE_KEY` (GitHub secret)
- `PROTONMAIL_USERNAME` / `PROTONMAIL_PASSWORD` (test account credentials)
- any local session files

Also revoke sessions in Proton account settings if possible, then refresh a new keep-logged-in session via a manual headful run.

## Reporting a Vulnerability

Preferred: use **GitHub Security Advisories** (private vulnerability report) for this repository.

If you cannot use advisories, contact the maintainer via GitHub. Do not include credentials, session JSON, or other secrets in the report.

