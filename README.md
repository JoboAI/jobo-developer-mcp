# Jobo Developer MCP Server

Remote MCP server for people writing code against the Jobo REST API. It sits in a coding agent (Claude
Code, Cursor and the like) and answers the questions an integration raises: which company id, which
occupation id, which exact filter value, which field of the request body. It can check a set of filters and
write out the request for them. It never runs a job search.

- **Transport:** Streamable HTTP, single `/mcp` endpoint, stateless. Serves MCP spec **2026-07-28** natively
  and every 2025-era client through the built-in legacy fallback (SDK v2 `createMcpHandler`, one factory
  for both eras). Same stack as the job-search server in `../mcp`.
- **Auth:** your Jobo API key, sent by the MCP client as `Authorization: Bearer <key>`. No OAuth, no
  sign-in. Three of the six tools need no key at all.
- **Cost:** every tool is free. None calls a billed endpoint, and a test fails if one ever does.

## Which Jobo MCP server is this?

There are three, split by who is asking:

| Server | For | Auth |
| --- | --- | --- |
| Job search, `jobs-mcp.jobo.world` (`../mcp`) | An assistant answering a job seeker: `search`, `fetch`, `search_jobs`. | OAuth sign-in |
| Analytics, `mcp.jobo.world` | SQL over the analytics data. | OAuth sign-in |
| **Developer (this one)** | A coding agent writing an integration against the REST API. | API key header |

The job-search server keeps its own `find_companies`, `find_filter_values` and `list_filters`, because an
assistant needs them while it searches. The same lookups are here for a different reader: this server's
tools say which filter a value goes into and where that sits in the request body, and its answers are
meant to be written into code.

## Setup

Create a key at [enterprise.jobo.world/api-keys](https://enterprise.jobo.world/api-keys) and put it in the
`JOBO_API_KEY` environment variable (the variable `jobo-cli` reads too). The snippets below take it from
there, so the key itself never lands in a file you might commit.

The hosted server runs at `https://dev-mcp.jobo.world/mcp` (live since 2026-11-22). To run your own copy
instead, see [Self-hosting](#self-hosting) and use `http://localhost:3003/mcp`, or
[Local mode](#local-mode-stdio) for a client that starts the server itself. Every coding agent and IDE
with a Jobo guide has its exact setup at `jobo.world/integrations/<client>`, or from `jobo mcp <client>`.

### Claude Code

```bash
claude mcp add --transport http jobo-developer https://dev-mcp.jobo.world/mcp \
  --header "Authorization: Bearer $JOBO_API_KEY"
```

Your shell expands `$JOBO_API_KEY`, and Claude Code stores the header with the server. Add `--scope user`
for every project. To share the server with a team, commit a `.mcp.json` that reads the variable instead:

```json
{
  "mcpServers": {
    "jobo-developer": {
      "type": "http",
      "url": "https://dev-mcp.jobo.world/mcp",
      "headers": {
        "Authorization": "Bearer ${JOBO_API_KEY}"
      }
    }
  }
}
```

Run `/mcp` in a session to check the server is connected.

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "jobo-developer": {
      "url": "https://dev-mcp.jobo.world/mcp",
      "headers": {
        "Authorization": "Bearer ${env:JOBO_API_KEY}"
      }
    }
  }
}
```

### Any other client

Point it at `https://dev-mcp.jobo.world/mcp` over Streamable HTTP and set one static header,
`Authorization: Bearer <key>`. `X-Api-Key: <key>`, the header the REST API itself takes, works too.

### Without a key

Leave the header out and the server still connects. `list_filters`, `describe_search_filters` and
`build_search_request` work as they are; the three `find_` tools answer with a tool error that shows the
header to add and where to create a key.

If a lookup says the value it received "is not a Jobo API key", the client most likely sent the
placeholder as text: check that `JOBO_API_KEY` is set in the environment the client starts from.

## Tools

All six are read-only.

| Tool | Key | What it returns |
| --- | --- | --- |
| `find_companies` | needed | Company name or domain prefix → each company's ids, domain, HQ country and live job count. |
| `find_filter_values` | needed | Values of one open-vocabulary filter (`sources`, `skills`, `industries`, `company_categories`, `job_categories`, `job_subcategories`, `occupations`) with live job counts. For `occupations`, a role name finds the occupation id. |
| `find_locations` | needed | How a place name resolves: the labels the job index stores, the string the search `location` filter takes, and the object the feed's `locations` takes. |
| `list_filters` | no | The fixed vocabularies: work models, employment types, experience levels, company categories, languages, sort orders, description formats, `include_fields`, and the feed's company size and revenue bands. |
| `describe_search_filters` | no | The whole job-search filter contract: each filter's name, type, accepted values or lookup tool, `exclude_` twin, where it goes in the `POST /api/jobs/search` body (with an example), and its `jobo` CLI flag. |
| `build_search_request` | no | A set of filters, checked against the contract → the exact request (method, URL, headers, JSON body), a `curl` command, a PowerShell command and a `jobo` CLI command. **It does not send the request.** |

A sandbox key (`jbe_test_…`) cannot use the lookups: the sandbox serves job search and lookups by id only.

### Occupations by name

The API's facet search matches occupation ids, not names, so `find_filter_values` with facet `occupations`
and a `q` matches the role name against the taxonomy (`GET /api/occupations`) and reads the facet once for
live job counts. The two calls are not equals:

- The taxonomy is the answer. If it cannot be had, the lookup fails. It is cached in memory for five
  minutes, since it is the same for every caller and only changes when the API ships a new one.
- The counts are a label. They are read on every lookup, on the caller's key. If the API cannot give them
  (a 5xx, a 429, a timeout), the matches still come back, with `count: null` and a line saying so. A
  refusal is not treated that way: a missing or rejected key, or a 404, fails the lookup, so the cached
  taxonomy is never served to a caller the API would turn away.

### `build_search_request`

Parameters are the contract's filter names (`work_model`, `q`, `min_salary_usd`), plus `page`, `page_size`,
`include_fields` and `include_facets`. The tool's input schema is generated from the contract, so
`tools/list` shows every filter with its values.

It reports two kinds of finding:

- An **error** is a break of something the contract defines: an unknown filter, a wrong type, a value
  outside a closed vocabulary, a malformed date or number, an impossible range, a page size out of bounds.
  One error and no request is built. The commonest slips get a direct answer: pass `work_models` (the
  body's spelling) and it names `work_model`; pass the flat `skills_exclude`, which the API ignores without
  failing, and it names `exclude_skills`; pass `"120000"` for a number and it says to send `120000`.
  The published schema carries each parameter's JSON type as a hint and enforces none of them, so that a
  wrong type reaches the tool and gets this answer instead of the SDK's generic validation error.
- Dates are checked by hand, not with `Date.parse`: `2026-02-31` is refused instead of rolling over to
  March, and a date-time with no zone is read as UTC, so a range compares the same on every machine.
- A **warning** is something the server can only guess at offline: a value of an open vocabulary (it names
  the lookup tool to confirm it with), a company given by name instead of id, a request with no narrowing
  filter. The request is still built.

The body comes from `toJobSearchBody` in `@jobo-ai/connector-core`, the function `jobo-cli`, the n8n node
and the other connectors build their search body with. Both commands read the key from the `JOBO_API_KEY`
environment variable: the `curl` command is written for a POSIX shell (bash, zsh), and the PowerShell one
(`Invoke-RestMethod`, Windows PowerShell 5.1 and PowerShell 7) reads `$env:JOBO_API_KEY` and sends the body
in ASCII, so 5.1's string encoding cannot change it. In `request.headers` the key is a description, not a
value to paste. The result also states the most the request can bill, which is `page_size` jobs, and no
price: the rate depends on the account.

## What costs money

Nothing on this server. In the API it describes:

| Call | Cost |
| --- | --- |
| Job search: `GET /api/jobs`, `POST /api/jobs/search` | Every job returned, after the plan's included jobs, at the account's pay-as-you-go rate. An empty page is free. |
| Feed: `POST /api/jobs/feed` | Every job that is new to the account, at the same rate. |
| Geocoding: `GET /api/locations/geocode` | Per lookup. |
| Lookups by id, and the endpoints behind this server's tools | Free. |

The current published rates are on [Billing](https://jobo.world/docs/billing). The server writes no price
into its instructions or results: the API charges by the account's pricing and plan, which it cannot see.
The server's instructions tell the agent the same, and tell it not to run a command `build_search_request`
returns unless the user wants the search run.

### The billed-endpoint guard

A tool here cannot name an upstream path. It names one of four entries in `FREE_ENDPOINTS`
(`src/upstream.ts`), declared per tool in `TOOL_CATALOG` (`src/server.ts`):

| Tool | Upstream |
| --- | --- |
| `find_companies` | `GET /api/connectors/companies/suggest` |
| `find_filter_values` | `GET /api/connectors/filter-options/{facet}`, and `GET /api/occupations` for an occupation name |
| `find_locations` | `GET /api/connectors/locations/suggest` |

Three checks keep it that way: `upstream.test.ts` fails if `FREE_ENDPOINTS` holds a search, feed or
geocode path; `server.test.ts` calls every tool in `tools/list` against a stub API and fails if any
request is billed, is not a `GET`, or goes somewhere the tool did not declare (and fails if a new tool is
not in that test); and `callApi` refuses a billed path at run time.

## Auth model

There is no gate on `/mcp`. The handshake, `tools/list` and the three contract tools are the same for
every caller and touch no upstream, so they are answered without a key.

A lookup that needs the key and gets none returns a tool error, not an HTTP `401`: a `401` makes an MCP
client start an OAuth flow, and this server has none. For the same reason it serves no
`/.well-known/oauth-protected-resource`.

The key is read from each request, forwarded to the Jobo API as `X-Api-Key`, and never stored, logged or
echoed. Validation is the API's: this server only checks the key's shape first (the check every Jobo
connector runs), so a mistyped key or an unexpanded `${JOBO_API_KEY}` fails with an explanation and never
leaves.

The hosted server reaches the API from inside the cluster, and the API blocks an address for five minutes
after 60 refused keys in five minutes. So that one client looping on a bad key cannot block everyone's
lookups:

- A key the API refuses is answered from memory for a minute, with the API's own words and without a
  request. Only a SHA-256 hash of the key is kept, in memory, bounded in size (`src/rejected-keys.ts`).
- Each lookup carries the caller's address as `X-Forwarded-For`: the chain the edge proxy sent, whose last
  entry is the address the proxy saw, or the socket's address when nothing is in front. The API takes the
  last entry as the client.

Which key a lookup runs on is decided by one function, `resolveApiKey` in `src/auth.ts`. Making the live
lookups keyless later means returning a key the server holds when the caller sent none, in that function.
Those calls would then share one key's rate limit, so that change needs a per-client limit in front of it.

## Discovery

- `GET /mcp/server-card`: the MCP Server Card
  ([SEP-2127](https://modelcontextprotocol.io/seps/2127-mcp-server-cards)): name, title, version,
  description, icons, the endpoint URL and the protocol versions it answers. Static, CORS-open, cacheable.
- `GET /.well-known/ai-catalog.json`: points at the card, for a client that knows only the host.
- `server/discover`, `initialize` and `tools/list` on `/mcp`, with no key. Each tool carries
  `"world.jobo/api-key": "required" | "not-needed"` in its `_meta`.

The card is built from the same constants as `server/discover`, and a test fails when it drifts from
`server.json` or `package.json`.

## Self-hosting

```bash
npx jobo-developer-mcp
```

Starts the server on `$PORT` (default `3003`); point your client at `http://localhost:3003/mcp`, with the
same `Authorization: Bearer <key>` header. From a checkout, `npm ci && npm run build && npm start` does the
same, and a `Dockerfile` is included.

| Variable | Default | Notes |
| --- | --- | --- |
| `JOBO_API_URL` | `https://connect.jobo.world` | Where the lookups go. |
| `MCP_PUBLIC_URL` | `https://dev-mcp.jobo.world` | The public base URL, used in the Server Card and in the setup snippet the missing-key error prints. |
| `PORT` | `3003` | The job-search server uses 3002, the analytics server 3001. |

The requests `build_search_request` writes always point at the public API (`https://connect.jobo.world`),
whatever `JOBO_API_URL` is, since that may be an internal address.

## Local mode: stdio

For a client that starts its MCP servers as child processes, and for directories that build a server and
inspect it. `--stdio` serves the same six tools over stdin and stdout; nothing listens on a port. 0.2.0 is
the first version with it.

```json
{
  "mcpServers": {
    "jobo-developer": {
      "command": "npx",
      "args": ["-y", "jobo-developer-mcp", "--stdio"],
      "env": {
        "JOBO_API_KEY": "<your key>"
      }
    }
  }
}
```

The key is the `JOBO_API_KEY` environment variable, not a header: there is no HTTP request to carry one.
Leave it out and the server still starts and lists its tools. `list_filters`, `describe_search_filters` and
`build_search_request` work as they are, and the three `find_` tools answer with a tool error that names the
variable to set. `JOBO_API_URL` applies as it does when self-hosting; `PORT` and `MCP_PUBLIC_URL` do nothing
here.

From a checkout: `npm ci && npm run build && node dist/index.js --stdio`.

## Directory files

| File | For | What it is |
| --- | --- | --- |
| `server.json` | The MCP Registry | The manifest: the hosted endpoint, and the npm package's two ways to run (HTTP and `--stdio`). |
| `glama.json` | Glama | Names the GitHub accounts that may manage a Glama listing of this repository, because it belongs to an organization. |
| `llms-install.md` | Coding agents, Cline's marketplace | Install steps written for an agent to follow. |

## Development

```bash
npm ci && npm run build && npm test
```

```bash
npm run dev
```

The tests need no credentials and no network: `server.test.ts` runs the real app on a socket in front of
a stub of the Jobo API, and refuses to start if the upstream is anything but that stub.

### Layout

| File | What it holds |
| --- | --- |
| `src/index.ts` | The HTTP app: `/mcp`, the Server Card, the AI Catalog, `/health`. |
| `src/server.ts` | The six tools, `TOOL_CATALOG`, the server instructions. |
| `src/auth.ts` | The API-key seam: reading the header, `resolveApiKey`, the missing-key text. |
| `src/upstream.ts` | `FREE_ENDPOINTS`, the billed-path list, the one function that calls the API. |
| `src/contract.ts` | The filter contract read for a developer: descriptions, body fields, fixed vocabularies. |
| `src/request.ts` | `build_search_request`: validation, the body, `curl` and the CLI command. |
| `src/format.ts` | Tool output as text. |
| `src/discovery.ts` | Server Card and AI Catalog. |

### Shared with the job-search server, by copy

`src/discovery.ts` (Server Card, AI Catalog, ETag matching) is a copy of `../mcp/src/discovery.ts`, and
the `Retry-After` parsing and the retry of gateway statuses in `src/upstream.ts` follow
`../mcp/src/upstream.ts`. They are copied, not imported, because each server is built by its own
Dockerfile from its own directory and `../mcp` is mirrored to a public repository on its own; neither can
reach into the other.

`callApi` has since parted from that server's in two places, on purpose: it does not retry a timeout (one
15-second wait, not three), and a `200` whose body is not JSON is reported as that, once, instead of being
retried and then called an unreachable API. The lookup
renderers in `src/format.ts` started from that server's and were rewritten for this server's reader.

The filter contract is not copied. It comes from `@jobo-ai/connector-core`, pinned exactly in
`package.json`; `contract.test.ts` fails when the installed version differs from `../contracts/filters.json`
or gains a filter that cannot be placed in the request body.

## Registry

Published to npm as **`jobo-developer-mcp`** and to the official MCP Registry as
**`world.jobo/developer`** (the `mcpName` in `package.json`; `server.json` in this directory is the
registry manifest). The tag `dev-mcp-vX.Y.Z` publishes npm first, then pushes `server.json` to the registry
under the DNS-verified `world.jobo/*` namespace: see `../RELEASING.md`. The version in `package.json`,
`server.json` (twice) and `src/config.ts` has to match, and a test fails when it does not.
