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
from forecast import build_forecast
from onchain import build_onchain_section, moving_average

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("cycle-engine")

# CoinGecko's /market_chart/range endpoint went paid-only; CryptoCompare
# /data/v2/histoday is free, no-auth, supports backward pagination via
# `toTs`, and is already trusted elsewhere in the TRADR codebase for
# candle backfill.
CRYPTOCOMPARE_BASE = os.getenv(
    "CRYPTOCOMPARE_BASE_URL",
    "https://min-api.cryptocompare.com/data/v2/histoday",
)
FIRST_HALVING_UNIX = 1354060800  # 2012-11-28
# Constant circulating-supply proxy for market cap derivation. Real BTC
# supply grows slowly (10.4M in 2012 → ~19.85M now) but for MVRV — which
# is a ratio of market_cap to its own rolling MA — the constant cancels,
# so supply-curve accuracy doesn't affect the on-chain metric outputs.
BTC_CIRCULATING_SUPPLY = 19_700_000

ANALYSIS_CACHE_TTL_SEC = 300      # 5 min (PART 2D spec)
DATA_REFRESH_INTERVAL_SEC = 86400  # 24h
RETRY_INTERVAL_SEC = 60            # per user spec on fetch failure
MAX_PAGINATION_CALLS = 10          # safety cap — expect 3-4 in practice


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
        # 5-min forecast cache (separate so a forecast miss doesn't
        # force an analog recompute and vice versa)
        self.forecast_cache: dict | None = None
        self.forecast_cache_at: datetime | None = None

    async def fetch(self) -> None:
        """Paginated fetch of daily BTC history from CryptoCompare.

        CryptoCompare returns up to ~2001 candles per call ending at `toTs`.
        We paginate backward (set each next `toTs` to the earliest timestamp
        we've seen) until we've covered back to the first halving, then
        dedupe + sort ascending. 3-4 calls typically suffice.
        """
        now_unix = int(datetime.utcnow().timestamp())
        to_ts = now_unix
        all_candles: dict[int, dict] = {}  # dedupe by timestamp

        async with httpx.AsyncClient(timeout=60.0) as client:
            for call_idx in range(MAX_PAGINATION_CALLS):
                url = f"{CRYPTOCOMPARE_BASE}?fsym=BTC&tsym=USD&limit=2000&toTs={to_ts}"
                log.info("cryptocompare fetch %d toTs=%d url=%s", call_idx + 1, to_ts, url)
                resp = await client.get(url)
                resp.raise_for_status()
                body = resp.json()

                if body.get("Response") != "Success":
                    raise RuntimeError(f"CryptoCompare error: {body.get('Message')}")

                batch = body.get("Data", {}).get("Data") or []
                if not batch:
                    break

                # Pre-trading / pre-exchange days have close=0. Skip those.
                valid = [c for c in batch if (c.get("close") or 0) > 0]
                for c in valid:
                    all_candles[int(c["time"])] = c

                earliest_ts = int(batch[0]["time"])
                if earliest_ts <= FIRST_HALVING_UNIX:
                    break
                # Pre-2012 we're done even if API has more
                to_ts = earliest_ts

        if not all_candles:
            raise RuntimeError("CryptoCompare returned no usable candles")

        # Filter to first-halving-onward window and sort ascending
        sorted_times = sorted(t for t in all_candles.keys() if t >= FIRST_HALVING_UNIX)
        if not sorted_times:
            raise RuntimeError("no candles in requested date range")

        self.dates = [datetime.utcfromtimestamp(t) for t in sorted_times]
        self.prices = np.array(
            [float(all_candles[t]["close"]) for t in sorted_times],
            dtype=float,
        )
        # Market cap proxy: close price × constant circulating supply. The
        # constant cancels in MVRV's market_cap/MA(market_cap) ratio, so
        # accuracy of the supply figure doesn't affect on-chain outputs.
        self.market_caps = self.prices * BTC_CIRCULATING_SUPPLY
        # CryptoCompare volumeto is USD volume — matches the dollar-volume
        # semantics our Reserve Risk proxy expects.
        self.volumes = np.array(
            [float(all_candles[t].get("volumeto") or 0.0) for t in sorted_times],
            dtype=float,
        )
        self.loaded = True
        self.loaded_at = datetime.utcnow()
        # Invalidate downstream caches on fresh data
        self.analysis_cache = None
        self.analysis_cache_at = None
        self.forecast_cache = None
        self.forecast_cache_at = None

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


@app.get("/cycle/forecast")
async def cycle_forecast() -> dict:
    """Forward-looking roadmap derived from the analog results + observed
    current cycle top. Cached 5 minutes independently of /cycle/analysis."""
    if not store.loaded:
        raise HTTPException(status_code=503, detail="data still loading from CryptoCompare")

    if (
        store.forecast_cache is not None
        and store.forecast_cache_at is not None
        and (datetime.utcnow() - store.forecast_cache_at).total_seconds() < ANALYSIS_CACHE_TTL_SEC
    ):
        return store.forecast_cache

    # Pull analogs from the analysis cache when fresh; otherwise compute
    # them directly (reuses the same helper).
    analysis = None
    if (
        store.analysis_cache is not None
        and store.analysis_cache_at is not None
        and (datetime.utcnow() - store.analysis_cache_at).total_seconds() < ANALYSIS_CACHE_TTL_SEC
    ):
        analysis = store.analysis_cache
    else:
        analysis = _build_analysis()
        store.analysis_cache = analysis
        store.analysis_cache_at = datetime.utcnow()

    analogs = analysis.get("analogs") or []
    result = build_forecast(store.dates, store.prices, analogs)
    store.forecast_cache = result
    store.forecast_cache_at = datetime.utcnow()
    return result
