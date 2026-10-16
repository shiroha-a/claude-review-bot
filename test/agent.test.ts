import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  BUDGET_NOTICE,
  runReviewAgent,
  type AgentDeps,
  type ClaudeReviewOptions,
  type ReviewOutput,
} from "../src/review/claude.js";

const OPTIONS: ClaudeReviewOptions = {
  model: "claude-opus-5-5",
  effort: "high",
  maxTokens: 1000,
  maxTurns: 2,
  system: "sys",
  user: "review this",
};

const OUTPUT: ReviewOutput = {
  overview: "o",
  verdict: "mergeable",
  verdict_reason: "r",
  summary: "s",
  testing: "",
  design: "",
  comments: [],
};

type Msg = Awaited<ReturnType<AgentDeps["send"]>>;
type SendParams = Parameters<AgentDeps["send"]>[0];

function message(partial: Partial<Msg>): Msg {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {} as Msg["usage"],
    ...partial,
  } as Msg;
}

function toolTurn(...calls: { id: string; name: string; input: unknown }[]): Msg {
  return message({
    stop_reason: "tool_use",
    content: calls.map((c) => ({ type: "tool_use", ...c })) as Msg["content"],
  });
}

const final = (output: ReviewOutput = OUTPUT) =>
  message({
    content: [{ type: "text", text: JSON.stringify(output) }] as Msg["content"],
    parsed_output: output,
  });

function setup(responses: (Msg | Error)[]) {
  // 送信時点のmessagesを記録する(配列は後で追記されるため複製して保存)
  const sent: SendParams[] = [];
  const send = vi.fn(async (params: SendParams) => {
    sent.push({ ...params, messages: JSON.parse(JSON.stringify(params.messages)) });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const executeTool = vi.fn(async (name: string, input: unknown) => ({
    content: `${name}:${JSON.stringify(input)}`,
    isError: name === "bad",
  }));
  return { deps: { send, executeTool } as AgentDeps, send, executeTool, sent };
}

describe("runReviewAgent", () => {
  it("returns the structured review when the model answers without tools", async () => {
    const { deps, sent } = setup([final()]);
    const result = await runReviewAgent(deps, OPTIONS);
    expect(result).toEqual({
      kind: "ok",
      output: OUTPUT,
      model: "claude-opus-5-5",
      stats: { turns: 0, toolCalls: 0 },
    });
    expect(sent[0]).toMatchObject({
      model: "claude-opus-5-5",
      system: "sys",
      tool_choice: { type: "auto" },
      cache_control: { type: "ephemeral" },
      fallbacks: "default",
      messages: [{ role: "user", content: "review this" }],
    });
    expect(sent[0]!.output_config?.effort).toBe("high");
  });

  it("executes every tool call of a turn and returns all results in one user message", async () => {
    const { deps, executeTool, sent } = setup([
      toolTurn(
        { id: "t1", name: "read_file", input: { path: "a.ts" } },
        { id: "t2", name: "bad", input: {} },
      ),
      final(),
    ]);
    const result = await runReviewAgent(deps, OPTIONS);

    expect(executeTool).toHaveBeenCalledTimes(2);
    const followUp = sent[1]!.messages;
    expect(followUp).toHaveLength(3);
    expect(followUp[1]!.role).toBe("assistant");
    expect(followUp[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: 'read_file:{"path":"a.ts"}',
          is_error: false,
        },
        { type: "tool_result", tool_use_id: "t2", content: "bad:{}", is_error: true },
      ],
    });
    expect(result).toMatchObject({ kind: "ok", stats: { turns: 1, toolCalls: 2 } });
  });

  it("only appends to the history so earlier turns stay byte-identical", async () => {
    const { deps, sent } = setup([
      toolTurn({ id: "t1", name: "grep", input: { pattern: "x" } }),
      toolTurn({ id: "t2", name: "grep", input: { pattern: "y" } }),
      final(),
    ]);
    await runReviewAgent(deps, { ...OPTIONS, maxTurns: 10 });
    expect(sent[2]!.messages.slice(0, sent[1]!.messages.length)).toEqual(sent[1]!.messages);
    expect(sent.map((s) => s.system)).toEqual(["sys", "sys", "sys"]);
    expect(sent[2]!.tools).toEqual(sent[0]!.tools);
  });

  it("stops offering tools after the turn budget and tells the model why", async () => {
    const { deps, sent } = setup([
      toolTurn({ id: "t1", name: "grep", input: { pattern: "a" } }),
      toolTurn({ id: "t2", name: "grep", input: { pattern: "b" } }),
      final(),
    ]);
    const result = await runReviewAgent(deps, OPTIONS);

    expect(sent.map((s) => s.tool_choice)).toEqual([
      { type: "auto" },
      { type: "auto" },
      { type: "none" },
    ]);
    const last = sent[2]!.messages.at(-1)!;
    expect(last.content).toContainEqual({ type: "text", text: BUDGET_NOTICE });
    // 予算に達する前のターンには通知を入れない
    expect(JSON.stringify(sent[1]!.messages)).not.toContain(BUDGET_NOTICE);
    expect(result).toMatchObject({ kind: "ok", stats: { turns: 2, toolCalls: 2 } });
  });

  it("reports a refusal without running tools", async () => {
    const { deps, executeTool } = setup([
      message({
        stop_reason: "refusal",
        stop_details: {
          type: "refusal",
          category: "cyber",
          explanation: null,
        } as Msg["stop_details"],
        content: [{ type: "tool_use", id: "t", name: "grep", input: {} }] as Msg["content"],
      }),
    ]);
    expect(await runReviewAgent(deps, OPTIONS)).toEqual({ kind: "refused", category: "cyber" });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("throws on max_tokens instead of running a truncated tool call", async () => {
    const { deps, executeTool } = setup([
      message({
        stop_reason: "max_tokens",
        content: [
          { type: "tool_use", id: "t", name: "grep", input: { pattern: "par" } },
        ] as Msg["content"],
      }),
    ]);
    await expect(runReviewAgent(deps, OPTIONS)).rejects.toThrow("max_tokens");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("throws when the final answer does not match the schema", async () => {
    const { deps } = setup([
      message({ content: [{ type: "text", text: "hi" }] as Msg["content"], parsed_output: null }),
    ]);
    await expect(runReviewAgent(deps, OPTIONS)).rejects.toThrow("schema");
  });

  it("retries a turn whose tool input was not valid JSON, up to twice", async () => {
    const ok = setup([new Error("bad json"), final()]);
    await expect(runReviewAgent(ok.deps, OPTIONS)).resolves.toMatchObject({ kind: "ok" });
    expect(ok.send).toHaveBeenCalledTimes(2);

    const failing = setup([
      new Error("bad json 1"),
      new Error("bad json 2"),
      new Error("bad json 3"),
    ]);
    await expect(runReviewAgent(failing.deps, OPTIONS)).rejects.toThrow("bad json 3");
    expect(failing.send).toHaveBeenCalledTimes(3);
  });

  it("counts only consecutive JSON failures toward the retry limit", async () => {
    const { deps } = setup([
      new Error("bad 1"),
      new Error("bad 2"),
      toolTurn({ id: "t1", name: "grep", input: { pattern: "a" } }),
      new Error("bad 3"),
      new Error("bad 4"),
      final(),
    ]);
    await expect(runReviewAgent(deps, { ...OPTIONS, maxTurns: 10 })).resolves.toMatchObject({
      kind: "ok",
    });
  });

  it("does not retry API errors", async () => {
    const apiError = new Anthropic.APIError(500, undefined, "server error", new Headers());
    const { deps, send } = setup([apiError, final()]);
    await expect(runReviewAgent(deps, OPTIONS)).rejects.toBe(apiError);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
