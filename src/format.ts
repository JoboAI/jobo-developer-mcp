/**
 * What the tools say: API responses and the contract, as text a coding agent
 * can act on.
 *
 * The lookup renderers started as the job-search server's
 * (`../../mcp/src/format.ts`) and were rewritten for a different reader. There
 * the reader is an assistant about to call `search_jobs`; here it is an agent
 * writing integration code, so every line names the filter the value goes into
 * and where that sits in the request body.
 *
 * Kept free of HTTP and SDK types so each one is directly testable.
 */

import type {
  CompanySuggestion,
  FilterOptionsFacet,
  JobFacet,
  LocationSuggestion,
  OccupationTaxonomyResponse,
} from "@jobo-ai/connector-core";

import {
  filtersFedBy,
  type FilterContract,
  type FilterDescription,
  type FilterLookup,
  type FixedVocabularies,
  type Vocabulary,
} from "./contract.js";
import type { BuildResult, Finding } from "./request.js";
import type { SignalFilterContract, SignalFilterDescription } from "./signals-contract.js";
import type { SignalsBuildResult } from "./signals-request.js";

const count = (value: number): string => value.toLocaleString("en-US");
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const ticked = (names: readonly string[]): string => names.map((name) => `\`${name}\``).join(" / ");

// ─────────────────────────────────────────────────────────────────────────────
//  find_companies
// ─────────────────────────────────────────────────────────────────────────────

export function renderCompanies(query: string, companies: readonly CompanySuggestion[]): string {
  if (companies.length === 0) {
    return (
      `No company name or website domain starts with "${query}". The lookup is a prefix match (2+ characters): ` +
      "try fewer characters, or the company's domain."
    );
  }

  const lines = companies.map((company, index) => {
    const facts = [company.domain, company.country].filter((fact): fact is string => Boolean(fact));
    const jobs = company.job_count == null ? "" : ` · ${count(company.job_count)} live ${plural(company.job_count, "job", "jobs")}`;
    const ids = company.ids?.length > 0 ? company.ids : [company.id];
    return `${index + 1}. ${company.name}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}${jobs}\n   ids: ${JSON.stringify(ids)}`;
  });

  return (
    `${companies.length} ${plural(companies.length, "company matches", "companies match")} "${query}", those with live jobs first. ` +
    "A company has one id per careers board: put every id of the one you mean in the `companies` filter " +
    '(POST body: { "companies": { "include": [ids] } }; `exclude` to leave it out). Store ids, not the name: a name ' +
    "also matches every other company called that.\n\n" +
    lines.join("\n")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  find_filter_values
// ─────────────────────────────────────────────────────────────────────────────

function facetHint(facet: FilterOptionsFacet): string {
  const filters = filtersFedBy(facet);
  if (facet === "occupations") return `Send the id (before the dash) in ${ticked(filters)}. Ids are stable; names can change.`;
  return `Send the value exactly as written in ${ticked(filters)}.`;
}

export function renderFilterValues(facet: FilterOptionsFacet, query: string | undefined, options: readonly JobFacet[]): string {
  if (options.length === 0) {
    return query
      ? `No ${facet} value starts with "${query}". Try a shorter prefix, or leave q out for the values with the most live jobs.`
      : `No ${facet} values are available right now.`;
  }

  const lines = options.map((option) => {
    const label = option.name && option.name !== option.key ? ` — ${option.name}` : "";
    const parent = option.parent ? ` (in ${option.parent})` : "";
    return `- ${option.key}${label}${parent}: ${count(option.count)} ${plural(option.count, "job", "jobs")}`;
  });

  const scope = query ? ` starting with "${query}"` : ", most live jobs first";
  return `${options.length} ${facet} ${plural(options.length, "value", "values")}${scope}. ${facetHint(facet)}\n\n${lines.join("\n")}`;
}

/** One occupation of the taxonomy, with where it sits. */
export interface OccupationRow {
  id: string;
  name: string;
  category: string;
  subcategory: string;
}

export function flattenOccupations(taxonomy: OccupationTaxonomyResponse): OccupationRow[] {
  const rows: OccupationRow[] = [];
  for (const category of taxonomy.categories ?? []) {
    for (const subcategory of category.subcategories ?? []) {
      for (const occupation of subcategory.occupations ?? []) {
        rows.push({ id: occupation.id, name: occupation.name, category: category.name, subcategory: subcategory.name });
      }
    }
  }
  return rows;
}

/** An occupation found by name, in the shape the facet endpoint uses, plus its category. */
export interface OccupationMatch {
  /** The `occupation_ids` value. */
  key: string;
  name: string;
  /** The subcategory, a `job_subcategories` value. */
  parent: string;
  /** The category, a `job_categories` value. */
  category: string;
  /** Live jobs; null outside the occupations the facet endpoint counted. */
  count: number | null;
}

/**
 * Occupations matching a role name. The API's facet search matches occupation
 * ids only, so a name is matched here against the taxonomy, as `jobo-cli`
 * does: every word of the query must appear in the occupation's name. An
 * occupation matched only through its subcategory or category name ("nursing")
 * comes after those. Within each group, most live jobs first.
 */
export function matchOccupations(
  rows: readonly OccupationRow[],
  query: string,
  counts: ReadonlyMap<string, number>,
): OccupationMatch[] {
  const needle = query.trim().toLowerCase();
  const words = needle.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const ranked: Array<{ rank: number; match: OccupationMatch }> = [];
  for (const row of rows) {
    const name = row.name.toLowerCase();
    const byName = row.id.toLowerCase().startsWith(needle) || words.every((word) => name.includes(word));
    const path = `${name} ${row.subcategory.toLowerCase()} ${row.category.toLowerCase()}`;
    if (!byName && !words.every((word) => path.includes(word))) continue;
    ranked.push({
      rank: byName ? 0 : 1,
      match: { key: row.id, name: row.name, parent: row.subcategory, category: row.category, count: counts.get(row.id) ?? null },
    });
  }
  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank || (b.match.count ?? -1) - (a.match.count ?? -1) || a.match.name.localeCompare(b.match.name),
    )
    .map((entry) => entry.match);
}

export function renderOccupationMatches(
  query: string,
  shown: readonly OccupationMatch[],
  total: number,
  /** False when the API could not give live job counts for this lookup. */
  countsAvailable = true,
): string {
  if (shown.length === 0) {
    return (
      `No occupation, subcategory or category name contains "${query}". Try a broader word ("nurse", "engineer"), ` +
      "or filter on a whole field with `job_categories` / `job_subcategories` (facets job_categories, job_subcategories)."
    );
  }
  const lines = shown.map((match) => {
    const jobs = match.count == null ? "" : `: ${count(match.count)} ${plural(match.count, "job", "jobs")}`;
    return `- ${match.key} — ${match.name} (${match.category} › ${match.parent})${jobs}`;
  });
  const more = total > shown.length ? ` Showing ${shown.length} of ${count(total)}: raise limit or add a word.` : "";
  const uncounted = !countsAvailable
    ? "\n\nLive job counts are unavailable right now, so none is shown and the order is by name. The ids are unaffected."
    : shown.some((match) => match.count == null)
      ? "\n\nNo job count is shown outside the 250 occupations with the most live jobs."
      : "";
  return (
    `${count(total)} ${plural(total, "occupation matches", "occupations match")} "${query}".${more} ${facetHint("occupations")} ` +
    "For a whole field, send the category or subcategory name in `job_categories` / `job_subcategories` instead.\n\n" +
    lines.join("\n") +
    uncounted
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  find_locations
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedPlace extends LocationSuggestion {
  /** The string the search `location` filter takes for this place. */
  search_location: string;
  /** The object `POST /api/jobs/feed` takes in `locations`; null when the place has no country to anchor it. */
  feed_location: { country: string; region?: string; city?: string } | null;
}

/** A suggested place with the two values an integration sends for it. */
export function resolvePlace(place: LocationSuggestion): ResolvedPlace {
  const search = place.display_name?.trim() || [place.city, place.region, place.country].filter(Boolean).join(", ");
  const feed = place.country
    ? {
        country: place.country,
        ...(place.region ? { region: place.region } : {}),
        ...(place.city ? { city: place.city } : {}),
      }
    : null;
  return { ...place, search_location: search, feed_location: feed };
}

export function renderLocations(query: string, places: readonly ResolvedPlace[]): string {
  if (places.length === 0) {
    return (
      `No place name starts with "${query}". The lookup is a prefix match on place names (2+ characters): try the ` +
      "start of the city, region or country name."
    );
  }
  const lines = places.map((place, index) => {
    const code = place.country_code ? ` (${place.country_code})` : "";
    const point = place.latitude != null && place.longitude != null ? ` · ${place.latitude}, ${place.longitude}` : "";
    return (
      `${index + 1}. ${place.search_location}${code}${point}\n` +
      `   location: ${JSON.stringify(place.search_location)}\n` +
      `   feed: ${place.feed_location ? JSON.stringify(place.feed_location) : "(no country, so not usable in the feed)"}`
    );
  });
  return (
    `${places.length} ${plural(places.length, "place matches", "places match")} "${query}", best first, with city, region and ` +
    "country as the job index stores them. `location` is the string the search filter takes (POST body: " +
    '{ "locations": ["…"] }). `feed` is the object `POST /api/jobs/feed` takes in its `locations` array.\n\n' +
    lines.join("\n")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  list_filters
// ─────────────────────────────────────────────────────────────────────────────

function lookupCall(lookup: FilterLookup): string {
  return lookup.arguments ? `\`${lookup.tool}\` (facet ${lookup.arguments.facet})` : `\`${lookup.tool}\``;
}

function vocabularyLine(vocabulary: Vocabulary): string {
  const values = vocabulary.names
    ? vocabulary.values.map((value) => `${value} (${vocabulary.names?.[value] ?? value})`).join(", ")
    : vocabulary.values.join(", ");
  const field = vocabulary.body_field && vocabulary.body_field !== vocabulary.filter ? ` (body: \`${vocabulary.body_field}\`)` : "";
  const note = vocabulary.note ? `\n  ${vocabulary.note}` : "";
  return `**${vocabulary.filter}**${field}: ${values}${note}`;
}

export function renderFixedVocabularies(vocabularies: FixedVocabularies): string {
  const open = new Map<string, string[]>();
  for (const entry of vocabularies.open) {
    const call = lookupCall(entry.lookup);
    open.set(call, [...(open.get(call) ?? []), entry.filter]);
  }
  return [
    "Fixed vocabularies of the Jobo job-search API, from the shared connector contract.",
    vocabularies.notes.map((note) => `- ${note}`).join("\n"),
    "## Search (POST /api/jobs/search)",
    vocabularies.search.map(vocabularyLine).join("\n\n"),
    "## Feed only (POST /api/jobs/feed)",
    vocabularies.feed_only.map(vocabularyLine).join("\n\n"),
    "## Looked up live instead",
    [...open].map(([call, filters]) => `- ${filters.join(", ")}: ${call}`).join("\n"),
  ].join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
//  describe_search_filters
// ─────────────────────────────────────────────────────────────────────────────

function filterBlock(filter: FilterDescription): string {
  const lines = [`### ${filter.name}`, `${filter.description}`, `- type: ${filter.value}`];
  if (filter.values) {
    lines.push(`- values${filter.values_exhaustive ? "" : " (others accepted)"}: ${filter.values.join(", ")}`);
  }
  if (filter.lookup && filter.lookup.tool !== "list_filters") lines.push(`- look values up with: ${lookupCall(filter.lookup)}`);
  if (filter.exclude_twin) lines.push(`- exclude twin: \`${filter.exclude_twin}\``);
  if (filter.excludes) lines.push(`- excludes: \`${filter.excludes}\` (same values)`);
  if (filter.body_field) lines.push(`- body: \`${filter.body_field}\`, e.g. ${JSON.stringify(filter.body_example)}`);
  lines.push(`- CLI: \`${filter.cli_flag}\``);
  return lines.join("\n");
}

export function renderFilterContract(contract: FilterContract): string {
  const options = contract.request_options.map((option) => {
    const values = option.values ? ` Values: ${option.values.join(", ")}.` : "";
    return `- \`${option.name}\` (${option.value}; CLI \`${option.cli_flag}\`): ${option.description}${values}`;
  });
  return [
    `# Job-search filters: ${contract.endpoint.method} ${contract.endpoint.url}`,
    `Auth: the API key in the \`${contract.endpoint.auth_header}\` header. Billed ${contract.endpoint.billed}. ` +
      "The names below are what `build_search_request` takes; `body` is where each goes in the JSON body.",
    contract.notes.map((note) => `- ${note}`).join("\n"),
    `## Filters (${contract.filters.length})`,
    contract.filters.map(filterBlock).join("\n\n"),
    "## Request options",
    options.join("\n"),
  ].join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
//  build_search_request
// ─────────────────────────────────────────────────────────────────────────────

const findings = (items: readonly Finding[]): string => items.map((item) => `- ${item.field}: ${item.message}`).join("\n");

export function renderBuildResult(result: BuildResult): string {
  if (!result.valid || !result.request) {
    const n = result.errors.length;
    return [
      `No request was built: ${n} ${plural(n, "problem", "problems")} to fix first.`,
      findings(result.errors),
      ...(result.warnings.length > 0 ? ["Also worth checking:", findings(result.warnings)] : []),
      "`describe_search_filters` lists every filter name, type and accepted value.",
    ].join("\n\n");
  }

  const { request } = result;
  return [
    "Request built and checked against the filter contract. Nothing was sent.",
    `${request.method} ${request.url}\nX-Api-Key: <your key>\nContent-Type: application/json\n\n` +
      "In code, read the key from the JOBO_API_KEY environment variable (process.env.JOBO_API_KEY in Node, " +
      "os.environ[\"JOBO_API_KEY\"] in Python); never write it into the source.",
    "```json\n" + JSON.stringify(request.body, null, 2) + "\n```",
    "curl (bash, zsh; reads the key from the JOBO_API_KEY environment variable):\n```bash\n" + (result.curl ?? "") + "\n```",
    ...(result.powershell
      ? ["PowerShell (reads the key from the same variable, as $env:JOBO_API_KEY):\n```powershell\n" + result.powershell + "\n```"]
      : []),
    result.cli
      ? "jobo CLI (`npm install -g jobo-cli`; reads the same variable):\n```bash\n" + result.cli + "\n```"
      : `jobo CLI: ${result.cli_note ?? "not available for this request."}`,
    ...(result.warnings.length > 0 ? ["Check before relying on it:", findings(result.warnings)] : []),
    result.billing?.note ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
//  describe_signal_filters
// ─────────────────────────────────────────────────────────────────────────────

function signalFilterBlock(filter: SignalFilterDescription): string {
  const lines = [`### ${filter.name}`, filter.description, `- type: ${filter.value}`];
  if (filter.values) lines.push(`- values: ${filter.values.join(", ")}`);
  if (filter.min !== undefined && filter.max !== undefined) lines.push(`- range: ${filter.min} to ${filter.max}`);
  const marks = [
    filter.narrowing ? "narrowing" : "",
    filter.focus ? "focus filter" : "",
    filter.per_company ? "also on the per-company endpoint" : "list endpoint only",
  ].filter(Boolean);
  lines.push(`- ${marks.join("; ")}`);
  lines.push(`- CLI: \`${filter.cli_flag}\``);
  return lines.join("\n");
}

export function renderSignalFilterContract(contract: SignalFilterContract): string {
  const { list, company } = contract.endpoints;
  return [
    `# Hiring Signals filters: ${list.method} ${list.url}`,
    `One company: ${company.method} ${company.url}, taking only ${(company.takes as readonly string[]).join(", ")}. ` +
      `Auth: the API key in the \`${contract.auth_header}\` header. The names below are the query parameters and what ` +
      "`build_signals_request` takes.",
    contract.notes.map((note) => `- ${note}`).join("\n"),
    "## What it costs",
    contract.billing,
    "## The focus filters",
    contract.focus_rule,
    "## Paging",
    contract.paging.rule,
    contract.paging.sort.values
      .map((value) => {
        const marks = [
          value === contract.paging.sort.default ? "default" : "",
          value === contract.paging.sort.poll ? "poll in this" : "",
        ].filter(Boolean);
        return `- sort=${value}${marks.length > 0 ? ` (${marks.join("; ")})` : ""}: ${contract.paging.sort.orders[value]}`;
      })
      .join("\n"),
    "## Reading only what is new",
    contract.polling,
    "## Types",
    contract.types.map((entry) => `- ${entry.type}: ${entry.label}`).join("\n"),
    `## Filters (${contract.filters.length})`,
    contract.filters.map(signalFilterBlock).join("\n\n"),
  ].join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
//  build_signals_request
// ─────────────────────────────────────────────────────────────────────────────

export function renderSignalsBuildResult(result: SignalsBuildResult): string {
  if (!result.valid || !result.request) {
    const n = result.errors.length;
    return [
      `No request was built: ${n} ${plural(n, "problem", "problems")} to fix first.`,
      findings(result.errors),
      ...(result.warnings.length > 0 ? ["Also worth checking:", findings(result.warnings)] : []),
      "`describe_signal_filters` lists every filter name, type and accepted value.",
    ].join("\n\n");
  }

  const { request } = result;
  return [
    "Request built and checked against the Hiring Signals contract. Nothing was sent.",
    `${request.method} ${request.url}\nX-Api-Key: <your key>\n\n` +
      "In code, read the key from the JOBO_API_KEY environment variable (process.env.JOBO_API_KEY in Node, " +
      "os.environ[\"JOBO_API_KEY\"] in Python); never write it into the source.",
    "Query parameters:\n```json\n" + JSON.stringify(request.query, null, 2) + "\n```",
    "curl (bash, zsh; reads the key from the JOBO_API_KEY environment variable):\n```bash\n" + (result.curl ?? "") + "\n```",
    ...(result.powershell
      ? ["PowerShell (reads the key from the same variable, as $env:JOBO_API_KEY):\n```powershell\n" + result.powershell + "\n```"]
      : []),
    ...(result.cli ? ["jobo CLI (`npm install -g jobo-cli`; reads the same variable):\n```bash\n" + result.cli + "\n```"] : []),
    ...(result.warnings.length > 0 ? ["Check before relying on it:", findings(result.warnings)] : []),
    result.billing?.note ?? "",
    ...(result.notes && result.notes.length > 0 ? ["Notes:", result.notes.map((note) => `- ${note}`).join("\n")] : []),
  ]
    .filter(Boolean)
    .join("\n\n");
}
