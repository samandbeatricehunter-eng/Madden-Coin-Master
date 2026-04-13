import axios from "axios";
import https from "https";
import crypto from "crypto";
import { db, eaConnectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Madden 26 EA API constants ────────────────────────────────────────────────
const AUTH_SOURCE   = 317239;
const CLIENT_SECRET = "teJpJ9cSXFqZAuKNW8IuHpy8D4dwWPoVrPoek38iCnrGbrUSfjqnHMBAv8iCVjeSm_20250910175618";
const REDIRECT_URL  = "http://127.0.0.1/success";
const CLIENT_ID     = "MCA_26_COMP_APP";
const MACHINE_KEY   = "444d362e8e067fe2";

export const EA_LOGIN_URL =
  `https://accounts.ea.com/connect/auth?hide_create=true&release_type=prod` +
  `&response_type=code&redirect_uri=${REDIRECT_URL}&client_id=${CLIENT_ID}` +
  `&machineProfileKey=${MACHINE_KEY}&authentication_source=${AUTH_SOURCE}`;

const VALID_ENTITLEMENT_TAGS: Record<string, string> = {
  xone:   "MADDEN_26XONE",
  ps4:    "MADDEN_26PS4",
  pc:     "MADDEN_26PC",
  ps5:    "MADDEN_26PS5",
  xbsx:   "MADDEN_26XBSX",
  stadia: "MADDEN_26SDA",
};

const ENTITLEMENT_TO_PLATFORM: Record<string, string> = {
  MADDEN_26XONE: "xone",
  MADDEN_26PS4:  "ps4",
  MADDEN_26PC:   "pc",
  MADDEN_26PS5:  "ps5",
  MADDEN_26XBSX: "xbsx",
  MADDEN_26SDA:  "stadia",
};

const ENTITLEMENT_TO_NAMESPACE: Record<string, string> = {
  MADDEN_26XONE: "xbox",
  MADDEN_26PS4:  "ps3",
  MADDEN_26PC:   "cem_ea_id",
  MADDEN_26PS5:  "ps3",
  MADDEN_26XBSX: "xbox",
  MADDEN_26SDA:  "stadia",
};

const PLATFORM_TO_BLAZE_SERVICE: Record<string, string> = {
  xone:   "madden-2026-xone",
  ps4:    "madden-2026-ps4",
  pc:     "madden-2026-pc",
  ps5:    "madden-2026-ps5",
  xbsx:   "madden-2026-xbsx",
  stadia: "madden-2026-stadia",
};

const PLATFORM_TO_PRODUCT_NAME: Record<string, string> = {
  xone:   "madden-2026-xone-mca",
  ps4:    "madden-2026-ps4-mca",
  pc:     "madden-2026-pc-mca",
  ps5:    "madden-2026-ps5-mca",
  xbsx:   "madden-2026-xbsx-mca",
  stadia: "madden-2026-stadia-mca",
};

// ── Types ─────────────────────────────────────────────────────────────────────
export type TokenInfo = {
  accessToken:  string;
  refreshToken: string;
  expiry:       Date;
  platform:     string;
  blazeId:      string;
};

type BlazeSession = {
  blazeId:    number;
  sessionKey: string;
  requestId:  number;
};

export type EALeague = {
  leagueId:     number;
  leagueName:   string;
  userTeamName: string;
};

export type PersonaCandidate = {
  personaId:   number;
  namespace:   string;
  platform:    string;
  entitlement: string;
};

// ── Pending connections (multi-league flow: stored in memory between commands) ─
export const pendingConnections = new Map<string, {
  personas: PersonaCandidate[];
  leagues:  EALeague[];
  tokens:   TokenInfo;
  expiresAt: number;
}>();

// ── HTTP clients ──────────────────────────────────────────────────────────────
const ANDROID_UA = "Dalvik/2.1.0 (Linux; U; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031)";

const eaHttp = axios.create({
  headers: {
    "Accept-Charset":   "UTF-8",
    "User-Agent":       ANDROID_UA,
    "Accept-Encoding":  "gzip",
  },
});

// EA's Blaze game server uses legacy SSL — must skip cert verification
const blazeHttp = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: {
    "Accept-Charset":    "UTF-8",
    "Accept":            "application/json",
    "X-BLAZE-VOID-RESP": "XML",
    "X-Application-Key": "MADDEN-MCA",
    "Content-Type":      "application/json",
    "User-Agent":        ANDROID_UA,
  },
});

function blazeHeaders(platform: string) {
  return { "X-BLAZE-ID": PLATFORM_TO_BLAZE_SERVICE[platform] ?? "madden-2026-pc" };
}

// ── Step 1: Exchange auth code for initial access token ───────────────────────
export async function exchangeCodeForToken(codeOrUrl: string): Promise<string> {
  // Accept full redirect URL (http://127.0.0.1/success?code=XXX) or bare code
  const code = codeOrUrl.includes("?code=")
    ? new URLSearchParams(codeOrUrl.slice(codeOrUrl.indexOf("?"))).get("code") ?? codeOrUrl
    : codeOrUrl.trim();

  const res = await eaHttp.post(
    "https://accounts.ea.com/connect/token",
    `authentication_source=${AUTH_SOURCE}&client_secret=${CLIENT_SECRET}&grant_type=authorization_code&code=${code}&redirect_uri=${REDIRECT_URL}&release_type=prod&client_id=${CLIENT_ID}`,
    { headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } },
  );
  const data = res.data as { access_token?: string };
  if (!data.access_token) throw new Error(`EA code exchange failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Step 2: Discover Madden personas from access token ────────────────────────
export async function detectPersonas(accessToken: string): Promise<PersonaCandidate[]> {
  // Get PID
  const pidRes = await eaHttp.get(
    `https://accounts.ea.com/connect/tokeninfo?access_token=${accessToken}`,
    { headers: { "X-Include-Deviceid": "true" } },
  );
  const pid = (pidRes.data as { pid_id?: string }).pid_id;
  if (!pid) throw new Error("Could not retrieve EA PID from token info");

  // Get entitlements
  const entRes = await axios.get(
    `https://gateway.ea.com/proxy/identity/pids/${pid}/entitlements/?status=ACTIVE`,
    {
      headers: {
        Authorization:    `Bearer ${accessToken}`,
        "User-Agent":     ANDROID_UA,
        "X-Expand-Results": "true",
      },
    },
  );
  const allEntitlements: any[] =
    (entRes.data as { entitlements?: { entitlement?: any[] } }).entitlements?.entitlement ?? [];

  const validTags = new Set(Object.values(VALID_ENTITLEMENT_TAGS));
  const maddenEntitlements = allEntitlements.filter(
    (e) => e.entitlementTag === "ONLINE_ACCESS" && validTags.has(e.groupName),
  );
  if (maddenEntitlements.length === 0) {
    throw new Error(
      "No Madden 26 entitlement found. Make sure you're logged in with an EA account that owns Madden 26.",
    );
  }

  const results: PersonaCandidate[] = [];
  for (const ent of maddenEntitlements) {
    const expectedNamespace = ENTITLEMENT_TO_NAMESPACE[ent.groupName as string];
    const platform          = ENTITLEMENT_TO_PLATFORM[ent.groupName as string];

    const personasRes = await axios.get(
      `https://gateway.ea.com/proxy/identity${ent.pidUri}/personas?status=ACTIVE&access_token=${accessToken}`,
      { headers: { "User-Agent": ANDROID_UA, "X-Expand-Results": "true" } },
    );
    const personas: any[] =
      (personasRes.data as { personas?: { persona?: any[] } }).personas?.persona ?? [];

    for (const p of personas.filter((p) => p.namespaceName === expectedNamespace)) {
      results.push({
        personaId:   p.personaId as number,
        namespace:   p.namespaceName as string,
        platform,
        entitlement: ent.groupName as string,
      });
    }
  }
  return results;
}

// ── Step 3: Get persona-scoped tokens (server-side redirect trick) ─────────────
export async function getPersonaScopedTokens(
  accessToken: string,
  personaId:   number,
  namespace:   string,
  platform:    string,
): Promise<TokenInfo> {
  // EA responds with a 302 redirect to localhost — capture Location header server-side
  const authUrl =
    `https://accounts.ea.com/connect/auth?hide_create=true&release_type=prod` +
    `&response_type=code&redirect_uri=${REDIRECT_URL}&client_id=${CLIENT_ID}` +
    `&machineProfileKey=${MACHINE_KEY}&authentication_source=${AUTH_SOURCE}` +
    `&access_token=${accessToken}&persona_id=${personaId}&persona_namespace=${namespace}`;

  const redirectRes = await axios.get(authUrl, {
    maxRedirects: 0,
    validateStatus: (s) => s >= 300 && s < 400,
    headers: {
      "Upgrade-Insecure-Requests": "1",
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/103.0.5060.71 Mobile Safari/537.36",
      "X-Requested-With": "com.ea.gp.madden19companionapp",
    },
  });

  const location = redirectRes.headers["location"] as string | undefined;
  if (!location) throw new Error("EA persona auth returned no redirect location");

  const personaCode = new URLSearchParams(location.replace(REDIRECT_URL, "")).get("code");
  if (!personaCode) throw new Error(`Could not extract persona code from: ${location}`);

  // Exchange the persona-scoped code for final tokens with refresh_token
  const tokenRes = await eaHttp.post(
    "https://accounts.ea.com/connect/token",
    `authentication_source=${AUTH_SOURCE}&code=${personaCode}&grant_type=authorization_code&token_format=JWS&release_type=prod&client_secret=${CLIENT_SECRET}&redirect_uri=${REDIRECT_URL}&client_id=${CLIENT_ID}`,
    { headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } },
  );
  const td = tokenRes.data as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!td.access_token) throw new Error(`Failed to get persona-scoped tokens: ${JSON.stringify(td)}`);

  return {
    accessToken:  td.access_token,
    refreshToken: td.refresh_token ?? "",
    expiry:       new Date(Date.now() + (td.expires_in ?? 3600) * 1000),
    platform,
    blazeId:      String(personaId),
  };
}

// ── Token refresh ─────────────────────────────────────────────────────────────
export async function refreshTokenIfNeeded(token: TokenInfo): Promise<TokenInfo> {
  // Refresh if within 5 minutes of expiry
  if (new Date() < new Date(token.expiry.getTime() - 5 * 60 * 1000)) return token;

  const res = await eaHttp.post(
    "https://accounts.ea.com/connect/token",
    `grant_type=refresh_token&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&release_type=prod&refresh_token=${token.refreshToken}&authentication_source=${AUTH_SOURCE}&token_format=JWS`,
    { headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } },
  );
  const data = res.data as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);

  return {
    ...token,
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? token.refreshToken,
    expiry:       new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
  };
}

// ── Blaze session ─────────────────────────────────────────────────────────────
async function createBlazeSession(token: TokenInfo, attempt = 1): Promise<BlazeSession> {
  const res = await blazeHttp.post(
    "https://wal2.tools.gos.bio-iad.ea.com/wal/authentication/login",
    {
      accessToken: token.accessToken,
      productName: PLATFORM_TO_PRODUCT_NAME[token.platform] ?? "madden-2026-pc-mca",
    },
    { headers: blazeHeaders(token.platform) },
  );

  const body = res.data as {
    userLoginInfo?: {
      sessionKey?:     string;
      personaDetails?: { personaId?: number } | { personaId?: number }[];
    };
    error?: unknown;
    code?:  string;
  };

  // EA occasionally returns an error object or a response without userLoginInfo
  if (!body.userLoginInfo) {
    const fullBody    = JSON.stringify(body).slice(0, 400);
    const errorName   = (body.error as any)?.errorname ?? "";
    const isErrSystem = errorName === "ERR_SYSTEM";
    console.error(`[ea-client] Blaze login attempt ${attempt} failed (${errorName || "unknown"}). Response: ${fullBody}`);

    const maxAttempts = isErrSystem ? 5 : 3;
    if (attempt < maxAttempts) {
      // ERR_SYSTEM = EA rate-limiting / session conflict — use longer exponential backoff
      const delayMs = isErrSystem ? 4000 * attempt : 1500 * attempt;
      console.log(`[ea-client] Retrying Blaze login in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})...`);
      await new Promise((r) => setTimeout(r, delayMs));
      return createBlazeSession(token, attempt + 1);
    }
    throw new Error(
      `EA Blaze login returned no session after ${attempt} attempts. EA response: ${fullBody}\n\n` +
      (isErrSystem
        ? "This usually means EA is rate-limiting concurrent sessions. Wait 5–10 minutes and try again."
        : ""),
    );
  }

  if (!body.userLoginInfo.sessionKey) {
    throw new Error(`EA Blaze login: sessionKey missing. Response: ${JSON.stringify(body).slice(0, 200)}`);
  }

  // personaDetails is sometimes an array, sometimes a single object
  const pd = body.userLoginInfo.personaDetails;
  const personaId: number | undefined = Array.isArray(pd)
    ? (pd[0] as any)?.personaId
    : (pd as any)?.personaId;

  if (!personaId) {
    throw new Error(`EA Blaze login: personaDetails missing personaId. Response: ${JSON.stringify(body).slice(0, 200)}`);
  }

  return {
    blazeId:    personaId,
    sessionKey: body.userLoginInfo.sessionKey,
    requestId:  1,
  };
}

// ── Message auth (required for Blaze command requests) ────────────────────────
function calculateMessageAuth(
  blazeId:   number,
  requestId: number,
): { authData: string; authCode: string; authType: number } {
  const rand4   = crypto.randomBytes(4);
  const reqData = JSON.stringify({ staticData: "05e6a7ead5584ab4", requestId, blazeId });
  const staticB = Buffer.from("634203362017bf72f70ba900c0aa4e6b", "hex");
  const xorHash = crypto.createHash("md5").update(rand4).update(staticB).digest();
  const reqBuf  = Buffer.from(reqData, "utf-8");
  const scrambled = reqBuf.map((b, i) => b ^ xorHash[i % 16]);
  const authDataBytes = Buffer.concat([rand4, scrambled]);
  const staticAuth    = Buffer.from("3a53413521464c3b6531326530705b70203a2900", "hex");
  return {
    authData: authDataBytes.toString("base64"),
    authCode: crypto.createHash("md5").update(staticAuth).update(authDataBytes).digest("base64"),
    authType: 17039361,
  };
}

// ── Blaze command request ─────────────────────────────────────────────────────
async function sendBlazeRequest<T>(
  token:   TokenInfo,
  session: BlazeSession,
  cmd: { commandName: string; componentId: number; commandId: number; requestPayload: Record<string, unknown>; componentName: string },
): Promise<T> {
  const auth = calculateMessageAuth(session.blazeId, session.requestId);
  const { requestPayload, ...rest } = cmd;
  const body = {
    apiVersion:  2,
    clientDevice: 3,
    requestInfo: JSON.stringify({
      ...rest,
      messageAuthData:       auth,
      messageExpirationTime: Math.floor(Date.now() / 1000),
      deviceId:              MACHINE_KEY,
      ipAddress:             "127.0.0.1",
      requestPayload:        JSON.stringify(requestPayload),
    }),
  };
  const res = await blazeHttp.post(
    `https://wal2.tools.gos.bio-iad.ea.com/wal/mca/Process/${session.sessionKey}`,
    body,
    { headers: blazeHeaders(token.platform) },
  );
  return res.data as T;
}

// ── Get leagues (requires Blaze session) ──────────────────────────────────────
export async function getLeaguesFromToken(token: TokenInfo): Promise<EALeague[]> {
  const session = await createBlazeSession(token);
  const res = await sendBlazeRequest<{
    responseInfo: { value: { leagues: EALeague[] } };
  }>(token, session, {
    commandName:    "Mobile_GetMyLeagues",
    componentId:    2060,
    commandId:      801,
    requestPayload: {},
    componentName:  "careermode",
  });
  return res.responseInfo.value.leagues ?? [];
}

// ── Export data fetch (direct WAL endpoint, no message auth needed) ────────────
const EXPORT_ENDPOINTS: Record<string, string> = {
  passing:    "CareerMode_GetWeeklyPassingStatsExport",
  rushing:    "CareerMode_GetWeeklyRushingStatsExport",
  receiving:  "CareerMode_GetWeeklyReceivingStatsExport",
  defense:    "CareerMode_GetWeeklyDefensiveStatsExport",
  teamStats:  "CareerMode_GetWeeklyTeamStatsExport",
  schedules:  "CareerMode_GetWeeklySchedulesExport",
  awards:     "CareerMode_GetAwardsExport",
  // League-level (no week/stage params needed)
  leagueTeams: "CareerMode_GetLeagueTeamsExport",
  standings:   "CareerMode_GetStandingsExport",
  // Roster (uses leagueId + teamId + listIndex + returnFreeAgents)
  teamRoster:  "CareerMode_GetTeamRostersExport",
};

async function fetchExportData(
  token:      TokenInfo,
  session:    BlazeSession,
  exportType: string,
  body:       Record<string, unknown>,
): Promise<unknown> {
  const res = await blazeHttp.post(
    `https://wal2.tools.gos.bio-iad.ea.com/wal/mca/${exportType}/${session.sessionKey}`,
    body,
    {
      headers:      blazeHeaders(token.platform),
      responseType: "text",
    },
  );
  // Strip control characters that sometimes appear in EA responses
  const cleaned = (res.data as string).replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  return JSON.parse(cleaned);
}

export type WeeklyExportData = {
  passing:   unknown;
  rushing:   unknown;
  receiving: unknown;
  defense:   unknown;
  teamStats: unknown;
  schedules: unknown;
};

export async function fetchWeeklyStats(
  token:       TokenInfo,
  eaLeagueId:  number,
  weekIndex:   number,
  stageIndex:  number,
): Promise<WeeklyExportData> {
  const refreshed = await refreshTokenIfNeeded(token);
  const session   = await createBlazeSession(refreshed);
  const body      = { leagueId: eaLeagueId, stageIndex, weekIndex };

  const [passing, rushing, receiving, defense, teamStats, schedules] = await Promise.all([
    fetchExportData(refreshed, session, EXPORT_ENDPOINTS.passing!,   body),
    fetchExportData(refreshed, session, EXPORT_ENDPOINTS.rushing!,   body),
    fetchExportData(refreshed, session, EXPORT_ENDPOINTS.receiving!, body),
    fetchExportData(refreshed, session, EXPORT_ENDPOINTS.defense!,   body),
    fetchExportData(refreshed, session, EXPORT_ENDPOINTS.teamStats!, body),
    fetchExportData(refreshed, session, EXPORT_ENDPOINTS.schedules!, body),
  ]);

  return { passing, rushing, receiving, defense, teamStats, schedules };
}

// ── Awards export (season-level, no weekIndex needed) ─────────────────────────
export async function fetchAwardsData(
  token:      TokenInfo,
  eaLeagueId: number,
): Promise<unknown> {
  const refreshed = await refreshTokenIfNeeded(token);
  const session   = await createBlazeSession(refreshed);
  return fetchExportData(refreshed, session, EXPORT_ENDPOINTS.awards!, { leagueId: eaLeagueId });
}

// ── Fetch ONLY schedule data for a specific week (no stats) ───────────────────
export async function fetchScheduleForWeek(
  token:       TokenInfo,
  eaLeagueId:  number,
  weekIndex:   number,   // 0-based
  stageIndex:  number,   // 0=preseason, 1=regular/playoffs
): Promise<unknown> {
  const refreshed = await refreshTokenIfNeeded(token);
  const session   = await createBlazeSession(refreshed);
  const body      = { leagueId: eaLeagueId, stageIndex, weekIndex };
  return fetchExportData(refreshed, session, EXPORT_ENDPOINTS.schedules!, body);
}

// ── Fetch league teams (season-level, no week needed) ─────────────────────────
// Returns the leagueTeamInfoList — team names, OVR ratings, userName assignments
export async function fetchLeagueTeams(
  token:      TokenInfo,
  eaLeagueId: number,
): Promise<unknown> {
  const refreshed = await refreshTokenIfNeeded(token);
  const session   = await createBlazeSession(refreshed);
  return fetchExportData(refreshed, session, EXPORT_ENDPOINTS.leagueTeams!, { leagueId: eaLeagueId });
}

// ── Fetch standings (season-level, no week needed) ────────────────────────────
export async function fetchStandings(
  token:      TokenInfo,
  eaLeagueId: number,
): Promise<unknown> {
  const refreshed = await refreshTokenIfNeeded(token);
  const session   = await createBlazeSession(refreshed);
  return fetchExportData(refreshed, session, EXPORT_ENDPOINTS.standings!, { leagueId: eaLeagueId });
}

// ── Roster export result type ─────────────────────────────────────────────────
export type RostersExportData = {
  leagueTeams:  unknown;
  teamRosters:  Array<{ teamId: number; data: unknown }>;
  freeAgents:   unknown;
};

// ── Fetch all team rosters + free agents in one Blaze session ─────────────────
// Must fetch leagueTeams first to discover all teamIds and their 0-based listIndex.
// Uses the same session for every call to avoid Blaze rate-limiting (no re-auth).
// Teams are fetched 4 at a time to avoid overloading the Blaze server.
export async function fetchLeagueTeamsAndRosters(
  token:      TokenInfo,
  eaLeagueId: number,
): Promise<RostersExportData> {
  const refreshed = await refreshTokenIfNeeded(token);
  const session   = await createBlazeSession(refreshed);

  // Step 1 — league teams (needed to get team IDs and list indices)
  const leagueTeams = await fetchExportData(
    refreshed, session, EXPORT_ENDPOINTS.leagueTeams!, { leagueId: eaLeagueId },
  );
  const teamList = ((leagueTeams as any)?.leagueTeamInfoList ?? []) as Array<{ teamId: number }>;

  // Step 2 — per-team rosters (4 at a time to avoid Blaze rate-limiting)
  const CHUNK = 4;
  const teamRosters: Array<{ teamId: number; data: unknown }> = [];
  for (let i = 0; i < teamList.length; i += CHUNK) {
    const chunk = teamList.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map((team, chunkIdx) =>
        fetchExportData(refreshed, session, EXPORT_ENDPOINTS.teamRoster!, {
          leagueId:         eaLeagueId,
          listIndex:        i + chunkIdx,
          returnFreeAgents: false,
          teamId:           team.teamId,
        }).then((data) => ({ teamId: team.teamId, data })),
      ),
    );
    teamRosters.push(...results);
  }

  // Step 3 — free agents (listIndex = -1, teamId = 0, returnFreeAgents = true)
  const freeAgents = await fetchExportData(refreshed, session, EXPORT_ENDPOINTS.teamRoster!, {
    leagueId:         eaLeagueId,
    listIndex:        -1,
    returnFreeAgents: true,
    teamId:           0,
  });

  return { leagueTeams, teamRosters, freeAgents };
}

// ── DB operations ─────────────────────────────────────────────────────────────
export async function saveEAConnection(opts: {
  eaLeagueId:  number;
  leagueName:  string;
  token:       TokenInfo;
  connectedBy: string;
}): Promise<void> {
  await db
    .insert(eaConnectionsTable)
    .values({
      eaLeagueId:  opts.eaLeagueId,
      leagueName:  opts.leagueName,
      blazeId:     opts.token.blazeId,
      accessToken: opts.token.accessToken,
      refreshToken: opts.token.refreshToken,
      expiry:      opts.token.expiry,
      platform:    opts.token.platform,
      connectedBy: opts.connectedBy,
    })
    .onConflictDoUpdate({
      target: eaConnectionsTable.eaLeagueId,
      set: {
        blazeId:      opts.token.blazeId,
        accessToken:  opts.token.accessToken,
        refreshToken: opts.token.refreshToken,
        expiry:       opts.token.expiry,
        platform:     opts.token.platform,
        connectedAt:  new Date(),
        connectedBy:  opts.connectedBy,
        leagueName:   opts.leagueName,
      },
    });
}

export async function loadEAConnection(): Promise<{
  token:       TokenInfo;
  eaLeagueId:  number;
  leagueName:  string;
} | null> {
  const rows = await db.select().from(eaConnectionsTable).limit(1);
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    eaLeagueId: row.eaLeagueId,
    leagueName: row.leagueName ?? "",
    token: {
      accessToken:  row.accessToken,
      refreshToken: row.refreshToken,
      expiry:       row.expiry,
      platform:     row.platform,
      blazeId:      row.blazeId,
    },
  };
}

export async function deleteEAConnection(): Promise<void> {
  await db.delete(eaConnectionsTable);
}

export async function updateStoredToken(eaLeagueId: number, token: TokenInfo): Promise<void> {
  await db
    .update(eaConnectionsTable)
    .set({
      accessToken:  token.accessToken,
      refreshToken: token.refreshToken,
      expiry:       token.expiry,
    })
    .where(eq(eaConnectionsTable.eaLeagueId, eaLeagueId));
}
