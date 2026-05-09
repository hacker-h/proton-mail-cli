import fs from "node:fs";
import { doctorConfig, doctorSession, redact, resolveCliConfig } from "./config.js";

/**
 * @typedef {{ write(chunk: string): unknown }} WritableLike
 * @typedef {"human" | "json"} CliFormat
 * @typedef {{ format: CliFormat, timeout: number | null, config: string | null, session: string | null, quiet: boolean, verbose: boolean, help: boolean, version: boolean }} GlobalOptions
 * @typedef {{ command: string, args: string[] }} NormalizedCommand
 * @typedef {{ command: string, args: string[], global: GlobalOptions }} ParsedCommand
 * @typedef {(...args: unknown[]) => unknown | Promise<unknown>} CliHandler
 * @typedef {{ list?: CliHandler, latest?: CliHandler, read?: CliHandler }} CliMailClient
 * @typedef {{ get?: CliHandler }} CliOtpClient
 * @typedef {{ session?: CliHandler, auth?: CliHandler }} CliDoctorClient
 * @typedef {{ mail?: CliMailClient, otp?: CliOtpClient, doctor?: CliDoctorClient }} CliClients
 * @typedef {{ argv?: string[], stdout?: WritableLike, stderr?: WritableLike, version?: string, clients?: CliClients }} CliRunOptions
 * @typedef {{ command: string, data: unknown, human: string }} CommandResult
 * @typedef {{ timeout: number | null, config: string, session: string, quiet: boolean, verbose: boolean, format: CliFormat }} ClientOptions
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
      if (value !== "human" && value !== "json") {
        throw new CliError(CLI_EXIT.USAGE, "INVALID_FORMAT", "--format must be human or json", { value });
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
    expectArgs(args, 0, "pm ls");
    const data = await callInjected(clients.mail?.list, [clientOptions(global)], "pm ls");
    return { command, data, human: renderList(data) };
  }

  if (command === "mail:latest") {
    expectArgs(args, 0, "pm mail latest");
    const data = await callInjected(clients.mail?.latest, [clientOptions(global)], "pm mail latest");
    return { command, data, human: renderObject(data) };
  }

  if (command === "mail:read") {
    const messageId = args[0];
    if (!messageId) {
      throw new CliError(CLI_EXIT.USAGE, "MISSING_MESSAGE_ID", "pm read requires <messageId>");
    }
    expectArgs(args, 1, "pm read <messageId>");
    const data = await callInjected(clients.mail?.read, [messageId, clientOptions(global)], "pm read <messageId>");
    return { command, data, human: renderObject(data) };
  }

  if (command === "otp") {
    expectArgs(args, 0, "pm otp");
    const data = await callInjected(clients.otp?.get, [clientOptions(global)], "pm otp");
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
  return `pm ${version}\n\nUsage:\n  pm help\n  pm version\n  pm ls [--json]\n  pm mail latest [--json]\n  pm read <messageId> [--json]\n  pm otp --json\n  pm doctor config --json\n  pm doctor session --json\n\nGlobal flags:\n  --json                 Emit a stable JSON envelope\n  --format <human|json>  Select output format\n  --timeout <seconds>    Set command timeout for injected clients\n  --config <path>        Read CLI config from path\n  --session <path>       Use Proton session state path\n  --quiet                Suppress human success output\n  --verbose              Include verbose client context\n\nAliases:\n  pm ls                  Alias for pm mail list\n  pm list                Alias for pm mail list\n  pm inbox               Alias for pm mail list\n  pm read <messageId>    Alias for pm mail read <messageId>\n  pm doctor auth         Alias for pm doctor session\n`;
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
    return `${item.ID || item.id || "<unknown>"}\t${item.Subject || item.subject || "(no subject)"}`;
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
function renderOtp(data) {
  const object = toRecord(data);
  if (object.code) return `${object.code}\n`;
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
