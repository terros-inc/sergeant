// serve's numeric flags (TECH-5105). `Number` alone reads "" and "  " as 0 and accepts "0x10" and
// "1e3", so the text must be a plain decimal before it is converted.

/** `value` as an integer of at least `min`, or undefined when it is not one written in decimal digits. */
export function integerFlag(value: string, min: number): number | undefined {
  const n = /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) && n >= min ? n : undefined;
}

/** `value` as a number of at least `min`, or undefined when it is not a plain decimal such as "15" or "0.5". */
export function decimalFlag(value: string, min: number): number | undefined {
  const n = /^-?(\d+\.?\d*|\.\d+)$/.test(value) ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= min ? n : undefined;
}
