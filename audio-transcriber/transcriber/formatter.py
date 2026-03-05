"""
Step 5: Output Formatting
Formats merged segments into readable transcripts (TXT and JSON).
"""
import json
import os
from pathlib import Path


def format_timestamp(seconds: float, short: bool = False) -> str:
    """Format seconds into HH:MM:SS or MM:SS timestamp."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)

    if short and hours == 0:
        return f"{minutes:02d}:{secs:02d}"
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def map_speaker_names(segments, speaker_names: list = None):
    """
    Replace raw speaker IDs (SPEAKER_00) with friendly names.

    Args:
        segments: List of segment dicts with 'speaker' key.
        speaker_names: Optional list of names (e.g., ["Alice", "Bob"]).

    Returns:
        Segments with updated speaker names and the mapping used.
    """
    # Get unique speakers in order of appearance
    seen = []
    for seg in segments:
        if seg["speaker"] not in seen:
            seen.append(seg["speaker"])

    # Build mapping
    mapping = {}
    for i, raw_name in enumerate(seen):
        if speaker_names and i < len(speaker_names):
            mapping[raw_name] = speaker_names[i]
        else:
            # Default: Speaker A, Speaker B, etc.
            letter = chr(ord("A") + i) if i < 26 else f"Speaker {i + 1}"
            mapping[raw_name] = f"Speaker {letter}"

    # Apply mapping
    for seg in segments:
        seg["speaker"] = mapping.get(seg["speaker"], seg["speaker"])

    return segments, mapping


def save_as_txt(segments, output_path: str, audio_duration: float = None):
    """Save transcript as a plain text file."""
    short_ts = audio_duration is not None and audio_duration < 3600

    lines = []
    for seg in segments:
        timestamp = format_timestamp(seg["start"], short=short_ts)
        lines.append(f'{seg["speaker"]} [{timestamp}]: {seg["text"]}')
        lines.append("")  # blank line between speakers

    text = "\n".join(lines)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(text)

    print(f"[Formatter] Saved TXT transcript: {output_path}")


def save_as_json(segments, output_path: str, audio_file: str = None,
                 audio_duration: float = None, model_used: str = None,
                 speaker_mapping: dict = None):
    """Save transcript as a JSON file."""
    num_speakers = len(set(s["speaker"] for s in segments))

    data = {
        "audio_file": audio_file or "unknown",
        "duration_seconds": round(audio_duration, 2) if audio_duration else None,
        "num_speakers": num_speakers,
        "model_used": model_used or "unknown",
        "speaker_mapping": speaker_mapping,
        "segments": [
            {
                "start": round(s["start"], 2),
                "end": round(s["end"], 2),
                "speaker": s["speaker"],
                "text": s["text"],
            }
            for s in segments
        ],
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"[Formatter] Saved JSON transcript: {output_path}")


def save_transcript(segments, output_dir: str, audio_file: str,
                    formats: list = None, audio_duration: float = None,
                    model_used: str = None, speaker_names: list = None):
    """
    Save transcript in requested formats.

    Args:
        segments: Grouped and merged segments.
        output_dir: Directory to save output files.
        audio_file: Original audio file path (for metadata).
        formats: List of formats to save (txt, json).
        audio_duration: Total audio duration in seconds.
        model_used: Whisper model used.
        speaker_names: Optional custom speaker names.

    Returns:
        List of output file paths.
    """
    formats = formats or ["txt", "json"]
    os.makedirs(output_dir, exist_ok=True)

    # Map speaker names
    segments, mapping = map_speaker_names(segments, speaker_names)

    # Generate base filename from audio file
    base_name = Path(audio_file).stem
    output_files = []

    if "txt" in formats:
        txt_path = os.path.join(output_dir, f"{base_name}_transcript.txt")
        save_as_txt(segments, txt_path, audio_duration)
        output_files.append(txt_path)

    if "json" in formats:
        json_path = os.path.join(output_dir, f"{base_name}_transcript.json")
        save_as_json(segments, json_path, audio_file, audio_duration, model_used, mapping)
        output_files.append(json_path)

    return output_files
