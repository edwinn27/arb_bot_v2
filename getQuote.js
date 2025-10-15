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
  const toAmountRaw = route.toAmountMin || route.toAmount;
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

// --- funkcja realistyczna: korekta fee/slippage ---
function adjustRealisticAmount(amount, bridge, direction) {
  const FEE_JUMPER_SOL = 0.0025;
  const FEE_JUMPER_EVM = 0.0015;
  const FEE_MAYAN_SOLANA = 0.002;
  const FEE_MAYAN_EVM = 0.0018;
  const SLIPPAGE
