# Usage

This bridge is best treated as an experimental self-hosted tool. The happy path is short, but real voice capture depends on Discord runtime conditions and local machine setup.

## Normal flow

1. Join a Discord voice channel.
2. Run `/join`.
3. Run `/listen` and speak after the bot says it is listening.
4. The bot transcribes the turn, sends it to Hermes, and plays the spoken reply.

## Commands

- `/join` - join your voice channel and create a fresh Hermes voice session for this joined connection
- `/listen` - process exactly one spoken turn from the invoking user
- `/debugtext` - send a text prompt directly into the active voice session, optionally without TTS playback
- `/voice-verbose` - mirror tool calls and background execution details into a separate Discord thread
- `/leave` - disconnect the voice connection
- `/info` - show voice status, in-memory session status, and dependency health
- `/help` - open the interactive help menu with buttons for Commands, Info, and Doctor
- `/ping` - simple reachability check

## Session behavior

- The bridge keeps one active Hermes voice session per guild while it is connected to voice.
- `/join` creates a fresh Hermes conversation key for that voice connection.
- Later `/listen` calls reuse the same active voice session until `/leave`.
- `/leave` disconnects the bot and clears the bridge's in-memory voice session reference.
- After a bot restart, the bridge rebuilds state in memory as users interact again.
- Hermes may keep its own CLI/API history under `~/.hermes`; this bridge does not delete it.

## Known limitations

- Reply playback can use a custom Hermes TTS command, Piper, macOS `say`, or ElevenLabs.
- Auto-listen is still beta-grade and should be treated as an experimental convenience mode.
- Voice receive is sensitive to mute/deafen state, push-to-talk or voice activity, channel permissions, and when the speaker starts talking.
- `/listen` is a one-turn interaction, not a continuous streaming conversation mode.
- End-to-end validation remains a manual smoke test, not a fully automated integration test.
- Verbose mode is best-effort and depends on what the local Hermes runtime exposes for the current session.

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

### No Hermes reply

- Check locally that `hermes chat -q "hello" -Q` works.
- Confirm your configured Hermes provider/model/toolsets are healthy.
- Check `/info` for the active Hermes conversation key and any returned response id.
- If you also inspect `hermes sessions`, treat that as a local Hermes diagnostic, not as a guarantee provided by this bridge.

### No playback

- Check the bot's voice-channel permissions.
- If `TTS_PROVIDER=hermes`, check that `HERMES_TTS_COMMAND` writes a playable audio file to its first argument.
- If `TTS_PROVIDER=piper`, check that `tools/piper-venv/bin/python` exists and `PIPER_MODEL_PATH` points to a real `.onnx` model.
- If `TTS_PROVIDER=say`, check that `say` works on macOS with your chosen `TTS_VOICE` and `TTS_RATE`.
- If `TTS_PROVIDER=elevenlabs`, check that `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` are valid.

## Smoke test checklist

This is still a manual end-to-end check:

1. Run `npm run build`.
2. Run `npm start`.
3. In Discord, run `/info` or `/help` -> `Doctor` and confirm all dependencies show as `OK`.
4. Join a normal voice channel and run `/join`.
5. Confirm `/join` shows a fresh Hermes conversation key for the newly created voice session.
6. Run `/listen`, wait for the prompt, then speak one short sentence.
7. Confirm the reply shows your transcript and the same Hermes conversation key that `/join` created.
8. Optionally run `hermes sessions` locally to inspect Hermes-side history.
9. Run `/leave` and confirm the bot disconnects cleanly.
10. Optionally enable `/voice-verbose` and verify a tool-heavy prompt creates thread updates while the final answer still lands in the main channel.
