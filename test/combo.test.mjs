// Combination power requirements and clan restrictions (invented data).
import test from 'node:test';
import assert from 'node:assert/strict';
const L = await import('../scripts/logic.mjs');

const items = [
  { type: 'discipline', name: 'Animalism', system: { level: 3 } },
  { type: 'discipline', name: 'obfuscate', system: { level: 2 } },
  { type: 'merit', name: 'Animalism', system: { level: 9 } },
];

test('comboStatus reports each requirement against the actor', () => {
  const st = L.comboStatus(items, [{ discipline: 'Animalism', level: 3 }, { discipline: 'Obfuscate', level: 3 }, { discipline: 'Auspex', level: 1 }]);
  assert.deepEqual(st, [
    { discipline: 'Animalism', level: 3, have: 3, ok: true },
    { discipline: 'Obfuscate', level: 3, have: 2, ok: false },
    { discipline: 'Auspex', level: 1, have: 0, ok: false },
  ]);
});

test('comboUsable needs every requirement; blanks are ignored', () => {
  assert.equal(L.comboUsable(items, [{ discipline: 'Animalism', level: 2 }, { discipline: '', level: 5 }]), true);
  assert.equal(L.comboUsable(items, [{ discipline: 'Animalism', level: 4 }]), false);
});

test('requirementsText', () => {
  assert.equal(L.requirementsText([{ discipline: 'Animalism', level: 3 }, { discipline: 'Obfuscate', level: 0 }]), 'Animalism 3, Obfuscate 1');
});

test('clanAllowed: empty list allows anyone', () => {
  assert.equal(L.clanAllowed('', 'Toreador'), true);
  assert.equal(L.clanAllowed('  ', ''), true);
});

test('clanAllowed: listed clan, case-insensitive, antitribu inherits', () => {
  assert.equal(L.clanAllowed('Nosferatu', 'nosferatu'), true);
  assert.equal(L.clanAllowed('Nosferatu', 'Nosferatu Antitribu'), true);
  assert.equal(L.clanAllowed('Nosferatu Antitribu', 'Nosferatu'), false);
  assert.equal(L.clanAllowed('Nosferatu, Gangrel', 'Gangrel'), true);
  assert.equal(L.clanAllowed('Nosferatu', 'Toreador'), false);
  assert.equal(L.clanAllowed('Nosferatu', ''), false);
});

test('clanTag', () => {
  assert.equal(L.clanTag('Nosferatu; Gangrel'), 'Nosferatu / Gangrel only');
  assert.equal(L.clanTag(''), '');
});

test('findPower resolves combination labels to a combo config address', () => {
  const combo = { type: L.COMBO_TYPE, name: 'Test Combo', system: {} };
  const hit = L.findPower([combo], L.comboLabel(combo));
  assert.equal(hit.lvl, 'combo');
  assert.deepEqual(hit.cfg, ['combo', 'Test Combo', 'combo']);
});
