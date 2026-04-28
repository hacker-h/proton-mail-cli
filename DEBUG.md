# Debug Mode

## Why Debug Mode Exists

`protonmail-api-client` uses a headless Playwright browser to log into Proton Mail and read emails. When login fails (CAPTCHA, 2FA, wrong credentials, selector changes), the browser closes immediately and a 5-minute cooldown is written, making it impossible to inspect what went wrong.

Debug mode fixes this by:
- Forcing headful (visible) browser
- Exposing a Chrome DevTools Protocol (CDP) port
- Keeping the browser open on any failure
- Suppressing cooldown writes
- Using an isolated profile directory (never touches your main browser)

## How to Enable

### Environment variable (recommended for CLI use):
```bash
PROTONMAIL_DEBUG=1 node scripts/debug-login.mjs
```

### Constructor option (for programmatic use):
```js
const client = new ProtonMailBrowserClient({ debug: true });
```

### With overrides:
```js
const client = new ProtonMailBrowserClient({
  debug: {
    cdpPort: 9333,
    profileDir: '/tmp/my-debug-profile',
    slowMo: 100,
    persistProfile: true,
  }
});
```

### Environment variable overrides:
| Variable | Default | Description |
|---|---|---|
| `PROTONMAIL_DEBUG` | `0` | Set to `1` or `true` to enable |
| `PROTONMAIL_DEBUG_CDP_PORT` | `9222` | CDP port |
| `PROTONMAIL_DEBUG_PROFILE_DIR` | `<repo>/data/debug-profile` | Browser profile dir |
| `PROTONMAIL_DEBUG_CHROMIUM` | (auto) | Chromium binary path |

## How to Attach Manually

While the debug session is running, open Chrome/Chromium and navigate to:
```
chrome://inspect
```
Click "Configure..." and add `127.0.0.1:9222`. Your Proton Mail page will appear under "Remote Target".

Or open the CDP endpoint directly:
```
http://127.0.0.1:9222
```

## How to Attach via Playwright MCP

From a Playwright MCP session, use `browser_run_code`:
```js
async (page) => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const pages = contexts[0].pages();
  return pages.map(p => p.url());
}
```

Or with the Playwright MCP `browser_navigate` tool, it will attach to the running CDP session.

## Profile Isolation Guarantee

Debug mode ALWAYS uses an isolated profile directory:
- Default: `<repo>/data/debug-profile/`
- This directory is in `.gitignore`, never committed
- It is separate from your system Chrome/Chromium profile
- It is separate from the Playwright MCP Chrome instance
- Set `persistProfile: true` to keep the profile between runs (useful for saved sessions)

## Known Caveats

- **Proton CAPTCHA**: If Proton Mail shows a CAPTCHA, you must solve it manually in the browser window. The debug session will wait up to 30 minutes (configurable via `--timeout`).
- **2FA**: If your account has 2FA enabled, you must complete it manually.
- **Port collision**: If port 9222 is already in use (e.g., by Playwright MCP), use `--port 9223` or set `PROTONMAIL_DEBUG_CDP_PORT=9223`.
- **Chromium install**: On first run, Playwright may need to install Chromium. This is automatic.

## Cleanup Commands

Kill orphaned Chromium processes:
```bash
pkill -f "remote-debugging-port=9222"
```

Remove debug profile (fresh start):
```bash
rm -rf data/debug-profile/
```

Remove debug Chromium binary cache:
```bash
rm -rf data/debug-chromium/
```
