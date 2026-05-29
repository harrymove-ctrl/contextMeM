# ContextMeM Marketplace Listing Prep

Submission remains manual. Do not publish, submit, change repo visibility, or create public marketplace entries without explicit human approval.

## Shared Positioning

ContextMeM turns public websites and Walrus Sites into agent-readable context packages with markdown, verified Walrus resources, screenshots, design tokens, AI Query, diffs, and MemWal-ready memory.

Primary persona: DEV users who want a reliable MCP namespace for coding agents.

Primary CTA: generate a context package, publish a hosted MCP namespace, then install it in an agent client.

## Smithery

Name: ContextMeM

Short description: Agent-readable website and Walrus Site context over MCP.

Long description: ContextMeM extracts public websites and Walrus Sites into portable context packages for agents. It resolves Walrus Site targets, verifies resource metadata, packages markdown and artifacts, exposes read-only hosted MCP namespaces, and supports scheduled re-scrape alerts for developer workflows.

Setup:

```json
{
  "contextmem": {
    "url": "https://contextmem-hosted-namespace-mcp.petlofi.workers.dev/mcp?namespace=<namespace>",
    "headers": {
      "Authorization": "Bearer <read-token>"
    }
  }
}
```

## Claude Desktop Directory

Category: Developer Tools

Value prop: Give Claude a verified context bundle for a website or Walrus Site without pasting raw docs.

Install shape:

```json
{
  "mcpServers": {
    "contextmem-<namespace>": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://contextmem-hosted-namespace-mcp.petlofi.workers.dev/mcp?namespace=<namespace>",
        "--header",
        "Authorization: Bearer <read-token>"
      ]
    }
  }
}
```

## Cursor MCP Marketplace

Category: Docs and Knowledge

Short description: Query extracted website and Walrus Site context from Cursor.

Install notes: Use the namespace-specific MCP URL and read token generated in ContextMeM Publish.

Suggested demo flow: open a codebase, connect the ContextMeM MCP namespace, ask Cursor to summarize the target site's API surface, then ask it to implement a small integration using the retrieved context.
