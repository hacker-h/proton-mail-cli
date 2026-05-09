import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { ProtonMailClient, Labels, ApiError, RateLimitError } from "../src/index.js";

function mockSessionStore(uid = "test-uid") {
  return {
    getCookieHeader: mock.fn(async () => "AUTH-test-uid=tok; Session-Id=sid"),
    getUIDCandidates: mock.fn(async () => [uid]),
  };
}

function mockFetch(status, body) {
  return mock.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
}

function mockResponse(status, body, headers = {}) {
  const normalizedHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => normalizedHeaders.get(String(name).toLowerCase()) || null,
      getSetCookie: () => [],
    },
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
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

  it("labelMessages calls PUT /mail/v4/messages/label", async () => {
    const fetchImpl = mockFetch(200, { Code: 1000 });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    await client.labelMessages(["m1"], Labels.STARRED);

    const [, fetchOptions] = fetchImpl.mock.calls[0].arguments;
    const body = JSON.parse(fetchOptions.body);
    assert.equal(body.LabelID, Labels.STARRED);
    assert.deepEqual(body.IDs, ["m1"]);
  });

  it("getLabels calls /core/v4/labels for each type", async () => {
    const fetchImpl = mockFetch(200, { Code: 1000, Labels: [{ ID: "l1", Name: "Custom" }] });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const labels = await client.getLabels([1]);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].Name, "Custom");
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

  it("backs off using Retry-After before retrying 429 responses", async () => {
    const waits = [];
    let calls = 0;
    const fetchImpl = mock.fn(async () => {
      calls++;
      if (calls === 1) {
        return mockResponse(429, { Code: 429, Error: "Too many requests" }, { "Retry-After": "2" });
      }
      return mockResponse(200, { Code: 1000, User: { ID: "u1" } });
    });
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      delayImpl: async (ms) => waits.push(ms),
      rateLimit: { maxRetries: 1 },
    });

    const user = await client.getUser();

    assert.equal(user.ID, "u1");
    assert.deepEqual(waits, [2000]);
    assert.equal(fetchImpl.mock.calls.length, 2);
  });

  it("uses configurable exponential backoff when Retry-After is absent", async () => {
    const waits = [];
    let calls = 0;
    const fetchImpl = mock.fn(async () => {
      calls++;
      if (calls === 1) {
        return mockResponse(429, { Code: 429 });
      }
      return mockResponse(200, { Code: 1000, User: { ID: "u1" } });
    });
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      delayImpl: async (ms) => waits.push(ms),
      rateLimit: { maxRetries: 1, baseDelayMs: 25, maxDelayMs: 1000, jitterMs: 0 },
    });

    await client.getUser();

    assert.deepEqual(waits, [25]);
    assert.equal(fetchImpl.mock.calls.length, 2);
  });

  it("throws RateLimitError when the 429 retry budget is exhausted", async () => {
    const fetchImpl = mock.fn(async () => mockResponse(429, { Code: 429 }, { "Retry-After": "1" }));
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      delayImpl: async () => {},
      rateLimit: { maxRetries: 0 },
    });

    await assert.rejects(() => client.getUser(), (err) => {
      assert.ok(err instanceof RateLimitError);
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 429);
      assert.equal(err.code, "RATE_LIMITED");
      assert.equal(err.retryAfter, 1000);
      return true;
    });
  });

  it("parses HTTP-date Retry-After values", async () => {
    const waits = [];
    const retryDate = new Date(Date.now() + 50).toUTCString();
    let calls = 0;
    const fetchImpl = mock.fn(async () => {
      calls++;
      if (calls === 1) {
        return mockResponse(429, { Code: 429 }, { "Retry-After": retryDate });
      }
      return mockResponse(200, { Code: 1000, User: { ID: "u1" } });
    });
    const client = new ProtonMailClient({
      sessionStore: mockSessionStore(),
      fetchImpl,
      delayImpl: async (ms) => waits.push(ms),
      rateLimit: { maxRetries: 1 },
    });

    await client.getUser();

    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 0);
    assert.ok(waits[0] <= 1000);
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

  it("deleteMessages sends batched PUTs", async () => {
    const fetchImpl = mockFetch(200, { Code: 1000 });
    const client = new ProtonMailClient({ sessionStore: mockSessionStore(), fetchImpl });

    const ids = Array.from({ length: 5 }, (_, i) => `m${i}`);
    await client.deleteMessages(ids);

    const [calledUrl, fetchOptions] = fetchImpl.mock.calls[0].arguments;
    assert.ok(calledUrl.toString().includes("/mail/v4/messages/delete"));
    assert.equal(fetchOptions.method, "PUT");
  });
});
