import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Local mode end to end: the built server started with `--stdio`, driven over
// its stdin and stdout the way a client or a directory's build check drives it,
// with a local HTTP server standing in for the Jobo API.

const entry = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const KEY = `jbe_test_${"a".repeat(21)}_${"b".repeat(43)}`;
const REVOKED_KEY = `jbe_live_${"r".repeat(21)}_${"v".repeat(43)}`;

interface Reply {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** One server process and the JSON-RPC conversation with it. */
class Session {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly waiting = new Map<number, (reply: Reply) => void>();
  private nextId = 1;
  /** Every line the server wrote to stdout, to prove none of it is chatter. */
  readonly stdoutLines: string[] = [];
  stderr = "";

  constructor(env: Record<string, string | undefined>) {
    this.child = spawn(process.execPath, [entry, "--stdio"], {
      env: { ...process.env, NODE_ENV: "production", JOBO_API_KEY: undefined, ...env } as NodeJS.ProcessEnv,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        this.stdoutLines.push(line);
        const reply = JSON.parse(line) as Reply;
        if (reply.id !== undefined) this.waiting.get(reply.id)?.(reply);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => (this.stderr += chunk));
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method}; stderr: ${this.stderr}`)), 20_000);
      this.waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async open(): Promise<Reply> {
    const reply = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-test", version: "0" },
    });
    this.notify("notifications/initialized");
    return reply;
  }

  call(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
    return this.request("tools/call", { name, arguments: args });
  }

  close(): void {
    this.child.kill();
  }
}

const textOf = (reply: Reply): string =>
  ((reply.result?.content as Array<{ text: string }> | undefined) ?? []).map((part) => part.text).join("\n");

describe("local mode over stdio", () => {
  let api: Server;
  let apiUrl: string;
  let seen: Array<{ method: string; path: string; headers: IncomingMessage["headers"] }> = [];
  const sessions: Session[] = [];

  const start = (env: Record<string, string | undefined>): Session => {
    const session = new Session({ JOBO_API_URL: apiUrl, ...env });
    sessions.push(session);
    return session;
  };

  before(async () => {
    api = createServer((req, res) => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers });
      req.resume();
      req.on("end", () => {
        if (req.headers["x-api-key"] !== KEY) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid or expired API key" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
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
          }),
        );
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  after(() => {
    for (const session of sessions) session.close();
    api.close();
  });

  it("starts without a key and lists every tool, which is all a directory's build check needs", async () => {
    const session = start({});

    const opened = await session.open();
    const listed = await session.request("tools/list");

    assert.equal((opened.result?.serverInfo as { name: string }).name, "jobo-developer");
    const tools = listed.result?.tools as Array<{ name: string; description: string }>;
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["build_search_request", "describe_search_filters", "find_companies", "find_filter_values", "find_locations", "list_filters"],
    );
    // The hosted server takes the key as a header. Here it is an environment variable, and the tools say so.
    const keyed = tools.find((tool) => tool.name === "find_companies")!;
    assert.match(keyed.description, /JOBO_API_KEY/);
    assert.doesNotMatch(keyed.description, /Authorization: Bearer/);
    assert.match(String(opened.result?.instructions), /`JOBO_API_KEY` environment variable this server was started with/);
  });

  it("answers the three contract tools with no key and no request", async () => {
    seen = [];
    const session = start({});
    await session.open();

    for (const tool of ["list_filters", "describe_search_filters"]) {
      const reply = await session.call(tool);
      assert.notEqual(reply.result?.isError, true, `${tool}: ${textOf(reply)}`);
    }
    const built = await session.call("build_search_request", { q: "nurse" });
    assert.notEqual(built.result?.isError, true, textOf(built));

    assert.equal(seen.length, 0, "the contract tools touch no upstream");
  });

  it("answers a lookup without a key by naming the variable to set, and calls nothing", async () => {
    seen = [];
    const session = start({});
    await session.open();

    const reply = await session.call("find_companies", { q: "stripe" });

    assert.equal(reply.result?.isError, true);
    assert.match(textOf(reply), /started without one/);
    assert.match(textOf(reply), /"env": \{ "JOBO_API_KEY": "<your key>" \}/);
    assert.doesNotMatch(textOf(reply), /Authorization: Bearer/, "a header is not how a local server takes the key");
    assert.equal(seen.length, 0, "no request is made without a key");
  });

  it("runs a lookup on the key from the environment", async () => {
    seen = [];
    const session = start({ JOBO_API_KEY: KEY });
    await session.open();

    const reply = await session.call("find_companies", { q: "stripe", limit: 3 });

    assert.notEqual(reply.result?.isError, true, textOf(reply));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/api/connectors/companies/suggest?q=stripe&limit=3");
    assert.equal(seen[0].headers["x-api-key"], KEY);
    assert.equal(seen[0].headers.authorization, undefined);
    assert.equal(seen[0].headers["x-jobo-client"], "dev-mcp");
    assert.match(String(seen[0].headers["user-agent"]), /^jobo-developer-mcp\/\d+\.\d+\.\d+ \(stdio\)$/);
    assert.match(textOf(reply), /Stripe/);
  });

  it("refuses an unexpanded placeholder before sending it anywhere", async () => {
    seen = [];
    const session = start({ JOBO_API_KEY: "${JOBO_API_KEY}" });
    await session.open();

    const reply = await session.call("find_companies", { q: "stripe" });

    assert.equal(reply.result?.isError, true);
    assert.match(textOf(reply), /value of the JOBO_API_KEY environment variable is not a Jobo API key/);
    assert.equal(seen.length, 0);
  });

  it("explains a rejected key in terms of the variable, not of a header", async () => {
    const session = start({ JOBO_API_KEY: REVOKED_KEY });
    await session.open();

    const reply = await session.call("find_companies", { q: "stripe" });

    assert.equal(reply.result?.isError, true);
    assert.match(textOf(reply), /rejected the API key/);
    assert.match(textOf(reply), /`JOBO_API_KEY` environment variable this server was started with/);
    assert.doesNotMatch(textOf(reply), /Authorization: Bearer/);
  });

  it("writes nothing to stdout but protocol messages", async () => {
    const session = start({ JOBO_API_KEY: KEY });
    await session.open();
    await session.request("tools/list");

    for (const line of session.stdoutLines) {
      assert.equal((JSON.parse(line) as { jsonrpc?: string }).jsonrpc, "2.0", `not a protocol message: ${line.slice(0, 80)}`);
    }
    assert.match(session.stderr, /on stdio/, "the start-up line goes to stderr");
  });
});
