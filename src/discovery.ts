/**
 * The static discovery documents: the MCP Server Card (SEP-2127) and the AI
 * Catalog that points at it.
 *
 * Copied from the job-search server (`../../mcp/src/discovery.ts`, 1.3.0), not
 * imported: each server is built by its own Dockerfile from its own directory,
 * and that one is mirrored to a public repository on its own, so neither can
 * reach into the other. Keep the two in step by hand; `buildServerCard`,
 * `serverCardUrl`, `etagMatches` and `buildAiCatalog` are the same code, with
 * one difference: `repositoryUrl` is optional here, because this server has no
 * public source repository yet.
 *
 * What is left out is that file's in-protocol allow-list. There, `/mcp` sits
 * behind OAuth and the list decides which requests may skip the token. Here
 * `/mcp` has no gate at all: the handshake, `tools/list` and the keyless tools
 * are answered for everyone, and a tool that needs the API key says so in its
 * own result.
 *
 * Pure and dependency-free so the rules can be unit-tested without a socket.
 */

export const SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";
export const AI_CATALOG_MEDIA_TYPE = "application/ai-catalog+json";

export interface ServerCardIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
}

export interface ServerCardInput {
  /** Registry-style name, `namespace/name` — the card schema requires the slash. */
  name: string;
  title: string;
  version: string;
  /** At most 100 characters (card schema). */
  description: string;
  websiteUrl: string;
  /** Left out of the card when the source is not public. */
  repositoryUrl?: string;
  icons: ServerCardIcon[];
  /** The Streamable HTTP endpoint, e.g. `https://dev-mcp.jobo.world/mcp`. */
  endpointUrl: string;
  protocolVersions: readonly string[];
}

export interface ServerCard {
  $schema: string;
  name: string;
  version: string;
  description: string;
  title: string;
  websiteUrl: string;
  repository?: { url: string; source: string };
  icons: ServerCardIcon[];
  remotes: { type: "streamable-http"; url: string; supportedProtocolVersions: string[] }[];
}

/**
 * The Server Card: who the server is and where to connect, for a client that
 * has not connected yet. The format deliberately carries no tools (those stay
 * behind `tools/list`) and no auth fields.
 */
export function buildServerCard(input: ServerCardInput): ServerCard {
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: input.name,
    version: input.version,
    description: input.description,
    title: input.title,
    websiteUrl: input.websiteUrl,
    ...(input.repositoryUrl ? { repository: { url: input.repositoryUrl, source: "github" } } : {}),
    icons: input.icons,
    remotes: [
      {
        type: "streamable-http",
        url: input.endpointUrl,
        supportedProtocolVersions: [...input.protocolVersions],
      },
    ],
  };
}

/** Where a server's card lives: the reserved `/server-card` under its endpoint. */
export function serverCardUrl(endpointUrl: string): string {
  return `${endpointUrl}/server-card`;
}

/**
 * Whether an `If-None-Match` header names this ETag. Done by hand rather than
 * left to Express's freshness check: `fetch` adds `Cache-Control: no-cache` to
 * any request that sets `If-None-Match` itself, and Express then answers 200.
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}

export interface AiCatalog {
  specVersion: "1.0";
  entries: { identifier: string; type: string; url: string }[];
}

/**
 * The AI Catalog served at `/.well-known/ai-catalog.json`: how a client that
 * knows only the host finds the card. `identifier` follows the discovery doc's
 * one worked example (`com.example/weather` → `urn:air:example.com:mcp:weather`).
 */
export function buildAiCatalog(cardName: string, cardUrl: string): AiCatalog {
  const [namespace = "", name = ""] = cardName.split("/");
  const publisher = namespace.split(".").reverse().join(".");
  return {
    specVersion: "1.0",
    entries: [
      {
        identifier: `urn:air:${publisher}:mcp:${name}`,
        type: SERVER_CARD_MEDIA_TYPE,
        url: cardUrl,
      },
    ],
  };
}
