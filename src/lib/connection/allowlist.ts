/**
 * Client-side mirror of the bridge's group address allowlist, used only for
 * early feedback in the wizard. The bridge enforces the allowlist itself.
 *
 * Pattern grammar (three-level): "*" | "main/middle/sub" where each segment is
 * a number, "*" or a range "a-b". Example: "1/2/*", "0/0/1-20", "*".
 */
import { parseGroupAddress } from "@/lib/knx/group-address";

function segmentMatches(pattern: string, value: number): boolean {
  if (pattern === "*") return true;
  const range = /^(\d{1,3})-(\d{1,3})$/.exec(pattern);
  if (range) return value >= Number(range[1]) && value <= Number(range[2]);
  return /^\d{1,3}$/.test(pattern) && Number(pattern) === value;
}

export function gaMatchesPattern(canonical: string, pattern: string): boolean {
  const p = pattern.trim();
  if (p === "*") return true;
  const parts = p.split("/");
  const ga = canonical.split("/").map(Number);
  if (parts.length !== 3 || ga.length !== 3) return false;
  return parts.every((seg, i) => segmentMatches(seg, ga[i]!));
}

export function gaAllowed(input: string, patterns: string[]): boolean {
  const parsed = parseGroupAddress(input);
  if (!parsed.ok) return false;
  return patterns.some((p) => gaMatchesPattern(parsed.value.canonical, p));
}
