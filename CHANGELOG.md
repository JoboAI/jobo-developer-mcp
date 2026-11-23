# Changelog

## 0.1.0

First version. A developer-facing MCP server: reference lookups for writing code against the Jobo REST
API, for use inside a coding agent. Separate from the job-search server, which is unchanged.

### Added

- **`find_companies`:** company name or domain prefix → each company's ids, domain, HQ country and live job
  count.
- **`find_filter_values`:** values of one open-vocabulary filter (sources, skills, industries, company
  categories, job categories and subcategories, occupations) with live job counts. For occupations, a role
  name finds the occupation id: the taxonomy is cached for five minutes, and the matches still come back,
  without counts, when the API cannot give the counts.
- **`find_locations`:** how a place name resolves, with the string the search `location` filter takes and
  the object the feed's `locations` takes. The free place lookup, not the billed geocoder.
- **`list_filters`:** the fixed vocabularies, from the shared connector contract. No key.
- **`describe_search_filters`:** the whole job-search filter contract: name, type, accepted values or
  lookup tool, `exclude_` twin, body field with an example, CLI flag. No key.
- **`build_search_request`:** checks a set of filters against the contract and returns the request for
  `POST /api/jobs/search`, a `curl` command and a `jobo` CLI command. It does not send the request. No key.
  A wrong type, an unknown name or a date that is not on the calendar is answered with what to send instead.
- **Auth by API key:** the caller's Jobo API key as `Authorization: Bearer <key>` (or `X-Api-Key`),
  forwarded to the API as `X-Api-Key`. No OAuth. A lookup with no key returns a tool error that shows the
  header to add and where to create a key.
- **Discovery with no key:** the handshake and `tools/list`, a Server Card at `/mcp/server-card` and an AI
  Catalog at `/.well-known/ai-catalog.json`.
- **A guard against billed endpoints:** tools can only name one of four free endpoints, and tests fail if
  any tool reaches job search, the feed or the geocoder.
- Server instructions that say what the server is for, that job search lives on the job-search server and
  the REST API, and which calls are billed.
- `server.json`, the registry manifest for `world.jobo/developer`, and an `npx jobo-developer-mcp` entry
  point for running a copy yourself.
