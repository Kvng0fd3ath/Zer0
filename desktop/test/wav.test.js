'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// wav.js is a browser script, so run it in a sandbox with a fake window.
function loadWav() {
  const sandbox = { window: {}, Blob: globalThis.Blob, DataView, ArrayBuffer, Uint8Array, Math };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'wav.js'), 'utf8'), sandbox);
  return sandbox.window.Zer0Wav;
}

test('encodeWav16 writes a valid 16 kHz mono 16-bit WAV header', () => {
  const { encodeWav16 } = loadWav();
  const buf = encodeWav16(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
  const v = new DataView(buf);
  const text = (o, n) => Buffer.from(buf, o, n).toString('ascii');
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(text(12, 4), 'fmt ');
  assert.equal(v.getUint16(20, true), 1, 'PCM');
  assert.equal(v.getUint16(22, true), 1, 'mono');
  assert.equal(v.getUint32(24, true), 16000, 'sample rate');
  assert.equal(v.getUint16(34, true), 16, 'bits per sample');
  assert.equal(text(36, 4), 'data');
  assert.equal(v.getUint32(40, true), 10, 'five 16-bit samples');
  assert.equal(v.getUint32(4, true), 36 + 10, 'RIFF size');
  assert.equal(buf.byteLength, 54);
});

test('encodeWav16 clamps and scales samples', () => {
  const { encodeWav16 } = loadWav();
  const buf = encodeWav16(new Float32Array([0, 1, -1, 2, -2]), 16000);
  const v = new DataView(buf);
  assert.equal(v.getInt16(44, true), 0);
  assert.equal(v.getInt16(46, true), 32767);
  assert.equal(v.getInt16(48, true), -32768);
  assert.equal(v.getInt16(50, true), 32767, 'values above 1 clamp');
  assert.equal(v.getInt16(52, true), -32768, 'values below -1 clamp');
});
