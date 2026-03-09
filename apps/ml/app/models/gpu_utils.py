"""GPU device detection and memory management.

Auto-detects the best available compute device:
  - NVIDIA GPU (CUDA)
  - Apple Silicon GPU (MPS)
  - CPU fallback
"""

import logging

import torch

logger = logging.getLogger("ml.gpu")


def get_device() -> torch.device:
    """Return the best available torch device."""
    if torch.cuda.is_available():
        dev = torch.device("cuda")
        name = torch.cuda.get_device_name(0)
        mem = torch.cuda.get_device_properties(0).total_mem / 1e9
        logger.info(f"Using CUDA: {name} ({mem:.1f} GB)")
        return dev

    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        logger.info("Using Apple Silicon MPS")
        return torch.device("mps")

    logger.info("Using CPU (no GPU detected)")
    return torch.device("cpu")


def clear_gpu_memory() -> None:
    """Release cached GPU memory."""
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()
