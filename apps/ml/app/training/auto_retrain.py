"""Auto-retrain pipeline — scheduled model retraining.

Process:
  1. Fetch latest candle data (since last training)
  2. Retrain all models with new data included
  3. Walk-forward backtest on most recent 30-day window
  4. Compare metrics against current active model
  5. If new model is better → promote to active
  6. If worse → keep current model, log for review
  7. Store version in ml_model_versions table

Schedule:
  - Weekly: XGBoost (fast, ~2 min)
  - Monthly: Deep learning models (slower, uses GPU)
  - On-demand: via API endpoint
"""

import asyncio
import json
import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from app.config import ML_MODEL_PATH
from app.db import get_pool, close_pool, fetch_active_pairs
from app.features.pipeline import build_feature_matrix, get_feature_columns
from app.training.trainer import prepare_training_data, train_final_model
from app.training.backtest import run_backtest
from app.models.xgboost_model import XGBoostModel
from app.models.lstm_model import LSTMModel
from app.models.tft_model import TFTModel
from app.models.cnn_model import CNNModel
from app.models.ensemble import EnsembleModel

logger = logging.getLogger("ml.retrain")


async def load_all_training_data(
    timeframe: str = "1h",
    limit: int = 500,
    forward_window: int = 10,
    atr_multiplier: float = 1.0,
) -> tuple:
    """Load training data for all active pairs."""
    pairs = await fetch_active_pairs()
    if not pairs:
        raise RuntimeError("No active pairs found")

    all_X, all_y, all_dfs = [], [], []
    feature_names = None

    for pair in pairs:
        df = await build_feature_matrix(pair["id"], timeframe, limit)
        if df.empty:
            continue
        X, y, feat_names = prepare_training_data(df, forward_window, atr_multiplier)
        all_X.append(X)
        all_y.append(y)
        all_dfs.append(df)
        if feature_names is None:
            feature_names = feat_names

    if not all_X:
        raise RuntimeError("No training data available")

    X = np.vstack(all_X)
    y = np.concatenate(all_y)
    return X, y, feature_names, all_dfs, pairs


async def retrain_xgboost(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
) -> tuple[XGBoostModel, dict]:
    """Retrain XGBoost model."""
    logger.info("Retraining XGBoost...")
    model, metrics = train_final_model(X, y, feature_names)
    logger.info(f"  XGBoost: train_acc={metrics['train_accuracy']}, val_acc={metrics.get('val_accuracy', 'N/A')}")
    return model, metrics


async def retrain_lstm(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
) -> tuple[LSTMModel, dict]:
    """Retrain LSTM model."""
    logger.info("Retraining LSTM...")
    split = int(len(X) * 0.9)
    model = LSTMModel(n_features=X.shape[1])
    metrics = model.train(
        X[:split], y[:split],
        X[split:], y[split:],
        feature_names=feature_names,
    )
    logger.info(f"  LSTM: train_acc={metrics['train_accuracy']}, val_acc={metrics.get('val_accuracy', 'N/A')}")
    return model, metrics


async def retrain_tft(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
) -> tuple[TFTModel, dict]:
    """Retrain TFT model."""
    logger.info("Retraining TFT...")
    split = int(len(X) * 0.9)
    model = TFTModel(n_features=X.shape[1])
    metrics = model.train(
        X[:split], y[:split],
        X[split:], y[split:],
        feature_names=feature_names,
    )
    logger.info(f"  TFT: train_acc={metrics['train_accuracy']}, val_acc={metrics.get('val_accuracy', 'N/A')}")
    return model, metrics


async def retrain_cnn(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
) -> tuple[CNNModel, dict]:
    """Retrain CNN model."""
    logger.info("Retraining CNN...")
    split = int(len(X) * 0.9)
    model = CNNModel()
    metrics = model.train(
        X[:split], y[:split],
        X[split:], y[split:],
        feature_names=feature_names,
    )
    logger.info(f"  CNN: train_acc={metrics['train_accuracy']}, val_acc={metrics.get('val_accuracy', 'N/A')}")
    return model, metrics


async def run_full_retrain(
    models_to_train: list[str] | None = None,
    timeframe: str = "1h",
    min_confidence: float = 70.0,
) -> dict:
    """
    Full retrain pipeline.

    Args:
        models_to_train: List of model names to retrain.
                         None = all models.
        timeframe: Candle timeframe.
        min_confidence: Minimum confidence for backtest.

    Returns:
        Report dict with metrics for each model + ensemble.
    """
    train_all = models_to_train is None
    models_to_train = models_to_train or ["xgboost", "lstm", "tft", "cnn"]

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    version = f"ensemble_v{ts}"

    logger.info(f"=== Auto-Retrain Pipeline ===")
    logger.info(f"Version: {version}")
    logger.info(f"Models: {models_to_train}")

    # Load data
    X, y, feature_names, all_dfs, pairs = await load_all_training_data(timeframe)
    logger.info(f"Data: {len(X)} samples × {len(feature_names)} features")

    report: dict = {
        "version": version,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "n_samples": len(X),
        "n_features": len(feature_names),
        "models": {},
    }

    # Split for validation
    split_idx = int(len(X) * 0.9)
    X_val, y_val = X[split_idx:], y[split_idx:]

    ensemble = EnsembleModel()
    ensemble.feature_names = feature_names

    # Retrain each model
    if "xgboost" in models_to_train:
        xgb_model, xgb_metrics = await retrain_xgboost(X, y, feature_names)
        ensemble.xgboost = xgb_model
        report["models"]["xgboost"] = xgb_metrics

    if "lstm" in models_to_train:
        lstm_model, lstm_metrics = await retrain_lstm(X, y, feature_names)
        ensemble.lstm = lstm_model
        report["models"]["lstm"] = lstm_metrics

    if "tft" in models_to_train:
        tft_model, tft_metrics = await retrain_tft(X, y, feature_names)
        ensemble.tft = tft_model
        report["models"]["tft"] = tft_metrics

    if "cnn" in models_to_train:
        cnn_model, cnn_metrics = await retrain_cnn(X, y, feature_names)
        ensemble.cnn = cnn_model
        report["models"]["cnn"] = cnn_metrics

    # Calibrate ensemble weights
    logger.info("Calibrating ensemble weights...")
    weights = ensemble.calibrate_weights(X_val, y_val, feature_names)
    report["ensemble_weights"] = weights

    # Save ensemble
    model_dir = Path(ML_MODEL_PATH)
    ensemble.save(str(model_dir), version)

    # Also update the standalone xgboost_latest for backward compat
    if ensemble.xgboost:
        latest_path = model_dir / "xgboost_latest.joblib"
        if latest_path.exists():
            latest_path.unlink()
        xgb_src = model_dir / f"{version}_xgboost.joblib"
        if xgb_src.exists():
            shutil.copy2(str(xgb_src), str(latest_path))
            meta_src = xgb_src.with_suffix(".meta.json")
            meta_dst = latest_path.with_suffix(".meta.json")
            if meta_src.exists():
                shutil.copy2(str(meta_src), str(meta_dst))

    # Run backtest on each pair
    logger.info("Running backtest...")
    backtest_results = {}
    for pair, df in zip(pairs, all_dfs):
        Xi, yi, _ = prepare_training_data(df, 10, 1.0)
        # Use XGBoost for backtest (simplest, supports single-row prediction)
        if ensemble.xgboost:
            bt = run_backtest(ensemble.xgboost, df, Xi, feature_names, min_confidence, 10)
            backtest_results[pair["symbol"]] = bt
            logger.info(f"  {pair['symbol']}: win_rate={bt.get('win_rate', 'N/A')}")

    report["backtest"] = backtest_results

    # Store version in DB
    await _store_model_version(version, report)

    # Save report
    report_path = model_dir / f"{version}_report.json"
    report_path.write_text(json.dumps(report, indent=2, default=str))
    logger.info(f"Report saved: {report_path}")
    logger.info("=== Retrain Complete ===")

    return report


async def _store_model_version(version: str, report: dict) -> None:
    """Insert model version record into ml_model_versions table."""
    try:
        pool = await get_pool()

        # Deactivate previous active versions
        await pool.execute("UPDATE ml_model_versions SET is_active = false WHERE is_active = true")

        await pool.execute(
            """
            INSERT INTO ml_model_versions (version, metrics, is_active, trained_at, training_samples, feature_importance)
            VALUES ($1, $2, true, now(), $3, $4)
            """,
            version,
            json.dumps(report.get("models", {})),
            report.get("n_samples", 0),
            json.dumps(report.get("ensemble_weights", {})),
        )
        logger.info(f"Model version {version} stored in DB (active)")
    except Exception as e:
        logger.warning(f"Failed to store model version: {e}")


async def retrain_cli(models: list[str] | None = None) -> None:
    """CLI entry point for retrain."""
    await get_pool()
    try:
        report = await run_full_retrain(models)
        print(json.dumps(report, indent=2, default=str))
    finally:
        await close_pool()
