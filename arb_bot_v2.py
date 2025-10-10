import asyncio
import aiohttp
import time
from decimal import Decimal
from datetime import datetime, timezone
import os

# ---------- KONFIGURACJA ----------
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

BASE_WALLET = os.environ.get("BASE_WALLET")
SOLANA_WALLET = os.environ.get("SOLANA_WALLET")

BASE_AMOUNT_ETH = Decimal("2.0")
PROFIT_THRESHOLD_ETH = Decimal("0.003")
MAYAN_PROFIT_THRESHOLD_ETH = Decimal("0.005")
POLL_INTERVAL = 30.0

# LI.FI chain IDs
CHAIN = {
    "ETH": 1,
    "BASE": 8453,
    "SOLANA": 1151111081099710,
    "ARBITRUM": 42161,
    "POLYGON": 137,
    "OPTIMISM": 10,
}

EVM_NATIVE = "0x0000000000000000000000000000000000000000"
SOL_NATIVE = "11111111111111111111111111111111"
# ---------- KONIEC KONFIGURACJI ----------

def now_ts():
    return datetime.now(timezone.utc).strftime("%H:%M:%S")

async def get_jumper_route(session, from_address, to_address, from_chain, to_chain, from_token, to_token, from_amount):
    url = "https://api.jumper.exchange/p/lifi/advanced/routes"
    headers = {
        "accept": "*/*",
        "content-type": "application/json",
        "origin": "https://jumper.exchange",
        "referer": "https://jumper.exchange/",
        "user-agent": "Mozilla/5.0",
        "x-lifi-integrator": "jumper.exchange",
        "x-lifi-sdk": "3.12.11",
        "x-lifi-widget": "3.32.2",
    }

    payload = {
        "fromAddress": from_address,
        "fromAmount": str(from_amount),
        "fromChainId": from_chain,
        "fromTokenAddress": from_token,
        "toAddress": to_address,
        "toChainId": to_chain,
        "toTokenAddress": to_token,
        "options": {
            "integrator": "jumper.exchange",
            "order": "CHEAPEST",
            "maxPriceImpact": 0.4,
            "allowSwitchChain": True
        }
    }

    async with session.post(url, headers=headers, json=payload) as resp:
        data = await resp.json()
        if "routes" not in data or not data["routes"]:
            raise RuntimeError(f"No routes found ({from_chain}->{to_chain})")
        return data

def parse_jumper_to_amount(data):
    for r in data.get("routes", []):
        tool = r.get("steps", [{}])[0].get("tool", "").lower()
        if "mayanmctp" not in tool:
            to_amount_raw = r.get("toAmount") or r.get("toAmountMin")
            if not to_amount_raw:
                continue
            decimals = int(r["toToken"]["decimals"])
            bridge = r["steps"][0]["tool"]
            return Decimal(to_amount_raw), decimals, bridge
    raise RuntimeError("No valid route found")

def to_smallest_unit(amount_decimal, decimals):
    return str((amount_decimal * (Decimal(10) ** decimals)).to_integral_value())

def from_smallest_unit(amount_str, decimals):
    return Decimal(str(amount_str)) / (Decimal(10) ** decimals)

async def check_pair(session, pair):
    name, cfg = pair
    try:
        from_amount_smallest = int(BASE_AMOUNT_ETH * (10 ** 18))
        data1 = await get_jumper_route(session, cfg["from_addr"], cfg["to_addr"],
                                       cfg["from_chain"], cfg["mid_chain"],
                                       cfg["from_token"], cfg["mid_token"], from_amount_smallest)
        to_amount_raw_1, mid_dec, bridge1 = parse_jumper_to_amount(data1)
        mid_amt = from_smallest_unit(to_amount_raw_1, mid_dec)

        mid_amt_smallest = to_smallest_unit(mid_amt, mid_dec)
        data2 = await get_jumper_route(session, cfg["to_addr"], cfg["from_addr"],
                                       cfg["mid_chain"], cfg["to_chain"],
                                       cfg["mid_token"], cfg["to_token"], mid_amt_smallest)
        to_amount_raw_2, back_dec, bridge2 = parse_jumper_to_amount(data2)
        back_amt = from_smallest_unit(to_amount_raw_2, back_dec)

        profit = back_amt - BASE_AMOUNT_ETH
        pct = (profit / BASE_AMOUNT_ETH * 100)
        color = "\033[1;38;5;46m" if profit > PROFIT_THRESHOLD_ETH else "\033[38;5;240m"
        reset = "\033[0m"
        mark = "▲" if profit > 0 else "▼"

        return f"-------- {name} --------\n" \
               f"{color}[{now_ts()}] {mark} {BASE_AMOUNT_ETH} ETH → {mid_amt:.6f} {cfg['mid_sym']} ({bridge1}) " \
               f"→ {back_amt:.6f} ETH ({bridge2}) | PROFIT: {profit:+.6f} ETH ({pct:+.3f}%) {reset}\n"

    except Exception as e:
        return f"-------- {name} --------\n[{now_ts()}] ERROR: {e}\n"

async def main_loop():
    pairs = [
        ("Base↔Solana", {
            "from_chain": CHAIN["BASE"], "mid_chain": CHAIN["SOLANA"], "to_chain": CHAIN["BASE"],
            "from_token": EVM_NATIVE, "mid_token": SOL_NATIVE, "to_token": EVM_NATIVE,
            "from_addr": BASE_WALLET, "to_addr": SOLANA_WALLET, "mid_sym": "SOL"
        }),
        ("Base↔Arbitrum", {
            "from_chain": CHAIN["BASE"], "mid_chain": CHAIN["ARBITRUM"], "to_chain": CHAIN["BASE"],
            "from_token": EVM_NATIVE, "mid_token": EVM_NATIVE, "to_token": EVM_NATIVE,
            "from_addr": BASE_WALLET, "to_addr": BASE_WALLET, "mid_sym": "ETH"
        }),
        ("Base↔Polygon", {
            "from_chain": CHAIN["BASE"], "mid_chain": CHAIN["POLYGON"], "to_chain": CHAIN["BASE"],
            "from_token": EVM_NATIVE, "mid_token": EVM_NATIVE, "to_token": EVM_NATIVE,
            "from_addr": BASE_WALLET, "to_addr": BASE_WALLET, "mid_sym": "ETH"
        }),
        ("Base↔Optimism", {
            "from_chain": CHAIN["BASE"], "mid_chain": CHAIN["OPTIMISM"], "to_chain": CHAIN["BASE"],
            "from_token": EVM_NATIVE, "mid_token": EVM_NATIVE, "to_token": EVM_NATIVE,
            "from_addr": BASE_WALLET, "to_addr": BASE_WALLET, "mid_sym": "ETH"
        })
    ]

    async with aiohttp.ClientSession() as session:
        while True:
            start = time.time()
            tasks = [check_pair(session, p) for p in pairs]
            results = await asyncio.gather(*tasks)
            print("----------------------------------")
            print("".join(results).strip())
            print("----------------------------------")
            elapsed = time.time() - start
            await asyncio.sleep(max(0.1, POLL_INTERVAL - elapsed))

if __name__ == "__main__":
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        pass
