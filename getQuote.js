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

const FROM_CHAIN = 8453;                      // Base
const MIDDLE_CHAIN = 1151111081099710;        // Solana
const TO_CHAIN = 8453;                        // Base

const FROM_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";
const TO_TOKEN_ADDRESS   = "11111111111111111111111111111111";
const BACK_TOKEN_ADDRESS = FROM_TOKEN_ADDRESS;

const FROM_TOKEN_DECIMALS = 18;
const TO_TOKEN_DECIMALS = 9;
const BACK_TOKEN_DECIMALS = 18;

const FROM_TOKEN_SYMBOL = "ETH";
const TO_TOKEN_SYMBOL = "SOL";
const BACK_TOKEN_SYMBOL = FROM_TOKEN_SYMBOL;

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
  } catch (_) {}
}

async function getLifiRoutes({ fromAddress, toAddress, fromChain, toChain, fromToken, toToken, fromAmount }) {
  const url = "https://li.quest/v1/advanced/routes";

  const payload = {
    fromAddress,
    toAddress,
    fromChainId: fromChain,
    toChainId: toChain,
    fromTokenAddress: fromToken,
    toTokenAddress: toToken,
    fromAmount: fromAmount,
    integrator: "jumper.exchange",

    // jedyne poprawne opcje
    options: {
      allowSwitchChain: true,
      order: "CHEAPEST"
    }
  };

  const headers = {
    "accept": "*/*",
    "content-type": "application/json",
    "origin": "https://jumper.exchange",
    "referer": "https://jumper.exchange/",
    "user-agent": "Mozilla/5.0",
    "x-lifi-integrator": "jumper.exchange"
  };

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const data = await res.json();

  if (!data.routes || data.routes.length === 0) throw new Error("No routes");
  return data.routes;
}

function parseRoute(route) {
  const step = route.steps[0];
  const toAmountRaw = route.toAmount || route.toAmountMin;
  return {
    toAmount: new Decimal(toAmountRaw),
    decimals: route.toToken.decimals,
    bridge: step.tool
  };
}

function toSmallest(amount, decimals) {
  return amount.mul(Decimal.pow(10, decimals)).toFixed(0);
}

function fromSmallest(amount, decimals) {
  return new Decimal(amount).div(Decimal.pow(10, decimals));
}

async function getMayanQuoteBack(amountIn) {
  try {
    const q = await fetchQuote({
      fromChain: "solana",
      toChain: "base",
      fromToken: TO_TOKEN_ADDRESS,
      toToken: BACK_TOKEN_ADDRESS,
      amountIn64: amountIn,
      slippageBps: 300
    });

    return q.map(x => ({
      amount: new Decimal(x.expectedAmountOut),
      bridge: "MAYAN"
    }));
  } catch (_) {
    return [];
  }
}

function logRoute(r) {
  const color = r.profit.gte(PROFIT_THRESHOLD) ? "\x1b[38;5;112m" : "\x1b[38;5;240m";
  const mark = r.profit.gt(0) ? "▲" : "▼";

  console.log(
    `${color}[${nowTs()}] ${mark} ${r.fromAmount.toFixed(6)} ${FROM_TOKEN_SYMBOL} `
    + `-> ${r.toAmount.toFixed(6)} ${TO_TOKEN_SYMBOL} (${r.bridgeFrom}) `
    + `-> ${r.backAmount.toFixed(6)} ${BACK_TOKEN_SYMBOL} (${r.bridgeTo}) `
    + `| PROFIT: ${r.profit.toFixed(6)} ${BACK_TOKEN_SYMBOL} (${r.pct.toFixed(3)}%)\x1b[0m`
  );
}

async function checkOnce() {
  const fromAmountSmall = toSmallest(BASE_AMOUNT, FROM_TOKEN_DECIMALS);

  // -------------------- BASE → SOL --------------------
  let toTokenAmount;
  let bridgeFrom;

  try {
    const routes = await getLifiRoutes({
      fromAddress: BASE_WALLET,
      toAddress: SOLANA_WALLET,
      fromChain: FROM_CHAIN,
      toChain: MIDDLE_CHAIN,
      fromToken: FROM_TOKEN_ADDRESS,
      toToken: TO_TOKEN_ADDRESS,
      fromAmount: fromAmountSmall
    });

    const filtered = routes
      .map(parseRoute)
      .filter(x => !x.bridge.toLowerCase().includes("mayan"));

    const best = filtered.sort((a, b) => b.toAmount.minus(a.toAmount).toNumber())[0];

    toTokenAmount = fromSmallest(best.toAmount, best.decimals);
    bridgeFrom = best.bridge;
  } catch (e) {
    console.log(`[${nowTs()}] Base→Sol failed:`, e.message);
    return;
  }

  // -------------------- SOL → BASE --------------------
  let backAmount;
  let bridgeTo;

  const amount64 = toSmallest(toTokenAmount, TO_TOKEN_DECIMALS);

  // MAYAN
  const mayan = await getMayanQuoteBack(amount64);
  let mayanBest = null;

  if (mayan.length > 0) {
    mayanBest = {
      amount: fromSmallest(mayan[0].amount, BACK_TOKEN_DECIMALS),
      bridge: "MAYAN"
    };
  }

  // LI.FI
  const routesBack = await getLifiRoutes({
    fromAddress: SOLANA_WALLET,
    toAddress: BASE_WALLET,
    fromChain: MIDDLE_CHAIN,
    toChain: TO_CHAIN,
    fromToken: TO_TOKEN_ADDRESS,
    toToken: BACK_TOKEN_ADDRESS,
    fromAmount: amount64
  });

  const jumperBestRaw = routesBack
    .map(parseRoute)
    .filter(x => !x.bridge.toLowerCase().includes("mayan"))
    .sort((a, b) => b.toAmount.minus(a.toAmount).toNumber())[0];

  const jumperBest = {
    amount: fromSmallest(jumperBestRaw.toAmount, jumperBestRaw.decimals),
    bridge: jumperBestRaw.bridge
  };

  if (mayanBest && mayanBest.amount.gt(jumperBest.amount)) {
    backAmount = mayanBest.amount;
    bridgeTo = "MAYAN";
  } else {
    backAmount = jumperBest.amount;
    bridgeTo = jumperBest.bridge;
  }

  // -------------------- RESULT --------------------
  const profit = backAmount.sub(BASE_AMOUNT);
  const pct = profit.div(BASE_AMOUNT).mul(100);

  logRoute({
    fromAmount: BASE_AMOUNT,
    toAmount: toTokenAmount,
    backAmount,
    bridgeFrom,
    bridgeTo,
    profit,
    pct
  });

  const threshold = bridgeTo === "MAYAN" ? MAYAN_PROFIT_THRESHOLD : PROFIT_THRESHOLD;

  if (profit.gte(threshold)) {
    const msg =
      `*ARBITRAGE ALERT*\n` +
      `Profit: ${profit.toFixed(6)} ${BACK_TOKEN_SYMBOL}\n` +
      `----------------------------\n` +
      `Bridge 1: ${bridgeFrom} (Base→Sol)\n` +
      `Bridge 2: ${bridgeTo} (Sol→Base)\n` +
      `Received: ${toTokenAmount.toFixed(6)} ${TO_TOKEN_SYMBOL}\n` +
      `Returned: ${backAmount.toFixed(6)} ${BACK_TOKEN_SYMBOL}\n` +
      `----------------------------`;

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
