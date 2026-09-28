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
      // Binance REST API
      const pair = symbol.toUpperCase();
      const resp = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
      const data = await resp.json();
      return parseFloat(data.price);
    } else {
      // Yahoo Finance for stocks, NSE, BSE
      const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1m`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const data = await resp.json();
      const meta = data.chart?.result?.[0]?.meta;
      if (meta && meta.regularMarketPrice) {
        return meta.regularMarketPrice;
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
    const price = await fetchPrice(group.symbol, group.market);
    if (price === null) continue;

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
    const { range = '1mo', interval = '60m' } = req.query;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const data = await response.json();
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
});
