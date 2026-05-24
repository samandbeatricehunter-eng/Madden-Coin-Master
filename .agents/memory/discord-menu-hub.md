---
name: Discord bot menu hub architecture
description: How /menu is layered — selector navigation on top, existing ac_/ao_ action buttons underneath.
---

The `/menu` command in `artifacts/discord-bot` is split into two layers:

1. **Navigation layer** (`src/lib/menu-hub.ts` + `src/lib/menu-router.ts`): a `StringSelectMenu` (`menu_cat`, `menu_admin_cat`) chooses a category. The router re-renders the message with that category's embed + action buttons via `interaction.update()`. Back buttons (`menu_back`, `menu_admin_back`) return up the tree. Admin operations are nested as a category inside `/menu`, only visible when `isAdminUser` or Discord Administrator is true.

2. **Action layer** (existing): all action buttons keep the legacy `ac_*` (user) and `ao_*` (admin) custom-id prefixes, so the huge handler files (`actions-handlers.ts`, `admin-operations-handlers.ts`, etc.) route them unchanged.

**Why:** The handler files are 4k–7k lines and tightly coupled. Rebuilding only the top-level navigation surface avoids a risky rewrite while still giving the user the new selector UX and gold/amber theme.

**How to apply:**
- Adding a new top-level category: add to `USER_CATEGORIES`/`ADMIN_CATEGORIES` in `menu-hub.ts`, add a case in `buildUserCategoryPage`/`buildAdminCategoryPage`, and extend the `VALID_*_CATS` allowlist in `menu-router.ts`.
- The role-guard at the top of `events/interactionCreate.ts` must exempt the `menu_` prefix (alongside `ac_`) so users with no roles can navigate the welcome hub.
- Back-compat: `buildActionsHubEmbed/Rows` and `buildAdminOpsEmbed/Rows` are kept as shims in `commands/actions.ts` and `commands/admin-operations.ts` because the giant handler files import them to re-render after sub-flows. Don't delete those shims.
- Colors come from `src/lib/theme.ts` (`THEME.GOLD`, `THEME.GOLD_DARK`, etc.) via `goldEmbed()`.
