'use strict';

// Shared helpers: sleep, atomic JSON persistence, retry with backoff.

const fs = require('fs');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Safely read + parse a JSON file. Returns fallback on any error.
function readJsonFile(filePath, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data === null || data === undefined ? fallback : data;
  } catch {
    return fallback;
  }
}

// Atomic write: write to a temp file, then rename over the target.
// A crash mid-write can never corrupt the existing store file.
function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

// Retry an async operation with exponential backoff + jitter.
//
// opts:
//   attempts    — max attempts (default 3)
//   baseMs      — base delay before retry (default 500)
//   maxMs       — upper bound for backoff delay (default 8000)
//   shouldRetry — optional (err) => bool; false skips a retry
//   onRetry     — optional (err, attempt) => void for logging
async function retry(fn, opts = {}) {
  const {
    attempts = 3,
    baseMs = 500,
    maxMs = 8000,
    shouldRetry = () => true,
    onRetry = () => {},
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      const wait = Math.min(maxMs, baseMs * 2 ** (attempt - 1)) + Math.random() * 200;
      onRetry(err, attempt);
      await sleep(wait);
    }
  }
  throw lastErr;
}

module.exports = { sleep, readJsonFile, writeJsonAtomic, retry };