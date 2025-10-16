// optimized-arb-bot.js
import fetch from "node-fetch";
import https from "https";
import http from "http";
import { Decimal } from "decimal.js";
import { fetchQuote } from "@mayanfinance/swap-sdk";
import dotenv from "dotenv";
dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BASE_WALLET = process.env.BASE_WALLET;
const SOLANA_WALLET = process.env.SOLANA_WALLET;

const BASE_AMOUNT_ETH = new Decimal("2.0");
const PROFIT_THRESHOLD_ETH = new Decimal("0.0025");
const MAYAN_PROFIT_THRESHOLD_ETH = new Decimal("0.005");
const POLL_INTERVAL = 20_000; // 20s - możesz zmienić
const REQUEST_TIMEOUT_MS = 7000; // timeout dla pojedynczych żądań

// chain ids (zgodne z wcześniejszym kodem)
const FROM_CHAIN = 8453; // Base
const MIDDLE_CHAIN = 1151111081099710; // Solana
const TO_CHAIN = 8453; // Base

const EVM_NATIVE = "0x0000000000000000000000000000000000000000";
const SOL_NATIVE = "11111111111111111111111111111111";

// keep-alive agents dla fetch
const httpsAgent = new https.Agent({ keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

// prosty cache ostatnich alertów: key = `${bridgeFrom}-${bridgeTo}`, value = {profit: Decimal, ts: Date}
const lastAlerts = new Map();

function nowTs() {
  return new Date().toISOString().split("T")[1].split(".")[0];
}

async function sendTelegramMessage(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
      agent: (parsedUrl => parsedUrl.protocol === "http:" ? httpAgent : httpsAgent)(new URL(url))
    });
  } catch (e) {
    console.error(`[${nowTs()}] Telegram send error:`, e.message || e);
  }
}

function toSmallestUnit(amountDecimal, decimals) {
  return amountDecimal.mul(Decimal.pow(10, decimals)).toFixed(0);
}
function fromSmallestUnit(amountStrOrDecimal, decimals) {
  return new Decimal(amountStrOrDecimal).div(Decimal.pow(10, decimals));
}

// helper fetch with timeout & keepAlive
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const opts = { ...options, signal: controller.signal };
    // attach agent if not provided
    if (!opts.agent) {
      const parsed = new URL(url);
      opts.agent = parsed.protocol === "http:" ? httpAgent : httpsAgent;
    }
    const res = await fetch(url, opts);
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// pobiera routes z Jumper (LiFi)
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
    fromAmount: String(fromAmount),
    fromChainId: fromChain,
    fromTokenAddress: fromToken,
    toAddress,
    toChainId: toChain,
    toTokenAddress: toToken,
    options: { integrator: "jumper.exchange", order: "CHEAPEST", maxPriceImpact: 0.4, allowSwitchChain: true }
  };

  const res = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(payload) }, REQUEST_TIMEOUT_MS);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Jumper API error ${res.status} ${t}`);
  }
  const data = await res.json();
  if (!data.routes || data.routes.length === 0) throw new Error("No routes from Jumper");
  return data.routes;
}

// parsuje route Jumper => zwraca { toAmount: Decimal, decimals: Number, bridge: String }
function parseJumperRoute(route) {
  const step = route.steps && route.steps[0] ? route.steps[0] : {};
  const toAmountRaw = route.toAmount || route.toAmountMin;
  if (!toAmountRaw) throw new Error("Missing toAmount in jumper route");
  return {
    toAmount: new Decimal(toAmountRaw),
    decimals: Number(route.toToken && route.toToken.decimals) || 0,
    bridge: (step.tool || "JUMPER").toUpperCase()
  };
}

// pobiera quote z Mayan (adapter), zwraca tablicę { amount: Decimal, bridge: "MAYAN" }
async function getMayanQuote(fromToken, toToken, fromChain, toChain, amountIn64) {
  try {
    const quotes = await fetchQuote({ fromChain, toChain, fromToken, toToken, amountIn64, slippageBps: 300 });
    if (!quotes || !Array.isArray(quotes) || quotes.length === 0) return [];
    return quotes.map(q => ({ amount: new Decimal(q.expectedAmountOut), bridge: "MAYAN" }));
  } catch (e) {
    // nie przerywaj cyklu, loguj i zwróć pustą tablicę
    console.error(`[${nowTs()}] Mayan fetchQuote error:`, e.message || e);
    return [];
  }
}

// wybiera najlepszy jumper route wg najwyższego toAmount (zwraca null jeśli brak)
function bestJumper(routes) {
  if (!routes || routes.length === 0) return null;
  const parsed = routes.map(r => {
    try { return parseJumperRoute(r); } catch (e) { return null; }
  }).filter(Boolean);
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => b.toAmount.minus(a.toAmount).toNumber());
  return parsed[0];
}

// logowanie do konsoli (kolory, format)
function logBestRoute(bestRoute) {
  const colorGreenDim = "\x1b[38;5;112m";
  const colorGray = "\x1b[38;5;240m";
  const colorReset = "\x1b[0m";
  const colorMain = bestRoute.profit.gte(PROFIT_THRESHOLD_ETH) ? colorGreenDim : colorGray;
  const profitMark = bestRoute.profit.gt(0) ? "▲" : "▼";
  console.log(
    `${colorMain}[${nowTs()}] ${profitMark} ${bestRoute.fromAmount.toFixed(6)} ETH -> ${bestRoute.toAmount.toFixed(6)} SOL (${bestRoute.bridgeFrom}) -> ${bestRoute.backAmount.toFixed(6)} ETH (${bestRoute.bridgeTo}) | PROFIT: ${bestRoute.profit.toFixed(6)} ETH (${bestRoute.pct.toFixed(3)}%)${colorReset}`
  );
}

// thresholdy per combo
const PROFIT_THRESHOLDS = {
  "MAYAN-MAYAN": MAYAN_PROFIT_THRESHOLD_ETH,
  "MAYAN-JUMPER": new Decimal("0.003"),
  "JUMPER-MAYAN": new Decimal("0.003"),
  "JUMPER-JUMPER": PROFIT_THRESHOLD_ETH
};

// core: pobiera wszystkie potrzebne źródła równolegle i ocenia wszystkie kombinacje
async function checkOnceOptimized() {
  // smallest unit wejściowe (wei)
  const fromAmountSmallest = BASE_AMOUNT_ETH.mul(Decimal.pow(10, 18)).toFixed(0);

  // uruchom równolegle:
  // 1) Jumper Base->Sol
  // 2) Mayan Base->Sol
  // 3) Jumper Sol->Base (potrzebne amount sor) - with smallest unit computed from sol amount later? -> but we can request jumper routes for guessed amount after we know sol amount.
  // Aby ograniczyć żądań: najpierw pobierz Base->Sol (Jumper) i Mayan Base->Sol równolegle, wybierz candidates for solAmount.
  let jumperBaseSolRoutes = [];
  let mayanBaseSolQuotes = [];
  const tasks1 = [
    getJumperRoutes(BASE_WALLET, SOLANA_WALLET, FROM_CHAIN, MIDDLE_CHAIN, EVM_NATIVE, SOL_NATIVE, fromAmountSmallest)
      .then(r => (jumperBaseSolRoutes = r))
      .catch(e => { console.error(`[${nowTs()}] Jumper Base->Sol error:`, e.message || e); jumperBaseSolRoutes = []; }),
    (async () => {
      // Mayan expects amountIn64: scale may differ per direction; using 64-bit amount param as string
      // For base->sol amountIn64, we need to pass BASE amount scaled to 1e18? previous code used amountIn64 for sol->base: scaled to 1e9 (sol decimals).
      // For Mayan base->sol we'll pass base amount scaled to 1e18 as string.
      try {
        const amountIn64 = BASE_AMOUNT_ETH.mul(Decimal.pow(10, 18)).toFixed(0);
        mayanBaseSolQuotes = await getMayanQuote(EVM_NATIVE, SOL_NATIVE, "base", "solana", amountIn64);
      } catch (e) {
        console.error(`[${nowTs()}] Mayan Base->Sol error:`, e.message || e);
        mayanBaseSolQuotes = [];
      }
    })()
  ];
  await Promise.all(tasks1);

  // Zbuduj listę kandydatów dla Base->Sol: każda pozycja: { solAmount: Decimal, bridgeFrom: "JUMPER"|"MAYAN", backData: { ... } }
  const forwardCandidates = [];

  // z Jumper Base->Sol: wybierz najlepszy jumper route (największe toAmount)
  const bestJumperBase = bestJumper(jumperBaseSolRoutes);
  if (bestJumperBase) {
    // convert to SOL decimal
    const solAmount = fromSmallestUnit(bestJumperBase.toAmount, bestJumperBase.decimals);
    forwardCandidates.push({ solAmount, bridgeFrom: bestJumperBase.bridge, raw: { source: "JUMPER", route: bestJumperBase } });
  }

  // z Mayan Base->Sol:
  if (mayanBaseSolQuotes && mayanBaseSolQuotes.length > 0) {
    // mayanBaseSolQuotes[].amount prawdopodobnie w najmniejszych jednostkach docelowego tokena (expectedAmountOut)
    // Jeśli expectedAmountOut jest już w najmniejszych jednostkach SOL (1e9), musimy przeliczyć na SOL - założymy, że expectedAmountOut odpowiada najmniejszej jednostce docelowej (tak jak wcześniej).
    // map from earlier code: they used new Decimal(q.expectedAmountOut) directly then later fromSmallestUnit by decimals. Tutaj nie mamy decimals więc zakładamy 9 (SOL).
    const q0 = mayanBaseSolQuotes[0];
    const solAmount = fromSmallestUnit(q0.amount, 9);
    forwardCandidates.push({ solAmount, bridgeFrom: "MAYAN", raw: { source: "MAYAN", quote: q0 } });
  }

  if (forwardCandidates.length === 0) {
    console.error(`[${nowTs()}] No forward candidates (Base->Sol) found`);
    return;
  }

  // dla każdego forwardCandidate ustalimy najlepszy powrót (Sol->Base) — pobieramy równolegle Mayan(Sol->Base) i Jumper(Sol->Base) dla tej konkretnej ilości SOL
  // żeby przyspieszyć: dla wszystkich unikatowych solAmount wykonamy równoległe zapytania do Jumper i Mayan
  const uniqueSolAmounts = [...new Map(forwardCandidates.map(c => [c.solAmount.toFixed(9), c.solAmount])).values()];

  // map solAmountKey -> { jumperRoutes: [], mayanQuotes: [] }
  const backDataBySol = {};

  await Promise.all(uniqueSolAmounts.map(async solAmt => {
    const solKey = solAmt.toFixed(9);
    backDataBySol[solKey] = { jumperRoutes: [], mayanQuotes: [] };
    const amountIn64ForMayan = solAmt.mul(Decimal.pow(10, 9)).toFixed(0);
    const amountSmallestForJumper = toSmallestUnit(solAmt, 9);

    const pJumper = getJumperRoutes(SOLANA_WALLET, BASE_WALLET, MIDDLE_CHAIN, TO_CHAIN, SOL_NATIVE, EVM_NATIVE, amountSmallestForJumper)
      .then(r => backDataBySol[solKey].jumperRoutes = r)
      .catch(e => { console.error(`[${nowTs()}] Jumper Sol->Base error (sol=${solKey}):`, e.message || e); backDataBySol[solKey].jumperRoutes = []; });

    const pMayan = getMayanQuote(SOL_NATIVE, EVM_NATIVE, "solana", "base", amountIn64ForMayan)
      .then(q => backDataBySol[solKey].mayanQuotes = q)
      .catch(e => { console.error(`[${nowTs()}] Mayan Sol->Base error (sol=${solKey}):`, e.message || e); backDataBySol[solKey].mayanQuotes = []; });

    await Promise.all([pJumper, pMayan]);
  }));

  // Teraz ocenimy wszystkie kombinacje bridgeFrom x bridgeTo dla każdych forwardCandidates
  const evaluated = [];

  for (const fc of forwardCandidates) {
    const solKey = fc.solAmount.toFixed(9);
    const backData = backDataBySol[solKey] || { jumperRoutes: [], mayanQuotes: [] };

    // candidate Jumper back:
    const bestJumperBack = bestJumper(backData.jumperRoutes);
    if (bestJumperBack) {
      const ethBack = fromSmallestUnit(bestJumperBack.toAmount, bestJumperBack.decimals);
      evaluated.push({
        bridgeFrom: fc.bridgeFrom,
        bridgeTo: bestJumperBack.bridge,
        solAmount: fc.solAmount,
        ethBack,
        sourceCombo: `${fc.raw.source}-JUMPER`
      });
    }

    // candidate Mayan back:
    if (backData.mayanQuotes && backData.mayanQuotes.length > 0) {
      // mayanQuotes[0].amount reprezentuje expectedAmountOut; zakładamy, że to smallest unit (wei-like) dla ETH (18)
      const q0 = backData.mayanQuotes[0];
      // Przyjmujemy, że q0.amount to już integer w najmniejszych jednostkach tokena docelowego (ETH -> 1e18)
      // Jeśli SDK zwraca different scale, trzeba dostosować. Tutaj zachowujemy wcześniejsze założenia.
      const ethBack = fromSmallestUnit(q0.amount, 18);
      evaluated.push({
        bridgeFrom: fc.bridgeFrom,
        bridgeTo: "MAYAN",
        solAmount: fc.solAmount,
        ethBack,
        sourceCombo: `${fc.raw.source}-MAYAN`
      });
    }
  }

  if (evaluated.length === 0) {
    console.error(`[${nowTs()}] No evaluated return candidates`);
    return;
  }

  // wybierz najlepszą kombinację według największego ethBack
  evaluated.sort((a, b) => b.ethBack.minus(a.ethBack).toNumber());
  const best = evaluated[0];

  // obliczenia profitu
  const profit = best.ethBack.sub(BASE_AMOUNT_ETH);
  const pct = profit.div(BASE_AMOUNT_ETH).mul(100);

  const bestRoute = {
    fromAmount: BASE_AMOUNT_ETH,
    toAmount: best.solAmount,
    backAmount: best.ethBack,
    bridgeFrom: best.bridgeFrom,
    bridgeTo: best.bridgeTo,
    profit,
    pct
  };

  logBestRoute(bestRoute);

  // threshold per combo
  const key = `${bestRoute.bridgeFrom.toUpperCase()}-${bestRoute.bridgeTo.toUpperCase()}`;
  const threshold = PROFIT_THRESHOLDS[key] || PROFIT_THRESHOLD_ETH;

  // de-dup alerts: alertuj tylko jeśli profit >= threshold i jest istotnie większy niż ostatni alert dla tej kombinacji
  if (profit.gte(threshold)) {
    const mapKey = `${bestRoute.bridgeFrom}-${bestRoute.bridgeTo}`;
    const last = lastAlerts.get(mapKey);
    const minDelta = new Decimal("0.0001"); // minimalna różnica, żeby ponowić alert
    let shouldAlert = false;
    if (!last) shouldAlert = true;
    else if (profit.sub(last.profit).gt(minDelta)) shouldAlert = true;

    if (shouldAlert) {
      const alertHeader = profit.gte(0.01) ? "*SUPER ARBITRAGE ALERT*" : "*ARBITRAGE ALERT*";
      const msg = `${alertHeader}\n\`Profit: ${profit.toFixed(6)} ETH\`\n----------------------------\n*Bridge 1:* ${bestRoute.bridgeFrom} (Base→Solana)\n*Bridge 2:* ${bestRoute.bridgeTo} (Solana→Base)\n*Received:* \`${bestRoute.toAmount.toFixed(6)} SOL\`\n*Returned:* \`${bestRoute.backAmount.toFixed(6)} ETH\`\n*Profit:* \`${profit.toFixed(6)} ETH (${pct.toFixed(3)}%)\`\n----------------------------`;
      await sendTelegramMessage(msg);
      lastAlerts.set(mapKey, { profit: profit, ts: Date.now() });
    }
  }
}

// główna pętla
async function mainLoop() {
  while (true) {
    const start = Date.now();
    try {
      await checkOnceOptimized();
    } catch (e) {
      console.error(`[${nowTs()}] checkOnceOptimized error:`, e.message || e);
    }
    const elapsed = Date.now() - start;
    const sleepFor = Math.max(0, POLL_INTERVAL - elapsed);
    await new Promise(r => setTimeout(r, sleepFor));
  }
}

mainLoop().catch(e => console.error("Fatal:", e));
