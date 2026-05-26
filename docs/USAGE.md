# Usage

This bridge is best treated as an experimental self-hosted tool. The happy path is short, but real voice capture depends on Discord runtime conditions and local machine setup.

## Normal flow

1. Join a Discord voice channel.
2. Run `/join`.
3. Run `/listen` and speak after the bot says it is listening.
4. The bot transcribes the turn, sends it to OpenClaw, and plays the spoken reply.

## Commands

- `/join` - join your voice channel and create a fresh OpenClaw voice session for this joined connection
- `/listen` - process exactly one spoken turn from the invoking user
- `/debugtext` - send a text prompt directly into the active voice session, optionally without TTS playback
- `/voice-verbose` - mirror tool calls and background execution details into a separate Discord thread
- `/leave` - disconnect the voice connection
- `/info` - show voice status, in-memory session status, and dependency health
- `/help` - open the interactive help menu with buttons for Commands, Info, and Doctor
- `/ping` - simple reachability check

## Session behavior

- The bridge keeps one active OpenClaw voice session per guild while it is connected to voice.
- `/join` creates that session immediately through the OpenClaw gateway.
- Later `/listen` calls reuse the same active voice session until `/leave`.
- `/leave` asks OpenClaw to delete/archive that voice session again.
- After a bot restart, the bridge rebuilds state in memory as users interact again.
- Do not assume that a prepared key or even a successful turn will always produce a visibly listed session in `openclaw sessions`; that depends on OpenClaw behavior outside this repo.

## Known limitations

- Reply playback can use OpenClaw gateway TTS, Piper, macOS `say`, or ElevenLabs.
- Auto-listen is still beta-grade and should be treated as an experimental convenience mode.
- Voice receive is sensitive to mute/deafen state, push-to-talk or voice activity, channel permissions, and when the speaker starts talking.
- `/listen` is a one-turn interaction, not a continuous streaming conversation mode.
- End-to-end validation remains a manual smoke test, not a fully automated integration test.
- Verbose mode is best-effort and depends on what the local OpenClaw runtime exposes for the current session.

## Troubleshooting

### `/join` or `/listen` fails immediately

- Make sure you are in a voice channel.
- Run `/info` and check for missing dependencies.
- Run `/help` -> `Doctor` or `npm run doctor:bridge` for a full bridge health check.
- If Discord returns a voice connect timeout, retry after a few seconds. If it repeats, switch the channel voice region or leave and rejoin the channel.

### `/listen` says no voice signal was received

- Start speaking only after the `/listen` prompt appears.
- Check Discord input settings, voice activity, and push-to-talk.
- Confirm your client is not muted and is actually transmitting audio.
- Confirm the bot can stay undeafened in the channel and has the expected voice permissions.
- Check the bot logs for `Speaking started`, `SSRC mapped`, and `First opus packet received`.
- If the bot waits too long on room noise, lower `VOICE_MAX_CAPTURE_MS` or `VOICE_NO_SPEECH_TIMEOUT_MS`.

### No transcription

- Check that `WHISPER_MODEL_PATH` points to a real model file.
- Check that `whisper-cli` is in `PATH`.
- Check that `ffmpeg` is in `PATH`.
- If you only speak one language most of the time, try setting `WHISPER_LANGUAGE=de` or `WHISPER_LANGUAGE=en`.
- If transcription feels slow, try a stronger model only if your machine can handle it, and tune `WHISPER_THREADS`.

### No OpenClaw reply

- Check locally that `openclaw agent --help` works.
- Confirm the local OpenClaw gateway and agent setup are healthy.
- Check `/info` for the session key and any returned session id.
- If a turn fails with a gateway close/1000 message, retry once before assuming the bridge state is broken; the local gateway can flake transiently.
- If you also inspect `openclaw sessions`, treat that as a local OpenClaw diagnostic, not as a guarantee provided by this bridge.

### No playback

- Check the bot's voice-channel permissions.
- If `TTS_PROVIDER=openclaw`, check `openclaw gateway call tts.status --json` and confirm OpenClaw TTS is configured.
- If `TTS_PROVIDER=piper`, check that `tools/piper-venv/bin/python` exists and `PIPER_MODEL_PATH` points to a real `.onnx` model.
- If `TTS_PROVIDER=say`, check that `say` works on macOS with your chosen `TTS_VOICE` and `TTS_RATE`.
- If `TTS_PROVIDER=elevenlabs`, check that `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` are valid.

## Smoke test checklist

This is still a manual end-to-end check:

1. Run `npm run build`.
2. Run `npm start`.
3. In Discord, run `/info` or `/help` -> `Doctor` and confirm all dependencies show as `OK`.
4. Join a normal voice channel and run `/join`.
5. Confirm `/join` shows an OpenClaw key and session id for the newly created voice session.
6. Run `/listen`, wait for the prompt, then speak one short sentence.
7. Confirm the reply shows your transcript and the same OpenClaw key/session id that `/join` created.
8. Optionally run `openclaw sessions` locally and confirm the voice session exists while connected.
9. Run `/leave` and confirm the bot disconnects and the voice session disappears or is archived on the OpenClaw side.
10. Optionally enable `/voice-verbose` and verify a tool-heavy prompt creates thread updates while the final answer still lands in the main channel.
