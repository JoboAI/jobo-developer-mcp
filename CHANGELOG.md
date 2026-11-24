# Changelog

## 0.2.1

Fixes from a code review: refused keys, the caller's address, and the request `build_search_request` writes.

### Added

- **`build_search_request` returns a PowerShell command** next to the `curl` one, for Windows PowerShell 5.1
  and PowerShell 7. It reads the key from `$env:JOBO_API_KEY` and sends the body in ASCII.

### Changed

- **The request's `X-Api-Key` header is described, not written as `$JOBO_API_KEY`.** That is POSIX shell
  syntax, and pasted into JavaScript or PowerShell it was sent as those characters. The header now says the
  key is read from the `JOBO_API_KEY` environment variable, and the text result shows how in Node and Python.
- **No fixed price.** The billing note and the server instructions no longer say 3 credits a job: the rate
  depends on the account's pricing. They say a search is billed per job returned, included jobs first, at
  the account's pay-as-you-go rate as published on the billing page. `billing` in the result drops
  `max_credits` and `max_usd` and keeps `max_jobs_billed`.

### Fixed

- **One client with a bad key no longer gets everyone's lookups blocked.** The API blocks an address for
  five minutes after 60 refused keys in five minutes, and every hosted caller reached it from this server's
  address. A key the API refuses is now answered from memory for a minute, with the API's own words and
  without a request; only a SHA-256 hash of the key is kept. The hosted server also sends the caller's
  address upstream as `X-Forwarded-For`.
- **A bug no longer passes for an outage.** Any `TypeError` used to count as "the API is unavailable", so a
  fault in this server's own code made `find_filter_values` drop the live counts without a word. Only a
  connection that failed on every try counts now.

## 0.2.0

Local mode: run the server over stdio, with the key in an environment variable.

### Added

- **`--stdio`** serves MCP over stdin and stdout instead of HTTP, for clients that start a server as a
  child process and for directories that build and inspect one. `npx jobo-developer-mcp --stdio`.
- **The key comes from `JOBO_API_KEY` in local mode.** There is no HTTP request, so no header. Without it
  the server starts, lists its six tools and answers the three contract tools; the three `find_` tools say
  which variable to set.
- `server.json` lists the stdio way of running the package next to the HTTP one.
- `glama.json` and `llms-install.md`, for directories that read a repository.

### Changed

- In local mode the tool descriptions, the server instructions and the key errors name the environment
  variable instead of the `Authorization` header, and requests to the Jobo API carry `(stdio)` in the
  `User-Agent`.

Nothing changes for the hosted server or for `npx jobo-developer-mcp` without the flag.

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
