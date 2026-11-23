import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { API_KEYS_URL, ApiKeyError, apiKeyErrorMessage, apiKeyFromHeaders, resolveApiKey } from "./auth.js";

// The right shape (jbe_test_ + 21 + _ + 43 characters) and nothing else: no key was ever issued with this value.
const KEY = `jbe_test_${"a".repeat(21)}_${"b".repeat(43)}`;
const ENDPOINT = "https://dev-mcp.example/mcp";

describe("apiKeyFromHeaders", () => {
  it("reads the key from Authorization: Bearer", () => {
    assert.equal(apiKeyFromHeaders({ authorization: `Bearer ${KEY}` }), KEY);
    assert.equal(apiKeyFromHeaders({ authorization: `bearer   ${KEY}  ` }), KEY);
  });

  it("takes the two near-misses a developer types from habit", () => {
    assert.equal(apiKeyFromHeaders({ authorization: KEY }), KEY, "the key with no Bearer in front");
    assert.equal(apiKeyFromHeaders({ "x-api-key": KEY }), KEY, "the REST API's own header");
  });

  it("prefers Authorization when both are sent", () => {
    assert.equal(apiKeyFromHeaders({ authorization: `Bearer ${KEY}`, "x-api-key": "other" }), KEY);
  });

  it("finds no key when there is none", () => {
    assert.equal(apiKeyFromHeaders({}), undefined);
    assert.equal(apiKeyFromHeaders({ authorization: "" }), undefined);
    assert.equal(apiKeyFromHeaders({ authorization: "Bearer " }), undefined);
    assert.equal(apiKeyFromHeaders({ authorization: "Basic dXNlcjpwYXNz" }), undefined);
  });
});

describe("resolveApiKey, the one place a lookup gets its key", () => {
  it("returns the caller's key", () => {
    assert.equal(resolveApiKey(KEY), KEY);
    assert.equal(resolveApiKey(`  ${KEY}  `), KEY);
  });

  it("refuses when the caller sent none", () => {
    for (const value of [undefined, "", "   "]) {
      assert.throws(
        () => resolveApiKey(value),
        (err) => err instanceof ApiKeyError && err.reason === "missing",
      );
    }
  });

  it("refuses a value that is not a Jobo API key, such as an unexpanded placeholder", () => {
    for (const value of ["${JOBO_API_KEY}", "$JOBO_API_KEY", "jbe_live_tooshort", "eyJhbGciOiJSUzI1NiJ9.e30.sig"]) {
      assert.throws(
        () => resolveApiKey(value),
        (err) => err instanceof ApiKeyError && err.reason === "malformed",
        value,
      );
    }
  });
});

describe("apiKeyErrorMessage", () => {
  it("says how to add the header and where to create a key", () => {
    const text = apiKeyErrorMessage(new ApiKeyError("missing"), "find_companies", ENDPOINT);
    assert.ok(text.includes("`find_companies`"));
    assert.ok(text.includes("Authorization: Bearer <your key>"));
    assert.ok(text.includes(`claude mcp add --transport http jobo-developer ${ENDPOINT} --header "Authorization: Bearer $JOBO_API_KEY"`));
    assert.ok(text.includes('"headers": { "Authorization": "Bearer ${env:JOBO_API_KEY}" }'));
    assert.ok(text.includes(API_KEYS_URL));
    assert.ok(text.includes("`build_search_request`"), "names the tools that work without a key");
  });

  it("explains a malformed key without repeating it", () => {
    const text = apiKeyErrorMessage(new ApiKeyError("malformed"), "find_locations", ENDPOINT);
    assert.ok(text.includes("is not a Jobo API key"));
    assert.ok(text.includes("unexpanded placeholder"));
    assert.ok(text.includes(API_KEYS_URL));
  });
});
