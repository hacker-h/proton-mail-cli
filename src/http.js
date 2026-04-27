import { setTimeout as delay } from "node:timers/promises";
import { ApiError } from "./errors.js";
import {
  DEFAULT_API_URL,
  DEFAULT_APP_VERSION,
  SUCCESS_CODES,
  AUTH_REFRESH_PATHS,
} from "./constants.js";

export class ProtonHttp {
  #baseUrl;
  #appVersion;
  #locale;
  #fetchImpl;
  #timeoutMs;
  #maxRetries;
  #sessionStore;
  #debugHttp;

  constructor(options) {
    this.#baseUrl = new URL(options.baseUrl || DEFAULT_API_URL);
    this.#appVersion = options.appVersion || DEFAULT_APP_VERSION;
    this.#locale = options.locale || "en-US";
    this.#fetchImpl = options.fetchImpl || fetch;
    this.#timeoutMs = options.timeoutMs || 30000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#sessionStore = options.sessionStore;
    this.#debugHttp = Boolean(options.debugHttp);
  }

  async request(method, pathname, options = {}) {
    const uid = options.uid || (await this.#resolveUID());
    const url = new URL(pathname, this.#baseUrl);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers = {
      Accept: "application/vnd.protonmail.v1+json",
      "x-pm-appversion": this.#appVersion,
      "x-pm-locale": this.#locale,
      "x-pm-uid": uid,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    let authRefreshAttempted = false;
    let attempt = 0;

    while (attempt <= this.#maxRetries) {
      const isFinal = attempt === this.#maxRetries;
      attempt++;

      try {
        const cookieHeader = await this.#sessionStore.getCookieHeader(url.toString());
        if (!cookieHeader) {
          throw new ApiError(401, "AUTH_EXPIRED", "No valid session cookies available");
        }

        const response = await this.#fetchImpl(url, {
          method,
          headers: { ...headers, Cookie: cookieHeader },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        await this.#persistSetCookies(url, response);
        const payload = await parsePayload(response);

        if (response.status === 401 || response.status === 403) {
          if (!authRefreshAttempted) {
            authRefreshAttempted = true;
            const refreshed = await this.#attemptAuthRefresh(uid);
            if (refreshed) {
              attempt--;
              continue;
            }
          }
          throw new ApiError(401, "AUTH_EXPIRED", "Proton session is expired or unauthorized");
        }

        if (response.status === 404) {
          throw new ApiError(404, "NOT_FOUND", "Resource not found");
        }

        if ((response.status === 429 || response.status >= 500) && !isFinal) {
          await delay(backoffMs(attempt));
          continue;
        }

        if (!response.ok) {
          throw new ApiError(response.status, "UPSTREAM_ERROR", "Upstream request failed", { payload });
        }

        if (payload && typeof payload === "object" && typeof payload.Code === "number") {
          if (!SUCCESS_CODES.includes(payload.Code)) {
            throw new ApiError(502, "UPSTREAM_ERROR", payload.Error || "Unexpected upstream response", { payload });
          }
        }

        return payload;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (isFinal) {
          throw new ApiError(502, "UPSTREAM_UNREACHABLE", "Unable to reach Proton backend", {
            message: error?.message,
          });
        }
        await delay(backoffMs(attempt));
      }
    }

    throw new ApiError(502, "UPSTREAM_UNREACHABLE", "Unable to reach Proton backend");
  }

  async requestRaw(method, pathname, options = {}) {
    const uid = options.uid || (await this.#resolveUID());
    const url = new URL(pathname, this.#baseUrl);

    const headers = {
      Accept: "application/octet-stream",
      "x-pm-appversion": this.#appVersion,
      "x-pm-locale": this.#locale,
      "x-pm-uid": uid,
    };

    const cookieHeader = await this.#sessionStore.getCookieHeader(url.toString());
    if (!cookieHeader) {
      throw new ApiError(401, "AUTH_EXPIRED", "No valid session cookies available");
    }

    const response = await this.#fetchImpl(url, {
      method,
      headers: { ...headers, Cookie: cookieHeader },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (!response.ok) {
      throw new ApiError(response.status, "UPSTREAM_ERROR", `Attachment fetch failed: ${response.status}`);
    }

    return response;
  }

  async #resolveUID() {
    if (typeof this.#sessionStore.getUID === "function") {
      return this.#sessionStore.getUID();
    }

    const candidates = await this.#sessionStore.getUIDCandidates();
    if (!candidates || candidates.length === 0) {
      throw new ApiError(401, "UID_MISSING", "No UID available in session store");
    }
    return candidates[0];
  }

  async #attemptAuthRefresh(uid) {
    for (const refreshPath of AUTH_REFRESH_PATHS) {
      try {
        const refreshPayload = await this.#extractRefreshPayload(uid);
        if (!refreshPayload) return false;

        const refreshUrl = new URL(refreshPath, this.#baseUrl);
        const cookieHeader = await this.#sessionStore.getCookieHeader(refreshUrl.toString());
        if (!cookieHeader) continue;

        const response = await this.#fetchImpl(refreshUrl, {
          method: "POST",
          headers: {
            Accept: "application/vnd.protonmail.v1+json",
            Cookie: cookieHeader,
            "Content-Type": "application/json",
            "x-pm-appversion": this.#appVersion,
            "x-pm-locale": this.#locale,
            "x-pm-uid": uid,
          },
          body: JSON.stringify(refreshPayload),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        await this.#persistSetCookies(refreshUrl, response);

        if (!response.ok) continue;

        const payload = await parsePayload(response);
        if (payload?.Code && !SUCCESS_CODES.includes(payload.Code)) continue;

        if (typeof this.#sessionStore.invalidate === "function") {
          await this.#sessionStore.invalidate();
        }

        this.#log("Auth refresh succeeded", { path: refreshPath });
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  async #extractRefreshPayload(uid) {
    if (typeof this.#sessionStore.getRefreshPayload === "function") {
      return this.#sessionStore.getRefreshPayload(uid);
    }
    return null;
  }

  async #persistSetCookies(url, response) {
    if (typeof this.#sessionStore.applySetCookieHeaders !== "function") return;

    const setCookies = getSetCookieHeaders(response.headers);
    if (setCookies.length > 0) {
      await this.#sessionStore.applySetCookieHeaders(url.toString(), setCookies);
    }
  }

  #log(message, details) {
    if (!this.#debugHttp) return;
    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    console.log(`[protonmail-http] ${message}${suffix}`);
  }
}

function getSetCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") {
    const values = headers.getSetCookie();
    if (Array.isArray(values)) return values.filter((v) => typeof v === "string" && v.length > 0);
  }
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

async function parsePayload(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function backoffMs(attempt) {
  return Math.min(3000, 200 * 2 ** attempt);
}
