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
            await _train_tft(X, y, feature_names, args)

        if model_type in ("cnn", "all", "ensemble"):
            await _train_cnn(X, y, feature_names, args)

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


async def _train_tft(X, y, feature_names, args):
    """Train TFT."""
    from app.models.tft_model import TFTModel

    print(f"\n── Temporal Fusion Transformer ──")
    split = int(len(X) * 0.9)
    model = TFTModel(n_features=X.shape[1])
    metrics = model.train(X[:split], y[:split], X[split:], y[split:], feature_names=feature_names)

    print(f"  Train accuracy: {metrics['train_accuracy']}")
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
                        choices=["xgboost", "lstm", "tft", "cnn", "ensemble", "all"],
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
