#!/usr/bin/env node
import { ProtonMailBrowserClient } from "../src/browser-client.js";
import { runPmCli } from "../src/cli.js";
import { filterMailMessages, parseBrowserMessageRef } from "../src/mail-runner.js";
import { extractOtpWithPolling } from "../src/otp-runner.js";

const exitCode = await runPmCli({
  argv: process.argv.slice(2),
  clients: {
    mail: {
      list: listMailFromBrowser,
      latest: latestMailFromBrowser,
      search: searchMailFromBrowser,
      read: readMailFromBrowser,
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

async function searchMailFromBrowser(options) {
  const client = browserClient(options);
  const result = await client.getInboxMessages(browserOptions(options));
  if (result?.success === false) return { ...result, source: "browser" };

  const messages = Array.isArray(result?.messages) ? filterMailMessages(result.messages, options.matchText) : [];
  return {
    ...result,
    source: "browser",
    messages,
  };
}

async function readMailFromBrowser(messageRef, options) {
  const index = parseBrowserMessageRef(messageRef);
  if (index === null) {
    return {
      success: false,
      error: "pm read currently supports browser:index:N refs emitted by pm ls and pm mail search",
    };
  }

  const client = browserClient(options);
  const result = await client.getLatestMessage({
    ...browserOptions(options),
    matchText: (message) => message.index === index,
  });
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
