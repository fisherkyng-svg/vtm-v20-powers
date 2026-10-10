// Elder Power items: a module-defined Item subtype for Discipline powers at
// levels 6-10. Several can exist per level; each is its own Item, so the
// Storyteller builds a library in the Items sidebar and drags them onto sheets.
import {
  MODULE_ID, ELDER_TYPE, ELDER_MIN, ELDER_MAX, elderLabel, elderPowersFor, elderUsable,
} from './logic.mjs';

const SYSTEM_ID = 'vtm-v20';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lc = s => String(s ?? '').trim().toLowerCase();
let deps = null;

// ---------------------------------------------------------------------------
// Data model

function defineModel() {
  const f = foundry.data.fields;
  const str = () => new f.StringField({ required: true, blank: true, initial: '' });
  return class ElderPowerData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
      return {
        discipline: str(),
        level: new f.NumberField({ required: true, nullable: false, integer: true, min: ELDER_MIN, max: ELDER_MAX, initial: ELDER_MIN }),
        primary: str(),
        secondary: str(),
        difficulty: new f.NumberField({ required: true, nullable: false, integer: true, min: 2, max: 10, initial: 6 }),
        cost: str(),
        description: new f.HTMLField({ initial: '' }),
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Rolling

export function disciplineRating(actor, name) {
  const d = actor?.items?.find(i => i.type === 'discipline' && lc(i.name) === lc(name));
  return Number(d?.system?.level) || 0;
}

export async function rollElder(item) {
  const actor = item.parent;
  if (!actor) return ui.notifications.warn('Put this Elder power on a character to use it.');
  const sys = item.system;
  const rating = disciplineRating(actor, sys.discipline);
  if (!elderUsable(rating, sys.level)) {
    const msg = `${actor.name} has ${sys.discipline || 'that Discipline'} ${rating}; ${item.name} needs ${sys.level}.`;
    if (!game.user.isGM) return ui.notifications.warn(msg);
    ui.notifications.warn(`${msg} Rolling anyway (Storyteller).`);
  }
  if (!sys.primary) {
    // Powers with no roll just announce themselves
    return ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="vpw-card"><h3>${esc(elderLabel(item))}</h3><p>${esc(actor.name)} uses an Elder power (level ${sys.level}).${sys.cost ? ` Cost: ${esc(sys.cost)}.` : ''}</p></div>`,
    });
  }
  // Same label format as regular powers, so contest settings apply
  return game.vtm.rollDicePool(actor, {
    trait: sys.primary, trait2: sys.secondary, label: elderLabel(item), difficulty: sys.difficulty,
  });
}

// ---------------------------------------------------------------------------
// Sheet

async function disciplineNames() {
  const names = new Set(game.items.filter(i => i.type === 'discipline').map(i => i.name));
  const pack = game.packs.get(`${SYSTEM_ID}.disciplines`);
  if (pack) for (const e of await pack.getIndex()) if (e.type === 'discipline') names.add(e.name);
  return [...names].sort();
}

async function enrich(html, item) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  return TE?.enrichHTML ? TE.enrichHTML(html || '', { relativeTo: item }) : (html || '');
}

function defineSheet() {
  const { HandlebarsApplicationMixin } = foundry.applications.api;
  const { ItemSheetV2 } = foundry.applications.sheets;
  return class ElderPowerSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
    static DEFAULT_OPTIONS = {
      classes: ['vtm-v20', 'sheet', 'item', 'vpw-elder-sheet'],
      position: { width: 500, height: 'auto' },
      window: { resizable: true },
      form: { submitOnChange: true },
      actions: {
        roll: function () { return rollElder(this.document); },
        contest: function () { return deps.editConfig(this.document, 'elder'); },
      },
    };
    static PARTS = { sheet: { template: `modules/${MODULE_ID}/templates/elder-power.hbs` } };

    async _prepareContext(options) {
      const ctx = await super._prepareContext(options);
      const item = this.document;
      const sys = item.system;
      const owned = !!item.parent;
      const rating = owned ? disciplineRating(item.parent, sys.discipline) : null;
      const cfg = deps.getConfig('elder', item.name, 'elder');
      const discs = await disciplineNames();
      const levels = Array.from({ length: ELDER_MAX - ELDER_MIN + 1 }, (_, i) => ELDER_MIN + i);
      ctx.body = `
        <header class="vpw-elder-head">
          <img src="${esc(item.img)}" data-edit="img" alt="" width="48" height="48">
          <input type="text" name="name" value="${esc(item.name)}" placeholder="Power name">
        </header>
        <div class="vpw-form">
          <label class="vpw-row">Discipline
            <input type="text" name="system.discipline" value="${esc(sys.discipline)}" list="vpw-disc-${item.id}" placeholder="e.g. Dominate">
            <datalist id="vpw-disc-${item.id}">${discs.map(n => `<option value="${esc(n)}">`).join('')}</datalist></label>
          <label class="vpw-row">Level
            <select name="system.level">${levels.map(l => `<option value="${l}" ${l === sys.level ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="vpw-row">Roll ${deps.traitSelect('system.primary', sys.primary)}</label>
          <label class="vpw-row">+ ${deps.traitSelect('system.secondary', sys.secondary)}</label>
          <label class="vpw-row">Difficulty <input type="number" name="system.difficulty" value="${sys.difficulty}" min="2" max="10"></label>
          <label class="vpw-row">Cost <input type="text" name="system.cost" value="${esc(sys.cost)}" placeholder="e.g. 1 Willpower"></label>
          <p class="vpw-sub">Leave Roll empty for powers that don't roll.</p>
        </div>
        <div class="vpw-elder-desc">
          ${this.isEditable
            ? `<prose-mirror name="system.description" toggled value="${esc(sys.description)}">${await enrich(sys.description, item)}</prose-mirror>`
            : await enrich(sys.description, item)}
        </div>
        <footer class="vpw-elder-foot">
          ${owned ? `<span class="${elderUsable(rating, sys.level) ? 'vpw-ok' : 'vpw-warn'}">${esc(sys.discipline || 'Discipline')} ${rating} / needs ${sys.level}</span>
            <button type="button" data-action="roll"><i class="fas fa-dice-d20"></i> ${sys.primary ? 'Roll' : 'Use'}</button>` : '<span class="vpw-sub">Library item. Drag onto a character to use it.</span>'}
          ${cfg ? `<span class="vpw-summary"><i class="fas fa-crosshairs"></i> ${esc(deps.summarize(cfg))}</span>` : ''}
          ${game.user.isGM ? `<button type="button" data-action="contest"><i class="fas fa-crosshairs"></i> ${cfg ? 'Edit contest' : 'Contest…'}</button>` : ''}
        </footer>`;
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
// Character sheet: list Elder powers under their Discipline

function elderRow(p, rating) {
  const ok = elderUsable(rating, p.system.level);
  return `<div class="vpw-elder-row ${ok ? '' : 'vpw-locked'}" data-elder-id="${p.id}">
    <span class="vpw-elder-lvl">${p.system.level}</span>
    <a class="vpw-elder-name" data-vpw="open" title="Open">${esc(p.name)}</a>
    <button type="button" data-vpw="roll" title="${ok ? (p.system.primary ? 'Roll' : 'Use') : `Needs ${p.system.discipline} ${p.system.level}`}"><i class="fas fa-dice-d20"></i></button>
  </div>`;
}

function onRenderActorSheet(app, element) {
  const actor = app.document;
  if (game.system.id !== SYSTEM_ID || actor?.type !== 'vampire') return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;
  root.querySelectorAll('.vpw-elder-list').forEach(e => e.remove());
  const elders = actor.items.filter(i => i.type === ELDER_TYPE);
  if (!elders.length) return;

  const placed = new Set();
  let lastDiscRow = null;
  for (const row of root.querySelectorAll('.item[data-item-id]')) {
    const disc = actor.items.get(row.dataset.itemId);
    if (disc?.type !== 'discipline') continue;
    lastDiscRow = row;
    const powers = elderPowersFor(actor.items, disc.name);
    if (!powers.length) continue;
    powers.forEach(p => placed.add(p.id));
    const list = document.createElement('div');
    list.className = 'vpw-elder-list';
    list.innerHTML = powers.map(p => elderRow(p, disc.system.level)).join('');
    row.after(list);
  }
  const orphans = elders.filter(p => !placed.has(p.id));
  if (orphans.length && lastDiscRow) {
    const list = document.createElement('div');
    list.className = 'vpw-elder-list vpw-orphans';
    list.innerHTML = `<div class="vpw-sub">Elder powers with no matching Discipline:</div>${orphans.map(p => elderRow(p, 0)).join('')}`;
    lastDiscRow.parentElement.append(list);
  }
  for (const list of root.querySelectorAll('.vpw-elder-list')) {
    list.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-vpw]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const item = actor.items.get(btn.closest('[data-elder-id]').dataset.elderId);
      if (!item) return;
      if (btn.dataset.vpw === 'open') item.sheet.render(true);
      else rollElder(item);
    });
  }
}

// ---------------------------------------------------------------------------

export function registerElder(d) {
  deps = d;
  CONFIG.Item.dataModels[ELDER_TYPE] = defineModel();
  const Sheet = defineSheet();
  const DSC = foundry.applications?.apps?.DocumentSheetConfig;
  const opts = { types: [ELDER_TYPE], makeDefault: true, label: 'Elder Power' };
  if (DSC?.registerSheet) DSC.registerSheet(foundry.documents?.Item ?? Item, MODULE_ID, Sheet, opts);
  else Items.registerSheet(MODULE_ID, Sheet, opts);
  Hooks.on('renderActorSheetV2', onRenderActorSheet);
}
