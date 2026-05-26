import { describe, expect, it } from "vitest";
import { buildWsResources } from "./package.js";

describe("Walrus package resources", () => {
  it("uses lowercase content-type for markdown-compatible routes", () => {
    const resources = buildWsResources("/tmp/contextmem");
    expect(resources).toHaveProperty("headers");
    const headers = resources.headers as Record<string, Record<string, string>>;
    expect(headers["/llms.txt"]?.["content-type"]).toBe("text/plain; charset=utf-8");
    expect(headers["/context/manifest.json"]?.["content-type"]).toBe("application/json; charset=utf-8");
    expect(headers["/context/design-system.json"]?.["content-type"]).toBe("application/json; charset=utf-8");
    expect(headers["/context/tokens.css"]?.["content-type"]).toBe("text/css; charset=utf-8");
    expect(headers["/context/screenshots.json"]?.["content-type"]).toBe("application/json; charset=utf-8");
    expect(headers["/context/component-previews.json"]?.["content-type"]).toBe("application/json; charset=utf-8");
  });
});
