/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function truncate(value, max = 200) {
  const text = normalizeText(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
