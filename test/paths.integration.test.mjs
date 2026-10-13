// Mock-Foundry run of paths.mjs: GM publishes path items to a world setting,
// every client extends the system's path list in place, path changes set the
// Instinct virtue flag, and the sheet safety net keeps unknown paths listed.
import test from 'node:test';
import assert from 'node:assert/strict';

const hooks = {};
const Hooks = {
  on(n, f) { (hooks[n] ??= []).push(f); }, once(n, f) { (hooks[n] ??= []).push(f); },
  async callAll(n, ...a) { for (const f of hooks[n] ?? []) await f(...a); },
};
const clone = o => JSON.parse(JSON.stringify(o));
const getProperty = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

const SYSTEM_PATHS = {
  Humanity: { virtues: { conscience: 'Conscience', selfControl: 'Self-Control' }, bearing: 'Normalcy' },
  'Path of the Beast': { virtues: { conscience: 'Conviction', selfControl: 'Instinct' }, bearing: 'Menace' },
};
const VTM = { paths: clone(SYSTEM_PATHS) };
const pathsRef = VTM.paths; // the system sheet holds this exact object
const settingStore = { 'vtm-v20-powers.paths': [] };
const onChange = {};
const gm = { id: 'gm', isGM: true };
const player = { id: 'p1', isGM: false };
const items = [];
const actors = [];
const renders = [];

function actor(name, pathName, flags = {}) {
  const a = {
    name, type: 'vampire', system: { pathName }, flags: clone(flags),
    getFlag(scope, k) { return this.flags[scope]?.[k]; },
    async setFlag(scope, k, v) { (this.flags[scope] ??= {})[k] = v; },
    async update(changes) {
      const diff = {};
      if ('system.pathName' in changes && changes['system.pathName'] !== this.system.pathName) {
        this.system.pathName = changes['system.pathName'];
        diff.system = { pathName: this.system.pathName };
      }
      await Hooks.callAll('updateActor', this, diff, {}, game.user.id);
    },
  };
  actors.push(a);
  return a;
}

Object.assign(globalThis, {
  Hooks,
  CONFIG: { VTM, Item: { dataModels: {} } },
  foundry: {
    utils: { deepClone: clone, getProperty },
    data: { fields: new Proxy({}, { get: () => class { constructor(...a) { this.a = a; } } }) },
    abstract: { TypeDataModel: class {} },
    applications: {
      api: { HandlebarsApplicationMixin: B => class extends B {}, DialogV2: { prompt: async o => { globalThis.__prompt = o; } } },
      sheets: { ItemSheetV2: class {} },
      apps: { DocumentSheetConfig: { registerSheet() {} } },
      instances: new Map([['s1', { document: { documentName: 'Actor' }, rendered: true, render() { renders.push('sheet'); } }]]),
    },
    documents: { Item: class {} },
  },
  game: {
    system: { id: 'vtm-v20' },
    user: gm,
    users: { get activeGM() { return { isSelf: game.user.isGM }; } },
    items: Object.assign(items, { filter: Array.prototype.filter.bind(items) }),
    actors,
    settings: {
      register(m, k, o) { onChange[`${m}.${k}`] = o.onChange; },
      get: (m, k) => clone(settingStore[`${m}.${k}`]),
      set: async (m, k, v) => { settingStore[`${m}.${k}`] = clone(v); await onChange[`${m}.${k}`]?.(v); },
    },
  },
});
globalThis.HTMLElement ??= class {};

const PATH = 'vtm-v20-powers.enlightenmentPath';
const { registerPaths, publishPaths, applyPaths, onRenderActorSheet } = await import('../scripts/paths.mjs');
registerPaths();

const evil = { type: PATH, name: 'Path of Evil Revelations', parent: null,
  system: { conscience: 'Conviction', selfControl: 'Instinct', bearing: 'Corruption', ethics: '<p>e</p>', sins: { r10: 'Sin ten', r1: 'Sin one' } } };

test('GM publishes path items; dropdown list extended in place', async () => {
  game.user = gm;
  items.push(evil);
  await Hooks.callAll('ready');
  assert.equal(settingStore['vtm-v20-powers.paths'].length, 1);
  assert.equal(VTM.paths, pathsRef, 'same object the system sheet holds');
  assert.deepEqual(Object.keys(VTM.paths), ['Humanity', 'Path of the Beast', 'Path of Evil Revelations']);
  assert.equal(VTM.paths['Path of Evil Revelations'].bearing, 'Corruption');
  assert.ok(renders.length > 0, 'open sheets re-render');
});

test('player client builds the list from the setting, without seeing the item', async () => {
  game.user = player;
  items.length = 0;            // players can't see GM-only world items
  for (const k of Object.keys(VTM.paths)) delete VTM.paths[k];
  Object.assign(VTM.paths, clone(SYSTEM_PATHS));
  applyPaths();
  assert.ok(VTM.paths['Path of Evil Revelations']);
  await publishPaths();        // not the GM: must not wipe the setting
  assert.equal(settingStore['vtm-v20-powers.paths'].length, 1);
  items.push(evil);
});

test('switching to an Instinct path sets the virtue flag frenzy rules read', async () => {
  game.user = player;
  const a = actor('Moth', 'Humanity');
  await a.update({ 'system.pathName': 'Path of Evil Revelations' });
  assert.deepEqual(a.getFlag('vtm-v20', 'virtueLabels'), { conscience: 'Conviction', selfControl: 'Instinct' });
  await a.update({ 'system.pathName': 'Humanity' });
  assert.deepEqual(a.getFlag('vtm-v20', 'virtueLabels'), { conscience: 'Conscience', selfControl: 'Self-Control' });
  await a.update({ 'system.pathName': 'Path of the Beast' }); // built-in paths fixed too
  assert.equal(a.getFlag('vtm-v20', 'virtueLabels').selfControl, 'Instinct');
});

test('another user\'s update does not write flags from this client', async () => {
  const a = actor('Niven', 'Humanity');
  game.user = player;
  a.system.pathName = 'Path of the Beast';
  await Hooks.callAll('updateActor', a, { system: { pathName: 'Path of the Beast' } }, {}, 'someone-else');
  assert.equal(a.getFlag('vtm-v20', 'virtueLabels'), undefined);
});

test('editing and deleting the item republishes; in-use path survives deletion', async () => {
  game.user = gm;
  actor('Zanatosa', 'Path of Evil Revelations');
  evil.system.bearing = 'Wickedness';
  await Hooks.callAll('updateItem', evil);
  assert.equal(VTM.paths['Path of Evil Revelations'].bearing, 'Wickedness');
  items.splice(items.indexOf(evil), 1);
  await Hooks.callAll('deleteItem', evil);
  assert.equal(settingStore['vtm-v20-powers.paths'].length, 0);
  assert.ok(VTM.paths['Path of Evil Revelations'], 'kept because Zanatosa is on it');
  assert.equal(VTM.paths['Path of Evil Revelations'].missing, true);
  actors.pop();
});

test('item on a character does not touch the world list', async () => {
  game.user = gm;
  const before = clone(settingStore['vtm-v20-powers.paths']);
  await Hooks.callAll('createItem', { ...evil, parent: { name: 'Moth' } });
  assert.deepEqual(settingStore['vtm-v20-powers.paths'], before);
});

test('sheet safety net: unknown current path gets listed and the sheet re-renders', () => {
  const a = actor('Enzo', 'Path of Homebrew');
  let rerendered = 0;
  const select = { options: [{ value: 'Humanity' }], parentElement: { querySelector: () => null }, after() {} };
  const root = Object.setPrototypeOf({ querySelector: s => (s === 'select[name="system.pathName"]' ? select : null) }, HTMLElement.prototype);
  onRenderActorSheet({ document: a, render: () => { rerendered++; } }, root);
  assert.equal(rerendered, 1);
  assert.ok(VTM.paths['Path of Homebrew']);
});

test('sins button opens the recorded hierarchy', async () => {
  game.user = gm;
  items.push(evil);
  await publishPaths();
  const a = actor('Moth2', 'Path of Evil Revelations');
  let btn;
  const select = { options: [{ value: 'Path of Evil Revelations' }], parentElement: { querySelector: () => null }, after(b) { btn = b; } };
  globalThis.document = { createElement: () => ({ addEventListener(_, f) { this.click = f; } }) };
  const root = Object.setPrototypeOf({ querySelector: () => select }, HTMLElement.prototype);
  onRenderActorSheet({ document: a, render() {} }, root);
  await btn.click({ preventDefault() {}, stopPropagation() {} });
  assert.match(globalThis.__prompt.content, /Sin ten/);
  assert.match(globalThis.__prompt.content, /Corruption|Wickedness/);
});
