import fs from "node:fs";
import { doctorConfig, doctorSession, redact, resolveCliConfig } from "./config.js";
import { buildMailMetadataFilter } from "./mail-runner.js";

/**
 * @typedef {{ write(chunk: string): unknown }} WritableLike
 * @typedef {"human" | "json" | "table"} CliFormat
 * @typedef {{ format: CliFormat, timeout: number | null, config: string | null, session: string | null, quiet: boolean, verbose: boolean, help: boolean, version: boolean }} GlobalOptions
 * @typedef {{ command: string, args: string[] }} NormalizedCommand
 * @typedef {{ command: string, args: string[], global: GlobalOptions }} ParsedCommand
 * @typedef {(...args: unknown[]) => unknown | Promise<unknown>} CliHandler
 * @typedef {{ list?: CliHandler, latest?: CliHandler, search?: CliHandler, read?: CliHandler }} CliMailClient
 * @typedef {{ get?: CliHandler }} CliOtpClient
 * @typedef {{ session?: CliHandler, auth?: CliHandler }} CliDoctorClient
 * @typedef {{ mail?: CliMailClient, otp?: CliOtpClient, doctor?: CliDoctorClient }} CliClients
 * @typedef {{ argv?: string[], stdout?: WritableLike, stderr?: WritableLike, version?: string, clients?: CliClients }} CliRunOptions
 * @typedef {{ command: string, data: unknown, human: string }} CommandResult
 * @typedef {{ timeout: number | null, config: string, session: string, quiet: boolean, verbose: boolean, format: CliFormat }} ClientOptions
 * @typedef {ClientOptions & { matchText?: string | RegExp, folder?: string, limit?: number, requireMatch?: boolean, subject?: string, from?: string, to?: string, labelId?: string, unread?: boolean, read?: boolean, after?: number, before?: number, metadataFilter?: Record<string, unknown> }} MailCommandOptions
 * @typedef {ClientOptions & { provider?: string, matchText?: string | RegExp, pattern?: string, otpPattern?: string, linkPattern?: string, folder?: string, limit?: number, pollInterval?: number, requireMatch?: boolean }} OtpCommandOptions
 * @typedef {{ exitCode: number, code: string, message: string, details?: unknown }} NormalizedCliError
 * @typedef {{ code: string, message: string, details?: unknown }} CliErrorBody
 * @typedef {{ ok: boolean, command: string, data?: unknown, error?: NormalizedCliError | null, version: string }} JsonEnvelopeOptions
 * @typedef {{ command: string, data: unknown, global: GlobalOptions, stdout: WritableLike, version: string, human?: string }} WriteSuccessOptions
 * @typedef {{ command: string, error: unknown, global: GlobalOptions, stdout: WritableLike, stderr: WritableLike, version: string }} WriteFailureOptions
 */

export const CLI_EXIT = Object.freeze({
  OK: 0,
  USAGE: 1,
  UNAVAILABLE: 2,
  RUNTIME: 3,
});

const DEFAULT_FORMAT = "human";
const VERSION = readPackageVersion();

/**
 * @param {CliRunOptions} [options]
 * @returns {Promise<number>}
 */
export async function runPmCli(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : [];
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const version = options.version || VERSION;
  const clients = options.clients || {};

  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    return writeFailure({
      command: "pm",
      error,
      global: globalForParseError(argv),
      stdout,
      stderr,
      version,
    });
  }

  const { command, args, global } = parsed;

  try {
    if (global.help || command === "help") {
      return writeSuccess({
        command: "help",
        data: { usage: rootHelp(version) },
        global,
        stdout,
        version,
        human: rootHelp(version),
      });
    }

    if (global.version || command === "version") {
      return writeSuccess({
        command: "version",
        data: { version },
        global,
        stdout,
        version,
        human: `pm ${version}\n`,
      });
    }

    if (!command) {
      return writeSuccess({
        command: "help",
        data: { usage: rootHelp(version) },
        global,
        stdout,
        version,
        human: rootHelp(version),
      });
    }

    const result = await dispatchCommand({ command, args, global, clients });
    return writeSuccess({
      command: result.command,
      data: result.data,
      global,
      stdout,
      version,
      human: result.human,
    });
  } catch (error) {
    return writeFailure({ command: command || "pm", error, global, stdout, stderr, version });
  }
}

export const runPm = runPmCli;

/**
 * @param {string[]} argv
 * @returns {ParsedCommand}
 */
export function parseArgv(argv) {
  const global = defaultGlobalOptions();
  const positionals = [];

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token === "--help" || token === "-h") {
      global.help = true;
      continue;
    }

    if (token === "--version" || token === "-v") {
      global.version = true;
      continue;
    }

    if (token === "--json") {
      global.format = "json";
      continue;
    }

    if (token === "--quiet") {
      global.quiet = true;
      continue;
    }

    if (token === "--verbose") {
      global.verbose = true;
      continue;
    }

    const option = splitOption(token);
    if (option.name === "--format") {
      const value = option.value ?? readOptionValue(argv, ++index, option.name);
      if (value !== "human" && value !== "json" && value !== "table") {
        throw new CliError(CLI_EXIT.USAGE, "INVALID_FORMAT", "--format must be human, json, or table", { value });
      }
      global.format = value;
      continue;
    }

    if (option.name === "--timeout") {
      const value = option.value ?? readOptionValue(argv, ++index, option.name);
      const timeout = Number(value);
      if (!Number.isInteger(timeout) || timeout <= 0) {
        throw new CliError(CLI_EXIT.USAGE, "INVALID_TIMEOUT", "--timeout must be a positive integer", { value });
      }
      global.timeout = timeout;
      continue;
    }

    if (option.name === "--config") {
      global.config = option.value ?? readOptionValue(argv, ++index, option.name);
      continue;
    }

    if (option.name === "--session") {
      global.session = option.value ?? readOptionValue(argv, ++index, option.name);
      continue;
    }

    if (positionals.length > 0) {
      positionals.push(token);
      continue;
    }

    throw new CliError(CLI_EXIT.USAGE, "UNKNOWN_FLAG", `Unknown flag: ${token}`, { flag: token });
  }

  if (global.quiet && global.verbose) {
    throw new CliError(CLI_EXIT.USAGE, "CONFLICTING_FLAGS", "--quiet and --verbose cannot be used together");
  }

  const normalized = normalizeCommand(positionals);
  return { ...normalized, global };
}

/**
 * @param {{ command: string, args: string[], global: GlobalOptions, clients?: CliClients }} options
 * @returns {Promise<CommandResult>}
 */
export async function dispatchCommand({ command, args, global, clients = {} }) {
  if (command === "mail:list") {
    const { options, requireMatch } = parseMailArgs(args, global, "pm ls");
    const result = await callInjected(clients.mail?.list, [options], "pm ls");
    const data = normalizeMailListResult(result, requireMatch);
    return { command, data, human: renderList(data) };
  }

  if (command === "mail:latest") {
    const { options, requireMatch } = parseMailArgs(args, global, "pm mail latest");
    const result = await callInjected(clients.mail?.latest, [options], "pm mail latest");
    const data = normalizeMailLatestResult(result, requireMatch);
    return { command, data, human: renderObject(data) };
  }

  if (command === "mail:search") {
    const { options, requireMatch } = parseMailArgs(args, global, "pm mail search");
    if (options.matchText === undefined) {
      throw new CliError(CLI_EXIT.USAGE, "MISSING_MATCH", "pm mail search requires --match <text|/re/i>");
    }
    const result = await callInjected(clients.mail?.search, [options], "pm mail search");
    const data = normalizeMailListResult(result, requireMatch);
    return { command, data, human: renderList(data) };
  }

  if (command === "mail:read") {
    const messageId = args[0];
    if (!messageId) {
      throw new CliError(CLI_EXIT.USAGE, "MISSING_MESSAGE_ID", "pm read requires <messageId>");
    }
    expectArgs(args, 1, "pm read <messageId>");
    const result = await callInjected(clients.mail?.read, [messageId, clientOptions(global)], "pm read <messageId>");
    const data = normalizeMailReadResult(result);
    return { command, data, human: renderRead(data) };
  }

  if (command === "otp") {
    const { options, requireMatch } = parseOtpArgs(args, global);
    const result = await callInjected(clients.otp?.get, [options], "pm otp");
    const data = normalizeOtpResult(result, requireMatch);
    return { command, data, human: renderOtp(data) };
  }

  if (command === "doctor:config") {
    const data = doctorConfig(global);
    return { command, data, human: renderDoctor(data) };
  }

  if (command === "doctor:session") {
    const data = await doctorSession(global, clients);
    return { command, data, human: renderDoctor(data) };
  }

  throw new CliError(CLI_EXIT.USAGE, "UNKNOWN_COMMAND", `Unknown command: ${formatCommand(command, args)}`, {
    command,
    args,
  });
}

/**
 * @param {string[]} args
 * @param {GlobalOptions} global
 * @param {string} commandLabel
 * @returns {{ options: MailCommandOptions, requireMatch: boolean }}
 */
function parseMailArgs(args, global, commandLabel) {
  /** @type {MailCommandOptions} */
  const options = { ...clientOptions(global) };
  let requireMatch = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("-") || token === "-") {
      throw new CliError(CLI_EXIT.USAGE, "UNEXPECTED_ARGUMENT", `${commandLabel} does not accept positional arguments`, {
        command: commandLabel,
        args,
      });
    }

    const option = splitOption(token);
    if (option.name === "--require-match") {
      if (option.value !== undefined) {
        throw new CliError(CLI_EXIT.USAGE, "INVALID_FLAG_VALUE", "--require-match does not accept a value", { flag: option.name });
      }
      requireMatch = true;
      options.requireMatch = true;
      continue;
    }

    if (option.name === "--match") {
      options.matchText = parseMatchText(option.value ?? readCommandOptionValue(args, ++index, option.name));
      continue;
    }

    if (option.name === "--folder") {
      options.folder = option.value ?? readCommandOptionValue(args, ++index, option.name);
      continue;
    }

    if (option.name === "--label" || option.name === "--label-id") {
      options.labelId = option.value ?? readCommandOptionValue(args, ++index, option.name);
      continue;
    }

    if (option.name === "--subject") {
      options.subject = option.value ?? readCommandOptionValue(args, ++index, option.name);
      continue;
    }

    if (option.name === "--from" || option.name === "--sender") {
      options.from = option.value ?? readCommandOptionValue(args, ++index, option.name);
      continue;
    }

    if (option.name === "--to") {
      options.to = option.value ?? readCommandOptionValue(args, ++index, option.name);
      continue;
    }

    if (option.name === "--unread") {
      if (option.value !== undefined) {
        throw new CliError(CLI_EXIT.USAGE, "INVALID_FLAG_VALUE", "--unread does not accept a value", { flag: option.name });
      }
      if (options.read) {
        throw new CliError(CLI_EXIT.USAGE, "CONFLICTING_FLAGS", "--read and --unread cannot be used together");
      }
      options.unread = true;
      continue;
    }

    if (option.name === "--read") {
      if (option.value !== undefined) {
        throw new CliError(CLI_EXIT.USAGE, "INVALID_FLAG_VALUE", "--read does not accept a value", { flag: option.name });
      }
      if (options.unread) {
        throw new CliError(CLI_EXIT.USAGE, "CONFLICTING_FLAGS", "--read and --unread cannot be used together");
      }
      options.read = true;
      continue;
    }

    if (option.name === "--after") {
      options.after = parseMailTimestamp(option.value ?? readCommandOptionValue(args, ++index, option.name), option.name);
      continue;
    }

    if (option.name === "--before") {
      options.before = parseMailTimestamp(option.value ?? readCommandOptionValue(args, ++index, option.name), option.name);
      continue;
    }

    if (option.name === "--limit") {
      const value = option.value ?? readCommandOptionValue(args, ++index, option.name);
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new CliError(CLI_EXIT.USAGE, "INVALID_LIMIT", "--limit must be a positive integer", { value });
      }
      options.limit = limit;
      continue;
    }

    throw new CliError(CLI_EXIT.USAGE, "UNKNOWN_FLAG", `Unknown flag: ${token}`, { flag: token });
  }

  const metadataFilter = buildMailMetadataFilter(options);
  if (Object.keys(metadataFilter).length > 0) options.metadataFilter = metadataFilter;
  return { options, requireMatch };
}

/**
 * @param {string} value
 * @param {string} flag
 */
function parseMailTimestamp(value, flag) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new CliError(CLI_EXIT.USAGE, "INVALID_DATE", `${flag} must be a Unix timestamp or parseable date`, { flag, value });
  }
  return Math.floor(parsed / 1000);
}

/**
 * @param {unknown} result
 * @param {boolean} requireMatch
 */
function normalizeMailListResult(result, requireMatch) {
  const object = toRecord(result);
  if (object.success === false) {
    return normalizeMailFailure(object, requireMatch);
  }

  const messages = sanitizeMailMessages(Array.isArray(object.messages) ? object.messages : Array.isArray(result) ? result : []);
  const status = messages.length > 0 ? "matched" : "no_match";
  if (requireMatch && messages.length === 0) {
    throw new CliError(CLI_EXIT.USAGE, "NO_MATCH", "No matching Proton Mail messages found", { status });
  }

  return {
    ...sanitizeMailOutput(object),
    success: object.success ?? true,
    status,
    source: object.source || "unknown",
    count: messages.length,
    messages,
  };
}

/**
 * @param {unknown} result
 * @param {boolean} requireMatch
 */
function normalizeMailLatestResult(result, requireMatch) {
  const object = toRecord(result);
  if (object.success === false) {
    return normalizeMailFailure(object, requireMatch);
  }

  const message = sanitizeMailMessage(object.message || result);
  const hasMessage = Object.keys(message).length > 0;
  const status = hasMessage ? "matched" : "no_match";
  if (requireMatch && !hasMessage) {
    throw new CliError(CLI_EXIT.USAGE, "NO_MATCH", "No matching Proton Mail message found", { status });
  }

  return {
    ...sanitizeMailOutput(object),
    success: object.success ?? true,
    status,
    source: object.source || "unknown",
    message: hasMessage ? message : null,
  };
}

/** @param {unknown} result */
function normalizeMailReadResult(result) {
  const object = toRecord(result);
  if (object.success === false) {
    const status = classifyMailFailure(object);
    throw new CliError(CLI_EXIT.USAGE, mailFailureCode(status), mailFailureMessage(status), {
      status,
      error: String(redact(object.error || mailFailureMessage(status))),
    });
  }

  const message = sanitizeMailReadMessage(object.message || result);
  return {
    ...sanitizeMailOutput(object),
    success: object.success ?? true,
    status: Object.keys(message).length > 0 ? "matched" : "no_match",
    source: object.source || "unknown",
    message,
  };
}

/**
 * @param {Record<string, unknown>} object
 * @param {boolean} requireMatch
 */
function normalizeMailFailure(object, requireMatch) {
  const status = classifyMailFailure(object);
  const error = String(redact(object.error || mailFailureMessage(status)));
  const data = {
    ...sanitizeMailOutput(object),
    success: false,
    status,
    error,
  };
  if (!requireMatch) return data;
  throw new CliError(CLI_EXIT.USAGE, mailFailureCode(status), mailFailureMessage(status), { status, error });
}

/** @param {Record<string, unknown>} result */
function classifyMailFailure(result) {
  const message = String(result.error || "");
  if (/No matching Proton Mail message found|No matching Proton Mail messages found/iu.test(message)) return "no_match";
  if (/browser:index:N refs/iu.test(message)) return "invalid_message_ref";
  if (result.sessionExpired || /expired/iu.test(message)) return "session_expired";
  if (/credential|auth|login/iu.test(message)) return "auth_error";
  return "upstream_failure";
}

/** @param {string} status */
function mailFailureCode(status) {
  if (status === "no_match") return "NO_MATCH";
  if (status === "invalid_message_ref") return "INVALID_MESSAGE_REF";
  if (status === "session_expired") return "SESSION_EXPIRED";
  if (status === "auth_error") return "AUTH_REQUIRED";
  return "MAIL_COMMAND_FAILED";
}

/** @param {string} status */
function mailFailureMessage(status) {
  if (status === "no_match") return "No matching Proton Mail message found";
  if (status === "invalid_message_ref") return "pm read requires a browser:index:N ref from pm ls or pm mail search";
  if (status === "session_expired") return "Saved Proton Mail session expired; refresh the session file";
  if (status === "auth_error") return "Proton Mail credentials or session are required";
  return "Proton Mail command failed";
}

/** @param {unknown[]} messages */
function sanitizeMailMessages(messages) {
  return messages.map(sanitizeMailMessage).filter((message) => Object.keys(message).length > 0);
}

/** @param {unknown} message */
function sanitizeMailMessage(message) {
  const object = toRecord(message);
  /** @type {Record<string, unknown>} */
  const output = {};
  if (object.ref !== undefined) output.ref = object.ref;
  if (object.ref === undefined && object.index !== undefined) output.ref = `browser:index:${object.index}`;
  for (const key of ["id", "ID", "index", "subject", "Subject", "from", "sender", "Sender", "time", "Time", "receivedAt", "Unread", "LabelIDs", "AddressID", "preview"]) {
    if (object[key] !== undefined) output[key] = object[key];
  }
  return output;
}

/** @param {unknown} message */
function sanitizeMailReadMessage(message) {
  const output = sanitizeMailMessage(message);
  const object = toRecord(message);
  if (typeof object.bodyText === "string") output.bodyText = object.bodyText;
  return output;
}

/** @param {Record<string, unknown>} result */
function sanitizeMailOutput(result) {
  /** @type {Record<string, unknown>} */
  const output = {};
  for (const [key, value] of Object.entries(result)) {
    if (["browser", "context", "page", "debugEvents", "bodyText"].includes(key)) continue;
    if (key === "error" || key === "lastError") {
      output[key] = redact(value);
      continue;
    }
    if (key === "message") {
      output[key] = sanitizeMailMessage(value);
      continue;
    }
    if (key === "messages") continue;
    output[key] = value;
  }
  return output;
}

/**
 * @param {string[]} args
 * @param {GlobalOptions} global
 * @returns {{ options: OtpCommandOptions, requireMatch: boolean }}
 */
function parseOtpArgs(args, global) {
  /** @type {OtpCommandOptions} */
  const options = { ...clientOptions(global) };
  let requireMatch = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("-") || token === "-") {
      throw new CliError(CLI_EXIT.USAGE, "UNEXPECTED_ARGUMENT", "pm otp does not accept positional arguments", {
        command: "pm otp",
        args,
      });
    }

    const option = splitOption(token);
    if (option.name === "--require-match") {
      if (option.value !== undefined) {
        throw new CliError(CLI_EXIT.USAGE, "INVALID_FLAG_VALUE", "--require-match does not accept a value", { flag: option.name });
      }
      requireMatch = true;
      options.requireMatch = true;
      continue;
    }

    if (option.name === "--provider") {
      options.provider = option.value ?? readCommandOptionValue(args, ++index, option.name);
      continue;
    }

    if (option.name === "--match") {
      options.matchText = parseMatchText(option.value ?? readCommandOptionValue(args, ++index, option.name));
      continue;
    }

    if (option.name === "--pattern") {
      options.pattern = option.value ?? readCommandOptionValue(args, ++index, option.name);
      continue;
    }

    if (option.name === "--otp-pattern") {
      options.otpPattern = option.value ?? readCommandOptionValue(args, ++index, option.name);
      continue;
    }

    if (option.name === "--link-pattern") {
      options.linkPattern = option.value ?? readCommandOptionValue(args, ++index, option.name);
      continue;
    }

    if (option.name === "--folder") {
      options.folder = option.value ?? readCommandOptionValue(args, ++index, option.name);
      continue;
    }

    if (option.name === "--limit") {
      const value = option.value ?? readCommandOptionValue(args, ++index, option.name);
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new CliError(CLI_EXIT.USAGE, "INVALID_LIMIT", "--limit must be a positive integer", { value });
      }
      options.limit = limit;
      continue;
    }

    if (option.name === "--poll-interval") {
      const value = option.value ?? readCommandOptionValue(args, ++index, option.name);
      const pollInterval = Number(value);
      if (!Number.isInteger(pollInterval) || pollInterval <= 0) {
        throw new CliError(CLI_EXIT.USAGE, "INVALID_POLL_INTERVAL", "--poll-interval must be a positive integer", { value });
      }
      options.pollInterval = pollInterval;
      continue;
    }

    throw new CliError(CLI_EXIT.USAGE, "UNKNOWN_FLAG", `Unknown flag: ${token}`, { flag: token });
  }

  return { options, requireMatch };
}

/**
 * @param {string[]} args
 * @param {number} index
 * @param {string} optionName
 */
function readCommandOptionValue(args, index, optionName) {
  const value = args[index];
  if (value === undefined || value.startsWith("-") || isOtpOptionName(splitOption(value).name)) {
    throw new CliError(CLI_EXIT.USAGE, "MISSING_FLAG_VALUE", `${optionName} requires a value`, { flag: optionName });
  }
  return value;
}

/** @param {string} name */
function isOtpOptionName(name) {
  return [
    "--require-match",
    "--provider",
    "--match",
    "--pattern",
    "--otp-pattern",
    "--link-pattern",
    "--folder",
    "--label",
    "--label-id",
    "--subject",
    "--from",
    "--sender",
    "--to",
    "--read",
    "--unread",
    "--after",
    "--before",
    "--limit",
    "--poll-interval",
  ].includes(name);
}

/** @param {string} value */
function parseMatchText(value) {
  const literalMatch = /^\/([\s\S]+)\/([a-z]*)$/u.exec(value.trim());
  if (!literalMatch) return value;
  const [, source, flags] = literalMatch;
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new CliError(CLI_EXIT.USAGE, "INVALID_MATCH_PATTERN", "--match must be plain text or a valid /pattern/flags expression", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * @param {unknown} result
 * @param {boolean} requireMatch
 */
function normalizeOtpResult(result, requireMatch) {
  const object = toRecord(result);
  if (object.success === false) {
    const status = classifyOtpFailure(object);
    const error = String(object.error || otpFailureMessage(status));
    const data = sanitizeOtpOutput({
      ...object,
      success: false,
      status,
      codeFound: false,
      linkFound: false,
      error,
    });
    if (!requireMatch) return data;

    throw new CliError(CLI_EXIT.USAGE, otpFailureCode(status), otpFailureMessage(status), {
      status,
      error,
    });
  }

  const codeFound = typeof object.code === "string" && object.code.length > 0;
  const linkFound = typeof object.link === "string" && object.link.length > 0;
  const status = String(object.status || (codeFound || linkFound ? "matched" : "matched_without_token"));
  if (requireMatch && !codeFound && !linkFound) {
    throw new CliError(CLI_EXIT.USAGE, otpFailureCode(status), otpFailureMessage(status), {
      status,
    });
  }
  return sanitizeOtpOutput({
    ...object,
    success: object.success ?? true,
    status,
    codeFound,
    linkFound,
  });
}

/** @param {Record<string, unknown>} result */
function sanitizeOtpOutput(result) {
  /** @type {Record<string, unknown>} */
  const output = {};
  for (const [key, value] of Object.entries(result)) {
    if (["browser", "context", "page", "debugEvents", "bodyText", "preview"].includes(key)) continue;
    if (key === "error" || key === "lastError") {
      output[key] = redact(value);
      continue;
    }
    output[key] = key === "message" ? sanitizeOtpMessage(value) : value;
  }
  return output;
}

/** @param {unknown} message */
function sanitizeOtpMessage(message) {
  const object = toRecord(message);
  /** @type {Record<string, unknown>} */
  const output = {};
  for (const key of ["id", "ID", "index", "subject", "Subject", "from", "sender", "receivedAt", "time"]) {
    if (object[key] !== undefined) output[key] = object[key];
  }
  return output;
}

/** @param {Record<string, unknown>} result */
function classifyOtpFailure(result) {
  const message = String(result.error || "");
  if (result.timeout || /timed out waiting/iu.test(message)) return "timeout";
  if (/No matching Proton Mail message found/iu.test(message)) return "no_match";
  if (/Matching email found, but no/iu.test(message)) return "matched_without_token";
  if (result.sessionExpired || /expired/iu.test(message)) return "session_expired";
  if (/credential|auth|login/iu.test(message)) return "auth_error";
  return "upstream_failure";
}

/** @param {string} status */
function otpFailureCode(status) {
  if (status === "no_match") return "NO_MATCH";
  if (status === "matched_without_token") return "TOKEN_NOT_FOUND";
  if (status === "session_expired") return "SESSION_EXPIRED";
  if (status === "auth_error") return "AUTH_REQUIRED";
  if (status === "timeout") return "TIMEOUT";
  return "OTP_EXTRACTION_FAILED";
}

/** @param {string} status */
function otpFailureMessage(status) {
  if (status === "no_match") return "No matching Proton Mail message found";
  if (status === "matched_without_token") return "Matching Proton Mail message found, but no OTP code or link was present";
  if (status === "session_expired") return "Saved Proton Mail session expired; refresh the session file";
  if (status === "auth_error") return "Proton Mail credentials or session are required";
  if (status === "timeout") return "Timed out waiting for matching Proton Mail OTP or link";
  return "OTP extraction failed";
}

/**
 * @param {string[]} args
 * @param {number} expectedCount
 * @param {string} commandLabel
 */
function expectArgs(args, expectedCount, commandLabel) {
  if (args.length === expectedCount) return;
  if (args.length < expectedCount) {
    throw new CliError(CLI_EXIT.USAGE, "MISSING_ARGUMENT", `${commandLabel} requires ${expectedCount} argument${expectedCount === 1 ? "" : "s"}`, {
      command: commandLabel,
      expected: expectedCount,
      received: args.length,
    });
  }

  throw new CliError(CLI_EXIT.USAGE, "UNEXPECTED_ARGUMENT", `${commandLabel} does not accept extra arguments`, {
    command: commandLabel,
    expected: expectedCount,
    received: args.length,
    args,
  });
}

export function rootHelp(version = VERSION) {
  return `pm ${version}\n\nUsage:\n  pm help\n  pm version\n  pm ls [--format table] [--json]\n  pm mail latest [--format table] [--json]\n  pm mail search --match <text> [--format table] [--json]\n  pm read <messageId> [--format table] [--json]\n  pm otp --match <text> --json\n  pm otp --provider github --require-match\n  pm doctor config --json\n  pm doctor session --json\n\nGlobal flags:\n  --json                 Emit a stable JSON envelope\n  --format <human|json|table> Select output format\n  --timeout <seconds>    Set command timeout for injected clients\n  --config <path>        Read CLI config from path\n  --session <path>       Use Proton session state path\n  --quiet                Suppress human success output\n  --verbose              Include verbose client context\n\npm mail flags:\n  --match <text|/re/i>   Match message previews for latest/search/list\n  --folder <name>        Select inbox or all-mail browser scan target\n  --label <id>           Add a REST metadata LabelID filter for injected clients\n  --label-id <id>        Alias for --label\n  --subject <text>       Add a REST metadata subject filter for injected clients\n  --from <text>          Add a REST metadata sender filter for injected clients\n  --sender <text>        Alias for --from\n  --to <text>            Add a REST metadata recipient filter for injected clients\n  --read | --unread      Add a REST metadata read-state filter for injected clients\n  --after <date|ts>      Add a REST metadata lower time bound\n  --before <date|ts>     Add a REST metadata upper time bound\n  --limit <count>        Maximum message previews to scan\n  --require-match        Exit non-zero when no matching message is found\n\npm otp flags:\n  --provider <name>      Use an OTP/link provider preset, e.g. generic, github, magic-link\n  --match <text|/re/i>   Match an email preview before extraction\n  --pattern <pattern>    Override the OTP extraction pattern\n  --otp-pattern <pattern> Override the OTP extraction pattern\n  --link-pattern <pattern> Extract a matching link instead of only an OTP code\n  --folder <name>        Select inbox or all-mail browser scan target\n  --limit <count>        Maximum message previews to scan\n  --poll-interval <sec>  Retry no-match results until --timeout elapses\n  --require-match        Exit non-zero when no matching token is found\n\nAliases:\n  pm ls                  Alias for pm mail list\n  pm list                Alias for pm mail list\n  pm inbox               Alias for pm mail list\n  pm read <messageId>    Alias for pm mail read <messageId>\n  pm doctor auth         Alias for pm doctor session\n`;
}

export class CliError extends Error {
  /**
   * @param {number} exitCode
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(exitCode, code, message, details) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

/** @returns {GlobalOptions} */
function defaultGlobalOptions() {
  return {
    format: DEFAULT_FORMAT,
    timeout: null,
    config: null,
    session: null,
    quiet: false,
    verbose: false,
    help: false,
    version: false,
  };
}

/** @param {string[]} argv */
function globalForParseError(argv) {
  const global = defaultGlobalOptions();
  if (argv.includes("--json") || argv.includes("--format=json")) {
    global.format = "json";
  }

  const formatIndex = argv.indexOf("--format");
  if (formatIndex !== -1 && argv[formatIndex + 1] === "json") {
    global.format = "json";
  }

  return global;
}

/** @param {string} token */
function splitOption(token) {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex === -1) return { name: token, value: undefined };
  return { name: token.slice(0, equalsIndex), value: token.slice(equalsIndex + 1) };
}

/**
 * @param {string[]} argv
 * @param {number} index
 * @param {string} optionName
 */
function readOptionValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new CliError(CLI_EXIT.USAGE, "MISSING_FLAG_VALUE", `${optionName} requires a value`, { flag: optionName });
  }
  return value;
}

/**
 * @param {string[]} positionals
 * @returns {NormalizedCommand}
 */
function normalizeCommand(positionals) {
  const [first, second, ...rest] = positionals;

  if (!first) return { command: "", args: [] };
  if (first === "help") return { command: "help", args: positionals.slice(1) };
  if (first === "version") return { command: "version", args: positionals.slice(1) };
  if (["ls", "list", "inbox"].includes(first)) return { command: "mail:list", args: positionals.slice(1) };
  if (first === "read") return { command: "mail:read", args: positionals.slice(1) };
  if (first === "otp") return { command: "otp", args: positionals.slice(1) };

  if (first === "doctor") {
    if (second === "config") return { command: "doctor:config", args: rest };
    if (second === "session" || second === "auth") return { command: "doctor:session", args: rest };
    return { command: `doctor:${second || ""}`, args: rest };
  }

  if (first === "mail") {
    if (!second || ["ls", "list", "inbox"].includes(second)) return { command: "mail:list", args: rest };
    if (second === "latest") return { command: "mail:latest", args: rest };
    if (second === "search") return { command: "mail:search", args: rest };
    if (second === "read") return { command: "mail:read", args: rest };
    return { command: `mail:${second}`, args: rest };
  }

  return { command: first, args: positionals.slice(1) };
}

/**
 * @param {CliHandler | undefined} handler
 * @param {unknown[]} args
 * @param {string} commandLabel
 */
async function callInjected(handler, args, commandLabel) {
  if (typeof handler !== "function") {
    throw new CliError(
      CLI_EXIT.UNAVAILABLE,
      "FEATURE_NOT_IMPLEMENTED",
      `${commandLabel} is a CLI contract stub; inject a client implementation to execute it`,
      { command: commandLabel }
    );
  }

  return handler(...args);
}

/**
 * @param {GlobalOptions} global
 * @returns {ClientOptions}
 */
function clientOptions(global) {
  const resolved = resolveCliConfig({ global });
  return {
    timeout: resolved.values.timeout,
    config: resolved.configFile.path,
    session: resolved.values.sessionFile,
    quiet: global.quiet,
    verbose: global.verbose,
    format: global.format,
  };
}

/** @param {WriteSuccessOptions} options */
function writeSuccess({ command, data, global, stdout, version, human }) {
  if (global.format === "json") {
    stdout.write(`${JSON.stringify(jsonEnvelope({ ok: true, command, data, version }))}\n`);
    return CLI_EXIT.OK;
  }

  if (!global.quiet && human) stdout.write(human.endsWith("\n") ? human : `${human}\n`);
  return CLI_EXIT.OK;
}

/** @param {WriteFailureOptions} options */
function writeFailure({ command, error, global, stdout, stderr, version }) {
  const normalized = normalizeError(error);
  if (global.format === "json") {
    stderr.write(`${JSON.stringify(jsonEnvelope({ ok: false, command, error: normalized, version }))}\n`);
  } else {
    stderr.write(`${normalized.message}\n`);
  }
  return normalized.exitCode;
}

/** @param {JsonEnvelopeOptions} options */
function jsonEnvelope({ ok, command, data = null, error = null, version }) {
  return {
    ok,
    command,
    data: ok ? data : null,
    error: ok || !error ? null : errorBody(error),
    meta: {
      version,
      envelope: "pm.v1",
    },
  };
}

/**
 * @param {unknown} error
 * @returns {NormalizedCliError}
 */
function normalizeError(error) {
  if (error instanceof CliError) {
    return {
      exitCode: error.exitCode,
      code: error.code,
      message: String(redact(error.message)),
      details: redact(error.details),
    };
  }

  return {
    exitCode: CLI_EXIT.RUNTIME,
    code: "RUNTIME_ERROR",
    message: String(redact(error instanceof Error && error.message ? error.message : "Unexpected CLI failure")),
  };
}

/**
 * @param {NormalizedCliError} error
 * @returns {CliErrorBody}
 */
function errorBody(error) {
  /** @type {CliErrorBody} */
  const body = { code: error.code, message: error.message };
  if (error.details !== undefined) body.details = error.details;
  return body;
}

/** @param {unknown} data */
function renderList(data) {
  const object = toRecord(data);
  const messages = Array.isArray(object.messages) ? object.messages : Array.isArray(data) ? data : [];
  if (messages.length === 0) return "No messages.\n";
  return `${messages.map((message) => {
    const item = toRecord(message);
    const ref = item.ref || item.ID || item.id || (item.index ?? "<unknown>");
    return `${ref}\t${item.Subject || item.subject || item.preview || "(no subject)"}`;
  }).join("\n")}\n`;
}

/** @param {unknown} data */
function renderObject(data) {
  const object = toRecord(data);
  const message = toRecord(object.message);
  if (message.subject) return `${message.subject}\n`;
  if (object.Subject) return `${object.Subject}\n`;
  if (object.subject) return `${object.subject}\n`;
  return `${JSON.stringify(data)}\n`;
}

/** @param {unknown} data */
function renderRead(data) {
  const message = toRecord(toRecord(data).message);
  if (typeof message.bodyText === "string" && message.bodyText.length > 0) return `${message.bodyText}\n`;
  return renderObject(data);
}

/** @param {unknown} data */
function renderOtp(data) {
  const object = toRecord(data);
  if (object.code) return `${object.code}\n`;
  if (object.link) return `${object.link}\n`;
  if (object.status === "no_match") return "No matching message.\n";
  if (object.status === "matched_without_token") return "Matching message found, but no OTP code or link was present.\n";
  return renderObject(data);
}

/** @param {unknown} data */
function renderDoctor(data) {
  const object = toRecord(data);
  const status = object.status || "unknown";
  return `${status}\n`;
}

/**
 * @param {string} command
 * @param {string[]} args
 */
function formatCommand(command, args) {
  return [command, ...(args || [])].filter(Boolean).join(" ");
}

/** @param {unknown} value */
function toRecord(value) {
  return value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : {};
}

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
