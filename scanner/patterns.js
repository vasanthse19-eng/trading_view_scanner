/**
 * patterns.js — Trendline-based chart pattern detection.
 *
 * REWRITTEN: Uses swing-point detection + trendline fitting with ≥3 touch
 * points on BOTH support and resistance lines.  Classifies:
 *   ascending_triangle, descending_triangle, symmetrical_triangle,
 *   ascending_channel, descending_channel, rectangle (range),
 *   rising_wedge, falling_wedge
 *
 * Input:  candles = [{ time, open, high, low, close, volume }, …] sorted ascending
 * Output: array of pattern objects sorted by score descending
 */

'use strict';

// ─── helpers ──────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

// ─── Swing-point detection ────────────────────────────────

/**
 * Adaptive swing detection.
 * A swing high at i: candles[i].high is the highest in [i-left, i+right].
 * We run two passes with different lookback windows (tight=3, wide=5)
 * and merge, so we don't miss smaller swings inside larger moves.
 */
function detectSwings(candles, lookback = 5) {
  const set = new Map();              // index → swing object (dedup)

  for (const lb of [Math.max(2, lookback - 2), lookback]) {
    const len = candles.length;
    for (let i = lb; i < len - lb; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - lb; j <= i + lb; j++) {
        if (j === i) continue;
        if (candles[j].high >= candles[i].high) isHigh = false;
        if (candles[j].low  <= candles[i].low)  isLow  = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh && !set.has('H' + i)) {
        set.set('H' + i, { index: i, time: candles[i].time, price: candles[i].high, type: 'high' });
      }
      if (isLow && !set.has('L' + i)) {
        set.set('L' + i, { index: i, time: candles[i].time, price: candles[i].low, type: 'low' });
      }
    }
  }

  return Array.from(set.values()).sort((a, b) => a.index - b.index);
}

// ─── Line fitting & touch counting ───────────────────────

/**
 * Fit a line through two anchor points and count how many other
 * swing points "touch" the line (within tolerance).
 *
 * @param {object} p1  – { index, price }
 * @param {object} p2  – { index, price }
 * @param {Array}  pts – candidate swing points [{ index, price }, …]
 * @param {number} tol – tolerance as fraction of price (e.g. 0.015 = 1.5%)
 * @returns {{ slope, intercept, touches: [{index,price,dist}], r2 }}
 */
function fitLine(p1, p2, pts, tol) {
  const dx = p2.index - p1.index;
  if (dx === 0) return null;

  const slope     = (p2.price - p1.price) / dx;
  const intercept = p1.price - slope * p1.index;

  const touches = [];
  let ssTot = 0, ssRes = 0;
  const prices = pts.map(p => p.price);
  const avgP   = mean(prices);

  for (const pt of pts) {
    const expected = slope * pt.index + intercept;
    const dist     = Math.abs(pt.price - expected);
    const pctDist  = dist / expected;

    ssTot += (pt.price - avgP) ** 2;
    ssRes += (pt.price - expected) ** 2;

    if (pctDist <= tol) {
      touches.push({ index: pt.index, price: pt.price, dist: pctDist });
    }
  }
  const r2 = ssTot === 0 ? 1 : clamp(1 - ssRes / ssTot, 0, 1);

  return { slope, intercept, touches, r2 };
}

/**
 * Among all pairs of swing points, find the best-fit trendline that
 * maximises the number of touches (≥ minTouches).
 *
 * Returns the single best line or null.
 */
function bestTrendline(swingPts, tol, minTouches = 3) {
  if (swingPts.length < minTouches) return null;

  let best = null;

  for (let i = 0; i < swingPts.length - 1; i++) {
    for (let j = i + 1; j < swingPts.length; j++) {
      // Anchors must be separated by at least 10 bars
      if (swingPts[j].index - swingPts[i].index < 10) continue;

      const line = fitLine(swingPts[i], swingPts[j], swingPts, tol);
      if (!line) continue;
      if (line.touches.length < minTouches) continue;

      const score = line.touches.length * 10 + line.r2 * 5;
      if (!best || score > best._score) {
        best = { ...line, _score: score, anchor1: swingPts[i], anchor2: swingPts[j] };
      }
    }
  }

  return best;
}

// ─── Pattern classification ──────────────────────────────

/**
 * Given a resistance line and a support line, classify the pattern.
 *
 * Uses normalised slopes (slope / avgPrice) and their relationship:
 *
 *   ascending_triangle:   resistance ~flat, support rising
 *   descending_triangle:  support ~flat, resistance falling
 *   symmetrical_triangle: resistance falling, support rising (converging)
 *   ascending_channel:    both rising, roughly parallel
 *   descending_channel:   both falling, roughly parallel
 *   rectangle:            both ~flat
 *   rising_wedge:         both rising, converging
 *   falling_wedge:        both falling, converging
 */
function classifyPattern(resLine, supLine, avgPrice, candleCount) {
  const rSlope = resLine.slope / avgPrice;   // normalised per-bar
  const sSlope = supLine.slope / avgPrice;

  const flat = 0.0003;  // ≈ 0.03% per candle → ~flat (tolerates noise in real data)

  const rFlat    = Math.abs(rSlope) < flat;
  const sFlat    = Math.abs(sSlope) < flat;
  const rRising  = rSlope >  flat;
  const rFalling = rSlope < -flat;
  const sRising  = sSlope >  flat;
  const sFalling = sSlope < -flat;

  // "Relatively flat" — one line's slope is < 1/3 of the other's magnitude
  // Real charts often have slight drift on the "flat" side of a triangle
  const rRelFlat = Math.abs(rSlope) < Math.abs(sSlope) * 0.35;
  const sRelFlat = Math.abs(sSlope) < Math.abs(rSlope) * 0.35;

  // Check convergence (lines getting closer)
  const startGap = (resLine.slope * 0 + resLine.intercept) - (supLine.slope * 0 + supLine.intercept);
  const endGap   = (resLine.slope * candleCount + resLine.intercept) - (supLine.slope * candleCount + supLine.intercept);
  const gapRatio = startGap > 0 ? endGap / startGap : 1;
  // Converging if gap narrowed by ≥4%, OR if lines actually crossed (endGap ≤ 0)
  const converging = startGap > 0 && (endGap <= 0 || gapRatio < 0.96);

  // Check parallelism (slopes within 25% of each other, AND not converging)
  const slopeDiff = Math.abs(rSlope - sSlope);
  const avgSlope  = (Math.abs(rSlope) + Math.abs(sSlope)) / 2;
  const parallel  = !converging && (slopeDiff < flat * 1.5 || (avgSlope > 0 && slopeDiff / avgSlope < 0.25));

  // ── Triangles (converging, at least one flat or opposing slopes) ──
  if ((rFlat || rRelFlat) && sRising && converging) {
    return { pattern: 'ascending_triangle', direction: 'bullish' };
  }
  if ((sFlat || sRelFlat) && rFalling && converging) {
    return { pattern: 'descending_triangle', direction: 'bearish' };
  }
  if (rFalling && sRising && converging) {
    return { pattern: 'symmetrical_triangle', direction: 'neutral' };
  }

  // ── Wedges (both same direction, converging) ──
  if (rRising && sRising && converging) {
    return { pattern: 'rising_wedge', direction: 'bearish' };
  }
  if (rFalling && sFalling && converging) {
    return { pattern: 'falling_wedge', direction: 'bullish' };
  }

  // ── Channels (both same direction, roughly parallel) ──
  if (rRising && sRising && parallel) {
    return { pattern: 'ascending_channel', direction: 'bullish' };
  }
  if (rFalling && sFalling && parallel) {
    return { pattern: 'descending_channel', direction: 'bearish' };
  }

  // ── Rectangle (both flat) ──
  if ((rFlat || rRelFlat) && (sFlat || sRelFlat)) {
    return { pattern: 'rectangle', direction: 'neutral' };
  }

  return null;  // no recognisable pattern
}

// ─── Main scan function ──────────────────────────────────

/**
 * Scan candles for trendline-based patterns.
 *
 * @param {Array}  candles  – OHLCV array (sorted ascending)
 * @param {Object} opts
 * @param {number} opts.minCandles  – minimum candle count (default 40)
 * @param {number} opts.tolerance   – touch tolerance as fraction (default 0.015 = 1.5%)
 * @param {number} opts.minTouches  – minimum touches per trendline (default 3)
 * @param {number} opts.lookback    – swing lookback window (default 5)
 * @param {number} opts.windowRatio – how much of data to scan (0-1, default 1.0)
 * @returns {Array} detected patterns sorted by score descending
 */
function scanAllPatterns(candles, opts = {}) {
  const {
    minCandles  = 40,
    tolerance   = 0.015,
    minTouches  = 3,
    lookback    = 5,
    maxWindow   = 500,   // cap window size to avoid noise on huge datasets
  } = opts;

  if (!candles || candles.length < minCandles) return [];

  const len = candles.length;

  // Use sliding windows to catch patterns at different scales
  // Cap each window at maxWindow candles
  const windows = [];
  const cap = Math.min(len, maxWindow);

  if (cap >= 200) {
    windows.push({ start: len - 60,  end: len });
    windows.push({ start: len - 120, end: len });
    windows.push({ start: len - 200, end: len });
    if (cap > 200) windows.push({ start: len - cap, end: len });
  } else if (cap >= 100) {
    windows.push({ start: len - 60,  end: len });
    windows.push({ start: len - 100, end: len });
    if (cap > 100) windows.push({ start: len - cap, end: len });
  } else {
    windows.push({ start: len - cap, end: len });
  }

  const results = [];
  const seen = new Set();  // avoid duplicate patterns from overlapping windows

  for (const win of windows) {
    const slice = candles.slice(win.start, win.end);
    if (slice.length < minCandles) continue;

    const swings = detectSwings(slice, lookback);
    const highs  = swings.filter(s => s.type === 'high');
    const lows   = swings.filter(s => s.type === 'low');

    if (highs.length < minTouches || lows.length < minTouches) continue;

    const resLine = bestTrendline(highs, tolerance, minTouches);
    const supLine = bestTrendline(lows,  tolerance, minTouches);

    if (!resLine || !supLine) continue;

    // Lines must not cross within the data range
    const resStart = resLine.slope * 0 + resLine.intercept;
    const supStart = supLine.slope * 0 + supLine.intercept;
    const resEnd   = resLine.slope * (slice.length - 1) + resLine.intercept;
    const supEnd   = supLine.slope * (slice.length - 1) + supLine.intercept;

    if (resStart < supStart || resEnd < supEnd) continue;  // resistance below support = invalid

    const avgPrice = mean(slice.map(c => c.close));
    const classification = classifyPattern(resLine, supLine, avgPrice, slice.length);
    if (!classification) continue;

    // Dedup key: approximate price zone (not pattern type — only best interpretation survives)
    const dedupKey =
      Math.round(resEnd / (avgPrice * 0.03)) + '_' +
      Math.round(supEnd / (avgPrice * 0.03));
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // ── Scoring ──
    const totalTouches = resLine.touches.length + supLine.touches.length;
    const touchScore   = clamp((totalTouches - 6) * 8, 0, 30);       // bonus for >6 touches
    const fitScore     = clamp(((resLine.r2 + supLine.r2) / 2) * 30, 0, 30);
    const baseTouches  = clamp(Math.min(resLine.touches.length, supLine.touches.length) * 10, 0, 30);

    // Recency bonus: last touch should be within last 15% of window
    const lastResIdx = Math.max(...resLine.touches.map(t => t.index));
    const lastSupIdx = Math.max(...supLine.touches.map(t => t.index));
    const lastTouch  = Math.max(lastResIdx, lastSupIdx);
    const recencyPct = lastTouch / (slice.length - 1);
    const recencyScore = recencyPct > 0.85 ? 10 : recencyPct > 0.7 ? 5 : 0;

    const score = Math.round(baseTouches + touchScore + fitScore + recencyScore);
    if (score < 35) continue;

    // ── Price targets ──
    const patternHeight = resEnd - supEnd;
    let breakoutPrice, targetPrice, stopLoss;

    if (classification.direction === 'bullish' || classification.direction === 'neutral') {
      breakoutPrice = resEnd;
      targetPrice   = resEnd + patternHeight;
      stopLoss      = supEnd;
    } else {
      breakoutPrice = supEnd;
      targetPrice   = supEnd - patternHeight;
      stopLoss      = resEnd;
    }

    results.push({
      pattern:    classification.pattern,
      direction:  classification.direction,
      confidence: clamp(score, 0, 100),
      breakoutPrice,
      targetPrice,
      stopLoss,
      details: {
        resistance: {
          slope: resLine.slope,
          intercept: resLine.intercept,
          r2: resLine.r2,
          touches: resLine.touches.length,
          anchor1: { index: win.start + resLine.anchor1.index, price: resLine.anchor1.price },
          anchor2: { index: win.start + resLine.anchor2.index, price: resLine.anchor2.price },
        },
        support: {
          slope: supLine.slope,
          intercept: supLine.intercept,
          r2: supLine.r2,
          touches: supLine.touches.length,
          anchor1: { index: win.start + supLine.anchor1.index, price: supLine.anchor1.price },
          anchor2: { index: win.start + supLine.anchor2.index, price: supLine.anchor2.price },
        },
        totalTouches,
        windowCandles: slice.length,
        patternHeight,
        recency: recencyPct,
      },
    });
  }

  // Keep only the best pattern per type
  const bestByType = {};
  for (const r of results) {
    if (!bestByType[r.pattern] || r.confidence > bestByType[r.pattern].confidence) {
      bestByType[r.pattern] = r;
    }
  }

  return Object.values(bestByType).sort((a, b) => b.confidence - a.confidence);
}

// ─── Exports ─────────────────────────────────────────────

module.exports = {
  detectSwings,
  fitLine,
  bestTrendline,
  classifyPattern,
  scanAllPatterns,
};
