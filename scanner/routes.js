// ==================== SCANNER ROUTES ====================
// Express routes for the pattern scanner API

const express = require('express');
const path = require('path');
const fs = require('fs');
const scanner = require('./index');

const router = express.Router();

// ── POST /api/scanner/run — Trigger scan (optionally per-timeframe) ──
router.post('/run', async (req, res) => {
  const state = scanner.getState();
  if (state.running) {
    return res.status(409).json({
      error: 'Scan already in progress',
      progress: state.progress
    });
  }

  const { batchSize, skipTelegram, timeframe } = req.body || {};

  // Normalize timeframe input: string → array, validate
  let timeframes = null; // null = all
  if (timeframe) {
    const valid = ['hourly', 'daily', 'weekly'];
    if (typeof timeframe === 'string') {
      timeframes = valid.includes(timeframe) ? [timeframe] : null;
    } else if (Array.isArray(timeframe)) {
      timeframes = timeframe.filter(t => valid.includes(t));
      if (timeframes.length === 0) timeframes = null;
    }
  }

  const scanPromise = scanner.runScan({
    sendTelegram: req.app.locals.sendTelegram || null,
    dashboardUrl: req.app.locals.dashboardUrl || '',
    batchSize: batchSize || 5,
    skipTelegram: skipTelegram || false,
    timeframes,
  });

  const tfLabel = timeframes ? timeframes.join(', ') : 'all';

  scanPromise
    .then(({ meta }) => {
      console.log(`✅ Manual scan (${tfLabel}) completed: ${meta.patternsFound} patterns found`);
    })
    .catch(err => {
      console.error(`❌ Manual scan (${tfLabel}) failed:`, err.message);
    });

  res.json({
    success: true,
    message: `Scan started for ${tfLabel} timeframe(s)`,
    progress: scanner.getState().progress
  });
});

// ── GET /api/scanner/status — Get scan progress ─────────
router.get('/status', (req, res) => {
  const state = scanner.getState();
  res.json({
    running: state.running,
    progress: state.progress,
    lastScan: state.lastScan,
    lastMeta: state.lastMeta,
    timeframeMeta: state.timeframeMeta || {},
  });
});

// ── GET /api/scanner/results — Get latest results ────────
router.get('/results', (req, res) => {
  const state = scanner.getState();

  if (!state.lastResults || state.lastResults.length === 0) {
    try {
      const filePath = scanner.RESULTS_FILE;
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return res.json(data);
      }
    } catch (e) { /* ignore */ }
    return res.json({ results: [], meta: null, message: 'No scan results yet. Trigger a scan via POST /api/scanner/run' });
  }

  let results = [...state.lastResults];
  const { pattern, direction, timeframe, minConfidence, search, limit } = req.query;

  if (pattern) {
    results = results.filter(r => r.patterns.some(p => p.pattern.includes(pattern)));
  }
  if (direction) {
    results = results.filter(r => r.patterns.some(p => p.direction === direction));
  }
  if (timeframe) {
    results = results.filter(r => r.patterns.some(p => p.timeframe === timeframe));
  }
  if (minConfidence) {
    const min = parseInt(minConfidence);
    results = results.filter(r => r.patterns.some(p => p.confidence >= min));
  }
  if (search) {
    const q = search.toLowerCase();
    results = results.filter(r =>
      r.symbol.toLowerCase().includes(q) ||
      r.name.toLowerCase().includes(q) ||
      (r.sector || '').toLowerCase().includes(q)
    );
  }
  if (limit) {
    results = results.slice(0, parseInt(limit));
  }

  res.json({ results, meta: state.lastMeta });
});

// ── GET /api/scanner/history — Scan history ──────────────
router.get('/history', (req, res) => {
  const history = scanner.loadHistory();
  res.json({ history });
});

// ── GET /api/scanner/dashboard — Serve the HTML dashboard ──
router.get('/dashboard', (req, res) => {
  const dashPath = scanner.DASHBOARD_FILE;
  if (fs.existsSync(dashPath)) {
    res.sendFile(dashPath);
  } else {
    // Generate a live dashboard with empty results so buttons/history are available
    const { generateDashboard } = require('./dashboard');
    const emptyMeta = {
      scanTime: null,
      duration: 0,
      totalStocks: 0,
      stocksScanned: 0,
      stocksFailed: 0,
      patternsFound: 0,
      timeframesScanned: [],
      markets: { nse: 0, us: 0, crypto: 0, commodities: 0 },
      timeframes: [],
    };
    try {
      const html = generateDashboard([], emptyMeta);
      // Save it so next request serves the file directly
      fs.writeFileSync(dashPath, html, 'utf8');
      res.send(html);
    } catch (e) {
      console.error('Failed to generate empty dashboard:', e.message);
      res.status(500).send(`
        <html><body style="background:#0a0e17;color:#d1d4dc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
          <div style="text-align:center;">
            <h1>📊 Dashboard Error</h1>
            <p>Could not generate dashboard: ${e.message}</p>
            <p style="color:#787b86;">Try triggering a scan via POST /api/scanner/run</p>
          </div>
        </body></html>
      `);
    }
  }
});

// ── GET /api/scanner/symbols — List all scan symbols (multi-market) ──
router.get('/symbols', (req, res) => {
  const { buildSymbolList } = require('./index');
  const { sector, search, limit, market } = req.query;
  let symbols = buildSymbolList();

  if (market) {
    symbols = symbols.filter(s => s.market === market);
  }
  if (sector) {
    symbols = symbols.filter(s => s.sector.toLowerCase() === sector.toLowerCase());
  }
  if (search) {
    const q = search.toLowerCase();
    symbols = symbols.filter(s =>
      s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
    );
  }

  const total = symbols.length;
  if (limit) symbols = symbols.slice(0, parseInt(limit));

  const sectors = [...new Set(symbols.map(s => s.sector))].sort();

  res.json({ symbols, total, sectors });
});

module.exports = router;
