import fs from "node:fs";

export const CLI_EXIT = Object.freeze({
  OK: 0,
  USAGE: 1,
  UNAVAILABLE: 2,
  RUNTIME: 3,
});

const DEFAULT_FORMAT = "human";
const VERSION = readPackageVersion();

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
      if (!["human", "json"].includes(value)) {
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

export async function dispatchCommand({ command, args, global, clients = {} }) {
  if (command === "mail:list") {
    const data = await callInjected(clients.mail?.list, [clientOptions(global)], "pm ls");
    return { command, data, human: renderList(data) };
  }

  if (command === "mail:latest") {
    const data = await callInjected(clients.mail?.latest, [clientOptions(global)], "pm mail latest");
    return { command, data, human: renderObject(data) };
  }

  if (command === "mail:read") {
    const messageId = args[0];
    if (!messageId) {
      throw new CliError(CLI_EXIT.USAGE, "MISSING_MESSAGE_ID", "pm read requires <messageId>");
    }
    const data = await callInjected(clients.mail?.read, [messageId, clientOptions(global)], "pm read <messageId>");
    return { command, data, human: renderObject(data) };
  }

  if (command === "otp") {
    const data = await callInjected(clients.otp?.get, [clientOptions(global)], "pm otp");
    return { command, data, human: renderOtp(data) };
  }

  throw new CliError(CLI_EXIT.USAGE, "UNKNOWN_COMMAND", `Unknown command: ${formatCommand(command, args)}`, {
    command,
    args,
  });
}

export function rootHelp(version = VERSION) {
  return `pm ${version}\n\nUsage:\n  pm help\n  pm version\n  pm ls [--json]\n  pm mail latest [--json]\n  pm read <messageId> [--json]\n  pm otp --json\n\nGlobal flags:\n  --json                 Emit a stable JSON envelope\n  --format <human|json>  Select output format\n  --timeout <seconds>    Set command timeout for injected clients\n  --config <path>        Read CLI config from path\n  --session <path>       Use Proton session state path\n  --quiet                Suppress human success output\n  --verbose              Include verbose client context\n\nAliases:\n  pm ls                  Alias for pm mail list\n  pm list                Alias for pm mail list\n  pm inbox               Alias for pm mail list\n  pm read <messageId>    Alias for pm mail read <messageId>\n`;
}

export class CliError extends Error {
  constructor(exitCode, code, message, details) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

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

function splitOption(token) {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex === -1) return { name: token, value: undefined };
  return { name: token.slice(0, equalsIndex), value: token.slice(equalsIndex + 1) };
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new CliError(CLI_EXIT.USAGE, "MISSING_FLAG_VALUE", `${optionName} requires a value`, { flag: optionName });
  }
  return value;
}

function normalizeCommand(positionals) {
  const [first, second, ...rest] = positionals;

  if (!first) return { command: "", args: [] };
  if (first === "help") return { command: "help", args: positionals.slice(1) };
  if (first === "version") return { command: "version", args: positionals.slice(1) };
  if (["ls", "list", "inbox"].includes(first)) return { command: "mail:list", args: positionals.slice(1) };
  if (first === "read") return { command: "mail:read", args: positionals.slice(1) };
  if (first === "otp") return { command: "otp", args: positionals.slice(1) };

  if (first === "mail") {
    if (!second || ["ls", "list", "inbox"].includes(second)) return { command: "mail:list", args: rest };
    if (second === "latest") return { command: "mail:latest", args: rest };
    if (second === "read") return { command: "mail:read", args: rest };
    return { command: `mail:${second}`, args: rest };
  }

  return { command: first, args: positionals.slice(1) };
}

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

function clientOptions(global) {
  return {
    timeout: global.timeout,
    config: global.config,
    session: global.session,
    quiet: global.quiet,
    verbose: global.verbose,
    format: global.format,
  };
}

function writeSuccess({ command, data, global, stdout, version, human }) {
  if (global.format === "json") {
    stdout.write(`${JSON.stringify(jsonEnvelope({ ok: true, command, data, version }))}\n`);
    return CLI_EXIT.OK;
  }

  if (!global.quiet && human) stdout.write(human.endsWith("\n") ? human : `${human}\n`);
  return CLI_EXIT.OK;
}

function writeFailure({ command, error, global, stdout, stderr, version }) {
  const normalized = normalizeError(error);
  if (global.format === "json") {
    stderr.write(`${JSON.stringify(jsonEnvelope({ ok: false, command, error: normalized, version }))}\n`);
  } else {
    stderr.write(`${normalized.message}\n`);
  }
  return normalized.exitCode;
}

function jsonEnvelope({ ok, command, data = null, error = null, version }) {
  return {
    ok,
    command,
    data: ok ? data : null,
    error: ok ? null : errorBody(error),
    meta: {
      version,
      envelope: "pm.v1",
    },
  };
}

function normalizeError(error) {
  if (error instanceof CliError) {
    return {
      exitCode: error.exitCode,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  return {
    exitCode: CLI_EXIT.RUNTIME,
    code: "RUNTIME_ERROR",
    message: error?.message || "Unexpected CLI failure",
  };
}

function errorBody(error) {
  const body = { code: error.code, message: error.message };
  if (error.details !== undefined) body.details = error.details;
  return body;
}

function renderList(data) {
  const messages = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [];
  if (messages.length === 0) return "No messages.\n";
  return `${messages.map((message) => `${message.ID || message.id || "<unknown>"}\t${message.Subject || message.subject || "(no subject)"}`).join("\n")}\n`;
}

function renderObject(data) {
  if (data?.message?.subject) return `${data.message.subject}\n`;
  if (data?.Subject) return `${data.Subject}\n`;
  if (data?.subject) return `${data.subject}\n`;
  return `${JSON.stringify(data)}\n`;
}

function renderOtp(data) {
  if (data?.code) return `${data.code}\n`;
  return renderObject(data);
}

function formatCommand(command, args) {
  return [command, ...(args || [])].filter(Boolean).join(" ");
}

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
