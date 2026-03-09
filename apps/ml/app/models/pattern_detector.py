"""Geometric chart pattern detection engine.

Detects 10 chart patterns from OHLC data using rule-based geometric analysis.
Optionally boosts/penalizes completion probability using CNN directional agreement.
"""

from dataclasses import dataclass, field
from enum import Enum

import numpy as np


class PatternType(str, Enum):
    DOUBLE_BOTTOM = "DOUBLE_BOTTOM"
    DOUBLE_TOP = "DOUBLE_TOP"
    HEAD_SHOULDERS = "HEAD_SHOULDERS"
    INV_HEAD_SHOULDERS = "INV_HEAD_SHOULDERS"
    BULL_FLAG = "BULL_FLAG"
    BEAR_FLAG = "BEAR_FLAG"
    ASCENDING_TRIANGLE = "ASCENDING_TRIANGLE"
    DESCENDING_TRIANGLE = "DESCENDING_TRIANGLE"
    RISING_WEDGE = "RISING_WEDGE"
    FALLING_WEDGE = "FALLING_WEDGE"


@dataclass
class DetectedPattern:
    pattern_type: PatternType
    status: str  # "forming" | "confirmed"
    completion_pct: float  # How much of the pattern has formed (0-100)
    completion_prob: float  # Probability it will complete (0-100)
    implied_direction: str  # "BUY" or "SELL"
    entry_zone: float  # Price where pattern confirms
    target_price: float  # Measured move target
    invalidation_price: float  # Pattern fails below/above this
    key_points: list = field(default_factory=list)  # [{time, price, label}]
    projection: list = field(default_factory=list)  # [{time, price}]


# ── Helpers ──────────────────────────────────────────────────────────────────


def _find_swing_highs(highs: np.ndarray, lookback: int = 3) -> list[int]:
    """Return indices of swing highs."""
    indices = []
    for i in range(lookback, len(highs) - lookback):
        is_high = True
        for j in range(1, lookback + 1):
            if highs[i - j] >= highs[i] or highs[i + j] >= highs[i]:
                is_high = False
                break
        if is_high:
            indices.append(i)
    return indices


def _find_swing_lows(lows: np.ndarray, lookback: int = 3) -> list[int]:
    """Return indices of swing lows."""
    indices = []
    for i in range(lookback, len(lows) - lookback):
        is_low = True
        for j in range(1, lookback + 1):
            if lows[i - j] <= lows[i] or lows[i + j] <= lows[i]:
                is_low = False
                break
        if is_low:
            indices.append(i)
    return indices


def _linear_regression_slope(values: np.ndarray) -> float:
    """Simple linear regression slope."""
    n = len(values)
    if n < 2:
        return 0.0
    x = np.arange(n, dtype=np.float64)
    x_mean = x.mean()
    y_mean = values.mean()
    denom = np.sum((x - x_mean) ** 2)
    if denom == 0:
        return 0.0
    return float(np.sum((x - x_mean) * (values - y_mean)) / denom)


def _generate_projection(
    current_price: float,
    target_price: float,
    current_time: float,
    timeframe_seconds: int,
    steps: int = 8,
) -> list[dict]:
    """Generate a smooth projection path from current price to target."""
    points = []
    for i in range(steps + 1):
        t_frac = i / steps
        # Ease-in-out curve for natural price movement
        ease = t_frac * t_frac * (3 - 2 * t_frac)
        price = current_price + (target_price - current_price) * ease
        time = current_time + (i + 1) * timeframe_seconds
        points.append({"time": int(time), "price": round(price, 2)})
    return points


# ── Pattern Detectors ────────────────────────────────────────────────────────


def detect_double_bottom(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    times: np.ndarray,
    atr: float,
) -> DetectedPattern | None:
    """Detect double bottom: two lows at similar level with a peak between."""
    swing_low_idxs = _find_swing_lows(lows, lookback=3)
    if len(swing_low_idxs) < 2:
        return None

    # Check the last two swing lows
    for i in range(len(swing_low_idxs) - 1, 0, -1):
        idx2 = swing_low_idxs[i]
        idx1 = swing_low_idxs[i - 1]

        # Must be separated by at least 10 candles
        if idx2 - idx1 < 10:
            continue

        low1 = lows[idx1]
        low2 = lows[idx2]

        # Lows must be within ATR tolerance
        if abs(low1 - low2) > atr * 0.5:
            continue

        # Find peak between the two lows (neckline)
        between = highs[idx1:idx2 + 1]
        peak_offset = int(np.argmax(between))
        peak_idx = idx1 + peak_offset
        neckline = highs[peak_idx]

        # Neckline must be meaningfully above lows
        avg_low = (low1 + low2) / 2
        if neckline - avg_low < atr * 0.5:
            continue

        current_price = closes[-1]
        current_time = float(times[-1])

        # Determine completion
        if current_price > neckline:
            status = "confirmed"
            completion_pct = 100
            completion_prob = 85
        elif idx2 >= len(closes) - 5:
            # Second low is recent, bounce starting
            status = "forming"
            if current_price > avg_low + (neckline - avg_low) * 0.3:
                completion_pct = 85
                completion_prob = 70
            else:
                completion_pct = 70
                completion_prob = 55
        else:
            status = "forming"
            completion_pct = 50
            completion_prob = 40

        target = neckline + (neckline - avg_low)  # Measured move
        invalidation = min(low1, low2) - atr * 0.2

        key_points = [
            {"time": int(times[idx1]), "price": round(float(low1), 2), "label": "L1"},
            {"time": int(times[peak_idx]), "price": round(float(neckline), 2), "label": "NK"},
            {"time": int(times[idx2]), "price": round(float(low2), 2), "label": "L2"},
        ]

        tf_sec = int(times[-1] - times[-2]) if len(times) > 1 else 3600
        projection = _generate_projection(current_price, target, current_time, tf_sec)

        return DetectedPattern(
            pattern_type=PatternType.DOUBLE_BOTTOM,
            status=status,
            completion_pct=completion_pct,
            completion_prob=completion_prob,
            implied_direction="BUY",
            entry_zone=round(float(neckline), 2),
            target_price=round(float(target), 2),
            invalidation_price=round(float(invalidation), 2),
            key_points=key_points,
            projection=projection,
        )

    return None


def detect_double_top(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    times: np.ndarray,
    atr: float,
) -> DetectedPattern | None:
    """Detect double top: two highs at similar level with a trough between."""
    swing_high_idxs = _find_swing_highs(highs, lookback=3)
    if len(swing_high_idxs) < 2:
        return None

    for i in range(len(swing_high_idxs) - 1, 0, -1):
        idx2 = swing_high_idxs[i]
        idx1 = swing_high_idxs[i - 1]

        if idx2 - idx1 < 10:
            continue

        high1 = highs[idx1]
        high2 = highs[idx2]

        if abs(high1 - high2) > atr * 0.5:
            continue

        between = lows[idx1:idx2 + 1]
        trough_offset = int(np.argmin(between))
        trough_idx = idx1 + trough_offset
        neckline = lows[trough_idx]

        avg_high = (high1 + high2) / 2
        if avg_high - neckline < atr * 0.5:
            continue

        current_price = closes[-1]
        current_time = float(times[-1])

        if current_price < neckline:
            status = "confirmed"
            completion_pct = 100
            completion_prob = 85
        elif idx2 >= len(closes) - 5:
            status = "forming"
            if current_price < avg_high - (avg_high - neckline) * 0.3:
                completion_pct = 85
                completion_prob = 70
            else:
                completion_pct = 70
                completion_prob = 55
        else:
            status = "forming"
            completion_pct = 50
            completion_prob = 40

        target = neckline - (avg_high - neckline)
        invalidation = max(high1, high2) + atr * 0.2

        key_points = [
            {"time": int(times[idx1]), "price": round(float(high1), 2), "label": "H1"},
            {"time": int(times[trough_idx]), "price": round(float(neckline), 2), "label": "NK"},
            {"time": int(times[idx2]), "price": round(float(high2), 2), "label": "H2"},
        ]

        tf_sec = int(times[-1] - times[-2]) if len(times) > 1 else 3600
        projection = _generate_projection(current_price, target, current_time, tf_sec)

        return DetectedPattern(
            pattern_type=PatternType.DOUBLE_TOP,
            status=status,
            completion_pct=completion_pct,
            completion_prob=completion_prob,
            implied_direction="SELL",
            entry_zone=round(float(neckline), 2),
            target_price=round(float(target), 2),
            invalidation_price=round(float(invalidation), 2),
            key_points=key_points,
            projection=projection,
        )

    return None


def detect_head_shoulders(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    times: np.ndarray,
    atr: float,
) -> DetectedPattern | None:
    """Detect head and shoulders: three peaks with middle highest."""
    swing_high_idxs = _find_swing_highs(highs, lookback=3)
    if len(swing_high_idxs) < 3:
        return None

    for i in range(len(swing_high_idxs) - 1, 1, -1):
        r_idx = swing_high_idxs[i]
        h_idx = swing_high_idxs[i - 1]
        l_idx = swing_high_idxs[i - 2]

        left_shoulder = highs[l_idx]
        head = highs[h_idx]
        right_shoulder = highs[r_idx]

        # Head must be highest
        if head <= left_shoulder or head <= right_shoulder:
            continue

        # Shoulders within ATR tolerance
        if abs(left_shoulder - right_shoulder) > atr * 0.7:
            continue

        # Head must be meaningfully higher than shoulders
        avg_shoulder = (left_shoulder + right_shoulder) / 2
        if head - avg_shoulder < atr * 0.5:
            continue

        # Neckline: connect the two troughs
        trough1_slice = lows[l_idx:h_idx + 1]
        trough1_offset = int(np.argmin(trough1_slice))
        trough1_idx = l_idx + trough1_offset

        trough2_slice = lows[h_idx:r_idx + 1]
        trough2_offset = int(np.argmin(trough2_slice))
        trough2_idx = h_idx + trough2_offset

        neckline = (lows[trough1_idx] + lows[trough2_idx]) / 2
        current_price = closes[-1]
        current_time = float(times[-1])

        if current_price < neckline:
            status = "confirmed"
            completion_pct = 100
            completion_prob = 80
        elif r_idx >= len(closes) - 5:
            status = "forming"
            completion_pct = 80
            completion_prob = 60
        else:
            status = "forming"
            completion_pct = 60
            completion_prob = 45

        target = neckline - (head - neckline)
        invalidation = head + atr * 0.2

        key_points = [
            {"time": int(times[l_idx]), "price": round(float(left_shoulder), 2), "label": "LS"},
            {"time": int(times[h_idx]), "price": round(float(head), 2), "label": "HD"},
            {"time": int(times[r_idx]), "price": round(float(right_shoulder), 2), "label": "RS"},
            {"time": int(times[trough1_idx]), "price": round(float(lows[trough1_idx]), 2), "label": "NK"},
        ]

        tf_sec = int(times[-1] - times[-2]) if len(times) > 1 else 3600
        projection = _generate_projection(current_price, target, current_time, tf_sec)

        return DetectedPattern(
            pattern_type=PatternType.HEAD_SHOULDERS,
            status=status,
            completion_pct=completion_pct,
            completion_prob=completion_prob,
            implied_direction="SELL",
            entry_zone=round(float(neckline), 2),
            target_price=round(float(target), 2),
            invalidation_price=round(float(invalidation), 2),
            key_points=key_points,
            projection=projection,
        )

    return None


def detect_inv_head_shoulders(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    times: np.ndarray,
    atr: float,
) -> DetectedPattern | None:
    """Detect inverse head and shoulders: three troughs with middle lowest."""
    swing_low_idxs = _find_swing_lows(lows, lookback=3)
    if len(swing_low_idxs) < 3:
        return None

    for i in range(len(swing_low_idxs) - 1, 1, -1):
        r_idx = swing_low_idxs[i]
        h_idx = swing_low_idxs[i - 1]
        l_idx = swing_low_idxs[i - 2]

        left_shoulder = lows[l_idx]
        head = lows[h_idx]
        right_shoulder = lows[r_idx]

        # Head must be lowest
        if head >= left_shoulder or head >= right_shoulder:
            continue

        if abs(left_shoulder - right_shoulder) > atr * 0.7:
            continue

        avg_shoulder = (left_shoulder + right_shoulder) / 2
        if avg_shoulder - head < atr * 0.5:
            continue

        # Neckline from peaks between troughs
        peak1_slice = highs[l_idx:h_idx + 1]
        peak1_offset = int(np.argmax(peak1_slice))
        peak1_idx = l_idx + peak1_offset

        peak2_slice = highs[h_idx:r_idx + 1]
        peak2_offset = int(np.argmax(peak2_slice))
        peak2_idx = h_idx + peak2_offset

        neckline = (highs[peak1_idx] + highs[peak2_idx]) / 2
        current_price = closes[-1]
        current_time = float(times[-1])

        if current_price > neckline:
            status = "confirmed"
            completion_pct = 100
            completion_prob = 80
        elif r_idx >= len(closes) - 5:
            status = "forming"
            completion_pct = 80
            completion_prob = 60
        else:
            status = "forming"
            completion_pct = 60
            completion_prob = 45

        target = neckline + (neckline - head)
        invalidation = head - atr * 0.2

        key_points = [
            {"time": int(times[l_idx]), "price": round(float(left_shoulder), 2), "label": "LS"},
            {"time": int(times[h_idx]), "price": round(float(head), 2), "label": "HD"},
            {"time": int(times[r_idx]), "price": round(float(right_shoulder), 2), "label": "RS"},
            {"time": int(times[peak1_idx]), "price": round(float(highs[peak1_idx]), 2), "label": "NK"},
        ]

        tf_sec = int(times[-1] - times[-2]) if len(times) > 1 else 3600
        projection = _generate_projection(current_price, target, current_time, tf_sec)

        return DetectedPattern(
            pattern_type=PatternType.INV_HEAD_SHOULDERS,
            status=status,
            completion_pct=completion_pct,
            completion_prob=completion_prob,
            implied_direction="BUY",
            entry_zone=round(float(neckline), 2),
            target_price=round(float(target), 2),
            invalidation_price=round(float(invalidation), 2),
            key_points=key_points,
            projection=projection,
        )

    return None


def detect_bull_flag(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    times: np.ndarray,
    atr: float,
) -> DetectedPattern | None:
    """Detect bull flag: sharp move up followed by shallow pullback channel."""
    n = len(closes)
    if n < 20:
        return None

    # Look for a pole in the last 30-50 candles
    for pole_start in range(max(0, n - 50), n - 15):
        # Pole: 5-15 candles of strong upward movement
        for pole_end in range(pole_start + 5, min(pole_start + 16, n - 5)):
            pole_height = highs[pole_end] - lows[pole_start]
            if pole_height < atr * 3:
                continue

            # Flag: subsequent candles pulling back
            flag_candles = closes[pole_end:]
            if len(flag_candles) < 3:
                continue

            # Flag should be a shallow pullback (< 50% of pole)
            flag_low = float(np.min(lows[pole_end:]))
            flag_high = float(np.max(highs[pole_end:]))
            retrace = highs[pole_end] - flag_low
            if retrace > pole_height * 0.5:
                continue

            # Flag should have downward or flat slope
            flag_slope = _linear_regression_slope(closes[pole_end:])
            if flag_slope > 0:
                continue  # Not pulling back

            current_price = closes[-1]
            current_time = float(times[-1])
            flag_top = float(np.max(highs[pole_end:]))

            # Completion based on flag position
            if current_price > flag_top:
                status = "confirmed"
                completion_pct = 100
                completion_prob = 75
            elif len(flag_candles) >= 5:
                status = "forming"
                completion_pct = 75
                completion_prob = 60
            else:
                status = "forming"
                completion_pct = 60
                completion_prob = 45

            target = flag_top + pole_height
            invalidation = flag_low - atr * 0.2

            key_points = [
                {"time": int(times[pole_start]), "price": round(float(lows[pole_start]), 2), "label": "PB"},
                {"time": int(times[pole_end]), "price": round(float(highs[pole_end]), 2), "label": "PT"},
                {"time": int(times[-1]), "price": round(float(current_price), 2), "label": "FL"},
            ]

            tf_sec = int(times[-1] - times[-2]) if len(times) > 1 else 3600
            projection = _generate_projection(current_price, target, current_time, tf_sec)

            return DetectedPattern(
                pattern_type=PatternType.BULL_FLAG,
                status=status,
                completion_pct=completion_pct,
                completion_prob=completion_prob,
                implied_direction="BUY",
                entry_zone=round(float(flag_top), 2),
                target_price=round(float(target), 2),
                invalidation_price=round(float(invalidation), 2),
                key_points=key_points,
                projection=projection,
            )

    return None


def detect_bear_flag(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    times: np.ndarray,
    atr: float,
) -> DetectedPattern | None:
    """Detect bear flag: sharp move down followed by shallow pullback channel."""
    n = len(closes)
    if n < 20:
        return None

    for pole_start in range(max(0, n - 50), n - 15):
        for pole_end in range(pole_start + 5, min(pole_start + 16, n - 5)):
            pole_height = highs[pole_start] - lows[pole_end]
            if pole_height < atr * 3:
                continue

            flag_candles = closes[pole_end:]
            if len(flag_candles) < 3:
                continue

            flag_high = float(np.max(highs[pole_end:]))
            flag_low = float(np.min(lows[pole_end:]))
            retrace = flag_high - lows[pole_end]
            if retrace > pole_height * 0.5:
                continue

            flag_slope = _linear_regression_slope(closes[pole_end:])
            if flag_slope < 0:
                continue  # Not pulling back up

            current_price = closes[-1]
            current_time = float(times[-1])
            flag_bottom = float(np.min(lows[pole_end:]))

            if current_price < flag_bottom:
                status = "confirmed"
                completion_pct = 100
                completion_prob = 75
            elif len(flag_candles) >= 5:
                status = "forming"
                completion_pct = 75
                completion_prob = 60
            else:
                status = "forming"
                completion_pct = 60
                completion_prob = 45

            target = flag_bottom - pole_height
            invalidation = flag_high + atr * 0.2

            key_points = [
                {"time": int(times[pole_start]), "price": round(float(highs[pole_start]), 2), "label": "PT"},
                {"time": int(times[pole_end]), "price": round(float(lows[pole_end]), 2), "label": "PB"},
                {"time": int(times[-1]), "price": round(float(current_price), 2), "label": "FL"},
            ]

            tf_sec = int(times[-1] - times[-2]) if len(times) > 1 else 3600
            projection = _generate_projection(current_price, target, current_time, tf_sec)

            return DetectedPattern(
                pattern_type=PatternType.BEAR_FLAG,
                status=status,
                completion_pct=completion_pct,
                completion_prob=completion_prob,
                implied_direction="SELL",
                entry_zone=round(float(flag_bottom), 2),
                target_price=round(float(target), 2),
                invalidation_price=round(float(invalidation), 2),
                key_points=key_points,
                projection=projection,
            )

    return None


def detect_ascending_triangle(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    times: np.ndarray,
    atr: float,
) -> DetectedPattern | None:
    """Detect ascending triangle: flat resistance + rising support."""
    swing_high_idxs = _find_swing_highs(highs, lookback=2)
    swing_low_idxs = _find_swing_lows(lows, lookback=2)

    if len(swing_high_idxs) < 2 or len(swing_low_idxs) < 2:
        return None

    # Check for flat resistance: last 2-3 swing highs at similar level
    recent_highs = swing_high_idxs[-3:]
    high_values = highs[recent_highs]
    if np.ptp(high_values) > atr * 0.5:
        return None  # Not flat enough

    resistance = float(np.mean(high_values))

    # Check for rising support: higher lows
    recent_lows = swing_low_idxs[-3:]
    low_values = lows[recent_lows]
    slope = _linear_regression_slope(low_values)
    if slope <= 0:
        return None  # Not rising

    current_price = closes[-1]
    current_time = float(times[-1])

    # Triangle height at widest point
    triangle_height = resistance - float(low_values[0])
    if triangle_height < atr * 0.5:
        return None

    # Completion
    touches = len(recent_highs)
    higher_lows = sum(1 for j in range(1, len(low_values)) if low_values[j] > low_values[j - 1])

    if current_price > resistance:
        status = "confirmed"
        completion_pct = 100
        completion_prob = 80
    elif touches >= 3 and higher_lows >= 2:
        status = "forming"
        completion_pct = 70
        completion_prob = 60
    else:
        status = "forming"
        completion_pct = 50
        completion_prob = 45

    target = resistance + triangle_height
    invalidation = float(low_values[-1]) - atr * 0.2

    key_points = []
    for idx in recent_highs:
        key_points.append({"time": int(times[idx]), "price": round(float(highs[idx]), 2), "label": "R"})
    for idx in recent_lows:
        key_points.append({"time": int(times[idx]), "price": round(float(lows[idx]), 2), "label": "S"})

    tf_sec = int(times[-1] - times[-2]) if len(times) > 1 else 3600
    projection = _generate_projection(current_price, target, current_time, tf_sec)

    return DetectedPattern(
        pattern_type=PatternType.ASCENDING_TRIANGLE,
        status=status,
        completion_pct=completion_pct,
        completion_prob=completion_prob,
        implied_direction="BUY",
        entry_zone=round(float(resistance), 2),
        target_price=round(float(target), 2),
        invalidation_price=round(float(invalidation), 2),
        key_points=key_points,
        projection=projection,
    )


def detect_descending_triangle(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    times: np.ndarray,
    atr: float,
) -> DetectedPattern | None:
    """Detect descending triangle: flat support + declining resistance."""
    swing_high_idxs = _find_swing_highs(highs, lookback=2)
    swing_low_idxs = _find_swing_lows(lows, lookback=2)

    if len(swing_high_idxs) < 2 or len(swing_low_idxs) < 2:
        return None

    # Check for flat support
    recent_lows = swing_low_idxs[-3:]
    low_values = lows[recent_lows]
    if np.ptp(low_values) > atr * 0.5:
        return None

    support = float(np.mean(low_values))

    # Check for declining resistance
    recent_highs = swing_high_idxs[-3:]
    high_values = highs[recent_highs]
    slope = _linear_regression_slope(high_values)
    if slope >= 0:
        return None

    current_price = closes[-1]
    current_time = float(times[-1])

    triangle_height = float(high_values[0]) - support
    if triangle_height < atr * 0.5:
        return None

    touches = len(recent_lows)
    lower_highs = sum(1 for j in range(1, len(high_values)) if high_values[j] < high_values[j - 1])

    if current_price < support:
        status = "confirmed"
        completion_pct = 100
        completion_prob = 80
    elif touches >= 3 and lower_highs >= 2:
        status = "forming"
        completion_pct = 70
        completion_prob = 60
    else:
        status = "forming"
        completion_pct = 50
        completion_prob = 45

    target = support - triangle_height
    invalidation = float(high_values[-1]) + atr * 0.2

    key_points = []
    for idx in recent_highs:
        key_points.append({"time": int(times[idx]), "price": round(float(highs[idx]), 2), "label": "R"})
    for idx in recent_lows:
        key_points.append({"time": int(times[idx]), "price": round(float(lows[idx]), 2), "label": "S"})

    tf_sec = int(times[-1] - times[-2]) if len(times) > 1 else 3600
    projection = _generate_projection(current_price, target, current_time, tf_sec)

    return DetectedPattern(
        pattern_type=PatternType.DESCENDING_TRIANGLE,
        status=status,
        completion_pct=completion_pct,
        completion_prob=completion_prob,
        implied_direction="SELL",
        entry_zone=round(float(support), 2),
        target_price=round(float(target), 2),
        invalidation_price=round(float(invalidation), 2),
        key_points=key_points,
        projection=projection,
    )


def detect_rising_wedge(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    times: np.ndarray,
    atr: float,
) -> DetectedPattern | None:
    """Detect rising wedge: both trendlines rising, converging. Bearish."""
    swing_high_idxs = _find_swing_highs(highs, lookback=2)
    swing_low_idxs = _find_swing_lows(lows, lookback=2)

    if len(swing_high_idxs) < 3 or len(swing_low_idxs) < 3:
        return None

    recent_highs = swing_high_idxs[-3:]
    recent_lows = swing_low_idxs[-3:]

    high_values = highs[recent_highs]
    low_values = lows[recent_lows]

    high_slope = _linear_regression_slope(high_values)
    low_slope = _linear_regression_slope(low_values)

    # Both rising
    if high_slope <= 0 or low_slope <= 0:
        return None

    # Lower trendline rising faster = NOT converging properly
    # Actually for rising wedge: both rise but highs rise slower → converging
    # We just need convergence: the range is narrowing
    range_start = high_values[0] - low_values[0]
    range_end = high_values[-1] - low_values[-1]
    if range_end >= range_start:
        return None  # Not converging

    if range_start < atr * 0.5:
        return None

    current_price = closes[-1]
    current_time = float(times[-1])

    wedge_entry = float(low_values[-1])
    wedge_height = float(high_values[0] - low_values[0])
    target = wedge_entry - wedge_height
    invalidation = float(high_values[-1]) + atr * 0.2

    if current_price < wedge_entry:
        status = "confirmed"
        completion_pct = 100
        completion_prob = 75
    else:
        status = "forming"
        completion_pct = 70
        completion_prob = 55

    key_points = []
    for idx in recent_highs:
        key_points.append({"time": int(times[idx]), "price": round(float(highs[idx]), 2), "label": "R"})
    for idx in recent_lows:
        key_points.append({"time": int(times[idx]), "price": round(float(lows[idx]), 2), "label": "S"})

    tf_sec = int(times[-1] - times[-2]) if len(times) > 1 else 3600
    projection = _generate_projection(current_price, target, current_time, tf_sec)

    return DetectedPattern(
        pattern_type=PatternType.RISING_WEDGE,
        status=status,
        completion_pct=completion_pct,
        completion_prob=completion_prob,
        implied_direction="SELL",
        entry_zone=round(float(wedge_entry), 2),
        target_price=round(float(target), 2),
        invalidation_price=round(float(invalidation), 2),
        key_points=key_points,
        projection=projection,
    )


def detect_falling_wedge(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    times: np.ndarray,
    atr: float,
) -> DetectedPattern | None:
    """Detect falling wedge: both trendlines declining, converging. Bullish."""
    swing_high_idxs = _find_swing_highs(highs, lookback=2)
    swing_low_idxs = _find_swing_lows(lows, lookback=2)

    if len(swing_high_idxs) < 3 or len(swing_low_idxs) < 3:
        return None

    recent_highs = swing_high_idxs[-3:]
    recent_lows = swing_low_idxs[-3:]

    high_values = highs[recent_highs]
    low_values = lows[recent_lows]

    high_slope = _linear_regression_slope(high_values)
    low_slope = _linear_regression_slope(low_values)

    # Both declining
    if high_slope >= 0 or low_slope >= 0:
        return None

    # Converging: range narrowing
    range_start = high_values[0] - low_values[0]
    range_end = high_values[-1] - low_values[-1]
    if range_end >= range_start:
        return None

    if range_start < atr * 0.5:
        return None

    current_price = closes[-1]
    current_time = float(times[-1])

    wedge_entry = float(high_values[-1])
    wedge_height = float(high_values[0] - low_values[0])
    target = wedge_entry + wedge_height
    invalidation = float(low_values[-1]) - atr * 0.2

    if current_price > wedge_entry:
        status = "confirmed"
        completion_pct = 100
        completion_prob = 75
    else:
        status = "forming"
        completion_pct = 70
        completion_prob = 55

    key_points = []
    for idx in recent_highs:
        key_points.append({"time": int(times[idx]), "price": round(float(highs[idx]), 2), "label": "R"})
    for idx in recent_lows:
        key_points.append({"time": int(times[idx]), "price": round(float(lows[idx]), 2), "label": "S"})

    tf_sec = int(times[-1] - times[-2]) if len(times) > 1 else 3600
    projection = _generate_projection(current_price, target, current_time, tf_sec)

    return DetectedPattern(
        pattern_type=PatternType.FALLING_WEDGE,
        status=status,
        completion_pct=completion_pct,
        completion_prob=completion_prob,
        implied_direction="BUY",
        entry_zone=round(float(wedge_entry), 2),
        target_price=round(float(target), 2),
        invalidation_price=round(float(invalidation), 2),
        key_points=key_points,
        projection=projection,
    )


# ── Scanner ──────────────────────────────────────────────────────────────────


def scan_patterns(
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    times: np.ndarray,
    atr: float,
    lookback: int = 100,
) -> list[DetectedPattern]:
    """Scan for all pattern types, return matches sorted by completion_prob."""
    # Use only last `lookback` candles
    h = highs[-lookback:]
    lo = lows[-lookback:]
    c = closes[-lookback:]
    t = times[-lookback:]

    detectors = [
        detect_double_bottom,
        detect_double_top,
        detect_head_shoulders,
        detect_inv_head_shoulders,
        detect_bull_flag,
        detect_bear_flag,
        detect_ascending_triangle,
        detect_descending_triangle,
        detect_rising_wedge,
        detect_falling_wedge,
    ]

    patterns = []
    for detect_fn in detectors:
        try:
            result = detect_fn(h, lo, c, t, atr)
            if result:
                patterns.append(result)
        except Exception:
            continue  # Skip failed detectors

    return sorted(patterns, key=lambda p: p.completion_prob, reverse=True)


def adjust_with_cnn(
    pattern: DetectedPattern,
    cnn_direction: str,
    cnn_confidence: float,
) -> DetectedPattern:
    """Boost or penalize completion_prob based on CNN directional agreement."""
    if cnn_direction == pattern.implied_direction:
        # CNN agrees — boost proportional to CNN confidence
        boost = (cnn_confidence - 50) / 100 * 15  # up to +7.5%
        pattern.completion_prob = min(pattern.completion_prob + boost, 95)
    elif cnn_direction != "NEUTRAL":
        # CNN disagrees — penalize
        penalty = (cnn_confidence - 50) / 100 * 20  # up to -10%
        pattern.completion_prob = max(pattern.completion_prob - penalty, 10)

    return pattern


def pattern_to_dict(p: DetectedPattern) -> dict:
    """Convert a DetectedPattern to a JSON-serializable dict."""
    return {
        "type": p.pattern_type.value,
        "status": p.status,
        "completionPct": round(p.completion_pct, 1),
        "completionProb": round(p.completion_prob, 1),
        "impliedDirection": p.implied_direction,
        "entryZone": p.entry_zone,
        "targetPrice": p.target_price,
        "invalidationPrice": p.invalidation_price,
        "keyPoints": p.key_points,
        "projection": p.projection,
    }
