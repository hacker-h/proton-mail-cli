import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { extractOtpWithPolling } from "../src/otp-runner.js";

describe("OTP polling runner", () => {
  it("calls the extractor once when polling is not requested", async () => {
    const extract = mock.fn(async () => ({ success: false, error: "No matching Proton Mail message found" }));
    const sleep = mock.fn(async () => {});

    const result = await extractOtpWithPolling({ timeout: 10 }, extract, { sleep });

    assert.deepEqual(result, { success: false, error: "No matching Proton Mail message found" });
    assert.equal(extract.mock.callCount(), 1);
    assert.equal(sleep.mock.callCount(), 0);
  });

  it("returns a successful OTP result without sleeping", async () => {
    const extract = mock.fn(async () => ({ success: true, code: "123456" }));
    const sleep = mock.fn(async () => {});

    const result = await extractOtpWithPolling({ pollInterval: 1, timeout: 10 }, extract, { sleep });

    assert.deepEqual(result, { success: true, code: "123456" });
    assert.equal(extract.mock.callCount(), 1);
    assert.equal(sleep.mock.callCount(), 0);
  });

  it("retries no-match results until an OTP appears", async () => {
    let nowMs = 0;
    let attempts = 0;
    const sleep = mock.fn(async (ms) => { nowMs += ms; });
    const extract = mock.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? { success: false, error: "No matching Proton Mail message found" }
        : { success: true, code: "654321" };
    });

    const result = await extractOtpWithPolling({ pollInterval: 2, timeout: 10 }, extract, {
      sleep,
      now: () => nowMs,
    });

    assert.deepEqual(result, { success: true, code: "654321" });
    assert.equal(extract.mock.callCount(), 2);
    assert.equal(sleep.mock.callCount(), 1);
    assert.equal(sleep.mock.calls[0].arguments[0], 2000);
  });

  it("times out with redacted metadata when no retryable result succeeds", async () => {
    let nowMs = 0;
    const sleep = mock.fn(async (ms) => { nowMs += ms; });
    const extract = mock.fn(async () => ({ success: false, error: "Matching email found, but no OTP code or link was present" }));

    const result = await extractOtpWithPolling({ pollInterval: 2, timeout: 3 }, extract, {
      sleep,
      now: () => nowMs,
    });

    assert.equal(result.success, false);
    assert.equal(result.timeout, true);
    assert.equal(result.timeoutSeconds, 3);
    assert.equal(result.error, "Timed out waiting for matching Proton Mail OTP or link");
    assert.equal(result.lastError, "Matching email found, but no OTP code or link was present");
    assert.equal(extract.mock.callCount(), 3);
    assert.deepEqual(sleep.mock.calls.map((call) => call.arguments[0]), [2000, 1000]);
  });

  it("does not retry auth or setup failures", async () => {
    const sleep = mock.fn(async () => {});
    const extract = mock.fn(async () => ({ success: false, error: "Missing Proton Mail credentials" }));

    const result = await extractOtpWithPolling({ pollInterval: 1, timeout: 10 }, extract, { sleep });

    assert.deepEqual(result, { success: false, error: "Missing Proton Mail credentials" });
    assert.equal(extract.mock.callCount(), 1);
    assert.equal(sleep.mock.callCount(), 0);
  });
});
