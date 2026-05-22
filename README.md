# Alpaca Trading Bot

Paper trading bot using the [Alpaca Markets API](https://alpaca.markets) for order execution and Yahoo Finance for historical price data.

## Strategy

**SMA Trend Following** — on every run, aligns positions with the moving average trend:

- **SMA_short > SMA_long** → bullish trend → **buy** if not holding
- **SMA_short < SMA_long** → bearish trend → **sell** if holding

Runs every 30 minutes during market hours (M-F, 9:30 AM – 4:00 PM ET) via cron.

## Configuration

Copy `config.example.json` to `config.json` and customize:

```bash
cp config.example.json config.json
```

Edit `config.json` to customize:

```json
{
  "watchlist": ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA", "AMD", "NFLX", "ADBE"],
  "positionSize": 5000,
  "maxBudget": 80000,
  "smaShort": 20,
  "smaLong": 50,
  "orderType": "market",
  "timeInForce": "day"
}
```

| Field | Description |
|-------|-------------|
| `watchlist` | Symbols to trade |
| `positionSize` | Dollar amount per trade |
| `maxBudget` | Maximum total dollars to allocate per run |
| `smaShort` / `smaLong` | Moving average periods |
| `orderType` | `market`, `limit`, `stop`, or `stop_limit` |
| `timeInForce` | `day`, `gtc`, or `ioc` |
| `limitPrice` | Required when `orderType` is `limit` or `stop_limit` |
| `stopPrice` | Required when `orderType` is `stop` or `stop_limit` |

When using a non-market order type, add the appropriate price fields:

```json
{
  "orderType": "limit",
  "limitPrice": 500.00
}
```

## Setup

Requires Node.js 18 or later.

```bash
npm install
```

Set environment variables:

```bash
export ALPACA_API_KEY="your-paper-api-key"
export ALPACA_API_SECRET="your-paper-api-secret"
```

The script also loads keys from a `.env` file in the project directory or workspace root.

## Run

```bash
node trade.js
```

The script checks if the market is open, fetches historical prices, calculates SMAs, and aligns positions with the trend. State is persisted in `state.json` to track which symbols are currently held.

## CLI

Quick account/position/order queries from the terminal:

```bash
node scripts/alpaca-cli.mjs <command> [args]
```

| Command | Description |
|---------|-------------|
| `account` | Balance, equity, daily P&L |
| `positions` | Open positions with P&L |
| `ticker <sym>` | Asset info |
| `orders [n]` | Recent order history |
| `buy <sym> <qty>` | Market buy order |
| `sell <sym> <qty>` | Market sell order |
| `close <sym>` | Close position |
| `close-all` | Close all positions |
