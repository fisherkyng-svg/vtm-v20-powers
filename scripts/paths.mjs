// Paths of Enlightenment: a module-defined Item type the Storyteller creates
// in the Items sidebar. Path definitions reach every client through a world
// setting (written by the active GM), because players usually can't see
// world items. The system's path dropdown, virtue labels and bearing read
// CONFIG.VTM.paths, which this file extends in place.
import {
  MODULE_ID, PATH_TYPE, SIN_RATINGS, FIRST_VIRTUES, SECOND_VIRTUES,
  pathRecord, mergePaths, virtueFlagFor,
} from './logic.mjs';

const SYSTEM_ID = 'vtm-v20';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let BASE = null;
const extraInUse = new Set();

// ---------------------------------------------------------------------------
// Data model

function defineModel() {
  const f = foundry.data.fields;
  const str = (initial = '') => new f.StringField({ required: true, blank: true, initial });
  const sins = {};
  for (const r of SIN_RATINGS) sins[`r${r}`] = str();
  return class EnlightenmentPathData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
      return {
        conscience: new f.StringField({ required: true, initial: 'Conviction', choices: FIRST_VIRTUES }),
        selfControl: new f.StringField({ required: true, initial: 'Self-Control', choices: SECOND_VIRTUES }),
        bearing: str(),
        ethics: new f.HTMLField({ initial: '' }),
        sins: new f.SchemaField(sins),
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Sync: items -> world setting -> CONFIG.VTM.paths on every client

const records = () => game.settings.get(MODULE_ID, 'paths') ?? [];

function inUseNames() {
  const names = new Set(extraInUse);
  for (const a of game.actors ?? []) if (a.type === 'vampire' && a.system?.pathName) names.add(a.system.pathName);
  return [...names];
}

export function applyPaths() {
  const target = CONFIG.VTM?.paths;
  if (!target) return;
  BASE ??= foundry.utils.deepClone(target);
  const merged = mergePaths(BASE, records(), inUseNames());
  for (const k of Object.keys(target)) delete target[k];   // in place: the sheet holds this object
  Object.assign(target, merged);
}

export async function publishPaths() {
  if (!game.users.activeGM?.isSelf) return;
  const recs = game.items.filter(i => i.type === PATH_TYPE).map(pathRecord).filter(r => r.name);
  recs.sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(recs) === JSON.stringify(records())) return;
  await game.settings.set(MODULE_ID, 'paths', recs);
}

function rerenderActorSheets() {
  const apps = foundry.applications?.instances?.values?.() ?? [];
  for (const app of apps) if (app.document?.documentName === 'Actor' && app.rendered) app.render();
}

function onItemChange(item) {
  if (item?.type === PATH_TYPE && !item.parent) publishPaths();
}

// ---------------------------------------------------------------------------
// Instinct fix: when a character's path changes, store its virtue labels the
// way the system's chargen does, so frenzy rules follow the path.

export async function onUpdateActor(actor, changes, options, userId) {
  if (userId !== game.user.id || actor.type !== 'vampire') return;
  const newPath = foundry.utils.getProperty(changes, 'system.pathName');
  if (newPath === undefined) return;
  applyPaths();
  const want = virtueFlagFor(CONFIG.VTM.paths, newPath);
  if (!want) return;
  const have = actor.getFlag(SYSTEM_ID, 'virtueLabels');
  if (have?.conscience === want.conscience && have?.selfControl === want.selfControl) return;
  await actor.setFlag(SYSTEM_ID, 'virtueLabels', want);
}

// ---------------------------------------------------------------------------
// Character sheet: safety net + Hierarchy of Sins button

function showSins(pathName) {
  const r = records().find(x => x.name === pathName);
  const D = foundry.applications.api.DialogV2;
  if (!r) {
    return D.prompt({ window: { title: pathName }, rejectClose: false,
      content: `<p>No Hierarchy of Sins is recorded for <b>${esc(pathName)}</b>.</p>
        <p class="vpw-sub">Storyteller: create a <b>Path of Enlightenment</b> item with this exact name to add one.</p>` });
  }
  const rows = SIN_RATINGS.map(n => `<tr><td class="vpw-num">${n}</td><td>${esc(r.sins[n]) || '<span class="vpw-sub">—</span>'}</td></tr>`).join('');
  return D.prompt({
    window: { title: r.name }, position: { width: 520 }, rejectClose: false,
    content: `<div class="vpw-form vpw-sins">
      <p><b>Virtues:</b> ${esc(r.conscience)}, ${esc(r.selfControl)}, Courage · <b>Bearing:</b> ${esc(r.bearing || '—')}</p>
      ${r.ethics ? `<div class="vpw-ethics">${r.ethics}</div>` : ''}
      <table class="vpw-table"><tr><th>Rating</th><th>Minimum wrongdoing for a degeneration roll</th></tr>${rows}</table></div>`,
  });
}

export function onRenderActorSheet(app, element) {
  const actor = app.document;
  if (game.system.id !== SYSTEM_ID || actor?.type !== 'vampire') return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const select = root?.querySelector('select[name="system.pathName"]');
  if (!select) return;
  const current = actor.system.pathName || 'Humanity';
  // Safety net: a path missing from the list would make the next edit reset it
  if (![...select.options].some(o => o.value === current)) {
    extraInUse.add(current);
    applyPaths();
    return app.render();
  }
  if (select.parentElement.querySelector('.vpw-sins-btn')) return;
  const btn = document.createElement('a');
  btn.className = 'vpw-sins-btn';
  btn.title = 'Ethics and Hierarchy of Sins';
  btn.innerHTML = '<i class="fas fa-scroll"></i>';
  btn.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); showSins(actor.system.pathName || 'Humanity'); });
  select.after(btn);
}

// ---------------------------------------------------------------------------
// Item sheet

async function enrich(html, item) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  return TE?.enrichHTML ? TE.enrichHTML(html || '', { relativeTo: item }) : (html || '');
}

function defineSheet() {
  const { HandlebarsApplicationMixin } = foundry.applications.api;
  const { ItemSheetV2 } = foundry.applications.sheets;
  return class EnlightenmentPathSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
    static DEFAULT_OPTIONS = {
      classes: ['vtm-v20', 'sheet', 'item', 'vpw-path-sheet'],
      position: { width: 560, height: 'auto' },
      window: { resizable: true },
      form: { submitOnChange: true },
    };
    static PARTS = { sheet: { template: `modules/${MODULE_ID}/templates/elder-power.hbs` } };

    async _prepareContext(options) {
      const ctx = await super._prepareContext(options);
      const item = this.document;
      const s = item.system;
      const opt = (list, v) => list.map(x => `<option value="${x}" ${x === v ? 'selected' : ''}>${x}</option>`).join('');
      const sinRows = SIN_RATINGS.map(r => `<label class="vpw-row vpw-sin-row"><span class="vpw-num">${r}</span>
        <input type="text" name="system.sins.r${r}" value="${esc(s.sins?.[`r${r}`])}" placeholder="Wrongdoing at rating ${r}"></label>`).join('');
      ctx.body = `
        <header class="vpw-elder-head">
          <img src="${esc(item.img)}" data-edit="img" alt="" width="48" height="48">
          <input type="text" name="name" value="${esc(item.name)}" placeholder="Path of …">
        </header>
        <div class="vpw-form">
          <label class="vpw-row">First virtue <select name="system.conscience">${opt(FIRST_VIRTUES, s.conscience)}</select></label>
          <label class="vpw-row">Second virtue <select name="system.selfControl">${opt(SECOND_VIRTUES, s.selfControl)}</select></label>
          <label class="vpw-row">Bearing <input type="text" name="system.bearing" value="${esc(s.bearing)}" placeholder="e.g. Resolve"></label>
          <p class="vpw-sub">Instinct paths use the system's Instinct frenzy rules. The third virtue is always Courage.</p>
        </div>
        <h3 class="vpw-h">Ethics</h3>
        <div class="vpw-elder-desc">
          ${this.isEditable
            ? `<prose-mirror name="system.ethics" toggled value="${esc(s.ethics)}">${await enrich(s.ethics, item)}</prose-mirror>`
            : await enrich(s.ethics, item)}
        </div>
        <h3 class="vpw-h">Hierarchy of Sins</h3>
        <div class="vpw-form">${sinRows}</div>
        <p class="vpw-sub">${item.parent ? 'This copy is on a character; the path list uses the world item of the same name.'
          : 'Appears in every character sheet’s path list as soon as it’s saved. Use a built-in path’s exact name to add its sins or override it.'}</p>`;
      return ctx;
    }

    _onRender(context, options) {
      super._onRender?.(context, options);
      if (this.isEditable) return;
      for (const el of this.element.querySelectorAll('input, select, textarea')) el.disabled = true;
    }
  };
}

// ---------------------------------------------------------------------------

export function registerPaths() {
  CONFIG.Item.dataModels[PATH_TYPE] = defineModel();
  game.settings.register(MODULE_ID, 'paths', {
    scope: 'world', config: false, type: Array, default: [],
    onChange: () => { applyPaths(); rerenderActorSheets(); },
  });
  const Sheet = defineSheet();
  const DSC = foundry.applications?.apps?.DocumentSheetConfig;
  const opts = { types: [PATH_TYPE], makeDefault: true, label: 'Path of Enlightenment' };
  if (DSC?.registerSheet) DSC.registerSheet(foundry.documents?.Item ?? Item, MODULE_ID, Sheet, opts);
  else Items.registerSheet(MODULE_ID, Sheet, opts);

  Hooks.on('createItem', onItemChange);
  Hooks.on('updateItem', onItemChange);
  Hooks.on('deleteItem', onItemChange);
  Hooks.on('updateActor', onUpdateActor);
  Hooks.on('renderActorSheetV2', onRenderActorSheet);
  Hooks.once('ready', async () => { applyPaths(); await publishPaths(); applyPaths(); });
}
