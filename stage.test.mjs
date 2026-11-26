import assert from 'node:assert/strict';
import test from 'node:test';
import {constellation, dialAngle, romanNumeral, seedRandom, sigil} from './stage.mjs';

function angularSeparation(stars, cx, cy) {
  const angles = stars.map(star => {
    const degrees = Math.atan2(star.y - cy, star.x - cx) * 180 / Math.PI;
    return (degrees + 360) % 360;
  }).sort((first, second) => first - second);
  return angles.map((angle, index) => {
    const next = angles[(index + 1) % angles.length];
    return (next - angle + 360) % 360;
  });
}

function assertConnected(starCount, links) {
  const neighbors = Array.from({length: starCount}, () => []);
  for (const [first, second] of links) {
    neighbors[first].push(second);
    neighbors[second].push(first);
  }
  const visited = new Set([0]);
  const pending = [0];
  while (pending.length) {
    for (const neighbor of neighbors[pending.pop()]) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      pending.push(neighbor);
    }
  }
  assert.equal(visited.size, starCount);
}

test('same seed produces identical constellation and dial angle', () => {
  assert.deepEqual(
    constellation('the same moonlit seed', {inner: 222, outer: 258, cx: 320, cy: 320}),
    constellation('the same moonlit seed', {inner: 222, outer: 258, cx: 320, cy: 320})
  );
  assert.equal(dialAngle('the same moonlit seed'), dialAngle('the same moonlit seed'));
});

test('different seeds vary their constellation and dial angle', () => {
  const seeds = Array.from({length: 50}, (_, index) => `sample-${index}`);
  assert.ok(new Set(seeds.map(dialAngle)).size > 1);
  assert.ok(new Set(seeds.map(seed => JSON.stringify(constellation(seed)))).size > 1);
});

test('stars stay in range and keep at least 20 degrees between neighbors', () => {
  const inner = 222;
  const outer = 258;
  const cx = 320;
  const cy = 320;
  for (let index = 0; index < 50; index += 1) {
    const {stars} = constellation(`angle-sample-${index}`, {inner, outer, cx, cy});
    assert.ok(stars.length >= 6 && stars.length <= 9);
    for (const star of stars) {
      const radius = Math.hypot(star.x - cx, star.y - cy);
      assert.ok(radius >= inner && radius <= outer, `radius ${radius} outside ${inner}–${outer}`);
      assert.ok(star.r >= 1.6 * (outer - inner) / 44);
      assert.ok(star.r <= 3.2 * (outer - inner) / 44);
    }
    for (const separation of angularSeparation(stars, cx, cy)) {
      assert.ok(separation >= 20, `neighboring stars separated by ${separation} degrees`);
    }
  }
});

test('links form a connected tree or one loop without duplicate or invalid edges', () => {
  for (let index = 0; index < 100; index += 1) {
    const {stars, links} = constellation(`link-sample-${index}`, {inner: 222, outer: 258, cx: 320, cy: 320});
    const expectedCount = stars.length - 1 + (stars.length >= 8 ? 1 : 0);
    assert.equal(links.length, expectedCount);
    const normalized = links.map(([first, second]) => {
      assert.ok(first >= 0 && first < stars.length);
      assert.ok(second >= 0 && second < stars.length);
      assert.ok(first < second);
      return `${first}:${second}`;
    });
    assert.equal(new Set(normalized).size, links.length);
    assertConnected(stars.length, links);
  }
});

test('empty, maximum-length, Unicode, and emoji seeds remain deterministic and finite', () => {
  const seeds = ['', 'x'.repeat(128), '星河与月光', '月🌙✨🎭'];
  for (const seed of seeds) {
    const result = constellation(seed, {inner: 7, outer: 25, cx: 32, cy: 32});
    assert.deepEqual(result, constellation(seed, {inner: 7, outer: 25, cx: 32, cy: 32}));
    for (const star of result.stars) {
      assert.ok(Number.isFinite(star.x));
      assert.ok(Number.isFinite(star.y));
      assert.ok(Number.isFinite(star.r));
    }
    assert.ok(Number.isInteger(dialAngle(seed)));
  }
});

test('Roman numerals cover standard subtractive forms and pass unsupported values through', () => {
  const cases = [
    [1, 'I'], [4, 'IV'], [9, 'IX'], [14, 'XIV'], [40, 'XL'], [90, 'XC'],
    [400, 'CD'], [1994, 'MCMXCIV'], [3999, 'MMMCMXCIX'],
    [0, '0'], [4000, '4000'], [-3, '-3'], [2.5, '2.5']
  ];
  for (const [value, expected] of cases) assert.equal(romanNumeral(value), expected);
});

test('dial angle stays within integer degrees', () => {
  for (let index = 0; index < 100; index += 1) {
    const angle = dialAngle(`angle-${index}`);
    assert.ok(Number.isInteger(angle));
    assert.ok(angle >= 0 && angle <= 359);
  }
});

test('seed PRNG is repeatable and returns values in the half-open unit interval', () => {
  const first = seedRandom('repeatable');
  const second = seedRandom('repeatable');
  for (let index = 0; index < 100; index += 1) {
    const value = first();
    assert.equal(value, second());
    assert.ok(value >= 0 && value < 1);
  }
});

test('sigil markup excludes hostile seed text and keeps decorative SVG attributes', () => {
  const markup = sigil('<img onerror=alert(1)>');
  assert.doesNotMatch(markup, /<img|alert/i);
  assert.match(markup, /viewBox="0 0 64 64"/);
  assert.match(markup, /aria-hidden="true"/);
});
