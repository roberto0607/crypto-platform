"""main.py — FastAPI cycle analysis service.

Fetches full BTC daily history from CoinGecko on startup (from 2012-11-28
first-halving date to now), caches in memory, refreshes every 24h. If the
initial fetch fails, retries every 60 seconds rather than failing hard.

Endpoints:
  GET /health            — liveness probe
  GET /cycle/analysis    — full cycle snapshot (5-min cached)
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import List, Tuple

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException

from analog import find_top_analogs
from cycle import HALVINGS, get_cycle_position, get_power_law_position
from onchain import build_onchain_section, moving_average

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("cycle-engine")

COINGECKO_BASE = os.getenv("COINGECKO_BASE_URL", "https://api.coingecko.com/api/v3")
FIRST_HALVING_UNIX = 1354060800  # 2012-11-28
ANALYSIS_CACHE_TTL_SEC = 300      # 5 min (PART 2D spec)
DATA_REFRESH_INTERVAL_SEC = 86400  # 24h
RETRY_INTERVAL_SEC = 60            # per user spec on fetch failure


class DataStore:
    """In-memory cache of the CoinGecko daily history."""

    def __init__(self) -> None:
        self.dates: List[datetime] = []
        self.prices: np.ndarray = np.array([])
        self.market_caps: np.ndarray = np.array([])
        self.volumes: np.ndarray = np.array([])
        self.loaded: bool = False
        self.loaded_at: datetime | None = None
        # 5-min analysis cache
        self.analysis_cache: dict | None = None
        self.analysis_cache_at: datetime | None = None

    async def fetch(self) -> None:
        now_unix = int(datetime.utcnow().timestamp())
        url = (
            f"{COINGECKO_BASE}/coins/bitcoin/market_chart/range"
            f"?vs_currency=usd&from={FIRST_HALVING_UNIX}&to={now_unix}&precision=2"
        )
        log.info("fetching CoinGecko %s", url)
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()

        prices_raw = data.get("prices") or []
        caps_raw = data.get("market_caps") or []
        vols_raw = data.get("total_volumes") or []

        if not prices_raw:
            raise RuntimeError("CoinGecko returned empty prices")

        self.dates = [datetime.utcfromtimestamp(p[0] / 1000) for p in prices_raw]
        self.prices = np.array([p[1] for p in prices_raw], dtype=float)
        self.market_caps = (
            np.array([p[1] for p in caps_raw], dtype=float)
            if caps_raw
            else np.zeros_like(self.prices)
        )
        self.volumes = (
            np.array([p[1] for p in vols_raw], dtype=float)
            if vols_raw
            else np.zeros_like(self.prices)
        )
        self.loaded = True
        self.loaded_at = datetime.utcnow()
        # Invalidate analysis cache on fresh data
        self.analysis_cache = None
        self.analysis_cache_at = None

        log.info(
            "loaded %d daily points %s → %s",
            len(self.dates),
            self.dates[0].strftime("%Y-%m-%d") if self.dates else "-",
            self.dates[-1].strftime("%Y-%m-%d") if self.dates else "-",
        )


store = DataStore()


async def loader_task() -> None:
    """Startup: retry every 60s until success; thereafter refresh daily."""
    while True:
        try:
            await store.fetch()
            await asyncio.sleep(DATA_REFRESH_INTERVAL_SEC)
        except Exception as err:  # noqa: BLE001 — catch-all by design
            log.warning("CoinGecko fetch failed: %s — retrying in %ds", err, RETRY_INTERVAL_SEC)
            await asyncio.sleep(RETRY_INTERVAL_SEC)


@asynccontextmanager
async def lifespan(app: FastAPI):
    loader = asyncio.create_task(loader_task())
    try:
        yield
    finally:
        loader.cancel()
        try:
            await loader
        except asyncio.CancelledError:
            pass


app = FastAPI(title="cycle-engine", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    """Gated on `store.loaded` so Railway's healthcheck actually waits for
    the CoinGecko fetch to complete before marking the deploy healthy.

    Returns 503 until the first successful data load (typically 3-10s on
    warm CoinGecko, longer if rate-limited). Paired with a 120s
    healthcheckTimeout in railway.toml.
    """
    if not store.loaded:
        raise HTTPException(status_code=503, detail="loading historical data")
    return {"status": "ok", "dataLoaded": True}


def _build_daily_onchain(
    prices: np.ndarray,
    caps: np.ndarray,
    dates: List[datetime],
) -> Tuple[List[dict], np.ndarray]:
    """Per-day MVRV/NUPL/Puell scalars + cycle-days array.

    Analog matching scores each candidate window by its end-of-window
    on-chain state, so we materialize these once instead of per-candidate.
    """
    n = prices.size

    # MVRV: caps / 155d MA (zero-padded at start until we have enough data)
    mvrv_series = np.zeros(n)
    if caps.size >= 155:
        ma155 = moving_average(caps, 155)
        mvrv_series[154:] = caps[154:] / np.maximum(ma155, 1.0)

    # Puell: price / 365d MA price
    puell_series = np.zeros(n)
    if prices.size >= 365:
        ma365 = moving_average(prices, 365)
        puell_series[364:] = prices[364:] / np.maximum(ma365, 1e-9)

    # NUPL derives from MVRV
    nupl_series = np.zeros(n)
    nz = mvrv_series > 0
    nupl_series[nz] = (mvrv_series[nz] - 1) / mvrv_series[nz]

    daily = [
        {
            "mvrv": float(mvrv_series[i]),
            "nupl": float(nupl_series[i]),
            "puell": float(puell_series[i]),
        }
        for i in range(n)
    ]

    cycle_days = np.zeros(n)
    for i, d in enumerate(dates):
        last_h = max((h for h in HALVINGS if h <= d), default=HALVINGS[0])
        cycle_days[i] = (d - last_h).days

    return daily, cycle_days


def _build_analysis() -> dict:
    if not store.loaded or store.prices.size == 0:
        raise HTTPException(status_code=503, detail="data not loaded")

    current_price = float(store.prices[-1])
    today = store.dates[-1]

    cycle = get_cycle_position(today)
    hist_for_pl = list(zip(store.dates, store.prices.tolist()))
    power = get_power_law_position(current_price, hist_for_pl)

    onchain = build_onchain_section(
        store.prices, store.market_caps, store.volumes, current_price,
    )

    daily_onchain, cycle_days = _build_daily_onchain(
        store.prices, store.market_caps, store.dates,
    )
    analogs, consensus = find_top_analogs(
        store.dates, store.prices, daily_onchain, cycle_days,
    )

    # Expose the current 90-day window so the frontend can overlay analogs
    # against the user's "now" trajectory without a second round-trip.
    current_window_prices = store.prices[-90:].round(2).tolist() if store.prices.size >= 90 else []

    return {
        "lastUpdated": datetime.utcnow().isoformat() + "Z",
        "currentPrice": round(current_price, 2),
        "cyclePosition": cycle,
        "powerLaw": power,
        "onChain": onchain,
        "currentWindow": {
            "prices": current_window_prices,
            "cycleDay": int(cycle_days[-1]) if cycle_days.size else 0,
        },
        "analogs": analogs,
        "consensus": consensus,
        "disclaimer": (
            "Based on 3 historical periods. Past performance does not "
            "guarantee future results. Bitcoin has completed only 3 full "
            "cycles since 2012. Use as context, not trading advice."
        ),
    }


@app.get("/cycle/analysis")
async def cycle_analysis() -> dict:
    if not store.loaded:
        raise HTTPException(status_code=503, detail="data still loading from CoinGecko")

    if (
        store.analysis_cache is not None
        and store.analysis_cache_at is not None
        and (datetime.utcnow() - store.analysis_cache_at).total_seconds() < ANALYSIS_CACHE_TTL_SEC
    ):
        return store.analysis_cache

    result = _build_analysis()
    store.analysis_cache = result
    store.analysis_cache_at = datetime.utcnow()
    return result
