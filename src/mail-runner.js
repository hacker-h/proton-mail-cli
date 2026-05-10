/**
 * @param {unknown[]} messages
 * @param {string | RegExp | undefined} matchText
 */
export function filterMailMessages(messages, matchText) {
  return messages.filter((message) => matchesPreview(message, matchText));
}

/**
 * @param {Record<string, unknown>} options
 * @returns {Record<string, unknown>}
 */
export function buildMailMetadataFilter(options) {
  /** @type {Record<string, unknown>} */
  const filter = {};
  if (typeof options.subject === "string" && options.subject) filter.Subject = options.subject;
  if (typeof options.from === "string" && options.from) filter.From = options.from;
  if (typeof options.to === "string" && options.to) filter.To = options.to;
  if (typeof options.labelId === "string" && options.labelId) filter.LabelID = options.labelId;
  if (options.unread === true) filter.Unread = 1;
  if (options.read === true) filter.Unread = 0;
  if (typeof options.after === "number") filter.Begin = options.after;
  if (typeof options.before === "number") filter.End = options.before;
  return filter;
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
