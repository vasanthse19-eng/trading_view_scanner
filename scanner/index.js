// ==================== SCANNER ORCHESTRATOR ====================
// Coordinates data fetching, pattern detection, dashboard generation, and Telegram alerts

const path = require('path');
const fs = require('fs');
const NSE_SYMBOLS = require('./nse-symbols');
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

/**
 * Run the full pattern scan
 * @param {Object} options
 * @param {function} options.sendTelegram - Telegram send function from alert-server
 * @param {string} options.dashboardUrl - Public URL for the dashboard
 * @param {number} options.batchSize - Concurrent fetches (default: 5)
 * @param {Array} options.symbols - Override symbol list (default: all NSE)
 * @param {boolean} options.skipTelegram - Don't send Telegram (for testing)
 * @returns {Promise<{results, meta}>}
 */
async function runScan(options = {}) {
  if (scanState.running) {
    throw new Error('Scan already in progress');
  }

  const {
    sendTelegram = null,
    dashboardUrl = '',
    batchSize = 5,
    symbols = NSE_SYMBOLS,
    skipTelegram = false
  } = options;

  scanState.running = true;
  scanState.progress = { scanned: 0, total: symbols.length, currentSymbol: '', phase: 'starting' };

  const startTime = Date.now();
  console.log(`\n🔍 ═══════════════════════════════════════════════`);
  console.log(`🔍  Pattern Scanner Starting — ${symbols.length} stocks`);
  console.log(`🔍 ═══════════════════════════════════════════════\n`);

  const allResults = [];
  let stocksScanned = 0;
  let stocksFailed = 0;

  try {
    // ── Phase 1: Fetch daily data ──────────────────────────
    scanState.progress.phase = 'fetching_daily';
    console.log('📥 Phase 1/4: Fetching daily (6mo) data...');

    const dailyData = await fetchBatch(symbols, 'daily', {
      batchSize,
      batchDelay: 500,
      onProgress: (done, total, sym) => {
        scanState.progress = { scanned: done, total, currentSymbol: sym, phase: 'fetching_daily' };
        if (done % 100 === 0 || done === total) {
          console.log(`   📥 Daily: ${done}/${total} (${(done/total*100).toFixed(0)}%)`);
        }
      }
    });

    // ── Phase 2: Fetch weekly data ─────────────────────────
    scanState.progress.phase = 'fetching_weekly';
    console.log('📥 Phase 2/4: Fetching weekly (1y) data...');

    const weeklyData = await fetchBatch(symbols, 'weekly', {
      batchSize,
      batchDelay: 500,
      onProgress: (done, total, sym) => {
        scanState.progress = { scanned: done, total, currentSymbol: sym, phase: 'fetching_weekly' };
        if (done % 100 === 0 || done === total) {
          console.log(`   📥 Weekly: ${done}/${total} (${(done/total*100).toFixed(0)}%)`);
        }
      }
    });

    // ── Phase 3: Pattern detection ─────────────────────────
    scanState.progress.phase = 'analyzing';
    console.log('🧮 Phase 3/4: Running pattern detection...');

    let analyzed = 0;
    for (const stock of symbols) {
      const daily = dailyData.get(stock.symbol);
      const weekly = weeklyData.get(stock.symbol);

      if (!daily && !weekly) {
        stocksFailed++;
        continue;
      }
      stocksScanned++;

      const stockResult = {
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        price: 0,
        dailyChange: 0,
        weeklyChange: 0,
        sparkline: [],
        patterns: []
      };

      // Extract price info from daily data
      if (daily) {
        const summary = extractPriceSummary(daily);
        stockResult.price = summary.price;
        stockResult.dailyChange = summary.dailyChange;
        stockResult.weeklyChange = summary.weeklyChange;
        stockResult.sparkline = summary.sparkline;

        // Scan daily candles for patterns
        const dailyPatterns = scanAllPatterns(daily.candles);
        dailyPatterns.forEach(p => { p.timeframe = 'daily'; });
        stockResult.patterns.push(...dailyPatterns);
      }

      // Scan weekly candles for patterns
      if (weekly && weekly.candles.length >= 30) {
        const weeklyPatterns = scanAllPatterns(weekly.candles);
        weeklyPatterns.forEach(p => { p.timeframe = 'weekly'; });
        stockResult.patterns.push(...weeklyPatterns);
      }

      // Only include stocks with patterns
      if (stockResult.patterns.length > 0) {
        allResults.push(stockResult);
      }

      analyzed++;
      if (analyzed % 200 === 0) {
        scanState.progress.scanned = analyzed;
        console.log(`   🧮 Analyzed: ${analyzed}/${symbols.length}`);
      }
    }

    // Sort results by highest confidence pattern first
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
      patternsFound: allResults.reduce((sum, r) => sum + r.patterns.length, 0)
    };

    // ── Phase 4: Generate outputs ──────────────────────────
    scanState.progress.phase = 'generating';
    console.log('📄 Phase 4/4: Generating dashboard & alerts...');

    // Generate HTML dashboard
    const dashboardHtml = generateDashboard(allResults, scanMeta);
    fs.writeFileSync(DASHBOARD_FILE, dashboardHtml, 'utf8');
    console.log(`   📄 Dashboard saved to ${DASHBOARD_FILE}`);

    // Save results JSON (for API access)
    fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results: allResults, meta: scanMeta }, null, 2), 'utf8');

    // Send Telegram summary
    if (sendTelegram && !skipTelegram) {
      const telegramMsg = buildTelegramMessage(allResults, scanMeta, dashboardUrl);
      await sendTelegram(telegramMsg);
      console.log('   📨 Telegram summary sent');
    }

    // Update state
    scanState.lastScan = scanMeta.scanTime;
    scanState.lastResults = allResults;
    scanState.lastMeta = scanMeta;
    scanState.progress.phase = 'complete';

    console.log(`\n✅ ═══════════════════════════════════════════════`);
    console.log(`✅  Scan complete in ${duration}s`);
    console.log(`✅  ${stocksScanned} stocks analyzed, ${scanMeta.patternsFound} patterns found`);
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
    `📈 ${meta.stocksScanned} stocks scanned in ${meta.duration}s`,
    `🔍 <b>${meta.patternsFound} patterns found</b>`,
    ``
  ];

  // Count by pattern type
  const counts = {};
  results.forEach(r => r.patterns.forEach(p => {
    const key = p.pattern.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    counts[key] = (counts[key] || 0) + 1;
  }));
  Object.entries(counts).forEach(([k, v]) => {
    lines.push(`  • ${k}: ${v}`);
  });
  lines.push('');

  // Top 10 matches
  const top = results.slice(0, 10);
  if (top.length > 0) {
    lines.push(`🏆 <b>Top ${top.length} Matches:</b>`);
    lines.push('');
    top.forEach((r, i) => {
      const sym = r.symbol.replace('.NS', '');
      const topPattern = r.patterns[0];
      const icon = getPatternIcon(topPattern.pattern);
      const dir = topPattern.direction === 'bullish' ? '🟢' : '🔴';
      lines.push(
        `${i + 1}. ${dir} <b>${sym}</b> — ₹${r.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
        `   ${icon} ${formatPatternName(topPattern.pattern)} (${topPattern.confidence}% conf)`,
        `   Target: ₹${topPattern.targetPrice?.toLocaleString('en-IN', { maximumFractionDigits: 2 }) || 'N/A'} | SL: ₹${topPattern.stopLoss?.toLocaleString('en-IN', { maximumFractionDigits: 2 }) || 'N/A'}`,
        ``
      );
    });
  }

  if (dashboardUrl) {
    lines.push(`🔗 <a href="${dashboardUrl}/scanner-dashboard.html">View Full Dashboard</a>`);
  }

  lines.push(`\n⚡ <i>TradeView Pro Scanner</i>`);
  return lines.join('\n');
}

function getPatternIcon(pattern) {
  const icons = {
    ascending_triangle: '📐⬆️',
    descending_triangle: '📐⬇️',
    symmetrical_triangle: '📐↔️',
    bull_flag: '🚩⬆️',
    bear_flag: '🚩⬇️',
    head_and_shoulders: '👤⬇️',
    inverse_head_and_shoulders: '👤⬆️'
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
  DASHBOARD_FILE,
  RESULTS_FILE
};
