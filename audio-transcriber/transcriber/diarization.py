"""
Step 3: Speaker Diarization with Pyannote
Identifies who spoke when.
"""
import os
import sys
import time
from pyannote.audio import Pipeline
from config import HF_TOKEN, DIARIZATION_MODEL, MIN_SPEAKERS, MAX_SPEAKERS


def check_hf_token():
    """Verify Hugging Face token is available."""
    token = HF_TOKEN or os.getenv("HF_TOKEN")
    if not token:
        print(
            "[Diarization] ERROR: Hugging Face token not found.\n"
            "Pyannote requires a free Hugging Face token.\n\n"
            "Setup steps:\n"
            "  1. Create account at https://huggingface.co\n"
            "  2. Accept license at https://huggingface.co/pyannote/speaker-diarization-3.1\n"
            "  3. Accept license at https://huggingface.co/pyannote/segmentation-3.0\n"
            "  4. Generate token at https://huggingface.co/settings/tokens\n"
            "  5. Set environment variable: export HF_TOKEN=hf_your_token_here\n"
        )
        sys.exit(1)
    return token


def load_diarization_pipeline(token: str = None):
    """
    Load the Pyannote speaker diarization pipeline.

    Args:
        token: Hugging Face access token.

    Returns:
        Loaded Pyannote Pipeline instance.
    """
    token = token or check_hf_token()

    print(f"[Diarization] Loading Pyannote pipeline...")
    sys.stdout.flush()
    pipeline = Pipeline.from_pretrained(DIARIZATION_MODEL, use_auth_token=token)
    print(f"[Diarization] Pipeline loaded successfully.")
    sys.stdout.flush()

    return pipeline


def diarize_audio(pipeline, audio_path: str, min_speakers: int = None, max_speakers: int = None):
    """
    Run speaker diarization on audio file.

    Args:
        pipeline: Loaded Pyannote Pipeline instance.
        audio_path: Path to the preprocessed WAV file.
        min_speakers: Minimum expected number of speakers.
        max_speakers: Maximum expected number of speakers.

    Returns:
        List of dicts with keys: start, end, speaker
    """
    min_spk = min_speakers or MIN_SPEAKERS
    max_spk = max_speakers or MAX_SPEAKERS

    print(f"[Diarization] Running speaker diarization on: {audio_path}")
    if min_spk or max_spk:
        print(f"[Diarization] Speaker range: {min_spk or '?'} to {max_spk or '?'}")
    sys.stdout.flush()

    start_time = time.time()

    # Build params
    params = {}
    if min_spk is not None:
        params["min_speakers"] = min_spk
    if max_spk is not None:
        params["max_speakers"] = max_spk

    diarization = pipeline(audio_path, **params)

    elapsed = time.time() - start_time

    # Extract segments
    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append({
            "start": turn.start,
            "end": turn.end,
            "speaker": speaker,
        })

    num_speakers = len(set(s["speaker"] for s in segments))
    print(f"[Diarization] Done in {elapsed:.0f}s ({elapsed/60:.1f}min). Found {num_speakers} speakers, {len(segments)} segments.")
    sys.stdout.flush()

    return segments
