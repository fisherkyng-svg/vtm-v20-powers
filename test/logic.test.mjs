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

import { ELDER_TYPE, elderPowersFor, elderUsable, elderLabel } from '../scripts/logic.mjs';

test('Elder powers: label match, config address, grouping, rating gate', () => {
  const items = [
    { type: 'discipline', name: 'Dominate', system: { level: 6, powers: { lvl1: { name: 'Command' } } } },
    { id: 'e2', type: ELDER_TYPE, name: 'Mass Mesmerize', system: { discipline: 'Dominate', level: 6 } },
    { id: 'e1', type: ELDER_TYPE, name: 'Far Mastery', system: { discipline: 'dominate', level: 6 } },
    { id: 'e3', type: ELDER_TYPE, name: 'Speak Through the Blood', system: { discipline: 'Dominate', level: 7 } },
  ];
  assert.equal(ELDER_TYPE, 'vtm-v20-powers.elderPower');
  const m = findPower(items, 'Dominate: Mass Mesmerize');
  assert.equal(m.lvl, 'elder');
  assert.deepEqual(m.cfg, ['elder', 'Mass Mesmerize', 'elder']);
  assert.deepEqual(findPower(items, 'Dominate: Command').cfg, ['discipline', 'Dominate', 'lvl1']);
  assert.deepEqual(elderPowersFor(items, 'DOMINATE').map(i => i.id), ['e1', 'e2', 'e3']);
  assert.equal(elderUsable(6, 6), true);
  assert.equal(elderUsable(6, 7), false);
  assert.equal(elderLabel(items[1]), 'Dominate: Mass Mesmerize');
});

import { PATH_TYPE, pathRecord, mergePaths, virtueFlagFor } from '../scripts/logic.mjs';

const BASE = {
  Humanity: { virtues: { conscience: 'Conscience', selfControl: 'Self-Control' }, bearing: 'Normalcy' },
  'Path of the Beast': { virtues: { conscience: 'Conviction', selfControl: 'Instinct' }, bearing: 'Menace' },
};
const evil = pathRecord({ name: ' Path of Evil Revelations ', system: { conscience: 'Conviction', selfControl: 'Instinct', bearing: 'Corruption', sins: { r10: 'a', r1: 'z' } } });

test('pathRecord normalizes name, virtues, sins', () => {
  assert.equal(PATH_TYPE, 'vtm-v20-powers.enlightenmentPath');
  assert.equal(evil.name, 'Path of Evil Revelations');
  assert.equal(evil.sins[10], 'a');
  assert.equal(evil.sins[5], '');
  assert.equal(pathRecord({ name: 'X', system: { conscience: 'bogus' } }).conscience, 'Conviction');
});

test('mergePaths: built-ins first, custom A-Z, override by exact name, in-use fallback', () => {
  const zed = { ...evil, name: 'Path of Zed' };
  const beast = { ...evil, name: 'Path of the Beast', bearing: 'Hunger' };
  const m = mergePaths(BASE, [zed, evil, beast], ['Path of Gone']);
  assert.deepEqual(Object.keys(m), ['Humanity', 'Path of the Beast', 'Path of Evil Revelations', 'Path of Zed', 'Path of Gone']);
  assert.equal(m['Path of the Beast'].bearing, 'Hunger');
  assert.deepEqual(m['Path of Evil Revelations'].virtues, { conscience: 'Conviction', selfControl: 'Instinct' });
  assert.equal(m['Path of Gone'].missing, true);
  assert.equal(m['Path of Gone'].bearing, 'Normalcy');
  assert.equal(Object.keys(mergePaths(BASE, [], ['Humanity'])).length, 2);
});

test('virtueFlagFor gives the labels the system reads for Instinct frenzy', () => {
  const m = mergePaths(BASE, [evil]);
  assert.deepEqual(virtueFlagFor(m, 'Path of Evil Revelations'), { conscience: 'Conviction', selfControl: 'Instinct' });
  assert.equal(virtueFlagFor(m, 'Nope'), null);
});
