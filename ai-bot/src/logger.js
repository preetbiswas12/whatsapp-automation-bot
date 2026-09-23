'use strict';

// Tiny timestamped console logger shared by every module.

function log(tag, msg, data) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] [${tag}] ${msg}`;
  console.log(data ? `${line} ${JSON.stringify(data)}` : line);
}

function banner(lines) {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const line of lines) console.log(`  ${line}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

module.exports = { log, banner };