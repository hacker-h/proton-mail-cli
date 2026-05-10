#!/usr/bin/env node
import { ProtonMailBrowserClient } from "../src/browser-client.js";
import { runPmCli } from "../src/cli.js";
import { extractOtpWithPolling } from "../src/otp-runner.js";

const exitCode = await runPmCli({
  argv: process.argv.slice(2),
  clients: {
    mail: {
      list: listMailFromBrowser,
      latest: latestMailFromBrowser,
    },
    otp: {
      get: extractOtpFromBrowser,
    },
  },
});
process.exitCode = exitCode;

async function listMailFromBrowser(options) {
  const client = browserClient(options);
  const result = await client.getInboxMessages(browserOptions(options));
  return { ...result, source: "browser" };
}

async function latestMailFromBrowser(options) {
  const client = browserClient(options);
  const result = await client.getLatestMessage(browserOptions(options));
  return { ...result, source: "browser" };
}

async function extractOtpFromBrowser(options) {
  const client = browserClient(options);
  return extractOtpWithPolling(options, (attemptOptions) => client.extractOtpCode({
    ...browserOptions(attemptOptions),
    provider: attemptOptions.provider,
    pattern: attemptOptions.pattern,
    otpPattern: attemptOptions.otpPattern,
    linkPattern: attemptOptions.linkPattern,
  }));
}

function browserClient(options) {
  return new ProtonMailBrowserClient({
    headless: true,
    sessionFile: options.session,
    timeoutSeconds: options.timeout || undefined,
  });
}

function browserOptions(options) {
  return {
    headless: true,
    timeoutSeconds: options.timeout || undefined,
    matchText: options.matchText,
    folder: options.folder,
    limit: options.limit,
  };
}
