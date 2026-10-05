// ==================== SCANNER ORCHESTRATOR ====================
// Coordinates data fetching, pattern detection, dashboard generation, and Telegram alerts
// Scans: NSE + US Stocks + Crypto + Commodities across 1H / 1D / Weekly timeframes

'use strict';

const path = require('path');
const fs = require('fs');
const NSE_SYMBOLS = require('./nse-symbols');
const { US_STOCKS, CRYPTO, COMMODITIES } = require('./scan-symbols');
const { fetchBatch, extractPriceSummary } = require('./data-fetcher');
const { scanAllPatterns } = require('./patterns');
const { generateDashboard } = require('./dashboard');

// Scanner state
let scanState = {
  running: false,
  lastScan: null,
  lastResults: [],
  lastMeta: null,
  progress: { scanned: 0, total: 0, currentSymbol: '', phase: 'idle' }
};

// Dashboard output path
const DASHBOARD_FILE = path.join(__dirname, '..', 'scanner-dashboard.html');
const RESULTS_FILE = path.join(__dirname, '..', 'scanner-results.json');

// Timeframes to scan
const TIMEFRAMES = [
  { key: 'hourly', label: '1H',     minCandles: 50 },
  { key: 'daily',  label: 'Daily',  minCandles: 40 },
  { key: 'weekly', label: 'Weekly', minCandles: 30 },
];

/**
 * Build the full symbol list to scan (NSE + US + Crypto + Commodities).
 * Tag each with a `market` field so the dashboard can link correctly.
 */
function buildSymbolList(options = {}) {
  const {
    includeNSE = true,
    includeUS = true,
    includeCrypto = true,
    includeCommodities = true,
    nseLimit = 0,  // 0 = all
  } = options;

  const symbols = [];

  if (includeNSE) {
    const nse = nseLimit > 0 ? NSE_SYMBOLS.slice(0, nseLimit) : NSE_SYMBOLS;
    nse.forEach(s => symbols.push({ ...s, market: 'nse' }));
  }
  if (includeUS) {
    US_STOCKS.forEach(s => symbols.push({ ...s, market: 'us' }));
  }
  if (includeCrypto) {
    CRYPTO.forEach(s => symbols.push({ ...s, market: 'crypto' }));
  }
  if (includeCommodities) {
    COMMODITIES.forEach(s => symbols.push({ ...s, market: 'commodities' }));
  }

  return symbols;
}

/**
 * Run the full pattern scan across all markets and timeframes.
 */
async function runScan(options = {}) {
  if (scanState.running) {
    throw new Error('Scan already in progress');
  }

  const {
    sendTelegram = null,
    dashboardUrl = '',
    batchSize = 5,
    symbols: overrideSymbols = null,
    skipTelegram = false,
    includeNSE = true,
    includeUS = true,
    includeCrypto = true,
    includeCommodities = true,
    nseLimit = 0,
  } = options;

  const symbols = overrideSymbols || buildSymbolList({
    includeNSE, includeUS, includeCrypto, includeCommodities, nseLimit
  });

  scanState.running = true;
  scanState.progress = { scanned: 0, total: symbols.length, currentSymbol: '', phase: 'starting' };

  const startTime = Date.now();
  console.log(`\n🔍 ═══════════════════════════════════════════════`);
  console.log(`🔍  Pattern Scanner Starting — ${symbols.length} symbols`);
  console.log(`🔍  Markets: NSE(${includeNSE}) US(${includeUS}) Crypto(${includeCrypto}) Commodities(${includeCommodities})`);
  console.log(`🔍  Timeframes: ${TIMEFRAMES.map(t => t.label).join(', ')}`);
  console.log(`🔍 ═══════════════════════════════════════════════\n`);

  const allResults = [];
  let stocksScanned = 0;
  let stocksFailed = 0;

  try {
    // ── Phase 1-3: Fetch data for each timeframe ──────────
    const dataByTimeframe = {};
    let phaseNum = 0;
    const totalPhases = TIMEFRAMES.length + 1; // +1 for analysis

    for (const tf of TIMEFRAMES) {
      phaseNum++;
      const phaseKey = `fetching_${tf.key}`;
      scanState.progress.phase = phaseKey;
      console.log(`📥 Phase ${phaseNum}/${totalPhases}: Fetching ${tf.label} data...`);

      dataByTimeframe[tf.key] = await fetchBatch(symbols, tf.key, {
        batchSize,
        batchDelay: 600,
        onProgress: (done, total, sym) => {
          scanState.progress = { scanned: done, total, currentSymbol: sym, phase: phaseKey };
          if (done % 100 === 0 || done === total) {
            console.log(`   📥 ${tf.label}: ${done}/${total} (${(done / total * 100).toFixed(0)}%)`);
          }
        }
      });
    }

    // ── Analysis phase ───────────────────────────────────
    phaseNum++;
    scanState.progress.phase = 'analyzing';
    console.log(`🧮 Phase ${phaseNum}/${totalPhases}: Running pattern detection...`);

    let analyzed = 0;
    for (const stock of symbols) {
      let hasData = false;
      const stockResult = {
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        market: stock.market || 'nse',
        price: 0,
        dailyChange: 0,
        weeklyChange: 0,
        sparkline: [],
        patterns: []
      };

      for (const tf of TIMEFRAMES) {
        const tfData = dataByTimeframe[tf.key]?.get(stock.symbol);
        if (!tfData || tfData.candles.length < tf.minCandles) continue;

        hasData = true;

        // Extract price info from daily (or hourly if no daily)
        if (tf.key === 'daily' || (tf.key === 'hourly' && stockResult.price === 0)) {
          const summary = extractPriceSummary(tfData);
          stockResult.price = summary.price;
          stockResult.dailyChange = summary.dailyChange;
          stockResult.weeklyChange = summary.weeklyChange;
          stockResult.sparkline = summary.sparkline;
        }

        // Run pattern scan with timeframe-appropriate window cap
        const maxWin = tf.key === 'hourly' ? 200 : tf.key === 'daily' ? 500 : 300;
        const patterns = scanAllPatterns(tfData.candles, {
          minCandles: tf.minCandles,
          tolerance: 0.015,     // 1.5% touch tolerance
          minTouches: 3,
          lookback: tf.key === 'hourly' ? 4 : 5,
          maxWindow: maxWin,
        });

        patterns.forEach(p => { p.timeframe = tf.key; });
        stockResult.patterns.push(...patterns);
      }

      if (!hasData) {
        stocksFailed++;
      } else {
        stocksScanned++;
      }

      if (stockResult.patterns.length > 0) {
        allResults.push(stockResult);
      }

      analyzed++;
      if (analyzed % 200 === 0) {
        scanState.progress.scanned = analyzed;
        console.log(`   🧮 Analyzed: ${analyzed}/${symbols.length}`);
      }
    }

    allResults.sort((a, b) => {
      const aMax = Math.max(...a.patterns.map(p => p.confidence));
      const bMax = Math.max(...b.patterns.map(p => p.confidence));
      return bMax - aMax;
    });

    const duration = Math.round((Date.now() - startTime) / 1000);

    const scanMeta = {
      scanTime: new Date().toISOString(),
      duration,
      totalStocks: symbols.length,
      stocksScanned,
      stocksFailed,
      patternsFound: allResults.reduce((sum, r) => sum + r.patterns.length, 0),
      markets: {
        nse: includeNSE ? NSE_SYMBOLS.length : 0,
        us: includeUS ? US_STOCKS.length : 0,
        crypto: includeCrypto ? CRYPTO.length : 0,
        commodities: includeCommodities ? COMMODITIES.length : 0,
      },
      timeframes: TIMEFRAMES.map(t => t.label),
    };

    // ── Generate outputs ─────────────────────────────────
    scanState.progress.phase = 'generating';
    console.log('📄 Generating dashboard & alerts...');

    const dashboardHtml = generateDashboard(allResults, scanMeta);
    fs.writeFileSync(DASHBOARD_FILE, dashboardHtml, 'utf8');
    console.log(`   📄 Dashboard saved to ${DASHBOARD_FILE}`);

    fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results: allResults, meta: scanMeta }, null, 2), 'utf8');

    if (sendTelegram && !skipTelegram) {
      const telegramMsg = buildTelegramMessage(allResults, scanMeta, dashboardUrl);
      await sendTelegram(telegramMsg);
      console.log('   📨 Telegram summary sent');
    }

    scanState.lastScan = scanMeta.scanTime;
    scanState.lastResults = allResults;
    scanState.lastMeta = scanMeta;
    scanState.progress.phase = 'complete';

    console.log(`\n✅ ═══════════════════════════════════════════════`);
    console.log(`✅  Scan complete in ${duration}s`);
    console.log(`✅  ${stocksScanned} symbols analyzed, ${scanMeta.patternsFound} patterns found`);
    console.log(`✅ ═══════════════════════════════════════════════\n`);

    return { results: allResults, meta: scanMeta };

  } catch (err) {
    console.error('❌ Scanner error:', err.message);
    scanState.progress.phase = 'error';
    throw err;
  } finally {
    scanState.running = false;
  }
}

/**
 * Build a Telegram HTML message summarizing scan results
 */
function buildTelegramMessage(results, meta, dashboardUrl) {
  const lines = [
    `📊 <b>Pattern Scanner Report</b>`,
    `🕐 ${new Date(meta.scanTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
    `📈 ${meta.stocksScanned} symbols scanned in ${meta.duration}s`,
    `🌐 NSE: ${meta.markets.nse} | US: ${meta.markets.us} | Crypto: ${meta.markets.crypto} | Commodities: ${meta.markets.commodities}`,
    `⏱️ Timeframes: ${meta.timeframes.join(', ')}`,
    `🔍 <b>${meta.patternsFound} patterns found</b>`,
    ``
  ];

  const counts = {};
  results.forEach(r => r.patterns.forEach(p => {
    const key = p.pattern.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    counts[key] = (counts[key] || 0) + 1;
  }));
  Object.entries(counts).forEach(([k, v]) => {
    lines.push(`  • ${k}: ${v}`);
  });
  lines.push('');

  const top = results.slice(0, 10);
  if (top.length > 0) {
    lines.push(`🏆 <b>Top ${top.length} Matches:</b>`);
    lines.push('');
    top.forEach((r, i) => {
      const sym = r.symbol.replace('.NS', '').replace('-USD', '');
      const topPattern = r.patterns[0];
      const icon = getPatternIcon(topPattern.pattern);
      const dir = topPattern.direction === 'bullish' ? '🟢' : topPattern.direction === 'bearish' ? '🔴' : '🟡';
      const currency = r.market === 'nse' ? '₹' : '$';
      lines.push(
        `${i + 1}. ${dir} <b>${sym}</b> — ${currency}${r.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
        `   ${icon} ${formatPatternName(topPattern.pattern)} [${topPattern.timeframe}] (${topPattern.confidence}% conf)`,
        `   Target: ${currency}${topPattern.targetPrice?.toLocaleString('en-IN', { maximumFractionDigits: 2 }) || 'N/A'} | SL: ${currency}${topPattern.stopLoss?.toLocaleString('en-IN', { maximumFractionDigits: 2 }) || 'N/A'}`,
        ``
      );
    });
  }

  if (dashboardUrl) {
    lines.push(`🔗 <a href="${dashboardUrl}/scanner-dashboard.html">View Full Dashboard</a>`);
  }

  lines.push(`\n⚡ <i>TradeView Pro Scanner v2</i>`);
  return lines.join('\n');
}

function getPatternIcon(pattern) {
  const icons = {
    ascending_triangle:   '📐⬆️',
    descending_triangle:  '📐⬇️',
    symmetrical_triangle: '📐↔️',
    ascending_channel:    '📈⬆️',
    descending_channel:   '📉⬇️',
    rectangle:            '⬜',
    rising_wedge:         '🔺⬇️',
    falling_wedge:        '🔻⬆️',
  };
  return icons[pattern] || '📊';
}

function formatPatternName(pattern) {
  return pattern.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Get current scanner state (for API)
 */
function getState() {
  return { ...scanState };
}

module.exports = {
  runScan,
  getState,
  buildSymbolList,
  DASHBOARD_FILE,
  RESULTS_FILE
};
