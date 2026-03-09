"""Temporal Fusion Transformer with multi-horizon quantile forecasting.

Key advantages over LSTM:
  - Multi-head attention: learns WHICH past candles matter most
  - Variable selection: learns which features are most relevant
  - Multi-timeframe: natively handles different timeframe inputs
  - Interpretable: can explain WHY it made a prediction

Architecture:
  Input (batch, seq_len, n_features)
  -> Variable Selection Network (gated, per-feature)
  -> LSTM Encoder
  -> Multi-Head Attention (4 heads)
  -> Gated Residual Network
  -> Output head (mode-dependent):
       Classification: FC -> 3-class softmax
       Quantile:       FC -> 12 outputs (4 horizons x 3 quantiles)

Quantile mode predicts price returns at t+1, t+3, t+6, t+12 candles
with p10/p50/p90 confidence intervals. Direction and confidence are
derived from the quantile output so the ensemble interface stays
compatible.
"""

import json
import logging
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader

from app.models.gpu_utils import get_device, clear_gpu_memory
from app.models.lstm_model import SequenceDataset, SEQ_LEN

logger = logging.getLogger("ml.tft")

# Multi-horizon quantile constants
FORECAST_HORIZONS = [1, 3, 6, 12]
QUANTILES = [0.1, 0.5, 0.9]
N_QUANTILE_OUTPUTS = len(FORECAST_HORIZONS) * len(QUANTILES)  # 12


class QuantileLoss(nn.Module):
    """Pinball loss for quantile regression.

    L = max(q * (y - y_hat), (q - 1) * (y - y_hat))

    Averaged across all horizons and quantiles.
    """

    def __init__(self, quantiles: list[float] | None = None):
        super().__init__()
        self.quantiles = quantiles or QUANTILES

    def forward(self, pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        """
        Args:
            pred: (batch, n_horizons, n_quantiles)
            target: (batch, n_horizons)
        """
        # Expand target for broadcasting: (batch, n_horizons, 1)
        target = target.unsqueeze(-1)
        errors = target - pred  # (batch, n_horizons, n_quantiles)

        q = torch.tensor(self.quantiles, device=pred.device, dtype=pred.dtype)
        # q shape: (n_quantiles,) -> broadcast with errors
        losses = torch.max(q * errors, (q - 1.0) * errors)
        return losses.mean()


class MultiHorizonSequenceDataset(Dataset):
    """Converts flat feature matrix into overlapping sequences with multi-horizon labels."""

    def __init__(self, X: np.ndarray, y: np.ndarray, seq_len: int = SEQ_LEN):
        """
        Args:
            X: (n_samples, n_features) normalized feature matrix
            y: (n_samples, n_horizons) forward return percentages
        """
        self.sequences: list[torch.Tensor] = []
        self.labels: list[torch.Tensor] = []

        for i in range(len(X) - seq_len):
            label_idx = i + seq_len - 1
            # Skip rows where any horizon is NaN
            if np.any(np.isnan(y[label_idx])):
                continue
            seq = X[i : i + seq_len]
            self.sequences.append(torch.FloatTensor(seq))
            self.labels.append(torch.FloatTensor(y[label_idx]))

    def __len__(self) -> int:
        return len(self.sequences)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor]:
        return self.sequences[idx], self.labels[idx]


class GatedResidualNetwork(nn.Module):
    """GRN: applies non-linear processing with a gating mechanism."""

    def __init__(self, d_model: int, dropout: float = 0.1):
        super().__init__()
        self.fc1 = nn.Linear(d_model, d_model)
        self.elu = nn.ELU()
        self.fc2 = nn.Linear(d_model, d_model)
        self.gate = nn.Linear(d_model, d_model)
        self.sigmoid = nn.Sigmoid()
        self.dropout = nn.Dropout(dropout)
        self.layer_norm = nn.LayerNorm(d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        h = self.elu(self.fc1(x))
        h = self.dropout(self.fc2(h))
        gate = self.sigmoid(self.gate(x))
        return self.layer_norm(residual + gate * h)


class VariableSelectionNetwork(nn.Module):
    """Learns per-feature importance weights via softmax gating."""

    def __init__(self, n_features: int, d_model: int, dropout: float = 0.1):
        super().__init__()
        self.feature_proj = nn.Linear(n_features, d_model)
        self.gate_weights = nn.Linear(n_features, n_features)
        self.softmax = nn.Softmax(dim=-1)
        self.grn = GatedResidualNetwork(d_model, dropout)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        # x: (batch, seq_len, n_features)
        weights = self.softmax(self.gate_weights(x))  # (batch, seq_len, n_features)
        selected = x * weights  # Element-wise feature gating
        projected = self.feature_proj(selected)  # (batch, seq_len, d_model)
        output = self.grn(projected)
        return output, weights.mean(dim=1).mean(dim=0)  # Return avg weights for interpretability


class TFTNet(nn.Module):
    """Simplified Temporal Fusion Transformer with dual output modes."""

    def __init__(self, n_features: int, d_model: int = 64, n_heads: int = 4,
                 lstm_hidden: int = 64, dropout: float = 0.1,
                 mode: str = "classification"):
        super().__init__()
        self.mode = mode
        self.vsn = VariableSelectionNetwork(n_features, d_model, dropout)
        self.encoder = nn.LSTM(d_model, lstm_hidden, batch_first=True, dropout=dropout, num_layers=2)
        self.attention = nn.MultiheadAttention(lstm_hidden, n_heads, dropout=dropout, batch_first=True)
        self.grn_post = GatedResidualNetwork(lstm_hidden, dropout)

        if mode == "quantile":
            self.fc_out = nn.Sequential(
                nn.Linear(lstm_hidden, 32),
                nn.ReLU(),
                nn.Dropout(dropout),
                nn.Linear(32, N_QUANTILE_OUTPUTS),
            )
        else:
            self.fc_out = nn.Sequential(
                nn.Linear(lstm_hidden, 32),
                nn.ReLU(),
                nn.Dropout(dropout),
                nn.Linear(32, 3),
            )

        self._attn_weights: torch.Tensor | None = None

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # Variable selection
        selected, _ = self.vsn(x)  # (batch, seq, d_model)

        # LSTM encoding
        encoded, _ = self.encoder(selected)  # (batch, seq, lstm_hidden)

        # Multi-head self-attention
        attn_out, attn_w = self.attention(encoded, encoded, encoded)
        self._attn_weights = attn_w.detach()

        # Gated residual
        fused = self.grn_post(attn_out[:, -1, :])  # Last time step

        out = self.fc_out(fused)

        # Reshape quantile output: (batch, 12) -> (batch, n_horizons, n_quantiles)
        if self.mode == "quantile":
            out = out.view(-1, len(FORECAST_HORIZONS), len(QUANTILES))

        return out


class TFTModel:
    """TFT wrapper matching XGBoostModel interface with quantile forecasting."""

    CLASS_NAMES = {0: "SELL", 1: "NEUTRAL", 2: "BUY"}

    def __init__(self, n_features: int | None = None, lr: float = 5e-4,
                 epochs: int = 60, batch_size: int = 32):
        self.n_features = n_features
        self.lr = lr
        self.epochs = epochs
        self.batch_size = batch_size
        self.device = get_device()
        self.net: TFTNet | None = None
        self.feature_names: list[str] = []
        self.version: str = ""
        self._feature_weights: np.ndarray | None = None
        self._mode: str = "classification"
        self._mean: np.ndarray = np.array([])
        self._std: np.ndarray = np.array([])

    def train(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
        feature_names: list[str] | None = None,
    ) -> dict:
        """Train the TFT on sequential data.

        Dual mode:
          - If y_train is 1D (class labels): classification mode (CrossEntropy)
          - If y_train is 2D (horizon returns): quantile mode (QuantileLoss)
        """
        self.feature_names = feature_names or [f"f{i}" for i in range(X_train.shape[1])]
        self.n_features = X_train.shape[1]

        # Detect mode from label shape
        self._mode = "quantile" if y_train.ndim == 2 else "classification"

        self.net = TFTNet(self.n_features, mode=self._mode).to(self.device)
        optimizer = torch.optim.Adam(self.net.parameters(), lr=self.lr)
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=self.epochs)

        if self._mode == "quantile":
            criterion = QuantileLoss()
        else:
            criterion = nn.CrossEntropyLoss()

        # Normalize
        self._mean = X_train.mean(axis=0)
        self._std = X_train.std(axis=0) + 1e-8
        X_train_norm = (X_train - self._mean) / self._std

        if self._mode == "quantile":
            train_ds = MultiHorizonSequenceDataset(X_train_norm, y_train)
        else:
            train_ds = SequenceDataset(X_train_norm, y_train)
        train_loader = DataLoader(train_ds, batch_size=self.batch_size, shuffle=True)

        val_loader = None
        if X_val is not None and y_val is not None:
            X_val_norm = (X_val - self._mean) / self._std
            if self._mode == "quantile":
                val_ds = MultiHorizonSequenceDataset(X_val_norm, y_val)
            else:
                val_ds = SequenceDataset(X_val_norm, y_val)
            if len(val_ds) > 0:
                val_loader = DataLoader(val_ds, batch_size=self.batch_size)

        best_val_loss = float("inf")
        patience, patience_counter = 12, 0
        best_state = None

        for epoch in range(self.epochs):
            self.net.train()
            total_loss = 0.0
            n_batches = 0

            for seqs, labels in train_loader:
                seqs = seqs.to(self.device)
                if self._mode == "quantile":
                    labels = labels.to(self.device)  # Already float tensors
                else:
                    labels = torch.LongTensor(labels).to(self.device)

                optimizer.zero_grad()
                output = self.net(seqs)
                loss = criterion(output, labels)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(self.net.parameters(), 1.0)
                optimizer.step()

                total_loss += loss.item()
                n_batches += 1

            scheduler.step()
            avg_loss = total_loss / max(n_batches, 1)

            if val_loader and len(val_loader) > 0:
                val_loss = self._eval_loss(val_loader, criterion)
                if val_loss < best_val_loss:
                    best_val_loss = val_loss
                    patience_counter = 0
                    best_state = {k: v.cpu().clone() for k, v in self.net.state_dict().items()}
                else:
                    patience_counter += 1
                    if patience_counter >= patience:
                        logger.info(f"Early stopping at epoch {epoch + 1}")
                        break

            if (epoch + 1) % 10 == 0:
                logger.info(f"Epoch {epoch + 1}/{self.epochs} — loss={avg_loss:.4f}")

        if best_state is not None:
            self.net.load_state_dict(best_state)

        # Extract feature importance from VSN
        self._extract_feature_weights()

        self.net.eval()
        metrics: dict = {"n_samples": len(X_train), "mode": self._mode}

        if self._mode == "classification":
            train_acc = self._eval_accuracy(train_loader)
            metrics["train_accuracy"] = round(train_acc, 4)
            if val_loader and len(val_loader) > 0:
                val_acc = self._eval_accuracy(val_loader)
                metrics["val_accuracy"] = round(val_acc, 4)
                metrics["n_val_samples"] = len(X_val) if X_val is not None else 0
        else:
            # Quantile calibration metrics
            metrics["train_quantile_loss"] = round(avg_loss, 6)
            if val_loader and len(val_loader) > 0:
                metrics["val_quantile_loss"] = round(best_val_loss, 6)
                metrics["n_val_samples"] = len(X_val) if X_val is not None else 0
                # Evaluate directional accuracy from quantile predictions
                dir_acc = self._eval_quantile_direction_accuracy(val_loader)
                metrics["val_direction_accuracy"] = round(dir_acc, 4)

        clear_gpu_memory()
        return metrics

    def predict(self, X: np.ndarray) -> dict:
        """Predict on a single sample (same interface as XGBoostModel).

        In quantile mode, returns direction/confidence/probabilities derived
        from the forecast, plus a 'forecast' key with horizon predictions.
        """
        if self.net is None:
            raise RuntimeError("Model not trained")

        self.net.eval()
        X_norm = (X - self._mean) / self._std

        if X_norm.ndim == 1:
            X_norm = X_norm.reshape(1, -1)

        if len(X_norm) < SEQ_LEN:
            pad = np.zeros((SEQ_LEN - len(X_norm), X_norm.shape[1]))
            X_norm = np.vstack([pad, X_norm])

        seq = torch.FloatTensor(X_norm[-SEQ_LEN:]).unsqueeze(0).to(self.device)

        with torch.no_grad():
            output = self.net(seq)

        if self._mode == "quantile":
            return self._predict_quantile(output)
        else:
            return self._predict_classification(output)

    def _predict_classification(self, output: torch.Tensor) -> dict:
        """Classification mode: 3-class softmax."""
        probs = torch.softmax(output, dim=1).cpu().numpy()[0]
        class_idx = int(np.argmax(probs))
        return {
            "direction": self.CLASS_NAMES[class_idx],
            "confidence": round(float(probs[class_idx]) * 100, 1),
            "probabilities": {
                "SELL": round(float(probs[0]) * 100, 1),
                "NEUTRAL": round(float(probs[1]) * 100, 1),
                "BUY": round(float(probs[2]) * 100, 1),
            },
        }

    def _predict_quantile(self, output: torch.Tensor) -> dict:
        """Quantile mode: derive direction/confidence from forecast, include forecast."""
        # output: (1, n_horizons, n_quantiles)
        quantiles = output.cpu().numpy()[0]  # (n_horizons, n_quantiles)

        # Build forecast dict
        forecast: dict[str, dict[str, float]] = {}
        for i, h in enumerate(FORECAST_HORIZONS):
            forecast[f"t+{h}"] = {
                "p10": round(float(quantiles[i, 0]), 6),
                "p50": round(float(quantiles[i, 1]), 6),
                "p90": round(float(quantiles[i, 2]), 6),
            }

        # Derive direction from t+1 median (p50)
        p50_t1 = quantiles[0, 1]
        if p50_t1 > 0.001:
            direction = "BUY"
        elif p50_t1 < -0.001:
            direction = "SELL"
        else:
            direction = "NEUTRAL"

        # Derive confidence from inverse of p10-p90 spread at t+1
        spread_t1 = quantiles[0, 2] - quantiles[0, 0]  # p90 - p10
        # Map spread to confidence: narrower spread = higher confidence
        # Typical spread range: 0.005 (very narrow, ~95%) to 0.10 (wide, ~30%)
        raw_conf = max(0.0, 1.0 - spread_t1 * 10.0)
        confidence = round(min(99.0, max(20.0, raw_conf * 100.0)), 1)

        # Convert to probability-like format for ensemble compatibility
        if direction == "BUY":
            buy_p = confidence
            sell_p = round(max(0.0, 100.0 - confidence) * 0.3, 1)
            neutral_p = round(100.0 - buy_p - sell_p, 1)
        elif direction == "SELL":
            sell_p = confidence
            buy_p = round(max(0.0, 100.0 - confidence) * 0.3, 1)
            neutral_p = round(100.0 - sell_p - buy_p, 1)
        else:
            neutral_p = confidence
            buy_p = round((100.0 - confidence) / 2.0, 1)
            sell_p = round(100.0 - neutral_p - buy_p, 1)

        return {
            "direction": direction,
            "confidence": confidence,
            "probabilities": {
                "SELL": sell_p,
                "NEUTRAL": neutral_p,
                "BUY": buy_p,
            },
            "forecast": forecast,
        }

    def predict_proba_batch(self, X: np.ndarray) -> np.ndarray:
        """Batch prediction returning probability arrays (for ensemble)."""
        if self.net is None:
            raise RuntimeError("Model not trained")

        self.net.eval()
        X_norm = (X - self._mean) / self._std

        all_probs = []
        for i in range(SEQ_LEN, len(X_norm) + 1):
            seq = torch.FloatTensor(X_norm[i - SEQ_LEN : i]).unsqueeze(0).to(self.device)
            with torch.no_grad():
                output = self.net(seq)

            if self._mode == "quantile":
                # Derive probabilities from quantile output
                result = self._predict_quantile(output)
                probs = np.array([
                    result["probabilities"]["SELL"] / 100.0,
                    result["probabilities"]["NEUTRAL"] / 100.0,
                    result["probabilities"]["BUY"] / 100.0,
                ])
            else:
                probs = torch.softmax(output, dim=1).cpu().numpy()[0]
            all_probs.append(probs)

        return np.array(all_probs) if all_probs else np.array([]).reshape(0, 3)

    def get_attention_explanation(self, X: np.ndarray) -> dict:
        """Extract attention weights and feature importance for the latest prediction."""
        if self.net is None:
            return {"temporal_attention": [], "feature_importance": []}

        self.net.eval()
        X_norm = (X - self._mean) / self._std
        if X_norm.ndim == 1:
            X_norm = X_norm.reshape(1, -1)
        if len(X_norm) < SEQ_LEN:
            pad = np.zeros((SEQ_LEN - len(X_norm), X_norm.shape[1]))
            X_norm = np.vstack([pad, X_norm])

        seq = torch.FloatTensor(X_norm[-SEQ_LEN:]).unsqueeze(0).to(self.device)

        with torch.no_grad():
            self.net(seq)

        # Temporal attention: which past candles the model focused on
        temporal = []
        if self.net._attn_weights is not None:
            attn_w = self.net._attn_weights.cpu().numpy()[0]  # (seq_len, seq_len)
            # Last row = attention from the final time step to all others
            last_attn = attn_w[-1] if attn_w.ndim == 2 else attn_w.mean(axis=0)[-1] if attn_w.ndim == 3 else []
            if len(last_attn) > 0:
                top_indices = np.argsort(last_attn)[::-1][:5]
                for idx in top_indices:
                    temporal.append({
                        "candle_ago": int(SEQ_LEN - 1 - idx),
                        "weight": round(float(last_attn[idx]), 4),
                    })

        # Feature importance from VSN
        feat_imp = []
        if self._feature_weights is not None:
            top_f = np.argsort(self._feature_weights)[::-1][:10]
            for idx in top_f:
                name = self.feature_names[idx] if idx < len(self.feature_names) else f"f{idx}"
                feat_imp.append({
                    "feature": name,
                    "weight": round(float(self._feature_weights[idx]), 4),
                })

        return {"temporal_attention": temporal, "feature_importance": feat_imp}

    def get_feature_importance(self, top_n: int = 15) -> list[dict]:
        """Return VSN-derived feature importance."""
        if self._feature_weights is None:
            return []
        indices = np.argsort(self._feature_weights)[::-1][:top_n]
        return [
            {
                "rank": i + 1,
                "feature": self.feature_names[idx] if idx < len(self.feature_names) else f"f{idx}",
                "importance": round(float(self._feature_weights[idx]), 4),
            }
            for i, idx in enumerate(indices)
        ]

    def save(self, path: str, version: str) -> None:
        self.version = version
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        state = {
            "net_state": self.net.state_dict() if self.net else None,
            "n_features": self.n_features,
            "mean": self._mean.tolist() if hasattr(self, "_mean") and len(self._mean) > 0 else None,
            "std": self._std.tolist() if hasattr(self, "_std") and len(self._std) > 0 else None,
            "feature_weights": self._feature_weights.tolist() if self._feature_weights is not None else None,
            "mode": self._mode,
        }
        torch.save(state, str(path))
        meta = {
            "version": version,
            "model_type": "tft",
            "mode": self._mode,
            "feature_names": self.feature_names,
            "n_features": self.n_features,
            "forecast_horizons": FORECAST_HORIZONS if self._mode == "quantile" else None,
            "quantiles": QUANTILES if self._mode == "quantile" else None,
        }
        Path(path).with_suffix(".meta.json").write_text(json.dumps(meta, indent=2))

    @classmethod
    def load(cls, path: str) -> "TFTModel":
        state = torch.load(path, map_location="cpu", weights_only=False)
        mode = state.get("mode", "classification")
        instance = cls(n_features=state["n_features"])
        instance._mode = mode
        instance.net = TFTNet(state["n_features"], mode=mode).to(instance.device)
        if state["net_state"]:
            instance.net.load_state_dict(state["net_state"])
        instance._mean = np.array(state["mean"]) if state["mean"] else np.zeros(state["n_features"])
        instance._std = np.array(state["std"]) if state["std"] else np.ones(state["n_features"])
        instance._feature_weights = np.array(state["feature_weights"]) if state.get("feature_weights") else None

        meta_path = Path(path).with_suffix(".meta.json")
        if meta_path.exists():
            meta = json.loads(meta_path.read_text())
            instance.feature_names = meta.get("feature_names", [])
            instance.version = meta.get("version", "unknown")
        else:
            instance.feature_names = []
            instance.version = "unknown"

        instance.net.eval()
        return instance

    def _extract_feature_weights(self) -> None:
        """Extract learned feature importance from Variable Selection Network."""
        if self.net is None:
            return
        try:
            w = self.net.vsn.gate_weights.weight.data.cpu().numpy()
            self._feature_weights = np.abs(w).mean(axis=0)
        except Exception:
            self._feature_weights = None

    def _eval_loss(self, loader: DataLoader, criterion: nn.Module) -> float:
        self.net.eval()  # type: ignore
        total = 0.0
        n = 0
        with torch.no_grad():
            for seqs, labels in loader:
                seqs = seqs.to(self.device)
                if self._mode == "quantile":
                    labels = labels.to(self.device)
                else:
                    labels = torch.LongTensor(labels).to(self.device)
                total += criterion(self.net(seqs), labels).item()  # type: ignore
                n += 1
        return total / max(n, 1)

    def _eval_accuracy(self, loader: DataLoader) -> float:
        """Classification accuracy (only for classification mode)."""
        self.net.eval()  # type: ignore
        correct = total = 0
        with torch.no_grad():
            for seqs, labels in loader:
                seqs = seqs.to(self.device)
                labels = torch.LongTensor(labels).to(self.device)
                preds = self.net(seqs).argmax(dim=1)  # type: ignore
                correct += (preds == labels).sum().item()
                total += len(labels)
        return correct / max(total, 1)

    def _eval_quantile_direction_accuracy(self, loader: DataLoader) -> float:
        """Evaluate directional accuracy from quantile predictions on validation set."""
        self.net.eval()  # type: ignore
        correct = total = 0
        with torch.no_grad():
            for seqs, labels in loader:
                seqs = seqs.to(self.device)
                labels = labels.to(self.device)  # (batch, n_horizons)
                output = self.net(seqs)  # (batch, n_horizons, n_quantiles)

                # Compare t+1 p50 direction vs actual t+1 return direction
                pred_dir = torch.sign(output[:, 0, 1])  # p50 at t+1
                actual_dir = torch.sign(labels[:, 0])    # actual t+1 return

                # Count where both agree on direction (or both near zero)
                correct += (pred_dir == actual_dir).sum().item()
                total += len(labels)
        return correct / max(total, 1)
