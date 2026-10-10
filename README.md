# VtM V20 Powers (`vtm-v20-powers`) v0.2.0

Contested Discipline powers for the **Vampire: The Masquerade V20** Foundry system (`vtm-v20` ≥ 1.1.5, Foundry v13–14).

- **Difficulty from the target.** A power's difficulty comes from the targeted token's traits, for example the target's permanent Willpower, or Wits + Courage.
- **Resisted rolls.** After a successful activation, the target gets a one-click **Roll resistance** button in chat. The module then posts the winner and the net successes.
- **Elder powers (levels 6–10).** A new **Elder Power** item type. Several can exist per level, and they're listed under their Discipline on the character sheet.

## Install

In Foundry Setup, go to **Add-on Modules → Install Module** and paste this into **Manifest URL**:

`https://github.com/fisherkyng-svg/vtm-v20-powers/releases/latest/download/module.json`

Then enable it under **Manage Modules**.

## Setting up a power (Storyteller)

1. Open any Discipline or Path item. This can be the world item, or a copy on a character sheet.
2. Under each power, click **Contest…**.
3. Configure:
   - **Attacker's difficulty:** *Fixed* uses the power's Diff box. *From the target's traits* lets you pick one or two traits plus a modifier.
   - **Resisted roll:** tick **Target rolls to resist**. Pick the resist pool (one or two traits). The resist difficulty is either a fixed number or taken from the attacker's traits.
4. Click **Save**.

The setup is stored per **Discipline name + level** for the whole world. Configure Dominate level 2 once, and every character's Dominate uses it, including copies bought later. A summary line under the power shows the setup to everyone.

## At the table

1. Target the victim's token: hover over it and press **T**.
2. Click the power's roll button as usual. The system's roll dialog opens with the difficulty already filled in, and all the usual modifiers still apply.
3. For resisted powers, a successful roll posts a **Resist** card. Only the target's owner (or the Storyteller, for NPCs) sees the **Roll resistance** button. Their roll uses their own sheet and modifiers.
4. The result card shows both success counts and who won by how many. **Ties go to the resister.**

If no token is targeted, the power rolls at its fixed difficulty, and you resolve any resistance by hand. A failed or botched activation posts no resist card.

## Elder Powers

**Build the library.** In the **Items** sidebar, click **Create Item** and choose type **Elder Power**. Set:

- **Discipline**: e.g. `Dominate`. Use the exact Discipline name, so world Disciplines like Daimoinon work.
- **Level**: 6–10.
- **Roll**: traits, difficulty, and cost. Leave Roll empty for powers that don't roll.
- **Description**: the rules text.

**NPCs.** Drag Elder Power items onto the character. They appear under the matching Discipline on the **Advantages** tab, each with a roll button. A power is usable only when the Discipline rating is at least the power's level. Players are blocked below that rating, and the Storyteller gets a warning but can still roll.

**Contest setup.** Open the power and click **Contest…**. It works the same as regular powers and is keyed by the power's name.

**Player purchasing.** This is handled by the **VtM V20 XP Tracker** module (v0.2+) and is off by default. When enabled:

- Buying dot 6+ includes picking one power of that level from your library.
- Extra powers at a level the character already has cost the same as that dot again. For example, an in-clan Dominate level-6 power costs 25 XP.

## Limits

- **Injected list.** The Elder powers list on the character sheet is added into the system's Disciplines markup. If a system update changes that markup, the list disappears, but the powers still roll from their own item sheet.
- **One target only.** The first targeted token is used.
- **Shown difficulty.** The difficulty taken from a target appears in the attacker's roll dialog, so players can learn an NPC's Willpower over time. This is by design.
- **Label matching.** The module recognizes a power by the system's roll label (`Discipline: Power`). If a system update changes that format, configured powers quietly fall back to normal rolls.
- **A GM must be logged in** to lock a resist card after a player resolves it. The roll and result still post without one.

## Macro API

```js
const p = game.modules.get('vtm-v20-powers').api;
p.getConfig('discipline', 'Dominate', 'lvl2');
p.editConfig(item, 'lvl2');   // GM: open the setup dialog
```

## Releasing

Bump `version` in `module.json` and push to `main`. The Release workflow runs the tests, tags `v<version>`, and publishes the release.

## Development

```
node --test test/logic.test.mjs test/integration.test.mjs
```
