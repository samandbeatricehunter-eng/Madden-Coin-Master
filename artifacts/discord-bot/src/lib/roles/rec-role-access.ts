import type { GuildMember, Role } from "discord.js";
import { PermissionFlagsBits } from "discord.js";

const COMMISSIONER_ROLE_NAMES = new Set([
  "commissioner",
  "co-commissioner",
  "co commissioner",
  "cocommissioner",
  "co-commish",
  "co commish",
  "commish",
  "league admin",
  "admin",
]);

function normalizeRoleName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function memberRoles(member: GuildMember | null | undefined): Role[] {
  if (!member) return [];
  const roles = (member as any).roles;
  if (roles?.cache?.map) return roles.cache.map((role: Role) => role);
  if (Array.isArray(roles)) return [];
  return [];
}

/**
 * Central commissioner-office access guard.
 *
 * This intentionally checks Discord roles first and optionally allows native
 * Discord Administrator. Database-level admin checks still happen in the menu
 * and admin services; this helper is for role-gated menu visibility and REC
 * office interactions.
 */
export function canUseCommissionerOffice(
  member: GuildMember | null | undefined,
  allowDiscordAdministrator = true,
): boolean {
  if (!member) return false;

  if (allowDiscordAdministrator && member.permissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  return memberRoles(member).some((role) => {
    const normalized = normalizeRoleName(role.name);
    return COMMISSIONER_ROLE_NAMES.has(normalized) || normalized.includes("commissioner");
  });
}

export function hasAnyRoleName(
  member: GuildMember | null | undefined,
  roleNames: readonly string[],
): boolean {
  if (!member || roleNames.length === 0) return false;
  const allowed = new Set(roleNames.map(normalizeRoleName));
  return memberRoles(member).some((role) => allowed.has(normalizeRoleName(role.name)));
}
