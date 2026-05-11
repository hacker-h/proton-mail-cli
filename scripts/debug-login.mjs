#!/usr/bin/env node
// scripts/debug-login.mjs
// ESM CLI for debug login — keeps browser open for manual inspection / Playwright MCP attach.

import { ProtonMailBrowserClient } from '../src/index.js';

const args = process.argv.slice(2);

// --help / -h
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node scripts/debug-login.mjs [options]

Options:
  --port <number>        CDP remote-debugging port (default: 9222)
                         env: PROTONMAIL_DEBUG_CDP_PORT
  --profile-dir <path>   Browser profile directory
                         env: PROTONMAIL_DEBUG_PROFILE_DIR
  --timeout <seconds>    Manual login timeout in seconds (default: 1800)
  --json                 Output result as JSON (credentials/cookies never printed)
  --help, -h             Show this help

Environment variables:
  PROTONMAIL_DEBUG=1              Enable debug mode (set automatically by this script)
  PROTONMAIL_DEBUG_CDP_PORT       CDP port override
  PROTONMAIL_DEBUG_PROFILE_DIR    Profile directory override
  PROTONMAIL_DEBUG_CHROMIUM       Chromium binary path override
  PROTONMAIL_ENV_FILE             Path to env file with credentials
  PROTONMAIL_SESSION_FILE         Path to session file

Description:
  Starts a headful Chromium browser with CDP enabled, navigates to Proton Mail,
  and waits for login to complete. The browser stays open until Ctrl+C or inbox
  is reached. Use chrome://inspect or Playwright MCP connectOverCDP to attach.

Cleanup:
  pkill -f "remote-debugging-port=9222"
`);
  process.exit(0);
}

// Helpers
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const port = getArg('--port') ? Number(getArg('--port')) : undefined;
const profileDir = getArg('--profile-dir') || undefined;
const timeout = getArg('--timeout') ? Number(getArg('--timeout')) : 1800;
const jsonOutput = args.includes('--json');

// Propagate flag overrides to env so resolveDebugConfig picks them up
process.env.PROTONMAIL_DEBUG = '1';
if (port) process.env.PROTONMAIL_DEBUG_CDP_PORT = String(port);
if (profileDir) process.env.PROTONMAIL_DEBUG_PROFILE_DIR = profileDir;

const sessionFile = process.env.PROTONMAIL_SESSION_FILE || undefined;

const client = new ProtonMailBrowserClient({
  sessionFile,
  debug: {
    cdpPort: port || 9222,
    profileDir,
    manualTimeoutSeconds: timeout,
  },
});

let browser;
let closing = false;

// Orphan cleanup: pkill -f "remote-debugging-port=9222"

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[protonmail-debug] Received ${signal}, closing browser...`);
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  process.exit(130);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', async (err) => {
  console.error('[protonmail-debug] Uncaught exception:', err.message);
  if (!closing && browser) {
    closing = true;
    await browser.close().catch(() => {});
  }
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('[protonmail-debug] Unhandled rejection:', reason);
  if (!closing && browser) {
    closing = true;
    await browser.close().catch(() => {});
  }
  process.exit(1);
});

console.log('[protonmail-debug] Starting debug login session...');
console.log('[protonmail-debug] Press Ctrl+C to exit');

const result = await client.loginAndSaveSession({ manualFallback: true });

if (result.browser) {
  browser = result.browser;
}

if (jsonOutput) {
  // Never print credentials, cookies, or storage state
  const safeResult = {
    success: result.success,
    loginMethod: result.loginMethod,
    error: result.error,
    debug: result.debug,
  };
  console.log(JSON.stringify(safeResult, null, 2));
}

if (result.success) {
  console.log('[protonmail-debug] Login successful! Session saved.');
  console.log('[protonmail-debug] Browser staying open. Press Ctrl+C to exit.');
  // Keep process alive until SIGINT/SIGTERM
  await new Promise(() => {});
} else {
  console.log(`[protonmail-debug] Login result: ${result.error || 'unknown'}`);
  const debug = result.debug && typeof result.debug === "object" ? /** @type {{ cdpEndpoint?: string }} */ (result.debug) : {};
  if (debug.cdpEndpoint) {
    console.log(`[protonmail-debug] Browser still open at: ${debug.cdpEndpoint}`);
    console.log('[protonmail-debug] Attach with: chrome://inspect or Playwright MCP connectOverCDP');
    // Keep process alive for manual interaction
    await new Promise(() => {});
  }
  process.exit(1);
}
