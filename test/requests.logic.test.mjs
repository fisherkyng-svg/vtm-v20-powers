import test from 'node:test';
import assert from 'node:assert/strict';
import { splitBudget, checkAllocation, applySplitRoll, resetRequestRow, splitActionDiff, normalizeConfig, resistDifficulty, summarize } from '../scripts/logic.mjs';
import { newRequest, applyRequestRoll, requestRollable, singleTotal, clearRequestLock, removeRequestRow } from '../scripts/logic.mjs';

const S = (o, r) => ({ total: o === 'success' ? r : 0, outcome: o });
const rows = [
  { actorUuid: 'A.moth', name: 'Moth' },
  { actorUuid: 'A.niven', name: 'Niven' },
  { actorUuid: 'A.dee', name: 'Dee Dee', companion: true, assists: 'A.moth' },
];

test('newRequest: rows, assist parent, clamps', () => {
  const s = newRequest({ type: 'extended', attr: 'attributes.intelligence', ability: 'abilities.occult', difficulty: 7, goal: 10, rows });
  assert.deepEqual(s.rows.map(r => [r.id, r.role, r.parent]), [['r1', 'main', null], ['r2', 'main', null], ['r3', 'assist', 'r1']]);
  assert.equal(newRequest({ type: 'team', rows }).rows[2].role, 'main'); // assisting = own row in teamwork
  assert.equal(newRequest({ type: 'x', difficulty: 15 }).type, 'single');
  assert.equal(newRequest({ difficulty: 15 }).difficulty, 10);
});

test('single: one roll each, assists add to the character total', () => {
  let s = newRequest({ type: 'single', rows });
  s = applyRequestRoll(s, 'r1', S('success', 2));
  s = applyRequestRoll(s, 'r3', S('success', 1));
  assert.equal(singleTotal(s, 'r1'), 3);
  assert.equal(requestRollable(s, 'r1').ok, false);
  const again = applyRequestRoll(s, 'r1', S('success', 5));
  assert.equal(singleTotal(again, 'r1'), 3);
});

test('extended: own totals, assist adds to Moth, failure resets, done stops', () => {
  let s = newRequest({ type: 'extended', goal: 5, onFail: 'reset', rows });
  s = applyRequestRoll(s, 'r1', S('success', 2));
  s = applyRequestRoll(s, 'r3', S('success', 2)); // Dee Dee helps Moth
  assert.equal(s.rows[0].total, 4);
  s = applyRequestRoll(s, 'r3', S('failure')); // assist failure adds 0, no reset
  assert.equal(s.rows[0].total, 4);
  s = applyRequestRoll(s, 'r2', S('failure'));
  assert.equal(s.rows[1].total, 0);
  s = applyRequestRoll(s, 'r1', S('success', 1));
  assert.equal(s.rows[0].status, 'done');
  assert.equal(requestRollable(s, 'r3').ok, false); // assist stops with Moth
  assert.equal(s.rows[0].log.at(-1).note, 'goal reached');
  assert.equal(s.rows[0].log.length, 4); // assist rolls log on Moth's row
});

test('extended: assist botch counts as the character botch; lock + clear', () => {
  let s = newRequest({ type: 'extended', goal: 9, onBotch: 'lock', rows });
  s = applyRequestRoll(s, 'r1', S('success', 3));
  s = applyRequestRoll(s, 'r3', S('botch'));
  assert.deepEqual([s.rows[0].total, s.rows[0].status], [0, 'locked']);
  assert.equal(requestRollable(s, 'r1').reason, 'locked after a botch');
  s = clearRequestLock(s, 'r1');
  assert.equal(requestRollable(s, 'r1').ok, true);
});

test('extended: max rolls per character', () => {
  let s = newRequest({ type: 'extended', goal: 9, maxRolls: 2, rows });
  s = applyRequestRoll(s, 'r1', S('success', 1));
  s = applyRequestRoll(s, 'r3', S('success', 1)); // assists don't use up rolls
  s = applyRequestRoll(s, 'r1', S('success', 1));
  assert.equal(s.rows[0].status, 'out');
  assert.equal(s.rows[0].total, 3);
});

test('team: shared total, contributions, botch resets and locks the botcher, done', () => {
  let s = newRequest({ type: 'team', goal: 6, onBotch: 'lock', rows });
  s = applyRequestRoll(s, 'r1', S('success', 3));
  s = applyRequestRoll(s, 'r3', S('success', 2));
  assert.equal(s.team.total, 5);
  s = applyRequestRoll(s, 'r2', S('botch'));
  assert.deepEqual([s.team.total, s.rows[1].status], [0, 'locked']);
  assert.equal(requestRollable(s, 'r2').ok, false);
  s = applyRequestRoll(s, 'r1', S('success', 4));
  s = applyRequestRoll(s, 'r3', S('success', 2));
  assert.equal(s.team.status, 'done');
  assert.deepEqual(s.rows.map(r => r.gained), [7, 0, 4]);
  assert.equal(requestRollable(s, 'r1').ok, false);
});

test('team: failure reset and team max rolls', () => {
  let s = newRequest({ type: 'team', goal: 9, onFail: 'reset', maxRolls: 3, rows });
  s = applyRequestRoll(s, 'r1', S('success', 3));
  s = applyRequestRoll(s, 'r2', S('failure'));
  assert.equal(s.team.total, 0);
  s = applyRequestRoll(s, 'r3', S('success', 1));
  assert.equal(s.team.status, 'out');
});

test('closed request and removal', () => {
  let s = newRequest({ type: 'extended', goal: 3, rows });
  s = removeRequestRow(s, 'r1');
  assert.deepEqual(s.rows.map(r => r.id), ['r2']); // Moth and his assist gone
  s.status = 'closed';
  assert.equal(requestRollable(s, 'r2').reason, 'the request is closed');
});


test('resist difficulty from attacker successes + modifier, clamped 2..10', () => {
  const c = normalizeConfig({ resist: { enabled: true, traits: ['willpowerCurrent', ''], diffMode: 'successes', mod: 3 } });
  assert.equal(c.resist.diffMode, 'successes');
  assert.equal(resistDifficulty(c, {}, 1), 4);
  assert.equal(resistDifficulty(c, {}, 9), 10);
  const plain = normalizeConfig({ resist: { enabled: true, diffMode: 'successes', mod: 0 } });
  assert.equal(resistDifficulty(plain, {}, 1), 2);
  assert.equal(resistDifficulty(plain, {}, 4), 4);
  assert.match(summarize(c), /vs diff your successes \+ 3/);
});

const split = () => newRequest({ type: 'split', extraDiff: 1, rows: rows.slice(0, 2), actions: [
  { label: 'Find the password', attr: 'attributes.intelligence', ability: 'abilities.investigation', difficulty: 7 },
  { label: 'Stay hidden', attr: 'attributes.dexterity', ability: 'abilities.stealth', difficulty: 10 },
] });

test('split: budget is the smallest pool plus wound penalty, at least 1', () => {
  assert.equal(splitBudget([7, 5]), 5);
  assert.equal(splitBudget([7, 5], -2), 3);
  assert.equal(splitBudget([1, 4], -3), 1);
});

test('split: request shape, extra difficulty capped at 10', () => {
  const s = split();
  assert.equal(s.actions.length, 2);
  assert.equal(splitActionDiff(s, s.actions[0]), 8);
  assert.equal(splitActionDiff(s, s.actions[1]), 10);
  assert.ok(s.rows.every(r => r.role === 'main'));
});

test('split: allocation checks', () => {
  assert.equal(checkAllocation([3, 2], 5, 2).ok, true);
  assert.equal(checkAllocation([3, 1], 5, 2).ok, true); // unspent allowed
  assert.match(checkAllocation([4, 2], 5, 2).reason, /budget is 5/);
  assert.match(checkAllocation([0, 0], 5, 2).reason, /at least one/);
  assert.equal(checkAllocation([2.5, 2], 5, 2).ok, false);
  assert.equal(checkAllocation([5], 5, 2).ok, false);
});

test('split: record results, skipped action, one go, reset', () => {
  let s = split();
  s = applySplitRoll(s, 'r1', { alloc: [5, 0], budget: 5, results: [{ total: 2, outcome: 'success' }, null] });
  const r = s.rows[0];
  assert.equal(r.status, 'rolled');
  assert.deepEqual(r.results, [{ total: 2, outcome: 'success' }, { skipped: true }]);
  assert.equal(requestRollable(s, 'r1').ok, false);
  const over = applySplitRoll(s, 'r2', { alloc: [6, 1], budget: 5, results: [] });
  assert.equal(over.rows[1].status, 'open'); // over budget ignored
  s = resetRequestRow(s, 'r1');
  assert.equal(requestRollable(s, 'r1').ok, true);
  assert.deepEqual(s.rows[0].results, []);
});
