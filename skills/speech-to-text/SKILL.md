---
name: speech-to-text
description: Transcribe audio files to text using OpenAI Whisper CLI — supports voice messages, audio recordings, and multiple languages.
user-invocable: false
---

# Speech-to-Text Transcription

You can transcribe audio files to text using the OpenAI Whisper CLI tool.

## Prerequisites

The following must be installed on the system:

- **openai-whisper**: `pip install openai-whisper`
- **ffmpeg**: `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Linux)

Verify installation: `whisper --help`

## Usage

To transcribe an audio file:

```bash
whisper <audio_file> --model base --output_format txt --output_dir /tmp
```

The transcript will be saved as a `.txt` file in the output directory.

### Common Options

| Option | Description | Values |
|--------|-------------|--------|
| `--model` | Model size (larger = more accurate but slower) | `tiny`, `base`, `small`, `medium`, `large` |
| `--language` | Source language (auto-detect if omitted) | `zh`, `en`, `ja`, `ko`, etc. |
| `--output_format` | Output format | `txt`, `srt`, `vtt`, `json` |
| `--output_dir` | Directory for output files | Any writable path |

### Recommended Models

- **tiny/base**: Fast, suitable for clear speech in common languages
- **small**: Good balance of speed and accuracy
- **medium/large**: Best accuracy, recommended for noisy audio or uncommon languages

## When to Use

When you receive a message containing an audio file path (e.g., `[User sent a voice message: /path/to/audio.ogg]`), use this skill to transcribe it:

1. Run the whisper command on the audio file.
2. Read the resulting `.txt` file.
3. Use the transcript to understand and respond to the user's request.
4. Clean up temporary output files.

If whisper is not installed, inform the user that speech-to-text requires installing `openai-whisper` and `ffmpeg`.
