import fetch from "node-fetch";
import { Decimal } from "decimal.js";
import { fetchQuote } from "@mayanfinance/swap-sdk";
import dotenv from "dotenv";
dotenv.config();

// Użycie klucza API z dotenv (zalecane)
const LIFI_API_KEY = process.env.LIFI_API_KEY;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BASE_WALLET = process.env.BASE_WALLET; 
const SOLANA_WALLET = process.env.SOLANA_WALLET;

const BASE_AMOUNT = new Decimal(process.env.BASE_AMOUNT || "2.0");
const PROFIT_THRESHOLD = new Decimal(process.env.PROFIT_THRESHOLD || "0.008");
const MAYAN_PROFIT_THRESHOLD = new Decimal(process.env.MAYAN_PROFIT_THRESHOLD || "0.015");
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "15000");

const FROM_CHAIN = 8453; // Base
const TO_CHAIN = FROM_CHAIN; // Base
const MIDDLE_CHAIN = 1151111081099710; // Solana - ID używane przez LI.FI (ASCII "solana")

const FROM_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000"; // ETH na Base
const TO_TOKEN_ADDRESS = "11111111111111111111111111111111"; // SOL na Solana
const BACK_TOKEN_ADDRESS = FROM_TOKEN_ADDRESS; // ETH na Base

const FROM_TOKEN_DECIMALS = 18;
const TO_TOKEN_DECIMALS = 9;
const BACK_TOKEN_DECIMALS = FROM_TOKEN_DECIMALS;

const FROM_TOKEN_SYMBOL = "ETH";
const TO_TOKEN_SYMBOL = "SOL";
const BACK_TOKEN_SYMBOL = "ETH";

function nowTs() {
  return new Date().toISOString().split("T")[1].split(".")[0];
}

function toSmallestUnit(amount, decimals) {
  return amount.mul(Decimal.pow(10, decimals)).toFixed(0);
}

function fromSmall(amount, decimals) {
  return new Decimal(amount).div(Decimal.pow(10, decimals));
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

// --- Relay Base -> Sol (Krok 1) ---
async function relayBaseToSol(amountSmall) {
  const url = "https://api.relay.link/quote";
  const body = {
    user: BASE_WALLET,
    recipient: SOLANA_WALLET,
    originChainId: FROM_CHAIN, 
    destinationChainId: 792703809, // ID Solany używane przez Relay
    originCurrency: FROM_TOKEN_ADDRESS,
    destinationCurrency: TO_TOKEN_ADDRESS,
    amount: amountSmall,
    tradeType: "EXACT_INPUT"
  };

  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();

  if (!data.details || !data.details.currencyOut || !data.details.currencyOut.amount) {
    throw new Error("Relay returned no currencyOut.amount");
  }

  return {
    bridge: "Relay",
    amount: fromSmall(data.details.currencyOut.amount, TO_TOKEN_DECIMALS)
  };
}

// --- LI.FI/Jumper Kwotowanie (Zastępuje gasZipSolToBase) (Krok 2) ---

function parseRoute(route) {
  const step = route.steps[0];
  const toAmountRaw = route.toAmount || route.toAmountMin;
  return {
    amount: fromSmall(toAmountRaw, route.toToken.decimals),
    bridge: step.tool
  };
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
    options: {
      allowSwitchChain: true,
      order: "CHEAPEST" // Zmieniono z CHEAPEST na BEST_RETURN dla maksymalizacji zysku
    }
  };

  const headers = {
    "accept": "*/*",
    "content-type": "application/json",
    "origin": "https://jumper.exchange", 
    "referer": "https://jumper.exchange/",
    "user-agent": "Mozilla/5.0",
    "x-lifi-integrator": "jumper.exchange",
    "X-API-Key": LIFI_API_KEY // DODANY KLUCZ API
  };

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const data = await res.json();

  if (!data.routes || data.routes.length === 0) {
    console.log(`[${nowTs()}] LI.FI/Jumper: No routes found. Error:`, data.message || "Unknown error");
    return [];
  }
  
  // Zwraca listę sparowanych obiektów z kwotą i mostem
  return data.routes.map(parseRoute);
}

// --- MAYAN Sol -> Base (Krok 2 - alternatywa) ---
async function mayanSolToBase(amountSmallStr) {
  try {
    const quotes = await fetchQuote({
      fromChain: "solana",
      toChain: "base",
      fromToken: TO_TOKEN_ADDRESS,
      toToken: BACK_TOKEN_ADDRESS,
      amountIn64: amountSmallStr,
      slippageBps: 300
    });

    if (!quotes || quotes.length === 0) return null;

    return {
      bridge: "MAYAN",
      amount: fromSmall(quotes[0].expectedAmountOutBaseUnits, BACK_TOKEN_DECIMALS)
    };
  } catch (e) {
    console.error(`[${nowTs()}] Mayan quote error:`, e.message);
    return null;
  }
}


// --- Logging ---
function logBestRoute(bestRoute) {
  const colorGreenDim = "\x1b[38;5;112m";
  const colorGray = "\x1b[38;5;240m";
  const colorReset = "\x1b[0m";

  const colorMain = bestRoute.profit.gte(PROFIT_THRESHOLD) ? colorGreenDim : colorGray;
  const profitMark = bestRoute.profit.gt(0) ? "▲" : "▼";

  console.log(
    `${colorMain}[${nowTs()}] ${profitMark} ${bestRoute.fromAmount.toFixed(6)} ${FROM_TOKEN_SYMBOL} -> ${bestRoute.toAmount.toFixed(6)} ${TO_TOKEN_SYMBOL} (${bestRoute.bridgeFrom}) -> ${bestRoute.backAmount.toFixed(6)} ${BACK_TOKEN_SYMBOL} (${bestRoute.bridgeTo}) | PROFIT: ${bestRoute.profit.toFixed(6)} ${BACK_TOKEN_SYMBOL} (${bestRoute.pct.toFixed(3)}%)${colorReset}`
  );
}

async function checkOnce() {
  const fromAmountSmall = toSmallestUnit(BASE_AMOUNT, FROM_TOKEN_DECIMALS);

  let toTokenAmount, bridgeFrom;
  
  // --- Krok 1: Base -> Solana przez Relay ---
  try {
    const relayQuote = await relayBaseToSol(fromAmountSmall);
    toTokenAmount = relayQuote.amount;
    bridgeFrom = relayQuote.bridge;
  } catch (e) {
    console.error(`[${nowTs()}] Relay error:`, e.message);
    return;
  }

  // Kwota SOL w najmniejszych jednostkach (lamports)
  const amount64 = toSmallestUnit(toTokenAmount, TO_TOKEN_DECIMALS);

  // --- Krok 2: Solana -> Base (Zbieranie i Porównanie kwotowań) ---
  const quotes = [];
  
  // 1. Kwotowanie Mayan (Włączone ponownie w celu pełnej optymalizacji zysku)
  try {
    const mayanQuote = await mayanSolToBase(amount64);
    if (mayanQuote) quotes.push(mayanQuote);
  } catch (e) {
    console.error(`[${nowTs()}] Mayan quote error:`, e.message);
  }

  // 2. Kwotowanie LI.FI (zawiera GasZip i inne mosty)
  try {
    // getLifiRoutes zwraca listę { amount: Decimal, bridge: string }
    const lifiQuotes = await getLifiRoutes({
      fromAddress: SOLANA_WALLET,
      toAddress: BASE_WALLET,
      fromChain: MIDDLE_CHAIN, 
      toChain: TO_CHAIN, 
      fromToken: TO_TOKEN_ADDRESS,
      toToken: BACK_TOKEN_ADDRESS,
      fromAmount: amount64
    });
    
    // Filtrowanie: Używamy tylko kwotowań spoza Mayana (żeby unikać duplikacji)
    const filteredLifiQuotes = lifiQuotes.filter(q => !q.bridge.toLowerCase().includes("mayan"));
    quotes.push(...filteredLifiQuotes);

  } catch (e) {
    console.error(`[${nowTs()}] LI.FI quote error:`, e.message);
  }

  // 3. Wybór najlepszego mostu (logika ulepszona)
  if (quotes.length === 0) {
    console.log(`[${nowTs()}] Brak dostępnych mostów powrotnych (Mayan/LI.FI)`);
    return;
  }

  const bestQuote = quotes.sort((a, b) => b.amount.minus(a.amount).toNumber())[0];

  const backTokenAmount = bestQuote.amount;
  const bridgeTo = bestQuote.bridge;
  
  // --- Wynik ---
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

  // Użycie progu dla Mayana lub ogólnego
  const threshold = bridgeTo === "MAYAN" ? MAYAN_PROFIT_THRESHOLD : PROFIT_THRESHOLD;
  
  if (profit.gte(threshold)) {
    const alertHeader = profit.gte(BACK_TOKEN_SYMBOL === "ETH" ? 0.01 : 10.0) ? "*SUPER ARBITRAGE ALERT*" : "*ARBITRAGE ALERT*";
    const msg = `${alertHeader}\n\`Profit: ${profit.toFixed(6)} ${BACK_TOKEN_SYMBOL}\`\n----------------------------\n*Bridge 1:* ${bridgeFrom} (Base→Solana)\n*Bridge 2:* ${bridgeTo} (Solana→Base)\n*Received:* \`${toTokenAmount.toFixed(6)} ${TO_TOKEN_SYMBOL}\`\n*Returned:* \`${backTokenAmount.toFixed(6)} ${BACK_TOKEN_SYMBOL}\`\n----------------------------`;
    await sendTelegramMessage(msg);
  }
}

// --- Main loop ---
async function mainLoop() {
  while (true) {
    const start = Date.now();
    await checkOnce();
    const elapsed = Date.now() - start;
    await new Promise(r => setTimeout(r, Math.max(0, POLL_INTERVAL - elapsed)));
  }
}

mainLoop();


