"""
Audio Transcriber Configuration
Auto-detects GPU (CUDA or Apple MPS) and falls back to CPU.
"""
import os
import sys


def _detect_device() -> str:
    """Detect the best available device: cuda > mps > cpu.
    
    Falls back to checking nvidia-smi if torch reports no CUDA 
    (can happen with CUDA toolkit version mismatches).
    """
    explicit = os.getenv("WHISPER_DEVICE")
    if explicit and explicit != "auto":
        return explicit
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    # Fallback: check if nvidia-smi works (torch may not see CUDA due to version mismatch)
    try:
        import subprocess
        result = subprocess.run(["nvidia-smi"], capture_output=True, timeout=5)
        if result.returncode == 0:
            return "cuda"
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
        pass
    return "cpu"


def _compute_type_for(device: str) -> str:
    """Pick optimal compute type for the device."""
    if device == "cuda":
        return "float16"
    if device == "mps":
        # MPS doesn't support float16 well in faster-whisper; int8 is safer
        return "int8"
    return "int8"


# Whisper model settings
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "medium")  # tiny, base, small, medium, large-v3
WHISPER_DEVICE = _detect_device()
WHISPER_COMPUTE_TYPE = _compute_type_for(WHISPER_DEVICE)
WHISPER_BEAM_SIZE = 5
WHISPER_LANGUAGE = None  # None = auto-detect, or "en", "es", etc.

# Pyannote settings
HF_TOKEN = os.getenv("HF_TOKEN", None)
DIARIZATION_MODEL = "pyannote/speaker-diarization-3.1"
MIN_SPEAKERS = None  # Set to help pyannote if you know speaker count
MAX_SPEAKERS = None

# Audio preprocessing
TARGET_SAMPLE_RATE = 16000
TARGET_CHANNELS = 1  # mono

# Output settings
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
OUTPUT_FORMATS = ["txt", "json"]  # txt, json, or both

# Supported audio formats
SUPPORTED_FORMATS = [".flac", ".wav", ".mp3", ".m4a", ".ogg", ".wma", ".aac"]
