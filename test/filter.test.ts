import { describe, expect, it } from "vitest";
import { filterFiles } from "../src/review/filter.js";

describe("filterFiles", () => {
  const opts = { excludeGlobs: [], maxChars: 1000 };

  it("skips lockfiles, removed files, and files without a patch", () => {
    const result = filterFiles(
      [
        { filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
        { filename: "package-lock.json", status: "modified", patch: "x" },
        { filename: "web/pnpm-lock.yaml", status: "modified", patch: "x" },
        { filename: "old.ts", status: "removed", patch: "-x" },
        { filename: "logo.png", status: "added" },
      ],
      opts,
    );
    expect(result.included.map((f) => f.filename)).toEqual(["src/a.ts"]);
    expect(result.skipped).toEqual([
      { filename: "package-lock.json", reason: "excluded" },
      { filename: "web/pnpm-lock.yaml", reason: "excluded" },
      { filename: "old.ts", reason: "removed" },
      { filename: "logo.png", reason: "no-patch" },
    ]);
  });

  it("applies user-provided globs", () => {
    const result = filterFiles(
      [
        { filename: "gen/api.ts", status: "added", patch: "+x" },
        { filename: "src/b.ts", status: "added", patch: "+x" },
      ],
      { excludeGlobs: ["gen/**"], maxChars: 1000 },
    );
    expect(result.included.map((f) => f.filename)).toEqual(["src/b.ts"]);
    expect(result.skipped).toEqual([{ filename: "gen/api.ts", reason: "excluded" }]);
  });

  it("reports files that exceed the cumulative size limit instead of truncating them", () => {
    const result = filterFiles(
      [
        { filename: "a.ts", status: "added", patch: "x".repeat(6) },
        { filename: "b.ts", status: "added", patch: "x".repeat(5) },
        { filename: "c.ts", status: "added", patch: "x".repeat(4) },
      ],
      { excludeGlobs: [], maxChars: 10 },
    );
    // b.tsは入らないが、それより小さいc.tsは入る
    expect(result.included.map((f) => f.filename)).toEqual(["a.ts", "c.ts"]);
    expect(result.skipped).toEqual([{ filename: "b.ts", reason: "size-limit" }]);
  });

  it("accepts a file whose patch exactly fills the limit", () => {
    const result = filterFiles([{ filename: "a.ts", status: "added", patch: "x".repeat(10) }], {
      excludeGlobs: [],
      maxChars: 10,
    });
    expect(result.included).toHaveLength(1);
  });
});
