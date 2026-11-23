#!/usr/bin/env node
/**
 * Jobo developer MCP server.
 *
 * The third Jobo MCP server, and the one for people writing code. The
 * job-search server (`../mcp`, jobs-mcp.jobo.world) is for assistants answering
 * a job seeker; the analytics server (mcp.jobo.world) runs SQL. This one sits
 * in a coding agent while a developer builds against the REST API, and answers
 * "which id, which value, which field": company ids, occupations, filter
 * values, the filter contract, and a checked request body. It never searches.
 *
 * Same stack as the job-search server: Streamable HTTP on one `/mcp` endpoint,
 * stateless, both protocol eras. The difference is auth. There is no OAuth
 * here: a developer already holds an API key, and a coding agent or a CI job
 * sets a static header far more easily than it completes a browser sign-in.
 *
 * Local mode: `--stdio` serves the same six tools over stdin and stdout, for a
 * client that starts the server as a child process and for a directory that
 * builds and inspects one. The key is then the `JOBO_API_KEY` environment
 * variable; nothing listens on a port.
 */

import { createHash } from "node:crypto";

import express from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { API_KEY_ENV, STDIO, apiKeyFromHeaders } from "./auth.js";
import {
  ENDPOINT_URL,
  PORT,
  PROTOCOL_VERSIONS,
  PUBLIC_URL,
  REGISTRY_NAME,
  SERVER_DESCRIPTION,
  SERVER_ICONS,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_VERSION,
  SERVER_WEBSITE,
} from "./config.js";
import {
  AI_CATALOG_MEDIA_TYPE,
  SERVER_CARD_MEDIA_TYPE,
  buildAiCatalog,
  buildServerCard,
  etagMatches,
  serverCardUrl,
} from "./discovery.js";
import { buildServer } from "./server.js";
import { apiBaseUrl } from "./upstream.js";

// ─────────────────────────────────────────────────────────────────────────────
//  The API key
//
//  Nothing on `/mcp` is refused at the HTTP layer. The handshake, `tools/list`
//  and the three contract tools are the same for every caller and touch no
//  upstream, so they are answered with no key. A tool that does need the key
//  and gets none says so in its own result, with the header to add: a 401
//  would make an MCP client start an OAuth flow this server does not have,
//  which is why there is no protected-resource metadata either.
//
//  The key is read from the current request and handed to the tool call as
//  `ctx.http.authInfo.token`; it is forwarded to the Jobo API, never stored and
//  never logged. Which key a lookup runs on is decided in one place:
//  `resolveApiKey` in `auth.ts`.
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

function attachApiKey(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  const key = apiKeyFromHeaders(req.headers);
  if (key) req.auth = { token: key, clientId: "", scopes: [] };
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP server
// ─────────────────────────────────────────────────────────────────────────────

export const app = express();
app.use(express.json({ limit: "1mb" }));

// Server Card (SEP-2127) and the AI Catalog pointing at it: who the server is
// and where to connect, for a client that has not connected yet. Identity and
// the endpoint URL only, no tools and no credentials. The CORS and cache
// headers are the ones the card's discovery doc asks for.
function publicDocument(mediaType: string, document: object): express.RequestHandler {
  const body = JSON.stringify(document);
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  return (req, res) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
      "Access-Control-Expose-Headers": "ETag",
      "Cache-Control": "public, max-age=3600",
      ETag: etag,
    });
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    if (etagMatches(req.headers["if-none-match"], etag)) {
      res.status(304).end();
      return;
    }
    res.type(mediaType).send(body);
  };
}

const serverCard = publicDocument(
  SERVER_CARD_MEDIA_TYPE,
  buildServerCard({
    name: REGISTRY_NAME,
    title: SERVER_TITLE,
    version: SERVER_VERSION,
    description: SERVER_DESCRIPTION,
    websiteUrl: SERVER_WEBSITE,
    icons: SERVER_ICONS,
    endpointUrl: ENDPOINT_URL,
    protocolVersions: PROTOCOL_VERSIONS,
  }),
);
const aiCatalog = publicDocument(AI_CATALOG_MEDIA_TYPE, buildAiCatalog(REGISTRY_NAME, serverCardUrl(ENDPOINT_URL)));
// `/mcp/server-card` is the reserved location: the card sits under the endpoint
// it describes, as its own route.
app.get("/mcp/server-card", serverCard);
app.options("/mcp/server-card", serverCard);
app.get("/.well-known/ai-catalog.json", aiCatalog);
app.options("/.well-known/ai-catalog.json", aiCatalog);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: `${SERVER_NAME}-mcp`, version: SERVER_VERSION });
});

// One factory, one endpoint, both protocol eras: `createMcpHandler` serves the
// 2026-07-28 revision (natively stateless — no handshake, no sessions) and,
// via its default `legacy: 'stateless'` fallback, answers 2025-era clients
// through a fresh server and transport per request. No session map, so a
// restart strands nobody and the deployment is not pinned to one replica.
// Method semantics (legacy GET/DELETE → 405) are owned by the handler.
// `toNodeHandler` forwards `req.auth` as the pass-through authInfo that tool
// handlers read via `ctx.http.authInfo`.
const mcpHandler = createMcpHandler(buildServer, {
  onerror: (err) => console.error("MCP request handling failed:", err),
});
const handleMcp = toNodeHandler(mcpHandler, {
  onerror: (err) => console.error("MCP request handling failed:", err),
});
app.all("/mcp", attachApiKey, (req, res) => {
  void handleMcp(req, res, req.body);
});

// Local mode. stdout carries the protocol, so the one start-up line goes to
// stderr, where a client shows it in its server log.
if (STDIO) {
  serveStdio(buildServer, { onerror: (err) => console.error("MCP request handling failed:", err) });
  console.error(
    `Jobo developer MCP server on stdio (${
      process.env[API_KEY_ENV]?.trim() ? "API key set" : `no ${API_KEY_ENV}: the three find_ tools will ask for one`
    }).`,
  );
}

// Skipped under test, which imports `app` directly, and in local mode.
if (!STDIO && process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Jobo developer MCP server listening on :${PORT}`);
    console.log(`  Public URL:    ${PUBLIC_URL}`);
    console.log(`  Upstream API:  ${apiBaseUrl()}`);
    console.log("  Auth:          the caller's Jobo API key (Authorization: Bearer), forwarded as X-Api-Key");
    console.log("  Without a key: handshake, tools/list, list_filters, describe_search_filters, build_search_request");
    console.log(`  Server card:   ${serverCardUrl(ENDPOINT_URL)}`);
  });
}
