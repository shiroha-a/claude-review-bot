import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/review/prompt.js";
import { REVIEW_GUIDES, TOOL_DEFINITIONS } from "../src/review/tools.js";

describe("buildSystemPrompt", () => {
  it("is byte-stable for a language so the prompt cache prefix is shared", () => {
    expect(buildSystemPrompt("Japanese")).toBe(buildSystemPrompt("Japanese"));
    expect(buildSystemPrompt("Japanese")).not.toBe(buildSystemPrompt("English"));
  });

  it("names every tool and every review guide the model can use", () => {
    const prompt = buildSystemPrompt("Japanese");
    for (const tool of TOOL_DEFINITIONS) expect(prompt).toContain(tool.name);
    for (const guide of REVIEW_GUIDES) expect(prompt).toContain(`"${guide}"`);
  });
});
