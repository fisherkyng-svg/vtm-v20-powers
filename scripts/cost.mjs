// Cost picker for power Cost boxes (Discipline / Path powers, Elder Powers,
// the Stats… override dialog) and the Elder Power spend.
import { parseCost, formatCost, costFields, costStatus, noteHasCharge } from './logic.mjs';

const DialogV2 = () => foundry.applications.api.DialogV2;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Picker dialog. Resolves to the new cost text, or null when cancelled.

export async function pickCost(current, { title = 'Cost', readOnly = false } = {}) {
  const f = costFields(current);
  const dis = readOnly ? 'disabled' : '';
  const content = `<div class="vpw-form vpw-cost-form">
    ${readOnly ? '<p class="vpw-sub">This sheet is locked. Change compendium costs with <b>Stats…</b> on the power.</p>' : ''}
    <label class="vpw-row">Blood <input type="number" name="blood" value="${f.blood}" min="0" max="20" ${dis}></label>
    <label class="vpw-check"><input type="checkbox" name="variable" ${f.variable ? 'checked' : ''} ${dis}> Or more (player chooses, this is the minimum)</label>
    <label class="vpw-row">Willpower <input type="number" name="wp" value="${f.wp}" min="0" max="10" ${dis}></label>
    <label class="vpw-row">Note <input type="text" name="note" value="${esc(f.note)}" placeholder="e.g. per turn" ${dis}></label>
    <p class="vpw-cost-preview" aria-live="polite"></p></div>`;

  const preview = root => {
    const form = root?.matches?.('form') ? root : root?.querySelector?.('form');
    const e = form?.elements;
    if (!e?.blood) return;
    const text = formatCost({ blood: e.blood.value, variable: e.variable.checked, wp: e.wp.value, note: e.note.value });
    const st = costStatus(text);
    const warn = noteHasCharge(e.note.value) ? ' <span class="vpw-warn">The note contains a charge the system will also take.</span>' : '';
    const out = root.querySelector('.vpw-cost-preview');
    if (out) out.innerHTML = `Writes <b>${esc(text || '(empty)')}</b> · charges <b>${esc(st.charges ? st.text : 'nothing')}</b>.${warn}`;
  };

  const res = await DialogV2().wait({
    window: { title: `Cost: ${title}` }, content, rejectClose: false, position: { width: 420 },
    render: (event, dialog) => {
      const root = dialog?.element ?? event?.target?.element;
      root?.addEventListener('input', () => preview(root));
      root?.addEventListener('change', () => preview(root));
      preview(root);
    },
    buttons: readOnly
      ? [{ action: 'close', label: 'Close', default: true }]
      : [
        { action: 'save', label: 'Save', icon: 'fas fa-check', default: true, callback: (ev, btn) => {
          const e = btn.form.elements;
          return { text: formatCost({ blood: e.blood.value, variable: e.variable.checked, wp: e.wp.value, note: e.note.value }) };
        } },
        { action: 'cancel', label: 'Cancel' },
      ],
  });
  return res && typeof res === 'object' ? res.text : null;
}

// ---------------------------------------------------------------------------
// Button beside a Cost input. Writing the input and firing "change" lets the
// sheet's own submit-on-change save it like a typed value.

export function attachCostButton(input, { title, keepEnabled } = {}) {
  if (!input || input.dataset.vpwCost) return;
  input.dataset.vpwCost = '1';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'vpw-cost-btn';
  const paint = () => {
    const st = costStatus(input.value);
    btn.classList.toggle('vpw-cost-warn', st.warn);
    btn.innerHTML = `<i class="fas fa-${st.warn ? 'triangle-exclamation' : 'coins'}"></i> ${esc(st.text)}`;
    btn.title = st.warn ? `"${input.value}" isn't charged by the system. Click to fix.` : 'Set the cost';
  };
  paint();
  input.addEventListener('input', paint);
  btn.addEventListener('click', async ev => {
    ev.preventDefault();
    ev.stopPropagation();
    const readOnly = input.disabled || input.readOnly;
    const text = await pickCost(input.value, { title: title ?? 'Power', readOnly });
    if (text === null || readOnly) return;
    input.value = text;
    paint();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  keepEnabled?.(btn);
  input.after(btn);
}

// Discipline / Path sheets: the system's per-power Cost inputs
export function decorateCostInputs(item, root, keepEnabled) {
  for (const input of root.querySelectorAll('input[name^="system.powers."][name$=".cost"]')) {
    const lvl = input.name.match(/powers\.(lvl\d)\./)?.[1];
    const power = item.system?.powers?.[lvl]?.name || lvl?.replace('lvl', 'Level ');
    attachCostButton(input, { title: `${item.name} · ${power}`, keepEnabled });
  }
}

// ---------------------------------------------------------------------------
// Spend, matching the system's confirm-and-spend behaviour.
// Returns { blood, wp } spent, or null when blocked or cancelled.

export async function spendCost(actor, costStr, powerName) {
  const cost = parseCost(costStr);
  if (!cost) return { blood: 0, wp: 0 };
  const bloodNow = Number(actor.system.blood?.value) || 0;
  const wpNow = Number(actor.system.willpower?.value) || 0;
  if (cost.blood > 0 && bloodNow < cost.blood) { ui.notifications.warn('Not enough blood.'); return null; }
  if (cost.wp > 0 && wpNow < cost.wp) { ui.notifications.warn('Not enough Willpower.'); return null; }

  const parts = [cost.blood ? `${cost.blood} blood` : '', cost.wp ? `${cost.wp} Willpower` : ''].filter(Boolean);
  const content = cost.variable
    ? `<div class="vpw-form"><label class="vpw-row">Blood to spend <input type="number" name="amount" value="${cost.blood}" min="${cost.blood}" max="${bloodNow}"></label>
       ${cost.wp ? `<p class="vpw-sub">Also costs ${cost.wp} Willpower.</p>` : ''}</div>`
    : `<p>Spend <b>${parts.join(' and ')}</b> to use <b>${esc(powerName)}</b>?</p>`;
  const res = await DialogV2().wait({
    window: { title: powerName }, content, rejectClose: false,
    buttons: [
      { action: 'spend', label: 'Spend', icon: 'fas fa-check', default: true, callback: (ev, btn) => {
        if (!cost.variable) return { blood: cost.blood };
        const v = Math.trunc(Number(btn.form.elements.amount.value) || cost.blood);
        return { blood: Math.min(Math.max(v, cost.blood), bloodNow) };
      } },
      { action: 'cancel', label: 'Cancel' },
    ],
  });
  if (!res || typeof res !== 'object') return null;
  const update = {};
  if (res.blood) update['system.blood.value'] = bloodNow - res.blood;
  if (cost.wp) update['system.willpower.value'] = wpNow - cost.wp;
  if (Object.keys(update).length) await actor.update(update);
  return { blood: res.blood, wp: cost.wp };
}

export function spentLine(actor, spent) {
  if (!spent || (!spent.blood && !spent.wp)) return '';
  const parts = [];
  if (spent.blood) parts.push(`${spent.blood} blood spent (${actor.system.blood?.value ?? 0} remaining)`);
  if (spent.wp) parts.push(`${spent.wp} Willpower spent (${actor.system.willpower?.value ?? 0} remaining)`);
  return parts.join(', ');
}
