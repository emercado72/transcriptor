# Audio Transcriber

Transcribe audio files with automatic speaker identification. Combines **Faster-Whisper** for speech-to-text and **Pyannote** for speaker diarization.

## Quick Start

### 1. Install dependencies
```bash
pip install -r requirements.txt
brew install ffmpeg  # macOS
```

### 2. Set up Hugging Face token (required for Pyannote)
```bash
# 1. Create free account at https://huggingface.co
# 2. Accept licenses at:
#    - https://huggingface.co/pyannote/speaker-diarization-3.1
#    - https://huggingface.co/pyannote/segmentation-3.0
# 3. Generate token at https://huggingface.co/settings/tokens
export HF_TOKEN=hf_your_token_here
```

### 3. Run
```bash
python main.py meeting.flac
python main.py meeting.flac --model large-v3 --speakers "Alice,Bob"
python main.py reunion.flac --language es --min-speakers 2 --max-speakers 2
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--model` | medium | Whisper model: tiny, base, small, medium, large-v3 |
| `--language` | auto | Language code (en, es, etc.) or auto-detect |
| `--speakers` | A,B,C... | Comma-separated speaker names |
| `--min-speakers` | - | Minimum expected speakers |
| `--max-speakers` | - | Maximum expected speakers |
| `--output-dir` | ./output | Output directory |
| `--format` | both | Output: txt, json, or both |
| `--device` | cpu | cpu or cuda |

## Processing Time (MacBook Pro i7, 32GB RAM)

| Model | 1hr Audio | Accuracy |
|-------|-----------|----------|
| tiny | ~5-10 min | Low |
| small | ~20-30 min | Good |
| medium | ~45-60 min | Very Good |
| large-v3 | ~2-4 hrs | Best |

Add ~15-30 min for diarization.

## Project Structure

```
audio-transcriber/
├── main.py                    # CLI entry point
├── config.py                  # Configuration
├── requirements.txt           # Dependencies
├── PIPELINE_INSTRUCTIONS.md   # Detailed pipeline docs
├── transcriber/
│   ├── preprocessor.py        # Audio format conversion
│   ├── transcription.py       # Faster-Whisper STT
│   ├── diarization.py         # Pyannote speaker ID
│   ├── merger.py              # Align text + speakers
│   └── formatter.py           # Output formatting
└── output/                    # Transcripts go here
```
