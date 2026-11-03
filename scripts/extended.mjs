// Extended actions: one chat tracker card per roller + power + target that
// accumulates successes toward a goal, with reset and scene-lock rules.
import { MODULE_ID, advanceExtended, extendedGoal, extendedKey } from './logic.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flagsOf = msg => msg?.flags?.[MODULE_ID];
const SAFE_OPTS = ['trait', 'trait2', 'label', 'pool', 'difficulty', 'poolMod', 'poolNote'];

let deps = null;
// Target forced by a tracker's Roll again button, consumed by the next roll
let forcedTarget = null;

export function setupExtended(d) { deps = d; }

// ---------------------------------------------------------------------------
// Finding trackers. Locks lapse when the scene changes or the combat they
// started in has ended; open trackers stay until they finish or are closed.

function lockLapsed(f) {
  if (f.status !== 'locked') return false;
  if (f.sceneId && f.sceneId !== (game.scenes?.viewed?.id ?? null)) return true;
  if (f.combatId && !game.combats?.get(f.combatId)) return true;
  return false;
}

export function findTracker(key) {
  const msgs = game.messages?.contents ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const f = flagsOf(msgs[i]);
    if (f?.kind !== 'extended' || f.key !== key) continue;
    if (f.status === 'open' || (f.status === 'locked' && !lockLapsed(f))) return msgs[i];
    return null; // the latest card for this key is finished
  }
  return null;
}

export function takeForcedTarget() {
  const t = forcedTarget;
  forcedTarget = null;
  return t;
}

// Called before the roll. Returns false to block it.
export function checkLock(actor, target, match) {
  const key = extendedKey(actor.uuid, match.cfg, target?.uuid);
  const msg = findTracker(key);
  if (flagsOf(msg)?.status !== 'locked') return true;
  const who = target ? ` on ${target.name}` : '';
  if (!game.user.isGM) {
    ui.notifications.warn(`${match.power.name ?? match.item.name}${who} is locked for the rest of the scene after a botch.`);
    return false;
  }
  ui.notifications.warn(`${match.power.name ?? match.item.name}${who} is locked by a botch; rolling anyway as Storyteller.`);
  return true;
}

// Called after a completed roll
export async function recordRoll(actor, target, match, cfg, opts, result) {
  if (!result) return;
  const key = extendedKey(actor.uuid, match.cfg, target?.uuid);
  const msg = findTracker(key);
  const power = opts.label ?? `${match.item.name}: ${match.power.name ?? ''}`;

  if (msg) {
    const f = flagsOf(msg);
    const state = advanceExtended({ total: f.total, goal: f.goal, status: 'open', log: f.log }, result, cfg);
    return writeState(msg, stateUpdate(state));
  }

  const goal = extendedGoal(cfg, target?.system, actor.system);
  if (goal === null) return;
  const state = advanceExtended({ total: 0, goal, status: 'open', log: [] }, result, cfg);
  const savedOpts = Object.fromEntries(SAFE_OPTS.filter(k => opts[k] !== undefined).map(k => [k, opts[k]]));
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="vpw-card vpw-ext"><h3>${esc(power)}</h3><div class="vpw-ext-slot"></div></div>`,
    flags: { [MODULE_ID]: {
      kind: 'extended', key, power,
      actorUuid: actor.uuid, actorName: actor.name,
      targetUuid: target?.uuid ?? null, targetName: target?.name ?? null,
      opts: savedOpts, ...stateFlags(state),
    } },
  });
}

function stateFlags(state) {
  return {
    total: state.total, goal: state.goal, status: state.status, log: state.log.slice(-12),
    sceneId: state.status === 'locked' ? (game.scenes?.viewed?.id ?? null) : null,
    combatId: state.status === 'locked' ? (game.combat?.id ?? null) : null,
  };
}
function stateUpdate(state) {
  return Object.fromEntries(Object.entries(stateFlags(state)).map(([k, v]) => [`flags.${MODULE_ID}.${k}`, v]));
}

// Players can only update their own messages, so other writes go via the GM
async function writeState(msg, update) {
  if (game.user.isGM || msg.isAuthor) return msg.update(update);
  game.socket.emit(deps.SOCKET, { action: 'extended', msgId: msg.id, update });
}

export function onExtendedSocket(data) {
  if (data?.action !== 'extended' || !game.users.activeGM?.isSelf) return false;
  const msg = game.messages.get(data.msgId);
  if (flagsOf(msg)?.kind !== 'extended') return true;
  // only this module's tracker fields may be written this way
  const allowed = ['total', 'goal', 'status', 'log', 'sceneId', 'combatId'].map(k => `flags.${MODULE_ID}.${k}`);
  const update = Object.fromEntries(Object.entries(data.update ?? {}).filter(([k]) => allowed.includes(k)));
  if (Object.keys(update).length) msg.update(update);
  return true;
}

// ---------------------------------------------------------------------------
// Card render

const STATUS_TEXT = { open: 'In progress', done: 'Goal reached', locked: 'Locked for the scene (botch)', closed: 'Closed' };

export function renderTracker(message, root) {
  const f = flagsOf(message);
  const slot = root?.querySelector('.vpw-ext-slot');
  if (f?.kind !== 'extended' || !slot) return;
  const actor = fromUuidSync(f.actorUuid);
  const canAct = game.user.isGM || !!actor?.isOwner;
  const lapsed = lockLapsed(f);
  const status = lapsed ? 'closed' : f.status;
  const pct = Math.min(100, Math.round((f.total / Math.max(1, f.goal)) * 100));
  const log = (f.log ?? []).map(l =>
    `<li><span>Roll ${l.n}: ${l.outcome === 'success' ? `+${l.gained}` : l.outcome}</span><span>${l.total} / ${f.goal}${l.note ? ` · ${esc(l.note)}` : ''}</span></li>`).join('');

  slot.innerHTML = `
    <p>${esc(f.actorName)}${f.targetName ? ` → <b>${esc(f.targetName)}</b>` : ''}</p>
    <div class="vpw-ext-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${f.goal}" aria-valuenow="${f.total}">
      <div class="vpw-ext-bar" style="width:${pct}%"></div><span>${f.total} / ${f.goal}</span></div>
    <p class="vpw-ext-status vpw-ext-${status}"><b>${STATUS_TEXT[status] ?? status}</b>${lapsed ? ' (lock expired)' : ''}</p>
    <ol class="vpw-ext-log">${log}</ol>
    ${canAct ? `<div class="vpw-ext-buttons">
      ${status === 'open' ? '<button type="button" data-ext="again"><i class="fas fa-dice-d20"></i> Roll again</button>' : ''}
      ${status === 'locked' && game.user.isGM ? '<button type="button" data-ext="unlock"><i class="fas fa-lock-open"></i> Clear lock</button>' : ''}
      ${status === 'open' || status === 'locked' ? '<button type="button" data-ext="close"><i class="fas fa-xmark"></i> Close</button>' : ''}
    </div>` : ''}`;

  slot.querySelector('[data-ext="again"]')?.addEventListener('click', ev => { ev.preventDefault(); rollAgain(message); });
  slot.querySelector('[data-ext="close"]')?.addEventListener('click', ev => {
    ev.preventDefault();
    writeState(message, { [`flags.${MODULE_ID}.status`]: 'closed' });
  });
  slot.querySelector('[data-ext="unlock"]')?.addEventListener('click', ev => {
    ev.preventDefault();
    writeState(message, { [`flags.${MODULE_ID}.status`]: 'open', [`flags.${MODULE_ID}.total`]: 0, [`flags.${MODULE_ID}.sceneId`]: null, [`flags.${MODULE_ID}.combatId`]: null });
  });
}

async function rollAgain(message) {
  const f = flagsOf(message);
  const actor = await fromUuid(f.actorUuid);
  if (!actor) return ui.notifications.error(`${f.actorName} is no longer available.`);
  if (f.targetUuid) {
    const target = await fromUuid(f.targetUuid);
    if (!target) return ui.notifications.error(`${f.targetName} is no longer on the scene.`);
    forcedTarget = target;
  }
  try {
    await game.vtm.rollDicePool(actor, { ...f.opts });
  } finally {
    forcedTarget = null;
  }
}
