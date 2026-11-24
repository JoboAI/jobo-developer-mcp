import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { API_KEYS_URL, ApiKeyError } from "./auth.js";
import { isUnavailable, readUpstreamBody, sentence, toToolError } from "./errors.js";
import { UpstreamError, UpstreamResponseError, UpstreamTimeoutError, UpstreamUnreachableError } from "./upstream.js";

const context = { tool: "find_companies", endpointUrl: "https://dev-mcp.example/mcp" };
const text = (err: unknown): string => toToolError(err, context).content[0]!.text;

describe("readUpstreamBody", () => {
  it("reads a problem document, the key check's bare error, and a validation problem", () => {
    assert.equal(readUpstreamBody('{"title":"Not found","detail":"The skills facet is not published yet."}').detail, "The skills facet is not published yet.");
    assert.equal(readUpstreamBody('{"error":"Invalid or expired API key"}').detail, "Invalid or expired API key");
    assert.equal(readUpstreamBody('{"code":"not_available_in_sandbox","detail":"x"}').code, "not_available_in_sandbox");
    assert.deepEqual(readUpstreamBody('{"title":"One or more validation errors occurred.","errors":{"facet":["facet must be one of: sources."]}}').fieldErrors, [
      "facet: facet must be one of: sources.",
    ]);
  });

  it("yields nothing for anything that is not such a document", () => {
    for (const body of ["", "<html>502</html>", "[]", "null", '"text"']) {
      assert.deepEqual(readUpstreamBody(body), { code: null, detail: null, fieldErrors: [] }, body);
    }
  });
});

describe("toToolError", () => {
  it("marks every result as an error", () => {
    assert.equal(toToolError(new Error("boom"), context).isError, true);
  });

  it("turns a missing key into setup instructions", () => {
    const message = text(new ApiKeyError("missing"));
    assert.ok(message.includes("Authorization: Bearer <your key>"));
    assert.ok(message.includes(API_KEYS_URL));
    assert.ok(message.includes(context.endpointUrl));
  });

  it("says a rejected key is the key's problem, and where keys live", () => {
    const message = text(new UpstreamError(401, '{"error":"Invalid or expired API key"}'));
    assert.ok(message.includes("rejected the API key (Invalid or expired API key)"));
    assert.ok(message.includes(API_KEYS_URL));
  });

  it("explains a sandbox key", () => {
    const message = text(new UpstreamError(404, '{"code":"not_available_in_sandbox","detail":"Not available in the sandbox."}'));
    assert.ok(message.includes("not available with a sandbox key"));
    assert.ok(message.includes("jbe_live_"));
  });

  it("passes the API's own sentence through for a 404 and a 400", () => {
    assert.equal(
      text(new UpstreamError(404, '{"detail":"The occupations facet is not published yet."}')),
      "The occupations facet is not published yet.",
    );
    assert.ok(text(new UpstreamError(404, "")).includes("no such lookup"));
    assert.equal(
      text(new UpstreamError(400, '{"errors":{"facet":["facet must be one of: sources, skills."]}}')),
      "The Jobo API rejected the request: facet: facet must be one of: sources, skills.",
    );
  });

  it("tells the agent when to come back after a 429", () => {
    assert.equal(text(new UpstreamError(429, "", 12)), "Rate limited by the Jobo API. Retry in 12s.");
    assert.ok(text(new UpstreamError(429, "")).includes("Wait a moment"));
  });

  it("never dumps a raw body", () => {
    const message = text(new UpstreamError(503, "<html><body>upstream connect error</body></html>"));
    assert.equal(message, "The Jobo API is temporarily unavailable (HTTP 503). Retry shortly; nothing was billed.");
  });

  it("ends the API's own sentence before starting the next, with or without its full stop", () => {
    const expected = "The Jobo API is temporarily unavailable (HTTP 503): Search unavailable. Retry shortly; nothing was billed.";
    assert.equal(text(new UpstreamError(503, '{"detail":"Search unavailable"}')), expected);
    assert.equal(text(new UpstreamError(503, '{"detail":"Search unavailable."}')), expected);
    assert.equal(sentence("  Retry later  "), "Retry later.");
    assert.equal(sentence("Really?"), "Really?");
  });

  it("reports a network failure as one", () => {
    assert.equal(text(new TypeError("fetch failed")), "Could not reach the Jobo API: fetch failed");
    assert.equal(
      text(new UpstreamUnreachableError(new TypeError("fetch failed"))),
      "Could not reach the Jobo API: fetch failed",
    );
  });

  it("reports a timeout as a timeout, in seconds", () => {
    assert.equal(
      text(new UpstreamTimeoutError(15_000)),
      "The Jobo API did not answer within 15 seconds. Retry shortly; nothing was billed.",
    );
  });

  it("reports an answer that is not JSON as the API's fault, not as an unreachable API", () => {
    const message = text(new UpstreamResponseError(200));
    assert.ok(message.startsWith("The Jobo API answered HTTP 200 with a body that is not JSON"));
    assert.ok(!message.includes("Could not reach"));
  });
});

describe("isUnavailable: could not answer, as against refused", () => {
  it("is true when the API could not answer", () => {
    for (const err of [
      new UpstreamError(500, ""),
      new UpstreamError(503, ""),
      new UpstreamError(429, ""),
      new UpstreamTimeoutError(15_000),
      new UpstreamResponseError(200),
      new UpstreamUnreachableError(new TypeError("fetch failed")),
    ]) {
      assert.equal(isUnavailable(err), true, err.message || err.name);
    }
  });

  it("is false for a TypeError from this server's own code, which is a bug and not an outage", () => {
    for (const err of [
      new TypeError("Cannot read properties of undefined (reading 'options')"),
      new TypeError("counted.options.map is not a function"),
    ]) {
      assert.equal(isUnavailable(err), false, err.message);
    }
  });

  it("is false for a refusal, a missing key, and a bug", () => {
    for (const err of [
      new UpstreamError(400, ""),
      new UpstreamError(401, ""),
      new UpstreamError(403, ""),
      new UpstreamError(404, ""),
      new ApiKeyError("missing"),
      new ApiKeyError("malformed"),
      new Error("find_filter_values is not declared to call occupations"),
    ]) {
      assert.equal(isUnavailable(err), false, err.message);
    }
  });
});
