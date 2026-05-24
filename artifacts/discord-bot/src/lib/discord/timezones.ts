/**
 * Shared timezone formatting for the Madden league bot.
 *
 * Everything that ever shows a date/time to users (advance deadlines,
 * scheduled game times, reminders, GOTW deadlines) MUST render through
 * one of these helpers so every surface shows the same 4 zones.
 */

export type LeagueTz = "CST" | "PST" | "EST" | "AKST";

export const LEAGUE_TZS: ReadonlyArray<{ code: LeagueTz; iana: string; label: string }> = [
  { code: "EST",  iana: "America/New_York",    label: "Eastern"  },
  { code: "CST",  iana: "America/Chicago",     label: "Central"  },
  { code: "PST",  iana: "America/Los_Angeles", label: "Pacific"  },
  { code: "AKST", iana: "America/Anchorage",   label: "Alaska"   },
];

export function ianaForTz(code: LeagueTz): string {
  return LEAGUE_TZS.find((z) => z.code === code)!.iana;
}

function fmtInZone(date: Date, iana: string): string {
  // e.g. "Mon, May 26 · 7:30 PM"
  return new Intl.DateTimeFormat("en-US", {
    timeZone:    iana,
    weekday:     "short",
    month:       "short",
    day:         "numeric",
    hour:        "numeric",
    minute:      "2-digit",
    hour12:      true,
  }).format(date);
}

/** Multi-line block — one zone per line. Use inside embed fields. */
export function formatAllZones(date: Date): string {
  return LEAGUE_TZS.map((z) => `• **${z.code}** — ${fmtInZone(date, z.iana)}`).join("\n");
}

/** Inline string — pipe-separated. Use in short content messages. */
export function formatAllZonesInline(date: Date): string {
  return LEAGUE_TZS.map((z) => `${fmtInZone(date, z.iana)} ${z.code}`).join("  |  ");
}

/** Discord <t:…:F> + <t:…:R> for "Tuesday, May 26, 2026 7:30 PM (in 2 hours)". */
export function discordTimestampLong(date: Date): string {
  const sec = Math.floor(date.getTime() / 1000);
  return `<t:${sec}:F> (<t:${sec}:R>)`;
}

/**
 * Compute the next advance deadline.
 * If we know when the league last advanced (`lastAdvanceAt`) we add the
 * period to that. If we don't, fall back to "now + period".
 */
export function nextAdvanceDeadline(
  lastAdvanceAt: Date | null,
  periodHours:   number,
): Date {
  const ms = periodHours * 60 * 60 * 1000;
  const base = lastAdvanceAt ?? new Date();
  return new Date(base.getTime() + ms);
}

/**
 * Build a Date for "day d of next-N days, at HH:MM in tz", anchored at
 * today midnight in the chosen tz. Returns a real UTC Date object that
 * survives JSON round-trips.
 *
 * dayOffset = 0 → today, 1 → tomorrow, …
 * minuteOfDay = 0..1439 (30-min granularity → 0, 30, 60, …)
 */
export function buildDateInTz(
  dayOffset:    number,
  minuteOfDay:  number,
  tz:           LeagueTz,
): Date {
  const iana = ianaForTz(tz);
  // Anchor "today" by formatting now in the zone, then offset days.
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: iana,
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const baseY = parseInt(get("year"), 10);
  const baseM = parseInt(get("month"), 10);
  const baseD = parseInt(get("day"), 10);

  // Pick target Y/M/D by adding dayOffset in UTC and back-trimming. We use
  // a UTC midnight anchored at the zone-local date, then add the offset
  // and the time-of-day, then re-resolve UTC via the IANA offset.
  const anchorUtc = Date.UTC(baseY, baseM - 1, baseD + dayOffset);
  const anchor    = new Date(anchorUtc);
  const targetY = anchor.getUTCFullYear();
  const targetM = anchor.getUTCMonth();   // 0-based
  const targetD = anchor.getUTCDate();

  const hour   = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;

  // Resolve the local-time → UTC by asking Intl what the offset is at that
  // local moment (handles DST). We construct a UTC date, ask Intl what
  // hour it reports in the zone, then shift by the delta.
  const guess = new Date(Date.UTC(targetY, targetM, targetD, hour, minute));
  const zoneHour   = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: iana, hour: "2-digit", hour12: false }).format(guess), 10);
  const zoneMin    = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: iana, minute: "2-digit" }).format(guess), 10);
  // delta = how many minutes the zone is "behind" UTC for this instant
  const guessLocalTotal = zoneHour * 60 + zoneMin;
  const wantedTotal     = hour * 60 + minute;
  let deltaMin = wantedTotal - guessLocalTotal;
  // Normalize for day-wrap
  if (deltaMin >  720) deltaMin -= 1440;
  if (deltaMin < -720) deltaMin += 1440;

  return new Date(guess.getTime() + deltaMin * 60_000);
}
