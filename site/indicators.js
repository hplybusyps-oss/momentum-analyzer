// 지표 계산 — indicators.py(IndicatorCalculator)를 그대로 옮긴 것.
// 시계열은 { t:[ms], o:[], h:[], l:[], c:[], v:[] } 형태 (t 는 현지 자정 기준 타임스탬프).
'use strict';

const DAY_MS = 86400000;
const SQRT252 = Math.sqrt(252);

function todayMs() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
}

// dateutil.relativedelta(months=m) 와 동일: 말일 초과 시 그 달 말일로 맞춤
function subMonths(ms, m) {
  const d = new Date(ms);
  const y = d.getFullYear(), mo = d.getMonth() - m, day = d.getDate();
  const last = new Date(y, mo + 1, 0).getDate();
  return new Date(y, mo, Math.min(day, last)).getTime();
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function toSeries(rec) {
  return { t: rec.d.map(parseDate), o: rec.o, h: rec.h, l: rec.l, c: rec.c, v: rec.v };
}

function mean(a) {
  if (!a.length) return NaN;
  let s = 0; for (const x of a) s += x; return s / a.length;
}

// pandas .std() (ddof=1)
function std(a) {
  const n = a.length;
  if (n < 2) return NaN;
  const m = mean(a);
  let s = 0; for (const x of a) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1));
}

const num = x => (x === null || x === undefined || Number.isNaN(x) || !Number.isFinite(x)) ? null : x;

// t 가 cutoff 이상인 첫 인덱스
function firstIdxSince(t, cutoff, end = t.length) {
  let lo = 0, hi = end;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < cutoff) lo = mid + 1; else hi = mid; }
  return lo;
}

// pandas ewm(adjust=False).mean()
function emaSeries(x, span) {
  const a = 2 / (span + 1), out = new Array(x.length);
  let y = x[0];
  for (let i = 0; i < x.length; i++) { y = i === 0 ? x[0] : a * x[i] + (1 - a) * y; out[i] = y; }
  return out;
}

// pandas ewm(com, min_periods, adjust=True).mean() — 앞쪽 NaN 은 건너뜀
function ewmAdjSeries(x, com, minPeriods) {
  const a = 1 / (1 + com), out = new Array(x.length).fill(NaN);
  let numr = 0, den = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) continue;
    numr = x[i] + (1 - a) * numr;
    den  = 1 + (1 - a) * den;
    cnt++;
    if (cnt >= minPeriods) out[i] = numr / den;
  }
  return out;
}

class IndicatorCalculator {
  constructor(cfg) {
    const m = cfg.Momentum, v = cfg.Volatility, r = cfg.RSM, t = cfg.Technical;
    this.p1m = +m.period_1m; this.p3m = +m.period_3m; this.p6m = +m.period_6m; this.p12m = +m.period_12m;
    this.w1m = +m.weight_1m; this.w3m = +m.weight_3m; this.w6m = +m.weight_6m; this.w12m = +m.weight_12m;
    this.volPeriod = +v.vol_period; this.filterShort = +v.filter_short;
    this.filterLong = +v.filter_long; this.filterSigma = +v.filter_sigma;
    this.rsmPeriod = +r.period;
    this.rsiPeriod = +t.rsi_period; this.relVolPeriod = +t.rel_vol_period;
    this.slopePeriod = +t.slope_period; this.highPeriod = +t.high_period;
    this.macdFast = +t.macd_fast; this.macdSlow = +t.macd_slow; this.macdSignal = +t.macd_signal;
    this.bbPeriod = +t.bb_period; this.bbStd = +t.bb_std;
  }

  // ── 캘린더 기반 헬퍼 (asOf: 기준일, end: 시계열 끝 인덱스+1) ──────────────
  _pastPrice(t, c, months, asOf, end) {
    const target = subMonths(asOf, months);
    const lo = target - 30 * DAY_MS;
    for (let i = end - 1; i >= 0; i--) {
      if (t[i] > target) continue;
      if (t[i] < lo) return null;
      return c[i] !== 0 ? c[i] : null;
    }
    return null;
  }

  _retByMonth(t, c, months, asOf = todayMs(), end = c.length) {
    if (!end) return null;
    const past = this._pastPrice(t, c, months, asOf, end);
    return past === null ? null : c[end - 1] / past - 1;
  }

  // ── 모멘텀 ─────────────────────────────────────────────────────────────────
  avgMomentum(t, c, asOf, end) {
    const vals = [this.p1m, this.p3m, this.p6m, this.p12m]
      .map(m => this._retByMonth(t, c, m, asOf, end)).filter(x => x !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  weightedMomentum(t, c) {
    const [r1, r3, r6, r12] = [this.p1m, this.p3m, this.p6m, this.p12m].map(m => this._retByMonth(t, c, m));
    if ([r1, r3, r6, r12].some(x => x === null)) return null;
    return r1 * this.w1m + r3 * this.w3m + r6 * this.w6m + r12 * this.w12m;
  }

  // ── 변동성 ─────────────────────────────────────────────────────────────────
  _dailyReturns(t, c) {
    const rt = [], rv = [];
    for (let i = 1; i < c.length; i++) { rt.push(t[i]); rv.push(c[i] / c[i - 1] - 1); }
    return { rt, rv };
  }

  volatility(t, c) {
    const { rt, rv } = this._dailyReturns(t, c);
    const w = rv.slice(firstIdxSince(rt, subMonths(todayMs(), this.volPeriod)));
    if (!w.length) return null;
    return num(std(w) * SQRT252);
  }

  overvolFilter(t, c) {
    const { rt, rv } = this._dailyReturns(t, c);
    const shortDays = Math.max(this.filterShort * 21, 2);
    const w = rv.slice(firstIdxSince(rt, subMonths(todayMs(), this.filterLong)));
    if (w.length < shortDays) return null;
    const rolling = [];
    for (let i = shortDays - 1; i < w.length; i++) rolling.push(std(w.slice(i - shortDays + 1, i + 1)) * SQRT252);
    if (!rolling.length) return null;
    const cur = rolling[rolling.length - 1];
    const threshold = mean(rolling) + this.filterSigma * std(rolling);
    return cur > threshold;   // threshold 가 NaN 이면 false (pandas 와 동일)
  }

  // ── RSM ────────────────────────────────────────────────────────────────────
  rsm(s, bench) {
    if (!bench || !bench.t.length) return null;
    const bmap = new Map(bench.t.map((x, i) => [x, bench.c[i]]));
    const ct = [], cc = [], bc = [];
    for (let i = 0; i < s.t.length; i++) {
      if (bmap.has(s.t[i])) { ct.push(s.t[i]); cc.push(s.c[i]); bc.push(bmap.get(s.t[i])); }
    }
    if (!ct.length) return null;
    const rt = this._retByMonth(ct, cc, this.rsmPeriod);
    const rb = this._retByMonth(ct, bc, this.rsmPeriod);
    if (rt === null || rb === null) return null;
    return (1 + rt) / (1 + rb) - 1;
  }

  // ── 회귀 기울기 (로그가격) ──────────────────────────────────────────────────
  regressionSlope(t, c) {
    const w = c.slice(firstIdxSince(t, subMonths(todayMs(), this.slopePeriod)));
    const n = w.length;
    if (n < 2) return [null, null];
    const y = w.map(Math.log);
    const xm = (n - 1) / 2, ym = mean(y);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (i - xm) * (y[i] - ym); sxx += (i - xm) * (i - xm); }
    const slope = sxy / sxx, icpt = ym - slope * xm;
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      const e = y[i] - (slope * i + icpt);
      ssRes += e * e; ssTot += (y[i] - ym) * (y[i] - ym);
    }
    return [slope * 252 * 100, ssTot > 0 ? 1 - ssRes / ssTot : 0];
  }

  // ── 거래량 (마지막 거래일 미확정 문제로 전일 기준) ───────────────────────────
  relativeVolume(t, v) {
    if (v.length < 2) return null;
    const cur = v[v.length - 2];
    const end = v.length - 2;
    const w = v.slice(firstIdxSince(t, subMonths(todayMs(), this.relVolPeriod), end), end);
    if (!w.length) return null;
    const avg = mean(w);
    return avg > 0 ? cur / avg : null;
  }

  // ── 최고가 근접도 ───────────────────────────────────────────────────────────
  highProximity(t, c, h) {
    const w = h.slice(firstIdxSince(t, subMonths(todayMs(), this.highPeriod)));
    if (!w.length) return null;
    const mx = Math.max(...w);
    return mx > 0 ? c[c.length - 1] / mx - 1 : null;
  }

  // ── RSI ────────────────────────────────────────────────────────────────────
  _rsiParts(c) {
    const p = this.rsiPeriod;
    const g = [NaN], l = [NaN];
    for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
    return [ewmAdjSeries(g, p - 1, p), ewmAdjSeries(l, p - 1, p)];
  }

  rsi(c) {
    const p = this.rsiPeriod;
    if (c.length < p * 2) return null;
    const [ag, al] = this._rsiParts(c);
    const lg = ag[ag.length - 1], ll = al[al.length - 1];
    if (ll === 0) return lg > 0 ? 100 : 50;
    return num(100 - 100 / (1 + lg / ll));
  }

  rsiSeries(c) {
    const [ag, al] = this._rsiParts(c);
    return ag.map((g, i) => (al[i] === 0 || Number.isNaN(al[i]) || Number.isNaN(g)) ? NaN : 100 - 100 / (1 + g / al[i]));
  }

  // ── MACD ───────────────────────────────────────────────────────────────────
  macdSeries(c) {
    const f = emaSeries(c, this.macdFast), s = emaSeries(c, this.macdSlow);
    const line = f.map((x, i) => x - s[i]);
    const sig = emaSeries(line, this.macdSignal);
    return { line, sig, hist: line.map((x, i) => x - sig[i]) };
  }

  macdHist(c) {
    if (c.length < this.macdSlow + this.macdSignal) return null;
    const { hist } = this.macdSeries(c);
    return num(hist[hist.length - 1]);
  }

  // ── 볼린저 ─────────────────────────────────────────────────────────────────
  bollingerSeries(c) {
    const p = this.bbPeriod, k = this.bbStd;
    const sma = new Array(c.length).fill(NaN), up = sma.slice(), lo = sma.slice();
    for (let i = p - 1; i < c.length; i++) {
      const w = c.slice(i - p + 1, i + 1), m = mean(w), sd = std(w);
      sma[i] = m; up[i] = m + k * sd; lo[i] = m - k * sd;
    }
    return { sma, up, lo };
  }

  bollingerPct(c) {
    if (c.length < this.bbPeriod) return null;
    const w = c.slice(-this.bbPeriod), m = mean(w), sd = std(w);
    const rng = 2 * this.bbStd * sd;
    if (!rng) return null;
    return num((c[c.length - 1] - (m - this.bbStd * sd)) / rng);
  }

  // ── 통합 계산 ───────────────────────────────────────────────────────────────
  calculateAll(s, bench) {
    const { t, c, h, v } = s;
    const [slope, r2] = this.regressionSlope(t, c);
    return {
      close:        c[c.length - 1],
      avg_momentum: this.avgMomentum(t, c),
      wgt_momentum: this.weightedMomentum(t, c),
      abs_mom:      this._retByMonth(t, c, this.p12m),
      volatility:   this.volatility(t, c),
      overvol:      this.overvolFilter(t, c),
      rsm:          this.rsm(s, bench),
      slope:        num(slope),
      r_squared:    num(r2),
      rel_vol:      this.relativeVolume(t, v),
      high52w:      this.highProximity(t, c, h),
      rsi:          this.rsi(c),
      macd_hist:    this.macdHist(c),
      bb_pct:       this.bollingerPct(c),
    };
  }
}
