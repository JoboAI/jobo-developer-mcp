/**
 * Who this server is and where it runs. Read once, at load.
 *
 * The identity is shared by `server/discover` and the Server Card, which must
 * not contradict each other. REGISTRY_NAME, the title, the description and the
 * version are the ones in `server.json`; a test fails when they drift apart.
 */

import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";

import { STDIO } from "./auth.js";

/**
 * The public base URL, used in the Server Card and in the setup snippet a tool
 * prints when the API key is missing. Set it to whatever host actually serves
 * this copy.
 */
export const PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? "https://dev-mcp.jobo.world").replace(/\/+$/, "");
export const ENDPOINT_URL = `${PUBLIC_URL}/mcp`;
export const PORT = Number(process.env.PORT ?? 3003);

export const SERVER_NAME = "jobo-developer";
export const SERVER_VERSION = "0.2.1";
export const REGISTRY_NAME = "world.jobo/developer";
export const SERVER_TITLE = "Jobo Developer";
export const SERVER_DESCRIPTION =
  "Look up Jobo company ids, occupations and filter values while you build on the Jobo jobs API.";
export const SERVER_WEBSITE = "https://jobo.world/docs";
export const SERVER_ICONS = [
  { src: "https://jobo.world/apple-touch-icon.png", mimeType: "image/png", sizes: ["180x180"] },
  { src: "https://jobo.world/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
];

/** Sent upstream as `User-Agent`. Local mode says so, to tell the two apart in the API's logs. */
export const USER_AGENT = `jobo-developer-mcp/${SERVER_VERSION}${STDIO ? " (stdio)" : ""}`;

/** The job-search server: where an assistant searches jobs. Named in the instructions so an agent does not look for search here. */
export const JOB_SEARCH_MCP_URL = "https://jobs-mcp.jobo.world/mcp";

/** 2026-07-28 first, then every 2025-era revision the legacy fallback answers. */
export const PROTOCOL_VERSIONS: readonly string[] = ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS];
