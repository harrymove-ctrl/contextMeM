import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type HostedNamespaceVisibility = "private" | "public";

export type HostedNamespaceSummary = {
  namespace: string;
  target: string;
  visibility: HostedNamespaceVisibility;
  ownerId?: string;
  displayName?: string;
  description?: string;
  tags?: string[];
  sourceType?: "web" | "walrus" | "upload" | "extract" | "import";
  directoryEnabled?: boolean;
  versionId: string;
  sourceRunId?: string;
  artifactCount: number;
  byteLength: number;
  createdAt: string;
  updatedAt: string;
};

export type HostedArtifactRecord = {
  path: string;
  contentType: string;
  kind: "json" | "markdown" | "html" | "css" | "text" | "binary" | "other";
  size: number;
  sha256?: string;
  updatedAt: string;
};

export type HostedArtifactContent = HostedArtifactRecord & {
  encoding: "utf8" | "base64";
  content: string;
};

export type HostedSearchResult = {
  path: string;
  title?: string;
  contentType: string;
  snippet: string;
  score: number;
};

export type HostedNamespaceStore = {
  getNamespace(namespace: string): Promise<HostedNamespaceSummary | undefined>;
  listArtifacts(namespace: string): Promise<HostedArtifactRecord[]>;
  readArtifact(namespace: string, artifactPath: string): Promise<HostedArtifactContent | undefined>;
  searchContext?(namespace: string, query: string, limit: number): Promise<HostedSearchResult[]>;
  recallMemory?(namespace: string, query: string): Promise<unknown>;
};

export type HostedNamespaceAuthorization =
  | { ok: true; summary: HostedNamespaceSummary }
  | { ok: false; status: number; message: string };

export type HostedMcpServerOptions = {
  namespace?: string;
  store: HostedNamespaceStore;
  authorizeNamespace?: (namespace: string, accessToken?: string) => Promise<HostedNamespaceAuthorization>;
};

export function createHostedContextMemMcpServer(options: HostedMcpServerOptions): McpServer {
  const server = new McpServer({
    name: options.namespace ? "contextmcp-namespace" : "contextmcp-gateway",
    version: "0.1.0"
  });
  const store = options.store;
  const namespaceInputSchema: Record<string, z.ZodTypeAny> = options.namespace
    ? {}
    : {
        namespace: z.string().min(1).describe("ContextMCP namespace to use, for example team.project or walrus:mainnet:0x..."),
        accessToken: z.string().optional().describe("Optional namespace read token. Prefer MCP headers for private namespaces.")
      };

  registerToolAliases(
    server,
    ["context_info", "contextmem_namespace_info"],
    {
      title: "Context namespace info",
      description: options.namespace ? "Return metadata for this ContextMCP namespace." : "Return metadata for a ContextMCP namespace.",
      inputSchema: namespaceInputSchema
    },
    async (args) => {
      const { namespace, summary } = await resolveNamespace(options, args);
      return textResult(summary);
    }
  );

  registerToolAliases(
    server,
    ["list_context", "contextmem_list_artifacts"],
    {
      title: "List context artifacts",
      description: "List files available in a namespace, including llms.txt, manifest, structure, pages, and design exports.",
      inputSchema: {
        ...namespaceInputSchema,
        limit: z.number().int().min(1).max(500).default(100)
      }
    },
    async (args) => {
      const { namespace } = await resolveNamespace(options, args);
      const limit = numericArg(args.limit, 100);
      const artifacts = await store.listArtifacts(namespace);
      return textResult({
        namespace,
        count: artifacts.length,
        artifacts: artifacts.slice(0, limit)
      });
    }
  );

  registerToolAliases(
    server,
    ["read_context", "contextmem_read_artifact"],
    {
      title: "Read context artifact",
      description: "Read one artifact from a namespace. Use paths such as /llms.txt, /context/manifest.json, or /context/site-structure.json.",
      inputSchema: {
        ...namespaceInputSchema,
        path: z.string().describe("Artifact path beginning with /, for example /llms.txt")
      }
    },
    async (args) => {
      const { namespace } = await resolveNamespace(options, args);
      const artifactPath = normalizeHostedArtifactPath(stringArg(args.path));
      const artifact = await store.readArtifact(namespace, artifactPath);
      if (!artifact) return errorResult(`Artifact not found: ${artifactPath}`);
      return textResult({
        namespace,
        artifact
      });
    }
  );

  registerToolAliases(
    server,
    ["search_context", "contextmem_search_context"],
    {
      title: "Search context",
      description: "Search text-like artifacts in a namespace and return short source-grounded snippets.",
      inputSchema: {
        ...namespaceInputSchema,
        query: z.string().min(1).describe("Search text"),
        limit: z.number().int().min(1).max(25).default(8)
      }
    },
    async (args) => {
      const { namespace } = await resolveNamespace(options, args);
      const query = stringArg(args.query);
      const limit = numericArg(args.limit, 8);
      const results = store.searchContext ? await store.searchContext(namespace, query, limit) : await searchHostedArtifacts(store, namespace, query, limit);
      return textResult({
        namespace,
        query,
        results
      });
    }
  );

  if (store.recallMemory) {
    registerToolAliases(
      server,
      ["recall_memory", "contextmem_recall_memory"],
      {
        title: "Recall memory",
        description: "Recall MemWal memory for a namespace when MemWal credentials are configured for this MCP request.",
        inputSchema: {
          ...namespaceInputSchema,
          query: z.string().min(1).describe("Memory recall question")
        }
      },
      async (args) => {
        const { namespace } = await resolveNamespace(options, args);
        const query = stringArg(args.query);
        const result = await store.recallMemory!(namespace, query);
        return textResult({
          namespace,
          result
        });
      }
    );
  }

  registerToolAliases(
    server,
    ["get_context_bundle", "contextmem_get_context_bundle"],
    {
      title: "Get context bundle",
      description: "Return namespace metadata, top search hits, selected artifact excerpts, and MemWal recall when user MemWal headers are available.",
      inputSchema: {
        ...namespaceInputSchema,
        query: z.string().min(1).describe("Question or task the agent needs context for"),
        paths: z.array(z.string()).max(8).optional().describe("Optional artifact paths to include"),
        limit: z.number().int().min(1).max(12).default(5)
      }
    },
    async (args) => {
      const { namespace, summary } = await resolveNamespace(options, args);
      const query = stringArg(args.query);
      const limit = numericArg(args.limit, 5);
      const searchResults = store.searchContext ? await store.searchContext(namespace, query, limit) : await searchHostedArtifacts(store, namespace, query, limit);
      const paths = Array.isArray(args.paths) && args.paths.length ? args.paths.filter((path): path is string => typeof path === "string") : searchResults.map((result) => result.path);
      const excerpts = await readArtifactExcerpts(store, namespace, paths, 2200);
      const memory = store.recallMemory
        ? {
            available: true,
            result: await store.recallMemory(namespace, query)
          }
        : {
            available: false,
            reason: "MemWal headers were not provided for this MCP request."
          };
      return textResult({
        namespace,
        query,
        summary,
        searchResults,
        excerpts,
        memory
      });
    }
  );

  if (options.namespace) {
    registerCoreResource(server, store, options.namespace, "contextmem_llms_txt", "/llms.txt", "text/plain; charset=utf-8", "Agent entrypoint for the namespace.");
    registerCoreResource(server, store, options.namespace, "contextmem_manifest", "/context/manifest.json", "application/json; charset=utf-8", "Full ContextMeM package manifest.");
    registerCoreResource(server, store, options.namespace, "contextmem_site_structure", "/context/site-structure.json", "application/json; charset=utf-8", "Grouped website structure for agents.");
  }

  return server;
}

function registerToolAliases(
  server: McpServer,
  names: string[],
  config: {
    title: string;
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
  },
  handler: (args: Record<string, unknown>) => Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>>
): void {
  for (const name of names) {
    server.registerTool(name, config, (args) => handler(args as Record<string, unknown>));
  }
}

async function resolveNamespace(options: HostedMcpServerOptions, args: Record<string, unknown>): Promise<{ namespace: string; summary: HostedNamespaceSummary }> {
  const namespace = options.namespace ?? stringArg(args.namespace);
  const accessToken = typeof args.accessToken === "string" && args.accessToken.trim() ? args.accessToken.trim() : undefined;
  if (options.authorizeNamespace) {
    const auth = await options.authorizeNamespace(namespace, accessToken);
    if (!auth.ok) throw new Error(auth.message);
    return { namespace, summary: auth.summary };
  }
  return { namespace, summary: await requireNamespace(options.store, namespace) };
}

function stringArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("A non-empty string argument is required.");
  return value.trim();
}

function numericArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeHostedArtifactPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) throw new Error("Artifact path must begin with /.");
  if (trimmed.includes("\0")) throw new Error("Artifact path is invalid.");
  if (trimmed.length > 512) throw new Error("Artifact path is too long.");
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) throw new Error("Artifact path cannot contain traversal segments.");
  return trimmed.replace(/\/{2,}/g, "/");
}

export function inferHostedArtifactKind(pathname: string, contentType: string): HostedArtifactRecord["kind"] {
  if (/json/i.test(contentType) || /\.json$/i.test(pathname)) return "json";
  if (/markdown/i.test(contentType) || /\.md$/i.test(pathname)) return "markdown";
  if (/html/i.test(contentType) || /\.html?$/i.test(pathname)) return "html";
  if (/css/i.test(contentType) || /\.css$/i.test(pathname)) return "css";
  if (/^text\//i.test(contentType) || /\.(txt|log)$/i.test(pathname)) return "text";
  if (/octet-stream/i.test(contentType)) return "binary";
  return "other";
}

export function isHostedTextArtifact(record: Pick<HostedArtifactRecord, "kind" | "contentType">): boolean {
  return ["json", "markdown", "html", "css", "text"].includes(record.kind) || /^text\//i.test(record.contentType) || /json|xml|javascript|css|html|markdown/i.test(record.contentType);
}

async function requireNamespace(store: HostedNamespaceStore, namespace: string): Promise<HostedNamespaceSummary> {
  const summary = await store.getNamespace(namespace);
  if (!summary) throw new Error(`ContextMeM namespace not found: ${namespace}`);
  return summary;
}

async function searchHostedArtifacts(store: HostedNamespaceStore, namespace: string, query: string, limit: number): Promise<HostedSearchResult[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  const artifacts = (await store.listArtifacts(namespace)).filter(isHostedTextArtifact);
  const matches: HostedSearchResult[] = [];

  for (const artifact of artifacts) {
    const content = await store.readArtifact(namespace, artifact.path);
    if (!content || content.encoding !== "utf8") continue;
    const haystack = content.content.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
    if (!score) continue;
    matches.push({
      path: artifact.path,
      title: titleForArtifact(artifact.path, content.content),
      contentType: artifact.contentType,
      snippet: snippetForMatch(content.content, terms),
      score
    });
  }

  return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

async function readArtifactExcerpts(store: HostedNamespaceStore, namespace: string, paths: string[], maxChars: number): Promise<Array<{ path: string; contentType: string; excerpt: string }>> {
  const uniquePaths = [...new Set(paths)].slice(0, 8);
  const excerpts: Array<{ path: string; contentType: string; excerpt: string }> = [];
  for (const path of uniquePaths) {
    const artifactPath = normalizeHostedArtifactPath(path);
    const artifact = await store.readArtifact(namespace, artifactPath);
    if (!artifact || artifact.encoding !== "utf8") continue;
    excerpts.push({
      path: artifact.path,
      contentType: artifact.contentType,
      excerpt: artifact.content.slice(0, maxChars)
    });
  }
  return excerpts;
}

function registerCoreResource(server: McpServer, store: HostedNamespaceStore, namespace: string, name: string, artifactPath: string, mimeType: string, description: string): void {
  const uri = `contextmem://namespace/${encodeURIComponent(namespace)}${artifactPath}`;
  server.registerResource(name, uri, { mimeType, description }, async () => {
    const artifact = await store.readArtifact(namespace, artifactPath);
    if (!artifact) {
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: `Artifact not found: ${artifactPath}`
          }
        ]
      };
    }
    return {
      contents: [
        artifact.encoding === "utf8"
          ? {
              uri,
              mimeType: artifact.contentType,
              text: artifact.content
            }
          : {
              uri,
              mimeType: artifact.contentType,
              blob: artifact.content
            }
      ]
    };
  });
}

function titleForArtifact(pathname: string, content: string): string | undefined {
  if (pathname.endsWith(".md")) {
    const heading = /^#\s+(.+)$/m.exec(content);
    if (heading?.[1]) return heading[1].trim();
  }
  if (pathname.endsWith(".json")) return pathname.split("/").pop();
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(content);
  return title?.[1]?.trim();
}

function snippetForMatch(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  const firstIndex = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstIndex - 180);
  const end = Math.min(content.length, firstIndex + 420);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

function errorResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: message
      }
    ],
    isError: true
  };
}
