"""1D-CNN for chart pattern recognition.

Treats price sequences as 1D signals and applies convolutional filters
to detect patterns at different scales:
  - 5-candle patterns (e.g., engulfing, doji clusters)
  - 10-candle patterns (e.g., flags, pennants)
  - 15-candle patterns (e.g., head & shoulders, double tops)

Architecture:
  Input: (batch, channels=5, seq_len=100)  [OHLCV]
  -> Conv1D(64, k=5) -> BN -> ReLU -> MaxPool
  -> Conv1D(128, k=5) -> BN -> ReLU -> MaxPool
  -> Conv1D(256, k=5) -> BN -> ReLU
  -> Global Average Pooling
  -> FC(256 -> 64 -> n_patterns)

Also provides a feature vector for the ensemble meta-learner.
"""

import json
import logging
from pathlib import Path
from enum import Enum

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader

from app.models.gpu_utils import get_device, clear_gpu_memory

logger = logging.getLogger("ml.cnn")

CNN_SEQ_LEN = 100  # Longer sequences for pattern detection


class ChartPattern(Enum):
    """Recognized chart patterns."""
    NO_PATTERN = 0
    DOUBLE_BOTTOM = 1
    DOUBLE_TOP = 2
    BULL_FLAG = 3
    BEAR_FLAG = 4
    ASCENDING_TRIANGLE = 5
    DESCENDING_TRIANGLE = 6
    HEAD_SHOULDERS = 7
    RISING_WEDGE = 8
    FALLING_WEDGE = 9
    CUP_HANDLE = 10

    @classmethod
    def num_classes(cls) -> int:
        return len(cls)


class OHLCVDataset(Dataset):
    """Converts OHLCV DataFrame into (channels, seq_len) tensors."""

    def __init__(self, X_ohlcv: np.ndarray, y: np.ndarray, seq_len: int = CNN_SEQ_LEN):
        """
        Args:
            X_ohlcv: (n_samples, 5) OHLCV data — will be windowed
            y: labels (n_samples,)
        """
        self.seq_len = seq_len
        self.sequences: list[torch.Tensor] = []
        self.labels: list[int] = []

        for i in range(len(X_ohlcv) - seq_len):
            seq = X_ohlcv[i : i + seq_len].T  # (5, seq_len) — channels first
            label = y[i + seq_len - 1]
            self.sequences.append(torch.FloatTensor(seq))
            self.labels.append(int(label))

    def __len__(self) -> int:
        return len(self.sequences)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, int]:
        return self.sequences[idx], self.labels[idx]


class CNNNet(nn.Module):
    """1D-CNN for price pattern recognition."""

    def __init__(self, in_channels: int = 5, n_classes: int = 3):
        super().__init__()
        self.conv_blocks = nn.Sequential(
            # Block 1: detect 5-candle patterns
            nn.Conv1d(in_channels, 64, kernel_size=5, padding=2),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.MaxPool1d(2),

            # Block 2: detect 10-candle patterns
            nn.Conv1d(64, 128, kernel_size=5, padding=2),
            nn.BatchNorm1d(128),
            nn.ReLU(),
            nn.MaxPool1d(2),

            # Block 3: detect 15-candle patterns
            nn.Conv1d(128, 256, kernel_size=5, padding=2),
            nn.BatchNorm1d(256),
            nn.ReLU(),
        )
        self.gap = nn.AdaptiveAvgPool1d(1)  # Global average pooling
        self.fc = nn.Sequential(
            nn.Linear(256, 64),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(64, n_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        features = self.conv_blocks(x)
        pooled = self.gap(features).squeeze(-1)  # (batch, 256)
        return self.fc(pooled)

    def extract_features(self, x: torch.Tensor) -> torch.Tensor:
        """Return the 256-d feature vector before classification head."""
        features = self.conv_blocks(x)
        return self.gap(features).squeeze(-1)


class CNNModel:
    """CNN wrapper matching XGBoostModel interface."""

    CLASS_NAMES = {0: "SELL", 1: "NEUTRAL", 2: "BUY"}

    def __init__(self, lr: float = 1e-3, epochs: int = 40, batch_size: int = 32):
        self.lr = lr
        self.epochs = epochs
        self.batch_size = batch_size
        self.device = get_device()
        self.net: CNNNet | None = None
        self.feature_names: list[str] = []
        self.version: str = ""

    def train(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
        feature_names: list[str] | None = None,
        ohlcv_cols: list[int] | None = None,
    ) -> dict:
        """
        Train CNN on OHLCV sequences.

        Args:
            X_train: Full feature matrix (n, n_features). We extract OHLCV columns.
            y_train: Labels in XGBoost format (0, 1, 2).
            ohlcv_cols: Indices of [open, high, low, close, volume] in X.
                        If None, uses first 5 columns.
        """
        self.feature_names = feature_names or []
        cols = ohlcv_cols or list(range(5))

        # Extract and normalize OHLCV
        ohlcv_train = X_train[:, cols].copy()
        self._mean = ohlcv_train.mean(axis=0)
        self._std = ohlcv_train.std(axis=0) + 1e-8
        ohlcv_train = (ohlcv_train - self._mean) / self._std

        self.net = CNNNet(in_channels=len(cols), n_classes=3).to(self.device)
        optimizer = torch.optim.Adam(self.net.parameters(), lr=self.lr)
        criterion = nn.CrossEntropyLoss()

        train_ds = OHLCVDataset(ohlcv_train, y_train, CNN_SEQ_LEN)
        train_loader = DataLoader(train_ds, batch_size=self.batch_size, shuffle=True)

        val_loader = None
        if X_val is not None and y_val is not None:
            ohlcv_val = (X_val[:, cols] - self._mean) / self._std
            val_ds = OHLCVDataset(ohlcv_val, y_val, CNN_SEQ_LEN)
            if len(val_ds) > 0:
                val_loader = DataLoader(val_ds, batch_size=self.batch_size)

        best_val_loss = float("inf")
        patience, patience_counter = 8, 0
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

    def predict(self, X: np.ndarray, ohlcv_cols: list[int] | None = None) -> dict:
        """Predict direction from OHLCV features."""
        if self.net is None:
            raise RuntimeError("Model not trained")

        self.net.eval()
        cols = ohlcv_cols or list(range(5))

        if X.ndim == 1:
            X = X.reshape(1, -1)

        ohlcv = X[:, cols].copy()
        ohlcv = (ohlcv - self._mean) / self._std

        if len(ohlcv) < CNN_SEQ_LEN:
            pad = np.zeros((CNN_SEQ_LEN - len(ohlcv), len(cols)))
            ohlcv = np.vstack([pad, ohlcv])

        seq = torch.FloatTensor(ohlcv[-CNN_SEQ_LEN:].T).unsqueeze(0).to(self.device)

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

    def predict_proba_batch(self, X: np.ndarray, ohlcv_cols: list[int] | None = None) -> np.ndarray:
        """Batch probability prediction for ensemble."""
        if self.net is None:
            raise RuntimeError("Model not trained")

        self.net.eval()
        cols = ohlcv_cols or list(range(5))
        ohlcv = (X[:, cols] - self._mean) / self._std

        all_probs = []
        for i in range(CNN_SEQ_LEN, len(ohlcv) + 1):
            seq = torch.FloatTensor(ohlcv[i - CNN_SEQ_LEN : i].T).unsqueeze(0).to(self.device)
            with torch.no_grad():
                logits = self.net(seq)
                probs = torch.softmax(logits, dim=1).cpu().numpy()[0]
            all_probs.append(probs)

        return np.array(all_probs) if all_probs else np.array([]).reshape(0, 3)

    def get_feature_importance(self, top_n: int = 15) -> list[dict]:
        """CNN uses spatial filters, not per-feature importance."""
        return []

    def save(self, path: str, version: str) -> None:
        self.version = version
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        state = {
            "net_state": self.net.state_dict() if self.net else None,
            "mean": self._mean.tolist() if hasattr(self, "_mean") else None,
            "std": self._std.tolist() if hasattr(self, "_std") else None,
        }
        torch.save(state, str(path))
        meta = {
            "version": version,
            "model_type": "cnn",
            "feature_names": self.feature_names,
        }
        Path(path).with_suffix(".meta.json").write_text(json.dumps(meta, indent=2))

    @classmethod
    def load(cls, path: str) -> "CNNModel":
        state = torch.load(path, map_location="cpu", weights_only=False)
        instance = cls()
        instance.net = CNNNet().to(instance.device)
        if state["net_state"]:
            instance.net.load_state_dict(state["net_state"])
        instance._mean = np.array(state["mean"]) if state["mean"] else np.zeros(5)
        instance._std = np.array(state["std"]) if state["std"] else np.ones(5)

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
        total = n = 0.0
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
