import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const REQUIRED = {
  GITHUB_APP_ID: "1",
  GITHUB_PRIVATE_KEY: "-----BEGIN-----\\nabc\\n-----END-----",
  GITHUB_WEBHOOK_SECRET: "s",
};

describe("loadConfig", () => {
  it("disables auto review by default", () => {
    expect(loadConfig({ ...REQUIRED }).AUTO_REVIEW).toBe(false);
  });

  it("parses AUTO_REVIEW as a strict boolean string", () => {
    expect(loadConfig({ ...REQUIRED, AUTO_REVIEW: "true" }).AUTO_REVIEW).toBe(true);
    expect(loadConfig({ ...REQUIRED, AUTO_REVIEW: "false" }).AUTO_REVIEW).toBe(false);
    expect(() => loadConfig({ ...REQUIRED, AUTO_REVIEW: "yes" })).toThrow("AUTO_REVIEW");
  });

  it("splits maintainer associations and restores newlines in the private key", () => {
    const config = loadConfig({ ...REQUIRED, MAINTAINER_ASSOCIATIONS: "OWNER, MEMBER" });
    expect(config.MAINTAINER_ASSOCIATIONS).toEqual(["OWNER", "MEMBER"]);
    expect(config.GITHUB_PRIVATE_KEY).toBe("-----BEGIN-----\nabc\n-----END-----");
  });

  it("listens on 8787 by default", () => {
    expect(loadConfig({ ...REQUIRED }).PORT).toBe(8787);
  });

  it("reads up to 30000 guideline characters by default and accepts 0 to disable", () => {
    expect(loadConfig({ ...REQUIRED }).MAX_GUIDELINE_CHARS).toBe(30_000);
    expect(loadConfig({ ...REQUIRED, MAX_GUIDELINE_CHARS: "0" }).MAX_GUIDELINE_CHARS).toBe(0);
    expect(() => loadConfig({ ...REQUIRED, MAX_GUIDELINE_CHARS: "-1" })).toThrow(
      "MAX_GUIDELINE_CHARS",
    );
  });
});
