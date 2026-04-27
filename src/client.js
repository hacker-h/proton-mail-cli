import { ProtonHttp } from "./http.js";
import { MAX_PAGE_SIZE, MAX_BATCH_IDS } from "./constants.js";

export class ProtonMailClient {
  #http;
  #uid;

  constructor(options) {
    this.#http = new ProtonHttp(options);
    this.#uid = options.uid || null;
  }

  async getUser() {
    const payload = await this.#http.request("GET", "/core/v4/users", { uid: this.#uid });
    return payload?.User;
  }

  async getAddresses() {
    const payload = await this.#http.request("GET", "/core/v4/addresses", { uid: this.#uid });
    return payload?.Addresses || [];
  }

  async getKeySalts() {
    const payload = await this.#http.request("GET", "/core/v4/keys/salts", { uid: this.#uid });
    return payload?.KeySalts || [];
  }

  async getMessage(messageId) {
    const payload = await this.#http.request("GET", `/mail/v4/messages/${enc(messageId)}`, {
      uid: this.#uid,
    });
    return payload?.Message;
  }

  async getMessageMetadata(filter = {}, page = 0, pageSize = MAX_PAGE_SIZE) {
    // POST with body is the canonical way Proton lists messages (not GET)
    const body = {
      ...filter,
      Page: page,
      PageSize: Math.min(pageSize, MAX_PAGE_SIZE),
      Sort: "ID",
    };

    const payload = await this.#http.request("POST", "/mail/v4/messages", {
      uid: this.#uid,
      body,
    });

    return {
      messages: payload?.Messages || [],
      total: payload?.Total ?? 0,
      stale: Boolean(payload?.Stale),
    };
  }

  async getAllMessageMetadata(filter = {}) {
    const messages = [];
    let page = 0;

    while (true) {
      const result = await this.getMessageMetadata(filter, page, MAX_PAGE_SIZE);
      messages.push(...result.messages);
      if (result.messages.length < MAX_PAGE_SIZE) break;
      page++;
    }

    return messages;
  }

  async getMessageIds(afterId = "", limit = 1000) {
    const query = { Limit: String(Math.min(limit, 1000)) };
    if (afterId) query.AfterID = afterId;

    const payload = await this.#http.request("GET", "/mail/v4/messages/ids", {
      uid: this.#uid,
      query,
    });
    return payload?.IDs || [];
  }

  async getAllMessageIds() {
    const allIds = [];
    let afterId = "";

    while (true) {
      const ids = await this.getMessageIds(afterId, 1000);
      if (ids.length === 0) break;
      allIds.push(...ids);
      afterId = ids[ids.length - 1];
    }

    return allIds;
  }

  async getMessageCount() {
    const payload = await this.#http.request("GET", "/mail/v4/messages/count", {
      uid: this.#uid,
    });
    return payload?.Counts || [];
  }

  async deleteMessages(messageIds) {
    for (const chunk of chunks(messageIds, MAX_BATCH_IDS)) {
      await this.#http.request("PUT", "/mail/v4/messages/delete", {
        uid: this.#uid,
        body: { IDs: chunk },
      });
    }
  }

  async markMessagesRead(messageIds) {
    for (const chunk of chunks(messageIds, MAX_BATCH_IDS)) {
      await this.#http.request("PUT", "/mail/v4/messages/read", {
        uid: this.#uid,
        body: { IDs: chunk },
      });
    }
  }

  async markMessagesUnread(messageIds) {
    for (const chunk of chunks(messageIds, MAX_BATCH_IDS)) {
      await this.#http.request("PUT", "/mail/v4/messages/unread", {
        uid: this.#uid,
        body: { IDs: chunk },
      });
    }
  }

  async labelMessages(messageIds, labelId) {
    for (const chunk of chunks(messageIds, MAX_BATCH_IDS)) {
      await this.#http.request("PUT", "/mail/v4/messages/label", {
        uid: this.#uid,
        body: { LabelID: labelId, IDs: chunk },
      });
    }
  }

  async unlabelMessages(messageIds, labelId) {
    for (const chunk of chunks(messageIds, MAX_BATCH_IDS)) {
      await this.#http.request("PUT", "/mail/v4/messages/unlabel", {
        uid: this.#uid,
        body: { LabelID: labelId, IDs: chunk },
      });
    }
  }

  async markMessagesForwarded(messageIds) {
    for (const chunk of chunks(messageIds, MAX_BATCH_IDS)) {
      await this.#http.request("PUT", "/mail/v4/messages/forward", {
        uid: this.#uid,
        body: { IDs: chunk },
      });
    }
  }

  async markMessagesUnforwarded(messageIds) {
    for (const chunk of chunks(messageIds, MAX_BATCH_IDS)) {
      await this.#http.request("PUT", "/mail/v4/messages/unforward", {
        uid: this.#uid,
        body: { IDs: chunk },
      });
    }
  }

  async getAttachment(attachmentId) {
    const response = await this.#http.requestRaw("GET", `/mail/v4/attachments/${enc(attachmentId)}`, {
      uid: this.#uid,
    });
    return Buffer.from(await response.arrayBuffer());
  }

  async getLabels(types = []) {
    const allLabels = [];
    const labelTypes = types.length > 0 ? types : [1, 3, 4];

    for (const type of labelTypes) {
      const payload = await this.#http.request("GET", "/core/v4/labels", {
        uid: this.#uid,
        query: { Type: String(type) },
      });
      allLabels.push(...(payload?.Labels || []));
    }

    return allLabels;
  }

  async createLabel(name, color, type = 1, parentId) {
    const body = { Name: name, Color: color, Type: type };
    if (parentId) body.ParentID = parentId;

    const payload = await this.#http.request("POST", "/core/v4/labels", {
      uid: this.#uid,
      body,
    });
    return payload?.Label;
  }

  async updateLabel(labelId, name, color, parentId) {
    const body = { Name: name, Color: color };
    if (parentId !== undefined) body.ParentID = parentId;

    const payload = await this.#http.request("PUT", `/core/v4/labels/${enc(labelId)}`, {
      uid: this.#uid,
      body,
    });
    return payload?.Label;
  }

  async deleteLabel(labelId) {
    await this.#http.request("DELETE", `/core/v4/labels/${enc(labelId)}`, {
      uid: this.#uid,
    });
  }

  async getConversation(conversationId) {
    const payload = await this.#http.request("GET", `/mail/v4/conversations/${enc(conversationId)}`, {
      uid: this.#uid,
    });
    return payload;
  }

  async getConversations(filter = {}, page = 0, pageSize = MAX_PAGE_SIZE) {
    const body = {
      ...filter,
      Page: page,
      PageSize: Math.min(pageSize, MAX_PAGE_SIZE),
      Sort: "ID",
    };

    const payload = await this.#http.request("POST", "/mail/v4/conversations", {
      uid: this.#uid,
      body,
    });

    return {
      conversations: payload?.Conversations || [],
      total: payload?.Total ?? 0,
    };
  }

  async getLatestEventId() {
    const payload = await this.#http.request("GET", "/core/v5/events/latest", {
      uid: this.#uid,
    });
    return payload?.EventID;
  }

  async getEvents(eventId) {
    const payload = await this.#http.request("GET", `/core/v5/events/${enc(eventId)}`, {
      uid: this.#uid,
    });
    return payload;
  }

  async api(method, pathname, options = {}) {
    return this.#http.request(method, pathname, { uid: this.#uid, ...options });
  }
}

function enc(value) {
  return encodeURIComponent(value);
}

function chunks(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}
