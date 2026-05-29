import {
  Guild,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
  TextChannel,
} from "discord.js";
import { db } from "@workspace/db";
import {
  franchiseScheduleTable,
  franchiseMcaTeamsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  getGuildChannel,
  setGuildChannel,
  getOrCreateActiveSeason,
  getScheduleSeasonId,
} from "../db/db-helpers.js";
import { getServerSettings } from "../db/server-settings.js";
import { nextAdvanceDeadline, formatAllZones } from "../discord/timezones.js";
import { createReactionBasedGamedayChannel } from "./reaction-panels/service.js";

export type GamedayChannelResult = {
  channelId: string;
  channelUrl?: string;
  h2hCount: number;
  totalGames: number;
  deletedPrevious: boolean;
  displayLabel: string;
};

function simpleTeamKey(teamName: string): string {
  return teamName.toLowerCase().trim();
}

function gamedayDisplayLabel(seasonNumber: number, weekNum: number): string {
  const playoffLabels: Record<number, string> = { 19: "Wild Card", 20: "Divisional Round", 21: "Conference Championship", 22: "Super Bowl" };
  return weekNum > 18
    ? `Season ${seasonNumber} — ${playoffLabels[weekNum] ?? `Playoff Wk ${weekNum}`}`
    : `Season ${seasonNumber} — Week ${weekNum}`;
}

export function gamedayWeekIndexFromNum(weekNum: number): number {
  const playoffIndexMap: Record<number, number> = { 19: 1018, 20: 1019, 21: 1020, 22: 1022 };
  return weekNum <= 18 ? weekNum - 1 : (playoffIndexMap[weekNum] ?? -1);
}

export function gamedayWeekNumFromWeekKey(weekKey: string): number | null {
  const raw = String(weekKey ?? "").toLowerCase().trim();
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= 18) return n;
  if (raw === "wildcard") return 19;
  if (raw === "divisional") return 20;
  if (raw === "conference") return 21;
  if (raw === "superbowl") return 22;
  return null;
}

function scheduleLines(games: Array<{ awayTeamName: string; homeTeamName: string }>): string {
  return games.map((g, i) => `**${i + 1}.** ${g.awayTeamName} @ ${g.homeTeamName}`).join("\n").slice(0, 3900);
}

export async function createWeeklyGamedayChannel(args: {
  guild: Guild;
  guildId: string;
  weekNum: number;
  categoryId?: string | null;
  deletePrevious?: boolean;
}): Promise<GamedayChannelResult> {
  return createReactionBasedGamedayChannel(args);
}
