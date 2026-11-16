'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Small JSON file helpers. When a codec with async methods is given (the app's safeStorage codec),
 * the file is encrypted at rest. Without one (tests), it is plain JSON.
 */
async function readJsonFile(file, codec) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const text = codec?.decryptAsync ? await codec.decryptAsync(raw) : raw;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeJsonFile(file, data, codec) {
  const text = JSON.stringify(data);
  const out = codec?.encryptAsync ? await codec.encryptAsync(text) : text;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = { readJsonFile, writeJsonFile };
