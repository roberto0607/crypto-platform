"""Ensemble meta-learner — combines XGBoost, LSTM, TFT, and CNN.

Strategy:
  1. Each model produces a probability distribution: [P(SELL), P(NEUTRAL), P(BUY)]
  2. Meta-learner combines via learned weights (calibrated on validation set)
  3. Agreement bonus: if majority agree on direction, confidence boosted
  4. Regime-aware: adjusts thresholds based on market regime

Weight defaults (can be overridden by calibration):
  XGBoost: 0.25  (fast, good at indicator combos)
  LSTM:    0.25  (good at sequential patterns)
  TFT:     0.30  (best overall, multi-timeframe attention)
  CNN:     0.20  (pattern recognition)
"""

import json
import logging
from pathlib import Path

import numpy as np

from app.models.xgboost_model import XGBoostModel
from app.models.lstm_model import LSTMModel
from app.models.tft_model import TFTModel
from app.models.cnn_model import CNNModel
from app.models.regime_detector import detect_regime, get_regime_config, MarketRegime

logger = logging.getLogger("ml.ensemble")

CLASS_NAMES = {0: "SELL", 1: "NEUTRAL", 2: "BUY"}

# Default model weights
DEFAULT_WEIGHTS = {
    "xgboost": 0.25,
    "lstm": 0.25,
    "tft": 0.30,
    "cnn": 0.20,
}

AGREEMENT_BONUS = 10.0  # % confidence boost when models agree


class EnsembleModel:
    """Multi-model ensemble with regime-aware meta-learner."""

    def __init__(self):
        self.xgboost: XGBoostModel | None = None
        self.lstm: LSTMModel | None = None
        self.tft: TFTModel | None = None
        self.cnn: CNNModel | None = None
        self.weights: dict[str, float] = DEFAULT_WEIGHTS.copy()
        self.feature_names: list[str] = []
        self.version: str = ""
        self.regime_aware: bool = True

    @property
    def available_models(self) -> dict[str, object]:
        """Return dict of model_name -> model for loaded models only."""
        models = {}
        if self.xgboost is not None:
            models["xgboost"] = self.xgboost
        if self.lstm is not None:
            models["lstm"] = self.lstm
        if self.tft is not None:
            models["tft"] = self.tft
        if self.cnn is not None:
            models["cnn"] = self.cnn
        return models

    def predict(self, X: np.ndarray, df=None) -> dict:
        """
        Ensemble prediction combining all available models.

        Args:
            X: Feature matrix (for single prediction, can be 1 row or sequence).
            df: Optional DataFrame for regime detection.

        Returns:
            Dict with direction, confidence, probabilities, model_contributions,
            regime info.
        """
        models = self.available_models
        if not models:
            raise RuntimeError("No models loaded in ensemble")

        # Collect predictions from each model
        predictions: dict[str, dict] = {}
        proba_arrays: dict[str, np.ndarray] = {}

        for name, model in models.items():
            try:
                pred = model.predict(X)
                predictions[name] = pred
                proba_arrays[name] = np.array([
                    pred["probabilities"]["SELL"],
                    pred["probabilities"]["NEUTRAL"],
                    pred["probabilities"]["BUY"],
                ]) / 100.0
            except Exception as e:
                logger.warning(f"Model {name} prediction failed: {e}")

        if not proba_arrays:
            raise RuntimeError("All models failed to predict")

        # Normalize weights for available models only
        active_names = list(proba_arrays.keys())
        raw_weights = {n: self.weights.get(n, 0.25) for n in active_names}
        total_w = sum(raw_weights.values())
        norm_weights = {n: w / total_w for n, w in raw_weights.items()}

        # Weighted probability combination
        combined_proba = np.zeros(3)
        for name in active_names:
            combined_proba += norm_weights[name] * proba_arrays[name]

        # Direction
        class_idx = int(np.argmax(combined_proba))
        direction = CLASS_NAMES[class_idx]
        confidence = float(combined_proba[class_idx]) * 100

        # Agreement bonus: count how many models agree on direction
        model_directions = [predictions[n]["direction"] for n in active_names]
        agreement_count = model_directions.count(direction)
        agreement_ratio = agreement_count / len(active_names)

        if agreement_ratio >= 0.75 and direction != "NEUTRAL":
            confidence = min(confidence + AGREEMENT_BONUS, 99.0)
        elif agreement_ratio < 0.5 and direction != "NEUTRAL":
            # Disagreement: reduce confidence or flip to NEUTRAL
            confidence *= 0.7

        # Regime detection
        regime_info = None
        if self.regime_aware and df is not None and not df.empty:
            try:
                regime, evidence = detect_regime(df)
                regime_config = get_regime_config(regime)
                regime_info = {
                    "regime": regime.value,
                    "evidence": evidence,
                    "config": {
                        "min_confidence": regime_config.min_confidence,
                        "tp_multiplier": regime_config.tp_multiplier,
                        "sl_multiplier": regime_config.sl_multiplier,
                    },
                }
            except Exception as e:
                logger.warning(f"Regime detection failed: {e}")

        # Model contributions
        contributions = {}
        for name in active_names:
            contributions[name] = {
                "weight": round(norm_weights[name], 3),
                "direction": predictions[name]["direction"],
                "confidence": predictions[name]["confidence"],
            }

        return {
            "direction": direction,
            "confidence": round(confidence, 1),
            "probabilities": {
                "SELL": round(float(combined_proba[0]) * 100, 1),
                "NEUTRAL": round(float(combined_proba[1]) * 100, 1),
                "BUY": round(float(combined_proba[2]) * 100, 1),
            },
            "agreement": round(agreement_ratio, 2),
            "model_contributions": contributions,
            "regime": regime_info,
        }

    def calibrate_weights(
        self,
        X: np.ndarray,
        y: np.ndarray,
        feature_names: list[str],
    ) -> dict[str, float]:
        """
        Learn optimal model weights from validation data.

        Uses each model's accuracy on validation set to set weights.
        Better models get higher weight.
        """
        models = self.available_models
        if not models:
            return self.weights

        from app.models.lstm_model import SEQ_LEN

        accuracies: dict[str, float] = {}

        for name, model in models.items():
            try:
                if name == "xgboost":
                    preds = model.model.predict(X)
                    acc = float(np.mean(preds == y))
                elif name in ("lstm", "tft"):
                    proba = model.predict_proba_batch(X)
                    if len(proba) > 0:
                        # Align: proba starts at index SEQ_LEN
                        y_aligned = y[SEQ_LEN:SEQ_LEN + len(proba)]
                        preds = np.argmax(proba, axis=1)
                        acc = float(np.mean(preds == y_aligned))
                    else:
                        acc = 0.0
                elif name == "cnn":
                    from app.models.cnn_model import CNN_SEQ_LEN
                    proba = model.predict_proba_batch(X)
                    if len(proba) > 0:
                        y_aligned = y[CNN_SEQ_LEN:CNN_SEQ_LEN + len(proba)]
                        preds = np.argmax(proba, axis=1)
                        acc = float(np.mean(preds == y_aligned))
                    else:
                        acc = 0.0
                else:
                    acc = 0.25

                accuracies[name] = acc
                logger.info(f"  {name} val_accuracy: {acc:.4f}")
            except Exception as e:
                logger.warning(f"  {name} calibration failed: {e}")
                accuracies[name] = 0.25

        # Softmax-like weighting based on accuracy
        total = sum(accuracies.values())
        if total > 0:
            self.weights = {n: round(a / total, 3) for n, a in accuracies.items()}
        else:
            self.weights = {n: round(1.0 / len(models), 3) for n in models}

        logger.info(f"  Calibrated weights: {self.weights}")
        return self.weights

    def get_feature_importance(self, top_n: int = 15) -> list[dict]:
        """Aggregate feature importance from all models that support it."""
        all_importance: dict[str, float] = {}

        for name, model in self.available_models.items():
            weight = self.weights.get(name, 0.25)
            for item in model.get_feature_importance(top_n * 2):
                feat = item["feature"]
                imp = item["importance"] * weight
                all_importance[feat] = all_importance.get(feat, 0) + imp

        if not all_importance:
            return []

        sorted_feats = sorted(all_importance.items(), key=lambda x: x[1], reverse=True)
        return [
            {"rank": i + 1, "feature": feat, "importance": round(imp, 4)}
            for i, (feat, imp) in enumerate(sorted_feats[:top_n])
        ]

    def save(self, model_dir: str, version: str) -> None:
        """Save ensemble config and all sub-models."""
        self.version = version
        base = Path(model_dir)
        base.mkdir(parents=True, exist_ok=True)

        if self.xgboost:
            self.xgboost.save(str(base / f"{version}_xgboost.joblib"), version)
        if self.lstm:
            self.lstm.save(str(base / f"{version}_lstm.pt"), version)
        if self.tft:
            self.tft.save(str(base / f"{version}_tft.pt"), version)
        if self.cnn:
            self.cnn.save(str(base / f"{version}_cnn.pt"), version)

        meta = {
            "version": version,
            "model_type": "ensemble",
            "weights": self.weights,
            "regime_aware": self.regime_aware,
            "models": list(self.available_models.keys()),
            "feature_names": self.feature_names,
        }
        (base / f"{version}_ensemble.meta.json").write_text(json.dumps(meta, indent=2))

        # Also save as "latest"
        (base / "ensemble_latest.meta.json").write_text(json.dumps(meta, indent=2))

    @classmethod
    def load(cls, model_dir: str, version: str | None = None) -> "EnsembleModel":
        """Load ensemble from saved sub-models."""
        base = Path(model_dir)
        instance = cls()

        # Find meta file
        if version:
            meta_path = base / f"{version}_ensemble.meta.json"
        else:
            meta_path = base / "ensemble_latest.meta.json"

        if not meta_path.exists():
            logger.warning(f"No ensemble meta found at {meta_path}")
            return instance

        meta = json.loads(meta_path.read_text())
        instance.version = meta.get("version", "unknown")
        instance.weights = meta.get("weights", DEFAULT_WEIGHTS)
        instance.regime_aware = meta.get("regime_aware", True)
        instance.feature_names = meta.get("feature_names", [])
        ver = instance.version

        # Load sub-models
        xgb_path = base / f"{ver}_xgboost.joblib"
        if xgb_path.exists():
            try:
                instance.xgboost = XGBoostModel.load(str(xgb_path))
                logger.info(f"Loaded XGBoost: {xgb_path.name}")
            except Exception as e:
                logger.warning(f"Failed to load XGBoost: {e}")

        lstm_path = base / f"{ver}_lstm.pt"
        if lstm_path.exists():
            try:
                instance.lstm = LSTMModel.load(str(lstm_path))
                logger.info(f"Loaded LSTM: {lstm_path.name}")
            except Exception as e:
                logger.warning(f"Failed to load LSTM: {e}")

        tft_path = base / f"{ver}_tft.pt"
        if tft_path.exists():
            try:
                instance.tft = TFTModel.load(str(tft_path))
                logger.info(f"Loaded TFT: {tft_path.name}")
            except Exception as e:
                logger.warning(f"Failed to load TFT: {e}")

        cnn_path = base / f"{ver}_cnn.pt"
        if cnn_path.exists():
            try:
                instance.cnn = CNNModel.load(str(cnn_path))
                logger.info(f"Loaded CNN: {cnn_path.name}")
            except Exception as e:
                logger.warning(f"Failed to load CNN: {e}")

        loaded = list(instance.available_models.keys())
        logger.info(f"Ensemble loaded: {loaded} (weights={instance.weights})")
        return instance
