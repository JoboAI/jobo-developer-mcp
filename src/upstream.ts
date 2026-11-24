/**
 * Upstream client for the Jobo REST API's free lookup endpoints.
 *
 * These are the API-key endpoints `jobo-cli` uses in its free commands
 * (`companies`, `locations`, `filters`, `occupations`). Every one is rate
 * limited and none is billed.
 *
 * A tool cannot name a path: it names one of `FREE_ENDPOINTS`, and `callApi`
 * builds the URL from that. Reaching a billed endpoint (search, feed, geocode)
 * therefore takes a new entry in this file, where `upstream.test.ts` fails it.
 */

import { DEFAULT_BASE_URL } from "@jobo-ai/connector-core";

import { rejectedKeys } from "./rejected-keys.js";

/**
 * Where the lookups go: `JOBO_API_URL`, or the public API. Read on every call
 * rather than once at load, so the order modules happen to load in can never
 * decide which API a request reaches (a test that sets the variable after an
 * import would otherwise talk to the live API).
 */
export function apiBaseUrl(): string {
  return (process.env.JOBO_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Every upstream endpoint this server may call. All `GET`, all free. */
export const FREE_ENDPOINTS = {
  /** Companies by name or domain prefix, with every board id and a live job count. */
  companiesSuggest: "/api/connectors/companies/suggest",
  /** Values of one open-vocabulary filter, with live job counts. */
  filterOptions: "/api/connectors/filter-options/{facet}",
  /** Places by name prefix, with the labels the job index stores. Not the billed geocoder. */
  locationsSuggest: "/api/connectors/locations/suggest",
  /** The occupation taxonomy, in one response. */
  occupations: "/api/occupations",
} as const;

export type FreeEndpoint = keyof typeof FREE_ENDPOINTS;

/**
 * Paths that cost money: job search (billed per job returned), the feed (per
 * new job) and the geocoder (per lookup). Nothing in this server may call one.
 */
export const BILLED_PATHS: readonly RegExp[] = [
  /^\/api\/jobs\/?$/, // GET /api/jobs
  /^\/api\/jobs\/search(\/|$)/, // POST /api/jobs/search
  /^\/api\/jobs\/feed(\/|$)/, // POST /api/jobs/feed, saved and managed feeds
  /^\/api\/locations\/geocode(\/|$)/, // GET /api/locations/geocode
  /^\/api\/mcp\/jobs\/search(\/|$)/, // the job-search server's own search
];

/** Whether a path (with or without a query string) is a billed endpoint. */
export function isBilledPath(path: string): boolean {
  const pathname = (path.split("?")[0] ?? "").toLowerCase();
  return BILLED_PATHS.some((pattern) => pattern.test(pathname));
}

export type QueryParams = Record<string, string | number | undefined>;

/** The request path for an endpoint: its template with `{facet}` filled in, plus the non-empty query parameters. */
export function upstreamPath(endpoint: FreeEndpoint, options: { facet?: string; query?: QueryParams } = {}): string {
  let path: string = FREE_ENDPOINTS[endpoint];
  if (path.includes("{facet}")) {
    if (!options.facet) throw new Error(`upstreamPath: ${endpoint} needs a facet`);
    path = path.replace("{facet}", encodeURIComponent(options.facet));
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `${path}?${parts.join("&")}` : path;
}

/** Error carrying the upstream HTTP status so tool handlers can map it. */
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    /** The response body, as text. */
    message: string,
    /** Whole seconds the upstream asked us to wait (Retry-After), when it said. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/**
 * Parse a Retry-After header into whole seconds. Accepts both forms the spec
 * allows — delta-seconds and an HTTP-date — and returns undefined when the
 * header is absent or unparseable.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

/**
 * The API did not answer in time. Never retried: the caller has already waited
 * the whole budget once, and two more waits would triple it.
 */
export class UpstreamTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`No answer from the Jobo API within ${timeoutMs} ms.`);
    this.name = "UpstreamTimeoutError";
  }
}

/** The API answered with a success status and a body that is not JSON. Not retried either. */
export class UpstreamResponseError extends Error {
  constructor(readonly status: number) {
    super(`The Jobo API answered HTTP ${status} with a body that is not JSON.`);
    this.name = "UpstreamResponseError";
  }
}

/**
 * The connection failed before any answer came (refused, reset, DNS), on every
 * try. Its own class so that only this, and not any `TypeError` a bug in the
 * code around the call throws, reads as "the API is unavailable".
 */
export class UpstreamUnreachableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "UpstreamUnreachableError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The caller's address
//
//  The hosted server calls the API from inside the cluster, so without help
//  the API sees one address, this server's, for every developer behind it, and
//  its per-address throttle on refused keys counts them all as one.
//
//  The edge proxy in front of this server appends the address it saw to
//  `X-Forwarded-For`, so the last entry of the chain it sends is the caller.
//  That chain goes upstream unchanged. The API takes the last entry of the
//  chain as the client (ASP.NET's forwarded-headers middleware, one hop), so
//  appending this server's own peer here, the edge proxy's address, would
//  hand the API that instead. With no chain (no proxy in front, as when run
//  locally) the socket's address is the caller and is sent alone.
// ─────────────────────────────────────────────────────────────────────────────

/** The most entries of an incoming chain passed on; a longer one keeps its end, where the caller is. */
const MAX_FORWARDED_ENTRIES = 10;

/** `::ffff:10.0.0.5` is how Node reports an IPv4 peer on a dual-stack socket. */
function plainAddress(address: string): string {
  return address.startsWith("::ffff:") && address.includes(".") ? address.slice("::ffff:".length) : address;
}

/** The `X-Forwarded-For` to send upstream for one request, or undefined when there is nothing to send. */
export function forwardedFor(
  incoming: string | string[] | undefined,
  socketAddress: string | undefined,
): string | undefined {
  const chain = (Array.isArray(incoming) ? incoming.join(",") : (incoming ?? ""))
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 64 && /^[0-9a-fA-F.:[\]]+$/.test(entry));
  if (chain.length > 0) return chain.slice(-MAX_FORWARDED_ENTRIES).join(", ");
  return socketAddress ? plainAddress(socketAddress) : undefined;
}

// The lookups are typeahead endpoints with a five-second budget of their own
// upstream. 15s is generous against that and keeps a wedged request from
// hanging an agent's turn (Node's fetch has no default timeout). It is the
// most one call waits on a silent API: a timeout is not retried.
export const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Transient upstream statuses worth retrying — gateway/unavailable only, never 4xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export interface CallOptions {
  facet?: string;
  query?: QueryParams;
  /** Sent as `User-Agent`, so the API's logs can tell this server's version. */
  userAgent?: string;
  /** How long to wait for the whole response. Defaults to `REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Sent as `X-Forwarded-For`: the caller's address, from `forwardedFor`. Hosted mode only. */
  forwardedFor?: string;
}

/**
 * `GET` one free endpoint with the caller's API key.
 *
 * The key travels as `X-Api-Key`: that is the header the REST API reads, and
 * the one a developer's own integration will send.
 *
 * What is tried again, up to three times: a gateway status (502, 503, 504) and
 * a connection that failed before an answer came, both of which a rolling
 * deploy produces and both of which pass in a moment. What is not: any other
 * status, a timeout, and an answer that is not JSON.
 *
 * A key the API refused in the last minute is refused again here, with the
 * API's own answer and without a request (see `rejected-keys.ts`).
 */
export async function callApi<T>(endpoint: FreeEndpoint, apiKey: string, options: CallOptions = {}): Promise<T> {
  const path = upstreamPath(endpoint, options);
  // Belt and braces: FREE_ENDPOINTS holds no billed path, and a test proves it.
  if (isBilledPath(path)) throw new Error(`Refusing to call a billed endpoint: ${path}`);

  const refused = rejectedKeys.rejection(apiKey);
  if (refused !== undefined) throw new UpstreamError(401, refused);

  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // One signal per attempt, covering the body as well as the headers. Asked
    // directly below, because the error a timed-out fetch throws varies.
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(`${apiBaseUrl()}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Api-Key": apiKey,
          // Unrecognised names count as `other` in the API's metrics until the
          // server-side allowlist learns this one.
          "X-Jobo-Client": "dev-mcp",
          ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
          ...(options.forwardedFor ? { "X-Forwarded-For": options.forwardedFor } : {}),
        },
        signal,
      });
      const text = (await response.text()).trim();

      if (response.status === 401) rejectedKeys.remember(apiKey, text);
      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
          lastError = new UpstreamError(response.status, text);
          await sleep(RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        // 429 is deliberately not retried here — the tool error tells the agent
        // when to come back instead of this gateway sitting on the request.
        throw new UpstreamError(response.status, text, parseRetryAfter(response.headers.get("retry-after")));
      }

      if (response.status === 204 || text === "") return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new UpstreamResponseError(response.status);
      }
    } catch (err) {
      // The API's own answer, good or bad, is final.
      if (err instanceof UpstreamError || err instanceof UpstreamResponseError) throw err;
      if (signal.aborted) throw new UpstreamTimeoutError(timeoutMs);
      // What is left is a connection that failed before an answer came
      // (reset, refused, DNS), as a rolling deploy produces.
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw new UpstreamUnreachableError(err);
    }
  }

  throw lastError ?? new Error("callApi: exhausted retries");
}
