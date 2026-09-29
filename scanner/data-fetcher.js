// ==================== DATA FETCHER ====================
// Fetches OHLCV data from Yahoo Finance in batches
// Handles rate limiting, retries, and error recovery

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Timeframe configs for scanner
const SCAN_CONFIGS = {
  daily: { range: '6mo', interval: '1d' },
  weekly: { range: '1y', interval: '1wk' }
};

/**
 * Fetch OHLCV candles for a single symbol from Yahoo Finance
 * @param {string} symbol - Yahoo Finance symbol (e.g. 'RELIANCE.NS')
 * @param {'daily'|'weekly'} timeframe
 * @returns {Promise<{candles: Array, meta: Object}|null>}
 */
async function fetchOHLCV(symbol, timeframe = 'daily') {
  const config = SCAN_CONFIGS[timeframe] || SCAN_CONFIGS.daily;
  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=${config.range}&interval=${config.interval}`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000) // 15s timeout
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
    if (e.message === 'RATE_LIMITED') throw e; // Let caller handle rate limit
    return null;
  }
}

/**
 * Fetch OHLCV data for multiple symbols in batches
 * @param {Array<{symbol: string, name: string, sector: string}>} symbols
 * @param {'daily'|'weekly'} timeframe
 * @param {Object} options
 * @param {number} options.batchSize - How many to fetch concurrently (default: 5)
 * @param {number} options.batchDelay - ms delay between batches (default: 500)
 * @param {number} options.retries - Retry count on rate limit (default: 2)
 * @param {function} options.onProgress - Progress callback (scanned, total, symbol)
 * @returns {Promise<Map<string, {candles, meta}>>}
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
            // Exponential backoff on rate limit
            const backoff = Math.min(2000 * Math.pow(2, attempt), 30000);
            console.log(`⏳ Rate limited on ${stock.symbol}, waiting ${backoff}ms (attempt ${attempt + 1})`);
            await sleep(backoff);
          }
        }
      }
      failed++;
      // Silent fail after retries exhausted
    });

    await Promise.all(promises);
    scanned += batch.length;

    if (onProgress) {
      onProgress(scanned, symbols.length, batch[batch.length - 1]?.symbol || '');
    }

    // Adaptive delay: increase if hitting rate limits
    let delay = batchDelay;
    if (rateLimitHits > 0) {
      delay = Math.min(batchDelay * (1 + rateLimitHits), 5000);
      rateLimitHits = 0; // Reset after adapting
    }

    // Delay between batches (skip after last batch)
    if (i + batchSize < symbols.length) {
      await sleep(delay);
    }
  }

  console.log(`📊 Fetch complete: ${results.size} succeeded, ${failed} failed out of ${symbols.length}`);
  return results;
}

/**
 * Extract price summary from fetched data
 * @param {Object} data - Result from fetchOHLCV
 * @returns {{price, dailyChange, weeklyChange, sparkline}}
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

  // Weekly change: compare current price to price ~5 trading days ago
  const weekAgoIdx = Math.max(0, candles.length - 6);
  const weekAgoPrice = candles[weekAgoIdx].close;
  const weeklyChange = weekAgoPrice > 0 ? ((price - weekAgoPrice) / weekAgoPrice * 100) : 0;

  // Sparkline: last 30 close prices
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
