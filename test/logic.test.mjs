import test from 'node:test';
import assert from 'node:assert/strict';
import {
  powerKey, traitValue, normalizeConfig, isActive, targetDifficulty, resistDifficulty,
  contest, findPower, summarize, clampDiff,
} from '../scripts/logic.mjs';

const npc = { attributes: { wits: 3 }, virtues: { courage: 4 }, willpower: { value: 2, max: 7 }, humanity: 5, abilities: { alertness: 2 } };
const pc = { attributes: { manipulation: 4, charisma: 3 }, abilities: { intimidation: 3 }, willpower: { max: 5 } };

test('trait values use permanent Willpower and system key format', () => {
  assert.equal(traitValue(npc, 'willpower'), 7);
  assert.equal(traitValue(npc, 'attributes.wits'), 3);
  assert.equal(traitValue(npc, 'virtues.courage'), 4);
  assert.equal(traitValue(npc, 'humanity'), 5);
  assert.equal(traitValue(npc, 'abilities.nope'), 0);
});

test('difficulty from target: single trait, sum, modifier, clamped 2-10', () => {
  assert.equal(targetDifficulty(normalizeConfig({ diff: { mode: 'target', traits: ['willpower', ''] } }), npc), 7);
  assert.equal(targetDifficulty(normalizeConfig({ diff: { mode: 'target', traits: ['attributes.wits', 'virtues.courage'] } }), npc), 7);
  assert.equal(targetDifficulty(normalizeConfig({ diff: { mode: 'target', traits: ['willpower', 'virtues.courage'] } }), npc), 10);
  assert.equal(targetDifficulty(normalizeConfig({ diff: { mode: 'target', traits: ['abilities.alertness', ''], mod: -1 } }), npc), 2);
  assert.equal(clampDiff(1), 2);
});

test('resist difficulty: fixed or from attacker traits', () => {
  assert.equal(resistDifficulty(normalizeConfig({ resist: { enabled: true, diff: 8 } }), pc), 8);
  const c = normalizeConfig({ resist: { enabled: true, diffMode: 'attacker', attackerTraits: ['attributes.manipulation', 'abilities.intimidation'] } });
  assert.equal(resistDifficulty(c, pc), 7);
});

test('contest: net successes, ties go to defender, negatives floored', () => {
  assert.deepEqual(contest(4, 1), { attacker: 4, defender: 1, net: 3, winner: 'attacker' });
  assert.equal(contest(2, 2).winner, 'defender');
  assert.equal(contest(2, 2).net, 0);
  assert.equal(contest(1, 3).winner, 'defender');
  assert.equal(contest(3, -1).defender, 0);
});

test('findPower matches the system roll label', () => {
  const items = [
    { type: 'discipline', name: 'Dominate', system: { powers: { lvl1: { name: 'Command' }, lvl2: { name: 'Mesmerize' } } } },
    { type: 'weapon', name: 'Knife', system: {} },
  ];
  const m = findPower(items, 'Dominate: Mesmerize');
  assert.equal(m.lvl, 'lvl2');
  assert.equal(findPower(items, 'Dominate: Forgetful Mind'), null);
  assert.equal(findPower(items, 'Knife: Stab'), null);
});

test('config normalization, activity, keys, summary', () => {
  assert.equal(isActive(normalizeConfig({})), false);
  assert.equal(isActive(normalizeConfig({ diff: { mode: 'target' } })), true);
  assert.equal(isActive(normalizeConfig({ resist: { enabled: true } })), true);
  assert.equal(powerKey('discipline', 'St. Dominate', 'lvl1'), 'discipline|st dominate|lvl1');
  const s = summarize(normalizeConfig({ diff: { mode: 'target', traits: ['willpower', ''] }, resist: { enabled: true, traits: ['willpower', ''], diff: 7 } }));
  assert.match(s, /Diff = target's Willpower/);
  assert.match(s, /Resisted: Willpower vs diff 7/);
});
