'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalize, levenshtein, match, closest } = require('./matcher');

const answers = [
  { text: 'Listen', points: 38, aliases: ['paying attention', 'pay attention'] },
  { text: 'Work', points: 22, aliases: [] },
  { text: 'Coffee mug', points: 15 },
  { text: 'Refrigerator', points: 10, aliases: ['fridge'] },
  { text: 'Boxes', points: 8 },
  { text: 'Cat', points: 7 },
];

test('normalize', () => {
  assert.strictEqual(normalize('  The Café!! '), 'cafe');
  assert.strictEqual(normalize('My dogs'), 'dog');
  assert.strictEqual(normalize("Don't  stop"), 'dont stop');
  assert.strictEqual(normalize('boxes'), 'box');
  assert.strictEqual(normalize('glass'), 'glass');
  assert.strictEqual(normalize('the'), 'the');
});

test('levenshtein', () => {
  assert.strictEqual(levenshtein('kitten', 'sitting'), 3);
  assert.strictEqual(levenshtein('', 'abc'), 3);
  assert.strictEqual(levenshtein('same', 'same'), 0);
});

test('match: exact, case, articles, plurals', () => {
  assert.strictEqual(match('work', answers), 1);
  assert.strictEqual(match('THE WORK!', answers), 1);
  assert.strictEqual(match('box', answers), 4);
  assert.strictEqual(match('cats', answers), 5);
});

test('match: typos scale with length', () => {
  assert.strictEqual(match('lisen', answers), 0); // len 6, d=1
  assert.strictEqual(match('refrigerater', answers), 3); // len 12, d=1
  assert.strictEqual(match('refridgerater', answers), 3); // d=2
  assert.strictEqual(match('cot', answers), -1); // len 3: exact only
});

test('match: aliases and word overlap', () => {
  assert.strictEqual(match('pay attention', answers), 0);
  assert.strictEqual(match('my fridge', answers), 3);
  assert.strictEqual(match('hot coffee', answers), 2); // significant word overlap
  assert.strictEqual(match('big mug', answers), -1); // "mug" is too short to count
});

test('match: non-matches and revealed skipping', () => {
  assert.strictEqual(match('sleep', answers), -1);
  assert.strictEqual(match('', answers), -1);
  assert.strictEqual(match('working hard', answers), -1); // "work" vs "working" is d=3
  assert.strictEqual(match('work', answers, [false, true]), -1);
  assert.strictEqual(match('coffee', answers), 2);
});

test('closest picks the nearest unrevealed answer', () => {
  assert.strictEqual(closest('wrk', answers), 1);
  assert.strictEqual(closest('fridg', answers, [false, false, false, false]), 3);
  assert.notStrictEqual(closest('wrk', answers, [false, true]), 1);
  assert.strictEqual(closest('x', answers, answers.map(() => true)), -1);
});
