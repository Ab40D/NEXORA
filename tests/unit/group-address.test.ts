import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatGroupAddress, isValidGroupAddress, parseGroupAddress, rawToThreeLevel, rawToTwoLevel } from "@/lib/knx/group-address";

interface Vectors {
  valid: Array<{ input: string; raw: number; canonical: string; style: string }>;
  invalid: Array<{ input: string; code: string }>;
}

const fixturePath = path.resolve(__dirname, "../fixtures/group-address-vectors.json");
const vectors = JSON.parse(readFileSync(fixturePath, "utf8")) as Vectors;

describe("parseGroupAddress — shared vectors", () => {
  it.each(vectors.valid)("accepts %j", (v) => {
    const r = parseGroupAddress(v.input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.raw).toBe(v.raw);
      expect(r.value.canonical).toBe(v.canonical);
      expect(r.value.style).toBe(v.style);
    }
  });

  it.each(vectors.invalid)("rejects %j", (v) => {
    const r = parseGroupAddress(v.input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(v.code);
      expect(r.error.message.length).toBeGreaterThan(5);
    }
  });
});

describe("group address formatting", () => {
  it("round-trips every raw value through three-level and two-level form", () => {
    for (const raw of [1, 255, 256, 2047, 2048, 2563, 30000, 65535]) {
      const three = parseGroupAddress(rawToThreeLevel(raw));
      const two = parseGroupAddress(rawToTwoLevel(raw));
      expect(three.ok && three.value.raw).toBe(raw);
      expect(two.ok && two.value.raw).toBe(raw);
    }
  });

  it("formats in the requested style", () => {
    expect(formatGroupAddress(2563, "three-level")).toBe("1/2/3");
    expect(formatGroupAddress(2563, "two-level")).toBe("1/515");
    expect(formatGroupAddress(2563, "free")).toBe("2563");
  });

  it("keeps the user's style in display and normalizes leading zeros", () => {
    const r = parseGroupAddress("01/0515");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.display).toBe("1/515");
      expect(r.value.canonical).toBe("1/2/3");
    }
  });

  it("rejects non-string input defensively", () => {
    expect(isValidGroupAddress(undefined as unknown as string)).toBe(false);
    expect(isValidGroupAddress(42 as unknown as string)).toBe(false);
  });
});

describe("contract drift", () => {
  it("bridge test vectors are identical to the web app vectors", () => {
    const bridgeCopy = path.resolve(__dirname, "../../bridge/tests/fixtures/group-address-vectors.json");
    if (!existsSync(bridgeCopy)) return; // bridge not checked out next to the web app
    expect(readFileSync(bridgeCopy, "utf8")).toBe(readFileSync(fixturePath, "utf8"));
  });
});
