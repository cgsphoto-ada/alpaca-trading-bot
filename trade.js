#!/usr/bin/env node
/**
 * Alpaca Paper Trading Bot — SMA Crossover Strategy
 * 
 * Uses Yahoo Finance for historical price data (free, unlimited history).
 * Uses Alpaca for account info, positions, and order execution (paper).
 * Runs on cron during market hours.
 */

import Alpaca from "@alpacahq/alpaca-trade-api";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "state.json");

// ── Config (from config.json) ────────────────────────────
function loadConfig() {
  const cfgPath = path.join(__dirname, "config.json");
  const raw = fs.readFileSync(cfgPath, "utf-8");
  const cfg = JSON.parse(raw);
  return {
    watchlist: cfg.watchlist || ["SPY", "QQQ", "IWM"],
    smaShort: cfg.smaShort || 50,
    smaLong: cfg.smaLong || 200,
    positionSize: cfg.positionSize || 5000,
    orderType: cfg.orderType || "market",
    timeInForce: cfg.timeInForce || "day",
  };
}

const CONFIG = loadConfig();
const WATCHLIST = CONFIG.watchlist;
const SMA_SHORT = CONFIG.smaShort;
const SMA_LONG = CONFIG.smaLong;
const ORDER_TYPE = CONFIG.orderType;
const TIME_IN_FORCE = CONFIG.timeInForce;

// ── Helpers ───────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")); }
  catch { return {}; }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function sma(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

async function loadEnv() {
  const candidates = ["/home/ada/.openclaw/.env"];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, "utf-8");
    for (const line of txt.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq);
      let val = t.slice(eq + 1);
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      process.env[key] = val;
    }
    log(`Loaded env from ${f}`);
    return;
  }
  log("WARN: No .env found");
}

// ── Yahoo Finance data (free, no API key) ─────────────────
async function fetchYahooBars(symbol) {
  // Fetch 1 year of daily data for SMA200 + buffer
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result?.timestamp) throw new Error("No data from Yahoo");
  
  const closes = result.indicators.quote[0].close;
  const timestamps = result.timestamp;
  // Pair timestamps with closes, filter out nulls
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null) bars.push({ t: timestamps[i], c: closes[i] });
  }
  return bars;
}

async function fetchYahooBarsWithRetry(symbol, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchYahooBars(symbol);
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  await loadEnv();

  const apiKey = process.env.ALPACA_API_KEY;
  const apiSecret = process.env.ALPACA_API_SECRET;
  if (!apiKey || !apiSecret) {
    log("FATAL: ALPACA_API_KEY or ALPACA_API_SECRET not set");
    process.exit(1);
  }

  const alpaca = new Alpaca({ keyId: apiKey, secretKey: apiSecret, paper: true });

  // 1. Market check
  try {
    const clock = await alpaca.getClock();
    if (!clock.is_open) {
      log(`Market closed. Next open: ${clock.next_open}`);
      return;
    }
    log(`Market open — ${clock.timestamp}`);
  } catch (e) {
    log(`ERROR clock: ${e.message}`);
    return;
  }

  // 2. Account + positions
  let account, positions;
  try {
    account = await alpaca.getAccount();
    positions = await alpaca.getPositions();
    log(`Account: $${Number(account.cash).toFixed(0)} cash | $${Number(account.portfolio_value).toFixed(0)} portfolio | ${account.buying_power} bp`);
  } catch (e) {
    log(`ERROR account: ${e.message}`);
    return;
  }

  // 3. Process symbols
  const state = loadState();
  let stateChanged = false;

  for (const symbol of WATCHLIST) {
    if (!state[symbol]) { state[symbol] = { crossover: "none" }; stateChanged = true; }

    try {
      log(`${symbol}: Fetching Yahoo data...`);
      const bars = await fetchYahooBarsWithRetry(symbol);
      const prices = bars.map(b => b.c);

      if (prices.length < SMA_LONG) {
        log(`${symbol}: Only ${prices.length} bars, need ${SMA_LONG}. Skipping.`);
        continue;
      }

      const shortNow = sma(prices, SMA_SHORT);
      const longNow = sma(prices, SMA_LONG);
      // Previous day's SMAs to detect crossover
      const shortPrev = sma(prices.slice(0, -1), SMA_SHORT);
      const longPrev = sma(prices.slice(0, -1), SMA_LONG);
      const lastPrice = prices[prices.length - 1];
      const lastDate = new Date(bars[bars.length - 1].t * 1000).toISOString().split("T")[0];

      if (shortNow == null || longNow == null || shortPrev == null || longPrev == null) {
        log(`${symbol}: SMA null — skip`);
        continue;
      }

      log(`${symbol}: ${lastDate} | $${lastPrice.toFixed(2)} | SMA${SMA_SHORT}=${shortNow.toFixed(2)} | SMA${SMA_LONG}=${longNow.toFixed(2)} | State: ${state[symbol].crossover}`);

      // First run: set initial state based on current trend
      if (state[symbol].crossover === "none") {
        state[symbol].crossover = shortNow > longNow ? "golden" : "death";
        stateChanged = true;
        log(`${symbol}: Initial state set to "${state[symbol].crossover}" (SMA50 ${shortNow > longNow ? ">" : "<"} SMA200)`);
        continue;
      }

      // Golden cross: 50 crosses ABOVE 200
      if (shortPrev <= longPrev && shortNow > longNow) {
        if (state[symbol].crossover !== "golden") {
          log(`${symbol}: \x1b[33m🔼 GOLDEN CROSS\x1b[0m`);
          const existing = positions.find(p => p.symbol === symbol);
          if (existing) {
            log(`${symbol}: Already holding ${existing.qty} shares, skipping`);
          } else {
            const qty = Math.max(1, Math.floor(POSITION_SIZE / lastPrice));
            try {
              const order = await alpaca.createOrder({ symbol, qty, side: "buy", type: ORDER_TYPE, time_in_force: TIME_IN_FORCE });
              log(`${symbol}: ✅ BUY ${qty} @ ~$${lastPrice.toFixed(2)} | ${order.id}`);
            } catch (e) {
              log(`${symbol}: ❌ BUY failed: ${e.message}`);
            }
          }
          state[symbol].crossover = "golden";
          stateChanged = true;
        }
      }

      // Death cross: 50 crosses BELOW 200
      if (shortPrev >= longPrev && shortNow < longNow) {
        if (state[symbol].crossover !== "death") {
          log(`${symbol}: \x1b[31m🔽 DEATH CROSS\x1b[0m`);
          const existing = positions.find(p => p.symbol === symbol);
          if (existing) {
            try {
              await alpaca.closePosition(symbol);
              log(`${symbol}: ✅ SOLD ${existing.qty} shares (closed position)`);
            } catch (e) {
              log(`${symbol}: ❌ SELL failed: ${e.message}`);
            }
          } else {
            log(`${symbol}: No position, nothing to sell`);
          }
          state[symbol].crossover = "death";
          stateChanged = true;
        }
      }

    } catch (e) {
      log(`${symbol}: ERROR — ${e.message}`);
    }
  }

  if (stateChanged) saveState(state);
  log("Run complete.");
}

main().catch(e => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
