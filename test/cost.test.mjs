import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCost, formatCost, costFields, costStatus, noteHasCharge } from '../scripts/logic.mjs';

test('parseCost matches the system parser', () => {
  assert.deepEqual(parseCost('1 blood'), { blood: 1, wp: 0, variable: false });
  assert.deepEqual(parseCost('1 Willpower'), { blood: 0, wp: 1, variable: false });
  assert.deepEqual(parseCost('2+ blood, 1 wp'), { blood: 2, wp: 1, variable: true });
  assert.equal(parseCost('1 point of blood'), null);
  assert.equal(parseCost('one blood'), null);
  assert.deepEqual(parseCost('1-3 blood'), { blood: 3, wp: 0, variable: false }); // the system's quirk
});

test('formatCost writes text the parser reads back', () => {
  for (const f of [{ blood: 1 }, { wp: 1 }, { blood: 2, variable: true, wp: 1 }, { blood: 3, note: 'per turn' }]) {
    const p = parseCost(formatCost(f));
    assert.equal(p.blood, f.blood ?? 0);
    assert.equal(p.wp, f.wp ?? 0);
    assert.equal(p.variable, !!f.variable && !!f.blood);
  }
  assert.equal(formatCost({ blood: 2, variable: true, wp: 1, note: 'per turn' }), '2+ blood, 1 willpower (per turn)');
  assert.equal(formatCost({ note: 'see text' }), 'see text');
  assert.equal(formatCost({}), '');
});

test('costFields pre-fills the picker, including notes', () => {
  assert.deepEqual(costFields('2+ blood, 1 willpower (per turn)'), { blood: 2, variable: true, wp: 1, note: 'per turn' });
  assert.deepEqual(costFields('1 Willpower point'), { blood: 0, variable: false, wp: 1, note: '' });
  assert.deepEqual(costFields('1 blood and 1 wp'), { blood: 1, variable: false, wp: 1, note: '' });
  assert.deepEqual(costFields('1 point of blood'), { blood: 0, variable: false, wp: 0, note: '1 point of blood' });
  assert.deepEqual(costFields(''), { blood: 0, variable: false, wp: 0, note: '' });
});

test('costStatus flags text the system will not charge', () => {
  assert.deepEqual(costStatus('1 blood, 1 wp'), { text: '1 blood · 1 WP', charges: true, warn: false });
  assert.deepEqual(costStatus('2+ blood'), { text: '2+ blood', charges: true, warn: false });
  assert.equal(costStatus('1 point of blood').warn, true);
  assert.equal(costStatus('').warn, false);
  assert.equal(noteHasCharge('then 3 blood per turn'), true);
  assert.equal(noteHasCharge('per turn'), false);
});
