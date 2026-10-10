// Pure rules logic for vtm-v20-powers. No Foundry globals here, so it can be
// unit-tested in Node.

export const MODULE_ID = 'vtm-v20-powers';
export const POWER_LEVELS = ['lvl1', 'lvl2', 'lvl3', 'lvl4', 'lvl5'];
export const POWER_ITEM_TYPES = ['discipline', 'path'];

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

// Find which power a roll belongs to from the system's label "<Item>: <Power>"
export function findPower(items, label) {
  if (!label) return null;
  for (const item of items ?? []) {
    if (!POWER_ITEM_TYPES.includes(item.type)) continue;
    for (const lvl of POWER_LEVELS) {
      const p = item.system?.powers?.[lvl];
      if (p?.name && `${item.name}: ${p.name}` === label) return { item, lvl, power: p };
    }
  }
  return null;
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
