"""XGBoost model wrapper for direction prediction.

Wraps XGBoost with our specific hyperparameters tuned for financial
time series. Supports training, prediction, serialization, and
feature importance extraction.

Three-class classification: BUY (1) / NEUTRAL (0) / SELL (-1)
Mapped to XGBoost classes: 0=SELL, 1=NEUTRAL, 2=BUY
"""

import json
from pathlib import Path

import joblib
import numpy as np
import xgboost as xgb


# Label mapping: our labels → XGBoost class indices
LABEL_TO_CLASS = {-1: 0, 0: 1, 1: 2}  # SELL=0, NEUTRAL=1, BUY=2
CLASS_TO_LABEL = {0: -1, 1: 0, 2: 1}
CLASS_NAMES = {0: "SELL", 1: "NEUTRAL", 2: "BUY"}

DEFAULT_PARAMS = {
    "objective": "multi:softprob",
    "num_class": 3,
    "max_depth": 6,
    "learning_rate": 0.05,
    "n_estimators": 500,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "min_child_weight": 5,
    "reg_alpha": 0.1,
    "reg_lambda": 1.0,
    "eval_metric": "mlogloss",
    "early_stopping_rounds": 50,
    "random_state": 42,
    "verbosity": 0,
}


class XGBoostModel:
    """XGBoost classifier for BUY/NEUTRAL/SELL prediction."""

    def __init__(self, params: dict | None = None):
        merged = {**DEFAULT_PARAMS, **(params or {})}

        # Extract params that are XGBClassifier constructor args vs fit args
        self.early_stopping = merged.pop("early_stopping_rounds", 50)

        self.model = xgb.XGBClassifier(**merged)
        self.feature_names: list[str] = []
        self.version: str = ""

    def train(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
        feature_names: list[str] | None = None,
    ) -> dict:
        """
        Train the model. Returns training metrics.

        Labels should be in XGBoost class format (0, 1, 2).
        """
        self.feature_names = feature_names or [f"f{i}" for i in range(X_train.shape[1])]

        fit_params: dict = {}
        if X_val is not None and y_val is not None:
            fit_params["eval_set"] = [(X_val, y_val)]
            fit_params["verbose"] = False

        self.model.fit(X_train, y_train, **fit_params)

        # Training metrics
        train_pred = self.model.predict(X_train)
        train_acc = float(np.mean(train_pred == y_train))

        metrics = {"train_accuracy": round(train_acc, 4), "n_samples": len(y_train)}

        if X_val is not None and y_val is not None:
            val_pred = self.model.predict(X_val)
            val_acc = float(np.mean(val_pred == y_val))
            metrics["val_accuracy"] = round(val_acc, 4)
            metrics["n_val_samples"] = len(y_val)

        return metrics

    def predict(self, X: np.ndarray) -> dict:
        """
        Predict on a single sample or batch.

        Returns dict with:
            direction: 'BUY' / 'SELL' / 'NEUTRAL'
            confidence: 0-100 (max class probability)
            probabilities: {BUY: %, SELL: %, NEUTRAL: %}
        """
        proba = self.model.predict_proba(X)

        if X.ndim == 1 or len(X) == 1:
            # Single prediction
            p = proba[0] if proba.ndim == 2 else proba
            class_idx = int(np.argmax(p))
            return {
                "direction": CLASS_NAMES[class_idx],
                "confidence": round(float(p[class_idx]) * 100, 1),
                "probabilities": {
                    "SELL": round(float(p[0]) * 100, 1),
                    "NEUTRAL": round(float(p[1]) * 100, 1),
                    "BUY": round(float(p[2]) * 100, 1),
                },
            }

        # Batch prediction
        results = []
        for p in proba:
            class_idx = int(np.argmax(p))
            results.append(
                {
                    "direction": CLASS_NAMES[class_idx],
                    "confidence": round(float(p[class_idx]) * 100, 1),
                    "probabilities": {
                        "SELL": round(float(p[0]) * 100, 1),
                        "NEUTRAL": round(float(p[1]) * 100, 1),
                        "BUY": round(float(p[2]) * 100, 1),
                    },
                }
            )
        return results

    def get_feature_importance(self, top_n: int = 15) -> list[dict]:
        """Get top N most important features."""
        importance = self.model.feature_importances_
        indices = np.argsort(importance)[::-1][:top_n]

        return [
            {
                "rank": i + 1,
                "feature": self.feature_names[idx] if idx < len(self.feature_names) else f"f{idx}",
                "importance": round(float(importance[idx]), 4),
            }
            for i, idx in enumerate(indices)
        ]

    def save(self, path: str, version: str) -> None:
        """Save model + metadata to disk."""
        self.version = version
        model_path = Path(path)
        model_path.parent.mkdir(parents=True, exist_ok=True)

        joblib.dump(self.model, str(model_path))

        # Save metadata alongside
        meta_path = model_path.with_suffix(".meta.json")
        meta = {
            "version": version,
            "feature_names": self.feature_names,
            "feature_importance": self.get_feature_importance(20),
        }
        meta_path.write_text(json.dumps(meta, indent=2))

    @classmethod
    def load(cls, path: str) -> "XGBoostModel":
        """Load a saved model from disk."""
        instance = cls.__new__(cls)
        instance.model = joblib.load(path)
        instance.early_stopping = 50

        meta_path = Path(path).with_suffix(".meta.json")
        if meta_path.exists():
            meta = json.loads(meta_path.read_text())
            instance.feature_names = meta.get("feature_names", [])
            instance.version = meta.get("version", "unknown")
        else:
            instance.feature_names = []
            instance.version = "unknown"

        return instance


def convert_labels_to_classes(labels: np.ndarray) -> np.ndarray:
    """Convert our labels (-1, 0, 1) to XGBoost classes (0, 1, 2)."""
    return np.vectorize(LABEL_TO_CLASS.get)(labels)


def convert_classes_to_labels(classes: np.ndarray) -> np.ndarray:
    """Convert XGBoost classes (0, 1, 2) back to our labels (-1, 0, 1)."""
    return np.vectorize(CLASS_TO_LABEL.get)(classes)
