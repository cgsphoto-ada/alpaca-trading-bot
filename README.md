# Alpaca Trading Bot

Paper trading bot using the [Alpaca Markets API](https://alpaca.markets) for order execution and Yahoo Finance for historical price data.

## Strategy

**SMA Crossover** — short / long simple moving average crossover on a configurable watchlist.

- **Golden Cross** (short SMA crosses *above* long SMA) → Buy
- **Death Cross** (short SMA crosses *below* long SMA) → Sell

Runs every 30 minutes during market hours (M-F, 9:30 AM – 4:00 PM ET) via cron.

## Configuration

Edit `config.json` to customize:

```json
{
  "watchlist": ["SPY", "QQQ", "IWM"],
  "positionSize": 5000,
  "smaShort": 50,
  "smaLong": 200,
  "orderType": "market",
  "timeInForce": "day"
}
```

| Field | Description |
|-------|-------------|
| `watchlist` | Symbols to trade |
| `positionSize` | Dollar amount per trade |
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

The script checks if the market is open, fetches historical prices, calculates SMAs, and places trades on crossover signals. State is persisted in `state.json` to avoid duplicate crossover signals.
