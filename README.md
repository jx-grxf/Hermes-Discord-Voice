<div align="center">

# 🎙️ OpenClaw-Discord-Voice

**Experimental, self-hosted Discord voice bridge for OpenClaw**

![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)
![Discord.js](https://img.shields.io/badge/Discord.js-14-5865F2?logo=discord&logoColor=white)
![Whisper](https://img.shields.io/badge/Whisper-STT-412991?logo=openai&logoColor=white)
![ffmpeg](https://img.shields.io/badge/ffmpeg-audio-007808?logo=ffmpeg&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-TTS-000000?logo=apple&logoColor=white)
![dotenv](https://img.shields.io/badge/dotenv-config-ECD53F?logo=dotenv&logoColor=black)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

OpenClaw-Discord-Voice connects a Discord voice channel to a local OpenClaw session: it captures one spoken turn, transcribes it locally, sends the transcript to OpenClaw, and plays the reply back into the channel.

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
| 🎙️ | Discord slash-command voice bridge for local OpenClaw sessions |
| 🧠 | Local speech-to-text with Whisper CLI |
| 🔊 | Switchable TTS: OpenClaw, Piper, macOS `say`, or ElevenLabs |
| 🧵 | Optional verbose thread for tool calls and background execution details |
| 🩺 | Built-in health check via `npm run doctor:bridge` and `/info` |
| 🧪 | Debug helper `/debugtext` for text-only session testing |

---

## 🌍 Scope

- **Self-hosted only**
- **Environment-sensitive**: depends on local binaries, PATH, macOS runtime, Discord voice state, and your local OpenClaw setup
- **Best for trusted setups** rather than public multi-tenant hosting
- **Live voice behavior still needs real smoke testing** in an actual Discord call

---

## 🛠️ Tech Stack

| Layer | Technologies |
|---|---|
| **Bot runtime** | Node.js 22+, TypeScript, Discord.js 14 |
| **Voice pipeline** | Discord Voice, Opus decode, PCM → WAV via `ffmpeg` |
| **Speech-to-text** | `whisper-cli` with local GGML models |
| **OpenClaw bridge** | local `openclaw` CLI + gateway |
| **Text-to-speech** | OpenClaw gateway TTS, Piper, macOS `say`, or ElevenLabs |

---

## 📋 Requirements

- **macOS**
- **Node.js** `20+`
- **openclaw**
- **ffmpeg**
- **whisper-cli**
- Whisper model at `models/ggml-base.bin` or another configured path
- Discord bot credentials for a single-guild setup

If you are starting from scratch, install and verify OpenClaw first. This bridge assumes OpenClaw is already healthy locally before Discord is added on top.

---

## 🧩 Dependency Matrix

| Dependency | Required | Why it exists | Notes |
|---|---|---|---|
| `openclaw` | Yes | Backend session + agent execution | Must already work locally |
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
- `openclaw`
- `ffmpeg`
- `whisper-cli`
- the configured Whisper model path

Depending on `TTS_PROVIDER`, it also checks:

- `say`, when `TTS_PROVIDER=say`
- the configured Piper binary and model path, when `TTS_PROVIDER=piper`
- OpenClaw gateway access, when `TTS_PROVIDER=openclaw`

---

## 🚀 Quick Start

```bash
git clone https://github.com/jx-grxf/OpenClaw-Discord-Voice.git
cd OpenClaw-Discord-Voice
brew install node
npm install
cp .env.example .env
npm run doctor:bridge
npm run dev
```

This quick start only works if these are already true:

- a working local `openclaw` installation
- Node.js `>=22.12.0`
- `ffmpeg`, `whisper-cli`, and either OpenClaw TTS, Piper, macOS `say`, or ElevenLabs
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
| `OPENCLAW_VOICE_AGENT_ID` | Dedicated OpenClaw voice agent namespace, default `discord-voice`; keep it separate from `main` so heartbeats cannot bleed into voice replies |

### Voice and TTS

| Variable | Purpose |
|---|---|
| `TTS_PROVIDER` | `openclaw`, `piper`, `say`, or `elevenlabs`; `.env.example` starts with `piper`, code fallback is `say` |
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
| `/join` | Join your current voice channel and prepare or reuse the active OpenClaw voice session |
| `/listen` | Capture one spoken turn and send it to OpenClaw |
| `/leave` | Disconnect the bot and request OpenClaw session cleanup |
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
5. Confirm the embed shows a session key and session id
6. Run `/listen`, wait for the prompt, then speak one short sentence
7. Confirm the bot posts your transcript and an OpenClaw reply
8. Switch TTS inside `/join` if you want to compare `OpenClaw`, `Piper`, `Say`, or `ElevenLabs`
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
- whether OpenClaw tool calls will succeed for a specific prompt
- whether cleanup will succeed for every local gateway/session edge case

That is why the manual smoke test still matters.

---

## 🧠 Architecture

1. Receive a Discord slash command
2. Read audio from the invoking user in the voice channel
3. Decode Opus to PCM
4. Convert PCM to WAV with `ffmpeg`
5. Transcribe WAV with `whisper-cli`
6. Send the transcript to OpenClaw with the active voice `sessionKey`
7. Generate speech with the selected TTS provider and play it back in Discord

---

## 🔄 Session Behavior

- The bridge keeps **one active voice session per guild** while the bot stays connected.
- `/join` creates or reuses the active OpenClaw voice session for that voice connection.
- `/listen` reuses that session for follow-up turns until `/leave`.
- `/leave` disconnects the bot and asks OpenClaw to delete/archive the session.
- Whether the session still appears inside `openclaw sessions` depends on the local OpenClaw runtime and cleanup success, not just the Discord bridge.

---

## ⚠️ Known Limitations

- `say` is **macOS-only**
- OpenClaw TTS delegates synthesis to the running OpenClaw gateway
- Piper is local and free, but you still need the model + Python environment installed
- Discord voice receive is sensitive to real runtime conditions such as mute/deafen state, permissions, push-to-talk, and who is speaking
- Session continuity still depends on what the local OpenClaw runtime returns
- End-to-end validation is still primarily a **manual live Discord smoke test**
