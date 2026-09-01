#!/usr/bin/env node
/**
 * Regenerate the README figures.
 *
 * Kept here rather than in `scripts/` so it stays out of the published package,
 * and reading from `docs/src/` rather than from `docs/` because framing is not
 * idempotent: point it at its own output and you get a backdrop on a backdrop.
 *
 * Each figure is the same raw capture twice — untouched on the left, framed on
 * the right — so the only variable between the halves is the treatment. Both
 * halves sit at their natural CSS size, which is what keeps the UI itself at
 * identical scale on both sides: the right one is larger because it has a
 * backdrop, not because it was blown up.
 *
 * Two figures rather than one because the style is a choice, and a single
 * example reads as the house style. One is loud and flat, one is a dark mesh in
 * a window; between them they say "pick".
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTKIT = join(HERE, '../scripts/shotkit.mjs');
const SRC = join(HERE, 'src/panel.png');
/*
 * Pre-cropped by 14 device px at the top. The raw capture caught the app's own
 * rounded corners against a white page, and white notches are invisible on the
 * light panel but obvious once the dark one is sitting in window chrome — the
 * chrome puts the shot's own corners in the middle of the frame, where the
 * frame's radius no longer clips them. Cutting to the panel's true top edge is
 * Step 2, not a workaround.
 */
const SRC_DARK = join(HERE, 'src/panel-dark.png');

/** The DPR the raw panel was captured at. Everything downstream is laid out in its CSS pixels. */
const SCALE = 2;
const GROUND = '#f7f7f5';

const FIGURES = [
  {
    out: 'before-after.png',
    caption: 'shotkit frame --bg cobalt --radius 12',
    flags: ['--preset', 'clean', '--bg', 'cobalt', '--radius', '12', '--shadow', 'deep'],
  },
  {
    out: 'before-after-hero.png',
    caption: 'shotkit frame --bg transparent --fade bottom',
    /*
     * The dissolve has no backdrop of its own — it takes the page's, so the
     * figure itself has to be the thing that demonstrates it.
     *
     * Dark capture into a dark ground, because a dissolve only reads as a blend
     * when the shot's edge and the page agree: fade a white panel into a dark
     * page and you get a glow, which is a fade-out rather than a blend. The
     * ground is one step deeper than the panel's own #14181c surface, which is
     * enough for the panel to sit on the page and not enough to show a seam.
     */
    src: SRC_DARK,
    ground: '#0f1215',
    dark: true,
    // 207 KB unquantised, comfortably inside the budget, and the traffic lights
    // survive: measured at a 98-level channel shift with the palette encoder on.
    optimize: false,
    flags: ['--preset', 'mac', '--chrome', 'mac-dark', '--bg', 'transparent', '--fade', 'bottom', '--radius', '12'],
  },
];

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const chrome = process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)
  ? process.env.CHROME_PATH
  : CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('needs a local Chrome/Chromium, or CHROME_PATH set to one');
  process.exit(1);
}
if (!existsSync(SRC)) {
  console.error(`no raw panel at ${SRC}`);
  process.exit(1);
}

/** Width and height straight out of the IHDR, so this stays dependency-free. */
function pngSize(file) {
  const head = readFileSync(file).subarray(16, 24);
  return { w: head.readUInt32BE(0), h: head.readUInt32BE(4) };
}

const dataUri = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;

function figureHtml({ raw, framed, caption, ground = GROUND, dark = false }) {
  const a = pngSize(raw);
  const b = pngSize(framed);
  // Natural CSS size: the source is placed 1:1 on the raster at this DPR, never resampled.
  const aw = a.w / SCALE, ah = a.h / SCALE;
  const bw = b.w / SCALE, bh = b.h / SCALE;

  const PAD = 36, GAP = 28, LABEL = 30;
  const pageW = PAD * 2 + aw + GAP + bw;
  const pageH = PAD * 2 + LABEL + Math.max(ah, bh);

  return { pageW, pageH, html: `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${pageW}px; height: ${pageH}px;
    background: ${ground};
    -webkit-font-smoothing: antialiased;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
  }
  /* Labels sit on one line, cards centre against each other. The right card is
     taller because it has a backdrop — splitting that difference above and below
     the raw one reads as deliberate, where hanging it all under one card does not. */
  .row { display: flex; gap: ${GAP}px; padding: ${PAD}px; align-items: stretch; }
  .col { display: flex; flex-direction: column; gap: 12px; }
  .slot { flex: 1; display: flex; align-items: center; }
  .label { font-size: 13px; letter-spacing: .02em; color: ${dark ? '#6b737a' : '#a1a19a'}; padding-left: 2px; }
  .label b { font-weight: 400; color: ${dark ? '#9aa4ac' : '#6f6f68'}; }
  /* Both cards take the same radius: the point of the pair is that only the
     treatment differs, and a square-cornered half would read as the older one. */
  .card { border-radius: 14px; overflow: hidden; display: block; }
  /* The raw half has no shadow to borrow separation from, so it carries the same
     hairline the renderer draws — 1px inside its own edge, sized to the shot. */
  .raw { box-shadow: inset 0 0 0 1px ${dark ? 'rgba(255,255,255,.13)' : 'rgba(16,20,24,.09)'}; }
  img { display: block; image-rendering: -webkit-optimize-contrast; }
</style></head>
<body>
  <div class="row">
    <div class="col">
      <div class="label">before</div>
      <div class="slot"><div class="card raw"><img src="${dataUri(raw)}" width="${aw}" height="${ah}"></div></div>
    </div>
    <div class="col">
      <div class="label">after · <b>${caption}</b></div>
      <div class="slot"><div class="card"><img src="${dataUri(framed)}" width="${bw}" height="${bh}"></div></div>
    </div>
  </div>
</body></html>` };
}

const tmp = mkdtempSync(join(tmpdir(), 'shotkit-docs-'));

for (const fig of FIGURES) {
  const src = fig.src ?? SRC;
  const framed = join(tmp, fig.out);
  execFileSync(process.execPath, [SHOTKIT, 'frame', src, '--out', framed, '--scale', String(SCALE), ...fig.flags], { stdio: 'inherit' });

  const { html, pageW, pageH } = figureHtml({
    raw: src, framed, caption: fig.caption, ground: fig.ground, dark: fig.dark,
  });
  const page = join(tmp, `${fig.out}.html`);
  writeFileSync(page, html);

  const out = join(HERE, fig.out);
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb',
    `--force-device-scale-factor=${SCALE}`,
    `--window-size=${Math.ceil(pageW)},${Math.ceil(pageH)}`,
    '--virtual-time-budget=3000',
    `--screenshot=${out}`,
    `file://${page}`,
  ], { stdio: 'ignore' });

  /*
   * Dogfood, but only where it is safe.
   *
   * Quantising to 256 entries is exactly right for a flat-ish figure on a
   * gradient, and wrong for one whose palette budget goes on a long dark ramp:
   * there is nothing left for three 11px traffic lights, and #ff5f57 comes back
   * as orange. Measured per figure rather than assumed.
   */
  if (fig.optimize !== false && !process.env.NO_OPTIMIZE) {
    execFileSync(process.execPath, [SHOTKIT, 'optimize', out], { stdio: 'inherit' });
  }
}

console.warn(`\n  ${FIGURES.length} figures written to docs/\n`);
