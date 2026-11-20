'use strict';
// Fuzzy answer matching (spec §4).

const ARTICLES = new Set(['a', 'an', 'the', 'my', 'your']);
const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'been', 'being', 'could', 'does', 'doing', 'from', 'have', 'having',
  'into', 'just', 'like', 'make', 'more', 'most', 'much', 'only', 'other', 'over', 'really', 'some',
  'something', 'stuff', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'thing',
  'things', 'this', 'those', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your',
]);

function singular(w) {
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2); // boxes, dishes, glasses
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function normalize(s) {
  const words = String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter(Boolean);
  while (words.length > 1 && ARTICLES.has(words[0])) words.shift();
  return words.map(singular).join(' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const candidates = (a) => [a.text, ...(a.aliases || [])].map(normalize).filter(Boolean);

// Lower is better; null = no match.
function score(cand, guess, guessWords) {
  if (cand === guess) return 0;
  const d = levenshtein(cand, guess);
  if ((cand.length >= 4 && cand.length <= 7 && d <= 1) || (cand.length >= 8 && d <= 2)) return d;
  const sig = cand.split(' ').filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  if (sig.length && sig.length <= 2 && sig.some((w) => guessWords.some((g) => levenshtein(w, g) <= 1))) return 3;
  return null;
}

// Index of best-matching unrevealed answer, or -1.
function match(guess, answers, revealed = []) {
  const g = normalize(guess);
  if (!g) return -1;
  const gw = g.split(' ');
  let best = -1, bestScore = Infinity;
  answers.forEach((a, i) => {
    if (revealed[i]) return;
    for (const c of candidates(a)) {
      const s = score(c, g, gw);
      if (s !== null && s < bestScore) { best = i; bestScore = s; }
    }
  });
  return best;
}

// Unrevealed answer with the lowest normalized edit distance (host "accept").
function closest(guess, answers, revealed = []) {
  const g = normalize(guess);
  let best = -1, bestScore = Infinity;
  answers.forEach((a, i) => {
    if (revealed[i]) return;
    for (const c of candidates(a)) {
      const s = levenshtein(c, g) / Math.max(c.length, g.length, 1);
      if (s < bestScore) { best = i; bestScore = s; }
    }
  });
  return best;
}

module.exports = { normalize, levenshtein, match, closest };
