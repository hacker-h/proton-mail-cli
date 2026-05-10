#!/usr/bin/env node
import { ProtonMailBrowserClient } from "../src/browser-client.js";
import { runPmCli } from "../src/cli.js";
import { extractOtpWithPolling } from "../src/otp-runner.js";

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
  return extractOtpWithPolling(options, (attemptOptions) => client.extractOtpCode({
    headless: true,
    timeoutSeconds: attemptOptions.timeout || undefined,
    provider: attemptOptions.provider,
    matchText: attemptOptions.matchText,
    pattern: attemptOptions.pattern,
    otpPattern: attemptOptions.otpPattern,
    linkPattern: attemptOptions.linkPattern,
    folder: attemptOptions.folder,
    limit: attemptOptions.limit,
  }));
}
