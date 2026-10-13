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
// willpower (permanent), humanity (Humanity or Path rating)
export function traitLabel(key) {
  if (!key) return '';
  if (key === 'willpower') return 'Willpower';
  if (key === 'humanity') return 'Humanity/Path';
  return titleCase(key.split('.').pop());
}

export function traitValue(system, key) {
  if (!system || !key) return 0;
  if (key === 'willpower') return Number(system.willpower?.max) || 0;
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
      diffMode: cfg.resist?.diffMode === 'attacker' ? 'attacker' : 'fixed',
      diff: clampDiff(cfg.resist?.diff ?? 6),
      attackerTraits: pair(cfg.resist?.attackerTraits, d.resist.attackerTraits),
      mod: Math.trunc(Number(cfg.resist?.mod) || 0),
    },
  };
}

export function isActive(cfg) {
  return !!cfg && (cfg.diff?.mode === 'target' || !!cfg.resist?.enabled);
}

// Attacker's difficulty taken from the target's traits
export function targetDifficulty(cfg, targetSystem) {
  return clampDiff(sumTraits(targetSystem, cfg.diff.traits) + cfg.diff.mod);
}

// Resister's difficulty: a fixed number, or taken from the attacker's traits
export function resistDifficulty(cfg, attackerSystem) {
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
    const rd = cfg.resist.diffMode === 'attacker'
      ? `your ${traitsText(cfg.resist.attackerTraits, cfg.resist.mod)}`
      : String(cfg.resist.diff);
    parts.push(`Resisted: ${traitsText(cfg.resist.traits)} vs diff ${rd}`);
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
