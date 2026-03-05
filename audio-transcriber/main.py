#!/usr/bin/env python3
"""
Audio Transcriber — Main Entry Point
Combines Faster-Whisper (STT) + Pyannote (diarization) for speaker-labeled transcripts.

Runs Whisper and Pyannote in separate subprocesses to avoid thread deadlocks on macOS.
Saves intermediate checkpoints so work is not lost on crashes.
"""
import argparse
import sys
import os
import time
import json
import subprocess as sp
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from config import WHISPER_MODEL, WHISPER_DEVICE, OUTPUT_DIR, OUTPUT_FORMATS


def parse_args():
    parser = argparse.ArgumentParser(description="Transcribe audio with speaker diarization.")
    parser.add_argument("audio_file", help="Path to the audio file to transcribe")
    parser.add_argument("--model", default=WHISPER_MODEL,
                        choices=["tiny", "base", "small", "medium", "large-v3"])
    parser.add_argument("--language", default=None)
    parser.add_argument("--speakers", default=None)
    parser.add_argument("--min-speakers", type=int, default=None)
    parser.add_argument("--max-speakers", type=int, default=None)
    parser.add_argument("--output-dir", default=OUTPUT_DIR)
    parser.add_argument("--format", default="both", choices=["txt", "json", "both"])
    parser.add_argument("--device", default=WHISPER_DEVICE, choices=["auto", "cpu", "cuda"])
    parser.add_argument("--skip-preprocess", action="store_true")
    return parser.parse_args()


def get_checkpoint_paths(output_dir, audio_file):
    """Get paths for intermediate checkpoint files."""
    base = Path(audio_file).stem
    return {
        "whisper": os.path.join(output_dir, f"{base}_whisper_checkpoint.json"),
        "diarization": os.path.join(output_dir, f"{base}_diarization_checkpoint.json"),
    }


def run_whisper_subprocess(audio_path, output_path, model, language, device):
    """Run Whisper transcription in a separate process."""
    script = os.path.join(os.path.dirname(__file__), "_run_whisper.py")
    cmd = [
        sys.executable, script,
        audio_path, output_path,
        "--model", model,
        "--device", device,
    ]
    if language:
        cmd.extend(["--language", language])

    print(f"[Main] Starting Whisper subprocess...")
    sys.stdout.flush()
    env = {**os.environ, "KMP_DUPLICATE_LIB_OK": "TRUE"}
    result = sp.run(cmd, env=env)
    if result.returncode != 0:
        raise RuntimeError(f"Whisper subprocess failed with exit code {result.returncode}")


def run_diarization_subprocess(audio_path, output_path, min_speakers, max_speakers):
    """Run Pyannote diarization in a separate process."""
    script = os.path.join(os.path.dirname(__file__), "_run_diarization.py")
    cmd = [sys.executable, script, audio_path, output_path]
    if min_speakers:
        cmd.extend(["--min-speakers", str(min_speakers)])
    if max_speakers:
        cmd.extend(["--max-speakers", str(max_speakers)])

    print(f"[Main] Starting Pyannote subprocess...")
    sys.stdout.flush()
    env = {**os.environ, "KMP_DUPLICATE_LIB_OK": "TRUE"}
    result = sp.run(cmd, env=env)
    if result.returncode != 0:
        raise RuntimeError(f"Pyannote subprocess failed with exit code {result.returncode}")


def main():
    args = parse_args()
    formats = ["txt", "json"] if args.format == "both" else [args.format]
    speaker_names = [n.strip() for n in args.speakers.split(",")] if args.speakers else None

    os.makedirs(args.output_dir, exist_ok=True)
    checkpoints = get_checkpoint_paths(args.output_dir, args.audio_file)

    print("=" * 60)
    print("  AUDIO TRANSCRIBER")
    print("=" * 60)
    print(f"  Audio file:  {args.audio_file}")
    print(f"  Model:       {args.model}")
    print(f"  Device:      {args.device}")
    print(f"  Language:    {args.language or 'auto-detect'}")
    print(f"  Output dir:  {args.output_dir}")
    print("=" * 60)
    sys.stdout.flush()

    start_time = time.time()

    # Step 1: Preprocess
    print("\n--- Step 1/5: Audio Preprocessing ---")
    sys.stdout.flush()
    if args.skip_preprocess:
        print("[Preprocessing] Skipped (--skip-preprocess)")
        audio_path = args.audio_file
    else:
        from transcriber.preprocessor import needs_preprocessing, preprocess_audio
        if not needs_preprocessing(args.audio_file):
            audio_path = args.audio_file
        else:
            audio_path = preprocess_audio(args.audio_file)
    print(f"[Preprocessing] Done in {time.time() - start_time:.1f}s")
    sys.stdout.flush()

    # Step 2: Whisper (separate process, with checkpoint)
    print("\n--- Step 2/5: Transcription (Faster-Whisper) ---")
    sys.stdout.flush()
    if os.path.exists(checkpoints["whisper"]):
        print(f"[Transcription] Resuming from checkpoint: {checkpoints['whisper']}")
        sys.stdout.flush()
    else:
        run_whisper_subprocess(audio_path, checkpoints["whisper"], args.model, args.language, args.device)

    with open(checkpoints["whisper"]) as f:
        transcription_segments = json.load(f)
    print(f"[Transcription] Loaded {len(transcription_segments)} segments")
    sys.stdout.flush()

    if not transcription_segments:
        print("[WARNING] No speech detected.")
        sys.exit(1)

    # Step 3: Pyannote diarization (separate process, with checkpoint)
    print("\n--- Step 3/5: Speaker Diarization (Pyannote) ---")
    sys.stdout.flush()
    if os.path.exists(checkpoints["diarization"]):
        print(f"[Diarization] Resuming from checkpoint: {checkpoints['diarization']}")
        sys.stdout.flush()
    else:
        run_diarization_subprocess(audio_path, checkpoints["diarization"], args.min_speakers, args.max_speakers)

    with open(checkpoints["diarization"]) as f:
        diarization_segments = json.load(f)
    print(f"[Diarization] Loaded {len(diarization_segments)} segments")
    sys.stdout.flush()

    # Step 4: Merge
    print("\n--- Step 4/5: Merging Transcription & Diarization ---")
    sys.stdout.flush()
    from transcriber.merger import merge_transcription_and_diarization, group_by_speaker
    merged = merge_transcription_and_diarization(transcription_segments, diarization_segments)
    grouped = group_by_speaker(merged)
    print(f"[Merger] Done. {len(grouped)} speaker blocks")
    sys.stdout.flush()

    # Step 5: Save output
    print("\n--- Step 5/5: Saving Output ---")
    sys.stdout.flush()
    from transcriber.formatter import save_transcript
    audio_duration = max(s["end"] for s in merged) if merged else 0

    output_files = save_transcript(
        grouped, output_dir=args.output_dir, audio_file=args.audio_file,
        formats=formats, audio_duration=audio_duration,
        model_used=args.model, speaker_names=speaker_names,
    )

    # Clean up checkpoints
    for cp in checkpoints.values():
        if os.path.exists(cp):
            os.remove(cp)

    elapsed = time.time() - start_time
    print("\n" + "=" * 60)
    print("  TRANSCRIPTION COMPLETE")
    print("=" * 60)
    print(f"  Time:    {elapsed:.0f}s ({elapsed/60:.1f} min)")
    print(f"  Audio:   {audio_duration:.0f}s ({audio_duration/60:.1f} min)")
    for f in output_files:
        print(f"  Output:  {f}")
    print("=" * 60)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
