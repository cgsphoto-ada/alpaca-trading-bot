#!/usr/bin/env node
/**
 * Alpaca Trading CLI — Quick account/position/order queries.
 * Usage: node alpaca.mjs <command> [args...]
 *
 * Commands:
 *   account              Show account balance, buying power, P/L
 *   positions            List open positions with unrealized P/L
 *   ticker <symbol>      Show latest price and daily stats
 *   orders [limit]       Show recent orders (default 10)
 *   buy <symbol> <qty>   Place market buy order
 *   sell <symbol> <qty>  Place market sell order
 *   close <symbol>       Close entire position for a symbol
 *   close-all            Close all positions
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const candidates = [
    "/home/ada/.openclaw/.env",
    path.join(__dirname, "..", "..", "..", "..", "..", ".env"),
    path.join(__dirname, "..", "..", "..", ".env"),
    path.join(__dirname, "..", "..", "alpaca-trading", ".env"),
    path.join(__dirname, ".env"),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, "utf-8");
    for (const line of txt.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq);
      let v = t.slice(eq + 1);
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
    return;
  }
}

async function alpacaRequest(endpoint, method = "GET", body = null) {
  const base = "https://paper-api.alpaca.markets/v2";
  const opts = {
    method,
    headers: {
      "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${base}${endpoint}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Alpaca ${res.status}: ${err}`);
  }
  return res.json();
}

function fmt(n) {
  return `$${Number(n).toFixed(2)}`;
}

async function cmdAccount() {
  const a = await alpacaRequest("/account");
  const pnl = Number(a.equity) - Number(a.last_equity);
  const pnlPct = (pnl / Number(a.last_equity) * 100).toFixed(2);
  console.log(JSON.stringify({
    cash: fmt(a.cash),
    portfolio: fmt(a.portfolio_value),
    equity: fmt(a.equity),
    buying_power: fmt(a.buying_power),
    daily_pnl: `${pnl >= 0 ? "+" : ""}${fmt(pnl)} (${pnl >= 0 ? "+" : ""}${pnlPct}%)`,
    status: a.status,
    day_trades: a.daytrade_count,
  }));
}

async function cmdPositions() {
  const pos = await alpacaRequest("/positions");
  if (!pos.length) {
    console.log(JSON.stringify({ positions: [], total: "No open positions" }));
    return;
  }
  const positions = pos.map(p => ({
    symbol: p.symbol,
    qty: p.qty,
    entry: fmt(p.avg_entry_price),
    current: fmt(p.current_price),
    market_value: fmt(p.market_value),
    unrealized_pl: `${Number(p.unrealized_pl) >= 0 ? "+" : ""}${fmt(p.unrealized_pl)} (${Number(p.unrealized_plpc) >= 0 ? "+" : ""}${Number(p.unrealized_plpc).toFixed(2)}%)`,
    change_today: `${Number(p.change_today) >= 0 ? "+" : ""}${fmt(p.change_today)}`,
  }));
  console.log(JSON.stringify({ positions, total: pos.length }));
}

async function cmdTicker(symbol) {
  // Use last quote from the quote endpoint (works on paper)
  const sym = symbol.toUpperCase();
  const asset = await alpacaRequest(`/assets/${sym}`);
  try {
    const quote = await alpacaRequest(`/stocks/${sym}/quotes/latest`);
    const mid = (quote.quote.bp + quote.quote.ap) / 2;
    console.log(JSON.stringify({
      symbol: sym,
      bid: fmt(quote.quote.bp),
      ask: fmt(quote.quote.ap),
      mid: fmt(mid),
      spread: fmt(quote.quote.ap - quote.quote.bp),
      exchange: quote.quote.x,
      timestamp: quote.quote.t,
      easy_to_borrow: asset.easy_to_borrow,
      shortable: asset.shortable,
      fractionable: asset.fractionable,
    }));
  } catch {
    // Fallback: just asset info
    console.log(JSON.stringify({
      symbol: sym,
      easy_to_borrow: asset.easy_to_borrow,
      shortable: asset.shortable,
      fractionable: asset.fractionable,
      note: "Quote data unavailable on paper",
    }));
  }
}

async function cmdOrders(limit = 10) {
  const orders = await alpacaRequest(`/orders?limit=${limit}&status=all`);
  const result = orders.map(o => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    qty: o.qty,
    type: o.type,
    status: o.status,
    filled_qty: o.filled_qty,
    filled_avg_price: o.filled_avg_price ? fmt(o.filled_avg_price) : null,
    created_at: o.created_at,
  }));
  console.log(JSON.stringify({ orders: result, total: result.length }));
}

async function cmdBuy(symbol, qty) {
  const order = await alpacaRequest("/orders", "POST", {
    symbol: symbol.toUpperCase(),
    qty: String(qty),
    side: "buy",
    type: "market",
    time_in_force: "day",
  });
  console.log(JSON.stringify({
    action: "BUY",
    symbol: order.symbol,
    qty: order.qty,
    id: order.id,
    status: order.status,
  }));
}

async function cmdSell(symbol, qty) {
  const order = await alpacaRequest("/orders", "POST", {
    symbol: symbol.toUpperCase(),
    qty: String(qty),
    side: "sell",
    type: "market",
    time_in_force: "day",
  });
  console.log(JSON.stringify({
    action: "SELL",
    symbol: order.symbol,
    qty: order.qty,
    id: order.id,
    status: order.status,
  }));
}

async function cmdClose(symbol) {
  const pos = await alpacaRequest(`/positions/${symbol.toUpperCase()}`);
  const order = await alpacaRequest(`/positions/${symbol.toUpperCase()}`, "DELETE");
  console.log(JSON.stringify({
    action: "CLOSE",
    symbol: symbol.toUpperCase(),
    qty: pos.qty,
    id: order.id,
    status: order.status,
  }));
}

async function cmdCloseAll() {
  const orders = await alpacaRequest("/positions", "DELETE");
  console.log(JSON.stringify({
    action: "CLOSE_ALL",
    closed: orders.length,
    details: orders.map(o => ({ symbol: o.symbol, id: o.id, status: o.status })),
  }));
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  await loadEnv();
  const [,, cmd, ...args] = process.argv;

  try {
    switch (cmd) {
      case "account": await cmdAccount(); break;
      case "positions": await cmdPositions(); break;
      case "ticker": await cmdTicker(args[0]); break;
      case "orders": await cmdOrders(args[0]); break;
      case "buy": await cmdBuy(args[0], args[1]); break;
      case "sell": await cmdSell(args[0], args[1]); break;
      case "close": await cmdClose(args[0]); break;
      case "close-all": await cmdCloseAll(); break;
      default:
        console.error(`Usage: node alpaca.mjs <account|positions|ticker|orders|buy|sell|close|close-all> [args]`);
        console.error(`Unknown command: ${cmd}`);
        process.exit(1);
    }
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

main();
