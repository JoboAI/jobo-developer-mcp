# Installing the Jobo developer MCP server

For an AI agent setting this server up for a developer. It gives a coding agent six free reference tools for
writing code against the Jobo jobs API: company ids, filter values, places, the filter contract, and a
checked search request. It never searches jobs.

## What you need

A Jobo API key for the three lookup tools (`find_companies`, `find_filter_values`, `find_locations`). The
developer creates one at https://enterprise.jobo.world/api-keys. Ask them for it, or better, ask them to put
it in the `JOBO_API_KEY` environment variable. Never write the key into a file that could be committed.

The other three tools (`list_filters`, `describe_search_filters`, `build_search_request`) need no key, so
the server is useful before the developer has one.

## Option 1: the hosted server (recommended)

Streamable HTTP at `https://dev-mcp.jobo.world/mcp`, with one header:

```json
{
  "mcpServers": {
    "jobo-developer": {
      "url": "https://dev-mcp.jobo.world/mcp",
      "headers": {
        "Authorization": "Bearer <the developer's Jobo API key>"
      }
    }
  }
}
```

If the client expands environment variables in its config, write the variable instead of the key.

## Option 2: local, over stdio

For a client that starts servers as child processes. Needs Node.js 20 or later and version 0.2.0 or later of
the package.

```json
{
  "mcpServers": {
    "jobo-developer": {
      "command": "npx",
      "args": ["-y", "jobo-developer-mcp", "--stdio"],
      "env": {
        "JOBO_API_KEY": "<the developer's Jobo API key>"
      }
    }
  }
}
```

## Check it works

1. List the server's tools. There are six.
2. Call `list_filters` with no arguments. It needs no key and returns the fixed filter vocabularies.
3. With a key, call `find_companies` with `{"q": "stripe"}`. It returns companies with their ids.

If a `find_` tool answers that it needs the key, the header or the variable did not reach the server: the
error text says which one to set. Every tool on this server is free.
