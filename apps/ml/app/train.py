"""Training CLI — run with: python -m app.train

Fetches candle data from PostgreSQL, computes features, generates labels,
trains models with walk-forward validation, runs backtest, and saves
the final model(s).

Usage:
    cd apps/ml
    python -m app.train                          # Train XGBoost only (default)
    python -m app.train --model all              # Train all models + ensemble
    python -m app.train --model lstm             # Train LSTM only
    python -m app.train --model ensemble         # Train full ensemble
    python -m app.train --model target            # Train target zone predictor (MFE/MAE)
    python -m app.train --model regime           # Train regime classifier (XGBoost 5-class)
    python -m app.train --retrain                # Auto-retrain pipeline
    python -m app.train --compare                # Compare all model performances
    python -m app.train --pair BTC/USD --timeframe 1h
    python -m app.train --backtest-only --model-path models/xgboost_v1.joblib
"""

import argparse
import asyncio
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from app.config import ML_MODEL_PATH
from app.db import get_pool, close_pool, fetch_active_pairs, fetch_pair_id
from app.features.pipeline import build_feature_matrix, get_feature_columns
from app.training.labels import label_distribution
from app.training.trainer import prepare_training_data, train_walk_forward, train_final_model
from app.training.backtest import run_backtest
from app.models.xgboost_model import XGBoostModel


async def load_training_data(
    pairs: list[dict],
    timeframe: str,
    limit: int,
    forward_window: int,
    atr_multiplier: float,
) -> tuple:
    """Load and prepare training data for all pairs combined."""
    import pandas as pd

    all_X = []
    all_y = []
    all_dfs = []
    feature_names = None

    for pair in pairs:
        pair_id = pair["id"]
        symbol = pair["symbol"]

        print(f"  Loading {symbol} {timeframe}...", end=" ")
        df = await build_feature_matrix(pair_id, timeframe, limit)

        if df.empty:
            print("skipped (not enough data)")
            continue

        X, y, feat_names = prepare_training_data(df, forward_window, atr_multiplier)
        print(f"{len(X)} samples, {len(feat_names)} features")

        all_X.append(X)
        all_y.append(y)
        all_dfs.append(df)

        if feature_names is None:
            feature_names = feat_names

    if not all_X:
        print("\nERROR: No training data available. Run backfill first.")
        sys.exit(1)

    X = np.vstack(all_X)
    y = np.concatenate(all_y)

    return X, y, feature_names, all_dfs


async def main_async(args: argparse.Namespace) -> None:
    await get_pool()

    try:
        # Auto-retrain mode
        if args.retrain:
            from app.training.auto_retrain import retrain_cli
            models = None if args.model == "all" else [args.model] if args.model != "xgboost" else None
            await retrain_cli(models)
            return

        # Determine pairs
        if args.pair:
            pair_id = await fetch_pair_id(args.pair)
            if not pair_id:
                print(f"Pair {args.pair} not found")
                sys.exit(1)
            pairs = [{"id": pair_id, "symbol": args.pair}]
        else:
            pairs = await fetch_active_pairs()

        if not pairs:
            print("No active pairs found. Run seed first.")
            sys.exit(1)

        timeframe = args.timeframe
        forward_window = args.forward_window
        atr_mult = args.atr_mult
        min_confidence = args.min_confidence
        model_type = args.model

        print(f"=== Training Pipeline ({model_type}) ===\n")
        print(f"Pairs:           {', '.join(p['symbol'] for p in pairs)}")
        print(f"Timeframe:       {timeframe}")
        print(f"Forward window:  {forward_window} candles")
        print(f"ATR multiplier:  {atr_mult}")
        print(f"Min confidence:  {min_confidence}%")
        print()

        # ── Load data ──
        print("Loading candle data + computing features...")
        X, y, feature_names, all_dfs = await load_training_data(
            pairs, timeframe, args.limit, forward_window, atr_mult
        )

        print(f"\nTotal: {len(X)} samples × {len(feature_names)} features")

        # Label distribution
        import pandas as pd

        dist_labels = np.where(y == 0, -1, np.where(y == 1, 0, 1))
        dist = label_distribution(pd.Series(dist_labels))
        print(
            f"Labels: BUY={dist['buy_pct']}% | NEUTRAL={dist['neutral_pct']}% | SELL={dist['sell_pct']}%"
        )

        # ── Backtest-only mode ──
        if args.backtest_only:
            if not args.model_path:
                print("ERROR: --model-path required with --backtest-only")
                sys.exit(1)
            model = XGBoostModel.load(args.model_path)
            print(f"\nLoaded model: {args.model_path}")
            print("\nRunning backtest...")
            for pair, df in zip(pairs, all_dfs):
                Xi, yi, _ = prepare_training_data(df, forward_window, atr_mult)
                results = run_backtest(model, df, Xi, feature_names, min_confidence, forward_window)
                print(f"\n--- {pair['symbol']} Backtest ---")
                _print_backtest(results)
            return

        # ── Compare mode ──
        if args.compare:
            await _run_compare(X, y, feature_names, all_dfs, pairs, min_confidence, forward_window, atr_mult)
            return

        # ── Train by model type ──
        if model_type in ("xgboost", "all", "ensemble"):
            await _train_xgboost(X, y, feature_names, all_dfs, pairs, args, min_confidence, forward_window, atr_mult)

        if model_type in ("lstm", "all", "ensemble"):
            await _train_lstm(X, y, feature_names, args)

        if model_type in ("tft", "all", "ensemble"):
            await _train_tft(X, y, feature_names, args, all_dfs)

        if model_type in ("cnn", "all", "ensemble"):
            await _train_cnn(X, y, feature_names, args)

        if model_type in ("target", "all"):
            await _train_target(X, feature_names, all_dfs, forward_window)

        if model_type in ("regime", "all"):
            await _train_regime(all_dfs)

        if model_type in ("seasonality", "all"):
            await _train_seasonality(pairs)

        if model_type in ("ensemble", "all"):
            await _train_ensemble(X, y, feature_names, all_dfs, pairs, args, min_confidence)

        print("\n=== Training Complete ===")

    finally:
        await close_pool()


async def _train_xgboost(X, y, feature_names, all_dfs, pairs, args, min_confidence, forward_window, atr_mult):
    """Train XGBoost with walk-forward validation."""
    print(f"\n── XGBoost ──")

    # Walk-forward
    print(f"Walk-forward validation ({args.n_folds} folds)...")
    wf_results = train_walk_forward(X, y, feature_names, args.n_folds)

    for fold in wf_results["folds"]:
        print(f"  Fold {fold['fold']}: train_acc={fold['train_accuracy']:.4f}  "
              f"val_acc={fold.get('val_accuracy', 'N/A')}")

    avg = wf_results["averages"]
    print(f"\n  Average: train_acc={avg.get('avg_train_accuracy', 'N/A')}  "
          f"val_acc={avg.get('avg_val_accuracy', 'N/A')}")

    # Final model
    print("\nTraining final model...")
    model, train_metrics = train_final_model(X, y, feature_names)

    print(f"  Train accuracy: {train_metrics['train_accuracy']}")
    print(f"  Val accuracy:   {train_metrics.get('val_accuracy', 'N/A')}")

    importance = model.get_feature_importance(10)
    print("\n  Top 10 features:")
    for fi in importance:
        print(f"    {fi['rank']:2d}. {fi['feature']:20s} {fi['importance']:.4f}")

    # Save
    version = f"xgboost_v1_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    model_dir = Path(ML_MODEL_PATH)
    model_dir.mkdir(parents=True, exist_ok=True)
    model_path = model_dir / f"{version}.joblib"
    model.save(str(model_path), version)

    latest_path = model_dir / "xgboost_latest.joblib"
    if latest_path.exists():
        latest_path.unlink()
    shutil.copy2(str(model_path), str(latest_path))
    meta_src = model_path.with_suffix(".meta.json")
    meta_dst = latest_path.with_suffix(".meta.json")
    if meta_src.exists():
        shutil.copy2(str(meta_src), str(meta_dst))

    print(f"\n  Model saved: {model_path}")

    # Backtest
    print("\n  Backtest:")
    for pair, df in zip(pairs, all_dfs):
        Xi, yi, _ = prepare_training_data(df, forward_window, atr_mult)
        results = run_backtest(model, df, Xi, feature_names, min_confidence, forward_window)
        print(f"    {pair['symbol']}: ", end="")
        if "error" in results:
            print(results["error"])
        else:
            print(f"win_rate={results['win_rate']:.1%}, PF={results['profit_factor']}, "
                  f"signals={results['total_signals']}")


async def _train_lstm(X, y, feature_names, args):
    """Train LSTM."""
    from app.models.lstm_model import LSTMModel

    print(f"\n── LSTM ──")
    split = int(len(X) * 0.9)
    model = LSTMModel(n_features=X.shape[1])
    metrics = model.train(X[:split], y[:split], X[split:], y[split:], feature_names=feature_names)

    print(f"  Train accuracy: {metrics['train_accuracy']}")
    print(f"  Val accuracy:   {metrics.get('val_accuracy', 'N/A')}")

    version = f"lstm_v1_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    model_dir = Path(ML_MODEL_PATH)
    model_path = model_dir / f"{version}.pt"
    model.save(str(model_path), version)
    print(f"  Model saved: {model_path}")


async def _train_tft(X, y, feature_names, args, all_dfs=None):
    """Train TFT with multi-horizon quantile forecasting."""
    from app.models.tft_model import TFTModel
    from app.training.labels import generate_multi_horizon_labels

    print(f"\n── Temporal Fusion Transformer ──")

    # Generate multi-horizon labels for quantile mode
    y_mh = None
    if all_dfs:
        all_mh = []
        for df in all_dfs:
            if df.empty:
                continue
            mh = generate_multi_horizon_labels(df)
            # Align: X was trimmed from df.dropna(), take from end
            samples_per_pair = len(X) // len(all_dfs)
            offset = len(df) - samples_per_pair
            all_mh.append(mh[offset:offset + samples_per_pair])
        if all_mh:
            y_mh = np.vstack(all_mh)
            # Trim to match X length
            min_len = min(len(X), len(y_mh))
            X_use = X[:min_len]
            y_mh = y_mh[:min_len]
            valid = ~np.any(np.isnan(y_mh), axis=1)
            print(f"  Multi-horizon labels: {int(valid.sum())}/{len(y_mh)} valid samples")

    if y_mh is not None:
        # Quantile mode
        split = int(len(X_use) * 0.9)
        model = TFTModel(n_features=X_use.shape[1])
        metrics = model.train(X_use[:split], y_mh[:split], X_use[split:], y_mh[split:], feature_names=feature_names)

        print(f"  Mode: quantile (4 horizons × 3 quantiles)")
        print(f"  Train quantile loss: {metrics.get('train_quantile_loss', 'N/A')}")
        print(f"  Val quantile loss:   {metrics.get('val_quantile_loss', 'N/A')}")
        print(f"  Val direction acc:   {metrics.get('val_direction_accuracy', 'N/A')}")
    else:
        # Classification fallback
        split = int(len(X) * 0.9)
        model = TFTModel(n_features=X.shape[1])
        metrics = model.train(X[:split], y[:split], X[split:], y[split:], feature_names=feature_names)

        print(f"  Mode: classification")
        print(f"  Train accuracy: {metrics.get('train_accuracy', 'N/A')}")
        print(f"  Val accuracy:   {metrics.get('val_accuracy', 'N/A')}")

    version = f"tft_v1_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    model_dir = Path(ML_MODEL_PATH)
    model_path = model_dir / f"{version}.pt"
    model.save(str(model_path), version)
    print(f"  Model saved: {model_path}")


async def _train_cnn(X, y, feature_names, args):
    """Train CNN."""
    from app.models.cnn_model import CNNModel

    print(f"\n── CNN Pattern Recognition ──")
    split = int(len(X) * 0.9)
    model = CNNModel()
    metrics = model.train(X[:split], y[:split], X[split:], y[split:], feature_names=feature_names)

    print(f"  Train accuracy: {metrics['train_accuracy']}")
    print(f"  Val accuracy:   {metrics.get('val_accuracy', 'N/A')}")

    version = f"cnn_v1_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    model_dir = Path(ML_MODEL_PATH)
    model_path = model_dir / f"{version}.pt"
    model.save(str(model_path), version)
    print(f"  Model saved: {model_path}")


async def _train_target(X, feature_names, all_dfs, forward_window):
    """Train target zone predictor (MFE/MAE regression)."""
    from app.models.target_predictor import TargetPredictor
    from app.training.labels import generate_mfe_mae_labels

    print(f"\n── Target Zone Predictor ──")

    # Generate MFE/MAE labels for each pair's DataFrame
    all_mfe = []
    all_mae = []
    for df in all_dfs:
        labels_df = generate_mfe_mae_labels(df, forward_window)
        mfe = labels_df["mfe_pct"].values
        mae = labels_df["mae_pct"].values

        # Align with X: the pipeline drops NaN rows from indicator warm-up
        # X is built from the tail of each df after dropna, so we align from the end
        samples_per_pair = len(X) // len(all_dfs)
        # labels_df has same len as df; X was trimmed from df.dropna()
        offset = len(df) - samples_per_pair
        all_mfe.append(mfe[offset:offset + samples_per_pair])
        all_mae.append(mae[offset:offset + samples_per_pair])

    mfe_labels = np.concatenate(all_mfe)
    mae_labels = np.concatenate(all_mae)

    # Ensure alignment (trim to shortest)
    min_len = min(len(X), len(mfe_labels))
    X_aligned = X[:min_len]
    mfe_labels = mfe_labels[:min_len]
    mae_labels = mae_labels[:min_len]

    valid_count = int(np.sum(~(np.isnan(mfe_labels) | np.isnan(mae_labels))))
    print(f"  Samples: {len(X_aligned)} total, {valid_count} with valid MFE/MAE labels")

    if valid_count < 50:
        print("  ERROR: Not enough valid samples. Need more candle data.")
        return

    predictor = TargetPredictor()
    metrics = predictor.train(X_aligned, mfe_labels, mae_labels, feature_names)

    print(f"  MFE R² (train): {metrics['mfe_r2_train']}")
    print(f"  MFE R² (val):   {metrics['mfe_r2_val']}")
    print(f"  MAE R² (train): {metrics['mae_r2_train']}")
    print(f"  MAE R² (val):   {metrics['mae_r2_val']}")

    # Save
    version = f"target_v1_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    model_dir = Path(ML_MODEL_PATH)
    model_dir.mkdir(parents=True, exist_ok=True)
    model_path = model_dir / f"{version}.joblib"
    predictor.save(str(model_path), version)

    # Copy as latest
    latest_path = model_dir / "target_latest.joblib"
    if latest_path.exists():
        latest_path.unlink()
    shutil.copy2(str(model_path), str(latest_path))
    meta_src = model_path.with_suffix(".meta.json")
    meta_dst = latest_path.with_suffix(".meta.json")
    if meta_src.exists():
        shutil.copy2(str(meta_src), str(meta_dst))

    print(f"\n  Target predictor saved: {model_path}")

    # Demo prediction
    sample_price = 65000.0  # Example BTC price
    zones = predictor.predict_zones(X_aligned[-1], sample_price, "BUY")
    print(f"\n  Demo (BUY @ ${sample_price:,.0f}):")
    print(f"    TP1: ${zones['tp1']:,.2f}  TP2: ${zones['tp2']:,.2f}  TP3: ${zones['tp3']:,.2f}")
    print(f"    SL:  ${zones['stop_loss']:,.2f}")
    print(f"    Expected move: +{zones['predicted_mfe_pct']:.2f}%")
    print(f"    Risk/Reward: {zones['risk_reward']:.2f}")


async def _train_regime(all_dfs):
    """Train the regime classifier on historical data from all pairs."""
    import pandas as pd
    from app.models.regime_classifier import RegimeClassifier
    from app.training.regime_labels import auto_label_regimes, regime_label_distribution

    print(f"\n── Regime Classifier ──")

    all_labeled_dfs = []
    all_labels = []

    for i, df in enumerate(all_dfs):
        if df.empty:
            continue
        labels = auto_label_regimes(df)
        all_labeled_dfs.append(df)
        all_labels.append(labels)
        dist = regime_label_distribution(labels)
        print(f"  Pair {i + 1}: {len(df)} samples — {dist['distribution']}")

    if not all_labeled_dfs:
        print("  ERROR: No data available for regime training")
        return

    combined_df = pd.concat(all_labeled_dfs, ignore_index=True)
    combined_labels = np.concatenate(all_labels)

    print(f"\n  Total: {len(combined_df)} samples")
    overall_dist = regime_label_distribution(combined_labels)
    for regime, info in overall_dist["distribution"].items():
        print(f"    {regime}: {info['count']} ({info['pct']}%)")

    classifier = RegimeClassifier()
    metrics = classifier.train(combined_df, combined_labels)

    print(f"\n  Train accuracy: {metrics['train_accuracy']}")
    print(f"  Val accuracy:   {metrics['val_accuracy']}")

    # Save
    model_dir = Path(ML_MODEL_PATH)
    model_dir.mkdir(parents=True, exist_ok=True)
    version = f"regime_v1_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    classifier.version = version
    model_path = model_dir / f"{version}.joblib"
    classifier.save(str(model_path))

    # Copy as latest
    latest_path = model_dir / "regime_classifier_latest.joblib"
    if latest_path.exists():
        latest_path.unlink()
    shutil.copy2(str(model_path), str(latest_path))
    meta_src = model_path.with_suffix(".meta.json")
    meta_dst = latest_path.with_suffix(".meta.json")
    if meta_src.exists():
        shutil.copy2(str(meta_src), str(meta_dst))

    print(f"\n  Regime classifier saved: {model_path}")


async def _train_seasonality(pairs):
    """Train seasonality profiles for all active pairs."""
    from app.models.seasonality import SeasonalityModel

    print(f"\n── Seasonality Profiles ──")

    model_dir = Path(ML_MODEL_PATH)
    model_dir.mkdir(parents=True, exist_ok=True)

    for pair in pairs:
        pair_id = pair["id"]
        symbol = pair["symbol"]

        print(f"  {symbol}...", end=" ")

        # Fetch 1h candles for seasonality
        pool = await get_pool()
        rows = await pool.fetch("""
            SELECT ts, open::float, high::float, low::float, close::float, volume::float
            FROM candles
            WHERE pair_id = $1 AND timeframe = '1h'
            ORDER BY ts ASC
        """, pair_id)

        if len(rows) < 100:
            print(f"skipped ({len(rows)} candles, need >= 100)")
            continue

        import pandas as pd
        df = pd.DataFrame([dict(r) for r in rows])
        df["ts"] = pd.to_datetime(df["ts"])

        model = SeasonalityModel()
        model.pair_id = pair_id
        metrics = model.train(df)

        save_name = symbol.replace("/", "_")
        save_path = model_dir / f"{save_name}_seasonality.json"
        model.save(str(save_path))
        print(f"{metrics['buckets_learned']} buckets from {metrics['total_candles']} candles → {save_path.name}")

    print("  Seasonality training complete.")


async def _train_ensemble(X, y, feature_names, all_dfs, pairs, args, min_confidence):
    """Train and calibrate the ensemble."""
    from app.models.lstm_model import LSTMModel
    from app.models.tft_model import TFTModel
    from app.models.cnn_model import CNNModel
    from app.models.ensemble import EnsembleModel

    print(f"\n── Ensemble Meta-Learner ──")

    model_dir = Path(ML_MODEL_PATH)
    ensemble = EnsembleModel()
    ensemble.feature_names = feature_names

    # Load latest of each model type
    xgb_path = model_dir / "xgboost_latest.joblib"
    if xgb_path.exists():
        ensemble.xgboost = XGBoostModel.load(str(xgb_path))
        print(f"  Loaded XGBoost: {ensemble.xgboost.version}")

    # Find latest .pt files for each type
    for model_type, ModelClass in [("lstm", LSTMModel), ("tft", TFTModel), ("cnn", CNNModel)]:
        pt_files = sorted(model_dir.glob(f"{model_type}_*.pt"), reverse=True)
        if pt_files:
            try:
                model = ModelClass.load(str(pt_files[0]))
                setattr(ensemble, model_type, model)
                print(f"  Loaded {model_type.upper()}: {model.version}")
            except Exception as e:
                print(f"  Failed to load {model_type}: {e}")

    if not ensemble.available_models:
        print("  ERROR: No models available for ensemble")
        return

    # Calibrate weights on validation split
    split = int(len(X) * 0.9)
    X_val, y_val = X[split:], y[split:]

    print("\n  Calibrating weights...")
    weights = ensemble.calibrate_weights(X_val, y_val, feature_names)
    print(f"  Weights: {weights}")

    # Save ensemble
    version = f"ensemble_v1_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    ensemble.save(str(model_dir), version)
    print(f"\n  Ensemble saved: {version}")
    print(f"  Models: {list(ensemble.available_models.keys())}")


async def _run_compare(X, y, feature_names, all_dfs, pairs, min_confidence, forward_window, atr_mult):
    """Compare all available models."""
    from app.models.lstm_model import LSTMModel
    from app.models.tft_model import TFTModel
    from app.models.cnn_model import CNNModel

    print(f"\n=== Model Comparison ===\n")

    model_dir = Path(ML_MODEL_PATH)
    split = int(len(X) * 0.9)
    X_val, y_val = X[split:], y[split:]

    results = {}

    # XGBoost
    xgb_path = model_dir / "xgboost_latest.joblib"
    if xgb_path.exists():
        model = XGBoostModel.load(str(xgb_path))
        preds = model.model.predict(X_val)
        acc = float(np.mean(preds == y_val))
        results["xgboost"] = {"accuracy": round(acc, 4), "version": model.version}
        print(f"  XGBoost:  acc={acc:.4f}  ({model.version})")

    # LSTM
    lstm_files = sorted(model_dir.glob("lstm_*.pt"), reverse=True)
    if lstm_files:
        try:
            model = LSTMModel.load(str(lstm_files[0]))
            proba = model.predict_proba_batch(X_val)
            if len(proba) > 0:
                from app.models.lstm_model import SEQ_LEN
                y_aligned = y_val[SEQ_LEN:SEQ_LEN + len(proba)]
                preds = np.argmax(proba, axis=1)
                acc = float(np.mean(preds == y_aligned))
                results["lstm"] = {"accuracy": round(acc, 4), "version": model.version}
                print(f"  LSTM:     acc={acc:.4f}  ({model.version})")
        except Exception as e:
            print(f"  LSTM: failed — {e}")

    # TFT
    tft_files = sorted(model_dir.glob("tft_*.pt"), reverse=True)
    if tft_files:
        try:
            model = TFTModel.load(str(tft_files[0]))
            proba = model.predict_proba_batch(X_val)
            if len(proba) > 0:
                from app.models.lstm_model import SEQ_LEN
                y_aligned = y_val[SEQ_LEN:SEQ_LEN + len(proba)]
                preds = np.argmax(proba, axis=1)
                acc = float(np.mean(preds == y_aligned))
                results["tft"] = {"accuracy": round(acc, 4), "version": model.version}
                print(f"  TFT:      acc={acc:.4f}  ({model.version})")
        except Exception as e:
            print(f"  TFT: failed — {e}")

    # CNN
    cnn_files = sorted(model_dir.glob("cnn_*.pt"), reverse=True)
    if cnn_files:
        try:
            model = CNNModel.load(str(cnn_files[0]))
            proba = model.predict_proba_batch(X_val)
            if len(proba) > 0:
                from app.models.cnn_model import CNN_SEQ_LEN
                y_aligned = y_val[CNN_SEQ_LEN:CNN_SEQ_LEN + len(proba)]
                preds = np.argmax(proba, axis=1)
                acc = float(np.mean(preds == y_aligned))
                results["cnn"] = {"accuracy": round(acc, 4), "version": model.version}
                print(f"  CNN:      acc={acc:.4f}  ({model.version})")
        except Exception as e:
            print(f"  CNN: failed — {e}")

    if results:
        best = max(results.items(), key=lambda x: x[1]["accuracy"])
        print(f"\n  Best: {best[0].upper()} (acc={best[1]['accuracy']:.4f})")


def _print_backtest(results: dict) -> None:
    """Pretty-print backtest results."""
    if "error" in results:
        print(f"  {results['error']}")
        return

    print(f"  Signals:       {results['total_signals']} "
          f"(BUY={results['buy_signals']}, SELL={results['sell_signals']})")
    print(f"  Win/Loss/Exp:  {results['wins']}/{results['losses']}/{results['expired']}")
    print(f"  Win Rate:      {results['win_rate']:.1%}")
    print(f"  TP Hit Rates:  TP1={results['tp1_hit_rate']:.1%}  "
          f"TP2={results['tp2_hit_rate']:.1%}  TP3={results['tp3_hit_rate']:.1%}")
    print(f"  Profit Factor: {results['profit_factor']}")
    print(f"  Sharpe Ratio:  {results['sharpe_ratio']}")
    print(f"  Max Drawdown:  {results['max_drawdown_pct']:.2f}%")
    print(f"  Total Return:  {results['total_return_pct']:.2f}%")
    print(f"  Avg Confidence:{results['avg_confidence']:.1f}%")


def main():
    parser = argparse.ArgumentParser(description="Train ML trading models")
    parser.add_argument("--model", type=str, default="xgboost",
                        choices=["xgboost", "lstm", "tft", "cnn", "target", "regime", "seasonality", "ensemble", "all"],
                        help="Model type to train")
    parser.add_argument("--pair", type=str, help="Single pair (e.g. BTC/USD)")
    parser.add_argument("--timeframe", type=str, default="1h", help="Candle timeframe")
    parser.add_argument("--limit", type=int, default=500, help="Max candles per pair")
    parser.add_argument("--forward-window", type=int, default=10, help="Label lookahead")
    parser.add_argument("--atr-mult", type=float, default=1.0, help="ATR threshold multiplier")
    parser.add_argument("--min-confidence", type=float, default=70.0, help="Min signal confidence")
    parser.add_argument("--n-folds", type=int, default=5, help="Walk-forward folds")
    parser.add_argument("--backtest-only", action="store_true", help="Only run backtest")
    parser.add_argument("--model-path", type=str, help="Path to saved model (for backtest)")
    parser.add_argument("--retrain", action="store_true", help="Run auto-retrain pipeline")
    parser.add_argument("--compare", action="store_true", help="Compare all available models")
    args = parser.parse_args()

    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
