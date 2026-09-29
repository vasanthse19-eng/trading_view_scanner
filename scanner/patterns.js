/**
 * patterns.js — Chart pattern detection algorithms for stock trading.
 *
 * Pure Node.js module (no external dependencies).
 * Receives OHLCV candle data and returns detected patterns.
 *
 * Input format:
 *   candles = [{ time, open, high, low, close, volume }, ...] sorted by time ascending
 */

'use strict';

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a value between min and max.
 */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Compute the mean of an array of numbers.
 */
function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ---------------------------------------------------------------------------
// detectSwings
// ---------------------------------------------------------------------------

/**
 * Find swing highs and swing lows using a lookback window.
 *
 * A swing high at index i means candles[i].high is the highest high in the
 * range [i - lookback, i + lookback].
 *
 * A swing low at index i means candles[i].low is the lowest low in the
 * range [i - lookback, i + lookback].
 *
 * @param {Array} candles  — array of OHLCV objects sorted by time ascending
 * @param {number} lookback — number of bars on each side to compare (default 5)
 * @returns {Array} — [{ index, time, price, type: 'high' | 'low' }]
 */
function detectSwings(candles, lookback = 5) {
  const swings = [];
  const len = candles.length;

  for (let i = lookback; i < len - lookback; i++) {
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isSwingHigh = false;
      if (candles[j].low <= candles[i].low) isSwingLow = false;
      // Early exit when neither is possible
      if (!isSwingHigh && !isSwingLow) break;
    }

    if (isSwingHigh) {
      swings.push({
        index: i,
        time: candles[i].time,
        price: candles[i].high,
        type: 'high',
      });
    }

    if (isSwingLow) {
      swings.push({
        index: i,
        time: candles[i].time,
        price: candles[i].low,
        type: 'low',
      });
    }
  }

  return swings;
}

// ---------------------------------------------------------------------------
// linearRegression
// ---------------------------------------------------------------------------

/**
 * Fit a line y = mx + b through an array of { x, y } points using
 * ordinary least squares.
 *
 * @param {Array} points — [{ x, y }, ...]
 * @returns {{ slope: number, intercept: number, r2: number }}
 */
function linearRegression(points) {
  const n = points.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0 };
  if (n === 1) return { slope: 0, intercept: points[0].y, r2: 1 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }

  const meanX = sumX / n;
  const meanY = sumY / n;
  const denom = sumX2 - n * meanX * meanX;

  // If all x values are the same, we can't compute a slope
  if (Math.abs(denom) < 1e-12) {
    return { slope: 0, intercept: meanY, r2: 0 };
  }

  const slope = (sumXY - n * meanX * meanY) / denom;
  const intercept = meanY - slope * meanX;

  // Coefficient of determination (R²)
  let ssTot = 0;
  let ssRes = 0;
  for (const p of points) {
    const predicted = slope * p.x + intercept;
    ssTot += (p.y - meanY) * (p.y - meanY);
    ssRes += (p.y - predicted) * (p.y - predicted);
  }

  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return { slope, intercept, r2 };
}

// ---------------------------------------------------------------------------
// detectTriangles
// ---------------------------------------------------------------------------

/**
 * Detect ascending, descending, and symmetrical triangle patterns.
 *
 * Algorithm:
 *  1. Isolate swings in the recent portion of candles (last 60%).
 *  2. Require at least 3 swing highs and 3 swing lows.
 *  3. Fit linear regressions through the swing highs and swing lows.
 *  4. Classify based on slope characteristics:
 *     - Ascending:   flat resistance (|slope| < threshold), rising support
 *     - Descending:  flat support, falling resistance
 *     - Symmetrical: highs slope negative, lows slope positive (converging)
 *  5. Compute confidence from touch count, R², and convergence rate.
 *  6. Calculate breakout, target, and stop-loss prices.
 *
 * @param {Array} candles — OHLCV candle array
 * @param {Array} swings  — output of detectSwings()
 * @returns {Array} — detected triangle pattern objects
 */
function detectTriangles(candles, swings) {
  const results = [];
  const len = candles.length;
  if (len < 30) return results;

  // Only consider swings in the recent 60% of candles
  const recentStart = Math.floor(len * 0.4);
  const recentSwings = swings.filter((s) => s.index >= recentStart);

  const swingHighs = recentSwings.filter((s) => s.type === 'high');
  const swingLows = recentSwings.filter((s) => s.type === 'low');

  // Need at least 3 of each
  if (swingHighs.length < 3 || swingLows.length < 3) return results;

  // Fit regression lines using candle index as x and price as y
  const highPoints = swingHighs.map((s) => ({ x: s.index, y: s.price }));
  const lowPoints = swingLows.map((s) => ({ x: s.index, y: s.price }));

  const highReg = linearRegression(highPoints);
  const lowReg = linearRegression(lowPoints);

  // Normalize slopes to be per-candle price change relative to the average price
  const avgPrice = mean(candles.map((c) => c.close));
  const normHighSlope = highReg.slope / avgPrice;
  const normLowSlope = lowReg.slope / avgPrice;

  // Threshold for considering a line "flat"
  const flatThreshold = 0.0003; // ~0.03% per candle

  // Check convergence: the two lines must be getting closer over time
  const startGap =
    (highReg.slope * recentStart + highReg.intercept) -
    (lowReg.slope * recentStart + lowReg.intercept);
  const endGap =
    (highReg.slope * (len - 1) + highReg.intercept) -
    (lowReg.slope * (len - 1) + lowReg.intercept);
  const converging = endGap < startGap && endGap > 0;

  if (!converging) return results;

  // Determine pattern type
  let patternType = null;
  let direction = null;

  const highFlat = Math.abs(normHighSlope) < flatThreshold;
  const lowFlat = Math.abs(normLowSlope) < flatThreshold;
  const highFalling = normHighSlope < -flatThreshold;
  const lowRising = normLowSlope > flatThreshold;

  if (highFlat && lowRising) {
    // Ascending triangle: flat top, rising bottom — bullish
    patternType = 'ascending_triangle';
    direction = 'bullish';
  } else if (lowFlat && highFalling) {
    // Descending triangle: flat bottom, falling top — bearish
    patternType = 'descending_triangle';
    direction = 'bearish';
  } else if (highFalling && lowRising) {
    // Symmetrical triangle: converging from both sides
    patternType = 'symmetrical_triangle';
    // Direction is ambiguous; use the last candle's position relative to midpoint
    const midPrice =
      ((highReg.slope * (len - 1) + highReg.intercept) +
        (lowReg.slope * (len - 1) + lowReg.intercept)) / 2;
    direction = candles[len - 1].close > midPrice ? 'bullish' : 'bearish';
  } else {
    // No valid triangle pattern
    return results;
  }

  // Compute apex (where the two lines would meet)
  const apexIndex =
    Math.abs(highReg.slope - lowReg.slope) > 1e-12
      ? (lowReg.intercept - highReg.intercept) / (highReg.slope - lowReg.slope)
      : len * 2;
  const apexPrice = highReg.slope * apexIndex + highReg.intercept;

  // Triangle height at widest point (the start of the recent range)
  const widestHigh = highReg.slope * recentStart + highReg.intercept;
  const widestLow = lowReg.slope * recentStart + lowReg.intercept;
  const triangleHeight = widestHigh - widestLow;

  // Breakout price: the trendline value at the last candle
  const resistanceAtEnd = highReg.slope * (len - 1) + highReg.intercept;
  const supportAtEnd = lowReg.slope * (len - 1) + lowReg.intercept;

  let breakoutPrice, targetPrice, stopLoss;
  if (direction === 'bullish') {
    breakoutPrice = resistanceAtEnd;
    targetPrice = breakoutPrice + triangleHeight;
    stopLoss = supportAtEnd;
  } else {
    breakoutPrice = supportAtEnd;
    targetPrice = breakoutPrice - triangleHeight;
    stopLoss = resistanceAtEnd;
  }

  // Confidence calculation
  const touchScore = clamp((swingHighs.length + swingLows.length - 6) * 5, 0, 25);
  const r2Score = clamp(((highReg.r2 + lowReg.r2) / 2) * 40, 0, 40);
  const convergenceRate = 1 - endGap / startGap;
  const convergenceScore = clamp(convergenceRate * 35, 0, 35);
  const confidence = Math.round(touchScore + r2Score + convergenceScore);

  if (confidence < 40) return results;

  results.push({
    pattern: patternType,
    confidence: clamp(confidence, 0, 100),
    direction,
    breakoutPrice,
    targetPrice,
    stopLoss,
    details: {
      resistanceLine: { slope: highReg.slope, intercept: highReg.intercept, r2: highReg.r2 },
      supportLine: { slope: lowReg.slope, intercept: lowReg.intercept, r2: lowReg.r2 },
      apex: { index: apexIndex, price: apexPrice },
      touches: swingHighs.length + swingLows.length,
    },
  });

  return results;
}

// ---------------------------------------------------------------------------
// detectPoleAndFlag
// ---------------------------------------------------------------------------

/**
 * Detect bull flag and bear flag (pole & flag) patterns.
 *
 * Algorithm:
 *  1. Scan backward from the end of candles looking for a "pole" — a strong
 *     directional move (>5% in <15 candles) with above-average volume.
 *  2. After the pole, look for a consolidation "flag" period (10-25 candles)
 *     with a slight counter-trend drift and decreasing volume.
 *  3. The flag should retrace 30-50% of the pole height.
 *  4. Calculate breakout, target, and stop-loss prices.
 *
 * @param {Array} candles — OHLCV candle array
 * @param {Array} swings  — output of detectSwings()
 * @returns {Array} — detected flag pattern objects
 */
function detectPoleAndFlag(candles, swings) {
  const results = [];
  const len = candles.length;
  if (len < 40) return results;

  // Average volume across all candles (for comparison)
  const avgVolume = mean(candles.map((c) => c.volume));

  // Try different pole lengths and flag lengths
  for (let poleLen = 5; poleLen <= 15; poleLen++) {
    for (let flagLen = 10; flagLen <= 25; flagLen++) {
      const totalLen = poleLen + flagLen;
      if (totalLen > len) continue;

      const poleStartIdx = len - totalLen;
      const poleEndIdx = poleStartIdx + poleLen - 1;
      const flagStartIdx = poleEndIdx + 1;
      const flagEndIdx = len - 1;

      // --- Determine pole direction and strength ---
      const poleStartPrice = candles[poleStartIdx].close;
      const poleEndPrice = candles[poleEndIdx].close;
      const poleChange = (poleEndPrice - poleStartPrice) / poleStartPrice;
      const poleHeight = Math.abs(poleEndPrice - poleStartPrice);
      const isBullPole = poleChange > 0.05;
      const isBearPole = poleChange < -0.05;

      if (!isBullPole && !isBearPole) continue;

      // Pole volume should be above average
      const poleCandles = candles.slice(poleStartIdx, poleEndIdx + 1);
      const poleVolume = mean(poleCandles.map((c) => c.volume));
      if (poleVolume < avgVolume * 0.8) continue;

      // --- Analyse the flag section ---
      const flagCandles = candles.slice(flagStartIdx, flagEndIdx + 1);
      const flagVolume = mean(flagCandles.map((c) => c.volume));

      // Volume should decrease during the flag relative to the pole
      const volumeDecreasing = flagVolume < poleVolume;

      // Flag drift: fit a regression through the flag close prices
      const flagPoints = flagCandles.map((c, idx) => ({
        x: idx,
        y: c.close,
      }));
      const flagReg = linearRegression(flagPoints);

      // Flag retracement: how much of the pole the flag gives back
      const flagStart = flagCandles[0].close;
      const flagEnd = flagCandles[flagCandles.length - 1].close;
      const retracement = Math.abs(flagEnd - flagStart) / poleHeight;

      // Flag should retrace 30-50% (allow some tolerance: 15-60%)
      if (retracement < 0.15 || retracement > 0.60) continue;

      // Flag tightness: the range of the flag relative to pole height
      const flagHighs = flagCandles.map((c) => c.high);
      const flagLows = flagCandles.map((c) => c.low);
      const flagRange = Math.max(...flagHighs) - Math.min(...flagLows);
      const flagTightness = 1 - clamp(flagRange / poleHeight, 0, 1);

      let pattern, direction, breakoutPrice, targetPrice, stopLoss;

      if (isBullPole) {
        // Bull flag: pole goes up, flag drifts slightly down or sideways
        const normFlagSlope = flagReg.slope / mean(flagCandles.map((c) => c.close));
        if (normFlagSlope > 0.002) continue; // Flag shouldn't drift strongly upward

        pattern = 'bull_flag';
        direction = 'bullish';
        breakoutPrice = Math.max(...flagHighs);
        targetPrice = breakoutPrice + poleHeight;
        stopLoss = Math.min(...flagLows);
      } else {
        // Bear flag: pole goes down, flag drifts slightly up or sideways
        const normFlagSlope = flagReg.slope / mean(flagCandles.map((c) => c.close));
        if (normFlagSlope < -0.002) continue; // Flag shouldn't drift strongly downward

        pattern = 'bear_flag';
        direction = 'bearish';
        breakoutPrice = Math.min(...flagLows);
        targetPrice = breakoutPrice - poleHeight;
        stopLoss = Math.max(...flagHighs);
      }

      // --- Confidence calculation ---
      // Pole strength (how far above the 5% minimum)
      const poleStrength = clamp((Math.abs(poleChange) - 0.05) * 400, 0, 25);

      // Flag tightness score
      const tightnessScore = clamp(flagTightness * 25, 0, 25);

      // Volume pattern score
      const volumeScore = volumeDecreasing ? 20 : 5;

      // Retracement quality (ideal is ~38% Fibonacci)
      const retracementIdeal = 1 - Math.abs(retracement - 0.38) / 0.38;
      const retracementScore = clamp(retracementIdeal * 30, 0, 30);

      const confidence = Math.round(
        poleStrength + tightnessScore + volumeScore + retracementScore
      );

      if (confidence < 40) continue;

      results.push({
        pattern,
        confidence: clamp(confidence, 0, 100),
        direction,
        poleHeight,
        flagLength: flagLen,
        targetPrice,
        stopLoss,
        details: {
          poleStart: {
            index: poleStartIdx,
            time: candles[poleStartIdx].time,
            price: poleStartPrice,
          },
          poleEnd: {
            index: poleEndIdx,
            time: candles[poleEndIdx].time,
            price: poleEndPrice,
          },
          flagStart: {
            index: flagStartIdx,
            time: candles[flagStartIdx].time,
            price: flagCandles[0].close,
          },
          flagEnd: {
            index: flagEndIdx,
            time: candles[flagEndIdx].time,
            price: flagCandles[flagCandles.length - 1].close,
          },
        },
      });
    }
  }

  // If multiple detections overlap, keep only the highest-confidence one per type
  const best = {};
  for (const r of results) {
    if (!best[r.pattern] || r.confidence > best[r.pattern].confidence) {
      best[r.pattern] = r;
    }
  }

  return Object.values(best);
}

// ---------------------------------------------------------------------------
// detectHeadAndShoulders
// ---------------------------------------------------------------------------

/**
 * Detect Head & Shoulders (bearish) and Inverse Head & Shoulders (bullish).
 *
 * Algorithm:
 *  1. Gather swing highs in the last 60-120 candles for regular H&S, and
 *     swing lows for inverse H&S.
 *  2. Use a sliding window of 5 consecutive swing points:
 *     - Regular: 3 peaks with 2 troughs between them.
 *     - Inverse: 3 troughs with 2 peaks between them.
 *  3. Validate shape: head must be the most extreme, shoulders roughly equal.
 *  4. Compute neckline from the two intermediate points.
 *  5. Calculate confidence from symmetry, head prominence, neckline flatness,
 *     and volume pattern.
 *
 * @param {Array} candles — OHLCV candle array
 * @param {Array} swings  — output of detectSwings()
 * @returns {Array} — detected H&S pattern objects
 */
function detectHeadAndShoulders(candles, swings) {
  const results = [];
  const len = candles.length;
  if (len < 60) return results;

  // Determine the window to search: last 60-120 candles
  const searchStart = Math.max(0, len - 120);
  const searchSwings = swings.filter((s) => s.index >= searchStart);

  const swingHighs = searchSwings.filter((s) => s.type === 'high');
  const swingLows = searchSwings.filter((s) => s.type === 'low');

  // --- Regular Head & Shoulders (bearish reversal) ---
  // Need at least 3 swing highs and 2 swing lows
  if (swingHighs.length >= 3 && swingLows.length >= 2) {
    // Try all combinations of 3 consecutive highs
    for (let i = 0; i <= swingHighs.length - 3; i++) {
      const leftShoulder = swingHighs[i];
      const head = swingHighs[i + 1];
      const rightShoulder = swingHighs[i + 2];

      // Head must be higher than both shoulders
      if (head.price <= leftShoulder.price || head.price <= rightShoulder.price) continue;

      // Shoulders should be roughly similar height (within 3%)
      const shoulderAvg = (leftShoulder.price + rightShoulder.price) / 2;
      const shoulderDiff = Math.abs(leftShoulder.price - rightShoulder.price) / shoulderAvg;
      if (shoulderDiff > 0.03) continue;

      // Head prominence: head should be meaningfully higher than shoulders
      const headProminence = (head.price - shoulderAvg) / shoulderAvg;
      if (headProminence < 0.01) continue; // At least 1% above shoulders

      // Find the two troughs between the peaks to form the neckline
      const trough1Candidates = swingLows.filter(
        (s) => s.index > leftShoulder.index && s.index < head.index
      );
      const trough2Candidates = swingLows.filter(
        (s) => s.index > head.index && s.index < rightShoulder.index
      );

      if (trough1Candidates.length === 0 || trough2Candidates.length === 0) continue;

      // Pick the lowest trough in each gap
      const trough1 = trough1Candidates.reduce((a, b) => (a.price < b.price ? a : b));
      const trough2 = trough2Candidates.reduce((a, b) => (a.price < b.price ? a : b));

      // Neckline
      const necklineSlope =
        (trough2.price - trough1.price) / (trough2.index - trough1.index || 1);
      const necklineAtEnd =
        trough1.price + necklineSlope * (len - 1 - trough1.index);
      const necklineAvg = (trough1.price + trough2.price) / 2;

      // Neckline flatness
      const necklineDiff = Math.abs(trough1.price - trough2.price) / necklineAvg;

      // Target: distance from head to neckline projected down from the neckline break
      const headToNeckline = head.price - necklineAvg;
      const breakoutPrice = necklineAtEnd;
      const targetPrice = breakoutPrice - headToNeckline;
      const stopLoss = head.price;

      // --- Confidence calculation ---
      // Symmetry: how close the shoulders are in price (max 25)
      const symmetryScore = clamp((1 - shoulderDiff / 0.03) * 25, 0, 25);

      // Head prominence (max 25)
      const prominenceScore = clamp(headProminence * 500, 0, 25);

      // Neckline flatness (max 25)
      const necklineFlatScore = clamp((1 - necklineDiff / 0.05) * 25, 0, 25);

      // Volume pattern: ideally volume decreases from left shoulder to head to right shoulder
      let volumeScore = 0;
      const lsVolume = candles[leftShoulder.index].volume;
      const headVolume = candles[head.index].volume;
      const rsVolume = candles[rightShoulder.index].volume;
      if (headVolume <= lsVolume) volumeScore += 12;
      if (rsVolume <= headVolume) volumeScore += 13;

      const confidence = Math.round(
        symmetryScore + prominenceScore + necklineFlatScore + volumeScore
      );

      if (confidence < 40) continue;

      results.push({
        pattern: 'head_and_shoulders',
        confidence: clamp(confidence, 0, 100),
        direction: 'bearish',
        necklinePrice: necklineAvg,
        targetPrice,
        stopLoss,
        details: {
          leftShoulder: { index: leftShoulder.index, time: leftShoulder.time, price: leftShoulder.price },
          head: { index: head.index, time: head.time, price: head.price },
          rightShoulder: { index: rightShoulder.index, time: rightShoulder.time, price: rightShoulder.price },
          neckline: {
            point1: { index: trough1.index, time: trough1.time, price: trough1.price },
            point2: { index: trough2.index, time: trough2.time, price: trough2.price },
            slope: necklineSlope,
          },
        },
      });
    }
  }

  // --- Inverse Head & Shoulders (bullish reversal) ---
  // Need at least 3 swing lows and 2 swing highs
  if (swingLows.length >= 3 && swingHighs.length >= 2) {
    for (let i = 0; i <= swingLows.length - 3; i++) {
      const leftShoulder = swingLows[i];
      const head = swingLows[i + 1];
      const rightShoulder = swingLows[i + 2];

      // Head must be lower than both shoulders
      if (head.price >= leftShoulder.price || head.price >= rightShoulder.price) continue;

      // Shoulders should be roughly similar height (within 3%)
      const shoulderAvg = (leftShoulder.price + rightShoulder.price) / 2;
      const shoulderDiff = Math.abs(leftShoulder.price - rightShoulder.price) / shoulderAvg;
      if (shoulderDiff > 0.03) continue;

      // Head prominence: head should be meaningfully lower than shoulders
      const headProminence = (shoulderAvg - head.price) / shoulderAvg;
      if (headProminence < 0.01) continue;

      // Find the two peaks between the troughs to form the neckline
      const peak1Candidates = swingHighs.filter(
        (s) => s.index > leftShoulder.index && s.index < head.index
      );
      const peak2Candidates = swingHighs.filter(
        (s) => s.index > head.index && s.index < rightShoulder.index
      );

      if (peak1Candidates.length === 0 || peak2Candidates.length === 0) continue;

      // Pick the highest peak in each gap
      const peak1 = peak1Candidates.reduce((a, b) => (a.price > b.price ? a : b));
      const peak2 = peak2Candidates.reduce((a, b) => (a.price > b.price ? a : b));

      // Neckline
      const necklineSlope =
        (peak2.price - peak1.price) / (peak2.index - peak1.index || 1);
      const necklineAtEnd =
        peak1.price + necklineSlope * (len - 1 - peak1.index);
      const necklineAvg = (peak1.price + peak2.price) / 2;

      // Neckline flatness
      const necklineDiff = Math.abs(peak1.price - peak2.price) / necklineAvg;

      // Target: distance from head to neckline projected up from the neckline break
      const necklineToHead = necklineAvg - head.price;
      const breakoutPrice = necklineAtEnd;
      const targetPrice = breakoutPrice + necklineToHead;
      const stopLoss = head.price;

      // --- Confidence calculation ---
      const symmetryScore = clamp((1 - shoulderDiff / 0.03) * 25, 0, 25);
      const prominenceScore = clamp(headProminence * 500, 0, 25);
      const necklineFlatScore = clamp((1 - necklineDiff / 0.05) * 25, 0, 25);

      // Volume pattern: ideally decreasing across the three lows
      let volumeScore = 0;
      const lsVolume = candles[leftShoulder.index].volume;
      const headVolume = candles[head.index].volume;
      const rsVolume = candles[rightShoulder.index].volume;
      if (headVolume <= lsVolume) volumeScore += 12;
      if (rsVolume <= headVolume) volumeScore += 13;

      const confidence = Math.round(
        symmetryScore + prominenceScore + necklineFlatScore + volumeScore
      );

      if (confidence < 40) continue;

      results.push({
        pattern: 'inverse_head_and_shoulders',
        confidence: clamp(confidence, 0, 100),
        direction: 'bullish',
        necklinePrice: necklineAvg,
        targetPrice,
        stopLoss,
        details: {
          leftShoulder: { index: leftShoulder.index, time: leftShoulder.time, price: leftShoulder.price },
          head: { index: head.index, time: head.time, price: head.price },
          rightShoulder: { index: rightShoulder.index, time: rightShoulder.time, price: rightShoulder.price },
          neckline: {
            point1: { index: peak1.index, time: peak1.time, price: peak1.price },
            point2: { index: peak2.index, time: peak2.time, price: peak2.price },
            slope: necklineSlope,
          },
        },
      });
    }
  }

  // Keep only the highest-confidence result per pattern type
  const best = {};
  for (const r of results) {
    if (!best[r.pattern] || r.confidence > best[r.pattern].confidence) {
      best[r.pattern] = r;
    }
  }

  return Object.values(best);
}

// ---------------------------------------------------------------------------
// scanAllPatterns
// ---------------------------------------------------------------------------

/**
 * Run all pattern detectors on the given candles and return a combined list
 * of detected patterns sorted by confidence descending.
 *
 * @param {Array} candles — OHLCV candle array (at least 50 candles recommended)
 * @returns {Array} — all detected patterns sorted by confidence descending
 */
function scanAllPatterns(candles) {
  if (!candles || candles.length < 50) return [];

  const swings = detectSwings(candles, 5);

  const patterns = [
    ...detectTriangles(candles, swings),
    ...detectPoleAndFlag(candles, swings),
    ...detectHeadAndShoulders(candles, swings),
  ];

  return patterns.sort((a, b) => b.confidence - a.confidence);
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  detectSwings,
  linearRegression,
  detectTriangles,
  detectPoleAndFlag,
  detectHeadAndShoulders,
  scanAllPatterns,
};
