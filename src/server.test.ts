import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { AI_CATALOG_MEDIA_TYPE, SERVER_CARD_MEDIA_TYPE, SERVER_CARD_SCHEMA } from "./discovery.js";
import { rejectedKeys } from "./rejected-keys.js";
import { FREE_ENDPOINTS, apiBaseUrl, isBilledPath, type FreeEndpoint } from "./upstream.js";

// ─────────────────────────────────────────────────────────────────────────────
//  The real app, on a real socket, in front of a stub of the Jobo API. No test
//  here reaches the live API or holds a real key.
// ─────────────────────────────────────────────────────────────────────────────

// The right shape (jbe_test_ + 21 + _ + 43 characters) and nothing else: no key was ever issued with these values.
const KEY = `jbe_test_${"a".repeat(21)}_${"b".repeat(43)}`;
const REVOKED_KEY = `jbe_live_${"r".repeat(21)}_${"v".repeat(43)}`;
const SANDBOX_KEY = `jbe_test_${"s".repeat(21)}_${"x".repeat(43)}`;
const BEARER = { authorization: `Bearer ${KEY}` };

const MODERN = "2026-07-28";

interface Seen {
  method: string;
  path: string;
  pathname: string;
  headers: IncomingHttpHeaders;
}

const STUB_ROUTES: Record<string, unknown> = {
  "/api/connectors/companies/suggest": {
    suggestions: [
      {
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        ids: ["aaaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000002"],
        name: "Stripe",
        domain: "stripe.com",
        logo_url: null,
        country: "US",
        job_count: 412,
      },
    ],
  },
  "/api/connectors/filter-options/skills": { facet: "skills", options: [{ key: "Python", count: 120345 }] },
  "/api/connectors/filter-options/occupations": {
    facet: "occupations",
    options: [{ key: "esco:rn", name: "Registered Nurse", parent: "nursing", count: 900 }],
  },
  "/api/connectors/locations/suggest": {
    suggestions: [
      {
        city: "Berlin",
        region: "Berlin",
        country: "Germany",
        latitude: 52.52,
        longitude: 13.405,
        display_name: "Berlin, Germany",
        country_code: "DE",
      },
    ],
  },
  "/api/occupations": {
    version: "test",
    categories: [
      {
        name: "Healthcare",
        subcategories: [{ name: "Nursing", occupations: [{ id: "esco:rn", name: "Registered Nurse" }] }],
      },
    ],
  },
};

describe("the developer MCP server", () => {
  let upstream: Server;
  let server: Server;
  let base: string;
  let seen: Seen[] = [];
  let toolNames: string[] = [];
  let catalog: Record<string, { needsKey: boolean; upstream: readonly FreeEndpoint[] }>;
  let clearOccupationCache: () => void;
  /** Per-test answers that replace a route's usual one, by pathname. */
  const outages = new Map<string, { status: number; body: unknown }>();

  before(async () => {
    upstream = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://stub");
      seen.push({ method: req.method ?? "", path: req.url ?? "", pathname: url.pathname, headers: req.headers });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const key = req.headers["x-api-key"];
      if (!key) return send(401, { error: "Missing X-Api-Key header" });
      const outage = outages.get(url.pathname);
      if (outage) return send(outage.status, outage.body);
      if (key === REVOKED_KEY) return send(401, { error: "Invalid or expired API key" });
      if (key === SANDBOX_KEY) return send(404, { code: "not_available_in_sandbox", detail: "Not available with a sandbox key." });
      const body = STUB_ROUTES[url.pathname];
      return body ? send(200, body) : send(404, { title: "Not found" });
    });
    upstream.listen(0);
    await new Promise((resolve) => upstream.once("listening", resolve));

    const stubUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    process.env.NODE_ENV = "test"; // `index.ts` only listens outside tests
    process.env.JOBO_API_URL = stubUrl;
    delete process.env.MCP_PUBLIC_URL; // read once, when `config.ts` loads
    // Before anything is called: every lookup below must land on the stub. If
    // this fails, stop here rather than send a single request anywhere else.
    assert.equal(apiBaseUrl(), stubUrl, "the upstream is not the stub; refusing to run the wire tests");

    const { app } = await import("./index.js");
    ({ TOOL_CATALOG: catalog, clearOccupationCache } = await import("./server.js"));
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    toolNames = (await (await rpc(await modern("tools/list"))).result.tools).map((tool: { name: string }) => tool.name);
  });

  beforeEach(() => {
    seen = [];
    outages.clear();
    clearOccupationCache(); // every test starts cold, so each sees its own upstream calls
    rejectedKeys.clear(); // and asks the API about each key afresh
  });

  after(() => {
    server.close();
    upstream.close();
  });

  /** A JSON-RPC response arrives as JSON or as a one-message SSE stream. */
  async function rpc(res: Response): Promise<any> {
    const text = await res.text();
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const data = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .filter(Boolean);
      return JSON.parse(data[data.length - 1]!);
    }
    return JSON.parse(text);
  }

  /** A 2025-era request: no envelope, no protocol headers. */
  function legacy(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  }

  /** A 2026-07-28 request: the version travels in the envelope and the headers. */
  function modern(
    method: string,
    params: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN,
        "mcp-method": method,
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientInfo": { name: "dev-mcp-test", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  }

  interface ToolResult {
    status: number;
    challenge: string | null;
    isError: boolean;
    text: string;
    structured: any;
  }

  async function call(name: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<ToolResult> {
    const res = await modern("tools/call", { name, arguments: args }, headers);
    const message = await rpc(res);
    assert.ok(message.result, `tools/call ${name} returned no result: ${JSON.stringify(message)}`);
    return {
      status: res.status,
      challenge: res.headers.get("www-authenticate"),
      isError: message.result.isError === true,
      text: message.result.content.map((part: { text: string }) => part.text).join("\n"),
      structured: message.result.structuredContent,
    };
  }

  /** Arguments that exercise every upstream path of each tool. A tool missing here fails the guard below. */
  const CALLS: Record<string, Record<string, unknown>[]> = {
    find_companies: [{ q: "stripe" }, { q: "stripe.com", limit: 3 }],
    find_filter_values: [{ facet: "skills", q: "pyth" }, { facet: "occupations" }, { facet: "occupations", q: "nurse" }],
    find_locations: [{ q: "berlin" }],
    list_filters: [{}],
    describe_search_filters: [{}],
    build_search_request: [{ q: "nurse", location: "Berlin, Germany", work_model: ["remote"], page_size: 5 }],
    describe_signal_filters: [{}],
    build_signals_request: [
      { types: ["hiring_surge"], domains: ["stripe.com"], limit: 10 },
      { company_id: "6c1f0a9e-3b7d-4c55-8e21-5a4d9f0b7c33", min_strength: 50 },
    ],
  };

  // ── Discovery ──────────────────────────────────────────────────────────────

  describe("discovery, with no key", () => {
    it("answers server/discover", async () => {
      const res = await modern("server/discover");
      assert.equal(res.status, 200);
      const { result } = await rpc(res);
      assert.ok(result.supportedVersions.includes(MODERN));
      assert.equal(result.cacheScope, "public");
      assert.ok(result.capabilities.tools, "the server must advertise its tools capability");
      assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "jobo-developer");
    });

    it("answers tools/list with the eight tools, each saying whether it needs the key", async () => {
      const res = await modern("tools/list");
      assert.equal(res.status, 200);
      const { result } = await rpc(res);
      assert.deepEqual(result.tools.map((tool: { name: string }) => tool.name).sort(), [
        "build_search_request",
        "build_signals_request",
        "describe_search_filters",
        "describe_signal_filters",
        "find_companies",
        "find_filter_values",
        "find_locations",
        "list_filters",
      ]);
      for (const tool of result.tools) {
        assert.equal(tool.inputSchema.type, "object", tool.name);
        assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be read-only`);
        assert.equal(tool.annotations.destructiveHint, false, tool.name);
        assert.equal(tool._meta["world.jobo/api-key"], catalog[tool.name]?.needsKey ? "required" : "not-needed", tool.name);
      }
      assert.equal(result.cacheScope, "public");
      assert.ok(result.ttlMs > 0);
    });

    it("publishes build_search_request's parameters straight from the filter contract", async () => {
      const { result } = await rpc(await modern("tools/list"));
      const schema = result.tools.find((tool: { name: string }) => tool.name === "build_search_request").inputSchema;
      for (const name of ["q", "location", "work_model", "exclude_skills", "min_salary_usd", "sort", "page_size", "include_fields"]) {
        assert.ok(schema.properties[name], `missing parameter ${name}`);
      }
      assert.ok(schema.properties.work_model.description.includes("remote, hybrid, onsite"));
      assert.ok(schema.properties.exclude_skills.description.includes("`skills.exclude`"));
      assert.deepEqual(schema.required ?? [], []);
    });

    // The types are published as hints and not enforced by the SDK: a wrong
    // one has to reach the tool, which answers it in its own words (below).
    it("publishes each parameter's JSON type", async () => {
      const { result } = await rpc(await modern("tools/list"));
      const { properties } = result.tools.find((tool: { name: string }) => tool.name === "build_search_request").inputSchema;
      const list = { type: "array", items: { type: "string" } };
      assert.equal(properties.q.type, "string");
      assert.equal(properties.posted_after.type, "string");
      assert.equal(properties.sort.type, "string");
      assert.equal(properties.min_salary_usd.type, "integer");
      assert.equal(properties.page_size.type, "integer");
      assert.equal(properties.search_description.type, "boolean");
      assert.deepEqual(properties.work_model.anyOf, [list, { type: "string" }]);
      assert.deepEqual(properties.location.anyOf, [list, { type: "string" }]);
      assert.deepEqual({ type: properties.include_fields.type, items: properties.include_fields.items }, list);
      for (const [name, schema] of Object.entries(properties) as [string, Record<string, unknown>][]) {
        assert.ok(schema.type || schema.anyOf, `${name} has no type`);
        assert.ok(typeof schema.description === "string" && schema.description.length > 0, `${name} has no description`);
      }
    });

    it("answers the 2025-era handshake and tools/list, with instructions that say what is billed", async () => {
      const init = await legacy({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dev-mcp-test", version: "0.0.0" } },
      });
      assert.equal(init.status, 200);
      const { result } = await rpc(init);
      assert.equal(result.serverInfo.name, "jobo-developer");
      for (const phrase of [
        "It does not search jobs",
        "jobs-mcp.jobo.world",
        "billed per job returned",
        "/api/locations/geocode",
        "Authorization: Bearer",
        "`describe_signal_filters`",
        "ten times the price of a job",
        "a signal read again is billed again",
        "no tool here reads signals",
      ]) {
        assert.ok(result.instructions.includes(phrase), `instructions should mention: ${phrase}`);
      }

      assert.equal((await legacy({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

      const list = await legacy({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      assert.equal(list.status, 200);
      assert.equal((await rpc(list)).result.tools.length, 8);
    });

    it("has no OAuth: no challenge anywhere, and no protected-resource metadata", async () => {
      assert.equal((await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } })).status, 405);
      assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource`)).status, 404);
      assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status, 404);
      assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 404);
    });

    it("touches no upstream", () => {
      assert.deepEqual(seen, []);
    });

    // ── Server Card + AI Catalog ─────────────────────────────────────────────

    const manifest = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

    it("serves the Server Card under the endpoint, publicly cacheable and CORS-open", async () => {
      const res = await fetch(`${base}/mcp/server-card`, { headers: { accept: SERVER_CARD_MEDIA_TYPE } });
      assert.equal(res.status, 200);
      assert.ok((res.headers.get("content-type") ?? "").startsWith(SERVER_CARD_MEDIA_TYPE));
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.equal(res.headers.get("access-control-expose-headers"), "ETag");
      assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
      const etag = res.headers.get("etag");
      assert.ok(etag, "the card must carry an ETag");

      const card = await res.json();
      assert.equal(card.$schema, SERVER_CARD_SCHEMA);
      assert.match(card.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
      assert.ok(card.description.length >= 1 && card.description.length <= 100, "card description is 1–100 chars");
      assert.ok(card.title.length >= 1 && card.title.length <= 100);

      assert.equal((await fetch(`${base}/mcp/server-card`, { headers: { "if-none-match": etag! } })).status, 304);

      const preflight = await fetch(`${base}/mcp/server-card`, { method: "OPTIONS" });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-methods"), "GET");
    });

    it("keeps the card in step with the registry manifest, package.json and server/discover", async () => {
      const card = await (await fetch(`${base}/mcp/server-card`)).json();
      assert.equal(manifest.name, "world.jobo/developer");
      assert.equal(pkg.mcpName, manifest.name);
      assert.equal(pkg.version, manifest.version);
      assert.equal(card.name, manifest.name);
      assert.equal(card.title, manifest.title);
      assert.equal(card.description, manifest.description);
      assert.equal(card.version, manifest.version);
      assert.equal(card.websiteUrl, manifest.websiteUrl);
      assert.deepEqual(card.icons, manifest.icons);
      assert.equal(card.remotes.length, 1);
      assert.equal(card.remotes[0].type, manifest.remotes[0].type);
      assert.equal(card.remotes[0].url, manifest.remotes[0].url);

      // A card should not contradict the live answer.
      const { result } = await rpc(await modern("server/discover"));
      const info = result._meta["io.modelcontextprotocol/serverInfo"];
      assert.equal(card.version, info.version);
      assert.equal(card.title, info.title);
      assert.equal(card.description, info.description);
      for (const version of result.supportedVersions) {
        assert.ok(card.remotes[0].supportedProtocolVersions.includes(version), `card is missing ${version}`);
      }
    });

    it("names the npm package in the manifest exactly as package.json publishes it", () => {
      // The registry reads `mcpName` from the published tarball and refuses a
      // manifest whose name, package or version disagrees with it.
      assert.equal(pkg.private, undefined, "a private package cannot be published");
      // Two ways to run the one package: the HTTP server, and local mode over stdio.
      assert.equal(manifest.packages.length, 2);
      const [entry, local] = manifest.packages;
      for (const packaged of manifest.packages) {
        assert.equal(packaged.registryType, "npm");
        assert.equal(packaged.identifier, pkg.name);
        assert.equal(packaged.version, pkg.version);
      }
      assert.deepEqual(entry.transport, { type: "streamable-http", url: "http://localhost:3003/mcp" });
      assert.deepEqual(local.transport, { type: "stdio" });
      assert.deepEqual(local.packageArguments.map((argument: { name: string }) => argument.name), ["--stdio"]);
      const [key] = local.environmentVariables;
      assert.equal(key.name, "JOBO_API_KEY");
      assert.equal(key.isSecret, true);
      assert.equal(key.isRequired, false, "five of the eight tools work without it");
      // `npx jobo-developer-mcp` has to start the server.
      assert.deepEqual(pkg.bin, { [pkg.name]: "dist/index.js" });
      assert.ok(pkg.files.includes("dist"));
    });

    it("declares the key as an optional secret header in the manifest, and nothing OAuth", () => {
      const [header] = manifest.remotes[0].headers;
      assert.equal(header.name, "Authorization");
      assert.equal(header.value, "Bearer {api_key}");
      assert.equal(header.isSecret, true);
      assert.equal(header.isRequired, false, "five of the eight tools work without it");
    });

    it("serves the AI Catalog pointing at the card", async () => {
      const res = await fetch(`${base}/.well-known/ai-catalog.json`);
      assert.equal(res.status, 200);
      assert.ok((res.headers.get("content-type") ?? "").startsWith(AI_CATALOG_MEDIA_TYPE));
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.deepEqual(await res.json(), {
        specVersion: "1.0",
        entries: [
          {
            identifier: "urn:air:jobo.world:mcp:developer",
            type: SERVER_CARD_MEDIA_TYPE,
            url: "https://dev-mcp.jobo.world/mcp/server-card",
          },
        ],
      });
    });
  });

  // ── The key seam ───────────────────────────────────────────────────────────

  describe("the API-key seam", () => {
    const keyless = () => toolNames.filter((name) => !catalog[name]?.needsKey);
    const keyed = () => toolNames.filter((name) => catalog[name]?.needsKey);

    it("splits the tools five without a key and three with one", () => {
      assert.deepEqual(keyless().sort(), [
        "build_search_request",
        "build_signals_request",
        "describe_search_filters",
        "describe_signal_filters",
        "list_filters",
      ]);
      assert.deepEqual(keyed().sort(), ["find_companies", "find_filter_values", "find_locations"]);
    });

    it("runs the keyless tools with no key, and with no upstream call", async () => {
      for (const name of keyless()) {
        for (const args of CALLS[name] ?? []) {
          const result = await call(name, args);
          assert.equal(result.status, 200, name);
          assert.equal(result.isError, false, `${name}: ${result.text}`);
          assert.ok(result.text.length > 0 && result.structured, name);
        }
      }
      assert.deepEqual(seen, [], "a keyless tool reached the upstream API");
    });

    it("runs the keyless tools the same when a key is present, still with no upstream call", async () => {
      for (const name of keyless()) {
        const result = await call(name, CALLS[name]![0]!, BEARER);
        assert.equal(result.isError, false, name);
      }
      assert.deepEqual(seen, []);
    });

    it("refuses a keyed tool with no key: a tool error with the setup steps, not a 401", async () => {
      for (const name of keyed()) {
        const result = await call(name, CALLS[name]![0]!);
        assert.equal(result.status, 200, `${name} must not answer 401: a client would start an OAuth flow`);
        assert.equal(result.challenge, null, name);
        assert.equal(result.isError, true, name);
        assert.ok(result.text.includes(`\`${name}\` calls the Jobo API and needs your Jobo API key`), result.text);
        assert.ok(result.text.includes("Authorization: Bearer <your key>"), name);
        assert.ok(result.text.includes("claude mcp add --transport http jobo-developer https://dev-mcp.jobo.world/mcp --header"), name);
        assert.ok(result.text.includes(".cursor/mcp.json"), name);
        assert.match(result.text, /https:\/\/enterprise\.jobo\.world\/api-keys/, name);
      }
      assert.deepEqual(seen, [], "a keyed tool reached the upstream API without a key");
    });

    it("refuses a 2025-era client the same way", async () => {
      const res = await legacy({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "find_companies", arguments: { q: "stripe" } } });
      assert.equal(res.status, 200);
      const { result } = await rpc(res);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /https:\/\/enterprise\.jobo\.world\/api-keys/);
      assert.deepEqual(seen, []);
    });

    it("forwards the caller's key upstream as X-Api-Key, on every call a keyed tool makes", async () => {
      for (const name of keyed()) {
        for (const args of CALLS[name] ?? []) {
          const result = await call(name, args, BEARER);
          assert.equal(result.isError, false, `${name} ${JSON.stringify(args)}: ${result.text}`);
          assert.ok(!result.text.includes(KEY) && !JSON.stringify(result.structured).includes(KEY), `${name} echoed the key`);
        }
      }
      assert.ok(seen.length >= keyed().length);
      for (const request of seen) {
        assert.equal(request.headers["x-api-key"], KEY, request.path);
        assert.equal(request.headers.authorization, undefined, "the key travels in the header the REST API reads");
        assert.equal(request.headers["x-jobo-client"], "dev-mcp");
        assert.match(String(request.headers["user-agent"]), /^jobo-developer-mcp\/\d+\.\d+\.\d+$/);
      }
    });

    it("takes the key from each request, never from an earlier one", async () => {
      assert.equal((await call("find_companies", { q: "stripe" }, BEARER)).isError, false);
      const next = await call("find_companies", { q: "stripe" });
      assert.equal(next.isError, true, "a request without a key must not ride on the previous caller's");
      assert.equal(seen.length, 1);
    });

    it("also accepts the REST API's own header, and a 2025-era client", async () => {
      assert.equal((await call("find_locations", { q: "berlin" }, { "x-api-key": KEY })).isError, false);
      const res = await legacy(
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "find_locations", arguments: { q: "berlin" } } },
        BEARER,
      );
      assert.equal((await rpc(res)).result.isError, undefined);
      assert.deepEqual(seen.map((request) => request.headers["x-api-key"]), [KEY, KEY]);
    });

    it("stops a value that is not a key before it leaves, without repeating it", async () => {
      // An unexpanded placeholder (under a name the message does not itself use), and a typo.
      for (const sent of ["Bearer ${MY_JOBO_KEY}", "Bearer not-a-key"]) {
        const result = await call("find_companies", { q: "stripe" }, { authorization: sent });
        assert.equal(result.isError, true);
        assert.ok(result.text.includes("is not a Jobo API key"), result.text);
        assert.ok(!result.text.includes(sent.slice("Bearer ".length)), "the value sent must not be echoed");
      }
      assert.deepEqual(seen, []);
    });

    it("reports a key the API rejects, and a sandbox key, in words", async () => {
      const revoked = await call("find_companies", { q: "stripe" }, { authorization: `Bearer ${REVOKED_KEY}` });
      assert.equal(revoked.isError, true);
      assert.ok(revoked.text.includes("rejected the API key (Invalid or expired API key)"), revoked.text);
      assert.ok(!revoked.text.includes(REVOKED_KEY));

      const sandbox = await call("find_filter_values", { facet: "skills" }, { authorization: `Bearer ${SANDBOX_KEY}` });
      assert.equal(sandbox.isError, true);
      assert.ok(sandbox.text.includes("not available with a sandbox key"), sandbox.text);
    });

    // The API blocks an address after 60 refused keys in five minutes, and
    // every hosted caller reaches it from this server's address.
    it("answers a refused key again from memory, in the same words, without asking the API", async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const revoked = await call("find_companies", { q: "stripe" }, { authorization: `Bearer ${REVOKED_KEY}` });
        assert.equal(revoked.isError, true);
        assert.ok(revoked.text.includes("rejected the API key (Invalid or expired API key)"), revoked.text);
      }
      assert.equal(seen.length, 1, "a refused key reached the API on every call");

      assert.equal((await call("find_companies", { q: "stripe" }, BEARER)).isError, false, "a good key is not affected");
    });

    it("sends the caller's address upstream, so the API's throttle counts the caller and not this server", async () => {
      // As the edge proxy sends it: whatever came in, then the address the proxy saw.
      await call("find_companies", { q: "stripe" }, { ...BEARER, "x-forwarded-for": "198.51.100.7, 203.0.113.9" });
      assert.equal(seen[0]?.headers["x-forwarded-for"], "198.51.100.7, 203.0.113.9");

      // No proxy in front: the socket's own address.
      await call("find_companies", { q: "stripe" }, BEARER);
      assert.match(String(seen[1]?.headers["x-forwarded-for"]), /^(127\.0\.0\.1|::1)$/);
    });
  });

  // ── What the lookups return ────────────────────────────────────────────────

  describe("the lookups", () => {
    it("find_companies returns every id of the company", async () => {
      const result = await call("find_companies", { q: "stripe", limit: 3 }, BEARER);
      assert.equal(seen[0]?.path, "/api/connectors/companies/suggest?q=stripe&limit=3");
      assert.ok(result.text.includes("1. Stripe (stripe.com, US) · 412 live jobs"));
      assert.equal(result.structured.suggestions[0].ids.length, 2);
    });

    it("find_filter_values lists a facet by prefix", async () => {
      const result = await call("find_filter_values", { facet: "skills", q: "pyth" }, BEARER);
      assert.equal(seen[0]?.path, "/api/connectors/filter-options/skills?q=pyth&limit=25");
      assert.ok(result.text.includes("- Python: 120,345 jobs"));
      assert.deepEqual(result.structured.options, [{ key: "Python", count: 120345 }]);
    });

    it("find_filter_values finds an occupation by name through the taxonomy, with its live count", async () => {
      const result = await call("find_filter_values", { facet: "occupations", q: "nurse" }, BEARER);
      assert.deepEqual(seen.map((request) => request.path).sort(), [
        "/api/connectors/filter-options/occupations?limit=250",
        "/api/occupations",
      ]);
      assert.deepEqual(result.structured.options, [
        { key: "esco:rn", name: "Registered Nurse", parent: "Nursing", category: "Healthcare", count: 900 },
      ]);
      assert.ok(result.text.includes("- esco:rn — Registered Nurse (Healthcare › Nursing): 900 jobs"));
    });

    // The live counts are a label on the answer. When the API cannot give
    // them, the ids still go out; the taxonomy is the answer, and stays fatal.
    it("find_filter_values still finds the occupation when only the counts are unavailable", async () => {
      outages.set("/api/connectors/filter-options/occupations", { status: 503, body: { detail: "Search unavailable" } });
      const result = await call("find_filter_values", { facet: "occupations", q: "nurse" }, BEARER);
      assert.equal(result.isError, false, result.text);
      assert.deepEqual(result.structured.options, [
        { key: "esco:rn", name: "Registered Nurse", parent: "Nursing", category: "Healthcare", count: null },
      ]);
      assert.equal(result.structured.counts_available, false);
      assert.ok(result.text.includes("- esco:rn — Registered Nurse (Healthcare › Nursing)\n"), result.text);
      assert.ok(result.text.includes("Live job counts are unavailable right now"));
      assert.equal(seen.filter((request) => request.pathname === "/api/occupations").length, 1);
    });

    it("find_filter_values does not pass a fault in its own code off as unavailable counts", async () => {
      // A counts answer this server cannot read throws a TypeError in its own code: a bug to report, not an outage.
      outages.set("/api/connectors/filter-options/occupations", { status: 200, body: { facet: "occupations", options: 42 } });
      const result = await call("find_filter_values", { facet: "occupations", q: "nurse" }, BEARER);
      assert.equal(result.isError, true, result.text);
      assert.ok(!result.text.includes("Live job counts are unavailable"), result.text);
    });

    it("find_filter_values fails when the taxonomy itself cannot be had", async () => {
      outages.set("/api/occupations", { status: 404, body: {} });
      const result = await call("find_filter_values", { facet: "occupations", q: "nurse" }, BEARER);
      assert.equal(result.isError, true);
      assert.ok(result.text.includes("no such lookup"), result.text);
    });

    it("find_filter_values does not hide a refusal of the counts call: a 4xx is not an outage", async () => {
      outages.set("/api/connectors/filter-options/occupations", { status: 404, body: { detail: "The occupations facet is not published yet." } });
      const result = await call("find_filter_values", { facet: "occupations", q: "nurse" }, BEARER);
      assert.equal(result.isError, true);
      assert.equal(result.text, "The occupations facet is not published yet.");
    });

    it("downloads the taxonomy once, and reads the counts on every lookup", async () => {
      for (const q of ["nurse", "registered", "nursing"]) {
        const result = await call("find_filter_values", { facet: "occupations", q }, BEARER);
        assert.equal(result.structured.options[0].key, "esco:rn", q);
        assert.equal(result.structured.options[0].count, 900, q);
      }
      assert.equal(seen.filter((request) => request.pathname === "/api/occupations").length, 1, "the taxonomy was fetched again");
      assert.equal(seen.filter((request) => request.pathname === "/api/connectors/filter-options/occupations").length, 3);
    });

    it("never serves the cached taxonomy to a caller with no key, or with one the API rejects", async () => {
      assert.equal((await call("find_filter_values", { facet: "occupations", q: "nurse" }, BEARER)).isError, false);
      seen = [];

      const none = await call("find_filter_values", { facet: "occupations", q: "nurse" });
      assert.equal(none.isError, true);
      assert.ok(none.text.includes("needs your Jobo API key"), none.text);
      assert.equal(none.structured, undefined);
      assert.deepEqual(seen, [], "a lookup with no key reached the upstream API");

      const revoked = await call("find_filter_values", { facet: "occupations", q: "nurse" }, { authorization: `Bearer ${REVOKED_KEY}` });
      assert.equal(revoked.isError, true);
      assert.ok(revoked.text.includes("rejected the API key"), revoked.text);
      assert.equal(revoked.structured, undefined);
    });

    it("find_locations returns the search string and the feed object", async () => {
      const result = await call("find_locations", { q: "berlin" }, BEARER);
      assert.equal(seen[0]?.path, "/api/connectors/locations/suggest?q=berlin&limit=5");
      assert.equal(result.structured.suggestions[0].search_location, "Berlin, Germany");
      assert.deepEqual(result.structured.suggestions[0].feed_location, { country: "Germany", region: "Berlin", city: "Berlin" });
    });

    it("rejects arguments outside a tool's schema as a tool error", async () => {
      const short = await call("find_companies", { q: "s" }, BEARER);
      assert.equal(short.isError, true);
      const facet = await call("find_filter_values", { facet: "salaries" }, BEARER);
      assert.equal(facet.isError, true);
      assert.deepEqual(seen, []);
    });
  });

  // ── build_search_request over the wire ─────────────────────────────────────

  describe("build_search_request", () => {
    it("returns the request and never sends it", async () => {
      const result = await call("build_search_request", {
        q: "nurse",
        location: "Berlin, Germany",
        work_model: ["remote"],
        exclude_skills: ["PHP"],
        page_size: 5,
      });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.structured.sent, false);
      assert.deepEqual(result.structured.request, {
        method: "POST",
        url: "https://connect.jobo.world/api/jobs/search",
        path: "/api/jobs/search",
        headers: {
          "X-Api-Key": "<your API key, read from the JOBO_API_KEY environment variable>",
          "Content-Type": "application/json",
        },
        body: {
          queries: ["nurse"],
          locations: ["Berlin, Germany"],
          work_models: ["remote"],
          skills: { exclude: ["PHP"] },
          page_size: 5,
        },
      });
      assert.ok(result.structured.curl.startsWith("curl -sS -X POST https://connect.jobo.world/api/jobs/search"));
      assert.ok(
        result.structured.powershell.startsWith("Invoke-RestMethod -Method Post -Uri 'https://connect.jobo.world/api/jobs/search'"),
      );
      assert.equal(
        result.structured.cli,
        "jobo search nurse --location 'Berlin, Germany' --work-model remote --exclude-skills PHP --page-size 5 --json",
      );
      assert.deepEqual(seen, [], "build_search_request must not send anything");
    });

    it("points at the public API, not at wherever this server's upstream is", async () => {
      const result = await call("build_search_request", { q: "nurse" });
      assert.ok(!result.text.includes("127.0.0.1") && !JSON.stringify(result.structured).includes("127.0.0.1"));
    });

    // Typed strictly, the SDK would refuse these before the tool ran, with a
    // generic "Input validation error" in place of the messages below.
    it("answers a value of the wrong type in its own words", async () => {
      const result = await call("build_search_request", { min_salary_usd: "120000", page_size: "10", q: ["a", "b"], search_description: "no" });
      assert.equal(result.isError, true);
      assert.ok(!result.text.includes("Input validation error"), result.text);
      assert.ok(result.text.includes('- min_salary_usd: Takes a whole number above zero. Send it as a JSON number: 120000, not "120000".'), result.text);
      assert.ok(result.text.includes('- page_size: Takes a whole number from 1 to 100. Send it as a JSON number: 10, not "10".'));
      assert.ok(result.text.includes("- q: Takes a string. One query per request here; the body's `queries` array takes several, OR'd."));
      assert.ok(result.text.includes("- search_description: Takes true or false."));
      assert.equal(result.structured.errors.length, 4);
      assert.equal(result.structured.request, undefined);
    });

    it("refuses a date that is not on the calendar", async () => {
      const result = await call("build_search_request", { q: "nurse", posted_after: "2026-02-31" });
      assert.equal(result.isError, true);
      assert.ok(result.text.includes('- posted_after: "2026-02-31" is not a real date or time'), result.text);
    });

    it("reports an unknown parameter instead of dropping it", async () => {
      const result = await call("build_search_request", { work_models: ["remote"], sort: "newest" });
      assert.equal(result.isError, true);
      assert.equal(result.structured.valid, false);
      assert.equal(result.structured.request, undefined);
      assert.ok(result.text.includes("`work_model`"), result.text);
      assert.ok(result.text.includes("relevance, discovered_asc, discovered_desc"));
      assert.deepEqual(seen, []);
    });
  });

  // ── The Hiring Signals tools over the wire ─────────────────────────────────

  describe("the Hiring Signals tools", () => {
    it("describe_signal_filters returns the contract with no key and no request", async () => {
      const result = await call("describe_signal_filters", {});
      assert.equal(result.isError, false, result.text);
      assert.equal(result.structured.endpoints.list.url, "https://connect.jobo.world/api/signals");
      assert.deepEqual(result.structured.endpoints.company.takes, [
        "types",
        "min_strength",
        "detected_after",
        "detected_before",
        "created_after",
      ]);
      assert.ok(result.text.includes("ten times the price of a job"), result.text);
      assert.ok(result.text.includes("minus five minutes"));
      assert.deepEqual(seen, []);
    });

    it("build_signals_request returns the GET request and never sends it", async () => {
      const result = await call("build_signals_request", {
        types: ["hiring_surge", "new_country"],
        domains: ["stripe.com"],
        exclude_agencies: true,
        limit: 10,
      });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.structured.sent, false);
      assert.deepEqual(result.structured.request, {
        method: "GET",
        url: "https://connect.jobo.world/api/signals?types=hiring_surge%2Cnew_country&domains=stripe.com&exclude_agencies=true&limit=10",
        path: "/api/signals",
        query: { types: "hiring_surge,new_country", domains: "stripe.com", exclude_agencies: true, limit: 10 },
        headers: { "X-Api-Key": "<your API key, read from the JOBO_API_KEY environment variable>" },
      });
      assert.equal(result.structured.billing.max_signals_billed, 10);
      assert.deepEqual(seen, [], "build_signals_request must not send anything");
    });

    it("build_signals_request refuses a filter the per-company endpoint does not take, naming it", async () => {
      const result = await call("build_signals_request", { company_id: "6c1f0a9e-3b7d-4c55-8e21-5a4d9f0b7c33", domains: ["stripe.com"] });
      assert.equal(result.isError, true);
      assert.ok(result.text.includes("- domains: `GET /api/companies/{id}/signals` does not take `domains`"), result.text);
      assert.equal(result.structured.request, undefined);
    });

    it("publishes build_signals_request's parameters from the signals contract", async () => {
      const { result } = await rpc(await modern("tools/list"));
      const { properties } = result.tools.find((tool: { name: string }) => tool.name === "build_signals_request").inputSchema;
      for (const name of ["types", "domains", "job_cities", "min_strength", "created_after", "company_id", "limit", "cursor"]) {
        assert.ok(properties[name], `missing parameter ${name}`);
      }
      assert.ok(properties.types.description.includes("hiring_surge"));
      assert.equal(properties.min_strength.type, "integer");
      assert.equal(properties.exclude_agencies.type, "boolean");
    });
  });

  // ── The billed-endpoint guard ──────────────────────────────────────────────
  //
  // No tool may reach job search, the feed or the geocoder. Two halves:
  // what each tool declares it calls, and what actually goes out when every
  // tool is called. `upstream.test.ts` covers the endpoint list itself.

  describe("the billed-endpoint guard", () => {
    it("declares only free endpoints, and an endpoint for every keyed tool", () => {
      assert.deepEqual(Object.keys(catalog).sort(), [...toolNames].sort(), "TOOL_CATALOG and tools/list name different tools");
      for (const [name, entry] of Object.entries(catalog)) {
        assert.equal(entry.upstream.length > 0, entry.needsKey, `${name}: a tool needs the key exactly when it calls upstream`);
        for (const endpoint of entry.upstream) {
          const template = FREE_ENDPOINTS[endpoint];
          assert.ok(template, `${name} declares an endpoint that does not exist: ${endpoint}`);
          assert.equal(isBilledPath(template), false, `${name} declares a billed endpoint: ${template}`);
        }
      }
    });

    it("has a call for every tool, so a new tool cannot skip the check", () => {
      assert.deepEqual(Object.keys(CALLS).sort(), [...toolNames].sort());
    });

    it("sends nothing to a billed endpoint, and nothing a tool did not declare", async () => {
      const used = new Set<string>();
      for (const name of toolNames) {
        seen = [];
        for (const args of CALLS[name] ?? []) {
          const result = await call(name, args, BEARER);
          assert.equal(result.isError, false, `${name} ${JSON.stringify(args)}: ${result.text}`);
        }

        const declared = (catalog[name]?.upstream ?? []).map(
          (endpoint) => new RegExp(`^${FREE_ENDPOINTS[endpoint].replace("{facet}", "[a-z_]+")}$`),
        );
        for (const request of seen) {
          assert.equal(isBilledPath(request.path), false, `${name} called a billed endpoint: ${request.method} ${request.path}`);
          assert.equal(request.method, "GET", `${name} sent a ${request.method}: every lookup is a read`);
          assert.ok(
            declared.some((pattern) => pattern.test(request.pathname)),
            `${name} called ${request.pathname}, which TOOL_CATALOG does not declare for it`,
          );
          used.add(request.pathname);
        }
        if (!catalog[name]?.needsKey) assert.deepEqual(seen, [], `${name} is keyless and must not call upstream`);
      }

      // The calls above have to reach every endpoint, or the guard proves less than it claims.
      for (const [endpoint, template] of Object.entries(FREE_ENDPOINTS)) {
        const pattern = new RegExp(`^${template.replace("{facet}", "[a-z_]+")}$`);
        assert.ok([...used].some((pathname) => pattern.test(pathname)), `no test call reached ${endpoint}`);
      }
    });
  });
});
