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
const BACK_TOKEN_DECIMALS = parseInt(process.env.BACK_TOKEN_DECIMALS || FROM_TOKEN_DECIMALS);

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

async function getJumperQuote(fromChain, toChain, fromToken, toToken, fromAmount, fromAddress, toAddress) {
  const url = "https://api.jumper.exchange/p/lifi/quote";

  const payload = {
    fromChain,
    toChain,
    fromToken,
    toToken,
    fromAmount: fromAmount.toString(),
    fromAddress,
    toAddress,
    slippage: 0.003,
    integrator: "jumper.exchange",
    allowSwitchChain: true
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

  if (!data.estimate) throw new Error("No estimate in quote");

  return {
    toAmount: new Decimal(data.estimate.toAmount),
    toAmountMin: new Decimal(data.estimate.toAmountMin),
    decimals: data.toToken.decimals,
    bridge: data.tool
  };
}

function fromSmallestUnit(amount, decimals) {
  return new Decimal(amount).div(Decimal.pow(10, decimals));
}

function toSmallestUnit(amount, decimals) {
  return amount.mul(Decimal.pow(10, decimals)).toFixed(0);
}

async function getMayanQuote(fromToken, toToken, fromChain, toChain, amountIn64) {
  try {
    const quotes = await fetchQuote({
      fromChain,
      toChain,
      fromToken,
      toToken,
      amountIn64,
      slippageBps: 300
    });

    return quotes.map(q => ({
      amount: new Decimal(q.expectedAmountOut),
      bridge: "MAYAN"
    }));
  } catch (e) {
    console.error(`[${nowTs()}] Błąd przy pobieraniu quote Mayan:`, e);
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
    `${colorMain}[${nowTs()}] ${profitMark} ${bestRoute.fromAmount.toFixed(6)} ${FROM_TOKEN_SYMBOL}` +
    ` -> ${bestRoute.toAmount.toFixed(6)} ${TO_TOKEN_SYMBOL} (${bestRoute.bridgeFrom})` +
    ` -> ${bestRoute.backAmount.toFixed(6)} ${BACK_TOKEN_SYMBOL} (${bestRoute.bridgeTo})` +
    ` | PROFIT: ${bestRoute.profit.toFixed(6)} ${BACK_TOKEN_SYMBOL} (${bestRoute.pct.toFixed(3)}%)${colorReset}`
  );
}

async function checkOnce() {

  //
  //  Base → Solana
  //
  let toTokenAmount = null;
  let bridgeFrom = "";

  try {
    const fromAmountSmallest = BASE_AMOUNT.mul(Decimal.pow(10, FROM_TOKEN_DECIMALS));

    const q = await getJumperQuote(
      FROM_CHAIN,
      MIDDLE_CHAIN,
      FROM_TOKEN_ADDRESS,
      TO_TOKEN_ADDRESS,
      fromAmountSmallest,
      BASE_WALLET,
      SOLANA_WALLET
    );

    toTokenAmount = fromSmallestUnit(q.toAmount, q.decimals);
    bridgeFrom = q.bridge;
  } catch (e) {
    console.error(`[${nowTs()}] Error BASE→SOL via QUOTE:`, e);
    return;
  }

  //
  // Solana → Base
  //
  let backTokenAmount = null;
  let bridgeTo = "";

  try {
    const amountIn64 = toSmallestUnit(toTokenAmount, TO_TOKEN_DECIMALS);

    const mayanQuotes = await getMayanQuote(
      TO_TOKEN_ADDRESS,
      BACK_TOKEN_ADDRESS,
      "solana",
      "base",
      amountIn64
    );

    let mayanBest = null;

    if (mayanQuotes.length > 0) {
      let amt = mayanQuotes[0].amount;
      mayanBest = { amount: amt, bridge: "MAYAN" };
    }

    const q = await getJumperQuote(
      MIDDLE_CHAIN,
      TO_CHAIN,
      TO_TOKEN_ADDRESS,
      BACK_TOKEN_ADDRESS,
      amountIn64,
      SOLANA_WALLET,
      BASE_WALLET
    );

    const jumperAmount = fromSmallestUnit(q.toAmount, q.decimals);
    const jumperBest = { amount: jumperAmount, bridge: q.bridge };

    if (mayanBest && mayanBest.amount.gt(jumperBest.amount)) {
      backTokenAmount = mayanBest.amount;
      bridgeTo = mayanBest.bridge;
    } else {
      backTokenAmount = jumperBest.amount;
      bridgeTo = jumperBest.bridge;
    }
  } catch (e) {
    console.error(`[${nowTs()}] Error SOL→BASE via QUOTE:`, e);
    return;
  }

  const profit = backTokenAmount.sub(BASE_AMOUNT);
  const pct = profit.div(BASE_AMOUNT).mul(100);

  const bestRoute = {
    fromAmount: BASE_AMOUNT,
    toAmount: toTokenAmount,
    backAmount: backTokenAmount,
    bridgeFrom,
    bridgeTo,
    profit,
    pct
  };

  logBestRoute(bestRoute);

  const threshold = bridgeFrom.toLowerCase() === "mayan" ? MAYAN_PROFIT_THRESHOLD : PROFIT_THRESHOLD;

  if (profit.gte(threshold)) {
    const msg =
      `*ARBITRAGE ALERT*\n` +
      `Profit: ${profit.toFixed(6)} ${BACK_TOKEN_SYMBOL}\n` +
      `----\n` +
      `Bridge 1: ${bridgeFrom}\n` +
      `Bridge 2: ${bridgeTo}\n` +
      `Received: ${toTokenAmount.toFixed(6)} ${TO_TOKEN_SYMBOL}\n` +
      `Returned: ${backTokenAmount.toFixed(6)} ${BACK_TOKEN_SYMBOL}`;

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
