import { describe, expect, it } from "vitest";
import { decimalFlag, integerFlag } from "./cli-numbers.ts";

const notDecimal = ["", " ", "\t", "0x10", "0X1f", "0b1", "0o7", "1e3", "Infinity", "NaN", "12abc", " 5", "5 ", "+5", "1_000"];

describe("integerFlag", () => {
  it("rejects empty and non-decimal text that Number would read as a number", () => {
    for (const value of [...notDecimal, "1.5", "1.", ".5"]) expect(integerFlag(value, 0), JSON.stringify(value)).toBeUndefined();
  });

  it("reads decimal integers at or above the minimum", () => {
    expect(integerFlag("0", 0)).toBe(0);
    expect(integerFlag("8080", 0)).toBe(8080);
    expect(integerFlag("007", 1)).toBe(7);
    expect(integerFlag("0", 1)).toBeUndefined();
    expect(integerFlag("-1", 0)).toBeUndefined();
  });
});

describe("decimalFlag", () => {
  it("rejects empty and non-decimal text that Number would read as a number", () => {
    for (const value of [...notDecimal, ".", "1.2.3"]) expect(decimalFlag(value, 0), JSON.stringify(value)).toBeUndefined();
  });

  it("reads decimal integers and fractions at or above the minimum", () => {
    expect(decimalFlag("15", 0)).toBe(15);
    expect(decimalFlag("0", 0)).toBe(0);
    expect(decimalFlag("0.5", 0)).toBe(0.5);
    expect(decimalFlag(".25", 0)).toBe(0.25);
    expect(decimalFlag("2.", 0)).toBe(2);
    expect(decimalFlag("-0.5", 0)).toBeUndefined();
  });
});
