# Hermes-Discord-Voice

[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)
[![Whisper](https://img.shields.io/badge/Whisper-STT-412991?logo=openai&logoColor=white)](https://github.com/ggerganov/whisper.cpp)
[![ffmpeg](https://img.shields.io/badge/ffmpeg-audio-007808?logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)
[![macOS](https://img.shields.io/badge/macOS-TTS-000000?logo=apple&logoColor=white)](https://www.apple.com/macos/)
[![dotenv](https://img.shields.io/badge/dotenv-config-ECD53F?logo=dotenv&logoColor=black)](https://github.com/motdotla/dotenv)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Self-hosted Discord voice bridge for Hermes. The bot joins a Discord voice channel, records a spoken turn, transcribes it locally with Whisper, sends the text to Hermes, and plays the reply back through the selected TTS provider.

This project is intended for personal and small trusted Discord servers. It is not a hosted multi-tenant service.

## Features

| Area | Support |
|---|---|
| Discord | Guild slash commands, voice join/leave, voice playback, ephemeral control embeds |
| Speech to text | Local `whisper-cli` with configurable model, language, and timing |
| Hermes | CLI transport by default, optional Hermes API/Gateway transport |
| TTS | Piper, macOS `say`, ElevenLabs, or custom Hermes TTS command |
| Sessions | One active voice session per guild, fresh Hermes sessions on `/join` and `/new-voice-session` |
| Access control | Voice input is private by default; `/voice-allowlist` adds or removes session speakers |
| Diagnostics | `npm run doctor:bridge`, `/info`, `/help`, `/debugtext`, optional verbose thread |

## Requirements

- macOS
- Node.js 20+
- `hermes`
- `ffmpeg`
- `whisper-cli`
- A Whisper GGML model file
- Discord bot token and test guild id
- One TTS provider: Piper, macOS `say`, ElevenLabs, or `HERMES_TTS_COMMAND`

Install and verify Hermes before starting this bridge. At minimum, `hermes --help` and `hermes chat -q "hello" -Q` should work locally.

## Quick Start

```bash
git clone https://github.com/jx-grxf/Hermes-Discord-Voice.git
cd Hermes-Discord-Voice
npm install
cp .env.example .env
npm run doctor:bridge
npm run dev
```

The bot registers guild slash commands automatically on startup.

Detailed setup:

- [docs/INSTALLATION.md](docs/INSTALLATION.md)
- [docs/USAGE.md](docs/USAGE.md)

## Discord Permissions

The invite should include the `bot` and `applications.commands` scopes.

Recommended bot permissions:

| Permission | Required for |
|---|---|
| View Channels | Finding command and voice channels |
| Send Messages | Public status and thread updates |
| Use Application Commands | Slash command execution |
| Connect | Joining voice |
| Speak | Playing TTS replies |
| Read Message History | Thread and status context |

The bot does not need Administrator. Session allowlist management is available to the session creator, server administrators, and members with `Manage Channels`.

## Configuration

Required:

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Discord bot token |
| `DISCORD_GUILD_ID` | Guild where slash commands are registered |

Hermes:

| Variable | Purpose |
|---|---|
| `HERMES_TRANSPORT` | `cli` by default; set `api` for Hermes API/Gateway mode |
| `HERMES_CLI` | Hermes executable, default `hermes` |
| `HERMES_PROVIDER` | CLI-mode provider override |
| `HERMES_MODEL` | Model override where supported |
| `HERMES_TOOLSETS` | CLI-mode comma-separated toolset override |
| `HERMES_SKILLS` | CLI-mode comma-separated skill override |
| `HERMES_SOURCE` | CLI source label, default `discord-voice` |
| `HERMES_TIMEOUT_MS` | Hermes turn timeout |
| `HERMES_VOICE_SESSION_PREFIX` | Prefix for generated Discord voice conversation keys |
| `HERMES_VOICE_INSTRUCTIONS` | Optional voice-specific instructions sent to Hermes |
| `HERMES_API_BASE_URL` | API base URL, default `http://127.0.0.1:8642/v1` |
| `HERMES_API_KEY` | Bearer token for API mode |

Transport notes:

- CLI mode passes `HERMES_PROVIDER`, `HERMES_MODEL`, `HERMES_TOOLSETS`, and `HERMES_SKILLS` to the local Hermes CLI.
- API mode sends the prompt, model, conversation metadata, voice instructions, and `X-Hermes-Session-Key`. Providers, tools, and skills are resolved by the Hermes API/Gateway configuration.

Voice and TTS:

| Variable | Purpose |
|---|---|
| `TTS_PROVIDER` | `piper`, `say`, `elevenlabs`, or `hermes` |
| `TTS_VOICE` | macOS `say` voice |
| `TTS_RATE` | macOS `say` rate |
| `PIPER_BINARY_PATH` | Piper runner path |
| `PIPER_MODEL_PATH` | Piper `.onnx` model path |
| `PIPER_SPEAKER` | Optional Piper speaker id |
| `ELEVENLABS_API_KEY` | Required for ElevenLabs |
| `ELEVENLABS_VOICE_ID` | Required for ElevenLabs |
| `ELEVENLABS_MODEL_ID` | ElevenLabs model id |
| `ELEVENLABS_OUTPUT_FORMAT` | ElevenLabs audio format |
| `ELEVENLABS_TIMEOUT_MS` | ElevenLabs request timeout |
| `HERMES_TTS_COMMAND` | Command used when `TTS_PROVIDER=hermes` |

Speech recognition:

| Variable | Purpose |
|---|---|
| `WHISPER_MODEL_PATH` | Whisper model path |
| `WHISPER_LANGUAGE` | `auto`, `de`, or `en` |
| `WHISPER_THREADS` | Optional Whisper CPU tuning |
| `VOICE_NO_AUDIO_TIMEOUT_MS` | Timeout before no-audio failure |
| `VOICE_NO_SPEECH_TIMEOUT_MS` | Timeout for unclear/background-only speech |
| `VOICE_SILENCE_END_MS` | Silence duration that ends one captured turn, default `1200` |
| `VOICE_MAX_CAPTURE_MS` | Hard cap for one captured turn; `0` disables |
| `VOICE_JOIN_ATTEMPTS` | Discord voice join retry count |
| `VOICE_JOIN_READY_TIMEOUT_MS` | Ready timeout per join attempt |
| `VOICE_AUTO_INTERRUPT_MIN_SPEECH_MS` | Minimum speech duration before auto-listen interrupts playback |

## Commands

| Command | Description |
|---|---|
| `/join` | Join your current voice channel and create or refresh the active voice session |
| `/listen` | Capture one spoken turn from an allowed speaker |
| `/stop-voice` | Stop current playback, TTS generation, or active Hermes run |
| `/interrupt` | Alias-style user interruption for active playback or run |
| `/new-voice-session` | Start a fresh Hermes conversation while the bot stays in voice |
| `/voice-allowlist` | Add or remove users who may speak into the active session |
| `/voice-verbose` | Send Hermes turn and tool details to a separate Discord thread |
| `/debugtext` | Send text into the active voice session for debugging |
| `/info` | Show bridge, dependency, session, and access status |
| `/leave` | Disconnect and clear the in-memory voice session |
| `/help` | Open interactive help |
| `/ping` | Basic bot reachability check |

## Session and Access Model

- The bridge keeps one active voice session per guild.
- `/join` creates a fresh Hermes conversation key.
- `/new-voice-session` replaces the Hermes conversation key without leaving voice.
- `/listen` and auto-listen accept speech only from allowlisted users.
- A new session starts with only the creator in the allowlist.
- The creator cannot be removed from the allowlist.
- `/leave` clears the in-memory session and allowlist.
- Hermes may keep its own CLI/API history under `~/.hermes`; this bridge does not delete it.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the bot in development mode |
| `npm run build` | Type-check and build |
| `npm test` | Run the test suite |
| `npm run doctor:bridge` | Check env, binaries, model path, and Discord auth |
| `npm start` | Run the built bot |

## Smoke Test

1. Run `npm run doctor:bridge`.
2. Run `npm run dev`.
3. In Discord, run `/info`.
4. Join a voice channel and run `/join`.
5. Confirm the embed shows the current session, TTS provider, and speaker allowlist.
6. Run `/listen`, wait for the prompt, then speak.
7. Confirm the bot posts transcript, Hermes reply, session id, and plays audio.
8. Run `/voice-allowlist` if another user should speak.
9. Run `/new-voice-session` to reset Hermes context without disconnecting.
10. Run `/leave` when finished.

## Known Limitations

- Live Discord voice behavior depends on channel permissions, mute/deafen state, push-to-talk, client voice activity, and Discord receive timing.
- Auto-listen is still beta-grade and may need per-room timing adjustment.
- `say` is macOS-only.
- Piper requires a local Python runtime and model files.
- ElevenLabs uses a remote API and may incur cost.
- End-to-end validation still requires a real Discord voice smoke test.
