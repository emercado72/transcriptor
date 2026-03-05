"""
Step 2: Transcription with Faster-Whisper
Converts speech to text with timestamps.
"""
import sys
import time
from faster_whisper import WhisperModel
from config import WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE, WHISPER_BEAM_SIZE, WHISPER_LANGUAGE


def load_whisper_model(model_size: str = None, device: str = None):
    """
    Load the Faster-Whisper model.

    Args:
        model_size: Model to load (tiny, base, small, medium, large-v3).
        device: Device to use (cpu or cuda).

    Returns:
        Loaded WhisperModel instance.
    """
    model_size = model_size or WHISPER_MODEL
    device = device or WHISPER_DEVICE
    compute_type = "float16" if device == "cuda" else WHISPER_COMPUTE_TYPE

    print(f"[Transcription] Loading Whisper model '{model_size}' on {device}...")
    sys.stdout.flush()
    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    print(f"[Transcription] Model loaded successfully.")
    sys.stdout.flush()

    return model


def transcribe_audio(model, audio_path: str, language: str = None, beam_size: int = None):
    """
    Transcribe audio file to text segments with timestamps.

    Args:
        model: Loaded WhisperModel instance.
        audio_path: Path to the preprocessed WAV file.
        language: Language code or None for auto-detect.
        beam_size: Beam size for decoding.

    Returns:
        List of dicts with keys: start, end, text
    """
    language = language or WHISPER_LANGUAGE
    beam_size = beam_size or WHISPER_BEAM_SIZE

    print(f"[Transcription] Transcribing: {audio_path}")
    if language:
        print(f"[Transcription] Language: {language}")
    else:
        print(f"[Transcription] Language: auto-detect")
    sys.stdout.flush()

    start_time = time.time()

    segments_generator, info = model.transcribe(
        audio_path,
        language=language,
        beam_size=beam_size,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )

    if not language:
        print(f"[Transcription] Detected language: {info.language} (probability: {info.language_probability:.2f})")
        sys.stdout.flush()

    # Collect all segments with progress tracking
    segments = []
    last_end_time = 0
    for segment in segments_generator:
        segments.append({
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip(),
        })
        last_end_time = segment.end

        # Progress every 100 segments
        if len(segments) % 100 == 0:
            elapsed = time.time() - start_time
            print(f"[Transcription] {len(segments)} segments | audio position: {last_end_time:.0f}s ({last_end_time/60:.1f}min) | elapsed: {elapsed:.0f}s")
            sys.stdout.flush()

    elapsed = time.time() - start_time
    print(f"[Transcription] Done. {len(segments)} segments, {last_end_time:.0f}s of audio in {elapsed:.0f}s ({elapsed/60:.1f}min)")
    sys.stdout.flush()
    return segments
