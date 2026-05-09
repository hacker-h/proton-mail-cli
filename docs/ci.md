# CI/CD Gate Contract

## Goals

This project is aimed at automation and CI/CD use cases, so CI is split into deterministic pull-request gates and Proton-facing regression checks.

## Pull Request Gates

Every pull request should pass:

```bash
pnpm install --frozen-lockfile
pnpm ci:offline
```

`pnpm ci:offline` runs:

- `pnpm typecheck`
- `pnpm test:unit`
- `pnpm test:package`
- `npm pack --dry-run`

These gates must not require Proton credentials, a browser login, Proton Bridge, or network access beyond dependency installation.

## Releases

Releases are defined in `.github/workflows/release.yml` and run on pushes to `main` or manual dispatch. The release job uses the same offline gate as pull requests before running semantic-release.

This package is currently private, so release automation creates GitHub Releases with attached npm tarballs and does not publish to the npm registry. See [RELEASING.md](RELEASING.md) for the release contract and npm-publishing checklist.

## Live Proton Regression

The live workflow is defined in `.github/workflows/live-proton.yml` and runs for trusted same-repository pull requests, pushes to `main`, schedule, or manual dispatch.

Preferred repository secret:

- `PROTONMAIL_SESSION_JSON`
- `PROTONMAIL_SESSION_CACHE_KEY`

Fallback repository secrets for explicitly allowed manual fresh-login runs:

- `PROTONMAIL_USERNAME`
- `PROTONMAIL_PASSWORD`

Local equivalent:

```bash
PROTONMAIL_LIVE_TEST=1 \
PROTONMAIL_SESSION_JSON="$(cat data/protonmail-auth.json)" \
pnpm test:live
```

The live test verifies:

- automatic Proton Mail login with the browser backend
- session file creation
- saved-session reuse without re-entering credentials

If `PROTONMAIL_SESSION_JSON` is present, the test writes it to an isolated temporary session file before launching the browser. This is the preferred and expected scheduled-CI mode because fresh credential login may trigger Proton CAPTCHA, 2FA/TOTP, or other risk checks.

Scheduled CI intentionally does not perform fresh username/password login when `PROTONMAIL_SESSION_JSON` is missing. A maintainer can manually dispatch the workflow with `allow_fresh_login=true`, but that should be rare and should be treated as potentially causing Proton risk challenges. If Proton returns the structured `twoFactor`/`manualRequired` result, the fix is to refresh the saved session in a headful/manual run; CI must not try to solve 2FA/TOTP automatically.

## Pull Request Live Login Cache

Same-repository pull requests run the live login regression, including Dependabot branches. Public forks stay offline-only, because they must not receive Proton credentials, session JSON, or the encrypted session cache key.

To avoid repeatedly logging in to Proton, the workflow restores an encrypted session cache scoped by branch name and a six-hour UTC time bucket.

Cache behavior:

- cache key: branch slug + six-hour bucket
- cache contents: encrypted minimized Playwright storage state
- encryption: AES-256-GCM via `PROTONMAIL_SESSION_CACHE_KEY`
- fallback: `PROTONMAIL_SESSION_JSON` when no cache exists for the current branch/bucket
- fresh password login: disabled unless a maintainer manually dispatches with `allow_fresh_login=true`

The cache is intentionally short-lived. New branch buckets fall back to the repository session secret, then save a refreshed encrypted session for later runs in the same six-hour window.

Do not cache raw session JSON. The workflow only caches `.ci-proton/session.enc`.

Dependabot live-login coverage uses Dependabot-scoped secrets with the same names as the Actions secrets. Keep these secrets limited to the dedicated Proton test account and rotate them if a dependency update or workflow log ever exposes session state.

## Proactive Session Refresh

For scheduled CI, refresh session state before jobs depend on it rather than waiting for a bot run to discover expiry.

Recommended cadence:

- run a scheduled refresh inside each six-hour cache bucket, or immediately before the live workflow batch
- use the dedicated Proton test account only
- write the refreshed Playwright storage state to a temporary file, then update `PROTONMAIL_SESSION_JSON`
- never print the session JSON, cookies, refresh payloads, or full account address

Local refresh recipe:

```bash
PROTONMAIL_USERNAME='test-account@example.com' \
PROTONMAIL_PASSWORD='...' \
PROTONMAIL_SESSION_FILE="$(pwd)/data/protonmail-auth.json" \
node --input-type=module <<'EOF'
import { ProtonMailBrowserClient, defaultSessionFile } from "./src/index.js";

const client = new ProtonMailBrowserClient({
  headless: true,
  sessionFile: process.env.PROTONMAIL_SESSION_FILE || defaultSessionFile(),
});
const result = await client.loginAndSaveSession({ headless: true, manualFallback: false });
await result.context?.close().catch(() => {});
await result.browser?.close().catch(() => {});
if (!result.success) {
  console.error(result.error || "Session refresh failed");
  process.exit(1);
}
EOF

pnpm session:secret -- --repo <owner>/<repo> --session-file data/protonmail-auth.json
```

If this returns `SESSION_EXPIRED` from a read path, run the same refresh before retrying the bot task. If refresh returns `captcha: true`, `twoFactor: true`, or `manualRequired: true`, stop the unattended run and recapture the session headfully:

```bash
PROTONMAIL_USERNAME='test-account@example.com' \
PROTONMAIL_PASSWORD='...' \
pnpm debug:login -- --profile-dir data/debug-profile --timeout 1800
pnpm session:secret -- --repo <owner>/<repo> --session-file data/protonmail-auth.json
```

GitHub Actions schedule sketch:

```yaml
on:
  schedule:
    - cron: "10 */6 * * *"
  workflow_dispatch:

jobs:
  refresh-proton-session:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install chromium
      - name: Refresh session
        env:
          PROTONMAIL_USERNAME: ${{ secrets.PROTONMAIL_USERNAME }}
          PROTONMAIL_PASSWORD: ${{ secrets.PROTONMAIL_PASSWORD }}
          PROTONMAIL_SESSION_FILE: data/protonmail-auth.json
        run: |
          node --input-type=module <<'EOF'
          import { ProtonMailBrowserClient } from "./src/index.js";

          const client = new ProtonMailBrowserClient({
            headless: true,
            sessionFile: process.env.PROTONMAIL_SESSION_FILE,
          });
          const result = await client.loginAndSaveSession({ headless: true, manualFallback: false });
          await result.context?.close().catch(() => {});
          await result.browser?.close().catch(() => {});
          if (!result.success) {
            console.error(result.error || "Session refresh failed");
            process.exit(1);
          }
          EOF
      - name: Update session secret
        env:
          GH_TOKEN: ${{ secrets.SESSION_SECRET_ROTATION_TOKEN }}
        run: pnpm session:secret -- --repo "$GITHUB_REPOSITORY"
```

The package runtime imports `playwright-core`, which does not install browser binaries. Live CI and local live checks must install the repo's `playwright` dev dependency and run `pnpm exec playwright install chromium`, or provide a compatible Chromium path through `PROTONMAIL_DEBUG_CHROMIUM`.

Use a fine-scoped token for `SESSION_SECRET_ROTATION_TOKEN` that can update Actions secrets in this repository. Do not use this refresh job for forked pull requests.

## Capturing a Keep-Logged-In Session

Capture the session locally in a headful browser, complete any CAPTCHA or account challenge manually, and leave Proton's stay-signed-in option enabled:

```bash
PROTONMAIL_USERNAME='test-account@example.com' \
PROTONMAIL_PASSWORD='...' \
pnpm debug:login -- --profile-dir data/debug-profile --timeout 1800
```

After the session file exists, store it as a GitHub Actions secret without printing the cookie JSON. The helper minimizes the Playwright storage state to Proton cookies plus the account-origin storage needed for session reuse, so it fits within GitHub's Actions secret size limit:

```bash
pnpm session:secret -- --repo <owner>/<repo>
```

You can also pass an explicit file:

```bash
pnpm session:secret -- --repo <owner>/<repo> --session-file data/protonmail-auth.json
```

Do not put session JSON in Actions cache, artifacts, issues, PR comments, or logs. It is secret-bearing browser state.

## Drift Policy

Live failures should be triaged into one of these categories:

- project regression: CLI/client behavior changed unexpectedly
- Proton backend drift: API/auth behavior changed
- Proton UI drift: selectors or mailbox UI changed
- auth challenge: CAPTCHA, 2FA/TOTP, account lock, or risk challenge
- infrastructure: missing secrets, browser install, GitHub runner failure

Do not make live tests required for external contributor PRs. They depend on private secrets and Proton-side behavior. Keep offline gates required; use live failures to open follow-up issues with redacted diagnostics.

## Secret Safety

CI must never print credentials, cookies, browser storage state, message bodies, or full email addresses unless a maintainer explicitly opts into a local debug run.
