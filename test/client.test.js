import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { ProtonMailClient, Labels, ApiError, RateLimitError } from "../src/index.js";

function mockSessionStore(uid = "test-uid") {
  return {
    getCookieHeader: mock.fn(async () => "AUTH-test-uid=tok; Session-Id=sid"),
    getUIDCandidates: mock.fn(async () => [uid]),
  };
}

function mockFetch(status, body, headers = {}) {
  return mock.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: mockHeaders(headers),
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
}

function mockFetchSequence(responses) {
  let index = 0;
  return mock.fn(async () => {
    const response = responses[index++];
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: mockHeaders(response.headers),
      text: async () => JSON.stringify(response.body),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  });
}

function mockHeaders(values = {}) {
  return {
    get: (name) => values[name.toLowerCase()] ?? null,
    getSetCookie: () => [],
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
      assert.equal(err.retryAfter, 2);
      assert.equal(err.retryAfterMs, 2000);
      return true;
    });
    assert.deepEqual(sleeps, [2000]);
  });
});
