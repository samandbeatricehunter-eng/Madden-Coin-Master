import sharp from "sharp";
import https from "https";
import http from "http";

const BANNER_W = 800;
const BANNER_H = 300;
const LOGO_W   = 310;
const LOGO_H   = 260;

async function fetchImageBuffer(url: string): Promise<Buffer> {
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

async function resizeLogoToBuffer(url: string): Promise<Buffer> {
  const raw = await fetchImageBuffer(url);
  return sharp(raw)
    .resize(LOGO_W, LOGO_H, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// Diagonal-cut SVG mask — left side keeps the left portion (away team)
function buildLeftMaskSvg(): string {
  const w = LOGO_W, h = LOGO_H;
  // Diagonal from (w*0.65, 0) to (w*0.35, h) — gives the rift slant
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <polygon points="0,0 ${w * 0.68},0 ${w * 0.32},${h} 0,${h}" fill="white"/>
  </svg>`;
}

// Right-side mask (home team)
function buildRightMaskSvg(): string {
  const w = LOGO_W, h = LOGO_H;
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <polygon points="${w * 0.32},0 ${w},0 ${w},${h} ${w * 0.68},${h}" fill="white"/>
  </svg>`;
}

async function applyDiagonalMask(logoBuffer: Buffer, side: "left" | "right"): Promise<Buffer> {
  const svgStr = side === "left" ? buildLeftMaskSvg() : buildRightMaskSvg();
  const maskBuf = await sharp(Buffer.from(svgStr)).png().toBuffer();

  // Multiply alpha: composite mask as "dest-in" equivalent using raw channels
  // sharp doesn't have "dest-in" natively, so we extract alpha from mask and apply it
  const { data: logoData, info: logoInfo } = await sharp(logoBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: maskData } = await sharp(maskBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const out = Buffer.from(logoData);
  for (let i = 0; i < logoInfo.width * logoInfo.height; i++) {
    const maskAlpha = maskData[i * 4];          // mask red channel = alpha coverage
    const currentAlpha = out[i * 4 + 3];
    out[i * 4 + 3] = Math.round((maskAlpha / 255) * currentAlpha);
  }

  return sharp(out, {
    raw: { width: logoInfo.width, height: logoInfo.height, channels: 4 },
  }).png().toBuffer();
}

// The rift / collision center overlay — jagged lightning SVG with glow
function buildRiftSvg(): string {
  const h = BANNER_H;
  // Jagged path running top-to-bottom down the center
  const cx = 400;
  const path = [
    `M ${cx - 4},0`,
    `L ${cx + 8},${Math.round(h * 0.12)}`,
    `L ${cx - 12},${Math.round(h * 0.25)}`,
    `L ${cx + 15},${Math.round(h * 0.38)}`,
    `L ${cx - 8},${Math.round(h * 0.50)}`,
    `L ${cx + 12},${Math.round(h * 0.62)}`,
    `L ${cx - 14},${Math.round(h * 0.75)}`,
    `L ${cx + 6},${Math.round(h * 0.88)}`,
    `L ${cx - 4},${h}`,
  ].join(" ");

  return `<svg width="${BANNER_W}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="glow" x="-50%" y="-10%" width="200%" height="120%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur1"/>
        <feGaussianBlur in="SourceGraphic" stdDeviation="14" result="blur2"/>
        <feMerge>
          <feMergeNode in="blur2"/>
          <feMergeNode in="blur1"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
      <linearGradient id="riftGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#ffffff" stop-opacity="0.9"/>
        <stop offset="30%"  stop-color="#c084fc" stop-opacity="1"/>
        <stop offset="60%"  stop-color="#7c3aed" stop-opacity="1"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0.9"/>
      </linearGradient>
    </defs>
    <!-- Wide soft glow aura -->
    <path d="${path}" stroke="#a855f7" stroke-width="28" stroke-linecap="round"
          stroke-linejoin="round" fill="none" opacity="0.25" filter="url(#glow)"/>
    <!-- Medium glow -->
    <path d="${path}" stroke="#d8b4fe" stroke-width="14" stroke-linecap="round"
          stroke-linejoin="round" fill="none" opacity="0.55" filter="url(#glow)"/>
    <!-- Core bright line -->
    <path d="${path}" stroke="url(#riftGrad)" stroke-width="3.5" stroke-linecap="round"
          stroke-linejoin="round" fill="none"/>
    <!-- Hot white center -->
    <path d="${path}" stroke="white" stroke-width="1.2" stroke-linecap="round"
          stroke-linejoin="round" fill="none" opacity="0.95"/>
  </svg>`;
}

// VS text badge centred in the rift
function buildVsSvg(): string {
  return `<svg width="${BANNER_W}" height="${BANNER_H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="textGlow">
        <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="blur"/>
        <feFlood flood-color="#7c3aed" flood-opacity="0.9" result="color"/>
        <feComposite in="color" in2="blur" operator="in" result="shadow"/>
        <feMerge>
          <feMergeNode in="shadow"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>
    <text x="400" y="${Math.round(BANNER_H / 2) + 12}" text-anchor="middle"
          font-family="Arial Black, sans-serif" font-size="38" font-weight="900"
          fill="white" filter="url(#textGlow)" letter-spacing="2">VS</text>
  </svg>`;
}

// Dark radial background so both logos pop
function buildBackgroundSvg(): string {
  return `<svg width="${BANNER_W}" height="${BANNER_H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bg" cx="50%" cy="50%" r="70%">
        <stop offset="0%"   stop-color="#1e1b2e"/>
        <stop offset="100%" stop-color="#0a0a0f"/>
      </radialGradient>
    </defs>
    <rect width="${BANNER_W}" height="${BANNER_H}" fill="url(#bg)"/>
  </svg>`;
}

export async function buildMatchupBanner(
  awayLogoUrl: string,
  homeLogoUrl: string,
): Promise<Buffer> {
  const [awayRaw, homeRaw] = await Promise.all([
    resizeLogoToBuffer(awayLogoUrl),
    resizeLogoToBuffer(homeLogoUrl),
  ]);

  const [awayCut, homeCut] = await Promise.all([
    applyDiagonalMask(awayRaw, "left"),
    applyDiagonalMask(homeRaw, "right"),
  ]);

  const bgBuf   = await sharp(Buffer.from(buildBackgroundSvg())).png().toBuffer();
  const riftBuf = await sharp(Buffer.from(buildRiftSvg())).png().toBuffer();
  const vsBuf   = await sharp(Buffer.from(buildVsSvg())).png().toBuffer();

  // Away: left-aligned  (offset x=20, centred vertically)
  // Home: right-aligned (offset x=470, centred vertically)
  const topPad = Math.round((BANNER_H - LOGO_H) / 2);

  return sharp(bgBuf)
    .composite([
      { input: awayCut, left: 20,          top: topPad },
      { input: homeCut, left: BANNER_W - LOGO_W - 20, top: topPad },
      { input: riftBuf, left: 0,           top: 0 },
      { input: vsBuf,   left: 0,           top: 0 },
    ])
    .png()
    .toBuffer();
}
