// Pure rules logic for vtm-v20-powers. No Foundry globals here, so it can be
// unit-tested in Node.

export const MODULE_ID = 'vtm-v20-powers';
export const POWER_LEVELS = ['lvl1', 'lvl2', 'lvl3', 'lvl4', 'lvl5'];
export const POWER_ITEM_TYPES = ['discipline', 'path'];
// Module-defined Item subtype (Foundry namespaces it with the module id)
export const ELDER_TYPE = `${MODULE_ID}.elderPower`;
export const ELDER_MIN = 6;
export const ELDER_MAX = 10;

const lc = s => String(s ?? '').trim().toLowerCase();

export function titleCase(key) {
  return String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

// One config per Discipline/Path name + level, shared by every copy of that item.
// Dots are stripped so the key can never be mistaken for a nested path.
export function powerKey(type, name, lvl) {
  return `${type}|${lc(name).replace(/\./g, '')}|${lvl}`;
}

// Trait keys use the system's own format: attributes.x, abilities.x, virtues.x,
// willpower (permanent), willpowerCurrent (current pool), humanity (Humanity or Path rating)
export function traitLabel(key) {
  if (!key) return '';
  if (key === 'willpower') return 'Willpower (permanent)';
  if (key === 'willpowerCurrent') return 'Willpower (current)';
  if (key === 'humanity') return 'Humanity/Path';
  return titleCase(key.split('.').pop());
}

export function traitValue(system, key) {
  if (!system || !key) return 0;
  if (key === 'willpower') return Number(system.willpower?.max) || 0;
  if (key === 'willpowerCurrent') return Number(system.willpower?.value) || 0;
  if (key === 'humanity') return Number(system.humanity) || 0;
  const [group, name] = key.split('.');
  return Number(system[group]?.[name]) || 0;
}

export const clampDiff = n => Math.min(10, Math.max(2, Math.round(Number(n) || 6)));

export function sumTraits(system, traits = []) {
  return traits.filter(Boolean).reduce((s, k) => s + traitValue(system, k), 0);
}

export function defaultConfig() {
  return {
    diff: { mode: 'fixed', traits: ['willpower', ''], mod: 0 },
    resist: { enabled: false, traits: ['willpower', ''], diffMode: 'fixed', diff: 6, attackerTraits: ['', ''], mod: 0 },
    extended: { enabled: false, goalMode: 'target', goal: 5, traits: ['willpowerCurrent', ''], mod: 0, onFail: 'keep', onBotch: 'reset' },
  };
}

export function normalizeConfig(cfg) {
  const d = defaultConfig();
  if (!cfg || typeof cfg !== 'object') return d;
  const pair = (v, fb) => [v?.[0] ?? fb[0], v?.[1] ?? fb[1]];
  return {
    diff: {
      mode: cfg.diff?.mode === 'target' ? 'target' : 'fixed',
      traits: pair(cfg.diff?.traits, d.diff.traits),
      mod: Math.trunc(Number(cfg.diff?.mod) || 0),
    },
    resist: {
      enabled: !!cfg.resist?.enabled,
      traits: pair(cfg.resist?.traits, d.resist.traits),
      diffMode: ['attacker', 'successes'].includes(cfg.resist?.diffMode) ? cfg.resist.diffMode : 'fixed',
      diff: clampDiff(cfg.resist?.diff ?? 6),
      attackerTraits: pair(cfg.resist?.attackerTraits, d.resist.attackerTraits),
      mod: Math.trunc(Number(cfg.resist?.mod) || 0),
    },
    extended: {
      enabled: !!cfg.extended?.enabled,
      goalMode: ['fixed', 'target', 'self'].includes(cfg.extended?.goalMode) ? cfg.extended.goalMode : d.extended.goalMode,
      goal: Math.max(1, Math.trunc(Number(cfg.extended?.goal) || d.extended.goal)),
      traits: pair(cfg.extended?.traits, d.extended.traits),
      mod: Math.trunc(Number(cfg.extended?.mod) || 0),
      onFail: cfg.extended?.onFail === 'reset' ? 'reset' : 'keep',
      onBotch: cfg.extended?.onBotch === 'lock' ? 'lock' : 'reset',
    },
  };
}

export function isActive(cfg) {
  return !!cfg && (cfg.diff?.mode === 'target' || !!cfg.resist?.enabled || !!cfg.extended?.enabled);
}

// Attacker's difficulty taken from the target's traits
export function targetDifficulty(cfg, targetSystem) {
  return clampDiff(sumTraits(targetSystem, cfg.diff.traits) + cfg.diff.mod);
}

// Resister's difficulty: a fixed number, or taken from the attacker's traits
export function resistDifficulty(cfg, attackerSystem, attackerSuccesses = 0) {
  if (cfg.resist.diffMode === 'successes') return clampDiff((Number(attackerSuccesses) || 0) + cfg.resist.mod);
  if (cfg.resist.diffMode === 'attacker') {
    return clampDiff(sumTraits(attackerSystem, cfg.resist.attackerTraits) + cfg.resist.mod);
  }
  return clampDiff(cfg.resist.diff);
}

// V20 resisted roll: compare successes; ties keep the status quo (defender)
export function contest(attackerTotal, defenderTotal) {
  const a = Math.max(0, Number(attackerTotal) || 0);
  const d = Math.max(0, Number(defenderTotal) || 0);
  const net = a - d;
  return { attacker: a, defender: d, net: Math.abs(net), winner: net > 0 ? 'attacker' : 'defender' };
}

export function elderLabel(item) { return `${item.system?.discipline ?? ''}: ${item.name}`; }

// Find which power a roll belongs to from the label "<Discipline>: <Power>".
// Returns the config address too: regular powers by Discipline + level,
// Elder powers by their own name.
export function findPower(items, label) {
  if (!label) return null;
  for (const item of items ?? []) {
    if (!POWER_ITEM_TYPES.includes(item.type)) continue;
    for (const lvl of POWER_LEVELS) {
      const p = item.system?.powers?.[lvl];
      if (p?.name && `${item.name}: ${p.name}` === label) return { item, lvl, power: p, cfg: [item.type, item.name, lvl] };
    }
  }
  for (const item of items ?? []) {
    if (item.type === ELDER_TYPE && elderLabel(item) === label) {
      return { item, lvl: 'elder', power: item.system, cfg: ['elder', item.name, 'elder'] };
    }
  }
  return null;
}

// Elder powers grouped under the actor's Disciplines (case-insensitive match)
export function elderPowersFor(items, disciplineName) {
  return (items ?? [])
    .filter(i => i.type === ELDER_TYPE && lc(i.system?.discipline) === lc(disciplineName))
    .sort((a, b) => (a.system.level - b.system.level) || a.name.localeCompare(b.name));
}

// Can this rating use this Elder power?
export function elderUsable(disciplineLevel, powerLevel) {
  return (Number(disciplineLevel) || 0) >= (Number(powerLevel) || ELDER_MIN);
}

const traitsText = (traits, mod = 0) => {
  const t = traits.filter(Boolean).map(traitLabel).join(' + ') || '—';
  return mod ? `${t} ${mod > 0 ? '+' : '−'} ${Math.abs(mod)}` : t;
};

export function summarize(cfg) {
  if (!isActive(cfg)) return '';
  const parts = [];
  if (cfg.diff.mode === 'target') parts.push(`Diff = target's ${traitsText(cfg.diff.traits, cfg.diff.mod)}`);
  if (cfg.resist.enabled) {
    const m = cfg.resist.mod;
    const rd = cfg.resist.diffMode === 'attacker'
      ? `your ${traitsText(cfg.resist.attackerTraits, m)}`
      : cfg.resist.diffMode === 'successes'
        ? `your successes${m ? ` ${m > 0 ? '+' : '−'} ${Math.abs(m)}` : ''}`
        : String(cfg.resist.diff);
    parts.push(`Resisted: ${traitsText(cfg.resist.traits)} vs diff ${rd}`);
  }
  if (cfg.extended?.enabled) {
    const e = cfg.extended;
    const goal = e.goalMode === 'fixed' ? String(e.goal) : `${e.goalMode === 'target' ? "target's" : 'own'} ${traitsText(e.traits, e.mod)}`;
    const rules = [e.onFail === 'reset' ? 'failure resets' : null, e.onBotch === 'lock' ? 'botch locks for the scene' : 'botch resets'].filter(Boolean).join(', ');
    parts.push(`Extended: goal ${goal} (${rules})`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Paths of Enlightenment

export const PATH_TYPE = `${MODULE_ID}.enlightenmentPath`;
export const SIN_RATINGS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
export const FIRST_VIRTUES = ['Conscience', 'Conviction'];
export const SECOND_VIRTUES = ['Self-Control', 'Instinct'];

// Plain, client-independent record of a Path item (what the world setting stores)
export function pathRecord(item) {
  const s = item.system ?? {};
  const sins = {};
  for (const r of SIN_RATINGS) sins[r] = String(s.sins?.[`r${r}`] ?? '');
  return {
    name: String(item.name ?? '').trim(),
    conscience: FIRST_VIRTUES.includes(s.conscience) ? s.conscience : 'Conviction',
    selfControl: SECOND_VIRTUES.includes(s.selfControl) ? s.selfControl : 'Self-Control',
    bearing: String(s.bearing ?? '').trim(),
    ethics: String(s.ethics ?? ''),
    sins,
  };
}

// Build the dropdown list: system paths first (a record with the same name
// overrides one), then custom paths A-Z, then a fallback for any path a
// character still uses that no longer exists, so the sheet can't reset it.
export function mergePaths(base, records, inUse = []) {
  const out = {};
  const byName = new Map((records ?? []).filter(r => r?.name).map(r => [r.name, r]));
  const entry = r => ({ virtues: { conscience: r.conscience, selfControl: r.selfControl }, bearing: r.bearing || 'Bearing' });
  for (const [name, info] of Object.entries(base ?? {})) out[name] = byName.has(name) ? entry(byName.get(name)) : info;
  for (const name of [...byName.keys()].sort((a, b) => a.localeCompare(b))) if (!(name in out)) out[name] = entry(byName.get(name));
  const fallback = base?.Humanity ?? { virtues: { conscience: 'Conscience', selfControl: 'Self-Control' }, bearing: 'Normalcy' };
  for (const name of inUse) if (name && !(name in out)) out[name] = { ...fallback, missing: true };
  return out;
}

// Virtue labels the system stores on the actor; its Instinct frenzy rules read these
export function virtueFlagFor(paths, pathName) {
  const info = paths?.[pathName];
  return info ? { conscience: info.virtues.conscience, selfControl: info.virtues.selfControl } : null;
}

// ---------------------------------------------------------------------------
// Discipline stat overrides: GM values that beat the system's compendium data
// and every copy of a Discipline. Stored per Discipline name, then level:
//   { animalism: { lvl3: { difficulty: 7, primary: '...', secondary: '', cost: '' } } }
// A field is overridden only when it is present.

export const STAT_FIELDS = ['difficulty', 'primary', 'secondary', 'cost'];
export const DISCIPLINE_TYPE = 'discipline';

export function statKey(name) { return lc(name).replace(/\./g, ''); }

export function normalizeStat(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  if (o.difficulty !== undefined && o.difficulty !== null && o.difficulty !== '') out.difficulty = clampDiff(o.difficulty);
  for (const f of ['primary', 'secondary', 'cost']) if (typeof o[f] === 'string') out[f] = o[f].trim();
  return out;
}

export const hasStat = o => !!o && STAT_FIELDS.some(f => f in o);

// Field-by-field updates needed to bring one Discipline item in line, as a
// flat { 'system.powers.lvl3.difficulty': 7 } object; null when nothing differs.
export function statUpdates(item, overrides) {
  if (item?.type !== DISCIPLINE_TYPE) return null;
  const byLvl = overrides?.[statKey(item.name)];
  if (!byLvl) return null;
  const out = {};
  for (const lvl of POWER_LEVELS) {
    const o = byLvl[lvl];
    if (!o) continue;
    const cur = item.system?.powers?.[lvl] ?? {};
    for (const f of STAT_FIELDS) {
      if (!(f in o)) continue;
      const want = o[f];
      const have = f === 'difficulty' ? Number(cur[f]) : String(cur[f] ?? '');
      if (have !== want) out[`system.powers.${lvl}.${f}`] = want;
    }
  }
  return Object.keys(out).length ? out : null;
}

// Strip changes to overridden fields from an update; returns the keys removed.
// `flat` is a flattened update object and is modified in place.
export function stripOverridden(item, overrides, flat) {
  const byLvl = overrides?.[statKey(item?.name)];
  if (item?.type !== DISCIPLINE_TYPE || !byLvl) return [];
  const removed = [];
  for (const key of Object.keys(flat)) {
    const m = key.match(/^system\.powers\.(lvl[1-5])\.(difficulty|primary|secondary|cost)$/);
    if (!m) continue;
    const o = byLvl[m[1]];
    if (!o || !(m[2] in o)) continue;
    const v = m[2] === 'difficulty' ? Number(flat[key]) : String(flat[key] ?? '');
    if (v !== o[m[2]]) { delete flat[key]; removed.push(key); }
  }
  return removed;
}

export function summarizeStat(o) {
  if (!hasStat(o)) return '';
  const parts = [];
  if ('primary' in o || 'secondary' in o) {
    const t = [o.primary, o.secondary].filter(Boolean).map(traitLabel).join(' + ') || 'no roll';
    parts.push(t);
  }
  if ('difficulty' in o) parts.push(`Diff ${o.difficulty}`);
  if ('cost' in o) parts.push(o.cost ? `Cost ${o.cost}` : 'No cost');
  return `Override: ${parts.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// Extended actions: accumulate successes across rolls toward a goal

// Does this setup need a targeted token to work?
export function needsTarget(cfg) {
  return cfg.diff.mode === 'target' || cfg.resist.enabled || (cfg.extended.enabled && cfg.extended.goalMode === 'target');
}

// Goal in successes; null when it needs a target and there isn't one
export function extendedGoal(cfg, targetSystem, selfSystem) {
  const e = cfg.extended;
  if (e.goalMode === 'fixed') return Math.max(1, e.goal);
  const sys = e.goalMode === 'target' ? targetSystem : selfSystem;
  if (!sys) return null;
  return Math.max(1, sumTraits(sys, e.traits) + e.mod);
}

// One roll applied to the tracker state. Statuses: open, done, locked, closed.
export function advanceExtended(state, result, cfg) {
  const e = cfg.extended;
  const s = { total: 0, goal: 1, status: 'open', log: [], ...state };
  s.log = [...(s.log ?? [])];
  const outcome = result?.outcome ?? 'failure';
  const gained = outcome === 'success' ? Math.max(0, Number(result.total) || 0) : 0;
  let note = '';
  if (outcome === 'success') {
    s.total += gained;
    if (s.total >= s.goal) { s.status = 'done'; note = 'goal reached'; }
  } else if (outcome === 'botch') {
    s.total = 0;
    if (e.onBotch === 'lock') { s.status = 'locked'; note = 'botch: locked for the scene'; } else note = 'botch: total reset';
  } else if (e.onFail === 'reset') { s.total = 0; note = 'failure: total reset'; }
  s.log.push({ n: s.log.length + 1, outcome, gained, total: s.total, note });
  return s;
}

export function extendedKey(actorUuid, cfgAddr, targetUuid) {
  return [actorUuid, ...cfgAddr, targetUuid || 'none'].join('|');
}

// ---------------------------------------------------------------------------
// Storyteller roll requests: one card, a row per character (players and
// companions), single / extended (each on their own) / teamwork (shared).
// Companions can have their own row or assist a character's row.

export const REQUEST_TYPES = ['single', 'extended', 'team', 'split'];

export function newRequest(o) {
  const type = REQUEST_TYPES.includes(o.type) ? o.type : 'single';
  const rows = [];
  const idFor = new Map();
  (o.rows ?? []).forEach((r, i) => { const id = `r${i + 1}`; idFor.set(r.actorUuid, id); });
  (o.rows ?? []).forEach((r, i) => {
    const parent = r.assists ? idFor.get(r.assists) : null;
    rows.push({
      id: `r${i + 1}`, actorUuid: r.actorUuid, name: r.name, companion: !!r.companion,
      role: parent && type !== 'team' ? 'assist' : 'main', parent: parent && type !== 'team' ? parent : null,
      total: 0, gained: 0, rolls: 0, status: 'open', last: null, log: [],
    });
  });
  if (type === 'split') {
    for (const r of rows) { r.role = 'main'; r.parent = null; r.alloc = []; r.results = []; r.budget = null; }
  }
  return {
    actions: type === 'split' ? (o.actions ?? []).slice(0, 4).map((a, i) => ({
      label: String(a.label ?? '').trim() || `Action ${i + 1}`, attr: a.attr || '', ability: a.ability || '',
      difficulty: clampDiff(a.difficulty),
    })) : [],
    extraDiff: type === 'split' ? Math.max(0, Math.trunc(Number(o.extraDiff) || 0)) : 0,
    label: String(o.label ?? '').trim(), attr: o.attr || '', ability: o.ability || '',
    difficulty: clampDiff(o.difficulty), type,
    goal: Math.max(1, Math.trunc(Number(o.goal) || 1)),
    onFail: o.onFail === 'reset' ? 'reset' : 'keep',
    onBotch: o.onBotch === 'lock' ? 'lock' : 'reset',
    maxRolls: Math.max(0, Math.trunc(Number(o.maxRolls) || 0)),
    status: 'open',
    team: { total: 0, rolls: 0, status: 'open' },
    rows,
  };
}

const findRow = (s, id) => s.rows.find(r => r.id === id);

// Can this row roll right now? { ok, reason }
export function requestRollable(s, rowId) {
  const row = findRow(s, rowId);
  if (!row) return { ok: false, reason: 'not on this request' };
  if (s.status !== 'open') return { ok: false, reason: 'the request is closed' };
  if (row.status === 'locked') return { ok: false, reason: 'locked after a botch' };
  if (s.type === 'single' || s.type === 'split') return row.rolls ? { ok: false, reason: 'already rolled' } : { ok: true };
  if (s.type === 'team') return s.team.status === 'open' ? { ok: true } : { ok: false, reason: `the team is ${s.team.status === 'done' ? 'done' : 'out of rolls'}` };
  const owner = row.role === 'assist' ? findRow(s, row.parent) : row;
  if (owner.status !== 'open') return { ok: false, reason: owner.status === 'done' ? 'goal already reached' : owner.status === 'out' ? 'out of rolls' : 'locked after a botch' };
  return { ok: true };
}

// Apply one roll ({ total, outcome }) to a request; returns the new state
export function applyRequestRoll(state, rowId, result) {
  const s = JSON.parse(JSON.stringify(state));
  if (!requestRollable(s, rowId).ok) return s;
  const row = findRow(s, rowId);
  const outcome = result?.outcome ?? 'failure';
  const succ = outcome === 'success' ? Math.max(0, Number(result.total) || 0) : 0;
  row.rolls += 1;
  row.last = { outcome, total: succ };
  let note = '';

  if (s.type === 'single') {
    row.total = succ;
    row.status = 'rolled';
  } else if (s.type === 'team') {
    const t = s.team;
    t.rolls += 1;
    row.gained += succ;
    if (outcome === 'success') t.total += succ;
    else if (outcome === 'botch') {
      t.total = 0; note = 'botch: team total reset';
      if (s.onBotch === 'lock') { row.status = 'locked'; note += `, ${row.name} locked out`; }
    } else if (s.onFail === 'reset') { t.total = 0; note = 'failure: team total reset'; }
    if (t.total >= s.goal) { t.status = 'done'; note = 'goal reached'; }
    else if (s.maxRolls && t.rolls >= s.maxRolls) { t.status = 'out'; note = note ? `${note}; out of rolls` : 'out of rolls'; }
    row.total = t.total;
  } else {
    const owner = row.role === 'assist' ? findRow(s, row.parent) : row;
    row.gained += succ;
    if (outcome === 'success') owner.total += succ;
    else if (outcome === 'botch') {
      owner.total = 0;
      if (s.onBotch === 'lock') { owner.status = 'locked'; note = 'botch: locked'; } else note = 'botch: total reset';
    } else if (s.onFail === 'reset' && row.role === 'main') { owner.total = 0; note = 'failure: total reset'; }
    if (owner.status === 'open' && owner.total >= s.goal) { owner.status = 'done'; note = 'goal reached'; }
    else if (owner.status === 'open' && row.role === 'main' && s.maxRolls && owner.rolls >= s.maxRolls) { owner.status = 'out'; note = note ? `${note}; out of rolls` : 'out of rolls'; }
  }
  const logRow = s.type === 'extended' && row.role === 'assist' ? findRow(s, row.parent) : row;
  logRow.log = [...logRow.log, { by: row.name, outcome, succ, total: s.type === 'team' ? s.team.total : logRow.total, note }].slice(-10);
  if (s.type === 'team') s.teamLog = [...(s.teamLog ?? []), { by: row.name, outcome, succ, total: s.team.total, note }].slice(-12);
  return s;
}

// Single-roll total for a main row, including assists
export function singleTotal(s, rowId) {
  return s.rows.filter(r => r.id === rowId || r.parent === rowId).reduce((n, r) => n + (r.total || 0), 0);
}

export function clearRequestLock(state, rowId) {
  const s = JSON.parse(JSON.stringify(state));
  const row = findRow(s, rowId);
  if (row?.status === 'locked') row.status = 'open';
  return s;
}

export function removeRequestRow(state, rowId) {
  const s = JSON.parse(JSON.stringify(state));
  s.rows = s.rows.filter(r => r.id !== rowId && r.parent !== rowId);
  return s;
}

// ---- split pool (V20 multiple actions) -------------------------------------

// Budget: the smallest of the action pools, plus the (negative) wound penalty
export function splitBudget(pools, woundPenalty = 0) {
  const vals = (pools ?? []).map(n => Number(n) || 0);
  if (!vals.length) return 0;
  return Math.max(Math.min(...vals) + (Number(woundPenalty) || 0), 1);
}

export const splitActionDiff = (s, a) => Math.min(10, (Number(a.difficulty) || 6) + (s.extraDiff || 0));

// { ok, reason } for an allocation against a budget
export function checkAllocation(alloc, budget, count) {
  if (!Array.isArray(alloc) || alloc.length !== count) return { ok: false, reason: 'one value per action' };
  if (alloc.some(n => !Number.isInteger(n) || n < 0)) return { ok: false, reason: 'whole numbers only' };
  const sum = alloc.reduce((a, b) => a + b, 0);
  if (sum < 1) return { ok: false, reason: 'allocate at least one die' };
  if (sum > budget) return { ok: false, reason: `${sum} dice allocated, budget is ${budget}` };
  return { ok: true, sum };
}

// Record a row's split roll: results[i] is { total, outcome }, or null when skipped/cancelled
export function applySplitRoll(state, rowId, { alloc, budget, results }) {
  const s = JSON.parse(JSON.stringify(state));
  const row = s.rows.find(r => r.id === rowId);
  if (s.type !== 'split' || !row || !requestRollable(s, rowId).ok) return s;
  if (!checkAllocation(alloc, budget, s.actions.length).ok) return s;
  row.alloc = alloc;
  row.budget = budget;
  row.results = s.actions.map((_, i) => {
    const r = results?.[i];
    if (!alloc[i] || !r) return { skipped: true };
    const outcome = ['success', 'failure', 'botch'].includes(r.outcome) ? r.outcome : 'failure';
    return { total: outcome === 'success' ? Math.max(0, Number(r.total) || 0) : 0, outcome };
  });
  row.rolls = 1;
  row.status = 'rolled';
  return s;
}

export function resetRequestRow(state, rowId) {
  const s = JSON.parse(JSON.stringify(state));
  const row = s.rows.find(r => r.id === rowId);
  if (!row) return s;
  Object.assign(row, { total: 0, gained: 0, rolls: 0, status: 'open', last: null, log: [], alloc: [], results: [], budget: null });
  return s;
}

// ---------------------------------------------------------------------------
// Power costs. parseCost mirrors the vtm-v20 system's own parser exactly
// (module/item-sheet.mjs), so what the picker writes is what the system charges.

export function parseCost(str) {
  if (!str) return null;
  let blood = 0, wp = 0, variable = false;
  const bm = String(str).match(/(\d+)(\+)?\s*blood/i);
  if (bm) { blood = parseInt(bm[1], 10); variable = !!bm[2]; }
  const wm = String(str).match(/(\d+)\s*(?:willpower|wp)/i);
  if (wm) wp = parseInt(wm[1], 10);
  return (blood || wp) ? { blood, wp, variable } : null;
}

// Picker fields -> cost text the system can read
export function formatCost({ blood = 0, variable = false, wp = 0, note = '' } = {}) {
  const b = Math.max(0, Math.trunc(Number(blood) || 0));
  const w = Math.max(0, Math.trunc(Number(wp) || 0));
  const parts = [];
  if (b) parts.push(`${b}${variable ? '+' : ''} blood`);
  if (w) parts.push(`${w} willpower`);
  const n = String(note ?? '').trim();
  if (!parts.length) return n;
  return n ? `${parts.join(', ')} (${n})` : parts.join(', ');
}

// Cost text -> picker fields. The note is whatever is left once the charged
// parts are taken out (brackets and separators trimmed).
export function costFields(str) {
  const c = parseCost(str) ?? { blood: 0, wp: 0, variable: false };
  let rest = String(str ?? '');
  if (c.blood) rest = rest.replace(/(\d+)(\+)?\s*blood(\s*points?)?/i, '');
  if (c.wp) rest = rest.replace(/(\d+)\s*(?:willpower|wp)(\s*points?)?/i, '');
  rest = rest.replace(/^[\s,;&+]*(and\b)?[\s,;]*/i, '').replace(/[\s,;]*(and)?[\s,;]*$/i, '').trim();
  const bracket = rest.match(/^\((.*)\)$/);
  return { blood: c.blood, variable: c.variable, wp: c.wp, note: (bracket ? bracket[1] : rest).trim() };
}

// What the button shows: { text, charges, warn }
export function costStatus(str) {
  const s = String(str ?? '').trim();
  if (!s) return { text: 'No cost', charges: false, warn: false };
  const c = parseCost(s);
  if (!c) return { text: 'Charges nothing', charges: false, warn: true };
  const parts = [];
  if (c.blood) parts.push(`${c.blood}${c.variable ? '+' : ''} blood`);
  if (c.wp) parts.push(`${c.wp} WP`);
  return { text: parts.join(' · '), charges: true, warn: false };
}

// A note the system would also read as a charge
export function noteHasCharge(note) {
  return !!parseCost(note);
}
