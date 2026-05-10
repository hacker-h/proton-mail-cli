/**
 * @param {unknown[]} messages
 * @param {string | RegExp | undefined} matchText
 */
export function filterMailMessages(messages, matchText) {
  return messages.filter((message) => matchesPreview(message, matchText));
}

/** @param {string} ref */
export function parseBrowserMessageRef(ref) {
  const match = /^browser:index:(\d+)$/u.exec(ref);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * @param {unknown} message
 * @param {string | RegExp | undefined} matchText
 */
function matchesPreview(message, matchText) {
  const object = message && typeof message === "object" ? /** @type {Record<string, unknown>} */ (message) : {};
  const preview = typeof object.preview === "string" ? object.preview : "";
  if (matchText instanceof RegExp) {
    matchText.lastIndex = 0;
    return matchText.test(preview);
  }
  return typeof matchText === "string" && preview.toLowerCase().includes(matchText.toLowerCase());
}
