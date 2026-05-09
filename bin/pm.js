#!/usr/bin/env node
import { runPmCli } from "../src/cli.js";

const exitCode = await runPmCli({ argv: process.argv.slice(2) });
process.exitCode = exitCode;
