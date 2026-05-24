---
name: Discord /menu hub architecture
description: How the /menu nested-selector tree is structured and how leaf actions dispatch into legacy ac_* handlers.
---

# /menu hub — nested selector tree

The `/menu` command renders a tree of `StringSelectMenu` screens (no nav buttons). Every screen uses the same select `customId = "menu_cat"`. Option `value` is a dot-delimited tree path (e.g. `coaches.rosters.my`). Every non-root screen appends a `"__home"` option that returns to the root.

**Why:** the user explicitly asked for selector-only navigation in the new menu layers — no back/close buttons.

**How to apply:** `menu-hub.ts` defines `ROOT_NODES` as the tree. Each node is one of:
- `branch` — renders a sub-screen whose selector lists visible children + "Back to Main Menu".
- `action` — leaf; the router calls `handleActionsInteraction(interaction, node.action)` to dispatch to the legacy `ac_*` handler (e.g. `ac_buy_training`, `ac_interview`).
- `placeholder` — leaf with a body string; renders a "coming soon" embed with only the home option (used for Rivalries, Hire Positional Trainers).
- `ops` — special leaf that delegates to `buildAdminHubPage` (League Operations is gated to `isAdmin || isCommissioner`).

`handleActionsInteraction(interaction, overrideId?)` takes an optional id override so a StringSelectMenuInteraction can be re-routed to any `ac_*` branch in the dispatch table. The dispatch casts to `ButtonInteraction` internally, but `.update()` / `.deferReply()` etc. work for both interaction types.

**Visibility predicates** on nodes use a `MenuCtx` ({ settings, isAdmin, isCommissioner, seasonNum, weekStr }). Coaches Office is gated on MCA-visible; GM's Office + Wagers on coin economy; per-purchase leaves on their individual `*Enabled` settings.

# Commissioner role

League Operations is gated on `isAdmin || isCommissioner`. Commissioner = member has a Discord role literally named `"Commissioner"` (case-sensitive). Checked in three places: `commands/actions.ts` (slash entry), `lib/menu-router.ts` (`loadContext`), `lib/actions-handlers.ts` `ac_hub` restore path.

# Caveats

- Sub-pages explicitly pass `files: []` on `interaction.update()` to clear the banner attachment. The banner is re-attached only when returning to the root hub.
- Admin sub-pages (`buildAdminCategoryPage`) and unlinked sub-pages (`buildUnlinkedCategoryPage`) keep their action buttons but use selector nav rows (`adminSubPageNavRow` / `unlinkedSubPageNavRow`) with values `__admin_home` / `__home` / `__unlinked_home`, handled in `menu-router.ts`.
- Banner image path is resolved via `import.meta.url` (not `process.cwd()`) — production cwd is `artifacts/discord-bot/`, dev cwd is repo root; `cwd()`-based paths double up in prod.
- Discord StringSelectMenuOption value max is 100 chars; tree paths stay well under.
