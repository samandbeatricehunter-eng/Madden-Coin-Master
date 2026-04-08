// In-memory session store for the /purchasecustomplayer multi-step flow.
// Sessions expire after 30 minutes of inactivity.

export type DevTrait   = "normal" | "star" | "superstar";
export type PackageTier = "bronze" | "silver" | "gold" | "kp";

export interface CustomPlayerSession {
  userId:        string;
  guildId:       string;

  // Step 1 – 4 selections
  position:      string | null;
  archetypeId:   number | null;
  archetypeName: string | null;
  devTrait:      DevTrait | null;
  packageTier:   PackageTier | null;

  // Computed after package selection
  packagePoints: number;
  totalCost:     number;

  // Attribute state (populated after archetype selection, edited in step 6)
  attributes:     Record<string, number>;  // name → current value
  attributeBases: Record<string, number>;  // name → base (cannot go below)
  attributeOrder: string[];               // display order

  // Which attribute is currently selected in the +/- UI
  selectedAttr: string | null;

  // Whether attributes have been locked (step 7 done)
  attrsLocked: boolean;

  // Player details (step 8)
  firstName:     string | null;
  lastName:      string | null;
  jerseyNumber:  number | null;
  college:       string | null;
  dominantHand:  "left" | "right" | null;
  heightFt:      number | null;
  heightIn:      number | null;
  weightLbs:     number | null;

  // Archetype browse state (set during step 2, before pick)
  archetypeList:       Array<{ id: number; name: string; attributes: Record<string, number> }>;
  archetypePreviewIdx: number;  // which index is currently shown

  // Housekeeping
  expiresAt: number;    // Date.now() + TTL
  step: number;         // current step (1–8) for display
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes

// sessionId → session
export const customPlayerSessions = new Map<string, CustomPlayerSession>();

export function createSession(userId: string, guildId: string): string {
  const sessionId = `${userId}-${Date.now()}`;
  customPlayerSessions.set(sessionId, {
    userId,
    guildId,
    position:      null,
    archetypeId:   null,
    archetypeName: null,
    devTrait:      null,
    packageTier:   null,
    packagePoints: 0,
    totalCost:     0,
    attributes:    {},
    attributeBases: {},
    attributeOrder: [],
    selectedAttr:       null,
    attrsLocked:        false,
    archetypeList:      [],
    archetypePreviewIdx: 0,
    firstName:     null,
    lastName:      null,
    jerseyNumber:  null,
    college:       null,
    dominantHand:  null,
    heightFt:      null,
    heightIn:      null,
    weightLbs:     null,
    expiresAt:     Date.now() + TTL_MS,
    step:          1,
  });
  return sessionId;
}

export function getSession(sessionId: string): CustomPlayerSession | null {
  const s = customPlayerSessions.get(sessionId);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    customPlayerSessions.delete(sessionId);
    return null;
  }
  s.expiresAt = Date.now() + TTL_MS; // refresh on access
  return s;
}

export function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [id, s] of customPlayerSessions) {
    if (now > s.expiresAt) customPlayerSessions.delete(id);
  }
}

// ── Point cost system ─────────────────────────────────────────────────────────
// Cost to raise attribute by 1 from value v to v+1:
export function pointCostForRaise(from: number): number {
  const next = from + 1;
  if (next <= 85) return 1;
  if (next <= 90) return 3;
  if (next <= 94) return 6;
  return 10;          // 95–99
}

// Total points spent across all attributes above their bases
export function pointsUsed(
  attrs:  Record<string, number>,
  bases:  Record<string, number>,
): number {
  let total = 0;
  for (const [name, val] of Object.entries(attrs)) {
    const base = bases[name] ?? val;
    for (let v = base; v < val; v++) total += pointCostForRaise(v);
  }
  return total;
}
