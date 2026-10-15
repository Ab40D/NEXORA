/**
 * KNX group address parsing/validation.
 *
 * A KNX group address is a 16-bit value. ETS shows it in one of three styles:
 *   - three-level  main/middle/sub   main 0–31, middle 0–7, sub 0–255
 *   - two-level    main/sub          main 0–31, sub 0–2047
 *   - free         integer           1–65535
 *
 * 0/0/0 (raw 0) is the broadcast address and is rejected.
 *
 * IMPORTANT: syntax validation only proves the string is a well-formed address.
 * It does NOT prove that the address exists in the installation, that any
 * actuator listens to it, or that it controls a light.
 */

export type GroupAddressStyle = "three-level" | "two-level" | "free";

export interface ParsedGroupAddress {
  /** 16-bit raw value, 1..65535 */
  raw: number;
  /** style the user typed */
  style: GroupAddressStyle;
  /** canonical three-level representation, e.g. "0/0/1" (used on the wire) */
  canonical: string;
  /** normalized representation in the user's style (leading zeros removed) */
  display: string;
}

export type GroupAddressErrorCode = "empty" | "format" | "range" | "reserved";

export interface GroupAddressError {
  code: GroupAddressErrorCode;
  message: string;
}

export type GroupAddressResult =
  | { ok: true; value: ParsedGroupAddress }
  | { ok: false; error: GroupAddressError };

const MAX_INPUT_LENGTH = 16;
const THREE_LEVEL = /^(\d{1,2})\/(\d{1,2})\/(\d{1,3})$/;
const TWO_LEVEL = /^(\d{1,2})\/(\d{1,4})$/;
const FREE = /^\d{1,5}$/;

function fail(code: GroupAddressErrorCode, message: string): GroupAddressResult {
  return { ok: false, error: { code, message } };
}

export function rawToThreeLevel(raw: number): string {
  return `${(raw >> 11) & 0x1f}/${(raw >> 8) & 0x07}/${raw & 0xff}`;
}

export function rawToTwoLevel(raw: number): string {
  return `${(raw >> 11) & 0x1f}/${raw & 0x7ff}`;
}

export function formatGroupAddress(raw: number, style: GroupAddressStyle = "three-level"): string {
  if (style === "two-level") return rawToTwoLevel(raw);
  if (style === "free") return String(raw);
  return rawToThreeLevel(raw);
}

export function parseGroupAddress(input: string): GroupAddressResult {
  if (typeof input !== "string") return fail("format", "Group address must be text.");
  const value = input.trim();
  if (value.length === 0) return fail("empty", "Enter a group address, e.g. 0/0/1.");
  if (value.length > MAX_INPUT_LENGTH) return fail("format", "Group address is too long.");

  let raw: number;
  let style: GroupAddressStyle;

  const three = THREE_LEVEL.exec(value);
  const two = three ? null : TWO_LEVEL.exec(value);
  const free = three || two ? null : FREE.exec(value);

  if (three) {
    const main = Number(three[1]);
    const middle = Number(three[2]);
    const sub = Number(three[3]);
    if (main > 31) return fail("range", "Main group must be between 0 and 31.");
    if (middle > 7) return fail("range", "Middle group must be between 0 and 7.");
    if (sub > 255) return fail("range", "Sub group must be between 0 and 255.");
    raw = (main << 11) | (middle << 8) | sub;
    style = "three-level";
  } else if (two) {
    const main = Number(two[1]);
    const sub = Number(two[2]);
    if (main > 31) return fail("range", "Main group must be between 0 and 31.");
    if (sub > 2047) return fail("range", "Sub group must be between 0 and 2047 in two-level format.");
    raw = (main << 11) | sub;
    style = "two-level";
  } else if (free) {
    raw = Number(value);
    if (raw > 65535) return fail("range", "Free-format group address must be between 1 and 65535.");
    style = "free";
  } else {
    return fail(
      "format",
      "Use the KNX format main/middle/sub (e.g. 1/2/3), main/sub (e.g. 1/515) or a number 1–65535.",
    );
  }

  if (raw === 0) {
    return fail("reserved", "0/0/0 is the KNX broadcast address and cannot be used for a light.");
  }

  return {
    ok: true,
    value: {
      raw,
      style,
      canonical: rawToThreeLevel(raw),
      display: formatGroupAddress(raw, style),
    },
  };
}

export function isValidGroupAddress(input: string): boolean {
  return parseGroupAddress(input).ok;
}
