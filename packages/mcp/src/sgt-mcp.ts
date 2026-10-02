#!/usr/bin/env node
// Serves Sergeant's read-only MCP tools over stdio. Register it with an MCP client as the command
// `node packages/mcp/src/sgt-mcp.ts [--api <url>]` on the host where `serve --trust-loopback` runs:
// it sends no Linear login yet (TECH-4938). The API is --api, else SGT_API_URL, else http://127.0.0.1:8080, as for `sgt`.
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { DEFAULT_API, sergeantMcp } from "./server.ts";

const { values } = parseArgs({ options: { api: { type: "string" } } });
const api = (values.api ?? process.env.SGT_API_URL ?? DEFAULT_API).replace(/\/+$/, "");
await sergeantMcp(api).connect(new StdioServerTransport());
