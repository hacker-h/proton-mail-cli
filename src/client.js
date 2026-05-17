import { ProtonHttp } from "./http.js";
import { Labels, MAX_PAGE_SIZE, MAX_BATCH_IDS } from "./constants.js";

/**
 * @typedef {import("./http.js").ProtonHttpOptions & { uid?: string | null }} ProtonMailClientOptions
 * @typedef {Record<string, unknown>} ProtonFilter
 * @typedef {Record<string, unknown>} ProtonUser
 * @typedef {Record<string, unknown>} ProtonMessage
 * @typedef {Record<string, unknown>} ProtonConversation
 * @typedef {Record<string, unknown>} ProtonLabel
 * @typedef {{ messages: unknown[], total: number, stale: boolean }} MessageMetadataResult
 * @typedef {{ conversations: ProtonConversation[], total: number }} ConversationListResult
 */

export class ProtonMailClient {
  #http;
  #uid;

  /** @param {ProtonMailClientOptions} options */
  constructor(options) {
    this.#http = new ProtonHttp(options);
    this.#uid = options.uid || null;
  }

  /** @returns {Promise<ProtonUser | undefined>} */
  async getUser() {
    const payload = await this.#http.request("GET", "/core/v4/users", { uid: this.#uid });
    return payload?.User;
  }

  /** @returns {Promise<unknown[]>} */
  async getAddresses() {
    const payload = await this.#http.request("GET", "/core/v4/addresses", { uid: this.#uid });
    return payload?.Addresses || [];
  }

  /** @returns {Promise<unknown[]>} */
  async getKeySalts() {
    const payload = await this.#http.request("GET", "/core/v4/keys/salts", { uid: this.#uid });
    return payload?.KeySalts || [];
  }

  /**
   * @param {string} messageId
   * @returns {Promise<ProtonMessage | undefined>}
   */
  async getMessage(messageId) {
    const payload = await this.#http.request("GET", `/mail/v4/messages/${enc(messageId)}`, {
      uid: this.#uid,
    });
    return payload?.Message;
  }

  /**
   * @param {ProtonFilter} [filter]
   * @param {number} [page]
   * @param {number} [pageSize]
   * @returns {Promise<MessageMetadataResult>}
   */
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

  /**
   * @param {ProtonFilter} [filter]
   * @returns {Promise<unknown[]>}
   */
  async getAllMessageMetadata(filter = {}) {
    /** @type {unknown[]} */
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

  /**
   * @param {string} [afterId]
   * @param {number} [limit]
   * @returns {Promise<string[]>}
   */
  async getMessageIds(afterId = "", limit = 1000) {
    /** @type {{ Limit: string, AfterID?: string }} */
    const query = { Limit: String(Math.min(limit, 1000)) };
    if (afterId) query.AfterID = afterId;

    const payload = await this.#http.request("GET", "/mail/v4/messages/ids", {
      uid: this.#uid,
      query,
    });
    return payload?.IDs || [];
  }

  /** @returns {Promise<string[]>} */
  async getAllMessageIds() {
    /** @type {string[]} */
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

  /** @returns {Promise<unknown[]>} */
  async getMessageCount() {
    const payload = await this.#http.request("GET", "/mail/v4/messages/count", {
      uid: this.#uid,
    });
    return payload?.Counts || [];
  }

  /**
   * @param {string[]} messageIds
   * @returns {Promise<unknown[]>}
   */
  async deleteMessages(messageIds) {
    return this.#mutateMessageIds("/mail/v4/messages/delete", validateMessageIds(messageIds));
  }

  /**
   * @param {string[]} messageIds
   * @returns {Promise<unknown[]>}
   */
  async markMessagesRead(messageIds) {
    return this.#mutateMessageIds("/mail/v4/messages/read", validateMessageIds(messageIds));
  }

  /**
   * @param {string[]} messageIds
   * @returns {Promise<unknown[]>}
   */
  async markMessagesUnread(messageIds) {
    return this.#mutateMessageIds("/mail/v4/messages/unread", validateMessageIds(messageIds));
  }

  /**
   * @param {string[]} messageIds
   * @param {string} labelId
   * @returns {Promise<unknown[]>}
   */
  async labelMessages(messageIds, labelId) {
    validateLabelId(labelId);
    return this.#mutateMessageIds("/mail/v4/messages/label", validateMessageIds(messageIds), labelId);
  }

  /**
   * @param {string[]} messageIds
   * @param {string} labelId
   * @returns {Promise<unknown[]>}
   */
  async unlabelMessages(messageIds, labelId) {
    validateLabelId(labelId);
    return this.#mutateMessageIds("/mail/v4/messages/unlabel", validateMessageIds(messageIds), labelId);
  }

  /** @param {string[]} messageIds */
  async archiveMessages(messageIds) {
    return this.labelMessages(messageIds, Labels.ARCHIVE);
  }

  /** @param {string[]} messageIds */
  async unarchiveMessages(messageIds) {
    return this.labelMessages(messageIds, Labels.INBOX);
  }

  /** @param {string[]} messageIds */
  async restoreMessages(messageIds) {
    return this.labelMessages(messageIds, Labels.INBOX);
  }

  /** @param {string[]} messageIds */
  async starMessages(messageIds) {
    return this.labelMessages(messageIds, Labels.STARRED);
  }

  /** @param {string[]} messageIds */
  async unstarMessages(messageIds) {
    return this.unlabelMessages(messageIds, Labels.STARRED);
  }

  /** @param {string[]} messageIds */
  async markMessagesSpam(messageIds) {
    return this.labelMessages(messageIds, Labels.SPAM);
  }

  /** @param {string[]} messageIds */
  async markMessagesNotSpam(messageIds) {
    return this.labelMessages(messageIds, Labels.INBOX);
  }

  /**
   * @param {string[]} messageIds
   * @param {string} folderId
   */
  async moveMessagesToFolder(messageIds, folderId) {
    return this.labelMessages(messageIds, folderId);
  }

  /**
   * @param {string} pathname
   * @param {string[]} messageIds
   * @param {string} [labelId]
   * @returns {Promise<unknown[]>}
   */
  async #mutateMessageIds(pathname, messageIds, labelId) {
    const responses = [];
    for (const chunk of chunks(messageIds, MAX_BATCH_IDS)) {
      responses.push(await this.#http.request("PUT", pathname, {
        uid: this.#uid,
        body: { ...(labelId === undefined ? {} : { LabelID: labelId }), IDs: chunk },
      }));
    }
    return responses;
  }

  /**
   * @param {string[]} messageIds
   * @returns {Promise<void>}
   */
  async markMessagesForwarded(messageIds) {
    for (const chunk of chunks(messageIds, MAX_BATCH_IDS)) {
      await this.#http.request("PUT", "/mail/v4/messages/forward", {
        uid: this.#uid,
        body: { IDs: chunk },
      });
    }
  }

  /**
   * @param {string[]} messageIds
   * @returns {Promise<void>}
   */
  async markMessagesUnforwarded(messageIds) {
    for (const chunk of chunks(messageIds, MAX_BATCH_IDS)) {
      await this.#http.request("PUT", "/mail/v4/messages/unforward", {
        uid: this.#uid,
        body: { IDs: chunk },
      });
    }
  }

  /**
   * @param {string} attachmentId
   * @returns {Promise<Buffer>}
   */
  async getAttachment(attachmentId) {
    const response = await this.#http.requestRaw("GET", `/mail/v4/attachments/${enc(attachmentId)}`, {
      uid: this.#uid,
    });
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * @param {number[]} [types]
   * @returns {Promise<unknown[]>}
   */
  async getLabels(types = []) {
    /** @type {unknown[]} */
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

  /**
   * @param {string} name
   * @param {string} color
   * @param {number} [type]
   * @param {string} [parentId]
   * @returns {Promise<ProtonLabel | undefined>}
   */
  async createLabel(name, color, type = 1, parentId) {
    /** @type {{ Name: string, Color: string, Type: number, ParentID?: string }} */
    const body = { Name: name, Color: color, Type: type };
    if (parentId) body.ParentID = parentId;

    const payload = await this.#http.request("POST", "/core/v4/labels", {
      uid: this.#uid,
      body,
    });
    return payload?.Label;
  }

  /**
   * @param {string} labelId
   * @param {string} name
   * @param {string} color
   * @param {string} [parentId]
   * @returns {Promise<ProtonLabel | undefined>}
   */
  async updateLabel(labelId, name, color, parentId) {
    /** @type {{ Name: string, Color: string, ParentID?: string }} */
    const body = { Name: name, Color: color };
    if (parentId !== undefined) body.ParentID = parentId;

    const payload = await this.#http.request("PUT", `/core/v4/labels/${enc(labelId)}`, {
      uid: this.#uid,
      body,
    });
    return payload?.Label;
  }

  /**
   * @param {string} labelId
   * @returns {Promise<void>}
   */
  async deleteLabel(labelId) {
    await this.#http.request("DELETE", `/core/v4/labels/${enc(labelId)}`, {
      uid: this.#uid,
    });
  }

  /**
   * @param {string} conversationId
   * @returns {Promise<import("./http.js").ProtonApiResponse | null>}
   */
  async getConversation(conversationId) {
    const payload = await this.#http.request("GET", `/mail/v4/conversations/${enc(conversationId)}`, {
      uid: this.#uid,
    });
    return payload;
  }

  /**
   * @param {ProtonFilter} [filter]
   * @param {number} [page]
   * @param {number} [pageSize]
   * @returns {Promise<ConversationListResult>}
   */
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
      conversations: /** @type {ProtonConversation[]} */ (payload?.Conversations || []),
      total: payload?.Total ?? 0,
    };
  }

  /** @returns {Promise<string | undefined>} */
  async getLatestEventId() {
    const payload = await this.#http.request("GET", "/core/v5/events/latest", {
      uid: this.#uid,
    });
    return payload?.EventID;
  }

  /**
   * @param {string} eventId
   * @returns {Promise<import("./http.js").ProtonApiResponse | null>}
   */
  async getEvents(eventId) {
    const payload = await this.#http.request("GET", `/core/v5/events/${enc(eventId)}`, {
      uid: this.#uid,
    });
    return payload;
  }

  /**
   * @param {string} method
   * @param {string} pathname
   * @param {import("./http.js").RequestOptions} [options]
   * @returns {Promise<import("./http.js").ProtonApiResponse | null>}
   */
  async api(method, pathname, options = {}) {
    return this.#http.request(method, pathname, { uid: this.#uid, ...options });
  }
}


/** @param {string[]} messageIds */
function validateMessageIds(messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new TypeError("messageIds must be a non-empty array");
  }
  return messageIds.map((messageId) => {
    const id = String(messageId || "").trim();
    if (!id || /^browser:index:/u.test(id) || /[\s\u0000-\u001f]/u.test(id)) {
      throw new TypeError("messageIds must contain explicit Proton message IDs");
    }
    return id;
  });
}

/** @param {string} labelId */
function validateLabelId(labelId) {
  const id = String(labelId || "").trim();
  if (!id || /[\s\u0000-\u001f]/u.test(id)) {
    throw new TypeError("labelId must be a non-empty Proton label ID");
  }
}

/** @param {string} value */
function enc(value) {
  return encodeURIComponent(value);
}

/**
 * @template T
 * @param {T[]} array
 * @param {number} size
 * @returns {T[][]}
 */
function chunks(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}
