import { z } from "zod";

const csv = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  GITHUB_APP_ID: z.string().min(1),
  // .envでは改行を\nと書くことが多いため、実改行へ戻す
  GITHUB_PRIVATE_KEY: z
    .string()
    .min(1)
    .transform((v) => v.replace(/\\n/g, "\n")),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  CLAUDE_MAX_TOKENS: z.coerce.number().int().positive().default(32000),
  MAX_AGENT_TURNS: z.coerce.number().int().positive().default(25),
  REVIEW_LANGUAGE: z.string().default("Japanese"),
  MAX_DIFF_CHARS: z.coerce.number().int().positive().default(200_000),
  EXCLUDE_GLOBS: z.string().default("").transform(csv),
  MAINTAINER_ASSOCIATIONS: z.string().default("OWNER,MEMBER,COLLABORATOR").transform(csv),
  // z.coerce.booleanは"false"もtrueにするため、文字列で受けて判定する
  AUTO_REVIEW: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  REVIEW_COMMAND: z.string().default("/review"),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parses and validates configuration from environment variables.
 * Throws with a readable message listing every invalid variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}
