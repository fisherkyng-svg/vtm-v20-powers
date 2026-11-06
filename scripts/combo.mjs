// Combination powers: a module-defined Item subtype for powers that need
// ratings in two or more Disciplines (e.g. Animalism 3 + Obfuscate 3) and are
// bought for a fixed XP cost. Built like Elder Powers: a library of world
// items the Storyteller drags onto sheets (or the XP module buys).
//
// Also here: clan restrictions. Combination powers carry them in
// system.clans; Merits and Flaws (system "merit" items) carry them in
// flags.vtm-v20-powers.clans. A restricted item can still go on anyone; the
// GM just gets a private note when it lands on a character of another clan.
import { spendCost, spentLine, attachCostButton } from './cost.mjs';
import {
  MODULE_ID, COMBO_TYPE, comboLabel, comboStatus, comboUsable, requirementsText,
  clanAllowed, clanTag,
} from './logic.mjs';

const SYSTEM_ID = 'vtm-v20';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX_REQS = 4;
let deps = null;

// ---------------------------------------------------------------------------
// Data model

function defineModel() {
  const f = foundry.data.fields;
  const str = () => new f.StringField({ required: true, blank: true, initial: '' });
  return class ComboPowerData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
      return {
        requirements: new f.ArrayField(new f.SchemaField({
          discipline: str(),
          level: new f.NumberField({ required: true, nullable: false, integer: true, min: 1, max: 10, initial: 1 }),
        }), { initial: [{ discipline: '', level: 1 }, { discipline: '', level: 1 }] }),
        xpCost: new f.NumberField({ required: true, nullable: false, integer: true, min: 0, initial: 0 }),
        primary: str(),
        secondary: str(),
        difficulty: new f.NumberField({ required: true, nullable: false, integer: true, min: 2, max: 10, initial: 6 }),
        cost: str(),
        clans: str(),
        description: new f.HTMLField({ initial: '' }),
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Using the power

export async function useCombo(item) {
  const actor = item.parent;
  if (!actor) return ui.notifications.warn('Put this Combination power on a character to use it.');
  const sys = item.system;
  const status = comboStatus(actor.items, sys.requirements);
  const short = status.filter(r => !r.ok);
  if (short.length) {
    const msg = `${actor.name} needs ${short.map(r => `${r.discipline} ${r.level} (has ${r.have})`).join(', ')} for ${item.name}.`;
    if (!game.user.isGM) return ui.notifications.warn(msg);
    ui.notifications.warn(`${msg} Rolling anyway (Storyteller).`);
  }
  const spent = await spendCost(actor, sys.cost, item.name);
  if (!spent) return null;
  const line = spentLine(actor, spent);
  if (!sys.primary) {
    return ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="vpw-card"><h3>${esc(item.name)}</h3><p>${esc(actor.name)} uses a Combination power (${esc(requirementsText(sys.requirements))}).</p>${line ? `<p class="vpw-sub">${esc(line)}</p>` : sys.cost ? `<p class="vpw-sub">Cost: ${esc(sys.cost)}</p>` : ''}</div>`,
    });
  }
  if (line) {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="vpw-card"><h3>${esc(item.name)}</h3><p class="vpw-sub">${esc(line)}</p></div>`,
      whisper: [...new Set([...game.users.filter(u => u.isGM).map(u => u.id), game.user.id])],
    });
  }
  return game.vtm.rollDicePool(actor, {
    trait: sys.primary, trait2: sys.secondary, label: comboLabel(item), difficulty: sys.difficulty,
  });
}

// ---------------------------------------------------------------------------
// Item sheet

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

const clanOptions = () => (CONFIG.VTM?.clans ?? game.vtm?.config?.clans ?? []).map(c => `<option value="${esc(c)}">`).join('');

function defineSheet() {
  const { HandlebarsApplicationMixin } = foundry.applications.api;
  const { ItemSheetV2 } = foundry.applications.sheets;
  return class ComboPowerSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
    static DEFAULT_OPTIONS = {
      classes: ['vtm-v20', 'sheet', 'item', 'vpw-elder-sheet', 'vpw-combo-sheet'],
      position: { width: 520, height: 'auto' },
      window: { resizable: true },
      form: { submitOnChange: true },
      actions: {
        roll: function () { return useCombo(this.document); },
        contest: function () { return deps.editConfig(this.document, 'combo'); },
        addReq: function () {
          const reqs = foundry.utils.deepClone(this.document.system.requirements ?? []);
          if (reqs.length >= MAX_REQS) return;
          reqs.push({ discipline: '', level: 1 });
          return this.document.update({ 'system.requirements': reqs });
        },
        removeReq: function (_ev, target) {
          const reqs = foundry.utils.deepClone(this.document.system.requirements ?? []);
          reqs.splice(Number(target.dataset.idx), 1);
          return this.document.update({ 'system.requirements': reqs });
        },
      },
    };
    static PARTS = { sheet: { template: `modules/${MODULE_ID}/templates/elder-power.hbs` } };

    // Requirement rows post as system.requirements.N.field; turn them back into an array
    _prepareSubmitData(event, form, formData, updateData) {
      const data = super._prepareSubmitData(event, form, formData, updateData);
      const reqs = data.system?.requirements;
      if (reqs && !Array.isArray(reqs)) {
        data.system.requirements = Object.keys(reqs).sort((a, b) => a - b).map(k => ({
          discipline: String(reqs[k]?.discipline ?? '').trim(), level: Number(reqs[k]?.level) || 1,
        }));
      }
      return data;
    }

    async _prepareContext(options) {
      const ctx = await super._prepareContext(options);
      const item = this.document;
      const sys = item.system;
      const owned = !!item.parent;
      const status = owned ? comboStatus(item.parent.items, sys.requirements) : null;
      const cfg = deps.getConfig('combo', item.name, 'combo');
      const discs = await disciplineNames();
      const source = item.getFlag(MODULE_ID, 'source') ?? '';
      const reqs = sys.requirements ?? [];
      const levels = Array.from({ length: 10 }, (_, i) => i + 1);
      const tag = clanTag(sys.clans);
      ctx.body = `
        <header class="vpw-elder-head">
          <img src="${esc(item.img)}" data-edit="img" alt="" width="48" height="48">
          <input type="text" name="name" value="${esc(item.name)}" placeholder="Power name">
        </header>
        ${tag ? `<div class="vpw-clan-tag">${esc(tag)}</div>` : ''}
        <div class="vpw-form">
          <div class="vpw-combo-reqs">
            <div class="vpw-sub">Requires</div>
            <datalist id="vpw-cdisc-${item.id}">${discs.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
            ${reqs.map((r, i) => `<div class="vpw-combo-req">
              <input type="text" name="system.requirements.${i}.discipline" value="${esc(r.discipline)}" list="vpw-cdisc-${item.id}" placeholder="Discipline">
              <select name="system.requirements.${i}.level" aria-label="Level">${levels.map(l => `<option value="${l}" ${l === r.level ? 'selected' : ''}>${l}</option>`).join('')}</select>
              ${status ? `<span class="${status.find(s => s.discipline === r.discipline)?.ok ? 'vpw-ok' : 'vpw-warn'}" title="Character's rating">${status.find(s => s.discipline === r.discipline)?.have ?? 0}</span>` : ''}
              <button type="button" data-action="removeReq" data-idx="${i}" title="Remove"><i class="fas fa-times"></i></button>
            </div>`).join('')}
            ${reqs.length < MAX_REQS ? '<button type="button" data-action="addReq" class="vpw-add-req"><i class="fas fa-plus"></i> Requirement</button>' : ''}
          </div>
          <label class="vpw-row">XP cost <input type="number" name="system.xpCost" value="${sys.xpCost}" min="0"></label>
          <label class="vpw-row">Roll ${deps.traitSelect('system.primary', sys.primary)}</label>
          <label class="vpw-row">+ ${deps.traitSelect('system.secondary', sys.secondary)}</label>
          <label class="vpw-row">Difficulty <input type="number" name="system.difficulty" value="${sys.difficulty}" min="2" max="10"></label>
          <label class="vpw-row">Cost <input type="text" name="system.cost" value="${esc(sys.cost)}" placeholder="e.g. 1 blood"></label>
          <label class="vpw-row">Clans <input type="text" name="system.clans" value="${esc(sys.clans)}" list="vpw-clans-${item.id}" placeholder="Anyone (or e.g. Nosferatu)"></label>
          <datalist id="vpw-clans-${item.id}">${clanOptions()}</datalist>
          <label class="vpw-row">Source <input type="text" name="flags.${MODULE_ID}.source" value="${esc(source)}" placeholder="Book and page"></label>
          <p class="vpw-sub">Leave Roll empty for powers that don't roll.</p>
        </div>
        <div class="vpw-elder-desc">
          ${this.isEditable
            ? `<prose-mirror name="system.description" toggled value="${esc(sys.description)}">${await enrich(sys.description, item)}</prose-mirror>`
            : await enrich(sys.description, item)}
        </div>
        <footer class="vpw-elder-foot">
          ${owned ? `<span class="${status.every(s => s.ok) ? 'vpw-ok' : 'vpw-warn'}">${status.every(s => s.ok) ? 'Requirements met' : 'Requirements not met'}</span>
            <button type="button" data-action="roll"><i class="fas fa-dice-d20"></i> ${sys.primary ? 'Roll' : 'Use'}</button>` : '<span class="vpw-sub">Library item. Drag onto a character to use it.</span>'}
          ${cfg ? `<span class="vpw-summary"><i class="fas fa-crosshairs"></i> ${esc(deps.summarize(cfg))}</span>` : ''}
          ${game.user.isGM ? `<button type="button" data-action="contest"><i class="fas fa-crosshairs"></i> ${cfg ? 'Edit contest' : 'Contest…'}</button>` : ''}
        </footer>`;
      return ctx;
    }

    _onRender(context, options) {
      super._onRender?.(context, options);
      deps.keepEnabled?.(this.element.querySelector('button[data-action="contest"]'));
      attachCostButton(this.element.querySelector('input[name="system.cost"]'), { title: this.document.name });
      if (this.isEditable) return;
      for (const el of this.element.querySelectorAll('input, select, textarea, button[data-action="addReq"], button[data-action="removeReq"]')) el.disabled = true;
    }
  };
}

// ---------------------------------------------------------------------------
// Character sheet: a "Combination Powers" block after the Disciplines

function comboRow(p, actor) {
  const status = comboStatus(actor.items, p.system.requirements);
  const ok = status.every(s => s.ok);
  const reqs = status.map(s => `<span class="${s.ok ? 'vpw-ok' : 'vpw-warn'}">${esc(s.discipline)} ${s.level}</span>`).join(' + ');
  const tag = clanTag(p.system.clans);
  return `<div class="vpw-elder-row vpw-combo-row ${ok ? '' : 'vpw-locked'}" data-combo-id="${p.id}" draggable="true" title="Drag to the Items sidebar or another sheet">
    <a class="vpw-elder-name" data-vpw="open" title="Open">${esc(p.name)}</a>
    <span class="vpw-combo-needs">${reqs}${tag ? ` · <em>${esc(tag)}</em>` : ''}</span>
    <button type="button" data-vpw="roll" title="${ok ? (p.system.primary ? 'Roll' : 'Use') : 'Requirements not met'}"><i class="fas fa-dice-d20"></i></button>
  </div>`;
}

function onRenderActorSheet(app, element) {
  const actor = app.document;
  if (game.system.id !== SYSTEM_ID || !['vampire', 'ghoul'].includes(actor?.type)) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;
  root.querySelectorAll('.vpw-combo-list').forEach(e => e.remove());
  const combos = actor.items.filter(i => i.type === COMBO_TYPE).sort((a, b) => a.name.localeCompare(b.name));
  if (!combos.length) return;

  // After the last Discipline row and any Elder list that follows it
  let anchor = null;
  for (const row of root.querySelectorAll('.item[data-item-id]')) {
    if (actor.items.get(row.dataset.itemId)?.type === 'discipline') anchor = row;
  }
  if (!anchor) return;
  while (anchor.nextElementSibling?.classList?.contains('vpw-elder-list')) anchor = anchor.nextElementSibling;

  const list = document.createElement('div');
  list.className = 'vpw-combo-list';
  list.innerHTML = `<div class="vpw-combo-title">Combination Powers</div>${combos.map(p => comboRow(p, actor)).join('')}`;
  anchor.after(list);

  list.addEventListener('dragstart', ev => {
    const row = ev.target.closest?.('[data-combo-id]');
    const item = row && actor.items.get(row.dataset.comboId);
    if (!item || !ev.dataTransfer) return;
    ev.stopPropagation();
    const data = typeof item.toDragData === 'function' ? item.toDragData() : { type: 'Item', uuid: item.uuid };
    ev.dataTransfer.setData('text/plain', JSON.stringify(data));
    ev.dataTransfer.effectAllowed = 'copy';
  });
  list.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-vpw]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const item = actor.items.get(btn.closest('[data-combo-id]').dataset.comboId);
    if (!item) return;
    if (btn.dataset.vpw === 'open') item.sheet.render(true);
    else useCombo(item);
  });
}

// ---------------------------------------------------------------------------
// Clan restrictions

export function itemClans(item) {
  if (item?.type === COMBO_TYPE) return item.system?.clans ?? '';
  return item?.flags?.[MODULE_ID]?.clans ?? '';
}

// GM-private note when a restricted item lands on a character of another clan.
// Runs on the client that created the item, so it posts once.
async function onCreateItem(item, _opts, userId) {
  if (userId !== game.user.id) return;
  const actor = item.parent;
  if (!actor || actor.documentName !== 'Actor') return;
  const clans = itemClans(item);
  if (!clans) return;
  const actorClan = actor.system?.clan ?? '';
  if (clanAllowed(clans, actorClan)) return;
  const gms = game.users.filter(u => u.isGM).map(u => u.id);
  if (!gms.length) return;
  await ChatMessage.create({
    content: `<div class="vpw-card"><h3>Clan restriction</h3><p><b>${esc(actor.name)}</b>${actorClan ? ` (${esc(actorClan)})` : ''} received <b>${esc(item.name)}</b>, which is ${esc(clanTag(clans))}.</p></div>`,
    whisper: gms,
  });
}

// Merit / Flaw sheets: a clan restriction field for the GM, a tag for everyone
function onRenderMeritSheet(app, element) {
  const item = app.document;
  if (game.system.id !== SYSTEM_ID || item?.type !== 'merit') return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;
  root.querySelectorAll('.vpw-clan-row').forEach(e => e.remove());
  const clans = item.getFlag(MODULE_ID, 'clans') ?? '';
  if (!clans && !game.user.isGM) return;
  const row = document.createElement('div');
  row.className = 'vpw-clan-row';
  if (game.user.isGM) {
    row.innerHTML = `<label>Clan restriction <input type="text" value="${esc(clans)}" list="vpw-clans-${item.id}" placeholder="Anyone (or e.g. Nosferatu)"></label>
      <datalist id="vpw-clans-${item.id}">${clanOptions()}</datalist>`;
    const input = row.querySelector('input');
    input.addEventListener('change', async ev => {
      ev.stopPropagation();
      const v = input.value.trim();
      await (v ? item.setFlag(MODULE_ID, 'clans', v) : item.unsetFlag(MODULE_ID, 'clans'));
    });
    deps.keepEnabled?.(input);
  } else {
    row.innerHTML = `<span class="vpw-clan-tag">${esc(clanTag(clans))}</span>`;
  }
  const form = root.querySelector('form') ?? root.querySelector('.window-content') ?? root;
  const head = form.querySelector('header, .sheet-header');
  if (head) head.after(row); else form.prepend(row);
}

// ---------------------------------------------------------------------------

export function registerCombo(d) {
  deps = d;
  CONFIG.Item.dataModels[COMBO_TYPE] = defineModel();
  const Sheet = defineSheet();
  const DSC = foundry.applications?.apps?.DocumentSheetConfig;
  const opts = { types: [COMBO_TYPE], makeDefault: true, label: 'Combination Power' };
  if (DSC?.registerSheet) DSC.registerSheet(foundry.documents?.Item ?? Item, MODULE_ID, Sheet, opts);
  else Items.registerSheet(MODULE_ID, Sheet, opts);
  Hooks.on('renderActorSheetV2', onRenderActorSheet);
  Hooks.on('renderItemSheetV2', onRenderMeritSheet);
  Hooks.on('createItem', onCreateItem);
}
