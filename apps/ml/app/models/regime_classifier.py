"""Trained regime classifier — replaces heuristic rule-based detection.

Uses XGBoost multiclass classification to identify 5 market regimes:
  - TRENDING_UP:    Strong uptrend with directional momentum
  - TRENDING_DOWN:  Strong downtrend with directional momentum
  - RANGING:        Sideways / mean-reverting conditions
  - VOLATILE:       High volatility breakout / expansion
  - TRANSITIONING:  Uncertain regime → abstain from trading

When the classifier confidence is below 0.5, the regime is forced to
TRANSITIONING to prevent trading during ambiguous conditions.
"""

import json
import logging
from dataclasses import dataclass, asdict
from enum import Enum
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import xgboost as xgb

logger = logging.getLogger("ml.regime_classifier")


class Regime(str, Enum):
    TRENDING_UP = "TRENDING_UP"
    TRENDING_DOWN = "TRENDING_DOWN"
    RANGING = "RANGING"
    VOLATILE = "VOLATILE"
    TRANSITIONING = "TRANSITIONING"


@dataclass
class RegimeResult:
    regime: Regime
    confidence: float
    probabilities: dict[str, float]
    features_used: list[str]
    should_trade: bool


# Regime-specific trading parameters
REGIME_PARAMS: dict[Regime, dict] = {
    Regime.TRENDING_UP: {
        "strategy": "momentum",
        "min_confidence": 60,
        "tp_multiplier": 1.5,
        "sl_multiplier": 1.0,
        "prefer_direction": "BUY",
    },
    Regime.TRENDING_DOWN: {
        "strategy": "momentum",
        "min_confidence": 60,
        "tp_multiplier": 1.5,
        "sl_multiplier": 1.0,
        "prefer_direction": "SELL",
    },
    Regime.RANGING: {
        "strategy": "mean_reversion",
        "min_confidence": 80,
        "tp_multiplier": 0.7,
        "sl_multiplier": 0.8,
        "prefer_direction": None,
    },
    Regime.VOLATILE: {
        "strategy": "volatility",
        "min_confidence": 85,
        "tp_multiplier": 2.0,
        "sl_multiplier": 1.5,
        "prefer_direction": None,
    },
    Regime.TRANSITIONING: {
        "strategy": "abstain",
        "min_confidence": 999,
        "tp_multiplier": 1.0,
        "sl_multiplier": 1.0,
        "prefer_direction": None,
    },
}

# Feature columns used from the feature pipeline
REGIME_FEATURE_COLS = [
    "adx_14", "bb_width", "atr_pct", "hist_vol_20",
    "rsi_14", "macd_hist", "squeeze",
    "supertrend_dir",
]

# Engineered feature names produced by _engineer_features
ENGINEERED_NAMES = [
    "adx", "bb_width", "atr_pct", "hist_vol", "rsi",
    "macd_hist", "squeeze", "supertrend",
    "ema_alignment", "vol_ratio",
    "deriv_funding_rate", "deriv_oi_change_pct", "deriv_global_ls_ratio",
]


class RegimeClassifier:
    """Trained XGBoost 5-class regime classifier."""

    def __init__(self):
        self.model: xgb.XGBClassifier | None = None
        self.version: str = "regime_v1"
        self.label_map = {r.value: i for i, r in enumerate(Regime)}
        self.inv_label_map = {i: r.value for i, r in enumerate(Regime)}

    def _engineer_features(self, df: pd.DataFrame) -> np.ndarray:
        """Transform raw feature columns into regime-discriminative inputs."""
        feat = pd.DataFrame(index=df.index)

        feat["adx"] = df["adx_14"] if "adx_14" in df.columns else 20.0
        feat["bb_width"] = df["bb_width"] if "bb_width" in df.columns else 0.05
        feat["atr_pct"] = df["atr_pct"] if "atr_pct" in df.columns else 0.01
        feat["hist_vol"] = df["hist_vol_20"] if "hist_vol_20" in df.columns else 0.01
        feat["rsi"] = df["rsi_14"] if "rsi_14" in df.columns else 50.0
        feat["macd_hist"] = df["macd_hist"] if "macd_hist" in df.columns else 0.0
        feat["squeeze"] = df["squeeze"].astype(float) if "squeeze" in df.columns else 0.0
        feat["supertrend"] = df["supertrend_dir"].astype(float) if "supertrend_dir" in df.columns else 0.0

        # EMA alignment: +1 = bullish stacked, -1 = bearish stacked, 0 = mixed
        if all(c in df.columns for c in ["close", "ema_50", "ema_200"]):
            feat["ema_alignment"] = np.where(
                (df["close"] > df["ema_50"]) & (df["ema_50"] > df["ema_200"]), 1.0,
                np.where(
                    (df["close"] < df["ema_50"]) & (df["ema_50"] < df["ema_200"]), -1.0, 0.0
                )
            )
        else:
            feat["ema_alignment"] = 0.0

        # Volume ratio: current volume vs rolling 20-period average
        if "volume" in df.columns:
            vol_ma = df["volume"].rolling(20, min_periods=1).mean()
            feat["vol_ratio"] = df["volume"] / vol_ma.replace(0, 1)
        else:
            feat["vol_ratio"] = 1.0

        # Derivatives features (filled 0 if not available from PR1)
        feat["deriv_funding_rate"] = df["deriv_funding_rate"] if "deriv_funding_rate" in df.columns else 0.0
        feat["deriv_oi_change_pct"] = df["deriv_oi_change_pct"] if "deriv_oi_change_pct" in df.columns else 0.0
        feat["deriv_global_ls_ratio"] = df["deriv_global_ls_ratio"] if "deriv_global_ls_ratio" in df.columns else 1.0

        return feat.values.astype(np.float64)

    def train(self, df: pd.DataFrame, labels: np.ndarray) -> dict:
        """
        Train on labeled regime data.

        Args:
            df: Feature DataFrame (output of build_feature_matrix).
            labels: Array of regime label strings (e.g. "TRENDING_UP").

        Returns:
            Dict with accuracy and sample count.
        """
        X = self._engineer_features(df)
        y = np.array([self.label_map[label] for label in labels])

        self.model = xgb.XGBClassifier(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.05,
            objective="multi:softprob",
            num_class=len(Regime),
            eval_metric="mlogloss",
            subsample=0.8,
            colsample_bytree=0.8,
            random_state=42,
        )

        # 80/20 time-ordered split (no shuffle — respect temporal order)
        split = int(len(X) * 0.8)
        X_train, X_val = X[:split], X[split:]
        y_train, y_val = y[:split], y[split:]

        self.model.fit(
            X_train, y_train,
            eval_set=[(X_val, y_val)],
            verbose=False,
        )

        # Validation metrics
        val_preds = self.model.predict(X_val)
        accuracy = float((val_preds == y_val).mean())
        train_preds = self.model.predict(X_train)
        train_accuracy = float((train_preds == y_train).mean())

        # Class distribution
        unique, counts = np.unique(labels, return_counts=True)
        distribution = {label: int(count) for label, count in zip(unique, counts)}

        logger.info(
            f"Regime classifier trained: train_acc={train_accuracy:.4f} "
            f"val_acc={accuracy:.4f} samples={len(X)} dist={distribution}"
        )

        return {
            "train_accuracy": round(train_accuracy, 4),
            "val_accuracy": round(accuracy, 4),
            "samples": len(X),
            "distribution": distribution,
        }

    def predict(self, df: pd.DataFrame) -> RegimeResult:
        """Classify current regime from the latest feature row."""
        if self.model is None:
            raise RuntimeError("Regime classifier not trained — run training first")

        X = self._engineer_features(df.tail(1))
        probs = self.model.predict_proba(X)[0]
        pred_idx = int(np.argmax(probs))
        regime = Regime(self.inv_label_map[pred_idx])
        confidence = float(probs[pred_idx])

        # If confidence < 0.5, force TRANSITIONING (uncertain)
        if confidence < 0.5:
            regime = Regime.TRANSITIONING

        should_trade = regime != Regime.TRANSITIONING and confidence >= 0.4

        # Top contributing features (from XGBoost feature importance)
        importances = self.model.feature_importances_
        top_indices = np.argsort(importances)[::-1][:5]
        features_used = [
            ENGINEERED_NAMES[i] if i < len(ENGINEERED_NAMES) else f"feat_{i}"
            for i in top_indices
        ]

        return RegimeResult(
            regime=regime,
            confidence=round(confidence, 4),
            probabilities={
                self.inv_label_map[i]: round(float(p), 4)
                for i, p in enumerate(probs)
            },
            features_used=features_used,
            should_trade=should_trade,
        )

    def save(self, path: str) -> None:
        """Save trained classifier to disk."""
        if self.model is None:
            raise RuntimeError("No trained model to save")

        filepath = Path(path)
        filepath.parent.mkdir(parents=True, exist_ok=True)

        joblib.dump(self.model, filepath)

        meta = {
            "version": self.version,
            "model_type": "regime_classifier",
            "n_classes": len(Regime),
            "classes": [r.value for r in Regime],
            "engineered_features": ENGINEERED_NAMES,
        }
        meta_path = filepath.with_suffix(".meta.json")
        meta_path.write_text(json.dumps(meta, indent=2))

        logger.info(f"Regime classifier saved to {filepath}")

    @classmethod
    def load(cls, path: str) -> "RegimeClassifier":
        """Load trained classifier from disk."""
        filepath = Path(path)
        instance = cls()
        instance.model = joblib.load(filepath)

        meta_path = filepath.with_suffix(".meta.json")
        if meta_path.exists():
            meta = json.loads(meta_path.read_text())
            instance.version = meta.get("version", "regime_v1")

        logger.info(f"Regime classifier loaded from {filepath} (version={instance.version})")
        return instance
