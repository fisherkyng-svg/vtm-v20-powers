import { attachCostButton } from './cost.mjs';
// Discipline stat overrides: GM-set Diff / roll traits / cost per Discipline
// power that win over the system's compendium data (which is rebuilt from code)
// and over every copy of the Discipline, on characters and in the world.
import {
  MODULE_ID, POWER_LEVELS, STAT_FIELDS, DISCIPLINE_TYPE, statKey, normalizeStat, hasStat,
  statUpdates, stripOverridden, summarizeStat, traitLabel,
} from './logic.mjs';

const SETTING = 'statOverrides';
const PACK_ID = 'vtm-v20.disciplines';
const DialogV2 = () => foundry.applications.api.DialogV2;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flatten = o => foundry.utils.flattenObject(o);
const expand = o => foundry.utils.expandObject(o);

let deps = {};

// ---------------------------------------------------------------------------
// Store

export function allStats() { return game.settings.get(MODULE_ID, SETTING) ?? {}; }
export function getStat(name, lvl) {
  const o = allStats()[statKey(name)]?.[lvl];
  return hasStat(o) ? o : null;
}
async function setStat(name, lvl, o) {
  const all = foundry.utils.deepClone(allStats());
  const k = statKey(name);
  const clean = normalizeStat(o);
  if (hasStat(clean)) (all[k] ??= {})[lvl] = clean;
  else if (all[k]) { delete all[k][lvl]; if (!Object.keys(all[k]).length) delete all[k]; }
  await game.settings.set(MODULE_ID, SETTING, all);
}
// Display names for the manage window (keys are lower-cased)
async function setLabel(name) {
  const labels = foundry.utils.deepClone(game.settings.get(MODULE_ID, 'statOverrideLabels') ?? {});
  labels[statKey(name)] = name;
  await game.settings.set(MODULE_ID, 'statOverrideLabels', labels);
}

// ---------------------------------------------------------------------------
// Apply engine: compendium pack, world items, characters (and unlinked tokens)

async function collectTargets(onlyKeys) {
  const ov = allStats();
  const wanted = item => item?.type === DISCIPLINE_TYPE && (!onlyKeys || onlyKeys.has(statKey(item.name)));
  const plan = { pack: [], world: [], actors: [] };

  const pack = game.packs.get(PACK_ID);
  if (pack) for (const d of await pack.getDocuments()) {
    const u = wanted(d) && statUpdates(d, ov);
    if (u) plan.pack.push({ _id: d.id, ...u });
  }
  for (const d of game.items) {
    const u = wanted(d) && statUpdates(d, ov);
    if (u) plan.world.push({ _id: d.id, ...u });
  }
  const actorSets = [...game.actors];
  for (const scene of game.scenes ?? []) for (const t of scene.tokens ?? []) if (!t.actorLink && t.actor) actorSets.push(t.actor);
  for (const a of actorSets) {
    const ups = [];
    for (const d of a.items) {
      const u = wanted(d) && statUpdates(d, ov);
      if (u) ups.push({ _id: d.id, ...u });
    }
    if (ups.length) plan.actors.push({ actor: a, ups });
  }
  return { plan, pack };
}

export async function applyStats({ names = null, confirm = true } = {}) {
  if (!game.user.isGM || !Object.keys(allStats()).length) return 0;
  const onlyKeys = names ? new Set(names.map(statKey)) : null;
  const { plan, pack } = await collectTargets(onlyKeys);
  const chars = plan.actors.reduce((n, a) => n + a.ups.length, 0);
  const total = plan.pack.length + plan.world.length + chars;
  if (!total) { if (confirm) ui.notifications.info('Discipline overrides: everything already matches.'); return 0; }

  if (confirm) {
    const ok = await DialogV2().confirm({
      window: { title: 'Apply Discipline overrides' },
      content: `<p>Update these copies to match your overrides?</p><ul>
        <li>${plan.pack.length} compendium item${plan.pack.length === 1 ? '' : 's'}</li>
        <li>${plan.world.length} world item${plan.world.length === 1 ? '' : 's'}</li>
        <li>${chars} character cop${chars === 1 ? 'y' : 'ies'} on ${plan.actors.length} actor${plan.actors.length === 1 ? '' : 's'}</li></ul>
        <p class="vpw-sub">Overridden fields on those copies are replaced. Other fields are untouched.</p>`,
      rejectClose: false,
    });
    if (!ok) return 0;
  }

  if (plan.pack.length && pack) {
    const wasLocked = pack.locked;
    try {
      if (wasLocked) await pack.configure({ locked: false });
      await Item.updateDocuments(plan.pack.map(expand), { pack: pack.collection, vpwOverride: true });
    } finally {
      if (wasLocked) await pack.configure({ locked: true });
    }
  }
  if (plan.world.length) await Item.updateDocuments(plan.world.map(expand), { vpwOverride: true });
  for (const { actor, ups } of plan.actors) await actor.updateEmbeddedDocuments('Item', ups.map(expand), { vpwOverride: true });

  ui.notifications.info(`Discipline overrides applied to ${total} item${total === 1 ? '' : 's'}.`);
  return total;
}

// ---------------------------------------------------------------------------
// Hooks: new copies pick overrides up on creation (this also covers the
// system's compendium rebuild, which deletes and re-creates every item), and
// edits to an overridden field are turned back.

function onPreCreateItem(item) {
  if (item.type !== DISCIPLINE_TYPE) return;
  const u = statUpdates(item, allStats());
  if (u) item.updateSource(expand(u));
}

function onPreUpdateItem(item, changes, options) {
  if (options?.vpwOverride || item.type !== DISCIPLINE_TYPE) return;
  const flat = flatten(changes);
  const removed = stripOverridden(item, allStats(), flat);
  if (!removed.length) return;
  for (const k of Object.keys(changes)) delete changes[k];
  Object.assign(changes, expand(flat));
  ui.notifications.warn(`${item.name}: ${removed.length === 1 ? 'that field is' : 'those fields are'} set by a Discipline override. Change it with Stats… on the power.`);
  setTimeout(() => item.sheet?.rendered && item.sheet.render(), 0);
}

// Backstop for the rebuild: if anything slipped past preCreate, re-sync the pack
let resyncTimer = null;
function onUpdateSetting(setting) {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  if (!['vtm-v20.compendiumVersion', 'vtm-v20.authenticTextApplied'].includes(setting?.key)) return;
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => applyStats({ confirm: false }).catch(err => console.error(`${MODULE_ID} | override re-sync failed`, err)), 1500);
}

// ---------------------------------------------------------------------------
// Stats… dialog

function traitSelectWithCurrent(name, value) {
  let html = deps.traitSelect(name, value);
  if (value && !html.includes(`value="${value}"`)) {
    html = html.replace(/<\/select>\s*$/, `<option value="${esc(value)}" selected>${esc(traitLabel(value))}</option></select>`);
  }
  return html;
}

export async function editStats(item, lvl) {
  const power = item.system.powers?.[lvl] ?? {};
  const cur = getStat(item.name, lvl) ?? {};
  const val = f => (f in cur ? cur[f] : power[f] ?? (f === 'difficulty' ? 6 : ''));
  const chk = f => (f in cur ? 'checked' : '');
  const content = `<div class="vpw-form vpw-stats">
    <p class="vpw-sub">Tick a field to override it. Applies to <b>${esc(item.name)}</b> level ${lvl.replace('lvl', '')} everywhere: the compendium, world items, and every character's copy.</p>
    <fieldset><legend>${esc(power.name || lvl)}</legend>
      <label class="vpw-row"><span><input type="checkbox" name="useRoll" ${'primary' in cur || 'secondary' in cur ? 'checked' : ''}> Roll</span>${traitSelectWithCurrent('primary', val('primary'))}</label>
      <label class="vpw-row"><span>+ trait</span>${traitSelectWithCurrent('secondary', val('secondary'))}</label>
      <label class="vpw-row"><span><input type="checkbox" name="useDiff" ${chk('difficulty')}> Difficulty</span><input type="number" name="difficulty" value="${esc(val('difficulty'))}" min="2" max="10"></label>
      <label class="vpw-row"><span><input type="checkbox" name="useCost" ${chk('cost')}> Cost</span><input type="text" name="cost" value="${esc(val('cost'))}" placeholder="e.g. 1 blood"></label>
    </fieldset></div>`;

  const res = await DialogV2().wait({
    window: { title: `Stats: ${item.name} · ${power.name || lvl}` }, content, rejectClose: false, position: { width: 480 },
    render: (event, dialog) => {
      const root = dialog?.element ?? event?.target?.element;
      attachCostButton(root?.querySelector('input[name="cost"]'), { title: `${item.name} · ${power.name || lvl}` });
    },
    buttons: [
      { action: 'save', label: 'Save', icon: 'fas fa-check', default: true, callback: (ev, btn) => {
        const e = btn.form.elements;
        const o = {};
        if (e.useRoll.checked) { o.primary = e.primary.value; o.secondary = e.secondary.value; }
        if (e.useDiff.checked) o.difficulty = e.difficulty.value;
        if (e.useCost.checked) o.cost = e.cost.value;
        return o;
      } },
      { action: 'clear', label: 'Clear' },
      { action: 'cancel', label: 'Cancel' },
    ],
  });
  if (res === 'clear') {
    await setStat(item.name, lvl, null);
    ui.notifications.info(`Override cleared. Existing copies keep their current values; the compendium returns to the book value on its next rebuild.`);
  } else if (res && typeof res === 'object') {
    await setStat(item.name, lvl, res);
    await setLabel(item.name);
    if (getStat(item.name, lvl)) await applyStats({ names: [item.name] });
  } else return;
  item.sheet?.rendered && item.sheet.render();
}

// ---------------------------------------------------------------------------
// Sheet row: summary + Stats… button, added next to the Contest row

export function decorateRow(item, lvl, block) {
  if (item.type !== DISCIPLINE_TYPE) return;
  const o = getStat(item.name, lvl);
  if (!o && !game.user.isGM) return;
  block.querySelector('.vpw-stat')?.remove();
  const row = document.createElement('div');
  row.className = 'vpw-config vpw-stat';
  row.innerHTML = `<span class="vpw-summary">${o ? `<i class="fas fa-thumbtack"></i> ${esc(summarizeStat(o))}` : ''}</span>
    ${game.user.isGM ? `<button type="button" class="vpw-stats-btn" title="Discipline stat override"><i class="fas fa-sliders"></i> ${o ? 'Stats' : 'Stats…'}</button>` : ''}`;
  const btn = row.querySelector('.vpw-stats-btn');
  btn?.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); editStats(item, lvl); });
  deps.keepEnabled(btn);
  const anchor = block.querySelector('.vpw-config:not(.vpw-stat)') ?? block.querySelector('.power-meta') ?? block.querySelector('.power-header');
  anchor?.after(row);
}

// Contest setups still reading permanent Willpower, so the GM can switch
// the ones the book says use the current pool
function permanentWillpowerList() {
  const rows = [];
  for (const [key, cfg] of Object.entries(deps.allConfigs?.() ?? {})) {
    const uses = [];
    if (cfg?.diff?.mode === 'target' && cfg.diff.traits?.includes('willpower')) uses.push('difficulty');
    if (cfg?.resist?.enabled && (cfg.resist.traits?.includes('willpower') || cfg.resist.attackerTraits?.includes('willpower'))) uses.push('resistance');
    if (cfg?.extended?.enabled && cfg.extended.goalMode !== 'fixed' && cfg.extended.traits?.includes('willpower')) uses.push('extended goal');
    if (!uses.length) continue;
    const [type, name, lvl] = key.split('|');
    const where = lvl === 'elder' ? `${name} (Elder)` : lvl === 'combo' ? `${name} (Combination)` : `${name} ${lvl.replace('lvl', '')}`;
    rows.push(`<li>${esc(where)} · ${uses.join(', ')}</li>`);
  }
  if (!rows.length) return '';
  return `<h4>Contest setups using Willpower (permanent)</h4>
    <p class="vpw-sub">Most V20 powers use the target's <b>current</b> Willpower. Open each power's Contest… and switch the trait to Willpower (current) where the book says so.</p>
    <ul class="vpw-stat-list">${rows.join('')}</ul>`;
}

// ---------------------------------------------------------------------------
// Manage window (Module Settings → Discipline Stat Overrides)

function defineManager() {
  const { ApplicationV2 } = foundry.applications.api;
  return class StatOverrideManager extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: 'vpw-stat-overrides',
      classes: ['vtm-v20', 'vpw-stat-manager'],
      window: { title: 'Discipline Overrides & Setups', resizable: true },
      position: { width: 520, height: 'auto' },
      actions: {
        clear: async function (ev, target) {
          await setStat(target.dataset.name, target.dataset.lvl, null);
          this.render();
        },
        reapply: async function () { await applyStats(); this.render(); },
      },
    };
    async _renderHTML() {
      const all = allStats();
      const labels = game.settings.get(MODULE_ID, 'statOverrideLabels') ?? {};
      const rows = Object.entries(all).flatMap(([k, byLvl]) => POWER_LEVELS.filter(l => byLvl[l]).map(l =>
        `<li class="vpw-stat-item"><span><b>${esc(labels[k] ?? k)}</b> ${l.replace('lvl', '')} · ${esc(summarizeStat(byLvl[l]).replace(/^Override: /, ''))}</span>
          <button type="button" data-action="clear" data-name="${esc(labels[k] ?? k)}" data-lvl="${l}"><i class="fas fa-xmark"></i> Clear</button></li>`));
      const div = document.createElement('div');
      div.className = 'vpw-form';
      div.innerHTML = `${rows.length ? `<ul class="vpw-stat-list">${rows.join('')}</ul>` : '<p>No overrides yet. Use <b>Stats…</b> on a Discipline power to add one.</p>'}
        <p class="vpw-sub">Clearing leaves existing copies as they are; the compendium returns to the book value on its next rebuild.</p>
        ${permanentWillpowerList()}
        <button type="button" data-action="reapply"><i class="fas fa-rotate"></i> Re-apply all</button>`;
      return div;
    }
    _replaceHTML(result, content) { content.replaceChildren(result); }
  };
}

// ---------------------------------------------------------------------------

export function registerOverrides(d) {
  deps = d;
  game.settings.register(MODULE_ID, SETTING, { scope: 'world', config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, 'statOverrideLabels', { scope: 'world', config: false, type: Object, default: {} });
  game.settings.registerMenu(MODULE_ID, 'statOverrideMenu', {
    name: 'Discipline Stat Overrides',
    label: 'Manage Overrides',
    hint: 'GM values for Discipline powers (Diff, roll, cost) that beat the system compendium and every copy.',
    icon: 'fas fa-sliders',
    type: defineManager(),
    restricted: true,
  });
  Hooks.on('preCreateItem', onPreCreateItem);
  Hooks.on('preUpdateItem', onPreUpdateItem);
  Hooks.on('updateSetting', onUpdateSetting);
  Hooks.once('ready', () => {
    if (game.user.isGM && game.users.activeGM?.id === game.user.id) {
      // after the system's own ready-time rebuild has had a chance to run
      setTimeout(() => applyStats({ confirm: false }).catch(err => console.error(`${MODULE_ID} | override sync failed`, err)), 5000);
    }
  });
}
