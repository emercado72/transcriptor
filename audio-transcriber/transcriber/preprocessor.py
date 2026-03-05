"""
Step 1: Audio Preprocessing
Converts input audio to 16kHz mono WAV for optimal processing.
"""
import os
import tempfile
import subprocess
import shutil
import json
from pathlib import Path
from config import TARGET_SAMPLE_RATE, TARGET_CHANNELS, SUPPORTED_FORMATS


def check_ffmpeg():
    """Check if ffmpeg is installed and available."""
    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "ffmpeg is not installed or not in PATH.\n"
            "Install it with:\n"
            "  macOS:  brew install ffmpeg\n"
            "  Linux:  sudo apt install ffmpeg\n"
            "  Windows: choco install ffmpeg"
        )


def validate_audio_file(file_path: str) -> str:
    """Validate that the audio file exists and has a supported format."""
    path = Path(file_path)

    if not path.exists():
        raise FileNotFoundError(f"Audio file not found: {file_path}")

    if path.suffix.lower() not in SUPPORTED_FORMATS:
        raise ValueError(
            f"Unsupported audio format: {path.suffix}\n"
            f"Supported formats: {', '.join(SUPPORTED_FORMATS)}"
        )

    return str(path.resolve())


def get_audio_info(file_path: str) -> dict:
    """Get audio file info via ffprobe."""
    check_ffmpeg()
    try:
        cmd = [
            "ffprobe", "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            file_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return {}
        data = json.loads(result.stdout)
        for stream in data.get("streams", []):
            if stream.get("codec_type") == "audio":
                return {
                    "channels": int(stream.get("channels", 0)),
                    "sample_rate": int(stream.get("sample_rate", 0)),
                    "codec": stream.get("codec_name", ""),
                    "duration": float(stream.get("duration", 0)),
                }
    except Exception:
        pass
    return {}


def needs_preprocessing(file_path: str) -> bool:
    """
    Check if the audio file needs preprocessing.

    Files that are already mono, 16kHz (or close), and in a format
    that Whisper/Pyannote can read directly (WAV, FLAC) don't need
    conversion. This avoids a redundant ffmpeg step when Chucho
    has already preprocessed the audio.
    """
    path = Path(file_path)
    ext = path.suffix.lower()

    # WAV and FLAC are directly readable by both Whisper and Pyannote
    if ext not in (".wav", ".flac"):
        return True

    info = get_audio_info(file_path)
    if not info:
        return True  # Can't determine, preprocess to be safe

    # Already mono?
    if info.get("channels", 0) != 1:
        return True

    # Sample rate close enough? Whisper handles resampling internally
    sr = info.get("sample_rate", 0)
    if sr < 8000:
        return True

    print(f"[Preprocessing] File is already {ext.upper()}, mono, {sr}Hz — skipping conversion")
    return False


def preprocess_audio(file_path: str) -> str:
    """
    Convert audio file to 16kHz mono WAV.

    Args:
        file_path: Path to the input audio file.

    Returns:
        Path to the preprocessed WAV file (temp file).
    """
    check_ffmpeg()
    file_path = validate_audio_file(file_path)

    # Create temp file for preprocessed audio
    temp_fd, temp_path = tempfile.mkstemp(suffix=".wav")
    os.close(temp_fd)

    print(f"[Preprocessing] Converting audio to {TARGET_SAMPLE_RATE}Hz mono WAV...")
    import sys; sys.stdout.flush()

    try:
        cmd = [
            "ffmpeg", "-y",
            "-i", file_path,
            "-ar", str(TARGET_SAMPLE_RATE),
            "-ac", str(TARGET_CHANNELS),
            "-acodec", "pcm_s16le",
            temp_path
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,  # 10 min timeout
        )

        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg conversion failed:\n{result.stderr}")

        print(f"[Preprocessing] Done. Temp file: {temp_path}")
        return temp_path

    except subprocess.TimeoutExpired:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise RuntimeError("ffmpeg conversion timed out after 10 minutes")
    except Exception as e:
        # Clean up temp file on error
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise e


def cleanup_temp_file(temp_path: str):
    """Remove the temporary preprocessed audio file."""
    if temp_path and os.path.exists(temp_path):
        os.remove(temp_path)
        print(f"[Preprocessing] Cleaned up temp file: {temp_path}")
