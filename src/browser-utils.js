export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

export function truncate(value, max = 200) {
  const text = normalizeText(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
