/**
 * Gold/amber color theme + shared embed helpers.
 * Used by the new selector-based menu hub and all admin/user-facing embeds.
 */
import { EmbedBuilder } from "discord.js";

export const THEME = {
  GOLD:        0xF59E0B, // primary brand gold (amber-500)
  GOLD_DARK:   0xD97706, // hover/active (amber-600)
  GOLD_LIGHT:  0xFCD34D, // highlights (amber-300)
  SLATE:       0x1C1C2E, // deep navy background (was the old user-hub color)
  SUCCESS:     0x10B981, // emerald
  DANGER:      0xEF4444, // red
  INFO:        0x3B82F6, // blue
  MUTED:       0x6B7280, // grey
} as const;

/** Build a base embed with the gold theme accent + standard footer. */
export function goldEmbed(opts: {
  title: string;
  description?: string;
  seasonNum?: number;
  weekStr?: string;
  footer?: string;
  variant?: "default" | "admin" | "danger" | "success" | "info";
}): EmbedBuilder {
  const variantColor =
    opts.variant === "danger"  ? THEME.DANGER  :
    opts.variant === "success" ? THEME.SUCCESS :
    opts.variant === "info"    ? THEME.INFO    :
    opts.variant === "admin"   ? THEME.GOLD_DARK :
    THEME.GOLD;

  const header =
    opts.seasonNum != null && opts.weekStr
      ? `**🗓️ Season ${opts.seasonNum} · ${opts.weekStr}**\n\n`
      : "";

  const eb = new EmbedBuilder()
    .setColor(variantColor)
    .setTitle(opts.title);

  if (opts.description) eb.setDescription(header + opts.description);
  else if (header) eb.setDescription(header);

  eb.setFooter({
    text: opts.footer ?? "/menu — private to you · expires after 15 min",
  });

  return eb;
}
