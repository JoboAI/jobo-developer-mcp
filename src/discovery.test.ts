import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SERVER_CARD_MEDIA_TYPE, SERVER_CARD_SCHEMA, buildAiCatalog, buildServerCard, etagMatches, serverCardUrl } from "./discovery.js";

// The documents themselves. `server.test.ts` checks them as served, against
// `server.json` and against what the live server says about itself.

describe("buildServerCard", () => {
  const input = {
    name: "com.example/weather",
    title: "Weather",
    version: "1.2.3",
    description: "Forecasts.",
    websiteUrl: "https://example.com",
    icons: [{ src: "https://example.com/icon.png", mimeType: "image/png", sizes: ["64x64"] }],
    endpointUrl: "https://example.com/mcp",
    protocolVersions: ["2026-07-28", "2025-06-18"],
  };

  it("says who the server is and where to connect, with no tools and no auth", () => {
    assert.deepEqual(buildServerCard(input), {
      $schema: SERVER_CARD_SCHEMA,
      name: "com.example/weather",
      version: "1.2.3",
      description: "Forecasts.",
      title: "Weather",
      websiteUrl: "https://example.com",
      icons: input.icons,
      remotes: [{ type: "streamable-http", url: "https://example.com/mcp", supportedProtocolVersions: ["2026-07-28", "2025-06-18"] }],
    });
  });

  it("names the repository only when there is a public one", () => {
    assert.equal("repository" in buildServerCard(input), false);
    assert.deepEqual(buildServerCard({ ...input, repositoryUrl: "https://github.com/example/weather" }).repository, {
      url: "https://github.com/example/weather",
      source: "github",
    });
  });

  it("puts the card under the endpoint it describes", () => {
    assert.equal(serverCardUrl("https://example.com/mcp"), "https://example.com/mcp/server-card");
  });
});

describe("etagMatches", () => {
  it("matches the tag in any of the forms a client may send", () => {
    assert.equal(etagMatches('"abc"', '"abc"'), true);
    assert.equal(etagMatches('W/"abc"', '"abc"'), true);
    assert.equal(etagMatches('"old", "abc"', '"abc"'), true);
    assert.equal(etagMatches("*", '"abc"'), true);
    assert.equal(etagMatches('"old"', '"abc"'), false);
    assert.equal(etagMatches(undefined, '"abc"'), false);
  });
});

describe("buildAiCatalog", () => {
  it("derives the URN from the registry name", () => {
    assert.deepEqual(buildAiCatalog("com.example/weather", "https://example.com/mcp/server-card"), {
      specVersion: "1.0",
      entries: [
        {
          identifier: "urn:air:example.com:mcp:weather",
          type: SERVER_CARD_MEDIA_TYPE,
          url: "https://example.com/mcp/server-card",
        },
      ],
    });
  });
});
