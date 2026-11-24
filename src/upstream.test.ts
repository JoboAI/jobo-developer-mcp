import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { RejectedKeys, keyHash, rejectedKeys } from "./rejected-keys.js";
import {
  FREE_ENDPOINTS,
  REQUEST_TIMEOUT_MS,
  UpstreamError,
  UpstreamResponseError,
  UpstreamTimeoutError,
  UpstreamUnreachableError,
  apiBaseUrl,
  callApi,
  forwardedFor,
  isBilledPath,
  isRetryableStatus,
  parseRetryAfter,
  upstreamPath,
} from "./upstream.js";

// ─────────────────────────────────────────────────────────────────────────────
//  The billed-endpoint guard, part one: the endpoints this server can name.
//  Part two (`server.test.ts`) calls every tool and watches what goes out.
// ─────────────────────────────────────────────────────────────────────────────

describe("isBilledPath", () => {
  it("knows search, the feed and the geocoder", () => {
    for (const path of [
      "/api/jobs",
      "/api/jobs/",
      "/api/jobs?q=nurse",
      "/api/jobs/search",
      "/api/jobs/search/preview",
      "/api/jobs/feed",
      "/api/jobs/feed/managed",
      "/api/jobs/feed/4f0c2f0e-0000-0000-0000-000000000000",
      "/api/locations/geocode?location=Berlin",
      "/API/Locations/Geocode",
      "/api/mcp/jobs/search",
    ]) {
      assert.equal(isBilledPath(path), true, path);
    }
  });

  // Every signal returned is billed, at ten times a job: this server must never read one.
  it("knows both Hiring Signals endpoints", () => {
    for (const path of [
      "/api/signals",
      "/api/signals/",
      "/api/signals?types=hiring_surge&limit=5",
      "/API/Signals",
      "/api/companies/6c1f0a9e-3b7d-4c55-8e21-5a4d9f0b7c33/signals",
      "/api/companies/6c1f0a9e-3b7d-4c55-8e21-5a4d9f0b7c33/signals?min_strength=50",
      "/api/companies/{id}/signals",
    ]) {
      assert.equal(isBilledPath(path), true, path);
    }
    assert.equal(isBilledPath("/api/companies/6c1f0a9e-3b7d-4c55-8e21-5a4d9f0b7c33"), false, "a company by id is free");
  });

  it("leaves the free lookups alone", () => {
    for (const path of [
      "/api/connectors/companies/suggest?q=stripe",
      "/api/connectors/filter-options/skills",
      "/api/connectors/locations/suggest?q=berlin",
      "/api/occupations",
      "/api/jobs/11111111-2222-3333-4444-555555555555",
      "/api/jobs/expired",
    ]) {
      assert.equal(isBilledPath(path), false, path);
    }
  });
});

describe("FREE_ENDPOINTS, every path this server can call", () => {
  it("holds no billed endpoint", () => {
    for (const [name, template] of Object.entries(FREE_ENDPOINTS)) {
      assert.equal(isBilledPath(template), false, `${name} (${template}) is a billed endpoint`);
      assert.equal(isBilledPath(template.replace("{facet}", "skills")), false, name);
    }
  });

  it("holds neither signals endpoint", () => {
    for (const template of Object.values(FREE_ENDPOINTS)) assert.ok(!template.includes("signals"), template);
  });

  it("is the four free lookups jobo-cli uses, and nothing else", () => {
    assert.deepEqual(Object.values(FREE_ENDPOINTS).sort(), [
      "/api/connectors/companies/suggest",
      "/api/connectors/filter-options/{facet}",
      "/api/connectors/locations/suggest",
      "/api/occupations",
    ]);
  });
});

describe("upstreamPath", () => {
  it("fills in the facet and drops empty query parameters", () => {
    assert.equal(
      upstreamPath("filterOptions", { facet: "skills", query: { q: "c++", limit: 25, extra: undefined, blank: "" } }),
      "/api/connectors/filter-options/skills?q=c%2B%2B&limit=25",
    );
    assert.equal(upstreamPath("occupations"), "/api/occupations");
    assert.equal(upstreamPath("companiesSuggest", { query: { q: "acme & co" } }), "/api/connectors/companies/suggest?q=acme%20%26%20co");
  });

  it("cannot be steered off its endpoint by a facet", () => {
    const path = upstreamPath("filterOptions", { facet: "../../jobs/search" });
    assert.equal(path, "/api/connectors/filter-options/..%2F..%2Fjobs%2Fsearch");
    assert.equal(isBilledPath(path), false);
  });

  it("refuses a facet endpoint with no facet", () => {
    assert.throws(() => upstreamPath("filterOptions"));
  });
});

describe("apiBaseUrl", () => {
  it("is read on every call, so load order cannot decide which API a request reaches", () => {
    const saved = process.env.JOBO_API_URL;
    try {
      process.env.JOBO_API_URL = "http://127.0.0.1:9/";
      assert.equal(apiBaseUrl(), "http://127.0.0.1:9");
      delete process.env.JOBO_API_URL;
      assert.equal(apiBaseUrl(), "https://connect.jobo.world");
    } finally {
      if (saved === undefined) delete process.env.JOBO_API_URL;
      else process.env.JOBO_API_URL = saved;
    }
  });
});

describe("parseRetryAfter", () => {
  it("parses the delta-seconds form", () => {
    assert.equal(parseRetryAfter("30"), 30);
    assert.equal(parseRetryAfter("0"), 0);
  });

  it("parses the HTTP-date form as seconds from now", () => {
    const value = parseRetryAfter(new Date(Date.now() + 42_000).toUTCString());
    assert.ok(value !== undefined && value >= 40 && value <= 43, `expected ~42, got ${value}`);
  });

  it("returns undefined for a missing or unparseable header", () => {
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter(""), undefined);
    assert.equal(parseRetryAfter("soon"), undefined);
  });
});

describe("retries", () => {
  it("retries gateway errors only, never a 4xx", () => {
    assert.deepEqual([502, 503, 504].map(isRetryableStatus), [true, true, true]);
    assert.deepEqual([400, 401, 404, 429, 500].map(isRetryableStatus), [false, false, false, false, false]);
  });

  it("carries the retry-after seconds when the upstream sent them", () => {
    assert.equal(new UpstreamError(429, "Too Many Requests", 15).retryAfterSeconds, 15);
    assert.equal(new UpstreamError(429, "Too Many Requests").retryAfterSeconds, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  callApi against a local stub: what it tries again, and what it does not.
// ─────────────────────────────────────────────────────────────────────────────

describe("callApi", () => {
  const KEY = `jbe_test_${"a".repeat(21)}_${"b".repeat(43)}`;
  let stub: Server;
  let saved: string | undefined;
  let requests = 0;
  /** The headers of each request the stub got, in order. */
  let headers: IncomingHttpHeaders[] = [];
  /** What the stub does with each request, in order; the last entry repeats. */
  let script: Array<(res: ServerResponse) => void> = [];

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => (res: ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const text = (status: number, body: string) => (res: ServerResponse) => {
    res.writeHead(status, { "content-type": "text/html" });
    res.end(body);
  };
  const silence = () => {};

  before(async () => {
    stub = createServer((req, res) => {
      headers.push(req.headers);
      const step = script[Math.min(requests, script.length - 1)];
      requests++;
      step?.(res);
    });
    stub.listen(0);
    await new Promise((resolve) => stub.once("listening", resolve));
    saved = process.env.JOBO_API_URL;
    process.env.JOBO_API_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    requests = 0;
    script = [];
    headers = [];
    rejectedKeys.clear();
  });

  after(() => {
    if (saved === undefined) delete process.env.JOBO_API_URL;
    else process.env.JOBO_API_URL = saved;
    stub.closeAllConnections();
    stub.close();
  });

  it("returns the parsed body", async () => {
    script = [json(200, { version: "1", categories: [] })];
    assert.deepEqual(await callApi("occupations", KEY), { version: "1", categories: [] });
    assert.equal(requests, 1);
  });

  it("tries a gateway status again, and returns the answer when it comes", async () => {
    script = [json(503, { detail: "Search unavailable" }), json(200, { suggestions: [] })];
    assert.deepEqual(await callApi("companiesSuggest", KEY, { query: { q: "stripe" } }), { suggestions: [] });
    assert.equal(requests, 2);
  });

  it("gives up on a gateway status after three tries, with the last answer", async () => {
    script = [json(503, { detail: "Search unavailable" })];
    await assert.rejects(
      callApi("occupations", KEY),
      (err) => err instanceof UpstreamError && err.status === 503 && err.message.includes("Search unavailable"),
    );
    assert.equal(requests, 3);
  });

  it("does not try a refusal again", async () => {
    for (const status of [400, 401, 404, 429]) {
      requests = 0;
      rejectedKeys.clear(); // the 401 would otherwise be answered from memory on the next turn
      script = [json(status, { error: "no" }, status === 429 ? { "retry-after": "7" } : {})];
      await assert.rejects(
        callApi("occupations", KEY),
        (err) => err instanceof UpstreamError && err.status === status && (status !== 429 || err.retryAfterSeconds === 7),
      );
      assert.equal(requests, 1, `HTTP ${status} was retried`);
    }
  });

  it("does not try a timeout again: one wait, not three", async () => {
    script = [silence];
    const started = Date.now();
    await assert.rejects(
      callApi("occupations", KEY, { timeoutMs: 60 }),
      (err) => err instanceof UpstreamTimeoutError && err.timeoutMs === 60,
    );
    assert.equal(requests, 1, "a timeout was retried");
    assert.ok(Date.now() - started < 1000, "the call waited longer than its one timeout");
    assert.equal(REQUEST_TIMEOUT_MS, 15_000, "the default budget for a lookup");
  });

  it("reports a 200 that is not JSON as that, once, not as an unreachable API", async () => {
    script = [text(200, "<html><body>upstream connect error</body></html>")];
    await assert.rejects(callApi("occupations", KEY), (err) => err instanceof UpstreamResponseError && err.status === 200);
    assert.equal(requests, 1, "a broken body was retried");
  });

  it("tries a connection that failed before any answer again", async () => {
    script = [(res) => res.destroy(), json(200, { suggestions: [] })];
    assert.deepEqual(await callApi("locationsSuggest", KEY, { query: { q: "berlin" } }), { suggestions: [] });
    assert.equal(requests, 2);
  });

  it("reports a connection that never answered, three times over, as unreachable", async () => {
    script = [(res) => res.destroy()];
    await assert.rejects(callApi("occupations", KEY), (err) => err instanceof UpstreamUnreachableError);
    assert.equal(requests, 3);
  });

  // ── A key the API refused ────────────────────────────────────────────────

  it("answers a key the API just refused itself, with the API's own words, and asks again once it is forgotten", async () => {
    script = [json(401, { error: "Invalid or expired API key" })];

    for (let call = 0; call < 3; call++) {
      await assert.rejects(
        callApi("companiesSuggest", KEY, { query: { q: "stripe" } }),
        (err) => err instanceof UpstreamError && err.status === 401 && err.message.includes("Invalid or expired API key"),
      );
    }
    assert.equal(requests, 1, "a refused key reached the API again within the minute");

    rejectedKeys.clear(); // what the minute running out does
    await assert.rejects(callApi("companiesSuggest", KEY, { query: { q: "stripe" } }));
    assert.equal(requests, 2);
  });

  it("does not hold another key's refusal against this one", async () => {
    const other = `jbe_live_${"c".repeat(21)}_${"d".repeat(43)}`;
    script = [json(401, { error: "Invalid or expired API key" }), json(200, { suggestions: [] })];
    await assert.rejects(callApi("companiesSuggest", other, { query: { q: "stripe" } }));
    assert.deepEqual(await callApi("companiesSuggest", KEY, { query: { q: "stripe" } }), { suggestions: [] });
    assert.equal(requests, 2);
  });

  it("remembers only a refusal: any other failure is asked again", async () => {
    script = [json(403, { detail: "Not for this key." }), json(200, { suggestions: [] })];
    await assert.rejects(callApi("companiesSuggest", KEY, { query: { q: "stripe" } }));
    assert.deepEqual(await callApi("companiesSuggest", KEY, { query: { q: "stripe" } }), { suggestions: [] });
    assert.equal(rejectedKeys.size, 0);
  });

  // ── The caller's address ─────────────────────────────────────────────────

  it("sends the caller's address as X-Forwarded-For when it has one, and none when it does not", async () => {
    script = [json(200, { suggestions: [] })];
    await callApi("companiesSuggest", KEY, { query: { q: "stripe" }, forwardedFor: "203.0.113.9" });
    await callApi("companiesSuggest", KEY, { query: { q: "stripe" } });
    assert.equal(headers[0]?.["x-forwarded-for"], "203.0.113.9");
    assert.equal(headers[1]?.["x-forwarded-for"], undefined);
  });
});

describe("forwardedFor", () => {
  it("passes on the chain the edge proxy sent, whose last entry is the caller", () => {
    assert.equal(forwardedFor("198.51.100.7, 203.0.113.9", "10.42.0.17"), "198.51.100.7, 203.0.113.9");
    assert.equal(forwardedFor(["198.51.100.7", "203.0.113.9"], "10.42.0.17"), "198.51.100.7, 203.0.113.9");
    assert.equal(forwardedFor("2001:db8::1", "10.42.0.17"), "2001:db8::1");
  });

  it("sends the socket's address when no proxy sent a chain", () => {
    assert.equal(forwardedFor(undefined, "203.0.113.9"), "203.0.113.9");
    assert.equal(forwardedFor("", "::ffff:203.0.113.9"), "203.0.113.9");
    assert.equal(forwardedFor(undefined, "::1"), "::1");
    assert.equal(forwardedFor(undefined, undefined), undefined);
  });

  it("drops entries that are not addresses, and keeps the end of a long chain", () => {
    assert.equal(forwardedFor("evil\r\nX-Api-Key: x, unknown, 203.0.113.9", "10.0.0.1"), "203.0.113.9");
    const long = Array.from({ length: 30 }, (_, index) => `192.0.2.${index}`).join(", ");
    const sent = forwardedFor(long, "10.0.0.1")!.split(", ");
    assert.equal(sent.length, 10);
    assert.equal(sent[sent.length - 1], "192.0.2.29");
  });
});

describe("RejectedKeys", () => {
  it("forgets a key after its minute, holds at most its bound, and stores only hashes", () => {
    let now = 0;
    const store = new RejectedKeys(60_000, 2, () => now);
    store.remember("jbe_live_one", "{}");
    assert.equal(store.rejection("jbe_live_one"), "{}");
    now = 60_000;
    assert.equal(store.rejection("jbe_live_one"), undefined);

    store.remember("jbe_live_a", "a");
    store.remember("jbe_live_b", "b");
    store.remember("jbe_live_c", "c");
    assert.equal(store.size, 2);
    assert.equal(store.rejection("jbe_live_a"), undefined, "the oldest is the one dropped");
    assert.deepEqual(store.storedKeys(), [keyHash("jbe_live_b"), keyHash("jbe_live_c")]);
    for (const stored of store.storedKeys()) assert.ok(!stored.includes("jbe_"));
  });
});
