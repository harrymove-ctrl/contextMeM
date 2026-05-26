import { describe, expect, it } from "vitest";
import { createHostedContextMemMcpServer, normalizeHostedArtifactPath, type HostedNamespaceStore } from "./hosted.js";

describe("hosted ContextMeM MCP helpers", () => {
  it("blocks hosted artifact path traversal", () => {
    expect(() => normalizeHostedArtifactPath("/context/manifest.json")).not.toThrow();
    expect(() => normalizeHostedArtifactPath("../secret")).toThrow(/begin/);
    expect(() => normalizeHostedArtifactPath("/context/../secret")).toThrow(/traversal/);
  });

  it("creates a hosted namespace MCP server with the compact agent tools", async () => {
    const store: HostedNamespaceStore = {
      async getNamespace(namespace) {
        return {
          namespace,
          target: "https://example.com/",
          visibility: "private",
          versionId: "ver_test",
          artifactCount: 2,
          byteLength: 128,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        };
      },
      async listArtifacts() {
        return [
          {
            path: "/llms.txt",
            contentType: "text/plain; charset=utf-8",
            kind: "text",
            size: 32,
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        ];
      },
      async readArtifact(_namespace, artifactPath) {
        return {
          path: artifactPath,
          contentType: "text/plain; charset=utf-8",
          kind: "text",
          size: 32,
          updatedAt: "2026-01-01T00:00:00.000Z",
          encoding: "utf8",
          content: "ContextMeM Walrus namespace content"
        };
      }
    };

    const server = createHostedContextMemMcpServer({ namespace: "web:example.com", store });

    expect(server).toBeTruthy();
  });
});
