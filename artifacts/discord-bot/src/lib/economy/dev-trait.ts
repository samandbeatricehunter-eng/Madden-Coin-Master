export const DEV_TRAIT_LABELS: Record<number, string> = {
  0: "Normal",
  1: "Star",
  2: "Superstar",
  3: "X-Factor",
};

export const DEV_EMOJI = {
  star:      "<:dev_star:1494392249163972699>",
  superstar: "<:dev_superstar:1494392251776897134>",
  xfactor:   "<:dev_xfactor:1494392253177663688>",
} as const;

export const DEV_LEGEND =
  `${DEV_EMOJI.xfactor} = X-Factor  ${DEV_EMOJI.superstar} = Superstar  ${DEV_EMOJI.star} = Star`;

/** Returns a dev-trait badge string (with leading space) or empty string for Normal.
 *  Uses custom emoji — safe in embed descriptions/field values, NOT in select menu labels. */
export function devBadge(trait: number): string {
  if (trait >= 3) return ` ${DEV_EMOJI.xfactor}`;
  if (trait === 2) return ` ${DEV_EMOJI.superstar}`;
  if (trait === 1) return ` ${DEV_EMOJI.star}`;
  return "";
}

/** Plain-text dev badge safe for StringSelectMenuOptionBuilder.setLabel() (no custom emoji). */
export function devBadgeText(trait: number): string {
  if (trait >= 3) return " [XF]";
  if (trait === 2) return " [SS]";
  if (trait === 1) return " [★]";
  return "";
}
