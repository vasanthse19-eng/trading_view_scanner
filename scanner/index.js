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
  timeframeMeta: {},  // { hourly: {scanTime, patternsFound}, daily: {...}, weekly: {...} }
  progress: { scanned: 0, total: 0, currentSymbol: '', phase: 'idle' }
};

// Output paths
const DASHBOARD_FILE = path.join(__dirname, '..', 'scanner-dashboard.html');
const RESULTS_FILE = path.join(__dirname, '..', 'scanner-results.json');
const HISTORY_FILE = path.join(__dirname, '..', 'scan-history.json');

// All timeframes
const TIMEFRAMES = [
  { key: 'hourly', label: '1H',     minCandles: 50 },
  { key: 'daily',  label: 'Daily',  minCandles: 40 },
  { key: 'weekly', label: 'Weekly', minCandles: 30 },
];

// Batch splitting — NSE symbols split into N parts, non-NSE always included
const TOTAL_BATCHES = 4;    // daily/weekly: 4 batches of ~670
const HOURLY_BATCHES = 3;   // hourly: 3 batches of ~325 (curated list)

function getSymbolsForBatch(batch, allSymbols, totalBatches = TOTAL_BATCHES) {
  if (!batch || batch < 1 || batch > totalBatches) return allSymbols;
  const nse = allSymbols.filter(s => s.market === 'nse');
  const nonNse = allSymbols.filter(s => s.market !== 'nse');
  const chunkSize = Math.ceil(nse.length / totalBatches);
  const start = (batch - 1) * chunkSize;
  const end = Math.min(start + chunkSize, nse.length);
  return [...nse.slice(start, end), ...nonNse];
}

// ─── Hourly Symbol List (Nifty 500 + extras ≈ 1000 total) ──

function buildHourlySymbolList() {
  const NIFTY_500 = require('./hourly-symbols');

  // Priority: all Nifty 500 members first
  const niftyStocks = NSE_SYMBOLS.filter(s => NIFTY_500.has(s.symbol));
  // Pad with additional NSE stocks (not in Nifty 500) to reach ~900 NSE total
  const extras = NSE_SYMBOLS.filter(s => !NIFTY_500.has(s.symbol)).slice(0, 400);
  const nseList = [...niftyStocks, ...extras].map(s => ({ ...s, market: 'nse' }));

  // Always include all non-NSE (US, Crypto, Commodities)
  const nonNse = [
    ...US_STOCKS.map(s => ({ ...s, market: 'us' })),
    ...CRYPTO.map(s => ({ ...s, market: 'crypto' })),
    ...COMMODITIES.map(s => ({ ...s, market: 'commodities' })),
  ];

  const list = [...nseList, ...nonNse];
  console.log(`📋 Hourly symbol list: ${niftyStocks.length} Nifty 500 + ${extras.length} extras + ${nonNse.length} non-NSE = ${list.length} total`);
  return list;
}

// ─── Scan History ────────────────────────────────────────

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save scan history:', e.message);
  }
}

function addHistoryEntry(meta, status, errorMessage) {
  const history = loadHistory();
  history.unshift({
    id: 'scan_' + Date.now(),
    timestamp: meta.scanTime || new Date().toISOString(),
    timeframes: meta.timeframesScanned || [],
    totalSymbols: meta.totalStocks || 0,
    symbolsScanned: meta.stocksScanned || 0,
    symbolsFailed: meta.stocksFailed || 0,
    patternsFound: meta.patternsFound || 0,
    duration: meta.duration || 0,
    batch: meta.batch || null,
    status,
    errorMessage: errorMessage || null,
  });
  // Keep only last 20
  if (history.length > 20) history.length = 20;
  saveHistory(history);
  return history;
}

// ─── Results Merging ─────────────────────────────────────

/**
 * Load existing scan results from memory or file.
 */
function loadExistingResults() {
  try {
    if (scanState.lastResults && scanState.lastResults.length > 0) {
      return scanState.lastResults;
    }
    if (fs.existsSync(RESULTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
      return data.results || [];
    }
  } catch (e) { /* ignore */ }
  return [];
}

/**
 * Merge new scan results with existing results, replacing only the scanned timeframes
 * for the scanned symbols (preserves other batches' results).
 */
function mergeResults(existing, incoming, scannedKeys, scannedSymbols) {
  const merged = new Map();

  // Keep patterns from existing results, stripping only scanned timeframes for scanned symbols
  for (const stock of existing) {
    if (scannedSymbols && scannedSymbols.has(stock.symbol)) {
      // This symbol was in the batch — keep only patterns NOT in scanned timeframes
      const keptPatterns = stock.patterns.filter(p => !scannedKeys.includes(p.timeframe));
      if (keptPatterns.length > 0) {
        merged.set(stock.symbol, { ...stock, patterns: [...keptPatterns] });
      }
    } else {
      // This symbol was NOT in the batch — keep ALL patterns unchanged
      merged.set(stock.symbol, { ...stock, patterns: [...stock.patterns] });
    }
  }

  // Add/merge incoming results
  for (const stock of incoming) {
    if (merged.has(stock.symbol)) {
      const entry = merged.get(stock.symbol);
      entry.patterns.push(...stock.patterns);
      // Update price info from newer data
      if (stock.price) entry.price = stock.price;
      if (stock.dailyChange !== undefined) entry.dailyChange = stock.dailyChange;
      if (stock.weeklyChange !== undefined) entry.weeklyChange = stock.weeklyChange;
      if (stock.sparkline && stock.sparkline.length) entry.sparkline = stock.sparkline;
    } else {
      merged.set(stock.symbol, { ...stock });
    }
  }

  // Sort by max confidence
  return Array.from(merged.values())
    .filter(s => s.patterns.length > 0)
    .sort((a, b) => {
      const aMax = Math.max(...a.patterns.map(p => p.confidence));
      const bMax = Math.max(...b.patterns.map(p => p.confidence));
      return bMax - aMax;
    });
}

// ─── Symbol List Builder ─────────────────────────────────

function buildSymbolList(options = {}) {
  const {
    includeNSE = true,
    includeUS = true,
    includeCrypto = true,
    includeCommodities = true,
    nseLimit = 0,
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

// ─── Main Scan ───────────────────────────────────────────

/**
 * Run pattern scan across selected markets and timeframes.
 * @param {Object} options
 * @param {Array}  options.timeframes - e.g. ['daily'] or ['daily','weekly']. null/undefined = all.
 * @param {number} options.batch - 1-4 to scan a subset of symbols, null/undefined = all.
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
    timeframes: requestedTimeframes = null,
    batch = null,
    includeNSE = true,
    includeUS = true,
    includeCrypto = true,
    includeCommodities = true,
    nseLimit = 0,
  } = options;

  // Filter timeframes
  const activeTimeframes = requestedTimeframes
    ? TIMEFRAMES.filter(tf => requestedTimeframes.includes(tf.key))
    : TIMEFRAMES;

  if (activeTimeframes.length === 0) {
    throw new Error('No valid timeframes specified');
  }

  const isPartialScan = activeTimeframes.length < TIMEFRAMES.length || batch != null;

  // Detect hourly-only scan → use curated smaller list + 3-batch split
  const isHourlyOnly = activeTimeframes.length === 1 && activeTimeframes[0].key === 'hourly';
  const effectiveBatches = isHourlyOnly ? HOURLY_BATCHES : TOTAL_BATCHES;

  const allSymbols = overrideSymbols || (isHourlyOnly
    ? buildHourlySymbolList()
    : buildSymbolList({ includeNSE, includeUS, includeCrypto, includeCommodities, nseLimit }));
  const symbols = getSymbolsForBatch(batch, allSymbols, effectiveBatches);

  scanState.running = true;
  scanState.progress = { scanned: 0, total: symbols.length, currentSymbol: '', phase: 'starting', batch: batch || null, batchTotal: effectiveBatches };

  const startTime = Date.now();
  const tfLabels = activeTimeframes.map(t => t.label).join(', ');
  const batchLabel = batch ? ` (Batch ${batch}/${effectiveBatches})` : '';
  console.log(`\n🔍 ═══════════════════════════════════════════════`);
  console.log(`🔍  Pattern Scanner Starting — ${symbols.length} symbols${batchLabel}`);
  console.log(`🔍  Timeframes: ${tfLabels}${isPartialScan ? ' (partial)' : ''}`);
  console.log(`🔍 ═══════════════════════════════════════════════\n`);

  const allResults = [];
  let stocksScanned = 0;
  let stocksFailed = 0;

  try {
    // ── Fetch data for each active timeframe ─────────────
    const dataByTimeframe = {};
    let phaseNum = 0;
    const totalPhases = activeTimeframes.length + 1;

    for (const tf of activeTimeframes) {
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

      for (const tf of activeTimeframes) {
        const tfData = dataByTimeframe[tf.key]?.get(stock.symbol);
        if (!tfData || tfData.candles.length < tf.minCandles) continue;

        hasData = true;

        if (tf.key === 'daily' || (tf.key === 'hourly' && stockResult.price === 0)) {
          const summary = extractPriceSummary(tfData);
          stockResult.price = summary.price;
          stockResult.dailyChange = summary.dailyChange;
          stockResult.weeklyChange = summary.weeklyChange;
          stockResult.sparkline = summary.sparkline;
        }

        const maxWin = tf.key === 'hourly' ? 200 : tf.key === 'daily' ? 500 : 300;
        const patterns = scanAllPatterns(tfData.candles, {
          minCandles: tf.minCandles,
          tolerance: 0.015,
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
      timeframesScanned: activeTimeframes.map(t => t.key),
      batch: batch || null,
      batchTotal: effectiveBatches,
      markets: {
        nse: includeNSE ? NSE_SYMBOLS.length : 0,
        us: includeUS ? US_STOCKS.length : 0,
        crypto: includeCrypto ? CRYPTO.length : 0,
        commodities: includeCommodities ? COMMODITIES.length : 0,
      },
      timeframes: activeTimeframes.map(t => t.label),
    };

    // ── Merge results if partial scan ────────────────────
    let finalResults;
    if (isPartialScan) {
      const existingResults = loadExistingResults();
      const scannedSymbolSet = new Set(symbols.map(s => s.symbol));
      finalResults = mergeResults(existingResults, allResults, activeTimeframes.map(tf => tf.key), scannedSymbolSet);
    } else {
      finalResults = allResults;
    }

    // ── Update per-timeframe meta ────────────────────────
    for (const tf of activeTimeframes) {
      scanState.timeframeMeta[tf.key] = {
        scanTime: scanMeta.scanTime,
        patternsFound: allResults.reduce((sum, r) =>
          sum + r.patterns.filter(p => p.timeframe === tf.key).length, 0),
      };
    }

    // ── Generate outputs ─────────────────────────────────
    scanState.progress.phase = 'generating';
    console.log('📄 Generating dashboard & alerts...');

    const dashboardHtml = generateDashboard(finalResults, scanMeta);
    fs.writeFileSync(DASHBOARD_FILE, dashboardHtml, 'utf8');
    console.log(`   📄 Dashboard saved to ${DASHBOARD_FILE}`);

    fs.writeFileSync(RESULTS_FILE, JSON.stringify({
      results: finalResults,
      meta: scanMeta,
      timeframeMeta: scanState.timeframeMeta,
    }, null, 2), 'utf8');

    if (sendTelegram && !skipTelegram) {
      const telegramMsg = buildTelegramMessage(allResults, scanMeta, dashboardUrl);
      await sendTelegram(telegramMsg);
      console.log('   📨 Telegram summary sent');
    }

    scanState.lastScan = scanMeta.scanTime;
    scanState.lastResults = finalResults;
    scanState.lastMeta = scanMeta;
    scanState.progress.phase = 'complete';

    // ── Save to history ──────────────────────────────────
    addHistoryEntry(scanMeta, 'success');

    console.log(`\n✅ ═══════════════════════════════════════════════`);
    console.log(`✅  Scan complete in ${duration}s (${tfLabels}${batchLabel})`);
    console.log(`✅  ${stocksScanned} symbols analyzed, ${scanMeta.patternsFound} patterns found`);
    if (isPartialScan) console.log(`✅  Merged with existing results: ${finalResults.length} total stocks with patterns`);
    console.log(`✅ ═══════════════════════════════════════════════\n`);

    return { results: finalResults, meta: scanMeta };

  } catch (err) {
    console.error('❌ Scanner error:', err.message);
    scanState.progress.phase = 'error';

    // Save failed scan to history
    const duration = Math.round((Date.now() - startTime) / 1000);
    addHistoryEntry({
      scanTime: new Date().toISOString(),
      duration,
      totalStocks: symbols.length,
      stocksScanned,
      stocksFailed,
      patternsFound: 0,
      timeframesScanned: activeTimeframes.map(t => t.key),
      batch: batch || null,
    }, 'error', err.message);

    throw err;
  } finally {
    scanState.running = false;
  }
}

// ─── Telegram Message ────────────────────────────────────

function buildTelegramMessage(results, meta, dashboardUrl) {
  const lines = [
    `📊 <b>Pattern Scanner Report</b>`,
    `🕐 ${new Date(meta.scanTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
    `📈 ${meta.stocksScanned} symbols scanned in ${meta.duration}s`,
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
  buildHourlySymbolList,
  loadHistory,
  DASHBOARD_FILE,
  RESULTS_FILE,
  HISTORY_FILE,
  TOTAL_BATCHES,
  HOURLY_BATCHES,
};
