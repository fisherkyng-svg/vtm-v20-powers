// Mock-Foundry run of the real main.mjs: roll interception, resist card,
// outcome, socket resolution, and fallbacks. Not Foundry; checks our wiring.
import test from 'node:test';
import assert from 'node:assert/strict';

const hooks = {};
const Hooks = {
  on(n, f) { (hooks[n] ??= []).push(f); }, once(n, f) { (hooks[n] ??= []).push(f); },
  callAll(n, ...a) { for (const f of hooks[n] ?? []) f(...a); },
};
const clone = o => JSON.parse(JSON.stringify(o));
let idn = 0;
const rid = () => `id${++idn}`;

const rollCalls = [];
const rollScript = [];
const settings = { 'vtm-v20-powers.configs': {} };
const messages = [];
const notes = [];
const emitted = [];

function makeMessage(data, author) {
  const msg = {
    id: rid(), ...clone(data), author, get isAuthor() { return game.user.id === author; },
    async update(u) { for (const [k, v] of Object.entries(u)) { const parts = k.split('.'); let t = this; for (const p of parts.slice(0, -1)) t = (t[p] ??= {}); t[parts.at(-1)] = v; } },
  };
  messages.push(msg);
  return msg;
}

const actors = {};
function actor(name, system, items = [], owners = []) {
  const a = { name, system, items, uuid: `Actor.${name}`, owners, get isOwner() { return game.user.isGM || owners.includes(game.user.id); } };
  actors[a.uuid] = a;
  return a;
}
const lucien = actor('Lucien', { attributes: { manipulation: 4 }, abilities: { intimidation: 3 }, willpower: { max: 5 } }, [
  { type: 'discipline', name: 'Dominate', system: { powers: { lvl1: { name: 'Command' }, lvl2: { name: 'Mesmerize' }, lvl3: { name: 'Forgetful Mind' } } } },
], ['p1']);
const marcus = actor('Marcus', { attributes: { wits: 3 }, virtues: { courage: 2 }, willpower: { max: 8 } }, [], []);
const vera = actor('Vera', { willpower: { max: 4 } }, [], ['p2']);

const gm = { id: 'gm', name: 'ST', isGM: true };
const p1 = { id: 'p1', name: 'Player 1', isGM: false };
const p2 = { id: 'p2', name: 'Player 2', isGM: false };
let currentTarget = null;

Object.assign(globalThis, {
  Hooks,
  CONFIG: { VTM: { attributes: { mental: ['wits'] }, abilities: { talents: ['intimidation'] } } },
  foundry: { utils: { deepClone: clone }, applications: { api: { DialogV2: { wait: async () => null } } } },
  ui: { notifications: { warn: m => notes.push(m), error: m => notes.push(m), info: m => notes.push(m) } },
  ChatMessage: { getSpeaker: ({ actor }) => ({ alias: actor?.name }), create: async d => makeMessage(d, game.user.id) },
  fromUuid: async u => actors[u] ?? null,
  fromUuidSync: u => actors[u] ?? null,
  game: {
    system: { id: 'vtm-v20' }, user: p1,
    users: { get activeGM() { return { isSelf: game.user.isGM }; } },
    settings: { register() {}, get: (m, k) => settings[`${m}.${k}`], set: async (m, k, v) => { settings[`${m}.${k}`] = v; } },
    modules: { get: () => (globalThis.__mod ??= {}) },
    messages: { get: id => messages.find(m => m.id === id) },
    socket: { emit: (ch, d) => emitted.push([ch, d]), on: (ch, f) => { globalThis.__sock = f; } },
    vtm: { async rollDicePool(a, opts) { rollCalls.push({ actor: a.name, ...opts }); return rollScript.length ? rollScript.shift() : { total: 1, outcome: 'success' }; } },
  },
});
Object.defineProperty(game.user, 'targets', { get: () => ({ first: () => currentTarget }), configurable: true });
for (const u of [p1, p2, gm]) Object.defineProperty(u, 'targets', { get: () => ({ first: () => currentTarget }) });

await import('../scripts/main.mjs');
Hooks.callAll('init');
Hooks.callAll('ready');
const api = globalThis.__mod.api;
const as = u => { game.user = u; };
const lastResist = () => [...messages].reverse().find(m => m.flags?.['vtm-v20-powers']?.kind === 'resist');

function renderSlot(msg) {
  const slot = { innerHTML: '', _btn: null, querySelector(s) { return s === 'button' ? (this._btn ??= { addEventListener(_, f) { this.click = f; } }) : null; } };
  const root = { querySelector: s => (s === '.vpw-resist-slot' ? slot : null) };
  Object.setPrototypeOf(root, HTMLElement.prototype);
  hooks.renderChatMessageHTML[0](msg, root);
  return slot;
}
globalThis.HTMLElement ??= class {};

test('unconfigured power rolls exactly as before', async () => {
  as(p1); currentTarget = { actor: marcus };
  await game.vtm.rollDicePool(lucien, { trait: 'attributes.manipulation', label: 'Dominate: Command', difficulty: 6 });
  assert.equal(rollCalls.at(-1).difficulty, 6);
  assert.equal(rollCalls.at(-1).label, 'Dominate: Command');
});

test('difficulty from target Willpower is passed to the system roll', async () => {
  as(gm);
  await api.setConfig('discipline', 'Dominate', 'lvl1', { diff: { mode: 'target', traits: ['willpower', ''], mod: 0 }, resist: { enabled: false } });
  as(p1); currentTarget = { actor: marcus };
  await game.vtm.rollDicePool(lucien, { trait: 'attributes.manipulation', label: 'Dominate: Command', difficulty: 6 });
  assert.equal(rollCalls.at(-1).difficulty, 8); // Marcus permanent Willpower
  currentTarget = { actor: vera };
  await game.vtm.rollDicePool(lucien, { trait: 'attributes.manipulation', label: 'Dominate: Command', difficulty: 6 });
  assert.equal(rollCalls.at(-1).difficulty, 4);
  assert.match(rollCalls.at(-1).label, /vs Vera/);
});

test('no target: warns and uses fixed difficulty', async () => {
  as(p1); currentTarget = null;
  await game.vtm.rollDicePool(lucien, { trait: 'attributes.manipulation', label: 'Dominate: Command', difficulty: 6 });
  assert.equal(rollCalls.at(-1).difficulty, 6);
  assert.match(notes.at(-1), /no token targeted/);
});

test('resisted: success posts a resist card; NPC target -> only GM gets the button', async () => {
  as(gm);
  await api.setConfig('discipline', 'Dominate', 'lvl2', { diff: { mode: 'target', traits: ['willpower', ''] }, resist: { enabled: true, traits: ['willpower', ''], diffMode: 'attacker', attackerTraits: ['attributes.manipulation', 'abilities.intimidation'] } });
  as(p1); currentTarget = { actor: marcus };
  rollScript.push({ total: 3, outcome: 'success' });
  await game.vtm.rollDicePool(lucien, { trait: 'attributes.manipulation', label: 'Dominate: Mesmerize', difficulty: 6 });
  const card = lastResist();
  assert.equal(card.flags['vtm-v20-powers'].atkTotal, 3);
  assert.equal(card.flags['vtm-v20-powers'].resist.difficulty, 7); // Manip 4 + Intim 3
  assert.match(renderSlot(card).innerHTML, /Waiting for Marcus/); // player can't roll for the NPC
  as(gm);
  assert.match(renderSlot(card).innerHTML, /Roll resistance/);
});

test('GM rolls resistance: outcome card, attacker wins by net, card resolved', async () => {
  as(gm);
  const card = lastResist();
  rollScript.push({ total: 1, outcome: 'success' });
  await api.rollResist(card);
  const resistRoll = rollCalls.at(-1);
  assert.equal(resistRoll.actor, 'Marcus');
  assert.equal(resistRoll.trait, 'willpower');
  assert.equal(resistRoll.difficulty, 7);
  const out = messages.at(-1);
  assert.equal(out.flags['vtm-v20-powers'].winner, 'attacker');
  assert.equal(out.flags['vtm-v20-powers'].net, 2);
  assert.equal(card.flags['vtm-v20-powers'].resolved, true);
  assert.match(renderSlot(card).innerHTML, /Resisted: 1 success/);
  const before = rollCalls.length;
  await api.rollResist(card); // can't roll twice
  assert.equal(rollCalls.length, before);
});

test('player-owned target resists; non-author player resolves via GM socket; tie -> defender', async () => {
  as(p1); currentTarget = { actor: vera };
  rollScript.push({ total: 2, outcome: 'success' });
  await game.vtm.rollDicePool(lucien, { trait: 'attributes.manipulation', label: 'Dominate: Mesmerize', difficulty: 6 });
  const card = lastResist();
  as(p2);
  assert.match(renderSlot(card).innerHTML, /Roll resistance \(Vera\)/);
  rollScript.push({ total: 2, outcome: 'success' });
  await api.rollResist(card);
  assert.equal(messages.at(-1).flags['vtm-v20-powers'].winner, 'defender');
  assert.equal(card.flags['vtm-v20-powers'].resolved, false); // p2 isn't author or GM
  assert.equal(emitted.at(-1)[0], 'module.vtm-v20-powers');
  as(gm);
  globalThis.__sock(emitted.at(-1)[1]);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(card.flags['vtm-v20-powers'].resolved, true);
});

test('failed or botched attack: no resist card', async () => {
  as(p1); currentTarget = { actor: marcus };
  const n = messages.length;
  rollScript.push({ total: 0, outcome: 'botch' });
  await game.vtm.rollDicePool(lucien, { trait: 'attributes.manipulation', label: 'Dominate: Mesmerize', difficulty: 6 });
  rollScript.push({ total: 0, outcome: 'failure' });
  await game.vtm.rollDicePool(lucien, { trait: 'attributes.manipulation', label: 'Dominate: Mesmerize', difficulty: 6 });
  assert.equal(messages.length, n);
});

test('cancelled roll dialog returns null and posts nothing', async () => {
  as(p1); currentTarget = { actor: marcus };
  const n = messages.length;
  rollScript.push(null);
  const r = await game.vtm.rollDicePool(lucien, { trait: 'attributes.manipulation', label: 'Dominate: Mesmerize', difficulty: 6 });
  assert.equal(r, null);
  assert.equal(messages.length, n);
});

test('clearing a config restores the plain roll', async () => {
  as(gm);
  await api.setConfig('discipline', 'Dominate', 'lvl1', null);
  assert.equal(api.getConfig('discipline', 'Dominate', 'lvl1'), null);
  as(p1); currentTarget = { actor: vera };
  await game.vtm.rollDicePool(lucien, { trait: 'attributes.manipulation', label: 'Dominate: Command', difficulty: 6 });
  assert.equal(rollCalls.at(-1).difficulty, 6);
});
