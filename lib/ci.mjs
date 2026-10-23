// Distribution-free 95% intervals quoted in the paper. Both are exact and
// deterministic, so the checker can recompute them from the pinned logs.
//   quantileCI      order-statistic interval for a quantile: [x_(l), x_(u)]
//                   with binomial coverage of at least 1 - alpha
//   clopperPearson  exact binomial interval for a proportion

const logFact = [0];
const lf = (n) => { for (let i = logFact.length; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i); return logFact[n]; };
const logPmf = (k, n, p) => {
  if (p <= 0) return k === 0 ? 0 : -Infinity;
  if (p >= 1) return k === n ? 0 : -Infinity;
  return lf(n) - lf(k) - lf(n - k) + k * Math.log(p) + (n - k) * Math.log1p(-p);
};
/** P(B <= k) for B ~ Binomial(n, p). */
export function binomCdf(k, n, p) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(logPmf(i, n, p));
  return Math.min(1, s);
}

/** Interval for the p-quantile of `values`; bounds are null when n is too small. */
export function quantileCI(values, p = 0.5, alpha = 0.05) {
  const s = [...values].sort((a, b) => a - b), n = s.length;
  let l = 0;
  for (let k = 1; k <= n; k++) if (binomCdf(k - 1, n, p) <= alpha / 2) l = k; else break;
  let u = n + 1;
  for (let k = 1; k <= n; k++) if (binomCdf(k - 1, n, p) >= 1 - alpha / 2) { u = k; break; }
  return { n, lo: l >= 1 ? s[l - 1] : null, hi: u <= n ? s[u - 1] : null, ranks: [l, u] };
}

/** Exact interval for x successes in n trials. */
export function clopperPearson(x, n, alpha = 0.05) {
  const solve = (f) => { let lo = 0, hi = 1; for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (f(m)) hi = m; else lo = m; } return (lo + hi) / 2; };
  // lower: smallest p with P(X >= x; p) >= alpha/2;  upper: smallest p with P(X <= x; p) <= alpha/2
  const lo = x === 0 ? 0 : solve((p) => 1 - binomCdf(x - 1, n, p) >= alpha / 2);
  const hi = x === n ? 1 : solve((p) => binomCdf(x, n, p) <= alpha / 2);
  return { x, n, lo, hi };
}
