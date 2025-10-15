import fetch from "node-fetch";
import { Decimal } from "decimal.js";
import { fetchQuote } from "@mayanfinance/swap-sdk";
import dotenv from "dotenv";
dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BASE_WALLET = process.env.BASE_WALLET;
const SOLANA_WALLET = process.env.SOLANA_WALLET;

const BASE_AMOUNT_ETH = new Decimal("2.0");
const PROFIT_THRESHOLD_ETH = new Decimal("0.003");
const MAYAN_PROFIT_THRESHOLD_ETH = new Decimal("0.006");
const POLL_INTERVAL = 30_000;

const FROM_CHAIN = 8453; // Base
const MIDDLE_CHAIN = 1151111081099710; // Solana
const TO_CHAIN = 8453; // Base

const EVM_NATIVE = "0x0000000000000000000000000000000000000000";
const SOL_NATIVE = "11111111111111111111111111111111";

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
  const colorGreenBright = "\x1b[38;5;46m";   // wyraźny zielony
  const colorGreenDim = "\x1b[38;5;112m";     // wyblakły zielony
  const colorGray = "\x1b[38;5;240m";
  const colorReset = "\x1b[0m";

  const colorMain = bestRoute.profit.gte(PROFIT_THRESHOLD_ETH) ? colorGreenDim : colorGray;
  const profitMark = bestRoute.profit.gt(0) ? "▲" : "▼";

  console.log(`${colorMain}[${nowTs()}] ${profitMark} ${bestRoute.fromAmount.toFixed(6)} ETH -> ${bestRoute.toAmount.toFixed(6)} SOL (${bestRoute.bridgeFrom}) -> ${bestRoute.backAmount.toFixed(6)} ETH (${bestRoute.bridgeTo}) | PROFIT: ${bestRoute.profit.toFixed(6)} ETH (${bestRoute.pct.toFixed(3)}%)${colorReset}`);
}

async function checkOnce() {
  const fromAmountSmallest = BASE_AMOUNT_ETH.mul(Decimal.pow(10, 18));

  // --- Base -> Sol ---
  let solAmount = null, bridgeFrom = "";
  try {
    const routes = await getJumperRoutes(BASE_WALLET, SOLANA_WALLET, FROM_CHAIN, MIDDLE_CHAIN, EVM_NATIVE, SOL_NATIVE, fromAmountSmallest);
    const best = parseJumperRoute(routes[0]);
    solAmount = fromSmallestUnit(best.toAmount, best.decimals);
    bridgeFrom = best.bridge;
  } catch (e) {
    console.error(`[${nowTs()}] Error BASE->SOL via Jumper:`, e);
    return;
  }

  // --- Sol -> Base ---
  let ethBack = null, bridgeTo = "";
  try {
    const amountIn64 = solAmount.mul(Decimal.pow(10, 9)).toFixed(0);
    const mayanQuotes = await getMayanQuote(SOL_NATIVE, EVM_NATIVE, "solana", "base", amountIn64);

    if (bridgeFrom.toLowerCase() !== "mayan" && mayanQuotes.length > 0) {
      ethBack = mayanQuotes[0].amount;
      bridgeTo = "MAYAN";
    } else {
      const routesBack = await getJumperRoutes(SOLANA_WALLET, BASE_WALLET, MIDDLE_CHAIN, TO_CHAIN, SOL_NATIVE, EVM_NATIVE, toSmallestUnit(solAmount, 9));
      const bestBack = parseJumperRoute(routesBack[0]);
      ethBack = fromSmallestUnit(bestBack.toAmount, bestBack.decimals);
      bridgeTo = bestBack.bridge;
    }

  } catch (e) {
    console.error(`[${nowTs()}] Error SOL->BASE:`, e);
    return;
  }

  const profit = ethBack.sub(BASE_AMOUNT_ETH);
  const pct = profit.div(BASE_AMOUNT_ETH).mul(100);

  const bestRoute = {
    fromAmount: BASE_AMOUNT_ETH,
    toAmount: solAmount,
    backAmount: ethBack,
    bridgeFrom,
    bridgeTo,
    profit,
    pct
  };

  logBestRoute(bestRoute);

  const threshold = bridgeFrom.toLowerCase() === "mayan" ? MAYAN_PROFIT_THRESHOLD_ETH : PROFIT_THRESHOLD_ETH;
  if (profit.gte(threshold)) {
    const alertHeader = profit.gte(0.01) ? "*SUPER ARBITRAGE ALERT*" : "*ARBITRAGE ALERT*";
    const msg = `${alertHeader}\n\`Profit: ${profit.toFixed(6)} ETH\`\n----------------------------\n*Bridge 1:* ${bridgeFrom} (Base→Solana)\n*Bridge 2:* ${bridgeTo} (Solana→Base)\n*Received:* \`${solAmount.toFixed(6)} SOL\`\n*Returned:* \`${ethBack.toFixed(6)} ETH\`\n----------------------------`;
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
