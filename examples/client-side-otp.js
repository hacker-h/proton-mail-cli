#!/usr/bin/env node
import fs from "node:fs";
const options = parseArgs(process.argv.slice(2));
const message = options.fixture
  ? readFixtureMessage(options.fixture)
  : await readLatestMessage(options);

const code = extractCode(message.bodyText || "", options.pattern);
if (!code) {
  console.error("No code found in message body");
  process.exitCode = 1;
} else if (options.json) {
  console.log(JSON.stringify({ ok: true, code, subject: message.subject || "" }));
} else {
  console.log(code);
}

function parseArgs(argv) {
  const parsed = {
    fixture: "",
    match: "",
    pattern: "\\b(?<code>\\d{6})\\b",
    session: "",
    timeout: 0,
    json: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--fixture") {
      parsed.fixture = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--match") {
      parsed.match = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--pattern") {
      parsed.pattern = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--session") {
      parsed.session = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--timeout") {
      parsed.timeout = Number(readValue(argv, ++index, token));
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return parsed;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function readFixtureMessage(filePath) {
  const fixture = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const data = fixture.data || fixture;
  return data.message || data;
}

async function readLatestMessage(options) {
  const { ProtonMailBrowserClient } = await import("proton-mail-cli");
  const client = new ProtonMailBrowserClient({
    headless: true,
    sessionFile: options.session || undefined,
    timeoutSeconds: options.timeout || undefined,
  });
  const result = await client.getLatestMessage({
    matchText: options.match ? new RegExp(options.match, "iu") : undefined,
  });
  if (!result.success) throw new Error(result.error || "Unable to read latest message");
  return result.message || {};
}

function extractCode(bodyText, pattern) {
  const regex = new RegExp(pattern, "u");
  const match = regex.exec(String(bodyText || ""));
  return match?.groups?.code || match?.[1] || match?.[0] || "";
}
