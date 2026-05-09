# CLI Conventions

These conventions are the contract for future `pm` command pull requests. Keep them stable unless a PR intentionally updates this document, tests, and README examples together.

The Proton Calendar `pc` CLI is prior art for short human aliases and automation-friendly output. `pm` follows the same general direction, but this document is the source of truth for Proton Mail because mail commands have stronger secret-redaction and session-state requirements.

## Command Shape

- Prefer explicit namespaces for documented commands: `pm mail list`, `pm mail latest`, `pm mail read <messageId>`, `pm doctor config`, `pm doctor session`.
- Keep human aliases for the most common paths: `pm ls`, `pm list`, `pm inbox`, `pm read <messageId>`, and `pm doctor auth`.
- New aliases must be stable, tested, and listed in `pm --help` before they are documented in README.
- Do not add aliases for destructive commands unless the long form already requires an explicit confirmation flag.

## Global Flags

Every command must accept the existing global flags consistently:

| Flag | Convention |
|------|------------|
| `--json` | Equivalent to `--format json`; emits the JSON envelope. |
| `--format <human\|json>` | Selects human output or JSON output. Future table output must be opt-in and documented before use. |
| `--timeout <seconds>` | Positive integer seconds passed to command implementations. |
| `--config <path>` | Overrides `PROTONMAIL_CONFIG_FILE`. |
| `--session <path>` | Overrides `PROTONMAIL_SESSION_FILE` and config-file session values. |
| `--quiet` | Suppresses human success output only. Errors still go to stderr. |
| `--verbose` | May include extra diagnostics, but never secrets, cookies, full message bodies, or full email addresses. |

Command-specific flags should use long names first. Add short flags only when they are obvious and unlikely to conflict.

## JSON Envelope

JSON mode always writes exactly one JSON object followed by a newline. Success goes to stdout:

```json
{
  "ok": true,
  "command": "mail:list",
  "data": {},
  "error": null,
  "meta": {
    "version": "1.2.0",
    "envelope": "pm.v1"
  }
}
```

Failure goes to stderr and keeps the same top-level shape:

```json
{
  "ok": false,
  "command": "mail:list",
  "data": null,
  "error": {
    "code": "FEATURE_NOT_IMPLEMENTED",
    "message": "pm ls is a CLI contract stub; inject a client implementation to execute it"
  },
  "meta": {
    "version": "1.2.0",
    "envelope": "pm.v1"
  }
}
```

Rules:

- `meta.envelope` remains `pm.v1` until a deliberate breaking-output PR changes it.
- `command` is the normalized command name, not necessarily the alias the user typed.
- `error.code` is machine-readable and stable enough for CI scripts.
- Error details may exist, but must be redacted before writing.
- Never mix logs, spinners, warnings, or progress text into JSON stdout.

## Exit Codes

| Code | Name | Meaning |
|------|------|---------|
| `0` | OK | Success, help, or version. |
| `1` | USAGE | Unknown commands, invalid flags, missing arguments, or invalid argument values. |
| `2` | UNAVAILABLE | The command contract exists, but the backend/config/session needed to execute it is unavailable. |
| `3` | RUNTIME | Unexpected local failure or unclassified upstream failure. |

Feature PRs may add finer error codes inside the JSON body, but should not add process exit codes unless the full CLI contract is updated.

## stdout and stderr

- Human success output goes to stdout.
- JSON success envelopes go to stdout.
- Human errors go to stderr.
- JSON error envelopes go to stderr.
- Debug logs must be disabled by default and must go to stderr if added to CLI commands.
- `--quiet` suppresses human success output, not errors or JSON failures.

## Human Output

Human output should be useful in a terminal, but JSON is the automation contract.

- Keep default human output short and stable.
- Prefer tabular output for lists only when columns are predictable and redacted.
- Use `No messages.` or another short sentence for empty human results.
- Do not print message bodies, OTP codes, links, or private mailbox metadata unless the command's purpose requires it and the user explicitly requested that output.
- If table output is added as a separate format, cover it with tests and document column names.

## No-Match Semantics

Search-like commands must distinguish these states in JSON:

- matching message found and requested value extracted
- matching message found but requested token/link/body was absent
- no matching message found
- search timed out before a match

Default no-match behavior should be a successful empty result when absence is expected. `--require-match` turns no-match, matched-without-token, and timeout into failures suitable for CI.

## Config and Secrets

Configuration resolves in this order:

1. CLI flags
2. environment variables
3. JSON config file
4. OS defaults

Secret values resolve in this order:

1. direct environment variable, such as `PROTONMAIL_PASSWORD`
2. file variable, such as `PROTONMAIL_PASSWORD_FILE`
3. command variable, such as `PROTONMAIL_PASSWORD_COMMAND`

Doctor commands may report sources and readiness. They must never print secret values, cookies, Playwright storage state, full email addresses, message bodies, OTP codes, magic links, or authorization headers.

## Backend Boundaries

- Offline unit tests should use injected clients or deterministic local doubles. They must not require Proton credentials, a browser login, Proton Bridge, or live network access.
- REST-backed commands may list metadata and perform supported API mutations when a valid session store is available.
- Browser-backed commands may read plaintext mailbox content from saved Playwright session state.
- Until native decryption exists, docs and output should clearly state when plaintext body reads require the browser backend.
- Proton Bridge support must remain optional and must use the same output envelope as REST/browser-backed commands.

## Testing Requirements

Every command PR should include tests for:

- alias and long-form dispatch
- `--json` success and failure envelopes
- stdout/stderr separation
- documented exit codes
- invalid flags and invalid positional arguments
- config/session/timeout propagation to the implementation layer
- redaction of secret-bearing fields
- empty and `--require-match` behavior for search-like commands

Package or CI PRs should also execute the installed `pm` binary from a packed tarball, not only source imports.

## Compatibility

Changing a field name in JSON output, moving an error from stdout to stderr, changing an exit code, or removing an alias is a breaking CLI change. Prefer additive changes and document any intentional break in README, tests, and release notes.
