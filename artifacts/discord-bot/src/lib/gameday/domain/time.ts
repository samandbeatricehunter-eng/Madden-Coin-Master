export const GAMEDAY_TZ_OPTIONS = [
  { key: "EST", label: "EST", timeZone: "America/New_York" },
  { key: "CST", label: "CST", timeZone: "America/Chicago" },
  { key: "MST", label: "MST", timeZone: "America/Denver" },
  { key: "PST", label: "PST", timeZone: "America/Los_Angeles" },
  { key: "AKST", label: "AKST", timeZone: "America/Anchorage" },
  { key: "UTC", label: "UTC", timeZone: "UTC" },
] as const;

export type GamedayTzKey = typeof GAMEDAY_TZ_OPTIONS[number]["key"];

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function displayTime(time: string): string {
  const [hRaw, mRaw] = time.split(":").map(Number);
  const h = hRaw ?? 0;
  const m = mRaw ?? 0;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(m)} ${suffix}`;
}

function tzByKey(key: GamedayTzKey) {
  return GAMEDAY_TZ_OPTIONS.find((t) => t.key === key)!;
}

export function partsInTimeZone(date: Date, tzKey: GamedayTzKey) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tzByKey(tzKey).timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

export function localIsoDate(date: Date, tzKey: GamedayTzKey): string {
  const p = partsInTimeZone(date, tzKey);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function timeZoneOffsetMs(date: Date, tzKey: GamedayTzKey): number {
  const p = partsInTimeZone(date, tzKey);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - date.getTime();
}

export function localDateTimeToUtc(dateIso: string, time: string, tzKey: GamedayTzKey): Date {
  const [year, month, day] = dateIso.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const guess = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!));
  let utc = new Date(guess.getTime() - timeZoneOffsetMs(guess, tzKey));
  utc = new Date(guess.getTime() - timeZoneOffsetMs(utc, tzKey));
  return utc;
}

export function parseAcceptedOfferDate(proposedFor: string, proposedTz?: string | null): Date | null {
  const raw = `${proposedFor} ${proposedTz ?? ""}`.trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*(EST|CST|MST|PST|AKST|UTC)?$/i);
  if (!m) return null;
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  if (m[6]!.toUpperCase() === "PM" && hour < 12) hour += 12;
  if (m[6]!.toUpperCase() === "AM" && hour === 12) hour = 0;
  return localDateTimeToUtc(`${m[1]}-${m[2]}-${m[3]}`, `${pad2(hour)}:${pad2(minute)}`, (m[7] ?? "UTC").toUpperCase() as GamedayTzKey);
}

export function isValidTz(value: string): value is GamedayTzKey {
  return GAMEDAY_TZ_OPTIONS.some((t) => t.key === value);
}
