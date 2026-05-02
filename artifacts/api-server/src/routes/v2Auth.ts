/**
 * v2 EA Auth Routes — mobile app user registration + EA account verification.
 *
 * Flow:
 *   1. App calls GET /api/v2/ea/login-url  → gets the EA OAuth URL
 *   2. App opens URL in a WebView
 *   3. WebView intercepts redirect to http://127.0.0.1/success?code=XXX
 *   4. App extracts the code and calls POST /api/v2/ea/connect
 *   5. Server verifies the EA persona name matches the supplied gamertag
 *   6. Server auto-links to any known leagues (mca_leagues) the account belongs to
 *   7. Returns verified user record + linked leagues
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, appUsersTable, appEaConnectionsTable, appUserLeagueLinksTable, mcaLeaguesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { requireApiKey } from "../middleware/requireApiKey.js";
import {
  EA_LOGIN_URL,
  exchangeCodeForToken,
  detectPersonas,
  getPersonaScopedTokens,
  getLeaguesFromToken,
} from "../lib/ea-client.js";

const router: IRouter = Router();

// ── GET /api/v2/ea/login-url ──────────────────────────────────────────────────
// Returns the EA OAuth URL for the app to open in a WebView.
// No auth required — this is a public constant.
router.get("/v2/ea/login-url", (_req: Request, res: Response): void => {
  res.json({ url: EA_LOGIN_URL });
});

// ── POST /api/v2/ea/connect ───────────────────────────────────────────────────
// Body: { gamertag: string, code: string }
//
// gamertag — the in-game name the user claims (PSN ID / Xbox GT / Origin)
// code     — the EA OAuth code intercepted from the WebView redirect URL
//
// On success:
//   - Creates or updates the app_users row
//   - Saves EA tokens to app_ea_connections
//   - Auto-links the user to any matching leagues in mca_leagues
//   - Returns { verified, eaPersonaName, platform, userId, linkedLeagues }
router.post("/v2/ea/connect", requireApiKey, async (req: Request, res: Response): Promise<void> => {
  const { gamertag, code } = req.body as { gamertag?: string; code?: string };

  if (!gamertag || typeof gamertag !== "string" || gamertag.trim() === "") {
    res.status(400).json({ error: "gamertag is required" });
    return;
  }
  if (!code || typeof code !== "string" || code.trim() === "") {
    res.status(400).json({ error: "code is required" });
    return;
  }

  const normalizedGamertag = gamertag.trim().toLowerCase();

  try {
    // Step 1 — exchange the OAuth code for an initial access token
    const initialToken = await exchangeCodeForToken(code.trim());

    // Step 2 — discover which Madden personas this account has
    const personas = await detectPersonas(initialToken);
    if (personas.length === 0) {
      res.status(400).json({
        error: "No Madden 26 personas found on this EA account.",
      });
      return;
    }

    // Step 3 — find the persona whose display name matches the supplied gamertag
    const matchedPersona = personas.find(
      (p) => p.personaName.trim().toLowerCase() === normalizedGamertag,
    );

    if (!matchedPersona) {
      const found = personas.map((p) => p.personaName).join(", ");
      res.status(400).json({
        error: `Gamertag mismatch. The EA account's Madden persona(s) are: ${found}. ` +
               `Make sure you entered your exact in-game gamertag.`,
        eaPersonasFound: personas.map((p) => ({ personaName: p.personaName, platform: p.platform })),
      });
      return;
    }

    // Step 4 — get persona-scoped tokens (the ones used for Blaze / data export)
    const token = await getPersonaScopedTokens(
      initialToken,
      matchedPersona.personaId,
      matchedPersona.namespace,
      matchedPersona.platform,
    );

    // Step 5 — get the user's Madden leagues
    const eaLeagues = await getLeaguesFromToken(token);

    // Step 6 — find which of those leagues are registered in this app
    const eaLeagueIds = eaLeagues.map((l) => l.leagueId);
    const knownLeagues = eaLeagueIds.length > 0
      ? await db
          .select()
          .from(mcaLeaguesTable)
          .where(inArray(mcaLeaguesTable.eaLeagueId, eaLeagueIds))
      : [];

    // Step 7 — upsert app_users (canonical gamertag is stored lowercase)
    await db
      .insert(appUsersTable)
      .values({
        gamertag:    normalizedGamertag,
        displayName: matchedPersona.personaName,   // preserve original casing as display name
        platform:    matchedPersona.platform,
      })
      .onConflictDoUpdate({
        target:  appUsersTable.gamertag,
        set: {
          displayName: matchedPersona.personaName,
          platform:    matchedPersona.platform,
          updatedAt:   new Date(),
        },
      });

    // Step 8 — upsert app_ea_connections
    await db
      .insert(appEaConnectionsTable)
      .values({
        gamertag:      normalizedGamertag,
        eaPersonaName: matchedPersona.personaName,
        platform:      matchedPersona.platform,
        blazeId:       token.blazeId,
        accessToken:   token.accessToken,
        refreshToken:  token.refreshToken,
        expiry:        token.expiry,
      })
      .onConflictDoUpdate({
        target: appEaConnectionsTable.gamertag,
        set: {
          eaPersonaName: matchedPersona.personaName,
          platform:      matchedPersona.platform,
          blazeId:       token.blazeId,
          accessToken:   token.accessToken,
          refreshToken:  token.refreshToken,
          expiry:        token.expiry,
          updatedAt:     new Date(),
        },
      });

    // Step 9 — upsert app_user_league_links for each matched league
    const linkedLeagues: Array<{ eaLeagueId: number; leagueName: string; userTeamName: string }> = [];

    for (const known of knownLeagues) {
      const eaLeague = eaLeagues.find((l) => l.leagueId === known.eaLeagueId);
      if (!eaLeague) continue;

      await db
        .insert(appUserLeagueLinksTable)
        .values({
          gamertag:   normalizedGamertag,
          eaLeagueId: known.eaLeagueId,
          teamName:   eaLeague.userTeamName ?? null,
        })
        .onConflictDoUpdate({
          target: [appUserLeagueLinksTable.gamertag, appUserLeagueLinksTable.eaLeagueId],
          set: {
            teamName:  eaLeague.userTeamName ?? null,
            updatedAt: new Date(),
          },
        });

      linkedLeagues.push({
        eaLeagueId:   known.eaLeagueId,
        leagueName:   known.leagueName,
        userTeamName: eaLeague.userTeamName,
      });
    }

    // Step 10 — fetch the final user row to return
    const [user] = await db
      .select()
      .from(appUsersTable)
      .where(eq(appUsersTable.gamertag, normalizedGamertag))
      .limit(1);

    res.json({
      verified:      true,
      eaPersonaName: matchedPersona.personaName,
      platform:      matchedPersona.platform,
      userId:        user?.id ?? null,
      gamertag:      normalizedGamertag,
      linkedLeagues,
      allEaLeagues:  eaLeagues.map((l) => ({
        eaLeagueId:   l.leagueId,
        leagueName:   l.leagueName,
        userTeamName: l.userTeamName,
        knownToApp:   knownLeagues.some((k) => k.eaLeagueId === l.leagueId),
      })),
    });
  } catch (err: any) {
    const msg: string = err?.message ?? "Unknown error";

    // Surface EA-specific errors clearly
    if (msg.includes("No Madden 26 entitlement")) {
      res.status(400).json({ error: msg });
      return;
    }
    if (msg.includes("EA code exchange failed")) {
      res.status(400).json({ error: "Invalid or expired EA login code. Please try again." });
      return;
    }

    req.log.error({ err }, "EA connect failed");
    res.status(500).json({ error: "EA connection failed. Please try again." });
  }
});

export default router;
