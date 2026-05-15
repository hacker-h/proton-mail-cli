import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertLivePrefix, cleanupTmpDir, closeLivePage, makeLivePrefix, openLiveInboxPage, pollBrowserMessage, prepareSessionFile, sendBrowserMessage, twoAccountTestOptions } from "./helpers.js";

let primaryTmpDir = "";
let secondaryTmpDir = "";

afterEach(() => {
  cleanupTmpDir(primaryTmpDir);
  cleanupTmpDir(secondaryTmpDir);
  primaryTmpDir = "";
  secondaryTmpDir = "";
});

describe("live Proton browser send and receive", twoAccountTestOptions, () => {
  it("sends between test accounts with To, Cc, and Bcc recipients", async () => {
    const prefix = makeLivePrefix("send");
    const primary = prepareSessionFile({ seed: false });
    const secondary = prepareSessionFile({ seed: false });
    primaryTmpDir = primary.tmpDir;
    secondaryTmpDir = secondary.tmpDir;

    const toSubject = `${prefix} to-and-cc`;
    const toBody = `${prefix} body for to and cc delivery`;
    assertLivePrefix(toSubject, prefix);
    assertLivePrefix(toBody, prefix);

    const sender = await openLiveInboxPage({ sessionFile: primary.sessionFile });
    try {
      await sendBrowserMessage(sender.page, {
        to: [process.env.PROTONMAIL_USERNAME2 || ""],
        cc: [process.env.PROTONMAIL_USERNAME || ""],
        subject: toSubject,
        body: toBody,
      });

      const bccSubject = `${prefix} bcc`;
      const bccBody = `${prefix} body for bcc delivery`;
      assertLivePrefix(bccSubject, prefix);
      assertLivePrefix(bccBody, prefix);
      await sendBrowserMessage(sender.page, {
        to: [process.env.PROTONMAIL_USERNAME || ""],
        bcc: [process.env.PROTONMAIL_USERNAME2 || ""],
        subject: bccSubject,
        body: bccBody,
      });

      const receivedTo = await pollBrowserMessage({
        sessionFile: secondary.sessionFile,
        usernameEnv: "PROTONMAIL_USERNAME2",
        passwordEnv: "PROTONMAIL_PASSWORD2",
        subject: toSubject,
        bodyText: toBody,
      });
      assert.ok(receivedTo.subject === toSubject || receivedTo.preview.includes(toSubject));

      const receivedBcc = await pollBrowserMessage({
        sessionFile: secondary.sessionFile,
        usernameEnv: "PROTONMAIL_USERNAME2",
        passwordEnv: "PROTONMAIL_PASSWORD2",
        subject: bccSubject,
        bodyText: bccBody,
      });
      assert.ok(receivedBcc.subject === bccSubject || receivedBcc.preview.includes(bccSubject));
      assert.equal(receivedBcc.bodyText.includes(process.env.PROTONMAIL_USERNAME2 || ""), false, "Bcc recipient must not be exposed in rendered body text");
    } finally {
      await closeLivePage(sender);
    }
  });
});
