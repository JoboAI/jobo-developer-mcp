/**
 * Anything a tool throws → tool error text.
 *
 * Pure and dependency-light so it can be unit-tested directly: the agent only
 * ever sees this string, so it has to say what went wrong and what to change,
 * never a raw JSON body.
 */

import { API_KEYS_URL, API_KEY_ENV, ApiKeyError, STDIO, apiKeyErrorMessage } from "./auth.js";
import { UpstreamError, UpstreamResponseError, UpstreamTimeoutError } from "./upstream.js";

// A type alias, not an interface: the MCP SDK's tool-result type carries an
// `[x: string]: unknown` index signature, and only aliases get the implicit
// index signature that makes them assignable to it.
export type ToolError = {
  content: { type: "text"; text: string }[];
  isError: true;
};

export interface ErrorContext {
  /** The tool that failed, named in the message. */
  tool: string;
  /** This server's public endpoint, for the setup snippet. */
  endpointUrl: string;
}

interface UpstreamBody {
  /** A machine-readable code, e.g. `not_available_in_sandbox`. */
  code: string | null;
  /** The sentence the API wrote for a person: `detail`, else `error`, else `title`. */
  detail: string | null;
  /** Per-field messages of a validation problem, flattened. */
  fieldErrors: string[];
}

/**
 * Read the API's error body. It answers with RFC 9457 problem documents
 * (`detail`, `title`, and `errors` on a validation problem) and, from the key
 * check, with a bare `{ "error": "…" }`. Anything else yields nothing, so the
 * caller falls back to its own sentence rather than surface a JSON fragment.
 */
export function readUpstreamBody(body: string): UpstreamBody {
  const empty: UpstreamBody = { code: null, detail: null, fieldErrors: [] };
  if (!body) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;
  const record = parsed as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };

  const fieldErrors: string[] = [];
  if (typeof record.errors === "object" && record.errors !== null) {
    for (const [field, messages] of Object.entries(record.errors as Record<string, unknown>)) {
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (typeof message === "string") fieldErrors.push(`${field}: ${message}`);
      }
    }
  }
  return { code: text("code"), detail: text("detail") ?? text("error") ?? text("title"), fieldErrors };
}

/** Text that ends like a sentence, so the next one can follow it. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Whether a failure means the API could not answer (a 5xx, a 429, a timeout, a
 * broken body, no connection) rather than that it refused the request. A
 * refusal (a rejected key, a 404, a bad argument) will come back the same on
 * the next call, and the caller has to hear about it; an API that could not
 * answer may leave an optional part of a result out instead.
 */
export function isUnavailable(err: unknown): boolean {
  if (err instanceof UpstreamError) return err.status >= 500 || err.status === 429;
  // `fetch` reports a connection that never got an answer as a TypeError.
  return err instanceof UpstreamTimeoutError || err instanceof UpstreamResponseError || err instanceof TypeError;
}

/** Where the key lives, in the words a developer would look for it: a header, or in local mode an environment variable. */
const KEY_PLACE = STDIO
  ? `the \`${API_KEY_ENV}\` environment variable this server was started with`
  : "this server's `Authorization: Bearer <key>` header";
const LIVE_KEY_FIX = STDIO
  ? `set a live key (jbe_live_…) as \`${API_KEY_ENV}\` for the lookups`
  : "put a live key (jbe_live_…) in this server's header for the lookups";

function upstreamMessage(err: UpstreamError): string {
  const body = readUpstreamBody(err.message);

  if (err.status === 401) {
    return (
      `The Jobo API rejected the API key${body.detail ? ` (${body.detail})` : ""}. Check the key in ` +
      `${KEY_PLACE}: it may be revoked, expired or cut short. Keys are managed at ${API_KEYS_URL}.`
    );
  }
  if (err.status === 403) {
    return body.detail ?? "The Jobo API refused this key for this lookup.";
  }
  if (err.status === 404) {
    if (body.code === "not_available_in_sandbox") {
      return (
        "This lookup is not available with a sandbox key (jbe_test_…). The sandbox serves job search and lookups " +
        `by id only; ${LIVE_KEY_FIX}. They are free.`
      );
    }
    return body.detail ?? "The Jobo API has no such lookup in this environment (occupations may not be published here).";
  }
  if (err.status === 429) {
    return err.retryAfterSeconds != null
      ? `Rate limited by the Jobo API. Retry in ${err.retryAfterSeconds}s.`
      : "Rate limited by the Jobo API. Wait a moment before retrying.";
  }
  if (err.status === 400) {
    const problems = body.fieldErrors.length > 0 ? body.fieldErrors.join(" ") : body.detail;
    return `The Jobo API rejected the request${problems ? `: ${problems}` : "."}`;
  }
  if (err.status >= 500) {
    return (
      `The Jobo API is temporarily unavailable (HTTP ${err.status})${body.detail ? `: ${sentence(body.detail)}` : "."} ` +
      "Retry shortly; nothing was billed."
    );
  }
  return body.detail ?? `The Jobo API answered HTTP ${err.status}.`;
}

export function toToolError(err: unknown, context: ErrorContext): ToolError {
  let text: string;
  if (err instanceof ApiKeyError) {
    text = apiKeyErrorMessage(err, context.tool, context.endpointUrl);
  } else if (err instanceof UpstreamError) {
    text = upstreamMessage(err);
  } else if (err instanceof UpstreamTimeoutError) {
    text = `The Jobo API did not answer within ${Math.round(err.timeoutMs / 1000)} seconds. Retry shortly; nothing was billed.`;
  } else if (err instanceof UpstreamResponseError) {
    text =
      `The Jobo API answered HTTP ${err.status} with a body that is not JSON, so the lookup could not be read. ` +
      "That is a fault on the API's side, not in the request. Retry shortly; nothing was billed.";
  } else {
    text = `Could not reach the Jobo API: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { content: [{ type: "text", text }], isError: true };
}
