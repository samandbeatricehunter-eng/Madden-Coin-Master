import { PermissionFlagsBits, type GuildMember } from "discord.js";

const COMMISSIONER_ROLE_PATTERNS = [
  /commissioner/i,
  /co[-\s]?commissioner/i,
  /commish/i,
  /admin/i,
  /owner/i,
];

export function canUseCommissionerOffice(member: GuildMember | null | undefined, allowAdministrator = true): boolean {
  if (!member) return false;

  if (allowAdministrator && member.permissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const roles = member.roles?.cache;
  if (!roles) return false;

  return roles.some((role) => COMMISSIONER_ROLE_PATTERNS.some((pattern) => pattern.test(role.name)));
}
