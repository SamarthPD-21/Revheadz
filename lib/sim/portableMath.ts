/**
 * Math that gives bit-identical results in every JavaScript engine.
 *
 * Drag results are decided by replaying both players' inputs, possibly in different browsers
 * (and, for verified leaderboards, on a server). IEEE-754 guarantees +, -, *, / and sqrt are
 * correctly rounded everywhere, but Math.exp, Math.pow, Math.sin and friends are left to each
 * engine and differ in the last bits between V8, SpiderMonkey and JavaScriptCore. Over
 * thousands of physics steps that can move a finish time. So the simulation uses these instead.
 */

// ln 2 split in two (as in fdlibm): k * LN2_HI is exact, so the reduction loses nothing
const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700;

/** e^x from basic arithmetic only: range-reduce by powers of two, then a Taylor series. */
export function pexp(x: number): number {
  if (x !== x) return NaN;
  if (x > 709) return Infinity;
  if (x < -745) return 0;
  const k = Math.round(x * INV_LN2); // Math.round is exact
  const r = x - k * LN2_HI - k * LN2_LO; // |r| <= ~0.35
  // Taylor series for e^r, summed from the smallest term up for accuracy (~1e-16 relative)
  let term = 1;
  const terms = [1];
  for (let n = 1; n <= 18; n++) {
    term = (term * r) / n;
    terms.push(term);
  }
  let sum = 0;
  for (let n = terms.length - 1; n >= 0; n--) sum += terms[n];
  // multiply by 2^k exactly, one power of two at a time
  let scale = 1;
  const step = k > 0 ? 2 : 0.5;
  for (let i = 0; i < Math.abs(k); i++) scale *= step;
  return sum * scale;
}
