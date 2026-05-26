# Installation

## 1) Install system dependencies

```bash
brew install ffmpeg whisper-cpp
```

Check them:

```bash
which ffmpeg
which whisper-cli
which hermes
which say
python3 --version
```

`hermes` must already be installed and working locally.

Recommended:

- install Hermes first from the official repo: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
- confirm `hermes --help` and `hermes chat -q "hello" -Q` work before starting this bot

This project currently assumes macOS for the easiest Discord voice setup. TTS can run through local Piper, macOS `say`, ElevenLabs, or a custom Hermes TTS command.

## 2) Clone the repo and install Node dependencies

```bash
git clone https://github.com/jx-grxf/Hermes-Discord-Voice.git
cd Hermes-Discord-Voice
brew install node
npm install
```

## 3) Configure the environment

Create `.env`:

```bash
cp .env.example .env
```

Set:

- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`

Discord bot setup, if you do not already have one:

1. Create a new application in the Discord Developer Portal
2. Add a bot user to that application
3. Copy the bot token into `DISCORD_TOKEN`
4. Invite the bot to your test guild with slash command + voice permissions
5. Right-click your guild, copy its id, and place it into `DISCORD_GUILD_ID`

Recommended Discord permissions:

- `View Channels`
- `Send Messages`
- `Use Application Commands`
- `Connect`
- `Speak`
- `Read Message History`

Optional:

- `TTS_PROVIDER` to choose `hermes`, `piper`, `say`, or `elevenlabs`. `.env.example` starts with `piper`; runtime fallback is `say` if unset.
- `HERMES_TRANSPORT` optional, default `cli`; set `api` to use the local Hermes API server.
- `HERMES_PROVIDER`, `HERMES_MODEL`, `HERMES_TOOLSETS`, and `HERMES_SKILLS` to override Hermes routing per bridge call.
- `HERMES_VOICE_SESSION_PREFIX` optional, default `hermes-discord-voice`; each `/join` still creates a fresh conversation key.
- `HERMES_API_BASE_URL` and `HERMES_API_KEY` if you use `HERMES_TRANSPORT=api`.
- `HERMES_TTS_COMMAND` if you use `TTS_PROVIDER=hermes`; the command receives output path and text as arguments.
- `TTS_VOICE` to choose the macOS `say` voice. Default: `Flo`
- `TTS_RATE` to set the macOS `say` speaking rate. Default: `220`
- `PIPER_BINARY_PATH` optional, default `tools/piper-venv/bin/python`
- `PIPER_MODEL_PATH` optional, default `models/piper/de_DE-thorsten-medium.onnx`
- `PIPER_SPEAKER` optional for multi-speaker Piper models
- `ELEVENLABS_API_KEY` if you use `TTS_PROVIDER=elevenlabs`
- `ELEVENLABS_VOICE_ID` if you use `TTS_PROVIDER=elevenlabs`
- `ELEVENLABS_MODEL_ID` optional, default `eleven_multilingual_v2`
- `ELEVENLABS_OUTPUT_FORMAT` optional, default `mp3_44100_128`
- `ELEVENLABS_TIMEOUT_MS` optional, default `60000`
- `WHISPER_MODEL_PATH` optional, default `models/ggml-base.bin`
- `WHISPER_LANGUAGE` optional, default `auto`; use `de` or `en` to force one language
- `WHISPER_THREADS` optional; use it if you want to give `whisper-cli` more CPU threads
- `VOICE_NO_AUDIO_TIMEOUT_MS` optional, default `12000`
- `VOICE_NO_SPEECH_TIMEOUT_MS` optional, default `5000`
- `VOICE_MAX_CAPTURE_MS` optional, default `9000`
- `VOICE_JOIN_ATTEMPTS` optional, default `2`
- `VOICE_JOIN_READY_TIMEOUT_MS` optional, default `10000`

## 4) Place the Whisper model

Path:

```text
models/ggml-base.bin
```

Expected filename in this repo:

- `models/ggml-base.bin`

How to get it:

- download or build a Whisper model compatible with `whisper-cli`
- place it at exactly `models/ggml-base.bin`
- if you prefer another file, rename or copy it to that path for this project

If the file is missing, the bot stops with a clear startup error.

## 5) Start

Run a quick health check first:

```bash
npm run doctor:bridge
```

Development:

```bash
npm run dev
```

Build + start:

```bash
npm run build
npm start
```

The bot registers guild slash commands automatically on startup.

If startup fails, do not jump straight into Discord debugging yet. First confirm:

- `hermes --help` works
- `hermes chat -q "hello" -Q` works
- `which ffmpeg`
- `which whisper-cli`
- your configured TTS provider is actually available

## TTS providers

Custom Hermes-backed:

- `TTS_PROVIDER=hermes`
- runs `HERMES_TTS_COMMAND <output-path> <text>`
- useful when your Hermes setup exposes a local TTS wrapper script

Recommended local default:

- `TTS_PROVIDER=piper`
- install the Python runtime once:

```bash
python3 -m venv tools/piper-venv
source tools/piper-venv/bin/activate
pip install -U pip
pip install piper-tts pathvalidate
```

- download a Piper model into `models/piper/`
- default model used by this repo:
  - `models/piper/de_DE-thorsten-medium.onnx`
  - `models/piper/de_DE-thorsten-medium.onnx.json`

Default:

- `TTS_PROVIDER=say`
- local macOS voice via `say`

Optional:

- `TTS_PROVIDER=elevenlabs`
- requires `ELEVENLABS_API_KEY`
- requires `ELEVENLABS_VOICE_ID`
- does not require the local `say` binary for startup checks

## Speech-to-text tuning

Recommended for better accuracy:

- point `WHISPER_MODEL_PATH` to a stronger Whisper model if your machine can handle it
- leave `WHISPER_LANGUAGE=auto` if you switch between German and English
- set `WHISPER_LANGUAGE=de` or `WHISPER_LANGUAGE=en` only if you want to optimize for one language

## Known setup caveats

- Successful startup only confirms the expected env vars, binaries, and Whisper model are present.
- It does not prove Discord voice receive will work in your runtime environment.
- It also does not prove every Hermes provider/model/toolset combination will succeed for a real prompt.
- Real verification still requires a manual smoke test in a Discord voice channel; see `docs/USAGE.md`.
- `/help` in Discord is the easiest way to discover commands, info, and doctor output after startup.
