/**
 * The API-key seam.
 *
 * This server has no sign-in of its own. A developer puts their Jobo API key in
 * the MCP client's config as a header, and a tool that calls the Jobo API
 * forwards it. Tools that answer from the shared filter contract never look at
 * it, so they work with no key at all.
 *
 * `resolveApiKey` is the one function that decides which key a live lookup runs
 * on. Today that is the caller's key, or a refusal. Making live lookups keyless
 * later is a change to that function alone: return a key this server holds when
 * the caller sent none. Those calls would then share one key's rate limit, so
 * that change wants a per-client limit in front of it.
 *
 * Pure and dependency-light so the rules can be unit-tested without a socket.
 */

import { isValidApiKeyFormat } from "@jobo-ai/connector-core";

/** Where a developer creates a key. */
export const API_KEYS_URL = "https://enterprise.jobo.world/api-keys";

/** The environment variable the setup snippets read the key from; `jobo-cli` reads the same one. */
export const API_KEY_ENV = "JOBO_API_KEY";

type HeaderValue = string | string[] | undefined;

function first(value: HeaderValue): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The key an MCP client sent with this request, or undefined when it sent none.
 *
 * `Authorization: Bearer <key>` is the documented form. Two near-misses are
 * taken as well, because both are what a developer types from habit and
 * neither can be mistaken for anything else: the key with no `Bearer` in front
 * of it, and `X-Api-Key`, the header the REST API itself reads.
 */
export function apiKeyFromHeaders(headers: { authorization?: HeaderValue; "x-api-key"?: HeaderValue }): string | undefined {
  const authorization = first(headers.authorization);
  if (authorization) {
    const bearer = /^Bearer(?:\s+(\S+))?$/i.exec(authorization);
    if (bearer?.[1]) return bearer[1];
    // A lone "Bearer" is a header with the key left out, not a key.
    if (!bearer && !/\s/.test(authorization)) return authorization;
  }
  return first(headers["x-api-key"]);
}

/** Why a live lookup could not get a key to run on. */
export class ApiKeyError extends Error {
  constructor(
    /** `missing`: the request carried no key. `malformed`: it carried something that is not one. */
    readonly reason: "missing" | "malformed",
  ) {
    super(reason === "missing" ? "No Jobo API key on the request." : "The value sent as the Jobo API key is not one.");
    this.name = "ApiKeyError";
  }
}

/**
 * The key a live lookup runs on. Every tool that reaches the Jobo API gets its
 * key here and nowhere else.
 *
 * The shape check is the one every Jobo connector runs before its first
 * request (`isValidApiKeyFormat` from the shared contract). Here it also
 * catches the commonest config mistake: a `${JOBO_API_KEY}` placeholder the
 * client never expanded, which would otherwise come back as a bare 401.
 */
export function resolveApiKey(callerKey: string | undefined): string {
  const key = callerKey?.trim();
  if (!key) throw new ApiKeyError("missing");
  if (!isValidApiKeyFormat(key)) throw new ApiKeyError("malformed");
  return key;
}

/** How to add the key, for the two clients this server is mostly used from. */
export function setupHint(endpointUrl: string): string {
  return [
    "Add the key to this server's entry in your MCP client config as a header:",
    `  Authorization: Bearer <your key>`,
    "",
    "Claude Code:",
    `  claude mcp add --transport http jobo-developer ${endpointUrl} --header "Authorization: Bearer $${API_KEY_ENV}"`,
    "Cursor (.cursor/mcp.json), inside the server's entry:",
    `  "headers": { "Authorization": "Bearer \${env:${API_KEY_ENV}}" }`,
    "",
    `Create a key at ${API_KEYS_URL} (live keys start with jbe_live_), then reconnect the server.`,
  ].join("\n");
}

/** Tool-error text for a lookup that had no usable key. Never echoes what was sent. */
export function apiKeyErrorMessage(error: ApiKeyError, tool: string, endpointUrl: string): string {
  const keyless = "`list_filters`, `describe_search_filters` and `build_search_request` need no key and work as they are.";
  if (error.reason === "malformed") {
    return [
      `\`${tool}\` was not run: the value this server received as the Jobo API key is not a Jobo API key.`,
      "Keys start with jbe_live_ or jbe_test_ and are 74 characters long. If the header is written with an " +
        `environment variable (\${${API_KEY_ENV}}), check that the variable is set where the MCP client starts ` +
        "and that the client expands it; an unexpanded placeholder arrives here as plain text.",
      "",
      setupHint(endpointUrl),
      "",
      keyless,
    ].join("\n");
  }
  return [
    `\`${tool}\` calls the Jobo API and needs your Jobo API key. This request carried none.`,
    "",
    setupHint(endpointUrl),
    "",
    keyless,
  ].join("\n");
}
