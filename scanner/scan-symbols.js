// ==================== SCAN SYMBOLS ====================
// Multi-market symbol lists for the pattern scanner
// Includes: NSE, US Stocks, Crypto, Commodities (XAUUSD etc.)

'use strict';

// ── Top US Stocks by market cap ──
const US_STOCKS = [
  { symbol: 'AAPL',  name: 'Apple',               sector: 'US Tech' },
  { symbol: 'MSFT',  name: 'Microsoft',            sector: 'US Tech' },
  { symbol: 'GOOGL', name: 'Alphabet (Google)',     sector: 'US Tech' },
  { symbol: 'AMZN',  name: 'Amazon',               sector: 'US Tech' },
  { symbol: 'NVDA',  name: 'NVIDIA',               sector: 'US Tech' },
  { symbol: 'META',  name: 'Meta Platforms',        sector: 'US Tech' },
  { symbol: 'TSLA',  name: 'Tesla',                sector: 'US Auto' },
  { symbol: 'BRK-B', name: 'Berkshire Hathaway B',  sector: 'US Finance' },
  { symbol: 'JPM',   name: 'JPMorgan Chase',       sector: 'US Finance' },
  { symbol: 'V',     name: 'Visa',                 sector: 'US Finance' },
  { symbol: 'UNH',   name: 'UnitedHealth',         sector: 'US Healthcare' },
  { symbol: 'MA',    name: 'Mastercard',           sector: 'US Finance' },
  { symbol: 'JNJ',   name: 'Johnson & Johnson',    sector: 'US Healthcare' },
  { symbol: 'WMT',   name: 'Walmart',              sector: 'US Retail' },
  { symbol: 'PG',    name: 'Procter & Gamble',     sector: 'US Consumer' },
  { symbol: 'XOM',   name: 'Exxon Mobil',          sector: 'US Energy' },
  { symbol: 'HD',    name: 'Home Depot',           sector: 'US Retail' },
  { symbol: 'BAC',   name: 'Bank of America',      sector: 'US Finance' },
  { symbol: 'COST',  name: 'Costco',               sector: 'US Retail' },
  { symbol: 'ABBV',  name: 'AbbVie',               sector: 'US Healthcare' },
  { symbol: 'CRM',   name: 'Salesforce',           sector: 'US Tech' },
  { symbol: 'AMD',   name: 'AMD',                  sector: 'US Tech' },
  { symbol: 'NFLX',  name: 'Netflix',              sector: 'US Tech' },
  { symbol: 'ADBE',  name: 'Adobe',                sector: 'US Tech' },
  { symbol: 'ORCL',  name: 'Oracle',               sector: 'US Tech' },
  { symbol: 'INTC',  name: 'Intel',                sector: 'US Tech' },
  { symbol: 'DIS',   name: 'Walt Disney',          sector: 'US Media' },
  { symbol: 'PYPL',  name: 'PayPal',               sector: 'US Finance' },
  { symbol: 'CSCO',  name: 'Cisco',                sector: 'US Tech' },
  { symbol: 'QCOM',  name: 'Qualcomm',             sector: 'US Tech' },
  { symbol: 'AVGO',  name: 'Broadcom',             sector: 'US Tech' },
  { symbol: 'IBM',   name: 'IBM',                  sector: 'US Tech' },
  { symbol: 'GS',    name: 'Goldman Sachs',        sector: 'US Finance' },
  { symbol: 'MS',    name: 'Morgan Stanley',       sector: 'US Finance' },
  { symbol: 'T',     name: 'AT&T',                 sector: 'US Telecom' },
  { symbol: 'BA',    name: 'Boeing',               sector: 'US Industrial' },
  { symbol: 'CAT',   name: 'Caterpillar',          sector: 'US Industrial' },
  { symbol: 'GE',    name: 'GE Aerospace',         sector: 'US Industrial' },
  { symbol: 'UBER',  name: 'Uber Technologies',    sector: 'US Tech' },
  { symbol: 'SQ',    name: 'Block (Square)',        sector: 'US Finance' },
  { symbol: 'SHOP',  name: 'Shopify',              sector: 'US Tech' },
  { symbol: 'COIN',  name: 'Coinbase',             sector: 'US Finance' },
  { symbol: 'PLTR',  name: 'Palantir',             sector: 'US Tech' },
  { symbol: 'SNAP',  name: 'Snap',                 sector: 'US Tech' },
  { symbol: 'RIVN',  name: 'Rivian',               sector: 'US Auto' },
  { symbol: 'SOFI',  name: 'SoFi Technologies',    sector: 'US Finance' },
  { symbol: 'ARM',   name: 'ARM Holdings',         sector: 'US Tech' },
  { symbol: 'MSTR',  name: 'MicroStrategy',        sector: 'US Tech' },
  { symbol: 'LLY',   name: 'Eli Lilly',            sector: 'US Healthcare' },
  { symbol: 'MRK',   name: 'Merck',                sector: 'US Healthcare' },
];

// ── Crypto pairs (Yahoo Finance format) ──
const CRYPTO = [
  { symbol: 'BTC-USD',  name: 'Bitcoin',           sector: 'Crypto' },
  { symbol: 'ETH-USD',  name: 'Ethereum',          sector: 'Crypto' },
  { symbol: 'BNB-USD',  name: 'Binance Coin',      sector: 'Crypto' },
  { symbol: 'SOL-USD',  name: 'Solana',            sector: 'Crypto' },
  { symbol: 'XRP-USD',  name: 'Ripple',            sector: 'Crypto' },
  { symbol: 'ADA-USD',  name: 'Cardano',           sector: 'Crypto' },
  { symbol: 'DOGE-USD', name: 'Dogecoin',          sector: 'Crypto' },
  { symbol: 'AVAX-USD', name: 'Avalanche',         sector: 'Crypto' },
  { symbol: 'DOT-USD',  name: 'Polkadot',          sector: 'Crypto' },
  { symbol: 'LINK-USD', name: 'Chainlink',         sector: 'Crypto' },
  { symbol: 'MATIC-USD',name: 'Polygon',           sector: 'Crypto' },
  { symbol: 'UNI7083-USD', name: 'Uniswap',        sector: 'Crypto' },
  { symbol: 'ATOM-USD', name: 'Cosmos',            sector: 'Crypto' },
  { symbol: 'LTC-USD',  name: 'Litecoin',          sector: 'Crypto' },
  { symbol: 'APT21794-USD', name: 'Aptos',         sector: 'Crypto' },
  { symbol: 'NEAR-USD', name: 'NEAR Protocol',     sector: 'Crypto' },
  { symbol: 'FTM-USD',  name: 'Fantom',            sector: 'Crypto' },
  { symbol: 'ALGO-USD', name: 'Algorand',          sector: 'Crypto' },
  { symbol: 'AAVE-USD', name: 'Aave',              sector: 'Crypto' },
  { symbol: 'INJ-USD',  name: 'Injective',         sector: 'Crypto' },
];

// ── Commodities (Yahoo Finance format) ──
const COMMODITIES = [
  { symbol: 'GC=F',   name: 'Gold (XAUUSD)',      sector: 'Commodities' },
  { symbol: 'SI=F',   name: 'Silver (XAGUSD)',     sector: 'Commodities' },
  { symbol: 'CL=F',   name: 'Crude Oil WTI',      sector: 'Commodities' },
  { symbol: 'NG=F',   name: 'Natural Gas',         sector: 'Commodities' },
  { symbol: 'HG=F',   name: 'Copper',              sector: 'Commodities' },
  { symbol: 'PL=F',   name: 'Platinum',            sector: 'Commodities' },
];

module.exports = { US_STOCKS, CRYPTO, COMMODITIES };
