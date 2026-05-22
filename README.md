
Paper trading bot using the [Alpaca Markets API](https://alpaca.markets) for order execution and Yahoo Finance for historical price data.

## Strategy

**SMA Crossover** — 50-day / 200-day simple moving average crossover on a configurable watchlist.

- **Golden Cross** (SMA50 crosses *above* SMA200) → Buy
- **Death Cross** (SMA50 crosses *below* SMA200) → Sell

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
| `orderType` | `market`, `limit`, `stop`, `stop_limit` |
| `timeInForce` | `day`, `gtc`, `ioc` |

## Setup

```bash
npm install
```

Set environment variables:

```bash
export ALPACA_API_KEY="your-paper-api-key"
export ALPACA_API_SECRET="your-paper-api-secret"
```

## Run

```bash
node trade.js
```

The script checks if the market is open, fetches historical prices, calculates SMAs, and places trades on crossover signals. State is persisted in `state.json` to avoid duplicate signals.
