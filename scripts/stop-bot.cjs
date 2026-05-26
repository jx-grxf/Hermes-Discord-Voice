#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const lockFile = path.resolve(__dirname, '..', 'tmp', 'bot.lock');

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeLock() {
  fs.rmSync(lockFile, { force: true });
}

if (!fs.existsSync(lockFile)) {
  console.log('Hermes-Discord-Voice is not locked.');
  process.exit(0);
}

const raw = fs.readFileSync(lockFile, 'utf8').trim();
const pid = Number(raw);

if (!Number.isFinite(pid) || pid <= 0) {
  removeLock();
  console.log('Removed invalid bot lock.');
  process.exit(0);
}

if (!pidExists(pid)) {
  removeLock();
  console.log(`Removed stale bot lock for pid ${pid}.`);
  process.exit(0);
}

process.kill(pid, 'SIGTERM');
setTimeout(() => {
  if (!pidExists(pid)) {
    removeLock();
    console.log(`Stopped Hermes-Discord-Voice process ${pid}.`);
    process.exit(0);
  }

  console.error(`Process ${pid} is still running. Stop it manually if it does not exit.`);
  process.exit(1);
}, 1_500);
