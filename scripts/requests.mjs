// Storyteller roll requests: a GM-only scene-controls button opens a window to
// ask players (and travelling NPC companions) for a single, extended, or
// teamwork roll. One chat card tracks every row; the active GM's client is
// the only writer, applying player results one at a time.
import {
  MODULE_ID, titleCase, traitLabel, newRequest, applyRequestRoll, requestRollable, singleTotal,
  clearRequestLock, removeRequestRow, splitBudget, splitActionDiff, checkAllocation, applySplitRoll, resetRequestRow,
  traitValue, withDisciplines,
} from './logic.mjs';

const DialogV2 = () => foundry.applications.api.DialogV2;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flagsOf = msg => msg?.flags?.[MODULE_ID];
let SOCKET = null;
let deps = {};

// ---------------------------------------------------------------------------
// Who can be asked

function companionsFolderIds() {
  const root = game.folders?.find(f => f.type === 'Actor' && f.name.trim().toLowerCase() === 'companions');
  if (!root) return new Set();
  const ids = new Set([root.id]);
  let grew = true;
  while (grew) { // include subfolders
    grew = false;
    for (const f of game.folders) if (f.type === 'Actor' && f.folder && ids.has(f.folder.id ?? f.folder) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
  }
  return ids;
}

export function playerCharacters() {
  const folderIds = companionsFolderIds();
  const players = game.users.filter(u => !u.isGM);
  return game.actors
    .filter(a => !folderIds.has(a.folder?.id))
    .map(a => ({ actor: a, owners: players.filter(u => a.testUserPermission(u, 'OWNER')).map(u => u.name) }))
    .filter(x => x.owners.length)
    .sort((a, b) => a.actor.name.localeCompare(b.actor.name));
}

export function companionActors() {
  const folderIds = companionsFolderIds();
  const out = new Map();
  for (const a of game.actors) if (folderIds.has(a.folder?.id)) out.set(a.uuid, a);
  for (const t of game.scenes?.viewed?.tokens ?? []) {
    const a = t.actor;
    if (a && !a.hasPlayerOwner && !out.has(a.uuid)) out.set(a.uuid, a);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Request window

function attrOptions() {
  const V = CONFIG.VTM ?? {};
  const groups = Object.entries(V.attributes ?? {}).map(([g, list]) =>
    `<optgroup label="${esc(titleCase(g))}">${list.map(k => `<option value="attributes.${k}">${esc(titleCase(k))}</option>`).join('')}</optgroup>`);
  groups.push(`<optgroup label="Other">${['virtues.conscience', 'virtues.selfControl', 'virtues.courage', 'willpower', 'humanity']
    .map(k => `<option value="${k}">${esc(k === 'willpower' ? 'Willpower' : traitLabel(k))}</option>`).join('')}</optgroup>`);
  return groups.join('');
}
function abilityOptions() {
  const V = CONFIG.VTM ?? {};
  return `<option value="">— none —</option>` + Object.entries(V.abilities ?? {}).map(([g, list]) =>
    `<optgroup label="${esc(titleCase(g))}">${list.map(k => `<option value="abilities.${k}">${esc(titleCase(k))}</option>`).join('')}</optgroup>`).join('');
}

export async function openRequestWindow() {
  if (!game.user.isGM) return;
  const pcs = playerCharacters();
  const npcs = companionActors();
  const selected = new Set((canvas?.tokens?.controlled ?? []).map(t => t.actor?.uuid).filter(Boolean));
  const assistOpts = pcs.map(p => `<option value="${esc(p.actor.uuid)}">Assists → ${esc(p.actor.name)}</option>`).join('');

  const content = `<div class="vpw-form vpw-request">
    <label class="vpw-row">Label <input type="text" name="label" placeholder="e.g. Research the catalogue"></label>
    <fieldset><legend>Players</legend>
      ${pcs.length ? pcs.map(p => `<label class="vpw-check"><input type="checkbox" name="pc" value="${esc(p.actor.uuid)}" ${selected.has(p.actor.uuid) ? 'checked' : ''}> ${esc(p.actor.name)} <span class="vpw-sub">(${esc(p.owners.join(', '))})</span></label>`).join('')
        : '<p class="vpw-sub">No player-owned characters.</p>'}
    </fieldset>
    <fieldset><legend>Companions</legend>
      ${npcs.length ? npcs.map(a => `<div class="vpw-companion"><label class="vpw-check"><input type="checkbox" name="npc" value="${esc(a.uuid)}" ${selected.has(a.uuid) ? 'checked' : ''}> ${esc(a.name)}</label>
        <select name="npcRole-${esc(a.uuid)}" aria-label="${esc(a.name)} acts as"><option value="">Own row</option>${assistOpts}</select></div>`).join('')
        : '<p class="vpw-sub">None. Put travelling NPCs in an Actors folder named <b>Companions</b>, or place their tokens on this scene.</p>'}
    </fieldset>
    <fieldset><legend>Roll</legend>
      <label class="vpw-row">Type <select name="type">
        <option value="single">Single roll</option>
        <option value="extended">Extended (each on their own)</option>
        <option value="team">Teamwork (shared total)</option>
        <option value="split">Split pool (multiple actions)</option></select></label>
      <div class="vpw-dep" data-when="type!=split">
      <label class="vpw-row">Attribute <select name="attr">${attrOptions()}</select></label>
      <label class="vpw-row">Ability <select name="ability">${abilityOptions()}</select></label>
      <label class="vpw-row">Difficulty <input type="number" name="difficulty" value="6" min="2" max="10"></label></div>
    </fieldset>
    <fieldset class="vpw-dep" data-when="type=split"><legend>Actions</legend>
      <p class="vpw-sub">Each character's budget is their smallest pool (minus wounds); they split it between the actions.</p>
      ${[1, 2, 3, 4].map(n => `<div class="vpw-split-line">
        <label class="vpw-check"><input type="checkbox" name="useAct${n}" ${n <= 2 ? 'checked' : ''}> Action ${n}</label>
        <div class="vpw-dep" data-when="useAct${n}">
          <label class="vpw-row">Label <input type="text" name="actLabel${n}" placeholder="e.g. ${n === 1 ? 'Find the password' : n === 2 ? 'Stay hidden' : 'Action ' + n}"></label>
          <label class="vpw-row">Attribute <select name="actAttr${n}">${attrOptions()}</select></label>
          <label class="vpw-row">Ability <select name="actAbility${n}">${abilityOptions()}</select></label>
          <label class="vpw-row">Difficulty <input type="number" name="actDiff${n}" value="6" min="2" max="10"></label>
        </div></div>`).join('')}
      <label class="vpw-row">+ difficulty to all <input type="number" name="extraDiff" value="0" min="0" max="8"></label>
      <p class="vpw-sub">For actions so different they're harder together, at your discretion.</p>
    </fieldset>
    <fieldset class="vpw-ext-fields vpw-dep" data-when="type=extended|team"><legend>Extended</legend>
      <label class="vpw-row">Successes needed <input type="number" name="goal" value="5" min="1"></label>
      <label class="vpw-row">On failure <select name="onFail"><option value="keep">Keep the total</option><option value="reset">Reset to 0</option></select></label>
      <label class="vpw-row">On botch <select name="onBotch"><option value="reset">Reset to 0</option><option value="lock">Reset and lock</option></select></label>
      <label class="vpw-row">Max rolls <input type="number" name="maxRolls" min="0" placeholder="unlimited"></label>
    </fieldset></div>`;

  const res = await DialogV2().wait({
    window: { title: 'Request Roll' }, content, rejectClose: false, position: { width: 520 },
    render: (event, dialog) => deps.bindDependents(dialog?.element ?? event?.target?.element),
    buttons: [
      { action: 'send', label: 'Send request', icon: 'fas fa-paper-plane', default: true, callback: (ev, btn) => {
        const f = btn.form;
        const e = f.elements;
        const pcsTicked = [...f.querySelectorAll('input[name="pc"]:checked')].map(i => i.value);
        const npcRows = [...f.querySelectorAll('input[name="npc"]:checked')].map(i => ({
          uuid: i.value, assists: f.querySelector(`select[name="npcRole-${CSS.escape(i.value)}"]`)?.value || '',
        }));
        return { label: e.label.value, attr: e.attr.value, ability: e.ability.value, type: e.type.value,
          difficulty: e.difficulty.value, goal: e.goal.value, onFail: e.onFail.value, onBotch: e.onBotch.value,
          maxRolls: e.maxRolls.value, pcs: pcsTicked, npcs: npcRows,
          extraDiff: e.extraDiff.value,
          actions: [1, 2, 3, 4].filter(n => e[`useAct${n}`].checked).map(n => ({
            label: e[`actLabel${n}`].value, attr: e[`actAttr${n}`].value, ability: e[`actAbility${n}`].value, difficulty: e[`actDiff${n}`].value,
          })) };
      } },
      { action: 'cancel', label: 'Cancel' },
    ],
  });
  if (!res || typeof res !== 'object') return;
  return createRequest(res);
}

export async function createRequest(res) {
  const nameOf = uuid => fromUuidSync(uuid)?.name ?? '?';
  const rows = res.pcs.map(u => ({ actorUuid: u, name: nameOf(u) }));
  const ticked = new Set(res.pcs);
  for (const n of res.npcs ?? []) {
    let assists = n.assists || null;
    if (assists && !ticked.has(assists)) {
      ui.notifications.warn(`${nameOf(n.uuid)} was set to assist ${nameOf(assists)}, who isn't on the request; giving them their own row.`);
      assists = null;
    }
    rows.push({ actorUuid: n.uuid, name: nameOf(n.uuid), companion: true, assists });
  }
  if (!rows.length) return ui.notifications.warn('Request Roll: tick at least one character.');
  if (res.type === 'split' && (res.actions?.length ?? 0) < 2) return ui.notifications.warn('Split pool: tick at least two actions.');
  if (res.type === 'split' && res.npcs?.some(n => n.assists)) ui.notifications.info('Split pool: companions get their own row (assisting isn\'t used for split rolls).');
  const state = newRequest({ ...res, rows });
  return ChatMessage.create({
    speaker: { alias: 'Storyteller' },
    content: `<div class="vpw-card vpw-req"><h3>${esc(state.label || 'Roll request')}</h3><div class="vpw-req-slot"></div></div>`,
    flags: { [MODULE_ID]: { kind: 'request', state } },
  });
}

// ---------------------------------------------------------------------------
// Pool values: the system's own effective ratings (Potence, Celerity, blood
// buffs) when its helper can be loaded; plain ratings otherwise.

let effective = null;
export async function loadSystemRatings() {
  try {
    const path = foundry.utils.getRoute?.('systems/vtm-v20/module/discipline-effects.mjs') ?? '/systems/vtm-v20/module/discipline-effects.mjs';
    const mod = await import(path);
    if (typeof mod.effectiveTraitValue === 'function') effective = mod.effectiveTraitValue;
  } catch (err) {
    console.warn(`${MODULE_ID} | system ratings helper not found; split budgets use sheet ratings`, err);
  }
}

export function traitDice(actor, key) {
  if (!key) return 0;
  const sys = withDisciplines(actor);
  if (key.startsWith('virtues.')) return Math.min(traitValue(sys, key), Number(sys.humanity ?? 10)); // system caps Virtue dice
  if (effective && (key.startsWith('attributes.') || key.startsWith('abilities.'))) {
    try { return Number(effective(actor, key)) || 0; } catch { /* fall through */ }
  }
  return traitValue(sys, key);
}

export function splitPoolsFor(actor, s) {
  const pools = s.actions.map(a => traitDice(actor, a.attr) + traitDice(actor, a.ability));
  return { pools, budget: splitBudget(pools, actor.system?.woundPenalty || 0) };
}

// ---------------------------------------------------------------------------
// Card

const poolText = s => /* s: request or split action */ [s.attr, s.ability].filter(Boolean).map(k => (k === 'willpower' ? 'Willpower' : traitLabel(k))).join(' + ');
const ROW_STATUS = { open: 'In progress', done: 'Goal reached', locked: 'Locked (botch)', out: 'Out of rolls', rolled: '' };
const outcomeText = l => (l.outcome === 'success' ? `${l.succ} success${l.succ === 1 ? '' : 'es'}` : l.outcome === 'botch' ? 'botch' : 'failure');

function bar(total, goal) {
  const pct = Math.min(100, Math.round((total / Math.max(1, goal)) * 100));
  return `<div class="vpw-ext-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${total}">
    <div class="vpw-ext-bar" style="width:${pct}%"></div><span>${total} / ${goal}</span></div>`;
}

function canRollFor(row) {
  if (game.user.isGM) return true;
  return !!fromUuidSync(row.actorUuid)?.isOwner;
}

function splitRowHtml(s, row) {
  const actor = fromUuidSync(row.actorUuid);
  const mine = canRollFor(row);
  const open = requestRollable(s, row.id).ok;
  const gm = game.user.isGM && s.status === 'open';
  let body = '';
  if (row.status === 'rolled') {
    body = `<ol class="vpw-split-results">${s.actions.map((a, i) => {
      const r = row.results?.[i] ?? {};
      const txt = r.skipped ? 'skipped' : r.outcome === 'success' ? `<b>${r.total}</b> success${r.total === 1 ? '' : 'es'}` : `<b>${r.outcome}</b>`;
      return `<li><span>${esc(a.label)} (${row.alloc?.[i] ?? 0} dice)</span><span>${txt}</span></li>`;
    }).join('')}</ol><p class="vpw-sub">Budget ${row.budget}</p>`;
  } else if (open && mine && actor) {
    const { pools, budget } = splitPoolsFor(actor, s);
    const even = s.actions.map((_, i) => Math.floor(budget / s.actions.length) + (i < budget % s.actions.length ? 1 : 0));
    body = `<div class="vpw-split-alloc" data-budget="${budget}">
      ${s.actions.map((a, i) => `<label class="vpw-split-slider"><span>${esc(a.label)} <span class="vpw-sub">(pool ${pools[i]})</span></span>
        <input type="range" min="0" max="${budget}" step="1" value="${even[i]}" data-alloc="${i}" aria-label="Dice for ${esc(a.label)}">
        <output>${even[i]}</output></label>`).join('')}
      <p class="vpw-split-sum">Allocated <b>${even.reduce((x, y) => x + y, 0)}</b> / ${budget}</p></div>`;
  } else {
    body = '<p class="vpw-sub">waiting</p>';
  }
  return `<div class="vpw-req-row" data-row="${row.id}">
    <div class="vpw-req-head"><span class="vpw-req-name">${esc(row.name)}${row.companion ? ' <span class="vpw-sub">(companion)</span>' : ''}</span></div>
    ${body}
    <div class="vpw-ext-buttons">
      ${open && mine ? `<button type="button" data-req="roll" data-row="${row.id}"><i class="fas fa-dice-d20"></i> Roll all</button>` : ''}
      ${gm && row.status === 'rolled' ? `<button type="button" data-req="reset" data-row="${row.id}"><i class="fas fa-rotate-left"></i> Reset row</button>` : ''}
      ${gm ? `<button type="button" class="vpw-req-remove" data-req="remove" data-row="${row.id}" title="Remove ${esc(row.name)}"><i class="fas fa-user-minus"></i></button>` : ''}
    </div></div>`;
}

function readAllocation(rowEl) {
  return [...(rowEl?.querySelectorAll('input[data-alloc]') ?? [])].map(i => Math.trunc(Number(i.value) || 0));
}

function bindSliders(slot) {
  for (const box of slot.querySelectorAll?.('.vpw-split-alloc') ?? []) {
    const budget = Number(box.dataset.budget) || 0;
    const sync = () => {
      const vals = [...box.querySelectorAll('input[data-alloc]')].map(i => { const o = i.parentElement?.querySelector('output'); if (o) o.textContent = i.value; return Number(i.value) || 0; });
      const sum = vals.reduce((a, b) => a + b, 0);
      const out = box.querySelector('.vpw-split-sum');
      if (out) {
        out.innerHTML = `Allocated <b>${sum}</b> / ${budget}${sum > budget ? ` <span class="vpw-warn">(${sum - budget} over)</span>` : sum < budget ? ` <span class="vpw-sub">(${budget - sum} unspent)</span>` : ''}`;
      }
      const btn = box.closest('.vpw-req-row')?.querySelector('[data-req="roll"]');
      if (btn) btn.disabled = sum > budget || sum < 1;
    };
    box.addEventListener('input', sync);
    sync();
  }
}

function rowHtml(s, row) {
  if (s.type === 'split') return splitRowHtml(s, row);
  const assist = row.role === 'assist';
  const parent = assist ? s.rows.find(r => r.id === row.parent) : null;
  const rollable = requestRollable(s, row.id).ok && canRollFor(row);
  const name = `${esc(row.name)}${row.companion ? ' <span class="vpw-sub">(companion)</span>' : ''}${assist ? ` <span class="vpw-sub">assisting ${esc(parent?.name)}</span>` : ''}`;
  let info = '';
  if (s.type === 'single') {
    if (!row.rolls) info = '<span class="vpw-sub">waiting</span>';
    else if (assist) info = `+${row.total}${row.last?.outcome === 'botch' ? ' (botch)' : ''}`;
    else {
      const t = singleTotal(s, row.id);
      const extra = t !== row.total ? ` <span class="vpw-sub">(${row.total} + ${t - row.total} help)</span>` : '';
      info = `<b>${t}</b> success${t === 1 ? '' : 'es'}${extra}${row.last?.outcome === 'botch' ? ' · <b>botch</b>' : ''}`;
    }
  } else if (s.type === 'team') {
    info = `${row.gained} contributed · ${row.rolls} roll${row.rolls === 1 ? '' : 's'}${row.status === 'locked' ? ' · <b>locked</b>' : ''}`;
  } else if (assist) {
    info = `+${row.gained} helped · ${row.rolls} roll${row.rolls === 1 ? '' : 's'}`;
  } else {
    info = `${row.rolls} roll${row.rolls === 1 ? '' : 's'}${s.maxRolls ? ` of ${s.maxRolls}` : ''} · <b>${ROW_STATUS[row.status] ?? row.status}</b>`;
  }
  const log = s.type === 'extended' && !assist && row.log?.length
    ? `<ol class="vpw-ext-log">${row.log.map(l => `<li><span>${esc(l.by)}: ${outcomeText(l)}</span><span>${l.total} / ${s.goal}${l.note ? ` · ${esc(l.note)}` : ''}</span></li>`).join('')}</ol>` : '';
  const gm = game.user.isGM && s.status === 'open';
  return `<div class="vpw-req-row ${assist ? 'vpw-req-assist' : ''}" data-row="${row.id}">
    <div class="vpw-req-head"><span class="vpw-req-name">${name}</span><span class="vpw-req-info">${info}</span></div>
    ${s.type === 'extended' && !assist ? bar(row.total, s.goal) : ''}
    ${log}
    <div class="vpw-ext-buttons">
      ${rollable ? `<button type="button" data-req="roll" data-row="${row.id}"><i class="fas fa-dice-d20"></i> Roll</button>` : ''}
      ${gm && row.status === 'locked' ? `<button type="button" data-req="unlock" data-row="${row.id}"><i class="fas fa-lock-open"></i> Clear lock</button>` : ''}
      ${gm ? `<button type="button" class="vpw-req-remove" data-req="remove" data-row="${row.id}" title="Remove ${esc(row.name)}"><i class="fas fa-user-minus"></i></button>` : ''}
    </div></div>`;
}

export function renderRequest(message, root) {
  const s = flagsOf(message)?.state;
  const slot = root?.querySelector('.vpw-req-slot');
  if (!s || !slot) return;
  const rules = s.type === 'single' || s.type === 'split' ? '' : `<p class="vpw-sub">${s.type === 'team' ? 'Teamwork: successes pool together.' : 'Extended: each character on their own.'}
    ${s.onFail === 'reset' ? ' Failure resets.' : ''} ${s.onBotch === 'lock' ? ' Botch resets and locks.' : ' Botch resets.'}
    ${s.maxRolls ? ` Max ${s.maxRolls} roll${s.maxRolls === 1 ? '' : 's'}${s.type === 'team' ? ' for the team' : ' each'}.` : ''}</p>`;
  const teamBlock = s.type === 'team'
    ? `${bar(s.team.total, s.goal)}<p class="vpw-ext-status vpw-ext-${s.team.status}"><b>${s.team.status === 'done' ? 'Goal reached' : s.team.status === 'out' ? 'Out of rolls' : 'In progress'}</b></p>
       ${s.teamLog?.length ? `<ol class="vpw-ext-log">${s.teamLog.map(l => `<li><span>${esc(l.by)}: ${outcomeText(l)}</span><span>${l.total} / ${s.goal}${l.note ? ` · ${esc(l.note)}` : ''}</span></li>`).join('')}</ol>` : ''}` : '';
  // assists listed directly under the row they help
  const ordered = [];
  for (const r of s.rows.filter(x => x.role === 'main')) { ordered.push(r); ordered.push(...s.rows.filter(x => x.parent === r.id)); }

  const header = s.type === 'split'
    ? `<p class="vpw-req-pool"><b>Multiple actions</b>: split the smallest pool between them.${s.extraDiff ? ` All actions +${s.extraDiff} difficulty.` : ''}</p>
       <ol class="vpw-split-actions">${s.actions.map(a => `<li><b>${esc(a.label)}</b>: ${esc(poolText(a))}, difficulty ${splitActionDiff(s, a)}</li>`).join('')}</ol>`
    : `<p class="vpw-req-pool"><b>${esc(poolText(s))}</b> · difficulty <b>${s.difficulty}</b>${s.type === 'single' ? '' : ` · <b>${s.goal}</b> successes needed`}</p>`;
  slot.innerHTML = `
    ${header}
    ${rules}${teamBlock}
    <div class="vpw-req-rows">${ordered.map(r => rowHtml(s, r)).join('')}</div>
    ${s.status === 'closed' ? '<p class="vpw-ext-status"><b>Request closed</b></p>' : ''}
    ${game.user.isGM && s.status === 'open' ? '<div class="vpw-ext-buttons"><button type="button" data-req="close"><i class="fas fa-xmark"></i> Close request</button></div>' : ''}`;

  bindSliders(slot);
  for (const btn of slot.querySelectorAll('[data-req]')) {
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      const action = btn.dataset.req;
      const rowId = btn.dataset.row;
      if (action === 'roll' && flagsOf(message)?.state?.type === 'split') return rollSplit(message, rowId, btn, readAllocation(btn.closest?.('.vpw-req-row')));
      if (action === 'roll') return rollRow(message, rowId, btn);
      if (game.user.isGM) enqueue(message.id, { action, rowId });
    });
  }
}

// ---------------------------------------------------------------------------
// Rolling and the GM write queue

async function rollRow(message, rowId, btn) {
  const s = flagsOf(message)?.state;
  const row = s?.rows.find(r => r.id === rowId);
  const ok = s && requestRollable(s, rowId);
  if (!ok?.ok) return ui.notifications.warn(`Can't roll: ${ok?.reason ?? 'request not found'}.`);
  if (!game.user.isGM && !game.users.activeGM) return ui.notifications.warn('The Storyteller needs to be connected to record this roll.');
  const actor = await fromUuid(row.actorUuid);
  if (!actor) return ui.notifications.error(`${row.name} is no longer available.`);
  if (btn) btn.disabled = true;
  try {
    const parent = row.parent ? s.rows.find(r => r.id === row.parent) : null;
    const label = `${s.label || 'Roll request'}${parent ? ` (assisting ${parent.name})` : ''}`;
    const res = await game.vtm.rollDicePool(actor, { trait: s.attr, trait2: s.ability, label, difficulty: s.difficulty });
    if (!res) return;
    const result = { total: Number(res.total) || 0, outcome: res.outcome };
    if (game.user.isGM) await enqueue(message.id, { action: 'roll', rowId, result });
    else game.socket.emit(SOCKET, { action: 'request', msgId: message.id, rowId, result, userId: game.user.id });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function rollSplit(message, rowId, btn, alloc) {
  const s = flagsOf(message)?.state;
  const row = s?.rows.find(r => r.id === rowId);
  const ok = s && requestRollable(s, rowId);
  if (!ok?.ok) return ui.notifications.warn(`Can't roll: ${ok?.reason ?? 'request not found'}.`);
  if (!game.user.isGM && !game.users.activeGM) return ui.notifications.warn('The Storyteller needs to be connected to record this roll.');
  const actor = await fromUuid(row.actorUuid);
  if (!actor) return ui.notifications.error(`${row.name} is no longer available.`);
  const { budget } = splitPoolsFor(actor, s);
  const check = checkAllocation(alloc, budget, s.actions.length);
  if (!check.ok) return ui.notifications.warn(`Split pool: ${check.reason}.`);
  if (btn) btn.disabled = true;
  try {
    const results = [];
    for (const [i, a] of s.actions.entries()) {
      if (!alloc[i]) { results.push(null); continue; }
      const res = await game.vtm.rollDicePool(actor, {
        trait: a.attr, trait2: a.ability, label: `${s.label ? `${s.label}: ` : ''}${a.label} (${alloc[i]} of ${budget} split dice)`,
        poolOverride: alloc[i], difficulty: splitActionDiff(s, a), adjust: true,
      });
      results.push(res ? { total: Number(res.total) || 0, outcome: res.outcome } : null);
    }
    const payload = { alloc, budget, results };
    if (game.user.isGM) await enqueue(message.id, { action: 'split', rowId, payload });
    else game.socket.emit(SOCKET, { action: 'request', kind: 'split', msgId: message.id, rowId, payload, userId: game.user.id });
  } finally {
    if (btn) btn.disabled = false;
  }
}

let queue = Promise.resolve();
export function enqueue(msgId, op) {
  queue = queue.then(() => applyOp(msgId, op)).catch(err => console.error(`${MODULE_ID} | request update failed`, err));
  return queue;
}

async function applyOp(msgId, op) {
  const msg = game.messages.get(msgId);
  const s = flagsOf(msg)?.state;
  if (!s) return;
  let next = null;
  if (op.action === 'roll') {
    if (!requestRollable(s, op.rowId).ok) return; // e.g. a teammate finished first
    next = applyRequestRoll(s, op.rowId, op.result);
  } else if (op.action === 'split') {
    if (!requestRollable(s, op.rowId).ok) return;
    const row = s.rows.find(r => r.id === op.rowId);
    const actor = row ? await fromUuid(row.actorUuid) : null;
    // the GM recomputes the budget so a stale or edited client can't overspend
    const budget = actor ? splitPoolsFor(actor, s).budget : op.payload.budget;
    if (!checkAllocation(op.payload.alloc, budget, s.actions.length).ok) {
      ui.notifications.warn(`${row?.name ?? 'A character'}'s split was over their budget of ${budget}; not recorded.`);
      return;
    }
    next = applySplitRoll(s, op.rowId, { ...op.payload, budget });
  } else if (op.action === 'reset') next = resetRequestRow(s, op.rowId);
  else if (op.action === 'unlock') next = clearRequestLock(s, op.rowId);
  else if (op.action === 'remove') next = removeRequestRow(s, op.rowId);
  else if (op.action === 'close') next = { ...s, status: 'closed' };
  if (next) await msg.update({ [`flags.${MODULE_ID}.state`]: next });
}

export function onRequestSocket(data) {
  if (data?.action !== 'request') return false;
  if (!game.users.activeGM?.isSelf) return true; // exactly one GM client writes
  const msg = game.messages.get(data.msgId);
  const row = flagsOf(msg)?.state?.rows?.find(r => r.id === data.rowId);
  const user = game.users.get(data.userId);
  const actor = row ? fromUuidSync(row.actorUuid) : null;
  if (!row || !user || !actor?.testUserPermission(user, 'OWNER')) return true;
  if (data.kind === 'split') {
    const p = data.payload ?? {};
    const alloc = Array.isArray(p.alloc) ? p.alloc.map(n => Math.trunc(Number(n) || 0)) : [];
    const results = Array.isArray(p.results) ? p.results.map(r => (r ? { total: Math.max(0, Number(r.total) || 0), outcome: r.outcome } : null)) : [];
    enqueue(msg.id, { action: 'split', rowId: row.id, payload: { alloc, results, budget: Number(p.budget) || 0 } });
    return true;
  }
  const outcome = ['success', 'failure', 'botch'].includes(data.result?.outcome) ? data.result.outcome : 'failure';
  enqueue(msg.id, { action: 'roll', rowId: row.id, result: { total: Math.max(0, Number(data.result?.total) || 0), outcome } });
  return true;
}

// ---------------------------------------------------------------------------
// Scene-controls button (Token tools), GM only

function onSceneControls(controls) {
  if (!game.user?.isGM) return;
  const tool = {
    name: 'vpwRequestRoll', title: 'Request Roll', icon: 'fas fa-dice', button: true, visible: true, order: 99,
    onChange: () => openRequestWindow(), onClick: () => openRequestWindow(),
  };
  if (Array.isArray(controls)) { // v12 shape
    controls.find(c => c.name === 'token')?.tools?.push(tool);
    return;
  }
  const tokens = controls?.tokens ?? controls?.token;
  if (tokens?.tools) tokens.tools[tool.name] = tool;
}

export function registerRequests({ socket, bindDependents }) {
  SOCKET = socket;
  Hooks.once('ready', loadSystemRatings);
  deps = { bindDependents };
  Hooks.on('getSceneControlButtons', onSceneControls);
}
