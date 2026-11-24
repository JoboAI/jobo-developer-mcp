/**
 * The MCP server and its eight tools.
 *
 * All eight are read-only and free. Three reach the Jobo API and need the
 * caller's API key (`find_companies`, `find_filter_values`, `find_locations`);
 * five answer from the filter contracts with no key and no network
 * (`list_filters`, `describe_search_filters`, `build_search_request`, and for
 * Hiring Signals `describe_signal_filters`, `build_signals_request`).
 * `TOOL_CATALOG` says which is which, and the tests hold every tool to it.
 * No tool reads signals: every signal returned is billed.
 *
 * The descriptions are written for an agent that is writing integration code:
 * what to store, which field of the request a value goes into, what it costs
 * to send. The job-search server describes the same lookups for an assistant
 * answering a job seeker; the two are meant to read differently.
 */

import { McpServer } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  JOB_SEARCH_FILTERS,
  type FilterDescriptor,
  type FilterOptionsResponse,
  type OccupationTaxonomyResponse,
  type SuggestCompaniesResponse,
  type SuggestLocationsResponse,
} from "@jobo-ai/connector-core";
import { z } from "zod";

import { API_KEYS_URL, API_KEY_ENV, STDIO, callerApiKey, resolveApiKey } from "./auth.js";
import {
  ENDPOINT_URL,
  JOB_SEARCH_MCP_URL,
  SERVER_DESCRIPTION,
  SERVER_ICONS,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_VERSION,
  SERVER_WEBSITE,
  USER_AGENT,
} from "./config.js";
import {
  BILLING_SUMMARY,
  DEFAULT_PAGE_SIZE,
  FILTER_VALUE_FACETS,
  MAX_PAGE_SIZE,
  PUBLIC_API_URL,
  REQUEST_OPTIONS,
  describeFilter,
  describeSearchFilters,
  fixedVocabularies,
  hasClosedVocabulary,
  lookupFor,
} from "./contract.js";
import { isUnavailable, toToolError } from "./errors.js";
import {
  type OccupationRow,
  flattenOccupations,
  matchOccupations,
  renderBuildResult,
  renderCompanies,
  renderFilterContract,
  renderFilterValues,
  renderFixedVocabularies,
  renderLocations,
  renderOccupationMatches,
  renderSignalFilterContract,
  renderSignalsBuildResult,
  resolvePlace,
} from "./format.js";
import { buildSearchRequest } from "./request.js";
import {
  COMPANY_SIGNAL_FILTER_KEYS,
  HIRING_SIGNAL_FILTERS,
  SIGNAL_DEFAULT_LIMIT,
  SIGNAL_MAX_LIMIT,
  SIGNAL_MAX_LIST_VALUES,
  describeSignalFilters,
  type SignalFilterDescriptor,
} from "./signals-contract.js";
import { buildSignalsRequest } from "./signals-request.js";
import { callApi, type CallOptions, type FreeEndpoint } from "./upstream.js";

// ─────────────────────────────────────────────────────────────────────────────
//  The catalogue
// ─────────────────────────────────────────────────────────────────────────────

interface ToolEntry {
  /** Whether the tool reaches the Jobo API, and so needs the caller's API key. */
  needsKey: boolean;
  /** The upstream endpoints the tool may call. A call to any other is refused. */
  upstream: readonly FreeEndpoint[];
}

export const TOOL_CATALOG = {
  find_companies: { needsKey: true, upstream: ["companiesSuggest"] },
  find_filter_values: { needsKey: true, upstream: ["filterOptions", "occupations"] },
  find_locations: { needsKey: true, upstream: ["locationsSuggest"] },
  list_filters: { needsKey: false, upstream: [] },
  describe_search_filters: { needsKey: false, upstream: [] },
  build_search_request: { needsKey: false, upstream: [] },
  describe_signal_filters: { needsKey: false, upstream: [] },
  build_signals_request: { needsKey: false, upstream: [] },
} as const satisfies Record<string, ToolEntry>;

export type ToolName = keyof typeof TOOL_CATALOG;

/** Carried in each tool's `_meta`, so a client listing tools can tell which ones need the key. */
export const API_KEY_META = "world.jobo/api-key";

export const SERVER_INSTRUCTIONS =
  "Jobo developer tools: reference lookups for writing code against the Jobo REST API " +
  `(${PUBLIC_API_URL}, API key in the \`X-Api-Key\` header), a live index of open jobs collected from employer ` +
  "career sites and 200+ applicant tracking systems. Use this server while building an integration. It does not " +
  "search jobs: the code you write does that, with `POST /api/jobs/search` or the `jobo` CLI. The separate Jobo " +
  `job-search MCP server (${JOB_SEARCH_MCP_URL}) is for assistants answering questions about jobs.\n\n` +
  "How to use it: `describe_search_filters` gives the filter contract (names, types, where each goes in the " +
  "request body). `list_filters` gives the fixed vocabularies. `find_companies`, `find_filter_values` and " +
  "`find_locations` turn a name into the id or exact value a filter takes. `build_search_request` checks a set " +
  "of filters and returns the request body, a curl command, a PowerShell command and a `jobo` CLI command. Filter values are matched " +
  "exactly, and a value the index does not hold returns zero jobs rather than an error, so look values up " +
  "instead of guessing them.\n\n" +
  "Hiring Signals (`GET /api/signals`, `GET /api/companies/{id}/signals`): company-level events detected from job " +
  "postings (a hiring surge, a first job in a country, a leadership search). `describe_signal_filters` gives that " +
  "contract: filters, the focus-filter rule, paging, billing, and how to poll for new signals. `build_signals_request` " +
  "checks a set of signals filters and returns the GET request, curl, PowerShell and `jobo signals` commands.\n\n" +
  `What costs money: nothing on this server. In the code you write: ${BILLING_SUMMARY} ` +
  "Hiring Signals are billed per signal returned, at ten times the price of a job, and a signal read again is billed " +
  "again. `build_search_request` and `build_signals_request` never send the request, and no tool here reads signals. " +
  "Do not run a command they return unless the user wants it run, and keep `page_size` or `limit` small while " +
  "testing; a sandbox key (jbe_test_…) runs search against fictional jobs at no charge and cannot read signals.\n\n" +
  "The key: the three `find_` tools call the Jobo API with the developer's own API key, " +
  (STDIO
    ? `read from the \`${API_KEY_ENV}\` environment variable this server was started with. `
    : "sent by the MCP client as `Authorization: Bearer <key>` in this server's config. ") +
  "The other five need no key. Keys are created at " +
  `${API_KEYS_URL}. Never write a key into source files: read it from the \`${API_KEY_ENV}\` environment variable.`;

// ─────────────────────────────────────────────────────────────────────────────
//  Shared pieces
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { http?: { authInfo?: AuthInfo } };
type Structured = { [key: string]: unknown };

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function meta(tool: ToolName): Record<string, unknown> {
  return { [API_KEY_META]: TOOL_CATALOG[tool].needsKey ? "required" : "not-needed" };
}

function reply(text: string, structured: object) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured as Structured };
}

/**
 * One free lookup for one tool, on the caller's key. The only way a tool
 * reaches the Jobo API: the key comes from `resolveApiKey`, and an endpoint
 * the tool did not declare in `TOOL_CATALOG` is refused before anything is sent.
 */
function lookup<T>(tool: ToolName, endpoint: FreeEndpoint, ctx: Ctx, options: CallOptions = {}): Promise<T> {
  if (!(TOOL_CATALOG[tool].upstream as readonly FreeEndpoint[]).includes(endpoint)) {
    throw new Error(`${tool} is not declared to call ${endpoint}`);
  }
  const apiKey = resolveApiKey(callerApiKey(ctx.http?.authInfo?.token));
  const caller = ctx.http?.authInfo?.extra?.forwardedFor;
  return callApi<T>(endpoint, apiKey, {
    ...options,
    userAgent: USER_AGENT,
    ...(typeof caller === "string" ? { forwardedFor: caller } : {}),
  });
}

const failure = (tool: ToolName) => (err: unknown) => toToolError(err, { tool, endpointUrl: ENDPOINT_URL });

const KEYED =
  (STDIO
    ? `Needs the Jobo API key in the \`${API_KEY_ENV}\` environment variable; `
    : "Needs the Jobo API key in this server's `Authorization: Bearer` header; ") +
  "a sandbox key (jbe_test_…) cannot use it. Free: rate limited, never billed.";
const KEYLESS = "No API key and no network call: it answers from the filter contract this server ships with.";

// ─────────────────────────────────────────────────────────────────────────────
//  build_search_request input, generated from the contract
// ─────────────────────────────────────────────────────────────────────────────

type JsonSchemaHint = Record<string, unknown>;

const STRING: JsonSchemaHint = { type: "string" };
const INTEGER: JsonSchemaHint = { type: "integer" };
const STRING_LIST: JsonSchemaHint = { type: "array", items: { type: "string" } };
const STRING_OR_LIST: JsonSchemaHint = { anyOf: [STRING_LIST, STRING] };

/** The JSON type a filter's value has, as published in `tools/list`. */
function parameterType(filter: FilterDescriptor): JsonSchemaHint {
  switch (filter.kind) {
    case "stringList":
    case "enumList":
      return STRING_OR_LIST;
    case "number":
      return INTEGER;
    case "boolean":
      return { type: "boolean" };
    case "string":
      return filter.key === "location" ? STRING_OR_LIST : STRING;
    case "enum":
    case "dateTime":
      return STRING;
    default: {
      const unhandled: never = filter.kind;
      throw new Error(`Unhandled filter kind: ${String(unhandled)}`);
    }
  }
}

/**
 * One parameter of `build_search_request`: its JSON type and description are
 * published, and nothing is enforced. A string where a number belongs has to
 * reach `buildSearchRequest`, which says what to send instead; typed here, the
 * SDK would turn it away first with a generic "Input validation error".
 */
function parameter(type: JsonSchemaHint, description: string) {
  return z.unknown().optional().meta({ ...type, description });
}

function parameterDescription(filter: FilterDescriptor): string {
  const described = describeFilter(filter);
  const parts = [filter.description];
  if (filter.options && filter.key !== "language") {
    parts.push(`${hasClosedVocabulary(filter) ? "One of" : "Known values"}: ${filter.options.join(", ")}.`);
  }
  const source = lookupFor(filter);
  if (source && source.tool !== "list_filters") {
    parts.push(`Look values up with \`${source.tool}\`${source.arguments ? ` (facet ${source.arguments.facet})` : ""}.`);
  }
  if (filter.kind === "stringList" || filter.kind === "enumList") parts.push("An array; one string is one value.");
  if (filter.key === "location") parts.push("A string, or an array for several places.");
  if (filter.kind === "dateTime") parts.push("ISO 8601.");
  if (described.body_field) parts.push(`Body field: \`${described.body_field}\`.`);
  return parts.join(" ");
}

/** A request option's description, with its values, as `describe_search_filters` gives them. */
function optionDescription(name: string): string {
  const option = REQUEST_OPTIONS.find((entry) => entry.name === name);
  if (!option) throw new Error(`No request option named ${name}`);
  return `${option.description}${option.values ? ` Values: ${option.values.join(", ")}.` : ""}`;
}

/**
 * One optional parameter per contract filter, plus the request options. Loose
 * twice over, so that every mistake is answered by `buildSearchRequest` in its
 * own words: an unknown key gets through (and is told which filter was meant,
 * instead of being dropped without a word), and so does a value of the wrong
 * type.
 */
export const BUILD_SEARCH_REQUEST_INPUT = z.looseObject({
  ...Object.fromEntries(
    JOB_SEARCH_FILTERS.map((filter) => [filter.key, parameter(parameterType(filter), parameterDescription(filter))]),
  ),
  page: parameter(INTEGER, "1-based page number. Default 1."),
  page_size: parameter(
    INTEGER,
    `Jobs per page, 1–${MAX_PAGE_SIZE} (API default ${DEFAULT_PAGE_SIZE}). The most the request can bill: every job returned is billed.`,
  ),
  include_fields: parameter(STRING_LIST, optionDescription("include_fields")),
  include_facets: parameter(STRING_LIST, optionDescription("include_facets")),
});

// ─────────────────────────────────────────────────────────────────────────────
//  build_signals_request input, generated from the signals contract
// ─────────────────────────────────────────────────────────────────────────────

function signalParameterType(filter: SignalFilterDescriptor): JsonSchemaHint {
  switch (filter.kind) {
    case "stringList":
    case "enumList":
      return STRING_OR_LIST;
    case "number":
      return INTEGER;
    case "boolean":
      return { type: "boolean" };
    case "date":
    case "dateTime":
      return STRING;
    default: {
      const unhandled: never = filter.kind;
      throw new Error(`Unhandled filter kind: ${String(unhandled)}`);
    }
  }
}

function signalParameterDescription(filter: SignalFilterDescriptor): string {
  const parts = [filter.description];
  if (filter.options) parts.push(`One of: ${filter.options.join(", ")}.`);
  if (filter.kind === "stringList" || filter.kind === "enumList") {
    parts.push(`An array; no value may contain a comma; at most ${SIGNAL_MAX_LIST_VALUES} values.`);
  }
  if (filter.kind === "number" && filter.min !== undefined && filter.max !== undefined) parts.push(`${filter.min} to ${filter.max}.`);
  if (filter.kind === "dateTime") parts.push("ISO 8601 with seconds, e.g. 2026-11-12T09:30:00Z.");
  if (!filter.company) parts.push("Not taken with `company_id`.");
  return parts.join(" ");
}

/** Loose for the same reason as `BUILD_SEARCH_REQUEST_INPUT`: every mistake is answered in `buildSignalsRequest`'s words. */
export const BUILD_SIGNALS_REQUEST_INPUT = z.looseObject({
  ...Object.fromEntries(
    HIRING_SIGNAL_FILTERS.map((filter) => [filter.key, parameter(signalParameterType(filter), signalParameterDescription(filter))]),
  ),
  company_id: parameter(
    STRING,
    "One Jobo company id (a GUID): the request then reads `GET /api/companies/{id}/signals`, which takes only " +
      `${COMPANY_SIGNAL_FILTER_KEYS.join(", ")}. Look the id up with \`find_companies\`.`,
  ),
  limit: parameter(
    INTEGER,
    `Signals per page, 1–${SIGNAL_MAX_LIMIT} (API default ${SIGNAL_DEFAULT_LIMIT}). The most the request can bill: every signal returned is billed.`,
  ),
  cursor: parameter(STRING, "The previous page's `next_cursor`, unchanged, with the same filters."),
});

// ─────────────────────────────────────────────────────────────────────────────
//  The server
// ─────────────────────────────────────────────────────────────────────────────

/** The catalogue is the same for every caller and only changes on a deploy. */
const PUBLIC_CACHE = { ttlMs: 5 * 60 * 1000, cacheScope: "public" } as const;

/** The most occupations the facet endpoint counts in one response. */
const MAX_FACET_VALUES = 250;

// ─────────────────────────────────────────────────────────────────────────────
//  Occupations by name
//
//  The facet endpoint's `q` matches occupation ids, not names, so a role name
//  is matched here against the taxonomy. Two calls stand behind that, and they
//  are not equals. The taxonomy is the answer: without it the lookup fails.
//  The live job counts are a label on the answer: when the API cannot give
//  them, the matches go out without.
// ─────────────────────────────────────────────────────────────────────────────

/** The taxonomy only changes when the API ships a new one, and it is the same for every caller. */
const TAXONOMY_TTL_MS = 5 * 60 * 1000;
let taxonomyCache: { rows: OccupationRow[]; expires: number } | undefined;

/** Forget the cached taxonomy. For tests. */
export function clearOccupationCache(): void {
  taxonomyCache = undefined;
}

/**
 * The flattened taxonomy, downloaded at most once every few minutes rather
 * than on every lookup. A cached copy is only ever served next to a counts
 * call made on the caller's own key (see `occupationCounts`), so a key the API
 * rejects still gets the API's rejection, not the cache.
 */
async function occupationRows(ctx: Ctx): Promise<OccupationRow[]> {
  if (taxonomyCache && taxonomyCache.expires > Date.now()) return taxonomyCache.rows;
  const rows = flattenOccupations(await lookup<OccupationTaxonomyResponse>("find_filter_values", "occupations", ctx));
  taxonomyCache = { rows, expires: Date.now() + TAXONOMY_TTL_MS };
  return rows;
}

/**
 * Live jobs per occupation id, or null when the API could not give them (a
 * 5xx, a 429, a timeout, no connection). A refusal is not swallowed: a missing
 * or rejected key, or a 404, fails the lookup as it would any other.
 */
async function occupationCounts(ctx: Ctx): Promise<Map<string, number> | null> {
  try {
    const counted = await lookup<FilterOptionsResponse>("find_filter_values", "filterOptions", ctx, {
      facet: "occupations",
      query: { limit: MAX_FACET_VALUES },
    });
    return new Map((counted.options ?? []).map((option) => [option.key, option.count]));
  } catch (err) {
    if (isUnavailable(err)) return null;
    throw err;
  }
}

export function buildServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version: SERVER_VERSION,
      websiteUrl: SERVER_WEBSITE,
      description: SERVER_DESCRIPTION,
      icons: SERVER_ICONS,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
      cacheHints: { "server/discover": PUBLIC_CACHE, "tools/list": PUBLIC_CACHE },
    },
  );

  // ── find_companies ───────────────────────────────────────────────────────
  server.registerTool(
    "find_companies",
    {
      title: "Find company ids",
      description:
        "Resolve a company name or website domain to its Jobo company ids. Prefix match on the name or the domain " +
        "(2+ characters). Returns each company's ids, domain, HQ country (ISO 3166-1 alpha-2) and live job count, " +
        "companies with live jobs first. Use it when the integration you are writing filters jobs by employer: " +
        "store the ids, not the name, because a name also matches every other company called that. One company " +
        "has one id per careers board, so put every id it returns into the `companies` filter (or " +
        `\`exclude_companies\`). ${KEYED}`,
      inputSchema: z.object({
        q: z.string().trim().min(2).describe("Start of the company name or website domain, e.g. 'stripe' or 'stripe.com'."),
        limit: z.number().int().min(1).max(20).optional().describe("Most companies to return, 1–20 (default 8)."),
      }),
      annotations: { title: "Find company ids", ...READ_ONLY },
      _meta: meta("find_companies"),
    },
    async ({ q, limit }, ctx) => {
      try {
        const res = await lookup<SuggestCompaniesResponse>("find_companies", "companiesSuggest", ctx, { query: { q, limit } });
        const suggestions = res.suggestions ?? [];
        return reply(renderCompanies(q, suggestions), { query: q, suggestions });
      } catch (err) {
        return failure("find_companies")(err);
      }
    },
  );

  // ── find_filter_values ───────────────────────────────────────────────────
  server.registerTool(
    "find_filter_values",
    {
      title: "Find filter values",
      description:
        "List the accepted values of one open-vocabulary search filter, with live job counts, so the code you " +
        "write sends a value the index holds. Filters match exactly: an unknown value returns zero jobs, not an " +
        `error. Facets: ${FILTER_VALUE_FACETS.join(", ")}. ` +
        "`sources` are ATS ids (greenhouse, lever_co); `job_categories` and `job_subcategories` are the occupation " +
        "taxonomy's two upper levels; `occupations` returns occupation ids for the `occupation_ids` filter. " +
        "Without `q`: the values with the most live jobs. With `q`: the values that start with it; for " +
        "`occupations`, `q` is a role name ('registered nurse') matched against occupation, subcategory and " +
        `category names. ${KEYED}`,
      inputSchema: z.object({
        facet: z.enum(FILTER_VALUE_FACETS as [string, ...string[]]).describe("Which filter's values to list."),
        q: z
          .string()
          .optional()
          .describe(
            "For occupations, words of the role name ('nurse', 'backend developer'). For the other facets, the " +
              "start of a value ('pyth', 'soft'). Leave out for the most common values.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_FACET_VALUES)
          .optional()
          .describe(`Most values to return, 1–${MAX_FACET_VALUES} (default 25).`),
      }),
      annotations: { title: "Find filter values", ...READ_ONLY },
      _meta: meta("find_filter_values"),
    },
    async (args, ctx) => {
      try {
        const facet = args.facet as (typeof FILTER_VALUE_FACETS)[number];
        const q = args.q?.trim() || undefined;
        const limit = args.limit ?? 25;

        if (facet === "occupations" && q) {
          const [rows, counts] = await Promise.all([occupationRows(ctx), occupationCounts(ctx)]);
          const matches = matchOccupations(rows, q, counts ?? new Map());
          const shown = matches.slice(0, limit);
          return reply(renderOccupationMatches(q, shown, matches.length, counts !== null), {
            facet,
            query: q,
            total_matches: matches.length,
            counts_available: counts !== null,
            options: shown,
          });
        }

        const res = await lookup<FilterOptionsResponse>("find_filter_values", "filterOptions", ctx, {
          facet,
          query: { q, limit },
        });
        const options = res.options ?? [];
        return reply(renderFilterValues(facet, q, options), { facet, ...(q ? { query: q } : {}), options });
      } catch (err) {
        return failure("find_filter_values")(err);
      }
    },
  );

  // ── find_locations ───────────────────────────────────────────────────────
  server.registerTool(
    "find_locations",
    {
      title: "Check a place name",
      description:
        "Check how a place name resolves before you put it in a request. Returns the places whose name starts " +
        "with `q` (2+ characters), with city, region and country exactly as the job index stores them, the string " +
        "the search `location` filter takes for each, and the `{ country, region, city }` object the feed " +
        "(`POST /api/jobs/feed`) takes in `locations`. This is the free place lookup, not the billed geocoder " +
        `(\`GET /api/locations/geocode\`), which this server never calls. ${KEYED}`,
      inputSchema: z.object({
        q: z.string().trim().min(2).describe("Start of a place name, e.g. 'berlin', 'san fran', 'texas'."),
        limit: z.number().int().min(1).max(10).optional().describe("Most places to return, 1–10 (default 5)."),
      }),
      annotations: { title: "Check a place name", ...READ_ONLY },
      _meta: meta("find_locations"),
    },
    async ({ q, limit }, ctx) => {
      try {
        const res = await lookup<SuggestLocationsResponse>("find_locations", "locationsSuggest", ctx, {
          query: { q, limit: limit ?? 5 },
        });
        const places = (res.suggestions ?? []).map(resolvePlace);
        return reply(renderLocations(q, places), { query: q, suggestions: places });
      } catch (err) {
        return failure("find_locations")(err);
      }
    },
  );

  // ── list_filters ─────────────────────────────────────────────────────────
  server.registerTool(
    "list_filters",
    {
      title: "List fixed filter values",
      description:
        "The fixed vocabularies of the Jobo jobs API: work models, employment types, experience levels, company " +
        "categories, languages (ISO 639-1), sort orders, description formats and `include_fields`, plus the " +
        "feed's company size and revenue bands. Use them for enums, constants and validation in the code you " +
        "write. Values are lowercase and canonical: send them verbatim. Jobs come back with display-cased values " +
        `(\`Remote\`, \`Full-time\`), which are not valid filter input. ${KEYLESS} For open vocabularies (companies, ` +
        "skills, industries, occupations, sources, places) use the `find_` tools.",
      inputSchema: z.object({}),
      annotations: { title: "List fixed filter values", ...READ_ONLY },
      _meta: meta("list_filters"),
    },
    async () => {
      const vocabularies = fixedVocabularies();
      return reply(renderFixedVocabularies(vocabularies), vocabularies);
    },
  );

  // ── describe_search_filters ──────────────────────────────────────────────
  server.registerTool(
    "describe_search_filters",
    {
      title: "Describe the search filters",
      description:
        "The whole job-search filter contract, one entry per filter: its name, type, the values it accepts or " +
        "the lookup tool that supplies them, its `exclude_` twin, where it goes in the `POST /api/jobs/search` " +
        "JSON body with an example fragment, and the matching `jobo` CLI flag. Read it before writing " +
        "request-building code or types: several filters are spelled differently in the body (`work_model` is " +
        "`work_models`, `q` is `queries`), and include/exclude filters are nested objects, where a flat " +
        `\`skills_exclude\` key is ignored without an error. ${KEYLESS}`,
      inputSchema: z.object({}),
      annotations: { title: "Describe the search filters", ...READ_ONLY },
      _meta: meta("describe_search_filters"),
    },
    async () => {
      const contract = describeSearchFilters();
      return reply(renderFilterContract(contract), contract);
    },
  );

  // ── build_search_request ─────────────────────────────────────────────────
  server.registerTool(
    "build_search_request",
    {
      title: "Build a search request",
      description:
        "Check a set of search filters against the contract and return the exact request for them: method, URL, " +
        "headers and JSON body for `POST /api/jobs/search`, a ready-to-run `curl` command (bash, zsh), the same " +
        "request for PowerShell, and the equivalent `jobo` CLI command. The commands read the key from the " +
        "`JOBO_API_KEY` environment variable; the headers show where it goes, not a value to paste. It does not " +
        "send the request: no network call, no key, no cost. Sending the request " +
        "it returns is billed per job returned, and `page_size` is the most one call can bill. Parameters are the " +
        "contract's filter names, not the body's field names: pass `work_model`, not `work_models`. An unknown " +
        "name, a wrong type or a value outside a fixed vocabulary is reported with the nearest valid one, and no " +
        "request is built. Values of open vocabularies cannot be checked offline; the result names the lookup " +
        "tool to confirm each with.",
      inputSchema: BUILD_SEARCH_REQUEST_INPUT,
      annotations: { title: "Build a search request", ...READ_ONLY },
      _meta: meta("build_search_request"),
    },
    async (args) => {
      const result = buildSearchRequest(args as Record<string, unknown>);
      return { ...reply(renderBuildResult(result), result), ...(result.valid ? {} : { isError: true }) };
    },
  );

  // ── describe_signal_filters ──────────────────────────────────────────────
  server.registerTool(
    "describe_signal_filters",
    {
      title: "Describe the Hiring Signals filters",
      description:
        "The Hiring Signals contract for `GET /api/signals` and `GET /api/companies/{id}/signals`: every filter with " +
        "its type, accepted values or range and what it matches, which filters the per-company endpoint takes, the " +
        "focus-filter rule (which types a request with `functions`, `roles` or `job_regions` can return), paging, what " +
        "a read costs, and how to poll for new signals without paying twice. A signal is one event at one company, " +
        "detected from its job postings. Read it before writing code that reads signals: each signal returned is " +
        `billed at ten times the price of a job, and a signal read again is billed again. ${KEYLESS}`,
      inputSchema: z.object({}),
      annotations: { title: "Describe the Hiring Signals filters", ...READ_ONLY },
      _meta: meta("describe_signal_filters"),
    },
    async () => {
      const contract = describeSignalFilters();
      return reply(renderSignalFilterContract(contract), contract);
    },
  );

  // ── build_signals_request ────────────────────────────────────────────────
  server.registerTool(
    "build_signals_request",
    {
      title: "Build a Hiring Signals request",
      description:
        "Check a set of Hiring Signals filters against the contract and return the exact request: method, URL with " +
        "its query string, headers, a `curl` command (bash, zsh), the same request for PowerShell, and the `jobo " +
        "signals` command. Pass `company_id` for one company's endpoint. The commands read the key from the " +
        "`JOBO_API_KEY` environment variable. It does not send the request: no network call, no key, no cost. " +
        "Sending it is billed per signal returned, at ten times the price of a job, and `limit` is the most one " +
        "call can bill. An unknown filter, a value outside a fixed vocabulary, a list value with a comma, more than " +
        "100 values, a number out of range, a date in the wrong shape or a filter the per-company endpoint does not " +
        "take is reported, and no request is built.",
      inputSchema: BUILD_SIGNALS_REQUEST_INPUT,
      annotations: { title: "Build a Hiring Signals request", ...READ_ONLY },
      _meta: meta("build_signals_request"),
    },
    async (args) => {
      const result = buildSignalsRequest(args as Record<string, unknown>);
      return { ...reply(renderSignalsBuildResult(result), result), ...(result.valid ? {} : { isError: true }) };
    },
  );

  return server;
}
