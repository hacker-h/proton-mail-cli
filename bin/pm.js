#!/usr/bin/env node
import { ProtonMailBrowserClient } from "../src/browser-client.js";
import { runPmCli } from "../src/cli.js";

const exitCode = await runPmCli({
  argv: process.argv.slice(2),
  clients: {
    otp: {
      get: extractOtpFromBrowser,
    },
  },
});
process.exitCode = exitCode;

async function extractOtpFromBrowser(options) {
  const client = new ProtonMailBrowserClient({
    headless: true,
    sessionFile: options.session,
    timeoutSeconds: options.timeout || undefined,
  });
  return client.extractOtpCode({
    headless: true,
    timeoutSeconds: options.timeout || undefined,
    provider: options.provider,
    matchText: options.matchText,
    pattern: options.pattern,
    otpPattern: options.otpPattern,
    linkPattern: options.linkPattern,
    folder: options.folder,
    limit: options.limit,
  });
}
