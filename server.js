/**
 * TradeView Pro — Express Proxy Server for Yahoo Finance
 *
 * Proxies requests to Yahoo Finance API to avoid CORS issues
 * when running the trading terminal from a hosted environment.
 * Requires Node 18+ (uses built-in fetch).
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const YAHOO_BASE = 'https://query1.finance.yahoo.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/*  Middleware                                                         */
/* ------------------------------------------------------------------ */

// CORS — allow any origin so the front-end can be served separately
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Request logging
app.use((req, _res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  next();
});

// Serve static files (index.html, JS, CSS, etc.) from the project root
app.use(express.static(path.join(__dirname)));

/* ------------------------------------------------------------------ */
/*  Yahoo Finance proxy routes                                        */
/* ------------------------------------------------------------------ */

/**
 * GET /api/yahoo/chart/:symbol
 * Proxies to Yahoo Finance v8 chart endpoint.
 * Query params forwarded: range, interval
 */
app.get('/api/yahoo/chart/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { range, interval } = req.query;

    const params = new URLSearchParams();
    if (range) params.set('range', range);
    if (interval) params.set('interval', interval);

    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;

    console.log(`  -> Proxying chart request: ${url}`);

    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Chart proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch chart data', details: err.message });
  }
});

/**
 * GET /api/yahoo/search?q=<query>
 * Proxies to Yahoo Finance v1 search endpoint.
 */
app.get('/api/yahoo/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Missing required query parameter: q' });
    }

    const params = new URLSearchParams({
      q,
      quotesCount: '10',
      newsCount: '0',
    });

    const url = `${YAHOO_BASE}/v1/finance/search?${params}`;

    console.log(`  -> Proxying search request: ${url}`);

    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Search proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch search results', details: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Start server                                                      */
/* ------------------------------------------------------------------ */

app.listen(PORT, () => {
  console.log(`TradeView Pro server running on http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop.');
});
