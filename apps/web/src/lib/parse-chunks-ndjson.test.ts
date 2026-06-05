import { describe, expect, it } from "vitest";
import { parseChunksNdjson } from "./parse-chunks-ndjson.js";

const valid = JSON.stringify({
  chunkId: "a", routePath: "/", headingPath: ["Home"], heading: "Home",
  text: "hi", contentHash: "h", byteLength: 2, order: 0,
});

describe("parseChunksNdjson", () => {
  it("parses one ContextChunk per non-empty line", () => {
    const out = parseChunksNdjson(`${valid}\n${valid.replace('"a"', '"b"')}\n`);
    expect(out.map((c) => c.chunkId)).toEqual(["a", "b"]);
  });

  it("ignores blank lines and trailing whitespace", () => {
    expect(parseChunksNdjson(`\n  \n${valid}\n\n`)).toHaveLength(1);
  });

  it("skips malformed JSON lines instead of throwing", () => {
    expect(parseChunksNdjson(`{not json\n${valid}`)).toHaveLength(1);
  });

  it("skips lines missing required fields", () => {
    const bad = JSON.stringify({ chunkId: "x" });
    expect(parseChunksNdjson(`${bad}\n${valid}`).map((c) => c.chunkId)).toEqual(["a"]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseChunksNdjson("")).toEqual([]);
  });
});
