export type RosterActionSubdomain =
  | "my_roster"
  | "any_roster"
  | "all_players"
  | "free_agents"
  | "team_stats"
  | "cap_manager"
  | "unknown_roster_action";

export const rosterActionLabels: Record<RosterActionSubdomain, string> = {
  my_roster: "My Roster",
  any_roster: "Any Team Roster",
  all_players: "All Players Search",
  free_agents: "Free Agents",
  team_stats: "Team Stats",
  cap_manager: "Cap Manager",
  unknown_roster_action: "Roster/Cap Legacy Fallback",
};

export function classifyRosterAction(customId: string): RosterActionSubdomain {
  if (customId === "ac_myroster" || customId.startsWith("ac_rc_")) return "my_roster";
  if (customId === "ac_anyroster" || customId.startsWith("ac_anyroster")) return "any_roster";
  if (customId === "ac_allplayers" || customId.startsWith("ac_ap_") || customId.startsWith("ac_modal_ap_")) return "all_players";
  if (customId === "ac_freeagents" || customId === "ac_fa" || customId.startsWith("ac_fa_") || customId.startsWith("ac_modal_fa_")) return "free_agents";
  if (customId === "ac_teamstats" || customId.startsWith("ac_teamstats")) return "team_stats";
  if (customId.startsWith("ac_cap_")) return "cap_manager";
  return "unknown_roster_action";
}
