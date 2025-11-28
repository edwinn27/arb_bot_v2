// FULL UPDATED SCRIPT WITH MINIMAL NECESSARY CHANGES APPLIED
// Only routing logic modified. Everything else kept intact.

import fetch from "node-fetch";
import { Decimal } from "decimal.js";
import { fetchQuote } from "@mayanfinance/swap-sdk";
import dotenv from "dotenv";
dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BASE_WALLET = process.env.BASE_WALLET;
const SOLANA_WALLET = process.env.SOLANA_WALLET;

const BASE_AMOUNT = new Decimal(process.env.BASE_AMOUNT || "2.0");
const PROFIT_THRESHOLD = new Decimal(process.env.PROFIT_THRESHOLD || "0.008");
const MAYAN_PROFIT_THRESHOLD = new Decimal(process.env.MAYAN_PROFIT_THRESHOLD || "0.015");
const POLL_INTERVAL = 15_000;

const FROM_CHAIN = process.env.FROM_CHAIN || 8453; // Base
const MIDDLE_CHAIN = process.env.MIDDLE_CHAIN || 1151111081099710; // Solana
const TO_CHAIN = FROM_CHAIN;

const FROM_TOKEN_ADDRESS = process.env.FROM_TOKEN_ADDRESS || "0x0000000000000000000000000000000000000000";
const TO_TOKEN_ADDRESS = process.env.TO_TOKEN_ADDRESS || "11111111111111111111111111111111";
const BACK_TOKEN_ADDRESS = process.env.BACK_TOKEN_ADDRESS || FROM_TOKEN_ADDRESS;

const FROM_TOKEN_DECIMALS = parseInt(process.env.FROM_TOKEN_DECIMALS || "18");
const TO_TOKEN_DECIMALS = parseInt(process.env.TO_TOKEN_DECIMALS || "9");
const BACK_TOKEN_DECIMALS = process.env.BACK_TOKEN_DECIMALS ? parseInt(process.env.BACK_TOKEN_DECIMALS) : FROM_TOKEN_DECIMALS;

const FROM_TOKEN_SYMBOL = process.env.FROM_TOKEN_SYMBOL || "ETH";
const TO_TOKEN_SYMBOL = process.env.TO_TOKEN_SYMBOL || "SOL";
const BACK_TOKEN_SYMBOL = process.env.BACK_TOKEN_SYMBOL || FROM_TOKEN_SYMBOL;

function nowTs() {
  return new Date().toISOString().split("T")[1].split(".")[0];
}

async function sendTelegramMessage(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" })
    });
  } catch (e) {
    console.error(`[${nowTs()}] Telegram send error:`, e);
  }
}

async function getJumperRoutes(fromAddress, toAddress, fromChain, toChain, fromToken, toToken, fromAmount) {
  const url = "https://api.jumper.exchange/p/lifi/advanced/routes";
  const headers = {
    "accept": "*/*",
    "content-type": "application/json",
    "origin": "https://jumper.exchange",
    "referer": "https://jumper.exchange/",
    "user-agent": "Mozilla/5.0",
    "x-lifi-integrator": "jumper.exchange",
    "x-lifi-sdk": "3.12.11",
    "x-lifi-widget": "3.32.2"
  };

  const payload = {
    fromAddress,
    fromAmount: fromAmount.toString(),
    fromChainId: fromChain,
    fromTokenAddress: fromToken,
    toAddress,
    toChainId: toChain,
    toTokenAddress: toToken,
    options: { integrator: "jumper.exchange", order: "CHEAPEST", maxPriceImpact: 0.4, allowSwitchChain: true }
  };

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!data.routes || data.routes.length === 0) throw new Error("No routes found");
  return data.routes;
}

function parseJumperRoute(route) {
  const step = route.steps[0];
  const toAmountRaw = route.toAmount || route.toAmountMin;
  if (!toAmountRaw) throw new Error("Missing toAmount in route");
  return {
    toAmount: new Decimal(toAmountRaw),
    decimals: parseInt(route.toToken.decimals),
    bridge: step.tool
  };
}

function toSmallestUnit(amount, decimals) {
  return amount.mul(Decimal.pow(10, decimals)).toFixed(0);
}

function fromSmallestUnit(amount, decimals) {
  return new Decimal(amount).div(Decimal.pow(10, decimals));
}

async function getMayanQuote(fromToken, toToken, fromChain, toChain, amountIn64) {
  try {
    const quotes = await fetchQuote({ fromChain, toChain, fromToken, toToken, amountIn64, slippageBps: 300 });

    return quotes
      .map(q => {
        const out = q.expectedAmountOut || q.bestRoute?.outputAmount || q.routes?.[0]?.steps?.[0]?.outputAmount || null;
        if (!out) return null;
        return { amount: new Decimal(out), bridge: "MAYAN" };
      })
      .filter(Boolean);

  } catch (e) {
    console.error(`[${nowTs()}] Błąd Mayan quote:`, e);
    return [];
  }
}

function logBestRoute(bestRoute) {
  const colorGreenDim = "\x1b[38;5;112m";
  const colorGray = "\x1b[38;5;240m";
  const colorReset = "\x1b[0m";

  const colorMain = bestRoute.profit.gte(PROFIT_THRESHOLD) ? colorGreenDim : colorGray;
  const profitMark = bestRoute.profit.gt(0) ? "▲" : "▼";

  console.log(
    `${colorMain}[${nowTs()}] ${profitMark} ${bestRoute.fromAmount.toFixed(6)} ${FROM_TOKEN_SYMBOL} -> ` +
    `${bestRoute.toAmount.toFixed(6)} ${TO_TOKEN_SYMBOL} (${bestRoute.bridgeFrom}) -> ` +
    `${bestRoute.backAmount.toFixed(6)} ${BACK_TOKEN_SYMBOL} (${bestRoute.bridgeTo}) | PROFIT: ` +
    `${bestRoute.profit.toFixed(6)} ${BACK_TOKEN_SYMBOL} (${bestRoute.pct.toFixed(3)}%)${colorReset}`
  );
}

// =========================
// ** FIXED ROUTING SECTION **
// =========================

async function getAllBaseToSol() {
  const baseAmtSmall = BASE_AMOUNT.mul(Decimal.pow(10, FROM_TOKEN_DECIMALS));
  const routes = await getJumperRoutes(
    BASE_WALLET,
    SOLANA_WALLET,
    FROM_CHAIN,
    MIDDLE_CHAIN,
    FROM_TOKEN_ADDRESS,
    TO_TOKEN_ADDRESS,
    baseAmtSmall
  );

  const jumper = routes.map(r => {
    const parsed = parseJumperRoute(r);
    return {
      amount: fromSmallestUnit(parsed.toAmount, parsed.decimals),
      bridge: parsed.bridge
    };
  });

  const mayanRaw = await getMayanQuote(
    FROM_TOKEN_ADDRESS,
    TO_TOKEN_ADDRESS,
    "base",
    "solana",
    baseAmtSmall.toFixed()
  );

  const mayan = mayanRaw.map(q => ({ amount: q.amount, bridge: "MAYAN" }));

  return [...jumper].sort((a, b) => b.amount.minus(a.amount).toNumber())[0];
}

async function getAllSolToBase(amountSol) {
  const amountSmall = toSmallestUnit(amountSol, TO_TOKEN_DECIMALS);

  const routesBack = await getJumperRoutes(
    SOLANA_WALLET,
    BASE_WALLET,
    MIDDLE_CHAIN,
    TO_CHAIN,
    TO_TOKEN_ADDRESS,
    BACK_TOKEN_ADDRESS,
    amountSmall
  );

  const jumper = routesBack.map(r => {
    const parsed = parseJumperRoute(r);
    return {
      amount: fromSmallestUnit(parsed.toAmount, parsed.decimals),
      bridge: parsed.bridge
    };
  });

  const mayanRaw = await getMayanQuote(
    TO_TOKEN_ADDRESS,
    BACK_TOKEN_ADDRESS,
    "solana",
    "base",
    amountSmall
  );

  const mayan = mayanRaw.map(q => ({ amount: q.amount, bridge: "MAYAN" }));

  return [...jumper, ...mayan].sort((a, b) => b.amount.minus(a.amount).toNumber())[0];
}

// =========================
// ** MAIN CHECK LOOP **
// =========================

async function checkOnce() {
  let bestA;
  try {
    bestA = await getAllBaseToSol();
  } catch (e) {
    console.error(`[${nowTs()}] Error BASE→SOL:`, e);
    return;
  }

  let bestB;
  try {
    bestB = await getAllSolToBase(bestA.amount);
  } catch (e) {
    console.error(`[${nowTs()}] Error SOL→BASE:`, e);
    return;
  }

  const profit = bestB.amount.sub(BASE_AMOUNT);
  const pct = profit.div(BASE_AMOUNT).mul(100);

  const bestRoute = {
    fromAmount: BASE_AMOUNT,
    toAmount: bestA.amount,
    backAmount: bestB.amount,
    bridgeFrom: bestA.bridge,
    bridgeTo: bestB.bridge,
    profit,
    pct
  };

  logBestRoute(bestRoute);

  const threshold = PROFIT_THRESHOLD;
  if (profit.gte(threshold)) {
    const msg = `*ARBITRAGE ALERT*\nProfit: ${profit.toFixed(6)} ${BACK_TOKEN_SYMBOL}`;
    await sendTelegramMessage(msg);
  }
}

async function mainLoop() {
  while (true) {
    const start = Date.now();
    await checkOnce();
    const elapsed = Date.now() - start;
    await new Promise(r => setTimeout(r, Math.max(0, POLL_INTERVAL - elapsed)));
  }
}

mainLoop();
