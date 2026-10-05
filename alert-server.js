const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// ==================== CONFIG ====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 60000; // 60 seconds
const ALERTS_FILE = path.join(__dirname, 'alerts.json');

// ==================== CORS ====================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ==================== ALERT STORAGE ====================
let alerts = [];
let alertHistory = [];
let lastPrices = {}; // symbol -> { price, time }

// ==================== YAHOO CHART CACHE ====================
const chartCache = {};  // key: "SYMBOL:range:interval" -> { data, timestamp }

function getCacheTTL(interval) {
  if (['1m','2m','5m','15m','60m'].includes(interval)) return 5 * 60 * 1000;  // 5 min
  if (interval === '1d') return 60 * 60 * 1000;        // 1 hour
  return 6 * 60 * 60 * 1000;                           // 6 hours for weekly/monthly
}

function getFromCache(key, interval) {
  const entry = chartCache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > getCacheTTL(interval)) {
    delete chartCache[key];
    return null;
  }
  return entry.data;
}

function putInCache(key, data) {
  const keys = Object.keys(chartCache);
  if (keys.length > 100) {
    let oldest = keys[0], oldestTime = chartCache[keys[0]].timestamp;
    keys.forEach(k => {
      if (chartCache[k].timestamp < oldestTime) { oldest = k; oldestTime = chartCache[k].timestamp; }
    });
    delete chartCache[oldest];
  }
  chartCache[key] = { data, timestamp: Date.now() };
}

function loadAlerts() {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
      alerts = data.alerts || [];
      alertHistory = data.alertHistory || [];
      console.log(`✅ Loaded ${alerts.length} alerts, ${alertHistory.length} history records`);
    }
  } catch (e) {
    console.error('Error loading alerts:', e.message);
  }
}

function saveAlerts() {
  try {
    fs.writeFileSync(ALERTS_FILE, JSON.stringify({ alerts, alertHistory }, null, 2));
  } catch (e) {
    console.error('Error saving alerts:', e.message);
  }
}

// ==================== TELEGRAM ====================
async function sendTelegram(message) {
  const chatId = TELEGRAM_CHAT_ID;
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    console.log('⚠️ Telegram not configured. Message:', message);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
    const data = await resp.json();
    if (!data.ok) console.error('Telegram error:', data.description);
    else console.log('📨 Telegram message sent');
  } catch (e) {
    console.error('Telegram send error:', e.message);
  }
}

// Auto-detect chat ID from bot messages
async function detectChatId() {
  if (TELEGRAM_CHAT_ID || !TELEGRAM_BOT_TOKEN) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=5`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.ok && data.result.length > 0) {
      const chatId = data.result[0].message?.chat?.id;
      if (chatId) {
        console.log(`🔍 Auto-detected Telegram Chat ID: ${chatId}`);
        console.log(`   Set TELEGRAM_CHAT_ID=${chatId} in your Render environment variables`);
        process.env.TELEGRAM_CHAT_ID = String(chatId);
      }
    }
  } catch (e) {
    console.error('Chat ID detection error:', e.message);
  }
}

// ==================== PRICE FETCHING ====================
async function fetchPrice(symbol, market) {
  try {
    if (market === 'crypto') {
      // Try Binance first
      try {
        const pair = symbol.toUpperCase();
        const resp = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`, {
          signal: AbortSignal.timeout(5000)
        });
        const data = await resp.json();
        if (data.lastPrice && !data.code) {
          return { price: parseFloat(data.lastPrice), change: parseFloat(data.priceChangePercent) || 0 };
        }
      } catch(e) { /* Binance blocked/failed, fall through to Yahoo */ }

      // Fallback: Yahoo Finance for crypto (BTCUSDT → BTC-USD)
      const yahooSymbol = symbol.replace('USDT', '-USD').replace('BUSD', '-USD').replace('USDC', '-USD');
      const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?range=1d&interval=1m`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const data = await resp.json();
      const meta = data.chart?.result?.[0]?.meta;
      if (meta && meta.regularMarketPrice) {
        const price = meta.regularMarketPrice;
        const prevClose = meta.previousClose || meta.chartPreviousClose || price;
        const change = prevClose > 0 ? ((price - prevClose) / prevClose * 100) : 0;
        return { price, change };
      }
    } else {
      // Yahoo Finance for stocks, NSE, BSE
      const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1m`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const data = await resp.json();
      const meta = data.chart?.result?.[0]?.meta;
      if (meta && meta.regularMarketPrice) {
        const price = meta.regularMarketPrice;
        const prevClose = meta.previousClose || meta.chartPreviousClose || price;
        const change = prevClose > 0 ? ((price - prevClose) / prevClose * 100) : 0;
        return { price, change };
      }
    }
  } catch (e) {
    // Silent fail - will retry next cycle
  }
  return null;
}

// ==================== ALERT CHECKER ====================
async function checkAllAlerts() {
  const enabledAlerts = alerts.filter(a => a.enabled);
  if (enabledAlerts.length === 0) return;

  // Group alerts by symbol to minimize API calls
  const symbolGroups = {};
  enabledAlerts.forEach(a => {
    const key = `${a.symbol}|${a.market}`;
    if (!symbolGroups[key]) symbolGroups[key] = { symbol: a.symbol, market: a.market, alerts: [] };
    symbolGroups[key].alerts.push(a);
  });

  const now = new Date();
  const timeStr = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  for (const key of Object.keys(symbolGroups)) {
    const group = symbolGroups[key];
    const result = await fetchPrice(group.symbol, group.market);
    if (result === null) continue;

    const price = result.price;
    const prevData = lastPrices[group.symbol];
    const currency = (group.market === 'nse' || group.market === 'bse') ? '₹' : '$';
    const displaySymbol = group.symbol.replace('USDT', '').replace('.NS', ' (NSE)').replace('.BO', ' (BSE)');

    for (const alert of group.alerts) {
      let triggered = false;
      let direction = '';

      switch (alert.type) {
        case 'price_above':
          if (price > alert.value) { triggered = true; direction = '⬆️ Above'; }
          break;
        case 'price_below':
          if (price < alert.value) { triggered = true; direction = '⬇️ Below'; }
          break;
        case 'rsi_overbought':
          // RSI needs candle data - skip for server-side (handled by frontend)
          break;
        case 'rsi_oversold':
          break;
        case 'percent_change_up':
          if (prevData && prevData.price > 0) {
            const pctChange = ((price - prevData.price) / prevData.price) * 100;
            if (pctChange >= alert.value) { triggered = true; direction = `⬆️ +${pctChange.toFixed(2)}%`; }
          }
          break;
        case 'percent_change_down':
          if (prevData && prevData.price > 0) {
            const pctChange = ((price - prevData.price) / prevData.price) * 100;
            if (pctChange <= -alert.value) { triggered = true; direction = `⬇️ ${pctChange.toFixed(2)}%`; }
          }
          break;
      }

      if (triggered) {
        alert.enabled = false;
        const record = {
          alertId: alert.id,
          symbol: alert.symbol,
          type: alert.type,
          triggeredAt: Date.now(),
          priceAtTrigger: price,
          message: `${displaySymbol} — ${alert.description}`
        };
        alertHistory.unshift(record);
        if (alertHistory.length > 500) alertHistory.length = 500;
        saveAlerts();

        // Send Telegram notification
        const msg = [
          `🔔 <b>ALERT TRIGGERED!</b>`,
          ``,
          `📈 <b>${displaySymbol}</b> hit <b>${currency}${price.toLocaleString()}</b>`,
          `${direction} Target: ${currency}${alert.value?.toLocaleString() || 'N/A'}`,
          `📋 ${alert.description}`,
          `🕐 ${timeStr} IST`,
        ].join('\n');

        await sendTelegram(msg);
        console.log(`🔔 Alert triggered: ${alert.description} @ ${currency}${price}`);
      }
    }

    // Store last price for percent change alerts
    lastPrices[group.symbol] = { price, time: Date.now() };

    // Small delay between symbols to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }
}

// ==================== API ROUTES ====================

// Health check (for UptimeRobot)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    alerts: alerts.filter(a => a.enabled).length,
    totalAlerts: alerts.length,
    lastCheck: new Date().toISOString(),
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && (TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID))
  });
});

// Get all alerts
app.get('/api/alerts', (req, res) => {
  res.json({ alerts, alertHistory: alertHistory.slice(0, 100) });
});

// ==================== BULK PRICE ENDPOINT ====================
// Frontend calls this every 60s to get ALL watchlist prices at once
app.post('/api/prices/bulk', async (req, res) => {
  const { symbols } = req.body; // [{symbol, market}]
  if (!Array.isArray(symbols)) return res.status(400).json({ error: 'symbols array required' });

  const results = {};
  const batchSize = 5; // fetch 5 at a time to avoid rate limits

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const promises = batch.map(async (s) => {
      try {
        const result = await fetchPrice(s.symbol, s.market);
        if (result !== null) {
          results[s.symbol] = { price: result.price, change: result.change, time: Date.now() };
          lastPrices[s.symbol] = { price: result.price, time: Date.now() };
        }
      } catch (e) { /* skip */ }
    });
    await Promise.all(promises);
    // Small delay between batches
    if (i + batchSize < symbols.length) await new Promise(r => setTimeout(r, 300));
  }

  res.json({ prices: results, timestamp: Date.now() });
});

// Get single stock price
app.get('/api/price/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const market = req.query.market || (symbol.includes('.NS') ? 'nse' : symbol.includes('.BO') ? 'bse' : symbol.endsWith('USDT') ? 'crypto' : 'stocks');
  const result = await fetchPrice(symbol, market);
  if (result !== null) {
    lastPrices[symbol] = { price: result.price, time: Date.now() };
    res.json({ symbol, price: result.price, change: result.change, time: Date.now() });
  } else {
    res.status(404).json({ error: 'Could not fetch price' });
  }
});

// Create alert
app.post('/api/alerts', (req, res) => {
  const { symbol, market, type, value, description } = req.body;
  if (!symbol || !type) return res.status(400).json({ error: 'symbol and type required' });

  const alert = {
    id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    symbol, market: market || 'crypto', type,
    value: value ? parseFloat(value) : null,
    enabled: true,
    description: description || `${symbol} ${type} ${value || ''}`,
    createdAt: Date.now(),
    source: 'server'
  };
  alerts.push(alert);
  saveAlerts();
  console.log(`➕ Alert created: ${alert.description}`);
  res.json({ success: true, alert });
});

// Sync alerts from frontend (bulk replace)
app.post('/api/alerts/sync', (req, res) => {
  const { alerts: frontendAlerts } = req.body;
  if (!Array.isArray(frontendAlerts)) return res.status(400).json({ error: 'alerts array required' });

  // Merge: keep server alerts, add/update frontend alerts
  const serverAlerts = alerts.filter(a => a.source === 'server');
  const synced = [...serverAlerts, ...frontendAlerts.map(a => ({ ...a, source: 'frontend' }))];
  alerts = synced;
  saveAlerts();
  console.log(`🔄 Synced ${frontendAlerts.length} alerts from frontend`);
  res.json({ success: true, totalAlerts: alerts.length });
});

// Delete alert
app.delete('/api/alerts/:id', (req, res) => {
  const before = alerts.length;
  alerts = alerts.filter(a => a.id !== req.params.id);
  if (alerts.length < before) {
    saveAlerts();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Alert not found' });
  }
});

// Send test notification
app.post('/api/alerts/test', async (req, res) => {
  const msg = [
    `🧪 <b>TEST NOTIFICATION</b>`,
    ``,
    `✅ TradeView Pro Alert Server is working!`,
    `📊 Monitoring ${alerts.filter(a => a.enabled).length} active alerts`,
    `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
  ].join('\n');
  await sendTelegram(msg);
  res.json({ success: true, message: 'Test notification sent to Telegram' });
});

// Get detected chat ID
app.get('/api/telegram/chatid', async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) return res.json({ error: 'TELEGRAM_BOT_TOKEN not set' });
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=5`;
    const resp = await fetch(url);
    const data = await resp.json();
    const chatIds = [];
    if (data.ok) {
      data.result.forEach(u => {
        const chatId = u.message?.chat?.id;
        const username = u.message?.chat?.username || u.message?.chat?.first_name;
        if (chatId) chatIds.push({ chatId, username });
      });
    }
    res.json({ chatIds, currentChatId: TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Add all NSE/BSE stocks alerts (bulk)
app.post('/api/alerts/bulk', (req, res) => {
  const { stockAlerts } = req.body;
  if (!Array.isArray(stockAlerts)) return res.status(400).json({ error: 'stockAlerts array required' });
  let added = 0;
  stockAlerts.forEach(sa => {
    const alert = {
      id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + added,
      symbol: sa.symbol, market: sa.market || 'nse', type: sa.type || 'price_above',
      value: sa.value ? parseFloat(sa.value) : null,
      enabled: true,
      description: sa.description || `${sa.symbol} ${sa.type} ${sa.value}`,
      createdAt: Date.now(),
      source: 'server'
    };
    alerts.push(alert);
    added++;
  });
  saveAlerts();
  console.log(`➕ Bulk added ${added} alerts`);
  res.json({ success: true, added, totalAlerts: alerts.length });
});

// ==================== YAHOO FINANCE PROXY ====================
app.get('/api/yahoo/chart/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { range = '1mo', interval = '60m', period1, period2 } = req.query;

    // Build URL and cache key based on whether period1/period2 are provided
    let yahooUrl, cacheKey;
    if (period1) {
      const p2 = period2 || Math.floor(Date.now() / 1000);
      yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${p2}&interval=${interval}`;
      cacheKey = `${symbol}:p${period1}-${p2}:${interval}`;
    } else {
      yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
      cacheKey = `${symbol}:${range}:${interval}`;
    }

    // Serve from cache if available
    const cached = getFromCache(cacheKey, interval);
    if (cached) {
      const maxAge = ['1d','1wk','1mo'].includes(interval) ? 3600 : 300;
      res.set('Cache-Control', `public, max-age=${maxAge}`);
      return res.json(cached);
    }

    const response = await fetch(yahooUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const data = await response.json();

    // Cache successful responses
    if (data.chart && data.chart.result && data.chart.result.length > 0) {
      putInCache(cacheKey, data);
    }

    const maxAge = ['1d','1wk','1mo'].includes(interval) ? 3600 : 300;
    res.set('Cache-Control', `public, max-age=${maxAge}`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/yahoo/search', async (req, res) => {
  try {
    const { q } = req.query;
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SCANNER ====================
const scannerRoutes = require('./scanner/routes');
const scanner = require('./scanner/index');
app.use('/api/scanner', scannerRoutes);

// Make sendTelegram available to scanner routes
app.locals.sendTelegram = sendTelegram;
app.locals.dashboardUrl = process.env.RENDER_EXTERNAL_URL || process.env.DASHBOARD_URL || '';

// ==================== STATIC FILES ====================
app.use(express.static(path.join(__dirname)));

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  🚀 TradeView Pro Alert Server                   ║
║  📡 Running on port ${PORT}                          ║
║  🔔 Telegram: ${TELEGRAM_BOT_TOKEN ? '✅ Configured' : '❌ Set TELEGRAM_BOT_TOKEN'}       ║
║  💬 Chat ID: ${(TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID) ? '✅ Set' : '⚠️  Set TELEGRAM_CHAT_ID'}               ║
║  ⏱️  Check interval: ${CHECK_INTERVAL / 1000}s                       ║
╚══════════════════════════════════════════════════╝
  `);

  // Load saved alerts
  loadAlerts();

  // Auto-detect Telegram chat ID
  await detectChatId();

  // Send startup message
  if (TELEGRAM_BOT_TOKEN && (TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID)) {
    await sendTelegram(`🟢 <b>TradeView Pro Alert Server Started!</b>\n\n📊 Monitoring ${alerts.filter(a => a.enabled).length} active alerts\n⏱️ Checking every ${CHECK_INTERVAL / 1000} seconds`);
  }

  // Start alert checker loop
  console.log('🔄 Starting alert checker...');
  setInterval(async () => {
    try {
      await checkAllAlerts();
    } catch (e) {
      console.error('Alert check error:', e.message);
    }
  }, CHECK_INTERVAL);

  // ── Daily Pattern Scanner Cron — 7:00 PM IST (13:30 UTC) ──
  function scheduleDailyScan() {
    const now = new Date();
    // 7:00 PM IST = 13:30 UTC
    const targetHour = 13;
    const targetMin = 30;

    let next = new Date(now);
    next.setUTCHours(targetHour, targetMin, 0, 0);

    // If already past today's target, schedule for tomorrow
    if (next <= now) {
      next.setUTCDate(next.getUTCDate() + 1);
    }

    const msUntil = next - now;
    const hoursUntil = (msUntil / 3600000).toFixed(1);
    console.log(`📅 Next pattern scan scheduled at 7:00 PM IST (in ${hoursUntil}h)`);

    setTimeout(async () => {
      console.log('⏰ Scheduled daily pattern scan triggered!');
      try {
        await scanner.runScan({
          sendTelegram,
          dashboardUrl: app.locals.dashboardUrl,
          batchSize: 5,
          timeframes: ['daily', 'weekly']  // Skip hourly to avoid Yahoo rate limits
        });
      } catch (e) {
        console.error('❌ Scheduled scan error:', e.message);
      }
      // Schedule next day's scan
      scheduleDailyScan();
    }, msUntil);
  }
  scheduleDailyScan();
});
