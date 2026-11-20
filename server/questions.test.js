const test = require('node:test');
const assert = require('node:assert');
const questions = require('./questions.json');

test('question bank shape', () => {
  assert.ok(Array.isArray(questions) && questions.length >= 240, 'need >= 240 questions');
  const byCat = c => questions.filter(q => q.category === c).length;
  assert.ok(byCat('culture-clash') >= 25, 'need >= 25 culture-clash questions');
  assert.ok(byCat('remote-work') >= 15, 'need >= 15 remote-work questions');
  assert.strictEqual(new Set(questions.map(q => q.id)).size, questions.length, 'ids unique');
  assert.strictEqual(new Set(questions.map(q => q.q.toLowerCase())).size, questions.length, 'question text unique');
  assert.ok(questions.filter(q => q.answers.length >= 5).length >= 60, '>= 60 bonus-usable questions');

  for (const q of questions) {
    const at = `${q.id}: `;
    assert.match(q.id, /^q\d{3}$/, at + 'id');
    assert.ok(typeof q.category === 'string' && q.category, at + 'category');
    assert.ok(typeof q.q === 'string' && q.q.length > 0 && q.q.length <= 140, at + 'q length');
    assert.ok(Array.isArray(q.answers) && q.answers.length >= 5 && q.answers.length <= 8, at + '5-8 answers');
    let sum = 0;
    const seen = new Set();
    q.answers.forEach((a, i) => {
      assert.ok(typeof a.text === 'string' && a.text.length > 0 && a.text.length <= 40, at + 'answer text');
      assert.ok(Number.isInteger(a.points) && a.points > 0, at + 'points integer');
      if (i) assert.ok(a.points <= q.answers[i - 1].points, at + 'points descending');
      assert.ok(Array.isArray(a.aliases) && a.aliases.every(s => typeof s === 'string' && s), at + 'aliases');
      for (const s of [a.text, ...a.aliases]) {
        const k = s.toLowerCase();
        assert.ok(!seen.has(k), at + `duplicate candidate "${s}"`);
        seen.add(k);
      }
      sum += a.points;
    });
    assert.ok(sum >= 80 && sum <= 100, at + `points sum ${sum}`);
  }
});
