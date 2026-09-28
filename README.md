# TradeView Pro

A **free, open-source TradingView-like trading terminal** that runs entirely in
your browser. No account required, no subscription fees -- just real-time charts,
technical indicators, drawing tools, and smart alerts powered by free market-data
APIs.

---

## Features

- **Real-time candlestick charts** with adjustable timeframes (1m to 1M)
- **6 technical indicators** -- SMA, EMA, RSI, MACD, Bollinger Bands, Volume
- **11 alert types** including price cross, percentage change, volume spike,
  RSI overbought/oversold, MACD cross, Bollinger Band breakout, and
  **trendline alerts** tied to your drawings
- **Drawing tools** -- trendlines, horizontal lines, rectangles, Fibonacci
  retracements
- **Watchlist** with quick-switch between symbols
- **Multi-source data** -- Binance WebSocket, CoinGecko REST, Yahoo Finance
  (via proxy), Finnhub WebSocket
- **Dark / light theme** toggle
- **Fully client-side** -- works by opening `index.html` directly; the Express
  server is optional (needed only for the Yahoo Finance proxy)

---

## Free Data Sources

| Source | Asset Types | Method |
|--------------|----------------------|---------------------|
| **Binance** | Crypto (BTC, ETH...) | WebSocket (free) |
| **CoinGecko**| Crypto market data | REST API (free tier) |
| **Yahoo Finance** | Stocks, ETFs, Forex | REST via Express proxy |
| **Finnhub** | US stocks, forex | WebSocket (free key) |

---

## Quick Start

### Option A -- Static (no server)

Just open the file in your browser:

```
index.html
```

Crypto data (Binance, CoinGecko) works out of the box. Yahoo Finance and
Finnhub require the server or an API key (see below).

### Option B -- With Express Proxy (recommended)

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

The Express server:
- Serves all static files
- Proxies Yahoo Finance requests to avoid CORS issues
- Requires **Node.js 18+** (uses built-in `fetch`)

---

## Finnhub API Key (optional, free)

To enable real-time US stock data via Finnhub:

1. Sign up at [https://finnhub.io/register](https://finnhub.io/register)
2. Copy your free API key from the dashboard
3. Paste it into the API key input field in the app settings panel

The free tier allows 60 calls/minute and real-time WebSocket streaming for US
stocks.

---

## Deployment

### GitHub Pages

1. Push the repo to GitHub
2. Go to **Settings > Pages**
3. Set source to the branch and root folder (`/`)
4. Your site will be live at `https://<user>.github.io/<repo>/`

> Note: Yahoo Finance proxy will not work on GitHub Pages (static hosting only).
> Crypto data sources work fine.

### Netlify

1. Push the repo to GitHub
2. Log in to [netlify.com](https://netlify.com) and click **Add new site > Import an existing project**
3. Select your repo; publish directory is `.`
4. Click **Deploy**

The included `netlify.toml` handles headers automatically. For the Yahoo proxy
you will need to add a Netlify Function -- the static deploy does not run
`server.js`.

### Vercel

1. Push the repo to GitHub
2. Import the project at [vercel.com/new](https://vercel.com/new)
3. Vercel auto-detects the `vercel.json` configuration
4. The server routes (`/api/*`) are deployed as serverless functions

### Render

1. Push the repo to GitHub
2. Create a new **Web Service** on [render.com](https://render.com)
3. Set:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
4. Render reads the `Procfile` automatically if you prefer that route

---

## Alert Types Explained

| # | Alert | Trigger |
|---|--------------------------|------------------------------------------------|
| 1 | Price crosses value | Price moves above or below a fixed level |
| 2 | Price percent change | Price moves X% from the alert-creation price |
| 3 | Volume spike | Volume exceeds N times the 20-period average |
| 4 | RSI overbought | RSI rises above 70 |
| 5 | RSI oversold | RSI falls below 30 |
| 6 | MACD bullish cross | MACD line crosses above the signal line |
| 7 | MACD bearish cross | MACD line crosses below the signal line |
| 8 | Bollinger upper breakout | Price closes above the upper Bollinger Band |
| 9 | Bollinger lower breakout | Price closes below the lower Bollinger Band |
|10 | SMA/EMA cross up | Price crosses above the selected moving average |
|11 | Trendline alert | Price touches or crosses a drawn trendline |

Alerts fire once and can be configured to auto-dismiss or persist until manually
cleared.

---

## Drawing Tools and Shortcuts

| Tool | Description |
|----------------------|------------------------------------------------|
| Trendline | Click two points to draw a trend line |
| Horizontal line | Click once to place a horizontal price level |
| Rectangle | Click two corners to draw a zone |
| Fibonacci retracement| Click swing high and swing low |

**Keyboard shortcuts:**

| Key | Action |
|-----|-------------------------------------------|
| `T` | Activate trendline tool |
| `H` | Activate horizontal line tool |
| `R` | Activate rectangle tool |
| `F` | Activate Fibonacci tool |
| `Esc` | Cancel current drawing / deselect tool |
| `Delete` | Remove selected drawing |
| `+` / `-` | Zoom in / out on the chart |
| Scroll | Pan the chart horizontally |

---

## Limitations and Known Issues

- **Yahoo Finance proxy required** -- Yahoo blocks direct browser requests
  (CORS). The Express server or a serverless proxy is needed for stock data.
- **Finnhub free tier** -- limited to 60 API calls per minute; exceeding the
  limit returns errors until the window resets.
- **No historical back-fill** -- data starts from the moment you open the app
  for WebSocket sources; REST sources provide up to 1 year of daily candles.
- **Browser storage only** -- watchlists, alerts, and drawings are saved in
  `localStorage`. Clearing browser data removes them.
- **Single-tab alerts** -- alerts are evaluated in the active tab only; closing
  the tab stops alert monitoring.
- **Not financial advice** -- this is a visualization and learning tool, not a
  trading platform. Always do your own research.

---

## License

MIT
