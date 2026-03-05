#!/usr/bin/env python3
"""
Subprocess worker for Pyannote diarization. 
Processes audio in chunks to avoid memory limits on large files.
Saves results to JSON checkpoint.
"""
import argparse
import sys
import os
import json
import time
import tempfile
import subprocess as sp

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
sys.path.insert(0, os.path.dirname(__file__))

from config import HF_TOKEN, DIARIZATION_MODEL, MIN_SPEAKERS, MAX_SPEAKERS

# Max chunk duration in seconds (10 min chunks with 30s overlap)
CHUNK_DURATION = 600
CHUNK_OVERLAP = 30


def split_audio_chunks(audio_path, output_dir=None, chunk_duration=CHUNK_DURATION, overlap=CHUNK_OVERLAP):
    """Split audio into overlapping chunks using ffmpeg. Returns list of (chunk_path, offset)."""
    # Get duration — try multiple methods since some FLAC files lack duration metadata
    duration = 0

    # Method 1: ffprobe show_streams
    try:
        probe = sp.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", audio_path],
            capture_output=True, text=True, timeout=30
        )
        data = json.loads(probe.stdout)
        for stream in data.get("streams", []):
            if stream.get("codec_type") == "audio" and stream.get("duration"):
                duration = float(stream["duration"])
                break
        if duration == 0 and data.get("format", {}).get("duration"):
            duration = float(data["format"]["duration"])
    except Exception:
        pass

    # Method 2: ffprobe with duration calculation
    if duration == 0:
        try:
            probe = sp.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", audio_path],
                capture_output=True, text=True, timeout=60
            )
            if probe.stdout.strip():
                duration = float(probe.stdout.strip())
        except Exception:
            pass

    # Method 3: decode a tiny bit and calculate from file size + sample rate
    if duration == 0:
        try:
            probe = sp.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", audio_path],
                capture_output=True, text=True, timeout=30
            )
            data = json.loads(probe.stdout)
            for stream in data.get("streams", []):
                if stream.get("codec_type") == "audio":
                    sr = int(stream.get("sample_rate", 0))
                    nb_samples = int(stream.get("duration_ts", 0))
                    if sr > 0 and nb_samples > 0:
                        duration = nb_samples / sr
                    break
        except Exception:
            pass

    # Method 4: decode to null and read the time from stderr
    if duration == 0:
        print("[Diarization] Probing duration by decoding (may take a moment)...")
        sys.stdout.flush()
        try:
            result = sp.run(
                ["ffmpeg", "-i", audio_path, "-f", "null", "-"],
                capture_output=True, text=True, timeout=300
            )
            import re
            # ffmpeg puts time in stderr
            times = re.findall(r"time=(\d+):(\d+):(\d+\.\d+)", result.stderr)
            if times:
                h, m, s = times[-1]
                duration = int(h) * 3600 + int(m) * 60 + float(s)
        except Exception:
            pass

    # Method 5: use soxi or get from whisper checkpoint in same output dir
    if duration == 0:
        try:
            checkpoint_dir = output_dir or os.path.dirname(audio_path)
            base = os.path.splitext(os.path.basename(audio_path))[0]
            whisper_cp = os.path.join(checkpoint_dir, f"{base}_whisper_checkpoint.json")
            if os.path.exists(whisper_cp):
                with open(whisper_cp) as f:
                    wsegs = json.load(f)
                if wsegs:
                    duration = wsegs[-1]["end"]
                    print(f"[Diarization] Got duration from Whisper checkpoint: {duration:.0f}s")
                    sys.stdout.flush()
        except Exception:
            pass

    if duration == 0:
        raise RuntimeError("Could not determine audio duration after trying all methods")

    print(f"[Diarization] Audio duration: {duration:.0f}s ({duration/60:.1f}min)")
    print(f"[Diarization] Splitting into {chunk_duration}s chunks with {overlap}s overlap")
    sys.stdout.flush()

    chunks = []
    offset = 0
    chunk_idx = 0
    while offset < duration:
        chunk_path = tempfile.mktemp(suffix=f"_chunk{chunk_idx:03d}.wav")
        end = min(offset + chunk_duration + overlap, duration)
        actual_duration = end - offset

        cmd = [
            "ffmpeg", "-y", "-v", "quiet",
            "-i", audio_path,
            "-ss", str(offset),
            "-t", str(actual_duration),
            "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le",
            chunk_path
        ]
        result = sp.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg chunk split failed: {result.stderr}")

        chunks.append((chunk_path, offset))
        print(f"[Diarization] Created chunk {chunk_idx}: {offset:.0f}s - {end:.0f}s")
        sys.stdout.flush()

        offset += chunk_duration  # advance by chunk_duration (not including overlap)
        chunk_idx += 1

    return chunks, duration


def merge_chunk_results(all_chunk_segments, chunk_duration=CHUNK_DURATION, overlap=CHUNK_OVERLAP):
    """Merge diarization results from overlapping chunks. Use overlap region to stitch."""
    if len(all_chunk_segments) <= 1:
        return all_chunk_segments[0] if all_chunk_segments else []

    merged = []
    for i, (segments, offset) in enumerate(all_chunk_segments):
        if i == 0:
            # First chunk: keep everything up to chunk_duration (trim overlap tail)
            cutoff = chunk_duration
            for seg in segments:
                if seg["start"] + offset < cutoff + offset:
                    merged.append({
                        "start": seg["start"] + offset,
                        "end": min(seg["end"] + offset, cutoff + offset),
                        "speaker": seg["speaker"],
                    })
        elif i == len(all_chunk_segments) - 1:
            # Last chunk: skip the overlap region at the beginning
            skip_until = overlap
            for seg in segments:
                if seg["start"] >= skip_until:
                    merged.append({
                        "start": seg["start"] + offset,
                        "end": seg["end"] + offset,
                        "speaker": seg["speaker"],
                    })
        else:
            # Middle chunks: skip overlap at start, trim at chunk_duration
            skip_until = overlap
            cutoff = chunk_duration
            for seg in segments:
                if seg["start"] >= skip_until and seg["start"] < cutoff:
                    merged.append({
                        "start": seg["start"] + offset,
                        "end": min(seg["end"] + offset, cutoff + offset),
                        "speaker": seg["speaker"],
                    })

    # Sort by start time
    merged.sort(key=lambda s: s["start"])
    return merged


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path")
    parser.add_argument("output_path")
    parser.add_argument("--min-speakers", type=int, default=None)
    parser.add_argument("--max-speakers", type=int, default=None)
    args = parser.parse_args()

    token = HF_TOKEN or os.getenv("HF_TOKEN")
    if not token:
        print("[Diarization] ERROR: HF_TOKEN not set", file=sys.stderr)
        sys.exit(1)

    from pyannote.audio import Pipeline

    print(f"[Diarization] Loading Pyannote pipeline...")
    sys.stdout.flush()
    pipeline = Pipeline.from_pretrained(DIARIZATION_MODEL, use_auth_token=token)
    # Move pipeline to GPU if available
    import torch
    if torch.cuda.is_available():
        pipeline.to(torch.device("cuda"))
        print(f"[Diarization] Pipeline moved to GPU: {torch.cuda.get_device_name(0)}")
    else:
        print("[Diarization] No GPU available, running on CPU")
    print(f"[Diarization] Pipeline loaded.")
    sys.stdout.flush()

    start = time.time()

    # Split into chunks
    chunks, total_duration = split_audio_chunks(args.audio_path, output_dir=os.path.dirname(args.output_path))

    params = {}
    min_spk = args.min_speakers or MIN_SPEAKERS
    max_spk = args.max_speakers or MAX_SPEAKERS
    if min_spk is not None:
        params["min_speakers"] = min_spk
    if max_spk is not None:
        params["max_speakers"] = max_spk

    # Process each chunk
    all_chunk_segments = []
    for i, (chunk_path, offset) in enumerate(chunks):
        print(f"[Diarization] Processing chunk {i+1}/{len(chunks)} (offset {offset:.0f}s)...")
        sys.stdout.flush()
        chunk_start = time.time()

        try:
            diarization = pipeline(chunk_path, **params)
            segments = []
            for turn, _, speaker in diarization.itertracks(yield_label=True):
                segments.append({"start": turn.start, "end": turn.end, "speaker": speaker})

            all_chunk_segments.append((segments, offset))
            chunk_elapsed = time.time() - chunk_start
            num_speakers = len(set(s["speaker"] for s in segments))
            print(f"[Diarization] Chunk {i+1} done in {chunk_elapsed:.0f}s — {num_speakers} speakers, {len(segments)} segments")
            sys.stdout.flush()
        finally:
            # Clean up chunk file
            if os.path.exists(chunk_path):
                os.remove(chunk_path)

    # Merge all chunks
    print(f"[Diarization] Merging {len(all_chunk_segments)} chunks...")
    sys.stdout.flush()
    merged = merge_chunk_results(all_chunk_segments)

    elapsed = time.time() - start
    num_speakers = len(set(s["speaker"] for s in merged))
    print(f"[Diarization] Done in {elapsed:.0f}s ({elapsed/60:.1f}min). {num_speakers} speakers, {len(merged)} segments.")
    sys.stdout.flush()

    with open(args.output_path, "w") as f:
        json.dump(merged, f, ensure_ascii=False)
    print(f"[Diarization] Saved: {args.output_path}")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
