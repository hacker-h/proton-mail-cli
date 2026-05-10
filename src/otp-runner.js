import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_POLL_TIMEOUT_SECONDS = 60;

/**
 * @typedef {{ pollInterval?: number, timeout?: number | null }} OtpPollingOptions
 * @typedef {(options: OtpPollingOptions) => Promise<unknown>} OtpExtractor
 * @typedef {{ sleep?: (ms: number) => Promise<unknown>, now?: () => number }} OtpPollingRuntime
 */

/**
 * @param {OtpPollingOptions} options
 * @param {OtpExtractor} extract
 * @param {OtpPollingRuntime} [runtime]
 * @returns {Promise<unknown>}
 */
export async function extractOtpWithPolling(options, extract, runtime = {}) {
  const pollIntervalSeconds = positiveInteger(options.pollInterval, 0);
  if (!pollIntervalSeconds) {
    return extract(options);
  }

  const now = runtime.now || Date.now;
  const wait = runtime.sleep || sleep;
  const timeoutSeconds = positiveInteger(options.timeout, DEFAULT_POLL_TIMEOUT_SECONDS);
  const deadline = now() + timeoutSeconds * 1000;
  let lastResult = null;

  while (true) {
    lastResult = await extract(options);
    if (!isRetryableOtpResult(lastResult)) {
      return lastResult;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return timeoutResult(lastResult, timeoutSeconds);
    }

    await wait(Math.min(pollIntervalSeconds * 1000, remainingMs));
  }
}

/** @param {unknown} result */
function isRetryableOtpResult(result) {
  const object = toRecord(result);
  if (object.success !== false) return false;
  const message = String(object.error || "");
  return /No matching Proton Mail message found|Matching email found, but no/iu.test(message);
}

/**
 * @param {unknown} result
 * @param {number} timeoutSeconds
 */
function timeoutResult(result, timeoutSeconds) {
  const object = toRecord(result);
  return {
    ...object,
    success: false,
    timeout: true,
    timeoutSeconds,
    lastError: object.error || null,
    error: "Timed out waiting for matching Proton Mail OTP or link",
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** @param {unknown} value */
function toRecord(value) {
  return value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : {};
}
