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
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse


class NumpyEncoder(json.JSONEncoder):
    """JSON encoder that handles numpy types."""
    def default(self, obj):
        if isinstance(obj, (np.integer,)):
            return int(obj)
        if isinstance(obj, (np.floating,)):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)

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
from app.models.regime_classifier import RegimeClassifier, REGIME_PARAMS
from app.models.explainer import generate_explanation
from app.models.target_predictor import TargetPredictor
from app.models.pattern_detector import scan_patterns, adjust_with_cnn, pattern_to_dict
from app.models.scenario_engine import generate_scenarios, scenarios_to_dict
from app.models.seasonality import SeasonalityModel
from app.training.alerts import AlertChecker, format_alerts

logger = logging.getLogger("ml")

# Loaded models
_model: XGBoostModel | None = None
_ensemble: EnsembleModel | None = None
_target_predictor: TargetPredictor | None = None
_regime_classifier: RegimeClassifier | None = None
_seasonality_models: dict[str, SeasonalityModel] = {}  # symbol → model


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model, _ensemble, _target_predictor
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

    # Try loading target predictor (learned TP/SL zones)
    target_path = model_dir / "target_latest.joblib"
    if target_path.exists():
        try:
            _target_predictor = TargetPredictor.load(str(target_path))
            logger.info(f"Target predictor loaded: {_target_predictor.version}")
        except Exception as e:
            logger.warning(f"Failed to load target predictor: {e}")

    # Try loading trained regime classifier (Phase 22 PR2)
    regime_path = model_dir / "regime_classifier_latest.joblib"
    if regime_path.exists():
        try:
            _regime_classifier = RegimeClassifier.load(str(regime_path))
            logger.info(f"Regime classifier loaded: {_regime_classifier.version}")
            # Attach to ensemble if available
            if _ensemble:
                _ensemble.regime_classifier = _regime_classifier
        except Exception as e:
            logger.warning(f"Failed to load regime classifier: {e}")
    else:
        logger.info("No trained regime classifier found — using heuristic detector")

    # Load seasonality models for all pairs
    for path in model_dir.glob("*_seasonality.json"):
        try:
            sm = SeasonalityModel.load(str(path))
            symbol = path.stem.replace("_seasonality", "").replace("_", "/")
            _seasonality_models[symbol] = sm
            logger.info(f"Seasonality loaded for {symbol}: {len(sm.profiles)} buckets")
        except Exception as e:
            logger.warning(f"Failed to load seasonality {path}: {e}")

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
        "target_predictor": _target_predictor is not None,
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

    # Predict learned TP/SL zones if target predictor is available
    learned_zones = None
    if _target_predictor:
        try:
            learned_zones = _target_predictor.predict_zones(
                X[0], current_price, prediction["direction"]
            )
        except Exception as e:
            logger.warning(f"Target predictor failed, falling back to ATR: {e}")

    # Extract TFT forecast from ensemble prediction (quantile mode)
    tft_forecast = prediction.get("tft_forecast")

    signal = generate_signal(
        prediction=prediction,
        current_price=current_price,
        atr=atr,
        min_confidence=effective_min_conf,
        top_features=top_features,
        model_version=model_version,
        learned_zones=learned_zones,
        tft_forecast=tft_forecast,
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

    # Generate explanation
    explanation = generate_explanation(
        prediction=prediction,
        top_features=top_features,
        regime=regime_info,
        contributions=model_contributions,
        attention=attention,
    )

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
        "explanation": explanation,
    }

    if learned_zones:
        response["learned_zones"] = learned_zones
    if regime_info:
        response["regime"] = regime_info
    if model_contributions:
        response["model_contributions"] = model_contributions
    if attention:
        response["attention"] = attention
    if tft_forecast:
        response["forecast"] = tft_forecast

    # Scan for chart patterns
    try:
        df_times = df["ts"].values[-100:].astype(np.int64) // 10**9  # datetime64 → epoch seconds
        df_highs = df["high"].values[-100:].astype(np.float64)
        df_lows = df["low"].values[-100:].astype(np.float64)
        df_closes = df["close"].values[-100:].astype(np.float64)

        detected = scan_patterns(df_highs, df_lows, df_closes, df_times, atr, lookback=100)

        # Adjust with CNN if available
        if detected and _ensemble and _ensemble.cnn:
            cnn_dir = prediction["direction"]
            cnn_conf = prediction["confidence"]
            detected = [adjust_with_cnn(p, cnn_dir, cnn_conf) for p in detected]
            detected.sort(key=lambda p: p.completion_prob, reverse=True)

        if detected:
            response["patterns"] = [pattern_to_dict(p) for p in detected[:3]]
    except Exception as e:
        logger.warning(f"Pattern detection failed: {e}")

    # Serialize with numpy-safe encoder
    return JSONResponse(content=json.loads(json.dumps(response, cls=NumpyEncoder)))


@app.get("/predict/{symbol}/scenarios")
async def predict_scenarios(symbol: str, timeframe: str = "1h", limit: int = 300):
    """Generate 3 AI scenario paths (bull/base/bear) with ghost candles."""
    from datetime import datetime as dt, timezone as tz

    if _ensemble is None and _model is None:
        raise HTTPException(status_code=503, detail="No trained model available")

    db_symbol = symbol.replace("-", "/")
    pair_id = await fetch_pair_id(db_symbol)
    if not pair_id:
        raise HTTPException(status_code=404, detail=f"Pair {db_symbol} not found")

    df = await build_feature_matrix(pair_id, timeframe, limit)
    if df.empty:
        raise HTTPException(status_code=400, detail="Not enough candle data")

    # Get feature columns for prediction
    if _ensemble and _ensemble.xgboost:
        feature_cols = _ensemble.xgboost.feature_names
    elif _model:
        feature_cols = _model.feature_names
    else:
        feature_cols = get_feature_columns(df)

    available_cols = set(df.columns)
    missing = [c for c in feature_cols if c not in available_cols]
    if missing:
        raise HTTPException(status_code=500, detail=f"Feature mismatch: {missing}")

    latest = df.iloc[-1]
    X = latest[feature_cols].values.astype(np.float64).reshape(1, -1)
    current_price = float(latest["close"])
    atr = float(latest["atr_14"]) if "atr_14" in df.columns else current_price * 0.002

    # Run ensemble prediction
    prediction = None
    if _ensemble and _ensemble.available_models:
        prediction = _ensemble.predict(X, df=df)
    elif _model:
        prediction = _model.predict(X)

    if prediction is None:
        raise HTTPException(status_code=503, detail="Prediction failed")

    # Extract inputs for scenario engine
    ensemble_direction = prediction.get("direction", "NEUTRAL")
    ensemble_confidence = prediction.get("confidence", 50)
    tft_forecast = prediction.get("tft_forecast")
    regime_info = prediction.get("regime")
    regime = regime_info.get("regime") if regime_info else None
    regime_confidence = regime_info.get("confidence", 0) if regime_info else 0

    # Get or create seasonality model
    seasonality = _seasonality_models.get(db_symbol)
    if seasonality is None:
        seasonality = SeasonalityModel()
        # Train on the fly from available data
        try:
            seas_df = df[["ts", "open", "high", "low", "close", "volume"]].copy()
            seas_df.columns = ["ts", "open", "high", "low", "close", "volume"]
            seasonality.train(seas_df)
        except Exception as e:
            logger.warning(f"On-the-fly seasonality training failed: {e}")

    # Get last candle timestamp
    last_ts = df["ts"].iloc[-1]
    if hasattr(last_ts, "to_pydatetime"):
        current_time = last_ts.to_pydatetime()
    else:
        current_time = dt.now(tz.utc)

    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=tz.utc)

    scenarios = generate_scenarios(
        current_price=current_price,
        current_time=current_time,
        timeframe=timeframe,
        tft_forecast=tft_forecast,
        regime=regime,
        regime_confidence=regime_confidence,
        ensemble_direction=ensemble_direction,
        ensemble_confidence=ensemble_confidence,
        seasonality=seasonality,
        atr_14=atr,
    )

    response = {
        "pair": db_symbol,
        "timeframe": timeframe,
        "currentPrice": current_price,
        "generatedAt": dt.now(tz.utc).isoformat(),
        "scenarios": scenarios_to_dict(scenarios),
        "inputs": {
            "regime": regime,
            "ensembleDirection": ensemble_direction,
            "ensembleConfidence": ensemble_confidence,
            "tftForecastAvailable": tft_forecast is not None,
        },
    }

    return JSONResponse(content=json.loads(json.dumps(response, cls=NumpyEncoder)))


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

    # Use trained classifier if available, else heuristic
    if _regime_classifier is not None:
        result = _regime_classifier.predict(df)
        params = REGIME_PARAMS[result.regime]
        return {
            "pair": db_symbol,
            "timeframe": timeframe,
            "regime": result.regime.value,
            "confidence": result.confidence,
            "probabilities": result.probabilities,
            "should_trade": result.should_trade,
            "strategy": params["strategy"],
            "features_used": result.features_used,
            "classifier": "trained",
            "config": {
                "min_confidence": params["min_confidence"],
                "tp_multiplier": params["tp_multiplier"],
                "sl_multiplier": params["sl_multiplier"],
            },
        }

    regime, evidence = detect_regime(df)
    config = REGIME_CONFIGS[regime]

    return {
        "pair": db_symbol,
        "timeframe": timeframe,
        "regime": regime.value,
        "evidence": evidence,
        "classifier": "heuristic",
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

    info["regime_classifier"] = {
        "loaded": _regime_classifier is not None,
        "version": _regime_classifier.version if _regime_classifier else None,
        "type": "trained" if _regime_classifier else "heuristic",
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
