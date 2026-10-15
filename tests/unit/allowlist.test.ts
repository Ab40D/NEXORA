import { describe, expect, it } from "vitest";
import { gaAllowed, gaMatchesPattern } from "@/lib/connection/allowlist";

describe("client-side group address allowlist mirror", () => {
  it.each([
    ["0/0/1", "0/0/1", true],
    ["0/0/2", "0/0/1", false],
    ["1/2/30", "1/2/*", true],
    ["0/0/9", "0/0/1-9", true],
    ["0/0/10", "0/0/1-9", false],
    ["31/7/255", "*", true],
    ["1/2/3", "1/2", false],
  ])("%s vs %s → %s", (ga, pattern, expected) => {
    expect(gaMatchesPattern(ga, pattern)).toBe(expected);
  });

  it("normalizes two-level and free-format input before matching", () => {
    expect(gaAllowed("1/515", ["1/2/3"])).toBe(true);
    expect(gaAllowed("2563", ["1/2/*"])).toBe(true);
    expect(gaAllowed("bogus", ["*"])).toBe(false);
    expect(gaAllowed("0/0/1", [])).toBe(false);
  });
});
