export class MemorySessionStore {
  #state;

  constructor(state = {}) {
    this.#state = {
      uid: state.uid || "",
      cookies: Array.isArray(state.cookies) ? [...state.cookies] : [],
      refreshPayloads: { ...(state.refreshPayloads || {}) },
    };
  }

  async getCookieHeader(url) {
    const target = new URL(url);
    const nowSeconds = Date.now() / 1000;
    return this.#state.cookies
      .filter((cookie) => cookie && cookie.name && cookie.value)
      .filter((cookie) => domainMatches(target.hostname, cookie.domain))
      .filter((cookie) => pathMatches(target.pathname, cookie.path))
      .filter((cookie) => !cookie.expires || cookie.expires > nowSeconds)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  async getUIDCandidates() {
    const candidates = new Set();
    if (this.#state.uid) {
      candidates.add(this.#state.uid);
    }
    for (const cookie of this.#state.cookies) {
      const match = /^AUTH-(.+)$/u.exec(cookie?.name || "");
      if (match) {
        candidates.add(match[1]);
      }
    }
    return [...candidates];
  }

  async getUID() {
    if (this.#state.uid) {
      return this.#state.uid;
    }
    return (await this.getUIDCandidates())[0] || "";
  }

  async applySetCookieHeaders(url, headers) {
    const target = new URL(url);
    for (const header of headers || []) {
      const cookie = parseSetCookieHeader(header, target.hostname);
      if (!cookie) {
        continue;
      }
      this.#state.cookies = this.#state.cookies.filter((existing) => {
        return existing.name !== cookie.name || existing.domain !== cookie.domain || existing.path !== cookie.path;
      });
      this.#state.cookies.push(cookie);
    }
    return this.snapshot();
  }

  async getRefreshPayload(uid) {
    return this.#state.refreshPayloads[uid] || null;
  }

  async invalidate() {
    return undefined;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.#state));
  }
}

function domainMatches(hostname, domain = hostname) {
  const normalizedHost = hostname.toLowerCase();
  const normalizedDomain = String(domain || hostname).replace(/^\./u, "").toLowerCase();
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function pathMatches(pathname, cookiePath = "/") {
  return pathname.startsWith(cookiePath || "/");
}

function parseSetCookieHeader(header, fallbackDomain) {
  const parts = String(header || "").split(";").map((part) => part.trim()).filter(Boolean);
  const [pair, ...attributes] = parts;
  if (!pair || !pair.includes("=")) {
    return null;
  }
  const index = pair.indexOf("=");
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
