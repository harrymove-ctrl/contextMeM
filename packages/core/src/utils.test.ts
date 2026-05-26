import { describe, expect, it } from "vitest";
import { comparePageRoutes, inferMode, inferTargetKind, isUtilityPageRoute, namespaceForTarget, normalizeInputTarget } from "./utils.js";

describe("target utilities", () => {
  it("normalizes domains into https URLs", () => {
    expect(normalizeInputTarget("example.com")).toBe("https://example.com/");
  });

  it("detects Walrus object IDs", () => {
    const id = `0x${"a".repeat(64)}`;
    expect(inferTargetKind(id)).toBe("walrus-object");
    expect(inferMode(id)).toBe("walrus");
  });

  it("treats wal.app portal subdomains as Walrus-native in auto mode", () => {
    expect(inferTargetKind("https://seal-docs.wal.app/")).toBe("walrus-url");
    expect(inferMode("https://seal-docs.wal.app/")).toBe("walrus");
    expect(inferMode("https://seal-docs.wal.app/", "walrus")).toBe("walrus");
  });

  it("creates stable Walrus namespaces", () => {
    const id = `0x${"b".repeat(64)}`;
    expect(namespaceForTarget(id, "walrus", "testnet", id)).toBe(`walrus:testnet:${id}`);
  });

  it("keeps utility routes out of content pages and sorts home first", () => {
    expect(isUtilityPageRoute("/404.html")).toBe(true);
    expect(isUtilityPageRoute("/search")).toBe(true);
    expect(isUtilityPageRoute("/search.html")).toBe(true);
    expect(isUtilityPageRoute("/search/index.html")).toBe(true);
    expect(isUtilityPageRoute("/docs/system-overview/operations.html.html")).toBe(true);
    expect(isUtilityPageRoute("/docs/system-overview/operations.htm/index.html")).toBe(true);
    expect(isUtilityPageRoute("/GettingStarted/index.html")).toBe(false);

    expect(["/GettingStarted/index.html", "/404.html", "/index.html", "/UsingSeal/index.html"].filter((route) => !isUtilityPageRoute(route)).sort(comparePageRoutes)).toEqual([
      "/index.html",
      "/GettingStarted/index.html",
      "/UsingSeal/index.html"
    ]);
  });
});
