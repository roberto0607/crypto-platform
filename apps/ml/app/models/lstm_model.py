"""LSTM model for sequential price pattern recognition.

Learns temporal dependencies that tree-based models miss:
  "after 3 red candles with declining volume, a reversal is likely"

Architecture:
  Input: (batch, seq_len=50, n_features)
  -> LSTM(128, dropout=0.2)
  -> LSTM(64, dropout=0.2)
  -> FC(64 -> 32 -> 3)
  -> Softmax

Three-class output: BUY / NEUTRAL / SELL
"""

import json
import logging
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader

from app.models.gpu_utils import get_device, clear_gpu_memory

logger = logging.getLogger("ml.lstm")

SEQ_LEN = 50  # Number of candles per sequence


class SequenceDataset(Dataset):
    """Converts flat feature matrix into overlapping sequences."""

    def __init__(self, X: np.ndarray, y: np.ndarray, seq_len: int = SEQ_LEN):
        self.seq_len = seq_len
        self.sequences: list[torch.Tensor] = []
        self.labels: list[int] = []

        for i in range(len(X) - seq_len):
            seq = X[i : i + seq_len]
            label = y[i + seq_len - 1]  # Label for last candle in sequence
            self.sequences.append(torch.FloatTensor(seq))
            self.labels.append(int(label))

    def __len__(self) -> int:
        return len(self.sequences)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, int]:
        return self.sequences[idx], self.labels[idx]


class LSTMNet(nn.Module):
    """Two-layer LSTM with fully connected head."""

    def __init__(self, n_features: int, hidden1: int = 128, hidden2: int = 64,
                 dropout: float = 0.2, n_classes: int = 3):
        super().__init__()
        self.lstm1 = nn.LSTM(n_features, hidden1, batch_first=True, dropout=dropout)
        self.lstm2 = nn.LSTM(hidden1, hidden2, batch_first=True)
        self.dropout = nn.Dropout(dropout)
        self.fc = nn.Sequential(
            nn.Linear(hidden2, 32),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(32, n_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out, _ = self.lstm1(x)
        out, _ = self.lstm2(out)
        # Use only the last time step
        last = out[:, -1, :]
        last = self.dropout(last)
        return self.fc(last)


class LSTMModel:
    """LSTM wrapper matching XGBoostModel interface."""

    CLASS_NAMES = {0: "SELL", 1: "NEUTRAL", 2: "BUY"}

    def __init__(self, n_features: int | None = None, lr: float = 1e-3,
                 epochs: int = 50, batch_size: int = 32):
        self.n_features = n_features
        self.lr = lr
        self.epochs = epochs
        self.batch_size = batch_size
        self.device = get_device()
        self.net: LSTMNet | None = None
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
        """Train the LSTM on sequential data."""
        self.feature_names = feature_names or [f"f{i}" for i in range(X_train.shape[1])]
        self.n_features = X_train.shape[1]

        self.net = LSTMNet(self.n_features).to(self.device)
        optimizer = torch.optim.Adam(self.net.parameters(), lr=self.lr)
        criterion = nn.CrossEntropyLoss()

        # Normalize features
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
        patience, patience_counter = 10, 0
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

            avg_loss = total_loss / max(n_batches, 1)

            # Validation
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

        # Restore best weights
        if best_state is not None:
            self.net.load_state_dict(best_state)

        # Compute metrics
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
        """Predict on a single sample or batch (expects flat features, builds sequence internally)."""
        if self.net is None:
            raise RuntimeError("Model not trained")

        self.net.eval()
        X_norm = (X - self._mean) / self._std

        # If input is a single row or short batch, pad into a sequence
        if X_norm.ndim == 1:
            X_norm = X_norm.reshape(1, -1)

        if len(X_norm) < SEQ_LEN:
            # Pad with zeros at the beginning
            pad = np.zeros((SEQ_LEN - len(X_norm), X_norm.shape[1]))
            X_norm = np.vstack([pad, X_norm])

        # Use the last SEQ_LEN rows as a single sequence
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
        """Predict probabilities for a batch of sequences (used by ensemble)."""
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

    def get_feature_importance(self, top_n: int = 15) -> list[dict]:
        """LSTM doesn't have per-feature importance; return empty."""
        return []

    def save(self, path: str, version: str) -> None:
        """Save model weights + normalization params."""
        self.version = version
        model_path = Path(path)
        model_path.parent.mkdir(parents=True, exist_ok=True)

        state = {
            "net_state": self.net.state_dict() if self.net else None,
            "n_features": self.n_features,
            "mean": self._mean.tolist() if hasattr(self, "_mean") else None,
            "std": self._std.tolist() if hasattr(self, "_std") else None,
        }
        torch.save(state, str(model_path))

        meta = {
            "version": version,
            "model_type": "lstm",
            "feature_names": self.feature_names,
            "n_features": self.n_features,
        }
        Path(path).with_suffix(".meta.json").write_text(json.dumps(meta, indent=2))

    @classmethod
    def load(cls, path: str) -> "LSTMModel":
        """Load a saved LSTM model."""
        state = torch.load(path, map_location="cpu", weights_only=False)
        instance = cls(n_features=state["n_features"])
        instance.net = LSTMNet(state["n_features"]).to(instance.device)
        if state["net_state"]:
            instance.net.load_state_dict(state["net_state"])
        instance._mean = np.array(state["mean"]) if state["mean"] else np.zeros(state["n_features"])
        instance._std = np.array(state["std"]) if state["std"] else np.ones(state["n_features"])

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

    def _eval_loss(self, loader: DataLoader, criterion: nn.Module) -> float:
        self.net.eval()  # type: ignore
        total = 0.0
        n = 0
        with torch.no_grad():
            for seqs, labels in loader:
                seqs = seqs.to(self.device)
                labels = torch.LongTensor(labels).to(self.device)
                logits = self.net(seqs)  # type: ignore
                total += criterion(logits, labels).item()
                n += 1
        return total / max(n, 1)

    def _eval_accuracy(self, loader: DataLoader) -> float:
        self.net.eval()  # type: ignore
        correct = 0
        total = 0
        with torch.no_grad():
            for seqs, labels in loader:
                seqs = seqs.to(self.device)
                labels = torch.LongTensor(labels).to(self.device)
                logits = self.net(seqs)  # type: ignore
                preds = logits.argmax(dim=1)
                correct += (preds == labels).sum().item()
                total += len(labels)
        return correct / max(total, 1)
