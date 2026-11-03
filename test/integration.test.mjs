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
  const a = { name, system, items, uuid: `Actor.${name}`, owners, get isOwner() { return game.user.isGM || owners.includes(game.user.id); }, testUserPermission(u) { return !!u?.isGM || owners.includes(u?.id); } };
  actors[a.uuid] = a;
  return a;
}
const lucien = actor('Lucien', { attributes: { manipulation: 4 }, abilities: { intimidation: 3 }, willpower: { max: 5 } }, [
  { type: 'discipline', name: 'Dominate', system: { level: 6, powers: { lvl1: { name: 'Command' }, lvl2: { name: 'Mesmerize' }, lvl3: { name: 'Forgetful Mind' } } } },
], ['p1']);
const elderA = { id: 'eA', type: 'vtm-v20-powers.elderPower', name: 'Mass Mesmerize', system: { discipline: 'Dominate', level: 6, primary: 'attributes.manipulation', secondary: 'abilities.intimidation', difficulty: 7, cost: '' } };
const elderB = { id: 'eB', type: 'vtm-v20-powers.elderPower', name: 'Speak Through the Blood', system: { discipline: 'Dominate', level: 7, primary: 'attributes.manipulation', secondary: '', difficulty: 8, cost: '' } };
for (const e of [elderA, elderB]) { e.parent = lucien; lucien.items.push(e); }
const marcus = actor('Marcus', { attributes: { wits: 3 }, virtues: { courage: 2 }, willpower: { max: 8 } }, [], []);
const vera = actor('Vera', { willpower: { max: 4 } }, [], ['p2']);

const gm = { id: 'gm', name: 'ST', isGM: true };
const p1 = { id: 'p1', name: 'Player 1', isGM: false };
const p2 = { id: 'p2', name: 'Player 2', isGM: false };
let currentTarget = null;

Object.assign(globalThis, {
  Hooks,
  CONFIG: { VTM: { attributes: { mental: ['wits'] }, abilities: { talents: ['intimidation'] } }, Item: { dataModels: {} } },
  foundry: {
    utils: { deepClone: clone },
    data: { fields: new Proxy({}, { get: () => class { constructor(o) { this.o = o; } } }) },
    abstract: { TypeDataModel: class {} },
    applications: {
      api: { DialogV2: { wait: async () => null }, HandlebarsApplicationMixin: B => class extends B {}, ApplicationV2: class {} },
      sheets: { ItemSheetV2: class {} },
      apps: { DocumentSheetConfig: { registerSheet: (...a) => { (globalThis.__sheetRegs ??= []).push(a); } } },
    },
    documents: { Item: class {} },
  },
  ui: { notifications: { warn: m => notes.push(m), error: m => notes.push(m), info: m => notes.push(m) } },
  ChatMessage: { getSpeaker: ({ actor }) => ({ alias: actor?.name }), create: async d => makeMessage(d, game.user.id) },
  fromUuid: async u => actors[u] ?? null,
  fromUuidSync: u => actors[u] ?? null,
  game: {
    system: { id: 'vtm-v20' }, user: p1,
    users: { get activeGM() { return { isSelf: game.user.isGM }; }, get: id => [gm, p1, p2].find(u => u.id === id) },
    settings: { register() {}, registerMenu() {}, get: (m, k) => settings[`${m}.${k}`], set: async (m, k, v) => { settings[`${m}.${k}`] = v; } },
    modules: { get: () => (globalThis.__mod ??= {}) },
    messages: { get: id => messages.find(m => m.id === id), get contents() { return messages; } },
    socket: { emit: (ch, d) => emitted.push([ch, d]), on: (ch, f) => { globalThis.__sock = f; } },
    vtm: { async rollDicePool(a, opts) { rollCalls.push({ actor: a.name, ...opts }); return rollScript.length ? rollScript.shift() : { total: 1, outcome: 'success' }; } },
  },
});
Object.defineProperty(game.user, 'targets', { get: () => ({ first: () => currentTarget }), configurable: true });
for (const u of [p1, p2, gm]) Object.defineProperty(u, 'targets', { get: () => ({ first: () => currentTarget }) });

await import('../scripts/main.mjs');
const { rollElder } = await import('../scripts/elder.mjs');
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

test('Elder Power type registers its data model and sheet', () => {
  assert.ok(CONFIG.Item.dataModels['vtm-v20-powers.elderPower']);
  assert.ok(globalThis.__sheetRegs.some(a => a[3].types[0] === 'vtm-v20-powers.elderPower'));
  assert.ok(globalThis.__sheetRegs.some(a => a[3].types[0] === 'vtm-v20-powers.enlightenmentPath'));
  assert.ok(CONFIG.Item.dataModels['vtm-v20-powers.enlightenmentPath']);
});

test('Elder roll: usable power rolls with the shared label format', async () => {
  as(p1); currentTarget = null;
  await rollElder(elderA);
  assert.equal(rollCalls.at(-1).label, 'Dominate: Mass Mesmerize');
  assert.equal(rollCalls.at(-1).difficulty, 7);
  assert.equal(rollCalls.at(-1).trait2, 'abilities.intimidation');
});

test('Elder roll: rating too low blocks players, warns but allows Storyteller', async () => {
  as(p1);
  const n = rollCalls.length;
  await rollElder(elderB); // Dominate 6, power needs 7
  assert.equal(rollCalls.length, n);
  assert.match(notes.at(-1), /needs 7/);
  as(gm);
  await rollElder(elderB);
  assert.equal(rollCalls.length, n + 1);
});

test('Elder power uses its own contest config (resisted)', async () => {
  as(gm);
  await api.setConfig('elder', 'Mass Mesmerize', 'elder', { diff: { mode: 'target', traits: ['willpower', ''] }, resist: { enabled: true, traits: ['willpower', ''], diff: 6 } });
  as(p1); currentTarget = { actor: marcus };
  rollScript.push({ total: 4, outcome: 'success' });
  await rollElder(elderA);
  assert.equal(rollCalls.at(-1).difficulty, 8); // Marcus Willpower
  const card = lastResist();
  assert.equal(card.flags['vtm-v20-powers'].power, 'Dominate: Mass Mesmerize');
  assert.equal(card.flags['vtm-v20-powers'].atkTotal, 4);
});

// ---- extended actions ------------------------------------------------------
const EXT = 'vtm-v20-powers';
const lastExt = () => [...messages].reverse().find(m => m.flags?.[EXT]?.kind === 'extended');
function renderExt(msg) {
  const btns = {};
  const slot = { innerHTML: '', querySelector(sel) { const k = sel.match(/data-ext="(\w+)"/)?.[1]; if (!k || !this.innerHTML.includes(`data-ext="${k}"`)) return null; return (btns[k] ??= { addEventListener(_, f) { this.click = () => f({ preventDefault() {} }); } }); } };
  const root = { querySelector: s => (s === '.vpw-ext-slot' ? slot : null) };
  Object.setPrototypeOf(root, HTMLElement.prototype);
  hooks.renderChatMessageHTML[0](msg, root);
  return { slot, btns };
}
const forgetful = { trait: 'attributes.manipulation', label: 'Dominate: Forgetful Mind', difficulty: 7 };

test('current Willpower trait reads willpower.value; permanent stays max', async () => {
  const { traitValue, traitLabel } = await import('../scripts/logic.mjs');
  assert.equal(traitValue({ willpower: { value: 3, max: 8 } }, 'willpowerCurrent'), 3);
  assert.equal(traitValue({ willpower: { value: 3, max: 8 } }, 'willpower'), 8);
  assert.equal(traitLabel('willpowerCurrent'), 'Willpower (current)');
});

test('extended: card accumulates toward the target current Willpower, failure resets', async () => {
  marcus.system.willpower.value = 3;
  as(gm);
  await api.setConfig('discipline', 'Dominate', 'lvl3', { extended: { enabled: true, goalMode: 'target', traits: ['willpowerCurrent', ''], onFail: 'reset', onBotch: 'lock' } });
  as(p1); currentTarget = { actor: marcus };
  const before = messages.length;
  rollScript.push({ total: 2, outcome: 'success' });
  await game.vtm.rollDicePool(lucien, forgetful);
  const card = lastExt();
  assert.equal(messages.length, before + 1);
  assert.equal(rollCalls.at(-1).difficulty, 7); // fixed Diff untouched
  assert.deepEqual([card.flags[EXT].total, card.flags[EXT].goal, card.flags[EXT].status], [2, 3, 'open']);
  rollScript.push({ total: 0, outcome: 'failure' });
  await game.vtm.rollDicePool(lucien, forgetful);
  assert.equal(lastExt(), card); // same card updated
  assert.equal(card.flags[EXT].total, 0);
  rollScript.push({ total: 3, outcome: 'success' });
  await game.vtm.rollDicePool(lucien, forgetful);
  assert.equal(card.flags[EXT].status, 'done');
  assert.equal(card.flags[EXT].log.length, 3);
  assert.match(renderExt(card).slot.innerHTML, /Goal reached/);
});

test('extended: a finished tracker starts a new card; botch locks players out, GM can roll', async () => {
  as(p1); currentTarget = { actor: marcus };
  const done = lastExt();
  rollScript.push({ total: 0, outcome: 'botch' });
  await game.vtm.rollDicePool(lucien, forgetful);
  const card = lastExt();
  assert.notEqual(card, done);
  assert.equal(card.flags[EXT].status, 'locked');
  const calls = rollCalls.length;
  await game.vtm.rollDicePool(lucien, forgetful);
  assert.equal(rollCalls.length, calls); // blocked
  assert.match(notes.at(-1), /locked/);
  as(gm);
  rollScript.push({ total: 1, outcome: 'success' });
  await game.vtm.rollDicePool(lucien, forgetful);
  assert.equal(rollCalls.length, calls + 1);
  assert.deepEqual([card.flags[EXT].status, card.flags[EXT].total], ['open', 1]); // GM override reopens it
  rollScript.push({ total: 0, outcome: 'botch' });
  await game.vtm.rollDicePool(lucien, forgetful);
  assert.equal(card.flags[EXT].status, 'locked');
  const { btns } = renderExt(card);
  btns.unlock.click();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(card.flags[EXT].status, 'open');
});

test('extended: Roll again keeps the original target even with nothing targeted', async () => {
  as(p1); currentTarget = null;
  const card = lastExt();
  const { btns } = renderExt(card);
  rollScript.push({ total: 2, outcome: 'success' });
  btns.again.click();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(rollCalls.at(-1).label, 'Dominate: Forgetful Mind');
  assert.equal(card.flags[EXT].targetName, 'Marcus');
  assert.ok(card.flags[EXT].total >= 2);
});

test('extended: no target -> warns and rolls one-shot, no card', async () => {
  as(p1); currentTarget = null;
  const n = messages.length;
  await game.vtm.rollDicePool(lucien, forgetful);
  assert.equal(messages.length, n);
  assert.match(notes.at(-1), /track the extended total by hand/);
});

test('extended: GM socket writes only tracker fields', async () => {
  as(gm);
  const card = lastExt();
  globalThis.__sock({ action: 'extended', msgId: card.id, update: { [`flags.${EXT}.total`]: 9, [`flags.${EXT}.kind`]: 'hack', content: 'x' } });
  assert.equal(card.flags[EXT].total, 9);
  assert.equal(card.flags[EXT].kind, 'extended');
});

test('extended summary and activity', async () => {
  const { normalizeConfig, isActive, summarize } = await import('../scripts/logic.mjs');
  const c = normalizeConfig({ extended: { enabled: true, goalMode: 'fixed', goal: 4, onBotch: 'lock' } });
  assert.equal(isActive(c), true);
  assert.match(summarize(c), /Extended: goal 4 \(botch locks for the scene\)/);
});

// ---- Storyteller roll requests ---------------------------------------------
const lastReq = () => [...messages].reverse().find(m => m.flags?.[EXT]?.kind === 'request');
function renderReq(msg) {
  const slot = { innerHTML: '', btns: [], querySelectorAll(sel) {
    if (sel !== '[data-req]') return [];
    this.btns = [...this.innerHTML.matchAll(/data-req="(\w+)"(?: data-row="(\w+)")?/g)].map(m => ({
      dataset: { req: m[1], row: m[2] }, disabled: false, addEventListener(_, f) { this.click = () => f({ preventDefault() {} }); },
    }));
    return this.btns;
  } };
  const root = { querySelector: s => (s === '.vpw-req-slot' ? slot : null) };
  Object.setPrototypeOf(root, HTMLElement.prototype);
  hooks.renderChatMessageHTML[0](msg, root);
  return slot;
}
const flush = () => new Promise(r => setTimeout(r, 0));
const reqState = () => lastReq().flags[EXT].state;

test('request: GM creates a teamwork request with a companion row', async () => {
  as(gm);
  await api.createRequest({ label: 'Research', attr: 'attributes.intelligence', ability: 'abilities.occult', type: 'team',
    difficulty: 7, goal: 5, onFail: 'keep', onBotch: 'lock', maxRolls: '',
    pcs: ['Actor.Lucien', 'Actor.Vera'], npcs: [{ uuid: 'Actor.Marcus', assists: '' }] });
  const s = reqState();
  assert.deepEqual(s.rows.map(r => [r.name, r.role, r.companion]), [['Lucien', 'main', false], ['Vera', 'main', false], ['Marcus', 'main', true]]);
  assert.equal(s.difficulty, 7);
});

test('request: each player sees a Roll button only on their own rows', () => {
  as(p1);
  const btns = renderReq(lastReq()).btns.filter(b => b.dataset.req === 'roll').map(b => b.dataset.row);
  assert.deepEqual(btns, ['r1']);
  as(gm);
  const gmBtns = renderReq(lastReq()).btns;
  assert.deepEqual(gmBtns.filter(b => b.dataset.req === 'roll').map(b => b.dataset.row), ['r1', 'r2', 'r3']);
  assert.ok(gmBtns.some(b => b.dataset.req === 'close'));
});

test('request: player roll uses the requested pool and reaches the GM over the socket', async () => {
  as(p1);
  const n = emitted.length;
  rollScript.push({ total: 3, outcome: 'success' });
  renderReq(lastReq()).btns.find(b => b.dataset.req === 'roll').click();
  await flush();
  const call = rollCalls.at(-1);
  assert.deepEqual([call.actor, call.trait, call.trait2, call.difficulty, call.label], ['Lucien', 'attributes.intelligence', 'abilities.occult', 7, 'Research']);
  const sent = emitted.slice(n).find(e => e[1].action === 'request');
  assert.ok(sent);
  as(gm);
  globalThis.__sock(sent[1]);
  await flush(); await flush();
  assert.equal(reqState().team.total, 3);
});

test('request: GM ignores a roll for a character the sender does not own', async () => {
  as(gm);
  globalThis.__sock({ action: 'request', msgId: lastReq().id, rowId: 'r1', result: { total: 9, outcome: 'success' }, userId: 'p2' });
  await flush(); await flush();
  assert.equal(reqState().team.total, 3);
});

test('request: simultaneous teamwork results are applied in order and finish the goal', async () => {
  as(gm);
  const id = lastReq().id;
  globalThis.__sock({ action: 'request', msgId: id, rowId: 'r2', result: { total: 1, outcome: 'success' }, userId: 'p2' });
  globalThis.__sock({ action: 'request', msgId: id, rowId: 'r2', result: { total: 1, outcome: 'success' }, userId: 'p2' });
  await flush(); await flush(); await flush();
  const s = reqState();
  assert.equal(s.team.total, 5);
  assert.equal(s.team.status, 'done');
  assert.match(renderReq(lastReq()).innerHTML, /Goal reached/);
});

test('request: extended with an assisting companion, GM close', async () => {
  as(gm);
  await api.createRequest({ label: 'Track', attr: 'attributes.perception', ability: '', type: 'extended', difficulty: 6, goal: 4,
    onFail: 'reset', onBotch: 'reset', maxRolls: '2', pcs: ['Actor.Lucien'], npcs: [{ uuid: 'Actor.Marcus', assists: 'Actor.Lucien' }] });
  const id = lastReq().id;
  rollScript.push({ total: 2, outcome: 'success' }, { total: 1, outcome: 'success' });
  for (const row of ['r1', 'r2']) renderReq(lastReq()).btns.find(b => b.dataset.req === 'roll' && b.dataset.row === row).click(), await flush(), await flush();
  let s = reqState();
  assert.equal(s.rows[0].total, 3);
  assert.match(renderReq(lastReq()).innerHTML, /assisting Lucien/);
  renderReq(lastReq()).btns.find(b => b.dataset.req === 'close').click();
  await flush(); await flush();
  assert.equal(reqState().status, 'closed');
  assert.equal(lastReq().id, id);
});

test('request: an assist pointing at an unticked character becomes its own row', async () => {
  as(gm);
  await api.createRequest({ type: 'single', attr: 'attributes.wits', ability: '', difficulty: 6, pcs: ['Actor.Vera'], npcs: [{ uuid: 'Actor.Marcus', assists: 'Actor.Lucien' }] });
  assert.deepEqual(reqState().rows.map(r => r.role), ['main', 'main']);
  assert.match(notes.at(-1), /isn't on the request/);
});
