import { registerElder } from './elder.mjs';
import {
  MODULE_ID, POWER_ITEM_TYPES, ELDER_TYPE, powerKey, traitLabel, normalizeConfig, isActive,
  targetDifficulty, resistDifficulty, contest, findPower, summarize, titleCase, defaultConfig,
} from './logic.mjs';

const SYSTEM_ID = 'vtm-v20';
const SOCKET = `module.${MODULE_ID}`;
const DialogV2 = () => foundry.applications.api.DialogV2;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flagsOf = msg => msg?.flags?.[MODULE_ID];

let originalRoll = null;
const busy = new Set();

// ---------------------------------------------------------------------------
// Config store: world setting keyed by Discipline/Path name + level

function allConfigs() { return game.settings.get(MODULE_ID, 'configs') ?? {}; }
function getConfig(type, name, lvl) {
  const raw = allConfigs()[powerKey(type, name, lvl)];
  return raw ? normalizeConfig(raw) : null;
}
async function setConfig(type, name, lvl, cfg) {
  const all = foundry.utils.deepClone(allConfigs());
  const key = powerKey(type, name, lvl);
  if (cfg && isActive(cfg)) all[key] = cfg; else delete all[key];
  await game.settings.set(MODULE_ID, 'configs', all);
}

function traitOptions() {
  const out = [];
  const V = CONFIG.VTM ?? {};
  for (const [group, list] of Object.entries(V.attributes ?? {})) for (const k of list) out.push({ key: `attributes.${k}`, group: `Attributes (${titleCase(group)})` });
  for (const [group, list] of Object.entries(V.abilities ?? {})) for (const k of list) out.push({ key: `abilities.${k}`, group: titleCase(group) });
  for (const k of ['conscience', 'selfControl', 'courage']) out.push({ key: `virtues.${k}`, group: 'Virtues' });
  out.push({ key: 'willpower', group: 'Other' }, { key: 'humanity', group: 'Other' });
  return out;
}

function traitSelect(name, value, { allowEmpty = true } = {}) {
  const groups = {};
  for (const o of traitOptions()) (groups[o.group] ??= []).push(o);
  return `<select name="${name}">${allowEmpty ? `<option value="" ${!value ? 'selected' : ''}>—</option>` : ''}
    ${Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(o =>
      `<option value="${o.key}" ${o.key === value ? 'selected' : ''}>${esc(traitLabel(o.key))}</option>`).join('')}</optgroup>`).join('')}
  </select>`;
}

// ---------------------------------------------------------------------------
// Roll interception

async function wrappedRoll(actor, opts = {}) {
  const match = actor?.items && opts?.label ? findPower(actor.items, opts.label) : null;
  const cfg = match ? getConfig(...match.cfg) : null;
  if (!cfg || !isActive(cfg)) return originalRoll(actor, opts);

  const target = game.user.targets?.first?.()?.actor ?? null;
  if (!target) {
    ui.notifications.warn(`${opts.label}: no token targeted. Rolling at the fixed difficulty${cfg.resist.enabled ? '; resolve the resistance by hand' : ''}.`);
    return originalRoll(actor, opts);
  }

  let difficulty = opts.difficulty;
  let label = opts.label;
  if (cfg.diff.mode === 'target') {
    difficulty = targetDifficulty(cfg, target.system);
    label = `${opts.label} vs ${target.name}`;
  }
  const result = await originalRoll(actor, { ...opts, difficulty, label });
  if (!result || !cfg.resist.enabled) return result;
  if (result.outcome !== 'success') return result; // nothing for the target to resist
  await postResistCard(actor, target, opts.label, cfg, result.total);
  return result;
}

// ---------------------------------------------------------------------------
// Resisted rolls

async function postResistCard(attacker, target, power, cfg, atkTotal) {
  const resist = { traits: cfg.resist.traits.filter(Boolean), difficulty: resistDifficulty(cfg, attacker.system) };
  const pool = resist.traits.map(traitLabel).join(' + ');
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: attacker }),
    content: `<div class="vpw-card">
      <h3>${esc(power)}</h3>
      <p><b>${esc(attacker.name)}</b> scored <b>${atkTotal}</b> success${atkTotal === 1 ? '' : 'es'} against <b>${esc(target.name)}</b>.</p>
      <p>${esc(target.name)} resists with <b>${esc(pool)}</b>, difficulty <b>${resist.difficulty}</b>.</p>
      <div class="vpw-resist-slot"></div></div>`,
    flags: { [MODULE_ID]: {
      kind: 'resist', power, atkTotal, resist, resolved: false,
      attackerName: attacker.name, targetName: target.name, targetUuid: target.uuid,
    } },
  });
}

function canResist(target) {
  return game.user.isGM || !!target?.isOwner;
}

async function rollResist(message) {
  const f = flagsOf(message);
  if (!f || f.resolved || busy.has(message.id)) return;
  const target = await fromUuid(f.targetUuid);
  if (!target) return ui.notifications.error(`${f.targetName} is no longer on the scene.`);
  if (!canResist(target)) return;
  busy.add(message.id);
  try {
    const res = await originalRoll(target, {
      trait: f.resist.traits[0] ?? '', trait2: f.resist.traits[1] ?? '',
      label: `Resist ${f.power}`, difficulty: f.resist.difficulty,
    });
    if (!res) return;
    const c = contest(f.atkTotal, res.total);
    const verdict = c.winner === 'attacker'
      ? `<b>${esc(f.attackerName)}</b> wins with <b>${c.net}</b> net success${c.net === 1 ? '' : 'es'}.`
      : c.net === 0 ? `Tie: <b>${esc(f.targetName)}</b> holds; the power fails.` : `<b>${esc(f.targetName)}</b> resists by <b>${c.net}</b>; the power fails.`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: target }),
      content: `<div class="vpw-card vpw-outcome ${c.winner}">
        <h3>${esc(f.power)}: Result</h3>
        <p>${esc(f.attackerName)} <b>${c.attacker}</b> vs ${esc(f.targetName)} <b>${c.defender}</b>${res.outcome === 'botch' ? ' (resistance botched)' : ''}</p>
        <p class="vpw-verdict">${verdict}</p></div>`,
      flags: { [MODULE_ID]: { kind: 'outcome', ...c, sourceId: message.id } },
    });
    await markResolved(message, res.total);
  } finally {
    busy.delete(message.id);
  }
}

async function markResolved(message, defTotal) {
  const update = { [`flags.${MODULE_ID}.resolved`]: true, [`flags.${MODULE_ID}.defTotal`]: defTotal };
  if (game.user.isGM || message.isAuthor) return message.update(update);
  game.socket.emit(SOCKET, { action: 'resolve', msgId: message.id, defTotal });
}

function onSocket(data) {
  if (data?.action !== 'resolve') return;
  if (!game.users.activeGM?.isSelf) return; // exactly one GM client writes
  const msg = game.messages.get(data.msgId);
  if (msg && !flagsOf(msg)?.resolved) {
    msg.update({ [`flags.${MODULE_ID}.resolved`]: true, [`flags.${MODULE_ID}.defTotal`]: data.defTotal });
  }
}

function onRenderMessage(message, html) {
  const f = flagsOf(message);
  if (f?.kind !== 'resist') return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const slot = root?.querySelector('.vpw-resist-slot');
  if (!slot) return;
  if (f.resolved) {
    slot.innerHTML = `<p class="vpw-sub">Resisted: ${f.defTotal ?? 0} success${f.defTotal === 1 ? '' : 'es'}.</p>`;
    return;
  }
  const target = fromUuidSync(f.targetUuid);
  if (!canResist(target)) {
    slot.innerHTML = `<p class="vpw-sub">Waiting for ${esc(f.targetName)} to resist…</p>`;
    return;
  }
  slot.innerHTML = `<button type="button" class="vpw-resist-btn"><i class="fas fa-shield-halved"></i> Roll resistance (${esc(f.targetName)})</button>`;
  const btn = slot.querySelector('button');
  btn.addEventListener('click', ev => {
    ev.preventDefault();
    btn.disabled = true;
    rollResist(message).finally(() => { btn.disabled = false; });
  });
}

// ---------------------------------------------------------------------------
// Config UI on Discipline / Path sheets

// Regular powers are addressed by Discipline + level; Elder powers by their own name
function configAddress(item, lvl) {
  if (item.type === ELDER_TYPE) return { addr: ['elder', item.name, 'elder'], title: `${item.system.discipline || 'Elder'} · ${item.name}`, scope: `the Elder power <b>${esc(item.name)}</b> on every character` };
  const power = item.system.powers?.[lvl]?.name || lvl.replace('lvl', 'Level ');
  return { addr: [item.type, item.name, lvl], title: `${item.name} · ${power}`, scope: `<b>${esc(item.name)}</b> level ${lvl.replace('lvl', '')} on every character` };
}

async function editConfig(item, lvl) {
  const { addr, title, scope } = configAddress(item, lvl);
  const cfg = getConfig(...addr) ?? defaultConfig();
  const content = `<div class="vpw-form">
    <fieldset><legend>Attacker's difficulty</legend>
      <label class="vpw-row">Source <select name="diffMode">
        <option value="fixed" ${cfg.diff.mode === 'fixed' ? 'selected' : ''}>Fixed (the power's Diff box)</option>
        <option value="target" ${cfg.diff.mode === 'target' ? 'selected' : ''}>From the target's traits</option></select></label>
      <label class="vpw-row">Target trait ${traitSelect('diffT1', cfg.diff.traits[0], { allowEmpty: false })}</label>
      <label class="vpw-row">+ trait ${traitSelect('diffT2', cfg.diff.traits[1])}</label>
      <label class="vpw-row">Modifier <input type="number" name="diffMod" value="${cfg.diff.mod}" step="1"></label>
    </fieldset>
    <fieldset><legend>Resisted roll</legend>
      <label class="vpw-check"><input type="checkbox" name="resEnabled" ${cfg.resist.enabled ? 'checked' : ''}> Target rolls to resist</label>
      <label class="vpw-row">Resist trait ${traitSelect('resT1', cfg.resist.traits[0], { allowEmpty: false })}</label>
      <label class="vpw-row">+ trait ${traitSelect('resT2', cfg.resist.traits[1])}</label>
      <label class="vpw-row">Resist difficulty <select name="resDiffMode">
        <option value="fixed" ${cfg.resist.diffMode === 'fixed' ? 'selected' : ''}>Fixed number</option>
        <option value="attacker" ${cfg.resist.diffMode === 'attacker' ? 'selected' : ''}>From the attacker's traits</option></select></label>
      <label class="vpw-row">Fixed difficulty <input type="number" name="resDiff" value="${cfg.resist.diff}" min="2" max="10"></label>
      <label class="vpw-row">Attacker trait ${traitSelect('resA1', cfg.resist.attackerTraits[0])}</label>
      <label class="vpw-row">+ trait ${traitSelect('resA2', cfg.resist.attackerTraits[1])}</label>
      <label class="vpw-row">Modifier <input type="number" name="resMod" value="${cfg.resist.mod}" step="1"></label>
    </fieldset>
    <p class="vpw-sub">Applies to ${scope}. Ties go to the resister.</p></div>`;
  const res = await DialogV2().wait({
    window: { title: `Contest: ${title}` }, content, rejectClose: false, position: { width: 480 },
    buttons: [
      { action: 'save', label: 'Save', icon: 'fas fa-check', default: true, callback: (ev, btn) => {
        const e = btn.form.elements;
        return normalizeConfig({
          diff: { mode: e.diffMode.value, traits: [e.diffT1.value, e.diffT2.value], mod: e.diffMod.value },
          resist: { enabled: e.resEnabled.checked, traits: [e.resT1.value, e.resT2.value], diffMode: e.resDiffMode.value,
            diff: e.resDiff.value, attackerTraits: [e.resA1.value, e.resA2.value], mod: e.resMod.value },
        });
      } },
      { action: 'clear', label: 'Clear' },
      { action: 'cancel', label: 'Cancel' },
    ],
  });
  if (res === 'clear') await setConfig(...addr, null);
  else if (res && typeof res === 'object') await setConfig(...addr, res);
  else return;
  item.sheet?.render();
}

function onRenderItemSheet(app, element) {
  const item = app.document;
  if (game.system.id !== SYSTEM_ID || !POWER_ITEM_TYPES.includes(item?.type)) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;
  for (const block of root.querySelectorAll('.power-level')) {
    const sel = block.querySelector('select[name$=".primary"]');
    const lvl = sel?.name?.match(/powers\.(lvl\d)\./)?.[1];
    if (!lvl) continue;
    block.querySelector('.vpw-config')?.remove();
    const cfg = getConfig(item.type, item.name, lvl);
    const text = cfg ? summarize(cfg) : '';
    if (!text && !game.user.isGM) continue;
    const row = document.createElement('div');
    row.className = 'vpw-config';
    row.innerHTML = `<span class="vpw-summary">${text ? `<i class="fas fa-crosshairs"></i> ${esc(text)}` : ''}</span>
      ${game.user.isGM ? `<button type="button" class="vpw-edit" title="Contest settings"><i class="fas fa-crosshairs"></i> ${text ? 'Edit' : 'Contest…'}</button>` : ''}`;
    row.querySelector('.vpw-edit')?.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); editConfig(item, lvl); });
    (block.querySelector('.power-meta') ?? block.querySelector('.power-header'))?.after(row);
  }
}

// ---------------------------------------------------------------------------
// Registration

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'configs', { scope: 'world', config: false, type: Object, default: {} });
  Hooks.on('renderItemSheetV2', onRenderItemSheet);
  Hooks.on('renderChatMessageHTML', onRenderMessage);
  registerElder({ getConfig, editConfig, traitSelect, summarize });
  game.modules.get(MODULE_ID).api = { getConfig, setConfig, editConfig, rollResist };
});

Hooks.once('ready', () => {
  if (game.system.id !== SYSTEM_ID) return ui.notifications.warn('VtM V20 Powers only works with the Vampire: The Masquerade V20 system.');
  if (typeof game.vtm?.rollDicePool !== 'function') return ui.notifications.error('VtM V20 Powers: the system roll function was not found; contested powers are off.');
  originalRoll = game.vtm.rollDicePool.bind(game.vtm);
  game.vtm.rollDicePool = wrappedRoll;
  game.socket.on(SOCKET, onSocket);
});
