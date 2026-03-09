"""Temporal Fusion Transformer for multi-timeframe prediction.

Key advantages over LSTM:
  - Multi-head attention: learns WHICH past candles matter most
  - Variable selection: learns which features are most relevant
  - Multi-timeframe: natively handles different timeframe inputs
  - Interpretable: can explain WHY it made a prediction

Architecture (simplified):
  Input (batch, seq_len, n_features)
  -> Variable Selection Network (gated, per-feature)
  -> LSTM Encoder
  -> Multi-Head Attention (4 heads)
  -> Gated Residual Network
  -> FC -> 3-class output
"""

import json
import logging
import math
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader

from app.models.gpu_utils import get_device, clear_gpu_memory
from app.models.lstm_model import SequenceDataset, SEQ_LEN

logger = logging.getLogger("ml.tft")


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
    """Simplified Temporal Fusion Transformer."""

    def __init__(self, n_features: int, d_model: int = 64, n_heads: int = 4,
                 lstm_hidden: int = 64, dropout: float = 0.1, n_classes: int = 3):
        super().__init__()
        self.vsn = VariableSelectionNetwork(n_features, d_model, dropout)
        self.encoder = nn.LSTM(d_model, lstm_hidden, batch_first=True, dropout=dropout, num_layers=2)
        self.attention = nn.MultiheadAttention(lstm_hidden, n_heads, dropout=dropout, batch_first=True)
        self.grn_post = GatedResidualNetwork(lstm_hidden, dropout)
        self.fc_out = nn.Sequential(
            nn.Linear(lstm_hidden, 32),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(32, n_classes),
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

        return self.fc_out(fused)


class TFTModel:
    """TFT wrapper matching XGBoostModel interface."""

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

    def train(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
        feature_names: list[str] | None = None,
    ) -> dict:
        """Train the TFT on sequential data."""
        self.feature_names = feature_names or [f"f{i}" for i in range(X_train.shape[1])]
        self.n_features = X_train.shape[1]

        self.net = TFTNet(self.n_features).to(self.device)
        optimizer = torch.optim.Adam(self.net.parameters(), lr=self.lr)
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=self.epochs)
        criterion = nn.CrossEntropyLoss()

        # Normalize
        self._mean = X_train.mean(axis=0)
        self._std = X_train.std(axis=0) + 1e-8
        X_train_norm = (X_train - self._mean) / self._std

        train_ds = SequenceDataset(X_train_norm, y_train)
        train_loader = DataLoader(train_ds, batch_size=self.batch_size, shuffle=True)

        val_loader = None
        if X_val is not None and y_val is not None:
            X_val_norm = (X_val - self._mean) / self._std
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
                labels = torch.LongTensor(labels).to(self.device)

                optimizer.zero_grad()
                logits = self.net(seqs)
                loss = criterion(logits, labels)
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
        metrics: dict = {"n_samples": len(X_train)}

        train_acc = self._eval_accuracy(train_loader)
        metrics["train_accuracy"] = round(train_acc, 4)

        if val_loader and len(val_loader) > 0:
            val_acc = self._eval_accuracy(val_loader)
            metrics["val_accuracy"] = round(val_acc, 4)
            metrics["n_val_samples"] = len(X_val) if X_val is not None else 0

        clear_gpu_memory()
        return metrics

    def predict(self, X: np.ndarray) -> dict:
        """Predict on a single sample (same interface as XGBoostModel)."""
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
            logits = self.net(seq)
            probs = torch.softmax(logits, dim=1).cpu().numpy()[0]

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
                logits = self.net(seq)
                probs = torch.softmax(logits, dim=1).cpu().numpy()[0]
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
            "mean": self._mean.tolist() if hasattr(self, "_mean") else None,
            "std": self._std.tolist() if hasattr(self, "_std") else None,
            "feature_weights": self._feature_weights.tolist() if self._feature_weights is not None else None,
        }
        torch.save(state, str(path))
        meta = {
            "version": version,
            "model_type": "tft",
            "feature_names": self.feature_names,
            "n_features": self.n_features,
        }
        Path(path).with_suffix(".meta.json").write_text(json.dumps(meta, indent=2))

    @classmethod
    def load(cls, path: str) -> "TFTModel":
        state = torch.load(path, map_location="cpu", weights_only=False)
        instance = cls(n_features=state["n_features"])
        instance.net = TFTNet(state["n_features"]).to(instance.device)
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
                labels = torch.LongTensor(labels).to(self.device)
                total += criterion(self.net(seqs), labels).item()  # type: ignore
                n += 1
        return total / max(n, 1)

    def _eval_accuracy(self, loader: DataLoader) -> float:
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
