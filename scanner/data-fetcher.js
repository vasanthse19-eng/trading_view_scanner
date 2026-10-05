// ==================== DATA FETCHER ====================
// Fetches OHLCV data from Yahoo Finance in batches
// Handles rate limiting, retries, and error recovery

'use strict';

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Timeframe configs for scanner — extended for pattern detection
const SCAN_CONFIGS = {
  hourly:  { range: '2y',  interval: '60m' },   // 1H: ~120 trading-day candles
  daily:   { range: '2y',  interval: '1d' },     // 1D: ~500 candles (covers >2yr patterns)
  weekly:  { range: '5y',  interval: '1wk' },    // 1W: ~260 candles
};

/**
 * Fetch OHLCV candles for a single symbol from Yahoo Finance
 */
async function fetchOHLCV(symbol, timeframe = 'daily') {
  const config = SCAN_CONFIGS[timeframe] || SCAN_CONFIGS.daily;
  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=${config.range}&interval=${config.interval}`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000)
    });

    if (!resp.ok) {
      if (resp.status === 429) throw new Error('RATE_LIMITED');
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const result = data.chart?.result?.[0];
    if (!result || !result.timestamp) return null;

    const ts = result.timestamp;
    const q = result.indicators?.quote?.[0];
    if (!q) return null;

    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open?.[i] != null && q.close?.[i] != null && q.high?.[i] != null && q.low?.[i] != null) {
        candles.push({
          time: ts[i],
          open: q.open[i],
          high: q.high[i],
          low: q.low[i],
          close: q.close[i],
          volume: q.volume?.[i] || 0
        });
      }
    }

    // For BSE stocks (.BO suffix), retry with smaller range if too few candles
    if (candles.length < 5 && (symbol.endsWith('.BO') || symbol.endsWith('.NS'))) {
      const fallbackRanges = ['5y', '2y', '1y', '6mo', '3mo'];
      for (const fbRange of fallbackRanges) {
        if (fbRange === config.range) continue;
        try {
          const fbUrl = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=${fbRange}&interval=${config.interval}`;
          const fbResp = await fetch(fbUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(15000)
          });
          if (!fbResp.ok) continue;
          const fbData = await fbResp.json();
          const fbResult = fbData.chart?.result?.[0];
          if (!fbResult || !fbResult.timestamp) continue;
          const fbQ = fbResult.indicators?.quote?.[0];
          if (!fbQ) continue;
          const fbCandles = [];
          for (let i = 0; i < fbResult.timestamp.length; i++) {
            if (fbQ.open?.[i] != null && fbQ.close?.[i] != null) {
              fbCandles.push({
                time: fbResult.timestamp[i],
                open: fbQ.open[i], high: fbQ.high[i],
                low: fbQ.low[i], close: fbQ.close[i],
                volume: fbQ.volume?.[i] || 0
              });
            }
          }
          if (fbCandles.length >= 5) {
            const fbMeta = fbResult.meta || {};
            return {
              candles: fbCandles,
              meta: {
                symbol: fbMeta.symbol, currency: fbMeta.currency,
                regularMarketPrice: fbMeta.regularMarketPrice,
                previousClose: fbMeta.previousClose || fbMeta.chartPreviousClose,
                exchangeName: fbMeta.exchangeName
              }
            };
          }
        } catch (_) { /* try next */ }
      }
    }

    const meta = result.meta || {};
    return {
      candles,
      meta: {
        symbol: meta.symbol,
        currency: meta.currency,
        regularMarketPrice: meta.regularMarketPrice,
        previousClose: meta.previousClose || meta.chartPreviousClose,
        exchangeName: meta.exchangeName
      }
    };
  } catch (e) {
    if (e.message === 'RATE_LIMITED') throw e;
    return null;
  }
}

/**
 * Fetch OHLCV data for multiple symbols in batches
 */
async function fetchBatch(symbols, timeframe = 'daily', options = {}) {
  const {
    batchSize = 5,
    batchDelay = 500,
    retries = 2,
    onProgress = null
  } = options;

  const results = new Map();
  let scanned = 0;
  let failed = 0;
  let rateLimitHits = 0;

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);

    const promises = batch.map(async (stock) => {
      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const data = await fetchOHLCV(stock.symbol, timeframe);
          if (data && data.candles.length > 0) {
            results.set(stock.symbol, {
              ...data,
              name: stock.name,
              sector: stock.sector
            });
          }
          return;
        } catch (e) {
          lastErr = e;
          if (e.message === 'RATE_LIMITED') {
            rateLimitHits++;
            const backoff = Math.min(2000 * Math.pow(2, attempt), 30000);
            console.log(`⏳ Rate limited on ${stock.symbol}, waiting ${backoff}ms (attempt ${attempt + 1})`);
            await sleep(backoff);
          }
        }
      }
      failed++;
    });

    await Promise.all(promises);
    scanned += batch.length;

    if (onProgress) {
      onProgress(scanned, symbols.length, batch[batch.length - 1]?.symbol || '');
    }

    let delay = batchDelay;
    if (rateLimitHits > 0) {
      delay = Math.min(batchDelay * (1 + rateLimitHits), 5000);
      rateLimitHits = 0;
    }

    if (i + batchSize < symbols.length) {
      await sleep(delay);
    }
  }

  console.log(`📊 Fetch complete: ${results.size} succeeded, ${failed} failed out of ${symbols.length}`);
  return results;
}

/**
 * Extract price summary from fetched data
 */
function extractPriceSummary(data) {
  if (!data || !data.candles || data.candles.length === 0) {
    return { price: 0, dailyChange: 0, weeklyChange: 0, sparkline: [] };
  }

  const candles = data.candles;
  const lastCandle = candles[candles.length - 1];
  const price = data.meta?.regularMarketPrice || lastCandle.close;
  const prevClose = data.meta?.previousClose || (candles.length > 1 ? candles[candles.length - 2].close : price);

  const dailyChange = prevClose > 0 ? ((price - prevClose) / prevClose * 100) : 0;

  const weekAgoIdx = Math.max(0, candles.length - 6);
  const weekAgoPrice = candles[weekAgoIdx].close;
  const weeklyChange = weekAgoPrice > 0 ? ((price - weekAgoPrice) / weekAgoPrice * 100) : 0;

  const sparkline = candles.slice(-30).map(c => c.close);

  return { price, dailyChange, weeklyChange, sparkline };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  fetchOHLCV,
  fetchBatch,
  extractPriceSummary,
  SCAN_CONFIGS
};
