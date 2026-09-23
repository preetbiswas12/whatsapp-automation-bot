'use strict';

// Small shared helpers.

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

module.exports = { sleep, readJsonFile };