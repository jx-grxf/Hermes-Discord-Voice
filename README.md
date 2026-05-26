<div align="center">

# 🎙️ Hermes-Discord-Voice

**Experimental, self-hosted Discord voice bridge for Hermes**

![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)
![Discord.js](https://img.shields.io/badge/Discord.js-14-5865F2?logo=discord&logoColor=white)
![Whisper](https://img.shields.io/badge/Whisper-STT-412991?logo=openai&logoColor=white)
![ffmpeg](https://img.shields.io/badge/ffmpeg-audio-007808?logo=ffmpeg&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-TTS-000000?logo=apple&logoColor=white)
![dotenv](https://img.shields.io/badge/dotenv-config-ECD53F?logo=dotenv&logoColor=black)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

Hermes-Discord-Voice connects a Discord voice channel to a local Hermes session: it captures one spoken turn, transcribes it locally, sends the transcript to Hermes, and plays the reply back into the channel.

It is built for self-hosted, personal, or small trusted setups, not as a polished hosted SaaS product.

---

## Contents

- [Highlights](#-highlights)
- [Scope](#-scope)
- [Tech Stack](#-tech-stack)
- [Requirements](#-requirements)
- [Dependency Matrix](#-dependency-matrix)
- [Quick Start](#-quick-start)
- [Configuration](#-configuration)
- [Commands](#-commands)
- [Scripts](#-scripts)
- [Smoke Test](#-smoke-test)
- [Doctor Coverage](#-doctor-coverage)
- [Architecture](#-architecture)
- [Session Behavior](#-session-behavior)
- [Known Limitations](#-known-limitations)

---

## ✨ Highlights

| | Feature |
|---|---|
| 🎙️ | Discord slash-command voice bridge for local Hermes sessions |
| 🧠 | Local speech-to-text with Whisper CLI |
| 🔊 | Switchable TTS: Hermes, Piper, macOS `say`, or ElevenLabs |
| 🧵 | Optional verbose thread for tool calls and background execution details |
| 🩺 | Built-in health check via `npm run doctor:bridge` and `/info` |
| 🧪 | Debug helper `/debugtext` for text-only session testing |

---

## 🌍 Scope

- **Self-hosted only**
- **Environment-sensitive**: depends on local binaries, PATH, macOS runtime, Discord voice state, and your local Hermes setup
- **Best for trusted setups** rather than public multi-tenant hosting
- **Live voice behavior still needs real smoke testing** in an actual Discord call

---

## 🛠️ Tech Stack

| Layer | Technologies |
|---|---|
| **Bot runtime** | Node.js 22+, TypeScript, Discord.js 14 |
| **Voice pipeline** | Discord Voice, Opus decode, PCM → WAV via `ffmpeg` |
| **Speech-to-text** | `whisper-cli` with local GGML models |
| **Hermes bridge** | local `hermes` CLI by default, optional Hermes API server |
| **Text-to-speech** | Piper, macOS `say`, ElevenLabs, or a custom Hermes TTS command |

---

## 📋 Requirements

- **macOS**
- **Node.js** `20+`
- **hermes**
- **ffmpeg**
- **whisper-cli**
- Whisper model at `models/ggml-base.bin` or another configured path
- Discord bot credentials for a single-guild setup

If you are starting from scratch, install and verify Hermes first. This bridge assumes Hermes is already healthy locally before Discord is added on top.

---

## 🧩 Dependency Matrix

| Dependency | Required | Why it exists | Notes |
|---|---|---|---|
| `hermes` | Yes | Backend session + agent execution | Must already work locally |
| `ffmpeg` | Yes | PCM → WAV conversion | Checked by `doctor` |
| `whisper-cli` | Yes | Local STT | Needs a compatible model file |
| Whisper model | Yes | Speech recognition | Default is `models/ggml-base.bin` |
| `say` | No | Built-in macOS fallback TTS | Lowest quality, but zero setup |
| Piper runtime + model | No | Better local TTS | Recommended local option via `.env.example` |
| ElevenLabs API | No | Cloud TTS | Higher quality, costs credits |
| Discord bot token | Yes | Bot login | Local `.env` only |
| Discord guild id | Yes | Guild command registration | Single-guild focused |

At startup the bot checks:

- `DISCORD_TOKEN`
- `DISCORD_GUILD_ID`
- `hermes`
- `ffmpeg`
- `whisper-cli`
- the configured Whisper model path

Depending on `TTS_PROVIDER`, it also checks:

- `say`, when `TTS_PROVIDER=say`
- the configured Piper binary and model path, when `TTS_PROVIDER=piper`
- `HERMES_TTS_COMMAND`, when `TTS_PROVIDER=hermes`

---

## 🚀 Quick Start

```bash
git clone https://github.com/jx-grxf/Hermes-Discord-Voice.git
cd Hermes-Discord-Voice
brew install node
npm install
cp .env.example .env
npm run doctor:bridge
npm run dev
```

This quick start only works if these are already true:

- a working local `hermes` installation
- Node.js `>=22.12.0`
- `ffmpeg`, `whisper-cli`, and either Hermes TTS, Piper, macOS `say`, or ElevenLabs
- a Whisper model file in `models/`
- valid `DISCORD_TOKEN` and `DISCORD_GUILD_ID` values in `.env`

If any of those are missing, use the detailed setup guide first:

More details:

- [docs/INSTALLATION.md](docs/INSTALLATION.md)
- [docs/USAGE.md](docs/USAGE.md)

---

## ⚙️ Configuration

### Required

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Bot token |
| `DISCORD_GUILD_ID` | Guild where slash commands are registered |

### Hermes Backend

| Variable | Purpose |
|---|---|
| `HERMES_TRANSPORT` | `cli` by default; set `api` to use the local Hermes API server |
| `HERMES_CLI` | Hermes executable, default `hermes` |
| `HERMES_PROVIDER` | Optional provider override passed to Hermes CLI |
| `HERMES_MODEL` | Optional model override for Hermes CLI/API |
| `HERMES_TOOLSETS` | Optional comma-separated Hermes toolsets |
| `HERMES_SKILLS` | Optional comma-separated Hermes skills |
| `HERMES_VOICE_SESSION_PREFIX` | Prefix for fresh per-join conversations, default `hermes-discord-voice` |
| `HERMES_API_BASE_URL` | Default `http://127.0.0.1:8642/v1` |
| `HERMES_API_KEY` | Required when `HERMES_TRANSPORT=api` |

### Voice and TTS

| Variable | Purpose |
|---|---|
| `TTS_PROVIDER` | `hermes`, `piper`, `say`, or `elevenlabs`; `.env.example` starts with `piper`, code fallback is `say` |
| `TTS_VOICE` | macOS `say` voice, default `Flo` |
| `TTS_RATE` | macOS `say` rate, default `220` |
| `PIPER_BINARY_PATH` | Piper runner path, default `tools/piper-venv/bin/python` |
| `PIPER_MODEL_PATH` | Piper model path, default `models/piper/de_DE-thorsten-medium.onnx` |
| `PIPER_SPEAKER` | Optional speaker id for multi-speaker Piper models |
| `ELEVENLABS_API_KEY` | Required for `TTS_PROVIDER=elevenlabs` |
| `ELEVENLABS_VOICE_ID` | Required for `TTS_PROVIDER=elevenlabs` |
| `ELEVENLABS_MODEL_ID` | Optional, default `eleven_multilingual_v2` |
| `ELEVENLABS_OUTPUT_FORMAT` | Optional, default `mp3_44100_128` |
| `ELEVENLABS_TIMEOUT_MS` | ElevenLabs request timeout, default `60000` |

### Speech Recognition

| Variable | Purpose |
|---|---|
| `WHISPER_MODEL_PATH` | Model path, default `models/ggml-base.bin` |
| `WHISPER_LANGUAGE` | `auto`, `de`, or `en` |
| `WHISPER_THREADS` | Optional manual CPU tuning |
| `VOICE_NO_AUDIO_TIMEOUT_MS` | Timeout before giving up on no audio |
| `VOICE_NO_SPEECH_TIMEOUT_MS` | Timeout for unclear/background-only speech |
| `VOICE_MAX_CAPTURE_MS` | Hard cap for one captured turn |
| `VOICE_JOIN_ATTEMPTS` | Discord voice join retry count, default `2` |
| `VOICE_JOIN_READY_TIMEOUT_MS` | Ready timeout per voice join attempt, default `10000` |

### Notes

- `DISCORD_CLIENT_ID` is **not required** anymore; the bot derives the application id from the logged-in client session.
- Local `.env` values override exported shell variables so the repo does not accidentally pick up credentials from another terminal session.

---

## 🧭 Commands

| Command | Description |
|---|---|
| `/join` | Join your current voice channel and prepare or reuse the active Hermes voice session |
| `/listen` | Capture one spoken turn and send it to Hermes |
| `/leave` | Disconnect the bot and clear the local voice session reference |
| `/voice-verbose` | Enable a separate Discord thread for tool calls and background execution details |
| `/debugtext` | Send plain text directly into the active voice session for debugging |
| `/info` | Show diagnostics, session state, talk mode, TTS, and bridge status |
| `/help` | Open the interactive help menu |
| `/ping` | Simple health check |

---

## 📜 Scripts

Run from the repository root:

| Command | Description |
|---|---|
| `npm run dev` | Start the bot in development mode |
| `npm run build` | Type-check and build the project |
| `npm test` | Run the test suite |
| `npm run doctor:bridge` | Check env, binaries, model path, and Discord auth |

---

## ✅ Smoke Test

Use this to verify a real end-to-end setup after `doctor` passes:

1. Run `npm run build`
2. Run `npm run dev`
3. In Discord, run `/info` and confirm env/binaries/model are healthy
4. Join a voice channel and run `/join`
5. Confirm the embed shows a fresh Hermes conversation key
6. Run `/listen`, wait for the prompt, then speak one short sentence
7. Confirm the bot posts your transcript and an Hermes reply
8. Switch TTS inside `/join` if you want to compare `Hermes`, `Piper`, `Say`, or `ElevenLabs`
9. Run `/leave` and confirm the bot disconnects cleanly

---

## 🩺 Doctor Coverage

`npm run doctor:bridge` is a fast health check, not a full runtime proof.

It validates:

- required env vars
- expected local binaries
- Whisper model path
- Discord bot auth

It does **not** validate:

- live Discord voice receive in your current channel
- Discord permissions/mute/deafen/runtime state
- whether Hermes tool calls will succeed for a specific prompt
- whether Hermes tool calls will succeed for a specific prompt

That is why the manual smoke test still matters.

---

## 🧠 Architecture

1. Receive a Discord slash command
2. Read audio from the invoking user in the voice channel
3. Decode Opus to PCM
4. Convert PCM to WAV with `ffmpeg`
5. Transcribe WAV with `whisper-cli`
6. Send the transcript to Hermes with the active voice conversation key
7. Generate speech with the selected TTS provider and play it back in Discord

---

## 🔄 Session Behavior

- The bridge keeps **one active voice session per guild** while the bot stays connected.
- `/join` creates a fresh Hermes conversation key for that voice connection.
- `/listen` reuses that session for follow-up turns until `/leave`.
- `/leave` disconnects the bot and clears the bridge's in-memory voice session reference.
- Hermes CLI/API may keep its own session history under `~/.hermes`; this bridge does not delete it.

---

## ⚠️ Known Limitations

- `say` is **macOS-only**
- `TTS_PROVIDER=hermes` delegates synthesis to a custom local command configured with `HERMES_TTS_COMMAND`
- Piper is local and free, but you still need the model + Python environment installed
- Discord voice receive is sensitive to real runtime conditions such as mute/deafen state, permissions, push-to-talk, and who is speaking
- Session continuity still depends on what the local Hermes runtime returns
- End-to-end validation is still primarily a **manual live Discord smoke test**
