#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node scripts/run-with-project-node.cjs <command> [...args]');
  process.exit(64);
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isSamePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function findExternalNode() {
  const pathCandidates = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, 'node'));
  const candidates = [
    process.env.OPENCLAW_NODE,
    ...pathCandidates,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ].filter(Boolean);

  const seen = new Set();
  return candidates.find((candidate) => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return isExecutable(candidate) && !isSamePath(candidate, process.execPath);
  });
}

function shouldPreferExternalNode() {
  return process.platform === 'darwin' && process.execPath.includes('/Applications/Codex.app/Contents/Resources/node');
}

const externalNode = findExternalNode();
const shouldUseExternalNode = Boolean(process.env.OPENCLAW_NODE) || shouldPreferExternalNode();
const selectedNode = shouldUseExternalNode ? externalNode : null;
const env = { ...process.env };

if (selectedNode) {
  const selectedNodeDir = path.dirname(selectedNode);
  env.PATH = `${selectedNodeDir}${path.delimiter}${env.PATH || ''}`;
  console.error(`Using ${selectedNode} for native Node addons.`);
}

const child = spawn(args[0], args.slice(1), {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error(`Failed to run ${args[0]}: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
