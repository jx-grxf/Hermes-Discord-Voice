# Security Policy

## Supported scope
This project is intended for self-hosted or otherwise trusted environments. It is not positioned as a hardened multi-tenant service.

## Sensitive data
- `.env` contains secrets and must never be committed.
- Rotate tokens immediately if exposed.

## Trust model

- Anyone allowed to invoke the bot can trigger local transcription, local TTS generation, and a local `openclaw` CLI call on the host machine.
- Treat Discord bot access as equivalent to granting access to this automation path.
- Restrict usage to trusted servers, channels, and users.

## Minimum hardening checklist
- Use least-privilege Discord bot permissions
- Keep host OS and dependencies updated
- Restrict host access and local tool capabilities where possible
- Avoid exposing the bot to untrusted guilds or public invite flows
- Store logs without secrets or user transcripts unless you intentionally need them
- Review the security posture of the local OpenClaw environment separately from this bridge

## Reporting
If you find a security issue, open a private report to the maintainer before public disclosure.
