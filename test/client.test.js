import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { ProtonMailClient, Labels, ApiError, RateLimitError } from "../src/index.js";

function mockSessionStore(options = "test-uid") {
  const config = typeof options === "string" ? { uid: options } : options;
  const uid = config.uid || "test-uid";
  const cookieHeader = config.cookieHeader ?? "AUTH-test-uid=tok; Session-Id=sid";
  const store = {
    getCookieHeader: mock.fn(async (url) => {
      if (typeof cookieHeader === "function") return cookieHeader(url);
      return cookieHeader;
    }),
    getUIDCandidates: mock.fn(async () => [uid]),
  };

  if ("refreshPayload" in config) {
    store.getRefreshPayload = mock.fn(async () => config.refreshPayload);
  }
  if ("applySetCookieHeaders" in config) {
    store.applySetCookieHeaders = mock.fn(config.applySetCookieHeaders);
  }
  if ("invalidate" in config) {
    store.invalidate = mock.fn(config.invalidate);
  }

  return store;
}

function mockFetch(status, body, headers = {}, bytes) {
  return mock.fn(async () => mockResponse({ status, body, headers, bytes }));
}

function mockFetchSequence(responses) {
  let index = 0;
  return mock.fn(async () => {
    const response = responses[index++];
    if (!response) throw new Error("Unexpected fetch call");
    if (response.throws) throw response.throws;
    return mockResponse(response);
  });
}

function mockHeaders(values = {}) {
  const normalized = Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => key !== "setCookies")
      .map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    get: (name) => normalized[name.toLowerCase()] ?? null,
    getSetCookie: () => values.setCookies || [],
  };
}

function mockResponse(response) {
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: mockHeaders(response.headers),
    text: async () => responseText(response),
    arrayBuffer: async () => responseArrayBuffer(response),
  };
}

function responseText(response) {
  if (response.text !== undefined) return response.text;
  if (response.body === undefined) return "";
  if (typeof response.body === "string") return response.body;
  return JSON.stringify(response.body);
}

function responseArrayBuffer(response) {
  if (response.bytes === undefined) return new ArrayBuffer(0);
  const bytes = response.bytes instanceof Uint8Array ? response.bytes : Buffer.from(response.bytes);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe("ProtonMailClient", () => {
  it("getUser calls /core/v4/users", async () => {
    const fetchImpl = mockFetch(200, { Code: 1000, User: { ID: "u1", Name: "test" } });
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
    });

    const user = await client.getUser();
    assert.equal(user.ID, "u1");
    assert.equal(user.Name, "test");

    const [calledUrl] = fetchImpl.mock.calls[0].arguments;
    assert.ok(calledUrl.toString().includes("/core/v4/users"));
  });

  it("getMessage calls /mail/v4/messages/:id", async () => {
    const fetchImpl = mockFetch(200, {
      Code: 1000,
      Message: { ID: "msg1", Subject: "Hello", Body: "-----BEGIN PGP MESSAGE-----" },
    });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const msg = await client.getMessage("msg1");
    assert.equal(msg.ID, "msg1");
    assert.equal(msg.Subject, "Hello");

    const [calledUrl] = fetchImpl.mock.calls[0].arguments;
    assert.ok(calledUrl.toString().includes("/mail/v4/messages/msg1"));
  });

  it("getMessageMetadata calls POST /mail/v4/messages", async () => {
    const fetchImpl = mockFetch(200, {
      Code: 1000,
      Messages: [{ ID: "m1" }, { ID: "m2" }],
      Total: 2,
    });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const result = await client.getMessageMetadata({ LabelID: Labels.INBOX });
    assert.equal(result.messages.length, 2);
    assert.equal(result.total, 2);

    const [, fetchOptions] = fetchImpl.mock.calls[0].arguments;
    assert.equal(fetchOptions.method, "POST");
  });

  it("getMessageMetadata forwards REST metadata filters", async () => {
    const fetchImpl = mockFetch(200, {
      Code: 1000,
      Messages: [{ ID: "m1", Subject: "Invoice", Sender: { Address: "billing@example.test" }, Time: 1704067200, Unread: 1 }],
      Total: 1,
    });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const result = await client.getMessageMetadata({
      Subject: "Invoice",
      From: "billing@example.test",
      To: "ops@example.test",
      LabelID: Labels.INBOX,
      Unread: 1,
      Begin: 1704067200,
      End: 1704153600,
      Sort: "Time",
      Desc: 1,
    }, 1, 25);

    assert.equal(result.messages.length, 1);
    assert.equal(result.total, 1);
    const [, fetchOptions] = fetchImpl.mock.calls[0].arguments;
    const body = JSON.parse(fetchOptions.body);
    assert.deepEqual(body, {
      Subject: "Invoice",
      From: "billing@example.test",
      To: "ops@example.test",
      LabelID: Labels.INBOX,
      Unread: 1,
      Begin: 1704067200,
      End: 1704153600,
      Sort: "ID",
      Desc: 1,
      Page: 1,
      PageSize: 25,
    });
  });

  it("markMessagesRead calls PUT /mail/v4/messages/read", async () => {
    const fetchImpl = mockFetch(200, { Code: 1000 });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    await client.markMessagesRead(["m1", "m2"]);

    const [calledUrl, fetchOptions] = fetchImpl.mock.calls[0].arguments;
    assert.ok(calledUrl.toString().includes("/mail/v4/messages/read"));
    assert.equal(fetchOptions.method, "PUT");
    const body = JSON.parse(fetchOptions.body);
    assert.deepEqual(body.IDs, ["m1", "m2"]);
  });


  it("markMessagesUnread calls PUT /mail/v4/messages/unread", async () => {
    const fetchImpl = mockFetch(200, { Code: 1000 });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    await client.markMessagesUnread(["m1"]);

    const [calledUrl, fetchOptions] = fetchImpl.mock.calls[0].arguments;
    assert.ok(calledUrl.toString().includes("/mail/v4/messages/unread"));
    assert.equal(fetchOptions.method, "PUT");
    assert.deepEqual(JSON.parse(fetchOptions.body).IDs, ["m1"]);
  });

  it("labelMessages calls PUT /mail/v4/messages/label", async () => {
    const fetchImpl = mockFetch(200, { Code: 1000 });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    await client.labelMessages(["m1"], Labels.STARRED);

    const [, fetchOptions] = fetchImpl.mock.calls[0].arguments;
    const body = JSON.parse(fetchOptions.body);
    assert.equal(body.LabelID, Labels.STARRED);
    assert.deepEqual(body.IDs, ["m1"]);
  });


  it("unlabelMessages calls PUT /mail/v4/messages/unlabel", async () => {
    const fetchImpl = mockFetch(200, { Code: 1000 });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    await client.unlabelMessages(["m1"], Labels.STARRED);

    const [calledUrl, fetchOptions] = fetchImpl.mock.calls[0].arguments;
    assert.ok(calledUrl.toString().includes("/mail/v4/messages/unlabel"));
    const body = JSON.parse(fetchOptions.body);
    assert.equal(body.LabelID, Labels.STARRED);
    assert.deepEqual(body.IDs, ["m1"]);
  });


  it("rejects invalid message mutation IDs before API calls", async () => {
    const fetchImpl = mockFetch(200, { Code: 1000 });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    await assert.rejects(() => client.markMessagesRead(["browser:index:0"]), /explicit Proton message IDs/u);
    await assert.rejects(() => client.deleteMessages([]), /non-empty array/u);
    await assert.rejects(() => client.labelMessages(["m1"], ""), /labelId/u);
    assert.equal(fetchImpl.mock.callCount(), 0);
  });

  it("getLabels calls /core/v4/labels for each type", async () => {
    const fetchImpl = mockFetch(200, { Code: 1000, Labels: [{ ID: "l1", Name: "Custom" }] });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const labels = await client.getLabels([1, 3]);
    assert.equal(labels.length, 2);
    assert.equal(labels[0].Name, "Custom");
    assert.equal(fetchImpl.mock.callCount(), 2);
    assert.equal(new URL(fetchImpl.mock.calls[0].arguments[0]).searchParams.get("Type"), "1");
    assert.equal(new URL(fetchImpl.mock.calls[1].arguments[0]).searchParams.get("Type"), "3");
  });

  it("creates, updates, and deletes labels and folders", async () => {
    const fetchImpl = mockFetchSequence([
      { status: 200, body: { Code: 1000, Label: { ID: "label1", Name: "Work", Type: 1 } } },
      { status: 200, body: { Code: 1000, Label: { ID: "folder1", Name: "Projects", Type: 3 } } },
      { status: 200, body: { Code: 1000, Label: { ID: "label1", Name: "Renamed", Type: 1 } } },
      { status: 200, body: { Code: 1000 } },
    ]);
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const label = await client.createLabel("Work", "#6d4aff", 1);
    const folder = await client.createLabel("Projects", "#008a00", 3, "parent1");
    const renamed = await client.updateLabel("label1", "Renamed", "#111111");
    await client.deleteLabel("folder1");

    assert.equal(label.ID, "label1");
    assert.equal(folder.ID, "folder1");
    assert.equal(renamed.Name, "Renamed");
    assert.deepEqual(JSON.parse(fetchImpl.mock.calls[0].arguments[1].body), { Name: "Work", Color: "#6d4aff", Type: 1 });
    assert.deepEqual(JSON.parse(fetchImpl.mock.calls[1].arguments[1].body), { Name: "Projects", Color: "#008a00", Type: 3, ParentID: "parent1" });
    assert.equal(fetchImpl.mock.calls[2].arguments[1].method, "PUT");
    assert.deepEqual(JSON.parse(fetchImpl.mock.calls[2].arguments[1].body), { Name: "Renamed", Color: "#111111" });
    assert.equal(fetchImpl.mock.calls[3].arguments[1].method, "DELETE");
  });

  it("throws ApiError on 401", async () => {
    const fetchImpl = mockFetch(401, { Code: 401, Error: "Unauthorized" });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl, maxRetries: 0 });

    await assert.rejects(() => client.getUser(), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 401);
      return true;
    });
  });

  it("throws ApiError on 404", async () => {
    const fetchImpl = mockFetch(404, { Code: 404 });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    await assert.rejects(() => client.getMessage("nope"), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 404);
      return true;
    });
  });

  it("api() passthrough works", async () => {
    const fetchImpl = mockFetch(200, { Code: 1000, Calendars: [] });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const result = await client.api("GET", "/calendar/v1");
    assert.ok(result);
    assert.ok(Array.isArray(result.Calendars));
  });

  it("getMessageCount returns counts array", async () => {
    const counts = [{ LabelID: "0", Total: 42, Unread: 3 }];
    const fetchImpl = mockFetch(200, { Code: 1000, Counts: counts });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const result = await client.getMessageCount();
    assert.deepEqual(result, counts);
  });

  it("fetches conversation lists and individual conversations", async () => {
    const fetchImpl = mockFetchSequence([
      { status: 200, body: { Code: 1000, Conversations: [{ ID: "conv1" }], Total: 1 } },
      { status: 200, body: { Code: 1000, Conversation: { ID: "conv1" } } },
    ]);
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const list = await client.getConversations({ LabelID: Labels.INBOX }, 1, 5);
    const detail = await client.getConversation("conv1");

    assert.deepEqual(list.conversations, [{ ID: "conv1" }]);
    assert.equal(list.total, 1);
    const conversation = /** @type {Record<string, unknown>} */ (detail?.Conversation || {});
    assert.equal(conversation.ID, "conv1");
    const [listUrl, listOptions] = fetchImpl.mock.calls[0].arguments;
    assert.ok(listUrl.toString().includes("/mail/v4/conversations"));
    assert.equal(listOptions.method, "POST");
    assert.deepEqual(JSON.parse(listOptions.body), { LabelID: Labels.INBOX, Page: 1, PageSize: 5, Sort: "ID" });
    const [detailUrl, detailOptions] = fetchImpl.mock.calls[1].arguments;
    assert.ok(detailUrl.toString().includes("/mail/v4/conversations/conv1"));
    assert.equal(detailOptions.method, "GET");
  });

  it("fetches latest event id and event stream payloads", async () => {
    const fetchImpl = mockFetchSequence([
      { status: 200, body: { Code: 1000, EventID: "event-1" } },
      { status: 200, body: { Code: 1000, EventID: "event-2", More: 0 } },
    ]);
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const eventId = await client.getLatestEventId();
    const events = await client.getEvents("event-1");

    assert.equal(eventId, "event-1");
    assert.equal(events?.EventID, "event-2");
    assert.equal(events?.More, 0);
    assert.ok(fetchImpl.mock.calls[0].arguments[0].toString().includes("/core/v5/events/latest"));
    assert.ok(fetchImpl.mock.calls[1].arguments[0].toString().includes("/core/v5/events/event-1"));
  });

  it("deleteMessages sends batched PUTs", async () => {
    const fetchImpl = mockFetch(200, { Code: 1000 });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const ids = Array.from({ length: 151 }, (_, i) => `m${i}`);
    await client.deleteMessages(ids);

    assert.equal(fetchImpl.mock.callCount(), 2);
    const [calledUrl, fetchOptions] = fetchImpl.mock.calls[0].arguments;
    assert.ok(calledUrl.toString().includes("/mail/v4/messages/delete"));
    assert.equal(fetchOptions.method, "PUT");
    assert.equal(JSON.parse(fetchOptions.body).IDs.length, 150);
    assert.deepEqual(JSON.parse(fetchImpl.mock.calls[1].arguments[1].body).IDs, ["m150"]);
  });

  it("returns raw attachment bytes with binary request headers", async () => {
    const bytes = Uint8Array.from([0, 1, 255, 65]);
    const fetchImpl = mockFetch(200, "", {}, bytes);
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const attachment = await client.getAttachment("att/1");

    assert.deepEqual(attachment, Buffer.from(bytes));
    const [calledUrl, fetchOptions] = fetchImpl.mock.calls[0].arguments;
    assert.ok(calledUrl.toString().includes("/mail/v4/attachments/att%2F1"));
    assert.equal(fetchOptions.method, "GET");
    assert.equal(fetchOptions.headers.Accept, "application/octet-stream");
    assert.equal(fetchOptions.headers.Cookie, "AUTH-test-uid=tok; Session-Id=sid");
    assert.equal(fetchOptions.headers["x-pm-uid"], "test-uid");
    assert.ok(fetchOptions.signal instanceof AbortSignal);
  });

  it("persists Set-Cookie headers from raw attachment responses", async () => {
    const sessionStore = mockSessionStore({
      applySetCookieHeaders: async () => undefined,
    });
    const fetchImpl = mockFetch(200, "", {
      setCookies: ["AUTH-test-uid=fresh; Path=/; HttpOnly"],
    });
    const client = new ProtonMailClient({ sessionStore, fetchImpl });

    await client.getAttachment("att1");

    assert.equal(sessionStore.applySetCookieHeaders.mock.calls.length, 1);
    const [url, cookies] = sessionStore.applySetCookieHeaders.mock.calls[0].arguments;
    assert.ok(url.includes("/mail/v4/attachments/att1"));
    assert.deepEqual(cookies, ["AUTH-test-uid=fresh; Path=/; HttpOnly"]);
  });

  it("refreshes auth and retries raw attachment fetches", async () => {
    const bytes = Uint8Array.from([9, 8, 7]);
    const refreshPayload = { RefreshToken: "refresh-token" };
    const sessionStore = mockSessionStore({
      refreshPayload,
      applySetCookieHeaders: async () => undefined,
      invalidate: async () => undefined,
    });
    const fetchImpl = mockFetchSequence([
      { status: 401, body: { Code: 401, Error: "Unauthorized" } },
      {
        status: 200,
        body: { Code: 1000 },
        headers: { setCookies: ["AUTH-test-uid=fresh; Path=/; HttpOnly"] },
      },
      { status: 200, body: "", bytes },
    ]);
    const client = new ProtonMailClient({ sessionStore, fetchImpl, maxRetries: 0 });

    const attachment = await client.getAttachment("att1");

    assert.deepEqual(attachment, Buffer.from(bytes));
    assert.equal(fetchImpl.mock.calls.length, 3);
    const [refreshUrl, refreshOptions] = fetchImpl.mock.calls[1].arguments;
    assert.ok(refreshUrl.toString().includes("/auth/refresh"));
    assert.equal(refreshOptions.method, "POST");
    assert.deepEqual(JSON.parse(refreshOptions.body), refreshPayload);
    assert.equal(sessionStore.invalidate.mock.calls.length, 1);
    assert.equal(sessionStore.applySetCookieHeaders.mock.calls.length, 1);
  });

  it("throws AUTH_EXPIRED when raw auth refresh fails", async () => {
    const sessionStore = mockSessionStore({
      refreshPayload: { RefreshToken: "refresh-token" },
    });
    const fetchImpl = mockFetchSequence([
      { status: 403, body: { Code: 403, Error: "Forbidden" } },
      { status: 401, body: { Code: 401, Error: "Refresh failed" } },
      { status: 401, body: { Code: 401, Error: "Refresh failed" } },
    ]);
    const client = new ProtonMailClient({ sessionStore, fetchImpl, maxRetries: 0 });

    await assert.rejects(() => client.getAttachment("att1"), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "AUTH_EXPIRED");
      return true;
    });

    assert.equal(fetchImpl.mock.calls.length, 3);
    assert.ok(fetchImpl.mock.calls[1].arguments[0].toString().includes("/auth/refresh"));
    assert.ok(fetchImpl.mock.calls[2].arguments[0].toString().includes("/auth/v4/refresh"));
  });

  it("backs off using Retry-After seconds before retrying 429 responses", async () => {
    const sleeps = [];
    const fetchImpl = mockFetchSequence([
      { status: 429, body: { Code: 429 }, headers: { "retry-after": "1" } },
      { status: 200, body: { Code: 1000, User: { ID: "u1" } } },
    ]);
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      sleep: async (ms) => sleeps.push(ms),
    });

    const user = await client.getUser();

    assert.equal(user.ID, "u1");
    assert.equal(fetchImpl.mock.calls.length, 2);
    assert.deepEqual(sleeps, [1000]);
  });

  it("backs off using Retry-After HTTP-date before retrying 429 responses", async () => {
    const sleeps = [];
    const retryDate = new Date(Date.now() + 2000).toUTCString();
    const fetchImpl = mockFetchSequence([
      { status: 429, body: { Code: 429 }, headers: { "retry-after": retryDate } },
      { status: 200, body: { Code: 1000, User: { ID: "u1" } } },
    ]);
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      sleep: async (ms) => sleeps.push(ms),
    });

    await client.getUser();

    assert.equal(fetchImpl.mock.calls.length, 2);
    assert.ok(sleeps[0] > 0);
    assert.ok(sleeps[0] <= 2000);
  });

  it("uses configurable exponential backoff when Retry-After is absent", async () => {
    const sleeps = [];
    const fetchImpl = mockFetchSequence([
      { status: 429, body: { Code: 429 } },
      { status: 200, body: { Code: 1000, User: { ID: "u1" } } },
    ]);
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      sleep: async (ms) => sleeps.push(ms),
      rateLimit: { baseDelayMs: 25, maxDelayMs: 50, jitterRatio: 0 },
    });

    await client.getUser();

    assert.deepEqual(sleeps, [25]);
  });

  it("throws RateLimitError when the 429 retry budget is exhausted", async () => {
    const sleeps = [];
    const fetchImpl = mockFetchSequence([
      { status: 429, body: { Code: 429 }, headers: { "retry-after": "2" } },
      { status: 429, body: { Code: 429 }, headers: { "retry-after": "2" } },
    ]);
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      sleep: async (ms) => sleeps.push(ms),
      rateLimit: { maxRetries: 1 },
    });

    await assert.rejects(() => client.getUser(), (err) => {
      assert.ok(err instanceof RateLimitError);
      assert.equal(err.status, 429);
      assert.equal(err.code, "RATE_LIMITED");
      assert.equal(err.retryAfter, 2);
      assert.equal(err.retryAfterMs, 2000);
      return true;
    });
    assert.deepEqual(sleeps, [2000]);
  });

  it("backs off 429 responses for raw attachment fetches", async () => {
    const sleeps = [];
    const fetchImpl = mockFetchSequence([
      { status: 429, body: "", headers: { "retry-after": "1" } },
      { status: 200, body: "" },
    ]);
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      sleep: async (ms) => sleeps.push(ms),
    });

    const attachment = await client.getAttachment("att1");

    assert.equal(attachment.length, 0);
    assert.equal(fetchImpl.mock.calls.length, 2);
    assert.deepEqual(sleeps, [1000]);
  });

  it("backs off 5xx responses for raw attachment fetches", async () => {
    const sleeps = [];
    const bytes = Uint8Array.from([4, 2]);
    const fetchImpl = mockFetchSequence([
      { status: 503, body: "" },
      { status: 200, body: "", bytes },
    ]);
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      sleep: async (ms) => sleeps.push(ms),
    });

    const attachment = await client.getAttachment("att1");

    assert.deepEqual(attachment, Buffer.from(bytes));
    assert.equal(fetchImpl.mock.calls.length, 2);
    assert.deepEqual(sleeps, [400]);
  });

  it("throws RateLimitError when raw attachment rate-limit budget is exhausted", async () => {
    const sleeps = [];
    const fetchImpl = mockFetchSequence([
      { status: 429, body: "", headers: { "retry-after": "2" } },
      { status: 429, body: "", headers: { "retry-after": "2" } },
    ]);
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      sleep: async (ms) => sleeps.push(ms),
      rateLimit: { maxRetries: 1 },
    });

    await assert.rejects(() => client.getAttachment("att1"), (err) => {
      assert.ok(err instanceof RateLimitError);
      assert.equal(err.status, 429);
      assert.equal(err.code, "RATE_LIMITED");
      assert.equal(err.retryAfter, 2);
      assert.equal(err.retryAfterMs, 2000);
      return true;
    });
    assert.deepEqual(sleeps, [2000]);
  });

  it("throws structured errors for raw attachment failures", async () => {
    const notFoundClient = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl: mockFetch(404, { Code: 404, Error: "Not found" }),
    });

    await assert.rejects(() => notFoundClient.getAttachment("missing"), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 404);
      assert.equal(err.code, "NOT_FOUND");
      return true;
    });

    const failedClient = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl: mockFetch(400, { Code: 400, Error: "Bad request" }),
    });

    await assert.rejects(() => failedClient.getAttachment("bad"), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "UPSTREAM_ERROR");
      assert.equal(err.message, "Attachment fetch failed: 400");
      assert.deepEqual(err.details.payload, { Code: 400, Error: "Bad request" });
      return true;
    });
  });

  it("uses deterministic backoff for raw 429 responses without Retry-After", async () => {
    const sleeps = [];
    const fetchImpl = mockFetchSequence([
      { status: 429, body: { Code: 429 } },
      { status: 200, body: "", bytes: Uint8Array.from([1]) },
    ]);
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      sleep: async (ms) => sleeps.push(ms),
      rateLimit: { baseDelayMs: 100, maxDelayMs: 100, jitterRatio: 0.2 },
    });

    await client.getAttachment("att1");

    // See src/http.js pseudoRandom01(1) => ((1 * 1103515245 + 12345) >>> 0) / 2^32 ≈ 0.2569
    assert.deepEqual(sleeps, [105]);
  });

  it("wraps raw attachment timeout errors", async () => {
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    const fetchImpl = mockFetchSequence([{ throws: timeout }]);
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      maxRetries: 0,
    });

    await assert.rejects(() => client.getAttachment("att1"), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 502);
      assert.equal(err.code, "UPSTREAM_UNREACHABLE");
      assert.equal(err.details.message, "The operation timed out");
      return true;
    });
  });
});
