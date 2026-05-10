import fs from "node:fs";

/**
 * @typedef {{ name: string, value: string, domain?: string, path?: string, expires?: number, secure?: boolean, httpOnly?: boolean, sameSite?: string }} RestCookie
 * @typedef {{ uid: string, cookies: RestCookie[], refreshPayloads: Record<string, unknown> }} RestSessionState
 * @typedef {(filePath: string, encoding: BufferEncoding) => string} ReadFileLike
 * @typedef {(filePath: string, data: string, options?: { mode?: number }) => void} WriteFileLike
 */

export class FileSessionStore {
  /** @type {string} */
  #filePath;
  /** @type {ReadFileLike} */
  #readFile;
  /** @type {WriteFileLike} */
  #writeFile;
  /** @type {RestSessionState | null} */
  #state = null;

  /**
   * @param {string} filePath
   * @param {{ readFile?: ReadFileLike, writeFile?: WriteFileLike }} [options]
   */
  constructor(filePath, { readFile = fs.readFileSync, writeFile = fs.writeFileSync } = {}) {
    this.#filePath = filePath;
    this.#readFile = readFile;
    this.#writeFile = writeFile;
  }

  /** @param {string} url */
  async getCookieHeader(url) {
    const target = new URL(url);
    const nowSeconds = Date.now() / 1000;
    return this.#load().cookies
      .filter((cookie) => cookie && cookie.name && cookie.value)
      .filter((cookie) => domainMatches(target.hostname, cookie.domain))
      .filter((cookie) => pathMatches(target.pathname, cookie.path))
      .filter((cookie) => !cookie.expires || cookie.expires > nowSeconds)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  /** @returns {Promise<string[]>} */
  async getUIDCandidates() {
    const state = this.#load();
    const candidates = new Set();
    if (state.uid) candidates.add(state.uid);
    for (const cookie of state.cookies) {
      const match = /^AUTH-(.+)$/u.exec(cookie?.name || "");
      if (match) candidates.add(match[1]);
    }
    return [...candidates];
  }

  /** @returns {Promise<string>} */
  async getUID() {
    return this.#load().uid || (await this.getUIDCandidates())[0] || "";
  }

  /** @param {string} uid */
  async getRefreshPayload(uid) {
    return this.#load().refreshPayloads?.[uid] || null;
  }

  /**
   * @param {string} url
   * @param {string[]} headers
   */
  async applySetCookieHeaders(url, headers) {
    const target = new URL(url);
    const state = this.#load();
    for (const header of headers || []) {
      const cookie = parseSetCookieHeader(header, target.hostname);
      if (!cookie) continue;
      state.cookies = state.cookies.filter((existing) => {
        return existing.name !== cookie.name || existing.domain !== cookie.domain || existing.path !== cookie.path;
      });
      state.cookies.push(cookie);
    }
    this.#persist(state);
  }

  async invalidate() {
    this.#state = null;
  }

  /** @returns {RestSessionState} */
  #load() {
    if (this.#state) return this.#state;
    const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(this.#readFile(this.#filePath, "utf8")));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("REST session store must contain a JSON object");
    }
    this.#state = {
      uid: typeof parsed.uid === "string" ? parsed.uid : "",
      cookies: Array.isArray(parsed.cookies) ? /** @type {RestCookie[]} */ (parsed.cookies) : [],
      refreshPayloads: parsed.refreshPayloads && typeof parsed.refreshPayloads === "object" ? /** @type {Record<string, unknown>} */ (parsed.refreshPayloads) : {},
    };
    return this.#state;
  }

  /** @param {RestSessionState} state */
  #persist(state) {
    this.#writeFile(this.#filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
}

/**
 * @param {string} hostname
 * @param {string} [domain]
 */
function domainMatches(hostname, domain = hostname) {
  const normalizedHost = hostname.toLowerCase();
  const normalizedDomain = String(domain || hostname).replace(/^\./u, "").toLowerCase();
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

/**
 * @param {string} pathname
 * @param {string} [cookiePath]
 */
function pathMatches(pathname, cookiePath = "/") {
  return pathname.startsWith(cookiePath || "/");
}

/**
 * @param {string} header
 * @param {string} fallbackDomain
 * @returns {RestCookie | null}
 */
function parseSetCookieHeader(header, fallbackDomain) {
  const parts = String(header || "").split(";").map((part) => part.trim()).filter(Boolean);
  const [pair, ...attributes] = parts;
  if (!pair || !pair.includes("=")) return null;
  const index = pair.indexOf("=");
  /** @type {RestCookie} */
  const cookie = {
    name: pair.slice(0, index),
    value: pair.slice(index + 1),
    domain: fallbackDomain,
    path: "/",
  };
  for (const attribute of attributes) {
    const [rawName, rawValue = ""] = attribute.split("=");
    const name = rawName.toLowerCase();
    if (name === "domain") cookie.domain = rawValue;
    if (name === "path") cookie.path = rawValue || "/";
    if (name === "expires") cookie.expires = Date.parse(rawValue) / 1000;
    if (name === "secure") cookie.secure = true;
    if (name === "httponly") cookie.httpOnly = true;
    if (name === "samesite") cookie.sameSite = rawValue;
  }
  return cookie;
}
