"""Target zone predictor — data-driven TP/SL using MFE/MAE regression.

Replaces hard-coded ATR multipliers with learned price targets:
- MFE model: predicts max favorable excursion (how far price moves in signal direction)
- MAE model: predicts max adverse excursion (worst drawdown before recovery)

TP zones derived from predicted MFE:
    TP1 = entry + predicted_mfe * 0.40  (conservative: 40% of expected move)
    TP2 = entry + predicted_mfe * 0.70  (moderate: 70% of expected move)
    TP3 = entry + predicted_mfe * 1.00  (full expected move)
    SL  = entry - predicted_mae * 0.80  (80% of expected adverse move)
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import joblib
import numpy as np
from xgboost import XGBRegressor

logger = logging.getLogger("ml.target_predictor")


class TargetPredictor:
    """Predicts price target zones using gradient boosted regression."""

    def __init__(self) -> None:
        self.mfe_model = XGBRegressor(
            max_depth=5,
            learning_rate=0.05,
            n_estimators=300,
            subsample=0.8,
            colsample_bytree=0.8,
            reg_alpha=0.1,
        )
        self.mae_model = XGBRegressor(
            max_depth=5,
            learning_rate=0.05,
            n_estimators=300,
            subsample=0.8,
            colsample_bytree=0.8,
            reg_alpha=0.1,
        )
        self.feature_names: list[str] = []
        self.version: str = ""

    def train(
        self,
        X: np.ndarray,
        mfe_labels: np.ndarray,
        mae_labels: np.ndarray,
        feature_names: list[str],
    ) -> dict:
        """Train both MFE and MAE regressors.

        Returns dict with R² scores for both models.
        """
        # Drop rows where labels are NaN
        valid = ~(np.isnan(mfe_labels) | np.isnan(mae_labels))
        X_clean = X[valid]
        mfe_clean = mfe_labels[valid]
        mae_clean = mae_labels[valid]

        if len(X_clean) < 50:
            raise ValueError(f"Not enough valid samples: {len(X_clean)} (need >= 50)")

        # Train/val split for evaluation
        split = int(len(X_clean) * 0.85)
        X_train, X_val = X_clean[:split], X_clean[split:]
        mfe_train, mfe_val = mfe_clean[:split], mfe_clean[split:]
        mae_train, mae_val = mae_clean[:split], mae_clean[split:]

        logger.info(f"Training target predictor: {len(X_train)} train, {len(X_val)} val samples")

        self.mfe_model.fit(X_train, mfe_train)
        self.mae_model.fit(X_train, mae_train)
        self.feature_names = feature_names

        # Evaluate on validation set
        mfe_r2_train = self.mfe_model.score(X_train, mfe_train)
        mae_r2_train = self.mae_model.score(X_train, mae_train)
        mfe_r2_val = self.mfe_model.score(X_val, mfe_val)
        mae_r2_val = self.mae_model.score(X_val, mae_val)

        return {
            "mfe_r2_train": round(float(mfe_r2_train), 4),
            "mae_r2_train": round(float(mae_r2_train), 4),
            "mfe_r2_val": round(float(mfe_r2_val), 4),
            "mae_r2_val": round(float(mae_r2_val), 4),
            "train_samples": len(X_train),
            "val_samples": len(X_val),
        }

    def predict_zones(
        self,
        X: np.ndarray,
        current_price: float,
        direction: str = "BUY",
    ) -> dict:
        """Predict TP/SL zones for a single sample.

        Args:
            X: Feature vector (1D array, will be reshaped).
            current_price: Current asset price.
            direction: "BUY" or "SELL".

        Returns:
            Dict with tp1, tp2, tp3, stop_loss, predicted_mfe_pct,
            predicted_mae_pct, risk_reward.
        """
        X_2d = X.reshape(1, -1) if X.ndim == 1 else X[:1]

        mfe_pred = float(self.mfe_model.predict(X_2d)[0])
        mae_pred = float(self.mae_model.predict(X_2d)[0])

        # Clamp to reasonable ranges
        mfe_pred = max(mfe_pred, 0.001)  # At least 0.1%
        mae_pred = max(mae_pred, 0.001)

        # TP zones as fractions of predicted MFE
        tp1_offset = current_price * mfe_pred * 0.40
        tp2_offset = current_price * mfe_pred * 0.70
        tp3_offset = current_price * mfe_pred * 1.00
        sl_offset = current_price * mae_pred * 0.80

        if direction == "BUY":
            tp1 = current_price + tp1_offset
            tp2 = current_price + tp2_offset
            tp3 = current_price + tp3_offset
            sl = current_price - sl_offset
        else:
            tp1 = current_price - tp1_offset
            tp2 = current_price - tp2_offset
            tp3 = current_price - tp3_offset
            sl = current_price + sl_offset

        return {
            "tp1": round(tp1, 2),
            "tp2": round(tp2, 2),
            "tp3": round(tp3, 2),
            "stop_loss": round(sl, 2),
            "predicted_mfe_pct": round(mfe_pred * 100, 2),
            "predicted_mae_pct": round(mae_pred * 100, 2),
            "risk_reward": round(mfe_pred / mae_pred, 2) if mae_pred > 0 else 999,
        }

    def save(self, path: str, version: str) -> None:
        """Save both models to disk."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)

        data = {
            "mfe_model": self.mfe_model,
            "mae_model": self.mae_model,
            "feature_names": self.feature_names,
            "version": version,
        }
        joblib.dump(data, str(p))
        self.version = version

        # Save meta
        meta = {
            "version": version,
            "feature_count": len(self.feature_names),
            "model_type": "target_predictor",
        }
        meta_path = p.with_suffix(".meta.json")
        meta_path.write_text(json.dumps(meta, indent=2))

        logger.info(f"Target predictor saved: {p}")

    @classmethod
    def load(cls, path: str) -> "TargetPredictor":
        """Load a saved target predictor."""
        data = joblib.load(path)
        predictor = cls()
        predictor.mfe_model = data["mfe_model"]
        predictor.mae_model = data["mae_model"]
        predictor.feature_names = data["feature_names"]
        predictor.version = data["version"]
        logger.info(f"Target predictor loaded: {predictor.version}")
        return predictor
