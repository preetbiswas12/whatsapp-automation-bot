#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WAA AI Bot — Process supervisor
//
//  Runs bot.js as a child process and restarts it on unexpected exit with
//  exponential backoff. Use `npm run start:prod`. For richer features
//  (log rotation, clustering) run PM2 with ecosystem.config.js instead.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { spawn } = require('child_process');
const path = require('path');

const BOT_PATH = path.join(__dirname, 'bot.js');
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

let child = null;
let restarts = 0;
let stopping = false;

function start() {
  child = spawn(process.execPath, [BOT_PATH], { stdio: 'inherit' });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) {
      console.log('[supervisor] stopping.');
      process.exit(0);
      return;
    }

    restarts += 1;
    const backoff = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.min(restarts - 1, 5));
    console.log(
      `[supervisor] bot exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}) — ` +
      `restart #${restarts} in ${backoff}ms`
    );
    setTimeout(start, backoff);
  });

  child.on('error', err => {
    console.error(`[supervisor] failed to spawn bot: ${err.message}`);
    stopping = true;
    process.exit(1);
  });
}

function stop(signal) {
  stopping = true;
  if (child) child.kill(signal);
  else process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

console.log(`[supervisor] starting ${BOT_PATH}`);
start();