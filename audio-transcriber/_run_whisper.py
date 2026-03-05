#!/usr/bin/env python3
"""Subprocess worker for Whisper transcription. Saves results to JSON checkpoint incrementally."""
import argparse
import sys
import os
import json
import time

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
sys.path.insert(0, os.path.dirname(__file__))

from config import WHISPER_COMPUTE_TYPE, WHISPER_BEAM_SIZE

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path")
    parser.add_argument("output_path")
    parser.add_argument("--model", default="medium")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--language", default=None)
    args = parser.parse_args()

    # Auto-detect device if not explicitly set
    device = args.device
    if device == "auto":
        try:
            import torch
            if torch.cuda.is_available():
                device = "cuda"
            elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                # faster-whisper uses CTranslate2 which doesn't support MPS directly
                # but we can still use CPU with int8 which is fast enough on Apple Silicon
                device = "cpu"
                print("[Whisper] MPS available but CTranslate2 doesn't support it — using CPU with int8 (fast on Apple Silicon)")
                sys.stdout.flush()
            else:
                device = "cpu"
        except ImportError:
            device = "cpu"

    # Check for existing partial checkpoint to resume from
    segments = []
    resume_after = 0.0
    if os.path.exists(args.output_path):
        try:
            with open(args.output_path) as f:
                segments = json.load(f)
            if segments:
                resume_after = segments[-1]["end"]
                print(f"[Whisper] Found checkpoint with {len(segments)} segments up to {resume_after:.0f}s — resuming")
                sys.stdout.flush()
        except Exception:
            segments = []

    from faster_whisper import WhisperModel

    # Pick compute type based on device
    if device == "cuda":
        compute_type = "float16"
    else:
        compute_type = WHISPER_COMPUTE_TYPE  # int8 for CPU (from config auto-detection)

    print(f"[Whisper] Loading model '{args.model}' on {device} (compute_type={compute_type})...")
    sys.stdout.flush()
    model = WhisperModel(args.model, device=device, compute_type=compute_type)
    print(f"[Whisper] Model loaded.")
    sys.stdout.flush()

    print(f"[Whisper] Transcribing: {os.path.basename(args.audio_path)}")
    sys.stdout.flush()
    start = time.time()

    segments_gen, info = model.transcribe(
        args.audio_path,
        language=args.language,
        beam_size=WHISPER_BEAM_SIZE,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )

    if not args.language:
        print(f"[Whisper] Detected language: {info.language} ({info.language_probability:.2f})")
        sys.stdout.flush()

    new_count = 0
    for seg in segments_gen:
        # Skip segments we already have from checkpoint
        if seg.end <= resume_after:
            continue

        segments.append({
            "start": seg.start,
            "end": seg.end,
            "text": seg.text.strip(),
            "avg_logprob": round(seg.avg_logprob, 4),
            "no_speech_prob": round(seg.no_speech_prob, 4),
            "compression_ratio": round(seg.compression_ratio, 4),
        })
        new_count += 1

        # Save checkpoint every 50 segments
        if new_count % 50 == 0:
            with open(args.output_path, "w") as f:
                json.dump(segments, f, ensure_ascii=False)
            elapsed = time.time() - start
            print(f"[Whisper] {len(segments)} segments | audio: {seg.end:.0f}s ({seg.end/60:.1f}min) | elapsed: {elapsed:.0f}s | saved checkpoint")
            sys.stdout.flush()

    # Final save
    with open(args.output_path, "w") as f:
        json.dump(segments, f, ensure_ascii=False)

    elapsed = time.time() - start
    last_end = segments[-1]["end"] if segments else 0
    print(f"[Whisper] Done. {len(segments)} segments, {last_end:.0f}s audio in {elapsed:.0f}s ({elapsed/60:.1f}min)")
    print(f"[Whisper] Checkpoint saved: {args.output_path}")
    sys.stdout.flush()

if __name__ == "__main__":
    main()
