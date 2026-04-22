import { Router } from "express";
import type { Request, Response } from "express";

const router = Router();

const MADDEN_CDN_YEAR = "madden26"; // Keep in sync with MADDEN_CDN_YEAR in discord-bot/constants.ts
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory cache — avoids hammering EA CDN on every Discord refresh
interface CacheEntry { buf: Buffer; contentType: string; fetchedAt: number }
const portraitCache = new Map<number, CacheEntry>();

/**
 * GET /portraits/:playerId
 * Proxy EA CDN portrait images through our server so Discord can reliably load them.
 * Discord can't always hotlink images from EA's CDN, so this endpoint fetches and
 * re-serves the image with public cache headers.
 */
router.get("/portraits/:playerId", async (req: Request, res: Response) => {
  const playerId = parseInt(String(req.params["playerId"] ?? ""), 10);
  if (isNaN(playerId) || playerId <= 0) {
    res.status(400).json({ error: "Invalid player ID" });
    return;
  }

  // Serve from in-process cache if still fresh
  const cached = portraitCache.get(playerId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    res.set("Content-Type", cached.contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.set("X-Portrait-Source", "cache");
    res.status(200).send(cached.buf);
    return;
  }

  const cdnUrl = `https://madden-assets-cdn.pulse.ea.com/${MADDEN_CDN_YEAR}/portraits/64/${playerId}.png`;

  try {
    const upstream = await fetch(cdnUrl, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "image/png,image/*,*/*",
        "Referer": "https://www.ea.com/",
      },
    });

    if (!upstream.ok) {
      res.status(upstream.status === 404 ? 404 : 502).json({ error: "Portrait not available" });
      return;
    }

    const arrayBuf = await upstream.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const contentType = upstream.headers.get("content-type") ?? "image/png";

    portraitCache.set(playerId, { buf, contentType, fetchedAt: Date.now() });

    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    res.set("X-Portrait-Source", "upstream");
    res.status(200).send(buf);
  } catch {
    res.status(502).json({ error: "Failed to reach EA CDN" });
  }
});

export default router;
