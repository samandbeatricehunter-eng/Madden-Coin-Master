import sharp from "sharp";
import https from "https";
import http from "http";
import { downloadTeamLogo } from "./gcs-reader.js";

const BANNER_W  = 400;
const BANNER_H  = 300;
const HALF_W    = 200;   // each team gets exactly half the canvas width
const RIFT_W    = 12;    // half-width of the glow zone on each side of the center seam

// ── Logo resolution ───────────────────────────────────────────────────────────

export async function resolveLogoBuf(gcsPath: string): Promise<Buffer | null> {
  return downloadTeamLogo(gcsPath);
}

/** Fetch a raw image buffer from any public HTTP/HTTPS URL. */
export async function fetchImageBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Resize a logo to fill exactly one half of the banner (200×300). */
async function resizeHalf(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .resize(HALF_W, BANNER_H, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
}

/** Dark gradient background for the full banner. */
function bgSvg(): string {
  return `<svg width="${BANNER_W}" height="${BANNER_H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%"   stop-color="#0d0d18"/>
        <stop offset="45%"  stop-color="#1a1030"/>
        <stop offset="55%"  stop-color="#1a1030"/>
        <stop offset="100%" stop-color="#0d0d18"/>
      </linearGradient>
    </defs>
    <rect width="${BANNER_W}" height="${BANNER_H}" fill="url(#bg)"/>
  </svg>`;
}

/** Vertical rift/collision overlay centred on x=200. */
function riftSvg(): string {
  const cx = BANNER_W / 2;   // 200
  const h  = BANNER_H;

  // Jagged vertical lightning path
  const path = [
    `M ${cx},0`,
    `L ${cx + 5},${Math.round(h * 0.10)}`,
    `L ${cx - 7},${Math.round(h * 0.22)}`,
    `L ${cx + 9},${Math.round(h * 0.35)}`,
    `L ${cx - 6},${Math.round(h * 0.48)}`,
    `L ${cx + 8},${Math.round(h * 0.61)}`,
    `L ${cx - 9},${Math.round(h * 0.74)}`,
    `L ${cx + 5},${Math.round(h * 0.87)}`,
    `L ${cx},${h}`,
  ].join(" ");

  return `<svg width="${BANNER_W}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="glow">
        <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b1"/>
        <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="b2"/>
        <feMerge><feMergeNode in="b2"/><feMergeNode in="b1"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <linearGradient id="riftGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#e0c4ff" stop-opacity="1"/>
        <stop offset="40%"  stop-color="#a855f7" stop-opacity="1"/>
        <stop offset="60%"  stop-color="#7c3aed" stop-opacity="1"/>
        <stop offset="100%" stop-color="#e0c4ff" stop-opacity="1"/>
      </linearGradient>
    </defs>

    <!-- Wide soft aura -->
    <path d="${path}" stroke="#7c3aed" stroke-width="${RIFT_W * 4}"
          stroke-linecap="round" stroke-linejoin="round"
          fill="none" opacity="0.18" filter="url(#glow)"/>

    <!-- Medium glow -->
    <path d="${path}" stroke="#a855f7" stroke-width="${RIFT_W * 2}"
          stroke-linecap="round" stroke-linejoin="round"
          fill="none" opacity="0.45" filter="url(#glow)"/>

    <!-- Core gradient line -->
    <path d="${path}" stroke="url(#riftGrad)" stroke-width="3"
          stroke-linecap="round" stroke-linejoin="round" fill="none"/>

    <!-- Hot white centre -->
    <path d="${path}" stroke="white" stroke-width="1"
          stroke-linecap="round" stroke-linejoin="round"
          fill="none" opacity="0.9"/>
  </svg>`;
}

/** "VS" badge centred on the rift. */
function vsSvg(): string {
  const cx = BANNER_W / 2;
  return `<svg width="${BANNER_W}" height="${BANNER_H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="tg">
        <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur"/>
        <feFlood flood-color="#4c1d95" flood-opacity="1" result="col"/>
        <feComposite in="col" in2="blur" operator="in" result="sh"/>
        <feMerge><feMergeNode in="sh"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <text x="${cx}" y="${Math.round(BANNER_H / 2) + 10}" text-anchor="middle"
          font-family="Arial Black,Impact,sans-serif" font-size="28" font-weight="900"
          fill="white" filter="url(#tg)" letter-spacing="2">VS</text>
  </svg>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds the 400×300 matchup banner.
 *   Left  200×300 — away team logo
 *   Right 200×300 — home team logo
 *   Centre         — vertical rift with purple glow + VS badge
 */
export async function buildMatchupBanner(awayBuf: Buffer, homeBuf: Buffer): Promise<Buffer> {
  const [awayHalf, homeHalf] = await Promise.all([
    resizeHalf(awayBuf),
    resizeHalf(homeBuf),
  ]);

  const bgBuf   = await sharp(Buffer.from(bgSvg())).png().toBuffer();
  const riftBuf = await sharp(Buffer.from(riftSvg())).png().toBuffer();
  const vsBuf   = await sharp(Buffer.from(vsSvg())).png().toBuffer();

  return sharp(bgBuf)
    .composite([
      { input: awayHalf, left: 0,        top: 0, blend: "over" },
      { input: homeHalf, left: HALF_W,   top: 0, blend: "over" },
      { input: riftBuf,  left: 0,        top: 0, blend: "over" },
      { input: vsBuf,    left: 0,        top: 0, blend: "over" },
    ])
    .png()
    .toBuffer();
}
