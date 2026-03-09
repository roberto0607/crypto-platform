"""Seasonality Model — learns hourly candle profiles (168 buckets: 24h × 7 days).

Crypto markets have strong intraday seasonality:
  - US market open (14:30 UTC): high volatility, large bodies
  - Asian session (00:00-08:00 UTC): low volatility, small bodies
  - Weekend: reduced volume, more ranging behavior
"""

import json
import logging
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import pandas as pd

logger = logging.getLogger("ml")


@dataclass
class HourlyProfile:
    hour: int                        # 0-23
    day_of_week: int                 # 0-6
    mean_return: float               # Average close-to-close return
    std_return: float                # Standard deviation of return
    mean_body_ratio: float           # |close-open| / (high-low), avg
    mean_upper_wick_ratio: float     # (high - max(o,c)) / (high-low)
    mean_lower_wick_ratio: float     # (min(o,c) - low) / (high-low)
    mean_range_pct: float            # (high-low) / open, avg candle range as %
    bullish_pct: float               # % of candles that were bullish (close > open)
    mean_volume_ratio: float         # volume / rolling_20_avg_volume
    sample_count: int                # Number of candles in this bucket


class SeasonalityModel:
    def __init__(self):
        self.profiles: dict[tuple[int, int], HourlyProfile] = {}
        self.pair_id: str = ""

    def train(self, df: pd.DataFrame) -> dict:
        """Learn hourly profiles from historical candle data."""
        df = df.copy()
        df["hour"] = df["ts"].dt.hour
        df["dow"] = df["ts"].dt.dayofweek
        df["return"] = df["close"].pct_change()
        df["range_pct"] = (df["high"] - df["low"]) / df["open"].replace(0, 1e-10)
        df["body"] = (df["close"] - df["open"]).abs()
        df["full_range"] = df["high"] - df["low"]
        df["body_ratio"] = df["body"] / df["full_range"].replace(0, 1e-10)
        df["upper_wick"] = (df["high"] - df[["open", "close"]].max(axis=1)) / df["full_range"].replace(0, 1e-10)
        df["lower_wick"] = (df[["open", "close"]].min(axis=1) - df["low"]) / df["full_range"].replace(0, 1e-10)
        df["bullish"] = (df["close"] > df["open"]).astype(float)
        df["vol_ma20"] = df["volume"].rolling(20, min_periods=1).mean()
        df["vol_ratio"] = df["volume"] / df["vol_ma20"].replace(0, 1)

        # Drop NaN from pct_change
        df = df.dropna(subset=["return"])

        for (hour, dow), group in df.groupby(["hour", "dow"]):
            if len(group) < 5:
                continue
            self.profiles[(int(hour), int(dow))] = HourlyProfile(
                hour=int(hour),
                day_of_week=int(dow),
                mean_return=float(group["return"].mean()),
                std_return=float(max(group["return"].std(), 1e-6)),
                mean_body_ratio=float(group["body_ratio"].clip(0, 1).mean()),
                mean_upper_wick_ratio=float(group["upper_wick"].clip(0, 1).mean()),
                mean_lower_wick_ratio=float(group["lower_wick"].clip(0, 1).mean()),
                mean_range_pct=float(group["range_pct"].clip(0, 0.1).mean()),
                bullish_pct=float(group["bullish"].mean()),
                mean_volume_ratio=float(group["vol_ratio"].clip(0, 10).mean()),
                sample_count=len(group),
            )

        return {"buckets_learned": len(self.profiles), "total_candles": len(df)}

    def get_profile(self, hour: int, dow: int) -> HourlyProfile:
        """Get profile for a specific hour/day, with fallback to hour-only average."""
        if (hour, dow) in self.profiles:
            return self.profiles[(hour, dow)]
        # Fallback: average across all days for this hour
        hour_profiles = [p for (h, _), p in self.profiles.items() if h == hour]
        if hour_profiles:
            return self._average_profiles(hour_profiles, hour, dow)
        # Ultimate fallback: global average
        return self._default_profile(hour, dow)

    def _average_profiles(self, profiles: list[HourlyProfile], hour: int, dow: int) -> HourlyProfile:
        n = len(profiles)
        return HourlyProfile(
            hour=hour,
            day_of_week=dow,
            mean_return=sum(p.mean_return for p in profiles) / n,
            std_return=sum(p.std_return for p in profiles) / n,
            mean_body_ratio=sum(p.mean_body_ratio for p in profiles) / n,
            mean_upper_wick_ratio=sum(p.mean_upper_wick_ratio for p in profiles) / n,
            mean_lower_wick_ratio=sum(p.mean_lower_wick_ratio for p in profiles) / n,
            mean_range_pct=sum(p.mean_range_pct for p in profiles) / n,
            bullish_pct=sum(p.bullish_pct for p in profiles) / n,
            mean_volume_ratio=sum(p.mean_volume_ratio for p in profiles) / n,
            sample_count=sum(p.sample_count for p in profiles),
        )

    def _default_profile(self, hour: int, dow: int) -> HourlyProfile:
        """Global average fallback when no data exists for this bucket."""
        if self.profiles:
            return self._average_profiles(list(self.profiles.values()), hour, dow)
        # Absolute fallback with reasonable defaults
        return HourlyProfile(
            hour=hour, day_of_week=dow,
            mean_return=0.0, std_return=0.002,
            mean_body_ratio=0.5, mean_upper_wick_ratio=0.2,
            mean_lower_wick_ratio=0.2, mean_range_pct=0.005,
            bullish_pct=0.5, mean_volume_ratio=1.0, sample_count=0,
        )

    def save(self, path: str) -> None:
        data = {
            "pair_id": self.pair_id,
            "profiles": {
                f"{h},{d}": asdict(p)
                for (h, d), p in self.profiles.items()
            },
        }
        Path(path).write_text(json.dumps(data, indent=2))

    @classmethod
    def load(cls, path: str) -> "SeasonalityModel":
        data = json.loads(Path(path).read_text())
        model = cls()
        model.pair_id = data.get("pair_id", "")
        for key, prof_dict in data.get("profiles", {}).items():
            h, d = key.split(",")
            model.profiles[(int(h), int(d))] = HourlyProfile(**prof_dict)
        return model
