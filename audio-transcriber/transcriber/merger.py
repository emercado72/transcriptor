"""
Step 4: Merge Transcription and Diarization
Assigns speaker labels to transcribed segments using timestamp overlap.
"""


def calculate_overlap(seg1_start, seg1_end, seg2_start, seg2_end):
    """Calculate the overlap duration between two time segments."""
    overlap = max(0.0, min(seg1_end, seg2_end) - max(seg1_start, seg2_start))
    return overlap


def merge_transcription_and_diarization(transcription_segments, diarization_segments):
    """
    Merge transcription segments with diarization segments.

    For each transcription segment, find the diarization segment with the
    greatest time overlap and assign that speaker.

    Args:
        transcription_segments: List of dicts with start, end, text
        diarization_segments: List of dicts with start, end, speaker

    Returns:
        List of dicts with start, end, speaker, text
    """
    print(f"[Merger] Aligning {len(transcription_segments)} transcription segments "
          f"with {len(diarization_segments)} diarization segments...")

    merged = []

    for t_seg in transcription_segments:
        t_start = t_seg["start"]
        t_end = t_seg["end"]
        t_text = t_seg["text"]

        # Find best matching speaker
        best_speaker = "UNKNOWN"
        best_overlap = 0.0

        for d_seg in diarization_segments:
            overlap = calculate_overlap(t_start, t_end, d_seg["start"], d_seg["end"])
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = d_seg["speaker"]

        merged.append({
            "start": t_start,
            "end": t_end,
            "speaker": best_speaker,
            "text": t_text,
        })

    print(f"[Merger] Done. Merged {len(merged)} segments.")
    return merged


def group_by_speaker(merged_segments):
    """
    Group consecutive segments by the same speaker into single blocks.

    This avoids repeated speaker labels when the same person speaks
    across multiple short segments.

    Args:
        merged_segments: List of dicts with start, end, speaker, text

    Returns:
        List of grouped dicts with start, end, speaker, text
    """
    if not merged_segments:
        return []

    grouped = []
    current = {
        "start": merged_segments[0]["start"],
        "end": merged_segments[0]["end"],
        "speaker": merged_segments[0]["speaker"],
        "text": merged_segments[0]["text"],
    }

    for seg in merged_segments[1:]:
        if seg["speaker"] == current["speaker"]:
            # Same speaker — extend the block
            current["end"] = seg["end"]
            current["text"] += " " + seg["text"]
        else:
            # New speaker — save current block and start new one
            grouped.append(current)
            current = {
                "start": seg["start"],
                "end": seg["end"],
                "speaker": seg["speaker"],
                "text": seg["text"],
            }

    # Don't forget the last block
    grouped.append(current)

    print(f"[Merger] Grouped into {len(grouped)} speaker blocks.")
    return grouped
