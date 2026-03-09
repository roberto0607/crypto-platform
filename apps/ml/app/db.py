import asyncpg
from app.config import DATABASE_URL

pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global pool
    if pool is None:
        pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=5)
    return pool


async def close_pool() -> None:
    global pool
    if pool:
        await pool.close()
        pool = None


async def fetch_candles(
    pair_id: str, timeframe: str, limit: int = 500
) -> list[asyncpg.Record]:
    """Fetch OHLCV candles from the database, oldest first."""
    p = await get_pool()
    rows = await p.fetch(
        """SELECT ts, open::float, high::float, low::float, close::float, volume::float
           FROM candles
           WHERE pair_id = $1 AND timeframe = $2
           ORDER BY ts ASC
           LIMIT $3""",
        pair_id,
        timeframe,
        limit,
    )
    return rows


async def fetch_pair_id(symbol: str) -> str | None:
    """Get pair UUID from symbol like 'BTC/USD'."""
    p = await get_pool()
    row = await p.fetchrow(
        "SELECT id FROM trading_pairs WHERE symbol = $1 AND is_active = true",
        symbol,
    )
    return str(row["id"]) if row else None


async def fetch_active_pairs() -> list[dict]:
    """Get all active trading pairs."""
    p = await get_pool()
    rows = await p.fetch(
        "SELECT id, symbol FROM trading_pairs WHERE is_active = true ORDER BY symbol"
    )
    return [{"id": str(r["id"]), "symbol": r["symbol"]} for r in rows]
