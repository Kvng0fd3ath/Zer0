'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchWake, buildPattern } = require('../src/renderer/wake-word.js');
const { createEndpointer } = require('../src/renderer/endpointer.js');

test('matches the wake phrase with commas, punctuation and case variations', () => {
  assert.deepEqual(matchWake('Hey, Zero, what time is it?', 'Hey Zero'), { matched: true, command: 'what time is it?' });
  assert.deepEqual(matchWake('hey zero', 'Hey Zero'), { matched: true, command: '' });
  assert.deepEqual(matchWake('HEY ZERO!', 'Hey Zero'), { matched: true, command: '' });
  assert.deepEqual(matchWake('Hey Zero.', 'Hey Zero'), { matched: true, command: '' });
});

test('treats "0" and "o" as the same letter (Whisper writes both)', () => {
  assert.equal(matchWake('hey zer0 text mom hi', 'Hey Zero').command, 'text mom hi');
  assert.equal(matchWake('Hey Zeero, call dad', 'Hey Zero').matched, false);
});

test('does not fire on similar words, or on the name without "hey"', () => {
  assert.equal(matchWake('Hey hero, that was great', 'Hey Zero').matched, false);
  assert.equal(matchWake('say hey zerolicious', 'Hey Zero').matched, false);
  assert.equal(matchWake('zero hey', 'Hey Zero').matched, false);
  assert.equal(matchWake('the zero point is fine', 'Hey Zero').matched, false);
  assert.equal(matchWake('', 'Hey Zero').matched, false);
  assert.equal(matchWake('   ', 'Hey Zero').matched, false);
});

test('a number near the phrase is not mangled in the command', () => {
  const m = matchWake('Hey Zero, call 10 times', 'Hey Zero');
  assert.equal(m.command, 'call 10 times');
});

test('custom phrases work and regex characters are escaped', () => {
  assert.equal(matchWake('computer, open mail', 'Computer').command, 'open mail');
  assert.equal(matchWake('wake (up) now', 'wake (up)').matched, true);
  assert.ok(buildPattern('a+b'));
  assert.equal(buildPattern(''), null);
});

test('endpointer: onset, end on silence, and valid flag', () => {
  const events = [];
  const ep = createEndpointer({
    threshold: 0.02,
    onsetMs: 100,
    minSpeechMs: 300,
    silenceMs: 500,
    onStart: (e) => events.push(['start', e.at]),
    onEnd: (e) => events.push(['end', e.valid]),
  });
  let t = 0;
  const tick = (level, n) => { for (let i = 0; i < n; i += 1) { t += 50; ep.feed(level, t); } };
  tick(0.001, 4);      // silence
  tick(0.05, 3);       // 100ms+ of voice: onset confirmed
  assert.equal(ep.speaking, true);
  tick(0.05, 10);      // 500ms of speech
  tick(0.0, 9);        // 450ms of quiet: not yet
  assert.equal(ep.speaking, true);
  tick(0.0, 2);        // past silenceMs
  assert.equal(ep.speaking, false);
  assert.equal(events[0][0], 'start');
  assert.deepEqual(events[1], ['end', true]);
});

test('endpointer: short blips are discarded (valid=false)', () => {
  const ends = [];
  const ep = createEndpointer({ threshold: 0.02, onsetMs: 50, minSpeechMs: 300, silenceMs: 200, onEnd: (e) => ends.push(e.valid) });
  let t = 0;
  const tick = (level, n) => { for (let i = 0; i < n; i += 1) { t += 50; ep.feed(level, t); } };
  tick(0.05, 3);       // ~150ms of sound
  tick(0.0, 6);        // silence
  assert.deepEqual(ends, [false]);
});

test('endpointer: utterances are capped at maxMs', () => {
  const ends = [];
  const ep = createEndpointer({ threshold: 0.02, onsetMs: 0, minSpeechMs: 100, silenceMs: 10_000, maxMs: 1000, onEnd: (e) => ends.push(e) });
  let t = 0;
  for (let i = 0; i < 40; i += 1) { t += 50; ep.feed(0.5, t); }
  assert.equal(ends.length >= 1, true);
  assert.equal(ends[0].valid, true);
});

test('endpointer: reset aborts an utterance in progress without a valid end', () => {
  const ends = [];
  const ep = createEndpointer({ threshold: 0.02, onsetMs: 0, minSpeechMs: 100, onEnd: (e) => ends.push(e.valid) });
  ep.feed(0.5, 0); ep.feed(0.5, 50); ep.feed(0.5, 100);
  assert.equal(ep.speaking, true);
  ep.reset();
  assert.equal(ep.speaking, false);
  assert.deepEqual(ends, [false]);
});
