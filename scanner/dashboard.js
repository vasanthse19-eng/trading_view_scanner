'use strict';

/**
 * dashboard.js
 *
 * Generates a self-contained HTML dashboard page for chart pattern scanner results.
 * Dark trading theme, inline CSS/JS, SVG sparklines, client-side filtering.
 *
 * Usage:
 *   const { generateDashboard } = require('./dashboard');
 *   const html = generateDashboard(scanResults, scanMeta);
 */

const PATTERN_ICONS = {
  ascending_triangle: '📐⬆️',
  descending_triangle: '📐⬇️',
  symmetrical_triangle: '📐↔️',
  bull_flag: '🚩⬆️',
  bear_flag: '🚩⬇️',
  head_and_shoulders: '👤⬇️',
  inverse_head_and_shoulders: '👤⬆️'
};

const PATTERN_LABELS = {
  ascending_triangle: 'Ascending Triangle',
  descending_triangle: 'Descending Triangle',
  symmetrical_triangle: 'Symmetrical Triangle',
  bull_flag: 'Bull Flag',
  bear_flag: 'Bear Flag',
  head_and_shoulders: 'Head & Shoulders',
  inverse_head_and_shoulders: 'Inverse H&S'
};

const PATTERN_CATEGORIES = {
  ascending_triangle: 'triangles',
  descending_triangle: 'triangles',
  symmetrical_triangle: 'triangles',
  bull_flag: 'flags',
  bear_flag: 'flags',
  head_and_shoulders: 'hs',
  inverse_head_and_shoulders: 'hs'
};

function formatPrice(price) {
  return '₹' + Number(price).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatPctChange(pct) {
  const sign = pct >= 0 ? '+' : '';
  return sign + pct.toFixed(1) + '%';
}

function formatScanTime(isoString) {
  const d = new Date(isoString);
  const options = {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
    hour12: true, timeZone: 'Asia/Kolkata'
  };
  return d.toLocaleString('en-IN', options) + ' IST';
}

function generateSparklineSVG(prices) {
  if (!prices || prices.length < 2) {
    return '<svg width="120" height="30"></svg>';
  }
  const w = 120;
  const h = 30;
  const padding = 2;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const step = (w - 2 * padding) / (prices.length - 1);

  const points = prices.map((p, i) => {
    const x = padding + i * step;
    const y = h - padding - ((p - min) / range) * (h - 2 * padding);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const color = prices[prices.length - 1] >= prices[0] ? '#26a69a' : '#ef5350';

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`;
}

function confidenceColor(conf) {
  if (conf >= 80) return '#26a69a';
  if (conf >= 60) return '#f5c842';
  return '#ef5350';
}

function buildRowsJSON(scanResults) {
  const rows = [];
  for (const stock of scanResults) {
    for (const pat of (stock.patterns || [])) {
      rows.push({
        symbol: stock.symbol,
        name: stock.name || '',
        sector: stock.sector || '',
        price: stock.price,
        dailyChange: stock.dailyChange,
        weeklyChange: stock.weeklyChange,
        sparklineSVG: generateSparklineSVG(stock.sparkline),
        pattern: pat.pattern,
        patternLabel: PATTERN_LABELS[pat.pattern] || pat.pattern,
        patternIcon: PATTERN_ICONS[pat.pattern] || '📊',
        patternCategory: PATTERN_CATEGORIES[pat.pattern] || 'other',
        confidence: pat.confidence,
        direction: pat.direction,
        timeframe: pat.timeframe,
        targetPrice: pat.targetPrice,
        stopLoss: pat.stopLoss,
        breakoutPrice: pat.breakoutPrice,
        details: pat.details || {}
      });
    }
  }
  return rows;
}

function countByCategory(rows) {
  const counts = { triangles: 0, flags: 0, hs: 0, bullish: 0, bearish: 0 };
  for (const r of rows) {
    if (counts[r.patternCategory] !== undefined) counts[r.patternCategory]++;
    if (r.direction === 'bullish') counts.bullish++;
    if (r.direction === 'bearish') counts.bearish++;
  }
  return counts;
}

function generateDashboard(scanResults, scanMeta) {
  const rows = buildRowsJSON(scanResults);
  const counts = countByCategory(rows);
  const totalPatterns = rows.length;

  // We embed the rows data as JSON inside the HTML for client-side filtering
  const rowsJSON = JSON.stringify(rows.map(r => ({
    ...r,
    // sparklineSVG already generated server-side
  })));

  const scanTimeFormatted = formatScanTime(scanMeta.scanTime);
  const durationMin = Math.floor(scanMeta.duration / 60);
  const durationSec = scanMeta.duration % 60;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TradeView Pro - Pattern Scanner Dashboard</title>
<style>
/* ===== RESET & BASE ===== */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 14px; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background: #0a0e17;
  color: #d1d4dc;
  min-height: 100vh;
  line-height: 1.5;
}
a { color: #2962ff; text-decoration: none; }

/* ===== HEADER ===== */
.header {
  background: #131722;
  border-bottom: 1px solid #2a2e3e;
  padding: 16px 24px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.header-title {
  font-size: 1.4rem;
  font-weight: 700;
  color: #d1d4dc;
}
.header-title span.emoji { margin-right: 8px; }
.header-meta {
  font-size: 0.85rem;
  color: #787b86;
}
.header-meta span { margin: 0 6px; }
.header-meta .sep { color: #2a2e3e; }

/* ===== CONTAINER ===== */
.container { max-width: 1400px; margin: 0 auto; padding: 16px; }

/* ===== FILTER BAR ===== */
.filter-bar {
  background: #131722;
  border: 1px solid #2a2e3e;
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 16px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.filter-group {
  display: flex;
  align-items: center;
  gap: 4px;
}
.filter-group-label {
  font-size: 0.75rem;
  color: #787b86;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-right: 4px;
}
.filter-sep {
  width: 1px;
  height: 24px;
  background: #2a2e3e;
  margin: 0 6px;
}
.filter-btn {
  background: transparent;
  border: 1px solid #2a2e3e;
  color: #787b86;
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.filter-btn:hover {
  background: #1e2235;
  color: #d1d4dc;
}
.filter-btn.active {
  background: #2962ff;
  border-color: #2962ff;
  color: #fff;
}
.sort-select {
  background: #0a0e17;
  border: 1px solid #2a2e3e;
  color: #d1d4dc;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 0.8rem;
  cursor: pointer;
}
.search-input {
  background: #0a0e17;
  border: 1px solid #2a2e3e;
  color: #d1d4dc;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 0.85rem;
  width: 180px;
  outline: none;
  transition: border-color 0.15s;
}
.search-input:focus { border-color: #2962ff; }
.search-input::placeholder { color: #787b86; }

/* ===== SUMMARY CARDS ===== */
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.summary-card {
  background: #131722;
  border: 1px solid #2a2e3e;
  border-radius: 8px;
  padding: 16px;
  text-align: center;
  transition: background 0.15s;
}
.summary-card:hover { background: #1e2235; }
.summary-card .card-icon { font-size: 1.5rem; margin-bottom: 4px; }
.summary-card .card-count {
  font-size: 1.8rem;
  font-weight: 700;
  color: #d1d4dc;
}
.summary-card .card-label {
  font-size: 0.8rem;
  color: #787b86;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.card-count.bullish { color: #26a69a; }
.card-count.bearish { color: #ef5350; }

/* ===== RESULTS COUNT ===== */
.results-info {
  font-size: 0.85rem;
  color: #787b86;
  margin-bottom: 8px;
  padding: 0 4px;
}
.results-info strong { color: #d1d4dc; }

/* ===== TABLE ===== */
.table-wrapper {
  background: #131722;
  border: 1px solid #2a2e3e;
  border-radius: 8px;
  overflow: hidden;
}
table {
  width: 100%;
  border-collapse: collapse;
}
thead th {
  background: #0a0e17;
  color: #787b86;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid #2a2e3e;
  position: sticky;
  top: 0;
  z-index: 2;
  white-space: nowrap;
}
tbody tr {
  border-bottom: 1px solid #1e2235;
  cursor: pointer;
  transition: background 0.12s;
}
tbody tr:hover { background: #1e2235; }
tbody td {
  padding: 10px 12px;
  font-size: 0.9rem;
  vertical-align: middle;
}
td.symbol-cell {
  font-weight: 600;
  color: #d1d4dc;
}
td.symbol-cell .stock-name {
  display: block;
  font-size: 0.75rem;
  font-weight: 400;
  color: #787b86;
}
td.price-cell { font-family: 'Courier New', monospace; }
td.change-cell { font-weight: 600; }
.change-positive { color: #26a69a; }
.change-negative { color: #ef5350; }
td.pattern-cell { white-space: nowrap; }
td.sparkline-cell { padding: 6px 8px; }
td.sparkline-cell svg { display: block; }

/* Confidence bar */
.confidence-bar-wrapper {
  display: flex;
  align-items: center;
  gap: 6px;
}
.confidence-bar-bg {
  width: 50px;
  height: 6px;
  background: #2a2e3e;
  border-radius: 3px;
  overflow: hidden;
}
.confidence-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s;
}
.confidence-value {
  font-size: 0.8rem;
  font-weight: 600;
  min-width: 32px;
}

/* ===== EXPANDED ROW DETAILS ===== */
.detail-row td {
  padding: 0;
  border-bottom: 1px solid #2a2e3e;
}
.detail-content {
  background: #0d1117;
  padding: 14px 20px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.detail-item { }
.detail-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #787b86;
  margin-bottom: 2px;
}
.detail-value {
  font-size: 1rem;
  font-weight: 600;
  color: #d1d4dc;
}
.detail-value.target { color: #26a69a; }
.detail-value.stoploss { color: #ef5350; }
.detail-value.breakout { color: #2962ff; }

/* ===== FOOTER ===== */
.footer {
  text-align: center;
  padding: 24px 16px;
  color: #787b86;
  font-size: 0.8rem;
  border-top: 1px solid #2a2e3e;
  margin-top: 24px;
}
.footer strong { color: #2962ff; }

/* ===== NO RESULTS ===== */
.no-results {
  text-align: center;
  padding: 48px 16px;
  color: #787b86;
}
.no-results .nr-icon { font-size: 2.5rem; margin-bottom: 8px; }
.no-results .nr-text { font-size: 1rem; }

/* ===== MOBILE CARDS (< 768px) ===== */
@media (max-width: 768px) {
  .header { padding: 12px 16px; flex-direction: column; align-items: flex-start; }
  .filter-bar { flex-direction: column; align-items: flex-start; }
  .filter-sep { display: none; }
  .search-input { width: 100%; }

  .table-wrapper { background: transparent; border: none; }
  table, thead, tbody, th, td, tr { display: block; }
  thead { display: none; }
  tbody tr {
    background: #131722;
    border: 1px solid #2a2e3e;
    border-radius: 8px;
    margin-bottom: 10px;
    padding: 12px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 12px;
  }
  tbody tr:hover { background: #1e2235; }
  tbody td { padding: 4px 0; }
  tbody td::before {
    content: attr(data-label);
    display: block;
    font-size: 0.7rem;
    color: #787b86;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  td.symbol-cell { grid-column: 1 / -1; }
  td.sparkline-cell { grid-column: 1 / -1; }

  .detail-row td { display: block; }
  .detail-row { border: none; margin-bottom: 0; padding: 0; }
  .detail-content { grid-template-columns: 1fr 1fr; }
}
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div class="header-title"><span class="emoji">📊</span>TradeView Pro &mdash; Pattern Scanner Dashboard</div>
  <div class="header-meta">
    Last scan: <strong>${scanTimeFormatted}</strong>
    <span class="sep">|</span>
    ${scanMeta.stocksScanned.toLocaleString()}/${scanMeta.totalStocks.toLocaleString()} stocks
    <span class="sep">|</span>
    <span id="patternCountHeader">${totalPatterns}</span> patterns
    <span class="sep">|</span>
    Duration: ${durationMin}m ${durationSec}s
    ${scanMeta.stocksFailed > 0 ? `<span class="sep">|</span><span style="color:#ef5350">${scanMeta.stocksFailed} failed</span>` : ''}
  </div>
</div>

<div class="container">

  <!-- FILTER BAR -->
  <div class="filter-bar">
    <div class="filter-group">
      <span class="filter-group-label">Type:</span>
      <button class="filter-btn active" data-filter="category" data-value="all">All</button>
      <button class="filter-btn" data-filter="category" data-value="triangles">📐 Triangles</button>
      <button class="filter-btn" data-filter="category" data-value="flags">🚩 Flags</button>
      <button class="filter-btn" data-filter="category" data-value="hs">👤 H&amp;S</button>
    </div>
    <div class="filter-sep"></div>
    <div class="filter-group">
      <span class="filter-group-label">Direction:</span>
      <button class="filter-btn active" data-filter="direction" data-value="all">All</button>
      <button class="filter-btn" data-filter="direction" data-value="bullish">Bullish</button>
      <button class="filter-btn" data-filter="direction" data-value="bearish">Bearish</button>
    </div>
    <div class="filter-sep"></div>
    <div class="filter-group">
      <span class="filter-group-label">Timeframe:</span>
      <button class="filter-btn active" data-filter="timeframe" data-value="all">All</button>
      <button class="filter-btn" data-filter="timeframe" data-value="daily">Daily</button>
      <button class="filter-btn" data-filter="timeframe" data-value="weekly">Weekly</button>
    </div>
    <div class="filter-sep"></div>
    <div class="filter-group">
      <span class="filter-group-label">Sort:</span>
      <select class="sort-select" id="sortSelect">
        <option value="confidence">Confidence ▼</option>
        <option value="change">Price Change ▼</option>
        <option value="name">Stock Name A-Z</option>
      </select>
    </div>
    <div class="filter-sep"></div>
    <div class="filter-group">
      <input type="text" class="search-input" id="searchInput" placeholder="Search stock / symbol...">
    </div>
  </div>

  <!-- SUMMARY CARDS -->
  <div class="summary-grid">
    <div class="summary-card">
      <div class="card-icon">📐</div>
      <div class="card-count" id="countTriangles">${counts.triangles}</div>
      <div class="card-label">Triangles</div>
    </div>
    <div class="summary-card">
      <div class="card-icon">🚩</div>
      <div class="card-count" id="countFlags">${counts.flags}</div>
      <div class="card-label">Flags</div>
    </div>
    <div class="summary-card">
      <div class="card-icon">👤</div>
      <div class="card-count" id="countHS">${counts.hs}</div>
      <div class="card-label">H&amp;S</div>
    </div>
    <div class="summary-card">
      <div class="card-icon">📈</div>
      <div class="card-count bullish" id="countBullish">${counts.bullish}</div>
      <div class="card-label">Bullish</div>
    </div>
    <div class="summary-card">
      <div class="card-icon">📉</div>
      <div class="card-count bearish" id="countBearish">${counts.bearish}</div>
      <div class="card-label">Bearish</div>
    </div>
    <div class="summary-card">
      <div class="card-icon">🎯</div>
      <div class="card-count" id="countTotal">${totalPatterns}</div>
      <div class="card-label">Total</div>
    </div>
  </div>

  <!-- RESULTS INFO -->
  <div class="results-info">
    Showing <strong id="visibleCount">${totalPatterns}</strong> of <strong>${totalPatterns}</strong> patterns
  </div>

  <!-- TABLE -->
  <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Stock</th>
          <th>Price</th>
          <th>Daily Chg</th>
          <th>Weekly Chg</th>
          <th>Pattern</th>
          <th>Confidence</th>
          <th>Sparkline</th>
          <th>Target</th>
        </tr>
      </thead>
      <tbody id="resultsBody">
      </tbody>
    </table>
    <div class="no-results" id="noResults" style="display:none;">
      <div class="nr-icon">🔍</div>
      <div class="nr-text">No patterns match your filters</div>
    </div>
  </div>

</div>

<!-- FOOTER -->
<div class="footer">
  Powered by <strong>TradeView Pro Scanner</strong> &mdash; Data is indicative. Not financial advice.
</div>

<script>
(function() {
  'use strict';

  /* ===== DATA ===== */
  var allRows = ${rowsJSON};

  /* ===== STATE ===== */
  var filters = {
    category: 'all',
    direction: 'all',
    timeframe: 'all',
    search: '',
    sort: 'confidence'
  };
  var expandedIndex = -1;

  /* ===== FORMAT HELPERS ===== */
  function formatPrice(p) {
    return '\\u20B9' + Number(p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function formatPct(v) {
    return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  }
  function confColor(c) {
    if (c >= 80) return '#26a69a';
    if (c >= 60) return '#f5c842';
    return '#ef5350';
  }

  /* ===== FILTERING ===== */
  function applyFilters() {
    var q = filters.search.toLowerCase();
    var filtered = allRows.filter(function(r) {
      if (filters.category !== 'all' && r.patternCategory !== filters.category) return false;
      if (filters.direction !== 'all' && r.direction !== filters.direction) return false;
      if (filters.timeframe !== 'all' && r.timeframe !== filters.timeframe) return false;
      if (q && r.symbol.toLowerCase().indexOf(q) === -1 && r.name.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });

    /* Sort */
    filtered.sort(function(a, b) {
      if (filters.sort === 'confidence') return b.confidence - a.confidence;
      if (filters.sort === 'change') return b.dailyChange - a.dailyChange;
      if (filters.sort === 'name') return a.symbol.localeCompare(b.symbol);
      return 0;
    });

    return filtered;
  }

  /* ===== UPDATE SUMMARY COUNTS ===== */
  function updateCounts(filtered) {
    var ct = { triangles: 0, flags: 0, hs: 0, bullish: 0, bearish: 0 };
    filtered.forEach(function(r) {
      if (ct[r.patternCategory] !== undefined) ct[r.patternCategory]++;
      if (r.direction === 'bullish') ct.bullish++;
      if (r.direction === 'bearish') ct.bearish++;
    });
    document.getElementById('countTriangles').textContent = ct.triangles;
    document.getElementById('countFlags').textContent = ct.flags;
    document.getElementById('countHS').textContent = ct.hs;
    document.getElementById('countBullish').textContent = ct.bullish;
    document.getElementById('countBearish').textContent = ct.bearish;
    document.getElementById('countTotal').textContent = filtered.length;
    document.getElementById('visibleCount').textContent = filtered.length;
    document.getElementById('patternCountHeader').textContent = filtered.length;
  }

  /* ===== RENDER TABLE ===== */
  function render() {
    var filtered = applyFilters();
    updateCounts(filtered);
    expandedIndex = -1;

    var tbody = document.getElementById('resultsBody');
    var noRes = document.getElementById('noResults');

    if (filtered.length === 0) {
      tbody.innerHTML = '';
      noRes.style.display = 'block';
      return;
    }
    noRes.style.display = 'none';

    var html = '';
    filtered.forEach(function(r, i) {
      var dcClass = r.dailyChange >= 0 ? 'change-positive' : 'change-negative';
      var wcClass = r.weeklyChange >= 0 ? 'change-positive' : 'change-negative';
      var cc = confColor(r.confidence);

      html += '<tr data-idx="' + i + '" class="result-row">';
      html += '<td class="symbol-cell" data-label="Stock">' + escapeHtml(r.symbol) + '<span class="stock-name">' + escapeHtml(r.name) + '</span></td>';
      html += '<td class="price-cell" data-label="Price">' + formatPrice(r.price) + '</td>';
      html += '<td class="change-cell ' + dcClass + '" data-label="Daily Chg">' + formatPct(r.dailyChange) + '</td>';
      html += '<td class="change-cell ' + wcClass + '" data-label="Weekly Chg">' + formatPct(r.weeklyChange) + '</td>';
      html += '<td class="pattern-cell" data-label="Pattern">' + r.patternIcon + ' ' + escapeHtml(r.patternLabel) + '</td>';
      html += '<td data-label="Confidence"><div class="confidence-bar-wrapper">';
      html += '<div class="confidence-bar-bg"><div class="confidence-bar-fill" style="width:' + r.confidence + '%;background:' + cc + '"></div></div>';
      html += '<span class="confidence-value" style="color:' + cc + '">' + r.confidence + '%</span>';
      html += '</div></td>';
      html += '<td class="sparkline-cell" data-label="Sparkline">' + r.sparklineSVG + '</td>';
      html += '<td data-label="Target" style="color:#26a69a;font-weight:600">' + formatPrice(r.targetPrice) + '</td>';
      html += '</tr>';

      /* Detail row (hidden by default) */
      html += '<tr class="detail-row" data-detail="' + i + '" style="display:none;">';
      html += '<td colspan="8"><div class="detail-content">';
      html += '<div class="detail-item"><div class="detail-label">Pattern</div><div class="detail-value">' + r.patternIcon + ' ' + escapeHtml(r.patternLabel) + '</div></div>';
      html += '<div class="detail-item"><div class="detail-label">Direction</div><div class="detail-value" style="color:' + (r.direction === 'bullish' ? '#26a69a' : '#ef5350') + '">' + capitalize(r.direction) + '</div></div>';
      html += '<div class="detail-item"><div class="detail-label">Timeframe</div><div class="detail-value">' + capitalize(r.timeframe) + '</div></div>';
      html += '<div class="detail-item"><div class="detail-label">Breakout Price</div><div class="detail-value breakout">' + formatPrice(r.breakoutPrice) + '</div></div>';
      html += '<div class="detail-item"><div class="detail-label">Target Price</div><div class="detail-value target">' + formatPrice(r.targetPrice) + '</div></div>';
      html += '<div class="detail-item"><div class="detail-label">Stop Loss</div><div class="detail-value stoploss">' + formatPrice(r.stopLoss) + '</div></div>';
      html += '<div class="detail-item"><div class="detail-label">Sector</div><div class="detail-value">' + escapeHtml(r.sector) + '</div></div>';
      html += '<div class="detail-item"><div class="detail-label">Confidence</div><div class="detail-value" style="color:' + cc + '">' + r.confidence + '%</div></div>';
      html += '</div></td></tr>';
    });

    tbody.innerHTML = html;
    bindRowClicks();
  }

  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  /* ===== ROW EXPAND/COLLAPSE ===== */
  function bindRowClicks() {
    var rows = document.querySelectorAll('.result-row');
    rows.forEach(function(row) {
      row.addEventListener('click', function() {
        var idx = this.getAttribute('data-idx');
        var detailRow = document.querySelector('.detail-row[data-detail="' + idx + '"]');
        if (!detailRow) return;

        if (expandedIndex === parseInt(idx)) {
          detailRow.style.display = 'none';
          expandedIndex = -1;
        } else {
          /* Collapse any open */
          var open = document.querySelectorAll('.detail-row');
          open.forEach(function(d) { d.style.display = 'none'; });
          detailRow.style.display = '';
          expandedIndex = parseInt(idx);
        }
      });
    });
  }

  /* ===== FILTER BUTTON HANDLERS ===== */
  document.querySelectorAll('.filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var filterType = this.getAttribute('data-filter');
      var value = this.getAttribute('data-value');
      filters[filterType] = value;

      /* Update active state within group */
      var siblings = this.parentElement.querySelectorAll('.filter-btn');
      siblings.forEach(function(s) { s.classList.remove('active'); });
      this.classList.add('active');

      render();
    });
  });

  /* ===== SORT HANDLER ===== */
  document.getElementById('sortSelect').addEventListener('change', function() {
    filters.sort = this.value;
    render();
  });

  /* ===== SEARCH HANDLER ===== */
  var searchTimeout;
  document.getElementById('searchInput').addEventListener('input', function() {
    var val = this.value;
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(function() {
      filters.search = val;
      render();
    }, 200);
  });

  /* ===== INITIAL RENDER ===== */
  render();
})();
</script>
</body>
</html>`;
}

module.exports = { generateDashboard };
