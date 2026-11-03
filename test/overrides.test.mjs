// Discipline stat overrides: pure logic plus the apply engine against mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statKey, normalizeStat, hasStat, statUpdates, stripOverridden, summarizeStat } from '../scripts/logic.mjs';

const disc = (name, powers) => ({ type: 'discipline', name, system: { powers } });
const OV = { animalism: { lvl3: { difficulty: 7 }, lvl2: { primary: 'attributes.charisma', secondary: 'abilities.animalKen' } } };

test('statKey is case- and dot-insensitive', () => {
  assert.equal(statKey(' Animalism '), 'animalism');
  assert.equal(statKey('Thaumaturgy. Rego'), 'thaumaturgy rego');
});

test('normalizeStat keeps only present fields and clamps Diff', () => {
  assert.deepEqual(normalizeStat({ difficulty: '7' }), { difficulty: 7 });
  assert.deepEqual(normalizeStat({ difficulty: 14 }), { difficulty: 10 });
  assert.deepEqual(normalizeStat({ cost: ' 1 blood ' }), { cost: '1 blood' });
  assert.deepEqual(normalizeStat({ primary: '', secondary: '' }), { primary: '', secondary: '' });
  assert.deepEqual(normalizeStat({ difficulty: '' }), {});
  assert.equal(hasStat({}), false);
  assert.equal(hasStat({ cost: '' }), true);
});

test('statUpdates: only differing overridden fields, Quell the Beast 6 -> 7', () => {
  const item = disc('Animalism', { lvl3: { name: 'Quell the Beast', difficulty: 6, cost: '' }, lvl2: { primary: 'attributes.charisma', secondary: 'abilities.animalKen' } });
  assert.deepEqual(statUpdates(item, OV), { 'system.powers.lvl3.difficulty': 7 });
  item.system.powers.lvl3.difficulty = 7;
  assert.equal(statUpdates(item, OV), null);
  assert.equal(statUpdates(disc('Dominate', { lvl3: { difficulty: 6 } }), OV), null);
  assert.equal(statUpdates({ ...item, type: 'path' }, OV), null);
});

test('stripOverridden drops edits to overridden fields only', () => {
  const item = disc('Animalism', {});
  const flat = { 'system.powers.lvl3.difficulty': 6, 'system.powers.lvl3.cost': '1 blood', 'system.powers.lvl3.name': 'X', 'system.powers.lvl3.difficulty_': 1 };
  assert.deepEqual(stripOverridden(item, OV, flat), ['system.powers.lvl3.difficulty']);
  assert.equal('system.powers.lvl3.cost' in flat, true);
  const same = { 'system.powers.lvl3.difficulty': 7 };
  assert.deepEqual(stripOverridden(item, OV, same), []);
});

test('summarizeStat', () => {
  assert.equal(summarizeStat({ difficulty: 7 }), 'Override: Diff 7');
  assert.equal(summarizeStat({ primary: 'attributes.manipulation', secondary: 'abilities.intimidation', cost: '' }), 'Override: Manipulation + Intimidation · No cost');
  assert.equal(summarizeStat({}), '');
});

// ---- apply engine with a mock Foundry ------------------------------------
const store = {};
const calls = [];
const flattenObject = (o, p = '', out = {}) => { for (const [k, v] of Object.entries(o)) { const key = p ? `${p}.${k}` : k; if (v && typeof v === 'object' && !Array.isArray(v)) flattenObject(v, key, out); else out[key] = v; } return out; };
const expandObject = o => { const out = {}; for (const [k, v] of Object.entries(o)) { const parts = k.split('.'); let t = out; for (const q of parts.slice(0, -1)) t = (t[q] ??= {}); t[parts.at(-1)] = v; } return out; };
const mk = (id, name, d) => ({ id, type: 'discipline', name, system: { powers: { lvl3: { name: 'Quell the Beast', difficulty: d } } } });
const packDocs = [mk('p1', 'Animalism', 6), mk('p2', 'Auspex', 6)];
const pack = { collection: 'vtm-v20.disciplines', locked: true, getDocuments: async () => packDocs,
  async configure(o) { calls.push(['lock', o.locked]); this.locked = o.locked; } };
const actorA = { name: 'Moth', items: [mk('a1', 'Animalism', 6), mk('a2', 'Dominate', 6)],
  async updateEmbeddedDocuments(t, ups, o) { calls.push(['actor', ups, o]); } };
const hooks = {};
Object.assign(globalThis, {
  Hooks: { on(n, f) { (hooks[n] ??= []).push(f); }, once(n, f) { (hooks[n] ??= []).push(f); } },
  foundry: { utils: { deepClone: o => JSON.parse(JSON.stringify(o)), flattenObject, expandObject },
    applications: { api: { ApplicationV2: class {}, DialogV2: { confirm: async () => true } } } },
  Item: { async updateDocuments(ups, o) { calls.push(['items', ups, o]); } },
  ui: { notifications: { info() {}, warn(m) { calls.push(['warn', m]); } } },
  game: {
    user: { id: 'gm', isGM: true }, users: { activeGM: { id: 'gm' } },
    packs: { get: id => (id === 'vtm-v20.disciplines' ? pack : null) },
    items: [mk('w1', 'Animalism', 6)], actors: [actorA], scenes: [],
    settings: { register() {}, registerMenu() {}, get: (m, k) => store[`${m}.${k}`], set: async (m, k, v) => { store[`${m}.${k}`] = v; } },
  },
});
const { registerOverrides, applyStats } = await import('../scripts/overrides.mjs');
registerOverrides({ traitSelect: () => '<select></select>', keepEnabled() {} });
store['vtm-v20-powers.statOverrides'] = { animalism: { lvl3: { difficulty: 7 } } };

test('applyStats updates pack (unlock/relock), world items and characters', async () => {
  const n = await applyStats({ confirm: true });
  assert.equal(n, 3);
  assert.deepEqual(calls.filter(c => c[0] === 'lock').map(c => c[1]), [false, true]);
  const packCall = calls.find(c => c[0] === 'items' && c[2].pack);
  assert.deepEqual(packCall[1], [{ _id: 'p1', system: { powers: { lvl3: { difficulty: 7 } } } }]);
  const worldCall = calls.find(c => c[0] === 'items' && !c[2].pack);
  assert.equal(worldCall[1][0]._id, 'w1');
  const actorCall = calls.find(c => c[0] === 'actor');
  assert.deepEqual(actorCall[1].map(u => u._id), ['a1']);
  assert.equal(actorCall[2].vpwOverride, true);
});

test('preCreateItem applies overrides to new copies (covers the compendium rebuild)', () => {
  const item = mk('n1', 'Animalism', 6);
  item.updateSource = u => { item.system.powers.lvl3.difficulty = u.system.powers.lvl3.difficulty; };
  for (const f of hooks.preCreateItem) f(item);
  assert.equal(item.system.powers.lvl3.difficulty, 7);
});

test('preUpdateItem turns back an edit to an overridden field, keeps the rest', () => {
  const item = mk('a1', 'Animalism', 7);
  const changes = { _id: 'a1', system: { powers: { lvl3: { difficulty: 5, cost: '1 blood' } } } };
  for (const f of hooks.preUpdateItem) f(item, changes, {});
  assert.equal(changes.system.powers.lvl3.difficulty, undefined);
  assert.equal(changes.system.powers.lvl3.cost, '1 blood');
  assert.ok(calls.some(c => c[0] === 'warn'));
  const own = { system: { powers: { lvl3: { difficulty: 5 } } } };
  for (const f of hooks.preUpdateItem) f(item, own, { vpwOverride: true });
  assert.equal(own.system.powers.lvl3.difficulty, 5);
});
