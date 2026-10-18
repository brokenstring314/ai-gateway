/**
 * Validators that turn a regex hit into a verdict. Each one exists to cut a
 * class of false positives a bare pattern cannot: order numbers that look
 * like card numbers, 18-digit strings that are not ID numbers, random
 * assignments that are not secrets.
 */

/** Luhn (mod 10) check over the digits of `s`; non-digits are skipped. */
export function luhnValid(s: string): boolean {
  let sum = 0;
  let double = false;
  let count = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) continue;
    let d = c - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
    count++;
  }
  return count > 0 && sum % 10 === 0;
}

/** Plausible payment card: 13–19 digits, a real issuer prefix, passes Luhn, not one repeated digit. */
export function creditCardValid(match: string): boolean {
  const digits = match.replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  // Visa 4, Mastercard 51–55 / 22–27, Amex 34/37, Discover 6011/65/644–649,
  // JCB 35, UnionPay 62, Diners 36/38/300–305.
  if (!/^(?:4|5[1-5]|2[2-7]|3[4-8]|30[0-5]|6)/.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  // Separators must be consistent with real groupings: either none, or groups of 4 (Amex 4-6-5).
  if (/[ -]/.test(match) && !/^\d{4}([ -])\d{4,6}(?:\1\d{1,5}){1,3}$/.test(match)) return false;
  return luhnValid(digits);
}

const CN_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CN_ID_CHECK = "10X98765432";

/** GB 11643-1999 check digit of an 18-digit PRC resident ID, plus a real calendar date. */
export function cnIdValid(match: string): boolean {
  const id = match.toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * CN_ID_WEIGHTS[i]!;
  if (CN_ID_CHECK[sum % 11] !== id[17]) return false;
  const y = Number(id.slice(6, 10));
  const m = Number(id.slice(10, 12));
  const d = Number(id.slice(12, 14));
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** ISO 13616 IBAN: country + check digits, 15–34 chars, mod-97 == 1. */
export function ibanValid(match: string): boolean {
  const iban = match.replace(/ /g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const val = code >= 65 ? String(code - 55) : ch;
    for (const digit of val) rem = (rem * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = [...s].length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A JWT whose header is base64url JSON naming an `alg`. */
export function jwtValid(match: string): boolean {
  const header = match.split(".")[0] ?? "";
  try {
    const json = Buffer.from(header.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" && "alg" in parsed;
  } catch {
    return false;
  }
}

/** Phone number with 8–15 digits in total (E.164 bounds). */
export function phoneDigitsValid(match: string): boolean {
  const n = match.replace(/\D/g, "").length;
  return n >= 8 && n <= 15;
}

/** A random-looking key body: has a letter and a digit (cuts slugs such as "sk-learn-tutorial-for-beginners"). */
export function mixedAlnum(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}
