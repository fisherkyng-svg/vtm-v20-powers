// Storyteller roll requests: a GM-only scene-controls button opens a window to
// ask players (and travelling NPC companions) for a single, extended, or
// teamwork roll. One chat card tracks every row; the active GM's client is
// the only writer, applying player results one at a time.
import {
  MODULE_ID, titleCase, traitLabel, newRequest, applyRequestRoll, requestRollable, singleTotal,
  clearRequestLock, removeRequestRow,
} from './logic.mjs';

const DialogV2 = () => foundry.applications.api.DialogV2;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flagsOf = msg => msg?.flags?.[MODULE_ID];
let SOCKET = null;

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
      <label class="vpw-row">Attribute <select name="attr">${attrOptions()}</select></label>
      <label class="vpw-row">Ability <select name="ability">${abilityOptions()}</select></label>
      <label class="vpw-row">Type <select name="type">
        <option value="single">Single roll</option>
        <option value="extended">Extended (each on their own)</option>
        <option value="team">Teamwork (shared total)</option></select></label>
      <label class="vpw-row">Difficulty <input type="number" name="difficulty" value="6" min="2" max="10"></label>
    </fieldset>
    <fieldset class="vpw-ext-fields"><legend>Extended</legend>
      <label class="vpw-row">Successes needed <input type="number" name="goal" value="5" min="1"></label>
      <label class="vpw-row">On failure <select name="onFail"><option value="keep">Keep the total</option><option value="reset">Reset to 0</option></select></label>
      <label class="vpw-row">On botch <select name="onBotch"><option value="reset">Reset to 0</option><option value="lock">Reset and lock</option></select></label>
      <label class="vpw-row">Max rolls <input type="number" name="maxRolls" min="0" placeholder="unlimited"></label>
    </fieldset></div>`;

  const res = await DialogV2().wait({
    window: { title: 'Request Roll' }, content, rejectClose: false, position: { width: 520 },
    render: (event, dialog) => {
      const el = dialog?.element ?? event?.target?.element;
      const type = el?.querySelector('select[name="type"]');
      const ext = el?.querySelector('.vpw-ext-fields');
      const sync = () => { if (ext) ext.hidden = type?.value === 'single'; };
      type?.addEventListener('change', sync);
      sync();
    },
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
          maxRolls: e.maxRolls.value, pcs: pcsTicked, npcs: npcRows };
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
  const state = newRequest({ ...res, rows });
  return ChatMessage.create({
    speaker: { alias: 'Storyteller' },
    content: `<div class="vpw-card vpw-req"><h3>${esc(state.label || 'Roll request')}</h3><div class="vpw-req-slot"></div></div>`,
    flags: { [MODULE_ID]: { kind: 'request', state } },
  });
}

// ---------------------------------------------------------------------------
// Card

const poolText = s => [s.attr, s.ability].filter(Boolean).map(k => (k === 'willpower' ? 'Willpower' : traitLabel(k))).join(' + ');
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

function rowHtml(s, row) {
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
  const rules = s.type === 'single' ? '' : `<p class="vpw-sub">${s.type === 'team' ? 'Teamwork: successes pool together.' : 'Extended: each character on their own.'}
    ${s.onFail === 'reset' ? ' Failure resets.' : ''} ${s.onBotch === 'lock' ? ' Botch resets and locks.' : ' Botch resets.'}
    ${s.maxRolls ? ` Max ${s.maxRolls} roll${s.maxRolls === 1 ? '' : 's'}${s.type === 'team' ? ' for the team' : ' each'}.` : ''}</p>`;
  const teamBlock = s.type === 'team'
    ? `${bar(s.team.total, s.goal)}<p class="vpw-ext-status vpw-ext-${s.team.status}"><b>${s.team.status === 'done' ? 'Goal reached' : s.team.status === 'out' ? 'Out of rolls' : 'In progress'}</b></p>
       ${s.teamLog?.length ? `<ol class="vpw-ext-log">${s.teamLog.map(l => `<li><span>${esc(l.by)}: ${outcomeText(l)}</span><span>${l.total} / ${s.goal}${l.note ? ` · ${esc(l.note)}` : ''}</span></li>`).join('')}</ol>` : ''}` : '';
  // assists listed directly under the row they help
  const ordered = [];
  for (const r of s.rows.filter(x => x.role === 'main')) { ordered.push(r); ordered.push(...s.rows.filter(x => x.parent === r.id)); }

  slot.innerHTML = `
    <p class="vpw-req-pool"><b>${esc(poolText(s))}</b> · difficulty <b>${s.difficulty}</b>${s.type === 'single' ? '' : ` · <b>${s.goal}</b> successes needed`}</p>
    ${rules}${teamBlock}
    <div class="vpw-req-rows">${ordered.map(r => rowHtml(s, r)).join('')}</div>
    ${s.status === 'closed' ? '<p class="vpw-ext-status"><b>Request closed</b></p>' : ''}
    ${game.user.isGM && s.status === 'open' ? '<div class="vpw-ext-buttons"><button type="button" data-req="close"><i class="fas fa-xmark"></i> Close request</button></div>' : ''}`;

  for (const btn of slot.querySelectorAll('[data-req]')) {
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      const action = btn.dataset.req;
      const rowId = btn.dataset.row;
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
  } else if (op.action === 'unlock') next = clearRequestLock(s, op.rowId);
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

export function registerRequests({ socket }) {
  SOCKET = socket;
  Hooks.on('getSceneControlButtons', onSceneControls);
}
