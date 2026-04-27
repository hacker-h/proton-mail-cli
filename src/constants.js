export const DEFAULT_API_URL = "https://mail.proton.me/api";

export const DEFAULT_APP_VERSION = "web-mail@5.0.60.0";

export const SUCCESS_CODES = [1000, 1001];

export const Labels = Object.freeze({
  INBOX: "0",
  ALL_DRAFTS: "1",
  ALL_SENT: "2",
  TRASH: "3",
  SPAM: "4",
  ALL_MAIL: "5",
  ARCHIVE: "6",
  SENT: "7",
  DRAFTS: "8",
  OUTBOX: "9",
  STARRED: "10",
  ALL_SCHEDULED: "12",
});

export const LabelType = Object.freeze({
  LABEL: 1,
  CONTACT_GROUP: 2,
  FOLDER: 3,
  SYSTEM: 4,
});

export const MessageFlag = Object.freeze({
  RECEIVED: 1 << 0,
  SENT: 1 << 1,
  INTERNAL: 1 << 2,
  E2E: 1 << 3,
  AUTO: 1 << 4,
  REPLIED: 1 << 5,
  REPLIED_ALL: 1 << 6,
  FORWARDED: 1 << 7,
  AUTO_REPLIED: 1 << 9,
  OPENED: 1 << 11,
  NOTIFIED: 1 << 12,
  TOUCHED: 1 << 13,
});

export const AUTH_REFRESH_PATHS = Object.freeze([
  "/auth/refresh",
  "/auth/v4/refresh",
]);

export const MAX_PAGE_SIZE = 150;
export const MAX_BATCH_IDS = 150;
