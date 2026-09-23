'use strict';

// Leveled, optionally file-backed logging.
//   configure({ level, file }) — call once at startup
//   log('TAG', 'msg', data)    — info
//   log.warn / log.error / log.debug

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_NAMES = ['debug', 'info', 'warn', 'error'];

let minLevel = 'info';
let logFile = null;
const FILE_MAX_BYTES = 5 * 1024 * 1024; // rotate at 5 MB

function configure({ level = 'info', file = null } = {}) {
  minLevel = LEVEL_NAMES.includes(level) ? level : 'info';
  if (file) {
    logFile = path.resolve(file);
    if (!fs.existsSync(path.dirname(logFile))) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
    }
  }
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size < FILE_MAX_BYTES) return;
    fs.renameSync(logFile, `${logFile}.old`);
  } catch { /* file missing/inaccessible — ignore */ }
}

function emit(line) {
  console.log(line);
  if (logFile) {
    try {
      rotateIfNeeded();
      fs.appendFileSync(logFile, `${line}\n`, 'utf-8');
    } catch { /* logging must never crash the bot */ }
  }
}

function logRaw(level, tag, msg, data) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const ts = new Date().toISOString();
  const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
  emit(`[${ts}] [${level.toUpperCase()}] [${tag}] ${msg}${suffix}`);
}

function log(tag, msg, data) {
  logRaw('info', tag, msg, data);
}
log.debug = (tag, msg, data) => logRaw('debug', tag, msg, data);
log.warn = (tag, msg, data) => logRaw('warn', tag, msg, data);
log.error = (tag, msg, data) => logRaw('error', tag, msg, data);

function banner(lines) {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const line of lines) console.log(`  ${line}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

module.exports = { configure, log, banner };