// ==================== SCANNER ROUTES ====================
// Express routes for the pattern scanner API

const express = require('express');
const path = require('path');
const fs = require('fs');
const scanner = require('./index');

const router = express.Router();

// ── POST /api/scanner/run — Trigger manual scan ──────────
router.post('/run', async (req, res) => {
  const state = scanner.getState();
  if (state.running) {
    return res.status(409).json({
      error: 'Scan already in progress',
      progress: state.progress
    });
  }

  // Get options from request body
  const { batchSize, skipTelegram } = req.body || {};

  // Start scan in background (don't await — return immediately)
  const scanPromise = scanner.runScan({
    sendTelegram: req.app.locals.sendTelegram || null,
    dashboardUrl: req.app.locals.dashboardUrl || '',
    batchSize: batchSize || 5,
    skipTelegram: skipTelegram || false
  });

  // Handle completion logging
  scanPromise
    .then(({ meta }) => {
      console.log(`✅ Manual scan completed: ${meta.patternsFound} patterns found`);
    })
    .catch(err => {
      console.error('❌ Manual scan failed:', err.message);
    });

  res.json({
    success: true,
    message: 'Scan started in background',
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
    lastMeta: state.lastMeta
  });
});

// ── GET /api/scanner/results — Get latest results ────────
router.get('/results', (req, res) => {
  const state = scanner.getState();

  if (!state.lastResults || state.lastResults.length === 0) {
    // Try loading from file
    try {
      const filePath = scanner.RESULTS_FILE;
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return res.json(data);
      }
    } catch (e) { /* ignore */ }
    return res.json({ results: [], meta: null, message: 'No scan results yet. Trigger a scan via POST /api/scanner/run' });
  }

  // Support filters via query params
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
      r.sector.toLowerCase().includes(q)
    );
  }
  if (limit) {
    results = results.slice(0, parseInt(limit));
  }

  res.json({ results, meta: state.lastMeta });
});

// ── GET /api/scanner/dashboard — Serve the HTML dashboard ──
router.get('/dashboard', (req, res) => {
  const dashPath = scanner.DASHBOARD_FILE;
  if (fs.existsSync(dashPath)) {
    res.sendFile(dashPath);
  } else {
    res.status(404).send(`
      <html><body style="background:#0a0e17;color:#d1d4dc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="text-align:center;">
          <h1>📊 No Scan Results Yet</h1>
          <p>Trigger a scan via POST /api/scanner/run</p>
          <p style="color:#787b86;">The scanner runs automatically daily at 7:00 PM IST</p>
        </div>
      </body></html>
    `);
  }
});

// ── GET /api/scanner/symbols — List all scan symbols (multi-market) ──────
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

  // Get unique sectors for filter
  const sectors = [...new Set(symbols.map(s => s.sector))].sort();

  res.json({ symbols, total, sectors });
});

module.exports = router;
