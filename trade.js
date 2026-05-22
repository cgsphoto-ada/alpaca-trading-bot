#!/usr/bin/env node
/**
 * Alpaca Paper Trading Bot — SMA Trend-Following Strategy
 *
 * On every run, aligns positions with the SMA trend:
 *   SMA_short > SMA_long → be LONG  (buy if not holding)
 *   SMA_short < SMA_long → be FLAT  (sell if holding)
 *
 * Uses Yahoo Finance for historical price data (free, unlimited history).
 * Uses Alpaca for account info, positions, and order execution (paper).
 * Runs on cron during market hours.
 *
 * Requires Node.js >= 18 (uses global fetch).
 */

import Alpaca from "@alpacahq/alpaca-trade-api";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "state.json");
const STATE_TMP = STATE_FILE + ".tmp";

// ── Config (from config.json) ────────────────────────────
function loadConfig() {
  const cfgPath = path.join(__dirname, "config.json");
  let cfg;
  try {
    const raw = fs.readFileSync(cfgPath, "utf-8");
    cfg = JSON.parse(raw);
  } catch (e) {
    console.error(`FATAL: Cannot read config.json: ${e.message}`);
    process.exit(1);
  }
  return {
    watchlist: cfg.watchlist || ["SPY", "QQQ", "IWM"],
    smaShort: cfg.smaShort || 20,
    smaLong: cfg.smaLong || 50,
    positionSize: cfg.positionSize || 5000,
    maxBudget: cfg.maxBudget || 80000,
    orderType: cfg.orderType || "market",
    timeInForce: cfg.timeInForce || "day",
    limitPrice: cfg.limitPrice,
    stopPrice: cfg.stopPrice,
  };
}

const CONFIG = loadConfig();
const WATCHLIST = CONFIG.watchlist;
const SMA_SHORT = CONFIG.smaShort;
const SMA_LONG = CONFIG.smaLong;
const POSITION_SIZE = CONFIG.positionSize;
const MAX_BUDGET = CONFIG.maxBudget;
const ORDER_TYPE = CONFIG.orderType;
const TIME_IN_FORCE = CONFIG.timeInForce;

// Validate strategy parameters
const validOrders = ["market", "limit", "stop", "stop_limit"];
const validTIF = ["day", "gtc", "opg", "cls", "ioc", "fok"];
if (!validOrders.includes(ORDER_TYPE)) {
  console.error(`FATAL: Invalid orderType "${ORDER_TYPE}" in config.json`);
  process.exit(1);
}
if (!validTIF.includes(TIME_IN_FORCE)) {
  console.error(`FATAL: Invalid timeInForce "${TIME_IN_FORCE}". Must be one of: ${validTIF.join(", ")}`);
  process.exit(1);
}
if (["limit", "stop_limit"].includes(ORDER_TYPE) && CONFIG.limitPrice === undefined) {
  console.error(`FATAL: orderType="${ORDER_TYPE}" requires "limitPrice" in config.json`);
  process.exit(1);
}
if (["stop", "stop_limit"].includes(ORDER_TYPE) && CONFIG.stopPrice === undefined) {
  console.error(`FATAL: orderType="${ORDER_TYPE}" requires "stopPrice" in config.json`);
  process.exit(1);
}
if (!Number.isFinite(SMA_SHORT) || !Number.isFinite(SMA_LONG) || SMA_SHORT < 1 || SMA_LONG < 1) {
  console.error(`FATAL: smaShort and smaLong must be positive numbers`);
  process.exit(1);
}
if (SMA_SHORT >= SMA_LONG) {
  console.error(`FATAL: smaShort (${SMA_SHORT}) must be less than smaLong (${SMA_LONG})`);
  process.exit(1);
}
if (!Number.isFinite(POSITION_SIZE) || POSITION_SIZE <= 0) {
  console.error(`FATAL: positionSize must be a positive number, got "${CONFIG.positionSize}"`);
  process.exit(1);
}
if (!Number.isFinite(MAX_BUDGET) || MAX_BUDGET <= 0) {
  console.error(`FATAL: maxBudget must be a positive number, got "${CONFIG.maxBudget}"`);
  process.exit(1);
}
if (!Array.isArray(WATCHLIST) || WATCHLIST.length === 0) {
  console.error(`FATAL: watchlist must be a non-empty array`);
  process.exit(1);
}
for (const sym of WATCHLIST) {
  if (typeof sym !== "string" || sym.trim() === "") {
    console.error(`FATAL: watchlist contains invalid symbol: "${sym}"`);
    process.exit(1);
  }
}

// ── Helpers ───────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")); }
  catch { return {}; }
}

function saveState(s) {
  fs.writeFileSync(STATE_TMP, JSON.stringify(s, null, 2));
  fs.renameSync(STATE_TMP, STATE_FILE);
}

function sma(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

async function loadEnv() {
  // Check project .env then workspace-relative .env
  const candidates = [
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", "..", ".env"),
  ];
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
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      )
        val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
    log(`Loaded env from ${f}`);
    return;
  }
  log("WARN: No .env found");
}

// ── Yahoo Finance data (free, no API key) ─────────────────
async function fetchYahooBars(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=1y&interval=1d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result?.timestamp) throw new Error(`No timestamp in Yahoo response for ${symbol}`);

  const quote = result.indicators?.quote?.[0];
  if (!quote?.close) throw new Error(`No close data in Yahoo response for ${symbol}`);
  const closes = quote.close;
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
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

function buildOrderParams(symbol, qty, side) {
  const params = { symbol, qty, side, type: ORDER_TYPE, time_in_force: TIME_IN_FORCE };
  if (["limit", "stop_limit"].includes(ORDER_TYPE))
    params.limit_price = CONFIG.limitPrice;
  if (["stop", "stop_limit"].includes(ORDER_TYPE))
    params.stop_price = CONFIG.stopPrice;
  return params;
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
    const cash = Number(account.cash);
    const pv = Number(account.portfolio_value);
    log(`Account: $${cash.toFixed(0)} cash | $${pv.toFixed(0)} portfolio | ${Number(account.buying_power).toFixed(0)} bp`);
  } catch (e) {
    log(`ERROR account: ${e.message}`);
    return;
  }

  // 3. Process symbols
  if (WATCHLIST.length === 0) {
    log("WARN: Watchlist is empty — nothing to trade");
    return;
  }

  const state = loadState();
  let stateChanged = false;
  let tradesExecuted = 0;
  let cashSpent = 0;

  for (const symbol of WATCHLIST) {
    if (!state[symbol]) { state[symbol] = { holding: false }; stateChanged = true; }

    try {
      const bars = await fetchYahooBarsWithRetry(symbol);
      const prices = bars.map((b) => b.c);

      if (prices.length < SMA_LONG) {
        log(`${symbol}: Only ${prices.length} bars, need ${SMA_LONG}. Skipping.`);
        continue;
      }

      const shortNow = sma(prices, SMA_SHORT);
      const longNow = sma(prices, SMA_LONG);
      const lastPrice = prices[prices.length - 1];
      const lastDate = new Date(bars[bars.length - 1].t * 1000).toISOString().split("T")[0];

      if (shortNow == null || longNow == null) {
        log(`${symbol}: SMA null — skip`);
        continue;
      }

      const bullish = shortNow > longNow;
      const spread = ((shortNow - longNow) / longNow * 100);
      const trendLabel = bullish ? "BULL" : "BEAR";

      const existing = positions.find((p) => p.symbol === symbol);

      // Reconcile orphan state: if state says we're holding but Alpaca
      // reports no position, clear the holding flag so buys aren't blocked
      if (state[symbol].holding && !existing) {
        state[symbol].holding = false;
        stateChanged = true;
        log(`${symbol}: State had holding but no position found, resetting`);
      }

      const isHolding = !!existing || state[symbol].holding;

      log(
        `${symbol}: ${lastDate} | $${lastPrice.toFixed(2)} | ` +
        `SMA${SMA_SHORT}=${shortNow.toFixed(2)} SMA${SMA_LONG}=${longNow.toFixed(2)} ` +
        `(${spread >= 0 ? "+" : ""}${spread.toFixed(1)}%) ${trendLabel} | ` +
        `Holding: ${existing ? existing.qty + " sh" : state[symbol].holding ? "pending" : "none"}`
      );

      // BUY: we're in a bullish trend but don't hold this symbol
      if (bullish && !isHolding) {
        if (lastPrice > POSITION_SIZE) {
          log(`${symbol}: Price $${lastPrice.toFixed(2)} exceeds position size $${POSITION_SIZE}, skipping`);
          continue;
        }

        const qty = Math.max(1, Math.floor(POSITION_SIZE / lastPrice));
        const estCost = qty * lastPrice;

        if (cashSpent + estCost > MAX_BUDGET) {
          log(`${symbol}: Budget limit reached (spent $${cashSpent}/${MAX_BUDGET}), skipping`);
          continue;
        }

        try {
          const order = await alpaca.createOrder(buildOrderParams(symbol, qty, "buy"));
          log(`${symbol}: ✅ BUY ${qty} @ ~$${lastPrice.toFixed(2)} | ${order.id}`);
          state[symbol].holding = true;
          stateChanged = true;
          tradesExecuted++;
          cashSpent += estCost;
        } catch (e) {
          log(`${symbol}: ❌ BUY failed: ${e.message}`);
        }
      }

      // SELL: we're in a bearish trend but still holding this symbol
      if (!bullish && isHolding) {
        try {
          const order = await alpaca.createOrder(
            buildOrderParams(symbol, Number(existing.qty), "sell")
          );
          log(`${symbol}: ✅ SOLD ${existing.qty} shares | ${order.id}`);
          state[symbol].holding = false;
          stateChanged = true;
          tradesExecuted++;
        } catch (e) {
          log(`${symbol}: ❌ SELL failed: ${e.message}`);
        }
      }
    } catch (e) {
      log(`${symbol}: ERROR — ${e.message}`);
    }
  }

  if (stateChanged) saveState(state);
  const summary = tradesExecuted > 0
    ? `Run complete — ${tradesExecuted} trade(s) executed.`
    : `Run complete — no changes.`;
  log(summary);
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
