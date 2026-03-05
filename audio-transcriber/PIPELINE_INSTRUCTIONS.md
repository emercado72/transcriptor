# Audio Transcriber Pipeline — Agent Instructions

## Project Overview

Build a Python-based audio transcription pipeline that converts audio files (FLAC, WAV, MP3) into speaker-labeled transcripts. The pipeline combines two models: **Faster-Whisper** for speech-to-text transcription and **Pyannote** for speaker diarization (identifying who spoke when). The output is a clean, timestamped transcript with speaker labels.

---

## Architecture

```
INPUT: Audio File (FLAC, WAV, MP3, etc.)
         |
         |--- Parallel Processing ---|
         v                           v
  +----------------+         +----------------+
  | Faster-Whisper |         |    Pyannote    |
  |                |         |                |
  | Transcribes    |         | Identifies     |
  | audio to text  |         | speakers by    |
  | with timestamps|         | time ranges    |
  +-------+--------+         +-------+--------+
          |                           |
          v                           v
  +------------------------------------------+
  |           MERGE / ALIGN                   |
  |                                           |
  |  Match each transcribed segment           |
  |  to a speaker by comparing                |
  |  timestamp overlap                        |
  +--------------------+---------------------+
                       |
                       v
  +------------------------------------------+
  |              FINAL OUTPUT                 |
  |                                           |
  |  Speaker A [0:00]: Hello...               |
  |  Speaker B [0:04]: Thanks...              |
  +------------------------------------------+
```

---

## Requirements

### Python Version
- Python 3.9 or higher

### Dependencies
```
faster-whisper
pyannote.audio
torch
pydub
ffmpeg-python
```

### System Dependencies
- **ffmpeg**: Required for audio format conversion. Install via `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Linux).

### Hugging Face Token (required for Pyannote)
1. Create a free account at https://huggingface.co
2. Go to https://huggingface.co/pyannote/speaker-diarization-3.1
3. Accept the model license agreement (free, one-time)
4. Go to https://huggingface.co/pyannote/segmentation-3.0
5. Accept the model license agreement (free, one-time)
6. Generate an access token at https://huggingface.co/settings/tokens
7. Store the token in an environment variable: `export HF_TOKEN=hf_your_token_here`

---

## Pipeline Steps — Detailed Instructions

### Step 1: Audio Preprocessing

**Goal:** Ensure the input audio is in a format both models can process reliably.

**Actions:**
1. Accept the input audio file path from the user (supports FLAC, WAV, MP3, M4A, OGG, WMA).
2. Convert the audio to WAV format, 16kHz sample rate, mono channel using ffmpeg or pydub.
3. Save the preprocessed file as a temporary WAV file.

**Why:** Both Faster-Whisper and Pyannote work best with 16kHz mono WAV. This avoids format-related issues.

**Implementation notes:**
- Use pydub or ffmpeg-python for conversion.
- If the input is already 16kHz mono WAV, skip conversion.
- Keep the temp file until the pipeline completes, then clean up.

---

### Step 2: Transcription with Faster-Whisper

**Goal:** Convert speech in the audio to text, producing segments with start/end timestamps.

**Actions:**
1. Load the Faster-Whisper model. Use `medium` model by default (best accuracy-to-speed ratio on CPU). Allow the user to override with `large-v3` for maximum accuracy or `small` for faster processing.
2. Set `device="cpu"` and `compute_type="int8"` for CPU-only machines.
3. Run transcription on the preprocessed WAV file.
4. Collect all segments into a list. Each segment must contain: `start` (float, seconds), `end` (float, seconds), `text` (string).

**Configuration options to expose:**
- `model_size`: tiny, base, small, medium, large-v3 (default: medium)
- `language`: auto-detect or specify (e.g., "en", "es")
- `beam_size`: default 5, higher = more accurate but slower

**Expected output structure:**
```python
transcription_segments = [
    {"start": 0.0, "end": 3.2, "text": "Hello, thanks for joining the call."},
    {"start": 3.5, "end": 6.8, "text": "Thanks for having me."},
]
```

---

### Step 3: Speaker Diarization with Pyannote

**Goal:** Identify who spoke when, producing time ranges labeled by speaker.

**Actions:**
1. Load the Pyannote speaker diarization pipeline using the Hugging Face token.
2. Run diarization on the same preprocessed WAV file.
3. Collect all diarization segments into a list. Each segment must contain: `start` (float, seconds), `end` (float, seconds), `speaker` (string, e.g., "SPEAKER_00", "SPEAKER_01").

**Configuration options to expose:**
- `min_speakers`: minimum expected number of speakers (optional)
- `max_speakers`: maximum expected number of speakers (optional)
- Setting these helps Pyannote produce better results when you know the speaker count.

**Expected output structure:**
```python
diarization_segments = [
    {"start": 0.0, "end": 4.1, "speaker": "SPEAKER_00"},
    {"start": 4.1, "end": 8.3, "speaker": "SPEAKER_01"},
]
```

---

### Step 4: Merge Transcription and Diarization

**Goal:** Assign a speaker label to each transcribed text segment by matching timestamps.

**Algorithm:**
1. For each transcription segment (from Step 2):
   a. Find all diarization segments (from Step 3) that overlap in time with it.
   b. Calculate the overlap duration for each matching diarization segment.
   c. Assign the speaker with the **greatest overlap** to that transcription segment.
2. If no diarization segment overlaps (rare edge case), label as "UNKNOWN".

**Overlap calculation:**
```
overlap = max(0, min(transcription_end, diarization_end) - max(transcription_start, diarization_start))
```

**Expected output structure:**
```python
merged_segments = [
    {"start": 0.0, "end": 3.2, "speaker": "SPEAKER_00", "text": "Hello, thanks for joining the call."},
    {"start": 3.5, "end": 6.8, "speaker": "SPEAKER_01", "text": "Thanks for having me."},
]
```

---

### Step 5: Post-Processing and Output

**Goal:** Format the merged segments into a clean, readable transcript.

**Actions:**
1. Group consecutive segments by the same speaker into a single block (to avoid repeated speaker labels for continuous speech).
2. Format timestamps as `[HH:MM:SS]` or `[MM:SS]` for files under 1 hour.
3. Generate the output in the following formats:

**Plain text output (.txt):**
```
Speaker A [00:00]: Hello, thanks for joining the call. I wanted to
discuss the project timeline today.

Speaker B [00:08]: Thanks for having me. Sure, let's go through the
milestones.

Speaker A [00:15]: Great. So the first milestone is...
```

**JSON output (.json):**
```json
{
    "audio_file": "meeting.flac",
    "duration_seconds": 3600,
    "num_speakers": 2,
    "model_used": "medium",
    "segments": [
        {
            "start": 0.0,
            "end": 7.5,
            "speaker": "Speaker A",
            "text": "Hello, thanks for joining the call."
        }
    ]
}
```

**Speaker name mapping:**
- Default labels are "Speaker A", "Speaker B", "Speaker C", etc.
- Provide an option for the user to supply a mapping file or pass names as arguments (e.g., `--speakers "Alice,Bob,Charlie"`).

---

## Project File Structure

```
audio-transcriber/
├── PIPELINE_INSTRUCTIONS.md   # This document
├── README.md                  # Project documentation
├── requirements.txt           # Python dependencies
├── config.py                  # Configuration (model size, paths, defaults)
├── transcriber/
│   ├── __init__.py
│   ├── preprocessor.py        # Step 1: Audio preprocessing
│   ├── transcription.py       # Step 2: Faster-Whisper transcription
│   ├── diarization.py         # Step 3: Pyannote diarization
│   ├── merger.py              # Step 4: Merge/align segments
│   └── formatter.py           # Step 5: Output formatting
├── main.py                    # CLI entry point
└── output/                    # Default output directory
```

---

## CLI Interface

The main entry point should accept the following arguments:

```
python main.py <audio_file> [options]

Required:
  audio_file              Path to the audio file to transcribe

Options:
  --model         TEXT    Whisper model size: tiny, base, small, medium, large-v3
                          (default: medium)
  --language      TEXT    Language code (e.g., en, es) or "auto" for auto-detect
                          (default: auto)
  --speakers      TEXT    Comma-separated speaker names (e.g., "Alice,Bob")
                          (default: Speaker A, Speaker B, ...)
  --min-speakers  INT    Minimum number of speakers expected (optional)
  --max-speakers  INT    Maximum number of speakers expected (optional)
  --output-dir    PATH   Output directory (default: ./output/)
  --format        TEXT    Output formats: txt, json, both (default: both)
  --device        TEXT    Device: cpu or cuda (default: cpu)
```

**Example usage:**
```bash
# Basic transcription
python main.py meeting.flac

# With speaker names and large model
python main.py meeting.flac --model large-v3 --speakers "Alice,Bob,Charlie"

# Spanish audio, 2 speakers expected
python main.py reunion.flac --language es --min-speakers 2 --max-speakers 2

# Quick transcription with small model
python main.py call.mp3 --model small --format txt
```

---

## Performance Expectations (MacBook Pro i7, 32GB RAM, CPU)

| Model    | Processing Time per 1hr Audio | Accuracy  |
|----------|-------------------------------|-----------|
| tiny     | ~5-10 min                     | Low       |
| base     | ~10-15 min                    | Decent    |
| small    | ~20-30 min                    | Good      |
| medium   | ~45-60 min                    | Very Good |
| large-v3 | ~2-4 hours                   | Best      |

Pyannote diarization adds approximately 15-30 minutes for 1 hour of audio on CPU.

**Recommendation:** Use `medium` model for the best accuracy-to-speed balance. Use `large-v3` only when maximum accuracy is critical and you can wait.

---

## Error Handling Requirements

1. **Missing Hugging Face token:** Check for `HF_TOKEN` environment variable at startup. If missing, print clear instructions on how to set it up and exit gracefully.
2. **Unsupported audio format:** Detect format and inform the user. Attempt conversion with ffmpeg if available.
3. **ffmpeg not installed:** Detect at startup, print installation instructions.
4. **Insufficient memory:** If model loading fails due to memory, suggest a smaller model size.
5. **Empty transcription:** If Whisper returns no segments, warn the user that the audio may be silent, corrupted, or in an unsupported language.
6. **Progress feedback:** Print progress messages during each pipeline step, including estimated time remaining if possible.

---

## Future Enhancements (Not Required for v1)

- **LLM post-processing:** Send the transcript to Ollama to clean up grammar, generate meeting notes, or extract action items.
- **Batch processing:** Accept a folder of audio files and process all of them sequentially.
- **Speaker naming via voice matching:** Use voice embeddings to match speakers across multiple files.
- **ROS node integration:** Wrap the pipeline as a ROS publisher/subscriber for robot integration.
- **Web UI:** Simple Flask or Streamlit interface for non-CLI users.
