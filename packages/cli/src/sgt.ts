#!/usr/bin/env node
import { main } from "./cli.ts";

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
