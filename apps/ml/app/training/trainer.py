"""Walk-forward training pipeline.

Uses expanding-window cross-validation to avoid look-ahead bias.
Each fold trains on all data before the test window and evaluates
on the next unseen chunk. This simulates real deployment conditions.

Walk-forward splits:
  Fold 1: [TRAIN-------][TEST]
  Fold 2: [TRAIN-----------][TEST]
  Fold 3: [TRAIN---------------][TEST]
"""

import numpy as np
import pandas as pd

from app.models.xgboost_model import XGBoostModel, convert_labels_to_classes
from app.training.labels import generate_labels, label_distribution


def prepare_training_data(
    df: pd.DataFrame,
    forward_window: int = 10,
    atr_multiplier: float = 1.0,
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """
    Prepare features (X) and labels (y) from a feature DataFrame.

    Returns:
        X: feature matrix (n_samples × n_features)
        y: labels in XGBoost class format (0, 1, 2)
        feature_names: list of feature column names
    """
    # Generate labels
    labels = generate_labels(df, forward_window, atr_multiplier)

    # Feature columns: everything except base OHLCV, timestamp, and label
    exclude = {"ts", "open", "high", "low", "close", "volume"}
    feature_cols = [c for c in df.columns if c not in exclude]

    # Drop rows where labels are NaN (last forward_window rows)
    valid_mask = labels.notna()
    X = df.loc[valid_mask, feature_cols].values.astype(np.float64)
    y = labels[valid_mask].values.astype(int)

    # Convert our labels (-1, 0, 1) → XGBoost classes (0, 1, 2)
    y_classes = convert_labels_to_classes(y)

    return X, y_classes, feature_cols


def walk_forward_split(
    n_samples: int,
    n_folds: int = 5,
    min_train_ratio: float = 0.4,
    test_size_ratio: float = 0.1,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """
    Generate walk-forward (expanding window) train/test index splits.

    Args:
        n_samples: Total number of samples.
        n_folds: Number of validation folds.
        min_train_ratio: Minimum training set as fraction of total.
        test_size_ratio: Test set size as fraction of total.

    Returns:
        List of (train_indices, test_indices) tuples.
    """
    test_size = max(int(n_samples * test_size_ratio), 20)
    min_train = max(int(n_samples * min_train_ratio), 100)

    # Available space for folds after minimum training set
    available = n_samples - min_train
    if available < test_size * n_folds:
        # Not enough data for requested folds; reduce fold count
        n_folds = max(1, available // test_size)

    step = available // n_folds if n_folds > 0 else available

    splits = []
    for i in range(n_folds):
        test_end = min_train + (i + 1) * step
        test_start = test_end - test_size

        if test_end > n_samples:
            break

        train_idx = np.arange(0, test_start)
        test_idx = np.arange(test_start, test_end)
        splits.append((train_idx, test_idx))

    return splits


def train_walk_forward(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
    n_folds: int = 5,
) -> dict:
    """
    Perform walk-forward cross-validation.

    Returns:
        Dict with per-fold metrics, average metrics, and label distribution.
    """
    splits = walk_forward_split(len(X), n_folds)

    fold_metrics = []
    for fold_i, (train_idx, test_idx) in enumerate(splits):
        X_train, y_train = X[train_idx], y[train_idx]
        X_test, y_test = X[test_idx], y[test_idx]

        model = XGBoostModel()
        metrics = model.train(
            X_train, y_train, X_test, y_test, feature_names=feature_names
        )
        metrics["fold"] = fold_i + 1
        metrics["train_size"] = len(train_idx)
        metrics["test_size"] = len(test_idx)

        # Per-class accuracy on test set
        preds = model.model.predict(X_test)
        for cls, name in {0: "sell", 1: "neutral", 2: "buy"}.items():
            mask = y_test == cls
            if mask.sum() > 0:
                metrics[f"{name}_accuracy"] = round(
                    float(np.mean(preds[mask] == cls)), 4
                )

        fold_metrics.append(metrics)

    # Average metrics across folds
    avg_keys = ["train_accuracy", "val_accuracy"]
    averages = {}
    for key in avg_keys:
        vals = [f[key] for f in fold_metrics if key in f]
        if vals:
            averages[f"avg_{key}"] = round(sum(vals) / len(vals), 4)

    return {
        "n_folds": len(splits),
        "n_samples": len(X),
        "folds": fold_metrics,
        "averages": averages,
    }


def train_final_model(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
    val_split: float = 0.1,
) -> tuple[XGBoostModel, dict]:
    """
    Train the final model on all data (with a small validation holdout
    for early stopping). This is the model that gets deployed.

    Returns:
        (model, training_metrics)
    """
    # Use the last val_split% as validation for early stopping
    split_idx = int(len(X) * (1 - val_split))
    X_train, y_train = X[:split_idx], y[:split_idx]
    X_val, y_val = X[split_idx:], y[split_idx:]

    model = XGBoostModel()
    metrics = model.train(X_train, y_train, X_val, y_val, feature_names=feature_names)

    return model, metrics
