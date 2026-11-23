/**
 * `build_search_request`: check a set of filters against the contract and
 * write out the request for them. Nothing here touches the network.
 *
 * Two kinds of finding. An **error** is a break of something the contract
 * defines: an unknown filter, a wrong type, a value outside a closed
 * vocabulary, a malformed date or number, paging out of bounds. One error and
 * no request is built. A **warning** is anything this server can only guess at
 * (a value of an open vocabulary it cannot look up offline, a company given by
 * name): the request is built and the warning says how to check.
 *
 * The body comes from the contract's own `toJobSearchBody`, the function every
 * other Jobo connector builds its search body with, so what this prints is
 * what `jobo-cli` or the n8n node would send for the same filters.
 */

import {
  INCLUDE_FIELDS,
  JOB_SEARCH_FILTERS,
  NARROWING_FILTER_KEYS,
  toJobSearchBody,
  type FilterDescriptor,
  type JobSearchFilters,
  type JobSearchPaging,
  type JobSearchRequest,
} from "@jobo-ai/connector-core";

import { API_KEY_ENV } from "./auth.js";
import {
  BILLING_DOCS_URL,
  CREDITS_PER_DOLLAR,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_SEARCH_DEPTH,
  PUBLIC_API_URL,
  REQUEST_OPTIONS,
  SEARCH_CREDITS_PER_JOB,
  SEARCH_FACETS,
  SEARCH_PATH,
  describeFilter,
  flagName,
  hasClosedVocabulary,
  lookupFor,
} from "./contract.js";

export interface Finding {
  /** The parameter the finding is about. */
  field: string;
  message: string;
}

export interface SearchRequest {
  method: "POST";
  url: string;
  path: string;
  headers: Record<string, string>;
  body: JobSearchRequest;
}

export interface BuildResult {
  valid: boolean;
  errors: Finding[];
  warnings: Finding[];
  /** Always false: this tool writes the request and never sends it. */
  sent: false;
  request?: SearchRequest;
  /** POSIX shell. Reads the key from `$JOBO_API_KEY`. */
  curl?: string;
  /** The same search as a `jobo` CLI command; null when the CLI cannot express it. */
  cli?: string | null;
  /** Why `cli` is null. */
  cli_note?: string;
  billing?: { max_jobs_billed: number; max_credits: number; max_usd: number; note: string };
}

const FILTERS_BY_KEY: ReadonlyMap<string, FilterDescriptor> = new Map(JOB_SEARCH_FILTERS.map((filter) => [filter.key, filter]));
const OPTION_KEYS: readonly string[] = REQUEST_OPTIONS.map((option) => option.name);

/** Every parameter `build_search_request` takes: the contract's filters, then the request options. */
export const REQUEST_PARAMETERS: readonly string[] = [...FILTERS_BY_KEY.keys(), ...OPTION_KEYS];

// ─────────────────────────────────────────────────────────────────────────────
//  Nearest-match suggestions
// ─────────────────────────────────────────────────────────────────────────────

/** Lower-case, without the separators people swap or drop: `Full Time`, `full_time` and `full-time` are one key. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Edit distance where swapping two neighbouring characters counts as one edit. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number) => d[i]?.[j] ?? 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, at(i - 2, j - 2) + 1);
      (d[i] as number[])[j] = best;
    }
  }
  return at(a.length, b.length);
}

/** The candidate `input` is another spelling of (case, separators), when exactly one fits. */
export function canonical(input: string, candidates: readonly string[]): string | undefined {
  const lower = input.trim().toLowerCase();
  const exact = candidates.find((candidate) => candidate.toLowerCase() === lower);
  if (exact !== undefined) return exact;
  const key = squash(input);
  const loose = key === "" ? [] : candidates.filter((candidate) => squash(candidate) === key);
  return loose.length === 1 ? loose[0] : undefined;
}

/** The candidate closest to `input`, when it is close enough to be what was meant. */
export function nearest(input: string, candidates: readonly string[]): string | undefined {
  const wanted = squash(input);
  if (wanted === "") return undefined;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(wanted, squash(candidate));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best !== undefined && bestDistance <= Math.min(3, Math.max(1, Math.floor(wanted.length / 3))) ? best : undefined;
}

/**
 * Body field → the filters that fill it, for the commonest slip: passing the
 * POST body's spelling (`work_models`, `queries`, `salary_usd`) where this tool
 * takes the contract's (`work_model`, `q`, `min_salary_usd`).
 */
const FILTERS_BY_BODY_FIELD: ReadonlyMap<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const filter of JOB_SEARCH_FILTERS) {
    const top = describeFilter(filter).body_field?.split(".")[0];
    if (top === undefined || FILTERS_BY_KEY.has(top)) continue;
    map.set(top, [...(map.get(top) ?? []), filter.key]);
  }
  return map;
})();

const code = (names: readonly string[]): string => names.map((name) => `\`${name}\``).join(" or ");

function unknownParameter(key: string): string {
  const fromBody = FILTERS_BY_BODY_FIELD.get(key);
  if (fromBody) {
    return `\`${key}\` is the field's name in the POST body. This tool takes the contract's name, ${code(fromBody)}, and writes the body field for you.`;
  }
  // `skills_exclude` / `skills_include`: the flat spelling the API ignores.
  const flat = /^(.+)_(include|exclude)$/.exec(key);
  if (flat) {
    const wanted = flat[2] === "exclude" ? `exclude_${flat[1]}` : (flat[1] as string);
    if (FILTERS_BY_KEY.has(wanted)) return `Unknown filter. Did you mean \`${wanted}\`?`;
  }
  if (key === "query" || key === "search") return "Unknown filter. Did you mean `q`?";
  const guess = nearest(key, REQUEST_PARAMETERS);
  return guess
    ? `Unknown filter. Did you mean \`${guess}\`?`
    : "Unknown filter. `describe_search_filters` lists every filter this request takes.";
}

// ─────────────────────────────────────────────────────────────────────────────
//  Value checks
// ─────────────────────────────────────────────────────────────────────────────

const COMPANY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const OCCUPATION_ID = /^(esco|jobo):\S+$/i;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * An ISO 8601 date or date-time as epoch milliseconds, or the reason it is not
 * one. Done by hand, not with `Date.parse`, for two reasons. `Date.parse`
 * rolls an impossible date over ("2026-02-31" becomes 3 March) instead of
 * refusing it. And it reads a date-time with no zone as local time, so the
 * same request would compare differently on two machines; here a value with
 * no zone is UTC.
 */
export function parseTimestamp(text: string): { ms: number } | { problem: "format" | "calendar" } {
  const match = ISO_TIMESTAMP.exec(text.trim());
  if (!match) return { problem: "format" };
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((group) => Number(match[group] ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const millis = match[7] ? Math.round(Number(`0${match[7]}`) * 1000) : 0;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const date = new Date(utc);
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59;
  if (!real) return { problem: "calendar" };

  const zone = match[8];
  if (!zone || zone === "Z") return { ms: utc };
  const zoneHours = Number(zone.slice(1, 3));
  const zoneMinutes = Number(zone.slice(-2));
  if (zoneHours > 23 || zoneMinutes > 59) return { problem: "calendar" };
  return { ms: utc - (zone.startsWith("-") ? -1 : 1) * (zoneHours * 60 + zoneMinutes) * 60_000 };
}

const quoted = (values: readonly string[]): string => values.map((value) => `"${value}"`).join(", ");

/** For a number sent as a string: the commonest wrong type, and worth a direct answer. */
function asNumberHint(value: unknown): string {
  return typeof value === "string" && /^\d+$/.test(value.trim()) ? ` Send it as a JSON number: ${value.trim()}, not "${value.trim()}".` : "";
}

/** A string or an array of strings, as a clean list. Null when it is neither. */
function stringList(value: unknown): string[] | null {
  const raw = typeof value === "string" ? [value] : value;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) return null;
  const out: string[] = [];
  for (const entry of raw as string[]) {
    const text = entry.trim();
    if (text !== "" && !out.includes(text)) out.push(text);
  }
  return out;
}

function lookupHint(filter: FilterDescriptor): string {
  const lookup = lookupFor(filter);
  if (!lookup) return "";
  if (lookup.tool === "find_filter_values") return `\`find_filter_values\` (facet ${lookup.arguments?.facet})`;
  return `\`${lookup.tool}\``;
}

interface Checked {
  filters: Record<string, unknown>;
  locations: string[];
  errors: Finding[];
  warnings: Finding[];
}

function checkList(filter: FilterDescriptor, value: unknown, out: Checked): void {
  const field = filter.key;
  const values = stringList(value);
  if (values === null) {
    out.errors.push({ field, message: "Takes an array of strings." });
    return;
  }
  if (values.length === 0) return;

  if (typeof value === "string" && value.includes(",") && filter.dynamicOptions !== "companies") {
    out.warnings.push({
      field,
      message: `"${value}" was taken as one value. Pass an array for several values: this tool does not split on commas.`,
    });
  }

  const options = filter.options;
  if (options && hasClosedVocabulary(filter)) {
    const accepted: string[] = [];
    for (const entry of values) {
      const match = canonical(entry, options);
      if (match === undefined) {
        const guess = nearest(entry, options);
        out.errors.push({
          field,
          message: `Unknown value "${entry}".${guess ? ` Did you mean "${guess}"?` : ""} Valid values: ${options.join(", ")}.`,
        });
      } else if (!accepted.includes(match)) {
        accepted.push(match);
      }
    }
    out.filters[field] = accepted;
    return;
  }

  if (filter.key === "language") {
    const codes = values.map((entry) => (/^[a-z]{2}$/i.test(entry) ? entry.toLowerCase() : entry));
    const odd = codes.filter((entry) => !/^[a-z]{2}$/.test(entry));
    if (odd.length > 0) {
      out.warnings.push({
        field,
        message: `${quoted(odd)} ${odd.length > 1 ? "are" : "is"} not an ISO 639-1 code (en, de). The API maps language names and locales server-side, but send the code.`,
      });
    }
    out.filters[field] = codes;
    return;
  }

  if (options) {
    // A picker list that is also served live: known values, not enforced.
    const known = values.map((entry) => canonical(entry, options) ?? entry);
    const odd = known.filter((entry) => !options.includes(entry));
    if (odd.length > 0) {
      out.warnings.push({
        field,
        message: `${quoted(odd)} ${odd.length > 1 ? "are" : "is"} not among the known values (${options.join(", ")}). Values are matched exactly, so an unknown one matches nothing.`,
      });
    }
    out.filters[field] = known;
    return;
  }

  if (filter.dynamicOptions === "companies") {
    const names = values.filter((entry) => !COMPANY_ID.test(entry) && !DOMAIN.test(entry));
    if (names.length > 0) {
      out.warnings.push({
        field,
        message: `${quoted(names)} ${names.length > 1 ? "are company names" : "is a company name"}. A name must be the whole name and also matches every other company called that. Use \`find_companies\` and pass the ids.`,
      });
    }
  } else if (filter.dynamicOptions === "occupations") {
    const names = values.filter((entry) => !OCCUPATION_ID.test(entry));
    if (names.length > 0) {
      out.warnings.push({
        field,
        message: `${quoted(names)} ${names.length > 1 ? "do" : "does"} not look like an occupation id (esco:… or jobo:…). This filter takes ids, not names: find the id with \`find_filter_values\` (facet occupations, q the role name).`,
      });
    }
  } else if (filter.dynamicOptions) {
    out.warnings.push({
      field,
      message: `Not checked: values are matched exactly, and one the index does not hold matches nothing. Confirm ${quoted(values)} with ${lookupHint(filter)}.`,
    });
  }
  out.filters[field] = values;
}

function checkFilter(filter: FilterDescriptor, value: unknown, out: Checked): void {
  const field = filter.key;
  switch (filter.kind) {
    case "stringList":
    case "enumList":
      checkList(filter, value, out);
      return;

    case "string": {
      if (field === "location") {
        const places = stringList(value);
        if (places === null) {
          out.errors.push({ field, message: "Takes a string, or an array of strings for several places." });
        } else if (places.length > 0) {
          out.locations.push(...places);
          out.filters[field] = places[0];
        }
        return;
      }
      if (typeof value !== "string") {
        const several = Array.isArray(value) ? " One query per request here; the body's `queries` array takes several, OR'd." : "";
        out.errors.push({ field, message: `Takes a string.${several}` });
        return;
      }
      if (value.trim() !== "") out.filters[field] = value.trim();
      return;
    }

    case "enum": {
      const options = filter.options ?? [];
      const match = typeof value === "string" ? canonical(value, options) : undefined;
      if (match === undefined) {
        const guess = typeof value === "string" ? nearest(value, options) : undefined;
        out.errors.push({
          field,
          message: `Takes one of: ${options.join(", ")}.${guess ? ` Did you mean "${guess}"?` : ""}`,
        });
        return;
      }
      out.filters[field] = match;
      return;
    }

    case "number": {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        out.errors.push({ field, message: `Takes a whole number above zero.${asNumberHint(value)}` });
        return;
      }
      out.filters[field] = value;
      return;
    }

    case "boolean": {
      if (typeof value !== "boolean") {
        out.errors.push({ field, message: "Takes true or false." });
        return;
      }
      out.filters[field] = value;
      return;
    }

    case "dateTime": {
      const parsed = typeof value === "string" ? parseTimestamp(value) : { problem: "format" as const };
      if ("problem" in parsed) {
        const relative = typeof value === "string" && /^\d+[hdw]$/i.test(value.trim());
        out.errors.push({
          field,
          message:
            parsed.problem === "calendar"
              ? `"${String(value).trim()}" is not a real date or time: check the day of the month, the hour and the zone offset.`
              : "Takes an ISO 8601 date or date-time (2026-11-01 or 2026-11-01T00:00:00Z)." +
                (relative ? " Ages such as 7d are a `jobo` CLI shorthand; the API takes a timestamp, so compute it in code." : ""),
        });
        return;
      }
      out.filters[field] = (value as string).trim();
      return;
    }

    default: {
      // A kind added to the contract has to be handled here before it can ship.
      const unhandled: never = filter.kind;
      throw new Error(`Unhandled filter kind: ${String(unhandled)}`);
    }
  }
}

function checkRanges(out: Checked): void {
  const { filters } = out;
  const min = filters.min_salary_usd;
  const max = filters.max_salary_usd;
  if (typeof min === "number" && typeof max === "number" && min > max) {
    out.errors.push({ field: "min_salary_usd", message: `Is above max_salary_usd (${min} > ${max}).` });
  }
  // Both ends were checked above; a value with no zone counts as UTC on both.
  const instant = (value: unknown): number | undefined => {
    const parsed = typeof value === "string" ? parseTimestamp(value) : undefined;
    return parsed && "ms" in parsed ? parsed.ms : undefined;
  };
  for (const stem of ["posted", "discovered"]) {
    const after = instant(filters[`${stem}_after`]);
    const before = instant(filters[`${stem}_before`]);
    if (after !== undefined && before !== undefined && after > before) {
      out.errors.push({ field: `${stem}_after`, message: `Is later than ${stem}_before, so no job can match.` });
    }
  }
}

function checkNameList(
  field: string,
  value: unknown,
  known: readonly string[],
  strict: boolean,
  out: Checked,
): string[] | undefined {
  const values = Array.isArray(value) ? stringList(value) : null;
  if (values === null) {
    out.errors.push({ field, message: "Takes an array of strings. An empty array is meaningful: it asks for none." });
    return undefined;
  }
  const names = values.map((entry) => canonical(entry, known) ?? entry);
  const odd = names.filter((entry) => !known.includes(entry));
  if (odd.length > 0) {
    const message = `Unknown ${odd.length > 1 ? "values" : "value"} ${quoted(odd)}. Known values: ${known.join(", ")}.`;
    (strict ? out.errors : out.warnings).push({ field, message });
  }
  return names;
}

function checkOptions(input: Record<string, unknown>, out: Checked): JobSearchPaging {
  const paging: { -readonly [K in keyof JobSearchPaging]: JobSearchPaging[K] } = {};

  // null is how some clients spell "not set", here as for the filters.
  const given = (name: string): unknown => input[name] ?? undefined;

  const page = given("page");
  if (page !== undefined) {
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
      out.errors.push({ field: "page", message: `Takes a whole number, 1 or more.${asNumberHint(page)}` });
    } else {
      paging.page = page;
    }
  }

  const pageSize = given("page_size");
  if (pageSize !== undefined) {
    if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      out.errors.push({ field: "page_size", message: `Takes a whole number from 1 to ${MAX_PAGE_SIZE}.${asNumberHint(pageSize)}` });
    } else {
      paging.page_size = pageSize;
    }
  }

  // A server setting, not part of the contract, and the API clamps instead of refusing: a warning.
  const depth = (paging.page ?? 1) * (paging.page_size ?? DEFAULT_PAGE_SIZE);
  if (depth > MAX_SEARCH_DEPTH) {
    out.warnings.push({
      field: "page",
      message: `Search stops at a depth of ${MAX_SEARCH_DEPTH.toLocaleString("en-US")} results (page × page_size); a deeper page comes back as the last one. Use the feed (POST /api/jobs/feed) for anything deeper.`,
    });
  }

  if (given("include_fields") !== undefined) {
    const fields = checkNameList("include_fields", given("include_fields"), INCLUDE_FIELDS, true, out);
    if (fields) paging.include_fields = fields;
  }
  if (given("include_facets") !== undefined) {
    // Facet names are not in the shared contract, so an unknown one is a warning.
    const facets = checkNameList("include_facets", given("include_facets"), SEARCH_FACETS, false, out);
    if (facets) paging.include_facets = facets;
  }
  return paging;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Rendering the request
// ─────────────────────────────────────────────────────────────────────────────

/** One POSIX shell word. Single quotes, so `$`, backticks and `!` stay literal. */
export function shellQuote(value: string): string {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function toCurl(url: string, body: unknown): string {
  return [
    `curl -sS -X POST ${shellQuote(url)}`,
    `  -H "X-Api-Key: $${API_KEY_ENV}"`,
    "  -H 'Content-Type: application/json'",
    `  -d ${shellQuote(JSON.stringify(body))}`,
  ].join(" \\\n");
}

/**
 * `jobo search` flags whose values may hold a comma (a company called "Acme,
 * Inc.", the subcategory "Film, TV & Stage Production"), so the CLI does not
 * split them: the flag is repeated per value. `jobo-cli` keeps the same list
 * (`NO_COMMA_SPLIT` in its `filters.ts`).
 */
const CLI_REPEATED_FLAGS: ReadonlySet<string> = new Set([
  "companies",
  "exclude_companies",
  "industries",
  "exclude_industries",
  "job_categories",
  "exclude_job_categories",
  "job_subcategories",
  "exclude_job_subcategories",
]);

/** `--flag value`, or `--flag=value` when the value would be read as another flag. */
function flagArg(flag: string, value: string): string {
  return value.length > 1 && value.startsWith("-") ? `--${flag}=${shellQuote(value)}` : `--${flag} ${shellQuote(value)}`;
}

export function toCliCommand(
  filters: Record<string, unknown>,
  locations: readonly string[],
  paging: JobSearchPaging,
): { command: string } | { command: null; note: string } {
  if (locations.length > 1) {
    return { command: null, note: "`jobo search` takes one --location. Run it once per place, or send the REST request." };
  }

  const words: string[] = ["jobo", "search"];
  for (const filter of JOB_SEARCH_FILTERS) {
    const value = filters[filter.key];
    if (value === undefined) continue;
    const flag = flagName(filter.key);

    if (filter.key === "q") {
      const query = value as string;
      // A query that starts with "-" would be read as a flag in the positional slot.
      words.push(query.startsWith("-") ? flagArg("q", query) : shellQuote(query));
      continue;
    }
    if (Array.isArray(value)) {
      const values = value as string[];
      if (CLI_REPEATED_FLAGS.has(filter.key)) {
        for (const entry of values) words.push(flagArg(flag, entry));
        continue;
      }
      const withComma = values.find((entry) => entry.includes(","));
      if (withComma !== undefined) {
        return {
          command: null,
          note: `\`jobo search\` splits --${flag} on commas, so the value "${withComma}" cannot be passed. Send the REST request.`,
        };
      }
      words.push(flagArg(flag, values.join(",")));
      continue;
    }
    words.push(flagArg(flag, String(value)));
  }

  if (paging.page !== undefined) words.push(`--page ${paging.page}`);
  // Always explicit: the CLI's own default is 10, the API's is 25.
  words.push(`--page-size ${paging.page_size ?? DEFAULT_PAGE_SIZE}`);
  if (paging.include_fields !== undefined) {
    words.push(flagArg("include-fields", paging.include_fields.length > 0 ? paging.include_fields.join(",") : "none"));
  }
  if (paging.include_facets !== undefined) {
    words.push(flagArg("facets", paging.include_facets.length > 0 ? paging.include_facets.join(",") : "none"));
  }
  words.push("--json");
  return { command: words.join(" ") };
}

// ─────────────────────────────────────────────────────────────────────────────
//  build_search_request
// ─────────────────────────────────────────────────────────────────────────────

export function buildSearchRequest(input: Record<string, unknown>): BuildResult {
  const out: Checked = { filters: {}, locations: [], errors: [], warnings: [] };

  for (const [key, value] of Object.entries(input)) {
    // null is how some clients spell "not set".
    if (value === undefined || value === null) continue;
    const filter = FILTERS_BY_KEY.get(key);
    if (filter) checkFilter(filter, value, out);
    else if (!OPTION_KEYS.includes(key)) out.errors.push({ field: key, message: unknownParameter(key) });
  }
  checkRanges(out);
  const paging = checkOptions(input, out);

  if (out.errors.length > 0) {
    return { valid: false, errors: out.errors, warnings: out.warnings, sent: false };
  }

  const body = toJobSearchBody(out.filters as JobSearchFilters, paging);
  // The contract's mapper carries one place; the body takes several.
  if (out.locations.length > 1) body.locations = [...out.locations];

  if (!NARROWING_FILTER_KEYS.some((key) => out.filters[key] !== undefined)) {
    out.warnings.push({
      field: "(request)",
      message: `No narrowing filter (${NARROWING_FILTER_KEYS.join(", ")}): this matches the whole index. Fine for one page; never poll or page through it.`,
    });
  }
  if ((paging.page ?? 1) > 1 && (out.filters.sort ?? "relevance") === "relevance") {
    out.warnings.push({
      field: "sort",
      message:
        "Relevance order can shift between pages, so a job may repeat (and is billed again). For a stable walk use " +
        "sort discovered_asc with discovered_after and discovered_before.",
    });
  }
  if (out.filters.min_salary_usd !== undefined || out.filters.max_salary_usd !== undefined) {
    out.warnings.push({
      field: "min_salary_usd",
      message: "Salary filters only match jobs whose employer published a range, a minority of listings.",
    });
  }

  const url = `${PUBLIC_API_URL}${SEARCH_PATH}`;
  const cli = toCliCommand(out.filters, out.locations, paging);
  const maxJobs = paging.page_size ?? DEFAULT_PAGE_SIZE;
  const maxCredits = maxJobs * SEARCH_CREDITS_PER_JOB;

  return {
    valid: true,
    errors: [],
    warnings: out.warnings,
    sent: false,
    request: {
      method: "POST",
      url,
      path: SEARCH_PATH,
      headers: { "X-Api-Key": `$${API_KEY_ENV}`, "Content-Type": "application/json" },
      body,
    },
    curl: toCurl(url, body),
    cli: cli.command,
    ...(cli.command === null ? { cli_note: cli.note } : {}),
    billing: {
      max_jobs_billed: maxJobs,
      max_credits: maxCredits,
      max_usd: maxCredits / CREDITS_PER_DOLLAR,
      note:
        `Sending this request is billed per job returned: up to ${maxJobs} jobs, ${SEARCH_CREDITS_PER_JOB} credits ` +
        `($${(SEARCH_CREDITS_PER_JOB / CREDITS_PER_DOLLAR).toFixed(3)}) each after the plan's included jobs. An empty ` +
        `page is free. A sandbox key (jbe_test_…) runs it against fictional jobs at no charge. See ${BILLING_DOCS_URL}.`,
    },
  };
}
