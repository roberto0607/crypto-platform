"""Crypto ML Signal Service — FastAPI application.

Serves predictions from a 4-model ensemble:
  - XGBoost (indicator combinations)
  - LSTM (sequential patterns)
  - TFT (multi-timeframe attention)
  - CNN (chart pattern recognition)

Plus: regime detection, attention explainability, auto-retrain,
and performance monitoring.
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, BackgroundTasks

from app.config import ML_MODEL_PATH, ML_MIN_CONFIDENCE
from app.db import get_pool, close_pool, fetch_pair_id, fetch_active_pairs
from app.features.pipeline import (
    build_feature_matrix,
    build_multi_timeframe_features,
    get_feature_columns,
)
from app.models.xgboost_model import XGBoostModel
from app.models.ensemble import EnsembleModel
from app.models.signal_generator import generate_signal
from app.models.regime_detector import detect_regime, REGIME_CONFIGS
from app.training.alerts import AlertChecker, format_alerts

logger = logging.getLogger("ml")

# Loaded models
_model: XGBoostModel | None = None
_ensemble: EnsembleModel | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model, _ensemble
    await get_pool()

    model_dir = Path(ML_MODEL_PATH)

    # Try loading ensemble first
    ensemble_meta = model_dir / "ensemble_latest.meta.json"
    if ensemble_meta.exists():
        try:
            _ensemble = EnsembleModel.load(str(model_dir))
            models = list(_ensemble.available_models.keys())
            logger.info(f"Ensemble loaded: {models} (weights={_ensemble.weights})")
        except Exception as e:
            logger.warning(f"Failed to load ensemble: {e}")

    # Always load XGBoost standalone (backward compat + fallback)
    model_path = model_dir / "xgboost_latest.joblib"
    if model_path.exists():
        try:
            _model = XGBoostModel.load(str(model_path))
            logger.info(f"XGBoost loaded: {_model.version} ({len(_model.feature_names)} features)")
        except Exception as e:
            logger.warning(f"Failed to load XGBoost: {e}")
    else:
        logger.info("No trained model found — /predict will return 503 until training is run")

    yield
    await close_pool()


app = FastAPI(
    title="Crypto ML Signal Service",
    version="0.2.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health():
    """Health check — verifies DB connectivity."""
    pool = await get_pool()
    await pool.fetchval("SELECT 1")

    models_loaded = []
    if _model:
        models_loaded.append("xgboost")
    if _ensemble:
        models_loaded.extend(list(_ensemble.available_models.keys()))

    return {
        "status": "ok",
        "service": "ml",
        "models_loaded": list(set(models_loaded)),
        "ensemble": _ensemble is not None,
    }


@app.get("/pairs")
async def list_pairs():
    """List all active trading pairs."""
    pairs = await fetch_active_pairs()
    return {"pairs": pairs}


@app.get("/features/{symbol}")
async def get_features(symbol: str, timeframe: str = "1h", limit: int = 500):
    """Compute feature matrix for a trading pair."""
    db_symbol = symbol.replace("-", "/")
    pair_id = await fetch_pair_id(db_symbol)
    if not pair_id:
        raise HTTPException(status_code=404, detail=f"Pair {db_symbol} not found")

    df = await build_feature_matrix(pair_id, timeframe, limit)
    if df.empty:
        raise HTTPException(status_code=400, detail="Not enough candle data (need >= 50)")

    feature_cols = get_feature_columns(df)

    preview = df.tail(5).copy()
    preview["ts"] = preview["ts"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    return {
        "pair": db_symbol,
        "timeframe": timeframe,
        "rows": len(df),
        "features": feature_cols,
        "feature_count": len(feature_cols),
        "latest": {
            k: _safe_val(v) for k, v in df.iloc[-1][feature_cols].to_dict().items()
        },
        "preview": [
            {k: _safe_val(v) for k, v in row.items()}
            for row in preview.to_dict(orient="records")
        ],
    }


@app.get("/features/{symbol}/multi-tf")
async def get_multi_tf_features(symbol: str, timeframe: str = "1h", limit: int = 500):
    """Compute multi-timeframe enriched feature matrix."""
    db_symbol = symbol.replace("-", "/")
    pair_id = await fetch_pair_id(db_symbol)
    if not pair_id:
        raise HTTPException(status_code=404, detail=f"Pair {db_symbol} not found")

    df = await build_multi_timeframe_features(pair_id, timeframe, limit)
    if df.empty:
        raise HTTPException(status_code=400, detail="Not enough candle data")

    feature_cols = get_feature_columns(df)

    return {
        "pair": db_symbol,
        "timeframe": timeframe,
        "rows": len(df),
        "features": feature_cols,
        "feature_count": len(feature_cols),
        "latest": {
            k: _safe_val(v) for k, v in df.iloc[-1][feature_cols].to_dict().items()
        },
    }


@app.get("/predict/{symbol}")
async def predict(symbol: str, timeframe: str = "1h", limit: int = 300):
    """
    Generate an AI trading signal using ensemble or XGBoost fallback.

    Returns signal with direction, confidence, TP zones, stop-loss,
    regime detection, model contributions, and attention explanation.
    """
    active_model = _model
    if active_model is None and _ensemble is None:
        raise HTTPException(
            status_code=503,
            detail="No trained model available. Run: python -m app.train",
        )

    db_symbol = symbol.replace("-", "/")
    pair_id = await fetch_pair_id(db_symbol)
    if not pair_id:
        raise HTTPException(status_code=404, detail=f"Pair {db_symbol} not found")

    df = await build_feature_matrix(pair_id, timeframe, limit)
    if df.empty:
        raise HTTPException(status_code=400, detail="Not enough candle data")

    # Determine which model to use for feature alignment
    if _ensemble and _ensemble.xgboost:
        feature_cols = _ensemble.xgboost.feature_names
    elif active_model:
        feature_cols = active_model.feature_names
    else:
        feature_cols = get_feature_columns(df)

    available_cols = set(df.columns)
    missing = [c for c in feature_cols if c not in available_cols]
    if missing:
        raise HTTPException(
            status_code=500,
            detail=f"Feature mismatch: model expects {missing} but they are not computed",
        )

    latest = df.iloc[-1]
    X = latest[feature_cols].values.astype(np.float64).reshape(1, -1)

    current_price = float(latest["close"])
    atr = float(latest["atr_14"]) if "atr_14" in df.columns else 0

    if atr <= 0:
        version = _ensemble.version if _ensemble else (active_model.version if active_model else "none")
        return {
            "pair": db_symbol,
            "timeframe": timeframe,
            "signal": None,
            "reason": "ATR is zero — cannot calculate TP zones",
            "model_version": version,
        }

    # Use ensemble if available, otherwise fall back to XGBoost
    regime_info = None
    model_contributions = None
    attention = None

    if _ensemble and _ensemble.available_models:
        prediction = _ensemble.predict(X, df=df)
        regime_info = prediction.get("regime")
        model_contributions = prediction.get("model_contributions")

        # Get attention explanation from TFT if loaded
        if _ensemble.tft:
            try:
                attention = _ensemble.tft.get_attention_explanation(
                    df[feature_cols].values.astype(np.float64)
                )
            except Exception:
                pass

        model_version = _ensemble.version
        top_features = _ensemble.get_feature_importance(5)
    elif active_model:
        prediction = active_model.predict(X)
        model_version = active_model.version
        top_features = active_model.get_feature_importance(5)
    else:
        raise HTTPException(status_code=503, detail="No model available")

    # Enrich feature importance with current values
    for f in top_features:
        fname = f["feature"]
        if fname in available_cols:
            f["value"] = _safe_val(latest[fname])

    # Adjust TP/SL based on regime
    tp_mult = 1.0
    sl_mult = 1.0
    effective_min_conf = ML_MIN_CONFIDENCE
    if regime_info and regime_info.get("config"):
        rc = regime_info["config"]
        tp_mult = rc.get("tp_multiplier", 1.0)
        sl_mult = rc.get("sl_multiplier", 1.0)
        effective_min_conf = rc.get("min_confidence", ML_MIN_CONFIDENCE)

    signal = generate_signal(
        prediction=prediction,
        current_price=current_price,
        atr=atr,
        min_confidence=effective_min_conf,
        top_features=top_features,
        model_version=model_version,
    )

    # Apply regime TP/SL multipliers
    if signal and (tp_mult != 1.0 or sl_mult != 1.0):
        if signal.signal_type == "BUY":
            signal.tp1 = round(current_price + (signal.tp1 - current_price) * tp_mult, 2)
            signal.tp2 = round(current_price + (signal.tp2 - current_price) * tp_mult, 2)
            signal.tp3 = round(current_price + (signal.tp3 - current_price) * tp_mult, 2)
            signal.stop_loss = round(current_price - (current_price - signal.stop_loss) * sl_mult, 2)
        else:
            signal.tp1 = round(current_price - (current_price - signal.tp1) * tp_mult, 2)
            signal.tp2 = round(current_price - (current_price - signal.tp2) * tp_mult, 2)
            signal.tp3 = round(current_price - (current_price - signal.tp3) * tp_mult, 2)
            signal.stop_loss = round(current_price + (signal.stop_loss - current_price) * sl_mult, 2)

    response: dict = {
        "pair": db_symbol,
        "timeframe": timeframe,
        "signal": signal.to_dict() if signal else None,
        "prediction": {
            "direction": prediction["direction"],
            "confidence": prediction["confidence"],
            "probabilities": prediction["probabilities"],
        },
        "current_price": current_price,
        "atr_14": round(atr, 2),
        "model_version": model_version,
    }

    if regime_info:
        response["regime"] = regime_info
    if model_contributions:
        response["model_contributions"] = model_contributions
    if attention:
        response["attention"] = attention

    return response


@app.get("/regime/{symbol}")
async def get_regime(symbol: str, timeframe: str = "1h", limit: int = 300):
    """Detect the current market regime for a pair."""
    db_symbol = symbol.replace("-", "/")
    pair_id = await fetch_pair_id(db_symbol)
    if not pair_id:
        raise HTTPException(status_code=404, detail=f"Pair {db_symbol} not found")

    df = await build_feature_matrix(pair_id, timeframe, limit)
    if df.empty:
        raise HTTPException(status_code=400, detail="Not enough candle data")

    regime, evidence = detect_regime(df)
    config = REGIME_CONFIGS[regime]

    return {
        "pair": db_symbol,
        "timeframe": timeframe,
        "regime": regime.value,
        "evidence": evidence,
        "config": {
            "min_confidence": config.min_confidence,
            "tp_multiplier": config.tp_multiplier,
            "sl_multiplier": config.sl_multiplier,
            "description": config.description,
        },
    }


@app.get("/model/info")
async def model_info():
    """Get info about loaded models."""
    info: dict = {"loaded": False}

    if _ensemble:
        models = {}
        for name, model in _ensemble.available_models.items():
            models[name] = {
                "version": getattr(model, "version", "unknown"),
                "weight": _ensemble.weights.get(name, 0),
            }
        info = {
            "loaded": True,
            "type": "ensemble",
            "version": _ensemble.version,
            "models": models,
            "weights": _ensemble.weights,
            "regime_aware": _ensemble.regime_aware,
            "feature_importance": _ensemble.get_feature_importance(15),
        }
    elif _model:
        info = {
            "loaded": True,
            "type": "xgboost",
            "version": _model.version,
            "n_features": len(_model.feature_names),
            "feature_importance": _model.get_feature_importance(15),
        }

    return info


@app.post("/retrain")
async def trigger_retrain(background_tasks: BackgroundTasks, models: str = "all"):
    """Trigger model retraining (runs in background)."""
    from app.training.auto_retrain import run_full_retrain

    model_list = None if models == "all" else models.split(",")

    async def _retrain():
        try:
            report = await run_full_retrain(model_list)
            logger.info(f"Retrain complete: {report.get('version')}")
        except Exception as e:
            logger.error(f"Retrain failed: {e}")

    background_tasks.add_task(_retrain)

    return {
        "status": "started",
        "models": model_list or "all",
        "message": "Retraining started in background. Check /model/info for updated version.",
    }


@app.get("/alerts")
async def check_alerts():
    """Check for performance degradation alerts."""
    checker = AlertChecker()

    pool = await get_pool()

    row = await pool.fetchrow("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE outcome IN ('tp1','tp2','tp3')) AS wins,
            COUNT(*) FILTER (WHERE outcome = 'sl') AS losses,
            AVG(confidence) AS avg_conf
        FROM ml_signals
        WHERE created_at > now() - interval '7 days'
    """)

    total = row["total"] if row else 0
    wins = row["wins"] if row else 0
    losses = row["losses"] if row else 0
    decided = wins + losses

    performance = {
        "win_rate": wins / max(decided, 1),
        "profit_factor": wins / max(losses, 1),
        "total_signals": total,
    }

    version_row = await pool.fetchrow(
        "SELECT trained_at FROM ml_model_versions WHERE is_active = true LIMIT 1"
    )
    last_retrained = version_row["trained_at"] if version_row else None

    alerts = checker.check(
        performance,
        last_retrained=last_retrained,
        recent_signal_count=total,
    )

    return {
        "alerts": format_alerts(alerts),
        "performance_snapshot": performance,
        "last_retrained": last_retrained.isoformat() if last_retrained else None,
    }


@app.get("/dashboard")
async def performance_dashboard():
    """Performance dashboard — comprehensive signal metrics."""
    pool = await get_pool()

    # Overall metrics
    overall = await pool.fetchrow("""
        SELECT
            COUNT(*) AS total_signals,
            COUNT(*) FILTER (WHERE outcome IN ('tp1','tp2','tp3')) AS wins,
            COUNT(*) FILTER (WHERE outcome = 'sl') AS losses,
            COUNT(*) FILTER (WHERE outcome = 'expired') AS expired,
            COUNT(*) FILTER (WHERE outcome = 'pending') AS pending,
            AVG(confidence) AS avg_confidence,
            COUNT(*) FILTER (WHERE tp1_hit_at IS NOT NULL) AS tp1_hits,
            COUNT(*) FILTER (WHERE tp2_hit_at IS NOT NULL) AS tp2_hits,
            COUNT(*) FILTER (WHERE tp3_hit_at IS NOT NULL) AS tp3_hits
        FROM ml_signals
    """)

    total = overall["total_signals"] or 0
    wins = overall["wins"] or 0
    losses = overall["losses"] or 0
    decided = wins + losses

    # By pair
    by_pair_rows = await pool.fetch("""
        SELECT
            tp.symbol,
            COUNT(*) AS signals,
            COUNT(*) FILTER (WHERE ms.outcome IN ('tp1','tp2','tp3')) AS wins,
            COUNT(*) FILTER (WHERE ms.outcome = 'sl') AS losses,
            AVG(ms.confidence) AS avg_conf
        FROM ml_signals ms
        JOIN trading_pairs tp ON tp.id = ms.pair_id
        GROUP BY tp.symbol
        ORDER BY COUNT(*) DESC
    """)

    by_pair = {}
    for r in by_pair_rows:
        d = r["wins"] + r["losses"]
        by_pair[r["symbol"]] = {
            "signals": r["signals"],
            "win_rate": round(r["wins"] / max(d, 1), 4),
            "wins": r["wins"],
            "losses": r["losses"],
            "avg_confidence": round(float(r["avg_conf"] or 0), 1),
        }

    # By regime
    by_regime_rows = await pool.fetch("""
        SELECT
            COALESCE(regime, 'unknown') AS regime,
            COUNT(*) AS signals,
            COUNT(*) FILTER (WHERE outcome IN ('tp1','tp2','tp3')) AS wins,
            COUNT(*) FILTER (WHERE outcome = 'sl') AS losses
        FROM ml_signals
        GROUP BY regime
        ORDER BY COUNT(*) DESC
    """)

    by_regime = {}
    for r in by_regime_rows:
        d = r["wins"] + r["losses"]
        by_regime[r["regime"]] = {
            "signals": r["signals"],
            "win_rate": round(r["wins"] / max(d, 1), 4),
        }

    # Recent signals
    recent = await pool.fetch("""
        SELECT
            ms.id, tp.symbol, ms.timeframe, ms.signal_type,
            ms.confidence, ms.entry_price, ms.tp1_price, ms.stop_loss_price,
            ms.outcome, ms.regime, ms.model_version, ms.created_at
        FROM ml_signals ms
        JOIN trading_pairs tp ON tp.id = ms.pair_id
        ORDER BY ms.created_at DESC
        LIMIT 20
    """)

    recent_signals = [
        {
            "id": str(r["id"]),
            "symbol": r["symbol"],
            "timeframe": r["timeframe"],
            "signal_type": r["signal_type"],
            "confidence": float(r["confidence"]),
            "entry_price": str(r["entry_price"]),
            "outcome": r["outcome"],
            "regime": r["regime"],
            "model_version": r["model_version"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        }
        for r in recent
    ]

    # Model version
    model_ver = await pool.fetchrow(
        "SELECT version, trained_at FROM ml_model_versions WHERE is_active = true LIMIT 1"
    )

    return {
        "overall": {
            "total_signals": total,
            "wins": wins,
            "losses": losses,
            "expired": overall["expired"] or 0,
            "pending": overall["pending"] or 0,
            "win_rate": round(wins / max(decided, 1), 4),
            "avg_confidence": round(float(overall["avg_confidence"] or 0), 1),
            "tp1_hit_rate": round((overall["tp1_hits"] or 0) / max(total, 1), 4),
            "tp2_hit_rate": round((overall["tp2_hits"] or 0) / max(total, 1), 4),
            "tp3_hit_rate": round((overall["tp3_hits"] or 0) / max(total, 1), 4),
        },
        "by_pair": by_pair,
        "by_regime": by_regime,
        "recent_signals": recent_signals,
        "model_version": model_ver["version"] if model_ver else None,
        "last_retrained": model_ver["trained_at"].isoformat() if model_ver and model_ver["trained_at"] else None,
    }


def _safe_val(v):
    """Convert numpy/pandas types to JSON-safe Python types."""
    if hasattr(v, "item"):
        return v.item()
    return v
