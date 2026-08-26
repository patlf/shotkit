#!/usr/bin/env node
/**
 * shotkit — screenshots that look like a product, not a bug report.
 *
 * Three commands:
 *
 *   capture   drive a headless browser to a clean, deterministic raw shot
 *   frame     composite that shot onto a backdrop: padding, radius, layered
 *             shadow, optional window chrome, annotations
 *   check     lint a finished shot for the defects that make one look cheap
 *
 * The frame is rendered as HTML and screenshotted, rather than composited with
 * an image library, for one reason: CSS already has layered box-shadows,
 * gradients, backdrop-filter, subpixel-accurate rounded clipping and real font
 * rendering. Re-implementing a penumbra in Node would be worse and slower.
 *
 * The one rule the renderer never breaks: the source pixels are placed 1:1 on
 * the output raster. The image is displayed at exactly naturalWidth / scale CSS
 * pixels and positioned on a whole device pixel, so it is never resampled.
 * Everything soft-looking about a bad screenshot starts with resampling.
 *
 * No dependencies. Uses Playwright if it can be resolved, otherwise a local
 * Chrome/Chromium binary in headless mode.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

/* ------------------------------------------------------------------ args -- */

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq !== -1) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return { positional, flags };
}

const num = (value, fallback) => (value === undefined ? fallback : Number(value));
const bool = (value, fallback = false) =>
  value === undefined ? fallback : value !== 'false' && value !== '0';

function fail(message) {
  console.error(`shotkit: ${message}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- images -- */

/**
 * Dimensions without an image library.
 *
 * Needed *before* the page is built, because the page is sized to fit the shot
 * exactly — that is what avoids a clip step, and a clip step is where fractional
 * offsets and resampling creep in.
 */
function imageSize(file) {
  const buf = readFileSync(file);

  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 1) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // Standalone markers carry no length field.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }

  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
    return {
      width: Number(/pixelWidth:\s*(\d+)/.exec(out)[1]),
      height: Number(/pixelHeight:\s*(\d+)/.exec(out)[1]),
    };
  } catch {
    fail(`cannot read the dimensions of ${file} (supported: png, jpeg, or any format sips can read)`);
  }
}

/**
 * Inlined rather than referenced by file:// URL.
 *
 * A data: URI is same-origin, so the page may read it back through a canvas —
 * which `--bg auto` and `check` both need. A file:// image on a file:// page
 * taints the canvas unless Chrome is launched with a flag that also weakens it
 * for everything else.
 */
function dataUri(file) {
  const ext = extname(file).toLowerCase();
  const mime =
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.avif' ? 'image/avif'
    : 'image/png';
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

/**
 * Shrink a finished PNG without touching how it looks.
 *
 * A gradient backdrop is where the bytes go, and it is also the easiest thing in
 * the image to encode cheaply: quantising to a 256-entry palette with error
 * diffusion took a mesh backdrop from 201 KB to 70 KB with no banding that
 * survives looking for it. Screenshots are flat-ish art, which is exactly what
 * palette encoding is good at — a photograph would not fare as well, which is why
 * this is opt-in rather than automatic.
 *
 * Tries the real tools first and falls back to Pillow, which is on most macOS
 * boxes. Returns the name of whatever ran, or null.
 */
const PILLOW_QUANTISE = `
import sys
from PIL import Image
path = sys.argv[1]
im = Image.open(path)
# An image with real transparency keeps it: a palette has one transparent index,
# which would turn a soft shadow edge into a hard one.
if im.mode in ('RGBA', 'LA') and im.getchannel('A').getextrema()[0] < 250:
    im.save(path, optimize=True)
else:
    im.convert('RGB').quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).save(path, optimize=True)
`;

function optimize(file) {
  if (!/\.png$/i.test(file)) return null;
  const before = statSync(file).size;

  const attempts = [
    ['pngquant', ['--force', '--skip-if-larger', '--quality', '70-98', '--speed', '1', '-o', file, file]],
    ['oxipng', ['-o', '4', '--strip', 'safe', '-q', file]],
    ['python3', ['-c', PILLOW_QUANTISE, file]],
  ];

  for (const [bin, args] of attempts) {
    try {
      execFileSync(bin, args, { stdio: 'ignore' });
      const after = statSync(file).size;
      if (after < before) return `${bin === 'python3' ? 'pillow' : bin} −${Math.round((1 - after / before) * 100)}%`;
      return null;
    } catch { /* not installed, or it refused; try the next */ }
  }
  return null;
}

/* -------------------------------------------------------------- backends -- */

async function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
    try {
      const mod = await import(name);
      if (mod.chromium) return mod.chromium;
    } catch { /* try the next one */ }
  }
  return null;
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return CHROME_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

/**
 * Render an HTML string to a PNG at an exact size.
 *
 * `transparent` matters for `--bg transparent`: the shot keeps its rounded
 * corners and shadow as real alpha, so it can be dropped onto a page whose
 * background is not known at capture time.
 */
async function renderHtml({ html, width, height, scale, transparent, out, quality }) {
  const chromium = await loadPlaywright();
  const isJpeg = /\.jpe?g$/i.test(out);

  if (chromium) {
    const browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: Math.ceil(width), height: Math.ceil(height) },
      deviceScaleFactor: scale,
    });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    // The frame does its own pixelation work on a canvas after decode; wait for it
    // rather than guessing at a timeout.
    await page
      .waitForFunction(() => window.__shotkitReady === true, null, { timeout: 8000 })
      .catch(() => console.warn('  note: frame script did not signal ready; capturing anyway'));
    await page.waitForTimeout(120);
    await page.screenshot({
      path: out,
      omitBackground: transparent,
      type: isJpeg ? 'jpeg' : 'png',
      ...(isJpeg ? { quality: quality ?? 92 } : {}),
    });
    await browser.close();
    return;
  }

  const chrome = findChrome();
  if (!chrome) {
    fail('needs Playwright or a local Chrome/Chromium.\n' +
         '  npm i -D playwright && npx playwright install chromium\n' +
         '  …or set CHROME_PATH to a Chrome binary.');
  }
  if (isJpeg) fail('jpeg output needs Playwright; install it or write a .png');

  const dir = mkdtempSync(join(tmpdir(), 'shotkit-'));
  const page = join(dir, 'frame.html');
  writeFileSync(page, html);
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    `--force-device-scale-factor=${scale}`,
    `--window-size=${Math.ceil(width)},${Math.ceil(height)}`,
    ...(transparent ? ['--default-background-color=00000000'] : []),
    '--virtual-time-budget=3000',
    `--screenshot=${out}`,
    `file://${page}`,
  ], { stdio: 'ignore' });
}

/** Run JS against an HTML string and get a JSON value back, on either backend. */
async function evaluateInPage(html, fnSource) {
  const chromium = await loadPlaywright();
  if (chromium) {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const value = await page.evaluate(`(${fnSource})()`);
    await browser.close();
    return value;
  }

  const chrome = findChrome();
  if (!chrome) fail('needs Playwright or a local Chrome/Chromium (see `shotkit help`)');

  const dir = mkdtempSync(join(tmpdir(), 'shotkit-eval-'));
  const file = join(dir, 'eval.html');
  writeFileSync(file, `${html}
<script>
  (async () => {
    const value = await (${fnSource})();
    const sink = document.createElement('pre');
    sink.id = 'shotkit-result';
    sink.textContent = JSON.stringify(value);
    document.body.appendChild(sink);
  })();
</script>`);
  const dom = execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--virtual-time-budget=4000', '--dump-dom', `file://${file}`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const match = /<pre id="shotkit-result">([\s\S]*?)<\/pre>/.exec(dom);
  if (!match) fail('could not read the analysis back out of the page');
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return JSON.parse(decode(match[1]));
}

/* -------------------------------------------------------------- presets --- */

/**
 * Shadows are stacked, not single.
 *
 * A real shadow is darkest and tightest where the object meets the surface and
 * fades out over a much larger radius. One `0 20px 60px rgba(0,0,0,.3)` gives
 * you a uniform grey halo with no contact — it is the single clearest tell of a
 * screenshot that was decorated rather than lit. `reach` is roughly how far the
 * shadow travels, and is what the minimum padding is derived from: a shadow
 * clipped by the canvas edge looks like a rendering bug.
 */
const SHADOWS = {
  none: { css: 'none', reach: 0 },
  contact: {
    reach: 18,
    css: '0 1px 1px rgba(12,16,20,.05), 0 2px 3px rgba(12,16,20,.05), 0 5px 8px rgba(12,16,20,.06)',
  },
  soft: {
    reach: 64,
    css: [
      '0 1px 1px rgba(12,16,20,.04)',
      '0 2px 4px rgba(12,16,20,.04)',
      '0 6px 10px rgba(12,16,20,.05)',
      '0 14px 22px rgba(12,16,20,.06)',
      '0 28px 44px rgba(12,16,20,.07)',
      '0 52px 80px rgba(12,16,20,.09)',
    ].join(', '),
  },
  deep: {
    reach: 110,
    css: [
      '0 2px 3px rgba(8,11,14,.06)',
      '0 5px 9px rgba(8,11,14,.07)',
      '0 12px 22px rgba(8,11,14,.08)',
      '0 26px 44px rgba(8,11,14,.10)',
      '0 50px 84px rgba(8,11,14,.13)',
      '0 90px 140px rgba(8,11,14,.16)',
    ].join(', '),
  },
  lifted: {
    reach: 150,
    css: [
      '0 3px 5px rgba(8,11,14,.07)',
      '0 9px 16px rgba(8,11,14,.08)',
      '0 22px 38px rgba(8,11,14,.10)',
      '0 46px 76px rgba(8,11,14,.13)',
      '0 88px 132px rgba(8,11,14,.16)',
      '0 150px 210px rgba(8,11,14,.18)',
    ].join(', '),
  },
};

/**
 * Backdrops.
 *
 * Two families, because they answer different questions.
 *
 * The **quiet** set is low-chroma on purpose: a screenshot is the subject, and a
 * saturated gradient behind it competes for the same attention and dates the
 * image to whatever year that gradient was fashionable. Reach for these when the
 * screenshot has to be read.
 *
 * The **mesh** set is for the top of a landing page, where the image is doing a
 * different job — it is an object on a surface, and the surface is allowed to be
 * a surface. Each is a base colour with three offset radial gradients bled over
 * it, which is what makes a mesh read as light rather than as a gradient.
 *
 * `dark` drives the hairline: a shot on a dark ground separates with a light rim,
 * not with a shadow, because a dark blur on dark ground does nothing.
 */
const BACKDROPS = {
  // Quiet.
  paper: { dark: false, css: 'linear-gradient(160deg, #fdfcfa 0%, #f0ece5 100%)' },
  slate: { dark: false, css: 'linear-gradient(160deg, #eef1f4 0%, #d9e0e7 100%)' },
  sand: { dark: false, css: 'linear-gradient(160deg, #f7f1e8 0%, #e9dcc9 100%)' },
  mint: { dark: false, css: 'linear-gradient(160deg, #eef6f2 0%, #d6e9de 100%)' },
  blush: { dark: false, css: 'linear-gradient(160deg, #faf0ee 0%, #efd9d6 100%)' },
  arctic: { dark: false, css: 'linear-gradient(160deg, #f4f8fb 0%, #dbe7f1 100%)' },
  dusk: { dark: true, css: 'linear-gradient(160deg, #2b303b 0%, #171a21 100%)' },
  ink: { dark: true, css: 'linear-gradient(160deg, #1c2126 0%, #0d1013 100%)' },
  graphite: { dark: true, css: 'linear-gradient(160deg, #33383d 0%, #202428 100%)' },
};

/**
 * Saturated single-hue backdrops.
 *
 * Generated from one OKLCH triple each rather than hand-written as CSS, for two
 * reasons. A linear gradient between two saturated sRGB colours dips in chroma
 * through the middle and goes muddy — interpolating in OKLCH keeps the hue and
 * the saturation constant along the ramp, so the result reads as *one colour*
 * lit unevenly rather than as a gradient between two. And expressing the family
 * as numbers means a new hue is one line, and it arrives with the same lightness
 * range and the same fall-off as its siblings instead of being eyeballed.
 *
 * The ±0.055 lightness swing and the small hue rotation are doing the same job as
 * the stacked shadow: light arrives from the top-left, so that corner is lighter
 * and rotates a few degrees warm, and the far corner sits back and cools off.
 * A flat fill has no such story and reads as a swatch, not a surface.
 *
 * Each chroma is 95% of the most sRGB can hold at that lightness and hue, solved
 * rather than picked. Asking for more does not get more: the browser gamut-maps
 * it back, and it maps the two stops by different amounts, which bends the ramp
 * — the exact failure interpolating in OKLCH was meant to avoid. That ceiling is
 * why the light hues are light. Yellow at this chroma simply is an L≈0.87 colour;
 * a "dark saturated yellow" is olive, and olive is not what anyone means.
 */
const SOLIDS = {
  cobalt: { l: 0.56, c: 0.169, h: 262 },
  azure: { l: 0.70, c: 0.119, h: 234 },
  teal: { l: 0.72, c: 0.107, h: 196 },
  emerald: { l: 0.68, c: 0.161, h: 155 },
  lemon: { l: 0.87, c: 0.157, h: 101 },
  amber: { l: 0.78, c: 0.142, h: 82 },
  tangerine: { l: 0.70, c: 0.160, h: 55 },
  crimson: { l: 0.60, c: 0.204, h: 22 },
  fuchsia: { l: 0.62, c: 0.234, h: 341 },
  violet: { l: 0.55, c: 0.252, h: 292 },
};

function solidCss({ l, c, h }) {
  const stop = (dl, dc, dh) =>
    `oklch(${(l + dl).toFixed(4)} ${(c * dc).toFixed(4)} ${(h + dh).toFixed(1)})`;
  return `linear-gradient(160deg, ${stop(0.055, 0.94, 6)} 0%, ${stop(-0.055, 1.02, -5)} 100%)`;
}

/** Mesh gradients: a base plus offset radial bleeds. */
const MESHES = {
  aurora: {
    dark: true, base: '#0e1729',
    stops: [
      'radial-gradient(62% 58% at 10% 6%, rgba(45,212,191,.42) 0%, transparent 62%)',
      'radial-gradient(58% 52% at 90% 16%, rgba(99,102,241,.44) 0%, transparent 64%)',
      'radial-gradient(75% 62% at 48% 104%, rgba(168,85,247,.34) 0%, transparent 66%)',
    ],
  },
  ember: {
    dark: true, base: '#1b0f14',
    stops: [
      'radial-gradient(60% 55% at 14% 10%, rgba(251,146,60,.40) 0%, transparent 62%)',
      'radial-gradient(58% 54% at 86% 22%, rgba(244,63,94,.38) 0%, transparent 64%)',
      'radial-gradient(70% 60% at 52% 100%, rgba(120,53,15,.55) 0%, transparent 68%)',
    ],
  },
  tide: {
    dark: true, base: '#08182a',
    stops: [
      'radial-gradient(62% 56% at 8% 12%, rgba(56,189,248,.40) 0%, transparent 62%)',
      'radial-gradient(56% 50% at 92% 8%, rgba(37,99,235,.42) 0%, transparent 64%)',
      'radial-gradient(72% 62% at 50% 102%, rgba(14,116,144,.42) 0%, transparent 66%)',
    ],
  },
  orchid: {
    dark: true, base: '#1a1024',
    stops: [
      'radial-gradient(60% 55% at 12% 8%, rgba(217,70,239,.36) 0%, transparent 62%)',
      'radial-gradient(58% 52% at 88% 18%, rgba(129,140,248,.38) 0%, transparent 64%)',
      'radial-gradient(72% 60% at 50% 102%, rgba(236,72,153,.30) 0%, transparent 66%)',
    ],
  },
  moss: {
    dark: true, base: '#0c1a14',
    stops: [
      'radial-gradient(60% 55% at 12% 10%, rgba(52,211,153,.34) 0%, transparent 62%)',
      'radial-gradient(58% 52% at 88% 20%, rgba(20,184,166,.34) 0%, transparent 64%)',
      'radial-gradient(72% 60% at 50% 102%, rgba(21,128,61,.40) 0%, transparent 66%)',
    ],
  },
  sunset: {
    dark: true, base: '#1c1020',
    stops: [
      'radial-gradient(64% 56% at 6% 4%, rgba(251,191,36,.34) 0%, transparent 60%)',
      'radial-gradient(60% 54% at 92% 14%, rgba(244,63,94,.36) 0%, transparent 62%)',
      'radial-gradient(76% 64% at 48% 104%, rgba(147,51,234,.36) 0%, transparent 66%)',
    ],
  },
  noir: {
    dark: true, base: '#0b0d10',
    stops: [
      'radial-gradient(70% 60% at 50% -10%, rgba(255,255,255,.09) 0%, transparent 62%)',
      'radial-gradient(50% 45% at 12% 96%, rgba(255,255,255,.05) 0%, transparent 60%)',
    ],
  },
  porcelain: {
    dark: false, base: '#f6f5f3',
    stops: [
      'radial-gradient(62% 56% at 10% 6%, rgba(148,163,184,.26) 0%, transparent 62%)',
      'radial-gradient(58% 52% at 92% 14%, rgba(251,191,36,.16) 0%, transparent 64%)',
      'radial-gradient(72% 60% at 50% 104%, rgba(129,140,248,.18) 0%, transparent 66%)',
    ],
  },
};

/**
 * Film grain.
 *
 * Not decoration. A wide two-stop gradient rendered at 2x quantises to 8 bits per
 * channel and bands in visible stripes; a little noise dithers the step away. It
 * is the difference between a backdrop that looks printed and one that looks like
 * a JPEG of a backdrop.
 */
const GRAIN_URI =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>" +
  "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/></filter>" +
  "<rect width='160' height='160' filter='url(%23n)'/></svg>\")";

/** Whole looks, so a set of shots can be made consistent with one word. */
const PRESETS = {
  clean: { bg: 'auto', pad: '9%', radius: 10, shadow: 'soft', chrome: 'none', hairline: true },
  mac: { bg: 'auto', pad: '10%', radius: 12, shadow: 'deep', chrome: 'mac', hairline: true },
  browser: { bg: 'slate', pad: '10%', radius: 12, shadow: 'deep', chrome: 'browser', hairline: true },
  hero: { bg: 'auto', pad: '14%', radius: 14, shadow: 'lifted', chrome: 'mac', hairline: true },
  docs: { bg: 'transparent', pad: 28, radius: 8, shadow: 'contact', chrome: 'none', hairline: true },
  flat: { bg: 'auto', pad: '7%', radius: 8, shadow: 'none', chrome: 'none', hairline: true },
  bare: { bg: 'transparent', pad: 0, radius: 10, shadow: 'none', chrome: 'none', hairline: false },
};

const CHROME_HEIGHT = { none: 0, mac: 30, 'mac-dark': 30, browser: 44, 'browser-dark': 44 };

/* ------------------------------------------------------------ background -- */

/**
 * Derive a backdrop from the shot itself.
 *
 * Sampling the edge pixels and shifting lightness in OKLCH keeps the backdrop
 * in the same colour family as the UI, so the pair reads as one object under
 * one light. Chroma is capped hard: a screenshot with a red banner along the
 * top should not end up on a pink card.
 *
 * Returned as a source string evaluated in the page, because the sampling needs
 * a canvas and the canvas needs the image already decoded.
 */
const AUTO_BG_FN = `async () => {
  const img = document.getElementById('shot');
  await img.decode();
  const canvas = document.createElement('canvas');
  const w = canvas.width = Math.min(img.naturalWidth, 400);
  const h = canvas.height = Math.min(img.naturalHeight, 400);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  // A ring just inside the edge: the frame of the UI, not its busy middle.
  let r = 0, g = 0, b = 0, n = 0;
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.06));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = x < band || y < band || x >= w - band || y >= h - band;
      if (!edge) continue;
      const i = (y * w + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  r /= n; g /= n; b /= n;

  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;

  const C = Math.min(Math.hypot(A, Bb), 0.045);
  const H = (Math.atan2(Bb, A) * 180) / Math.PI;

  // Dark UI sits on a darker backdrop; light UI on a slightly darker one too.
  // Lifting a light UI onto a lighter backdrop erases its own edges.
  const dark = L < 0.5;
  const near = dark ? Math.max(0.10, L - 0.06) : Math.max(0.86, Math.min(0.965, L - 0.035));
  const far  = dark ? Math.max(0.05, L - 0.13) : Math.max(0.78, near - 0.075);

  const stop = (light, chroma) => 'oklch(' + light.toFixed(4) + ' ' + chroma.toFixed(4) + ' ' + H.toFixed(1) + ')';
  return {
    dark,
    css: 'linear-gradient(160deg, ' + stop(near, C * 0.9) + ' 0%, ' + stop(far, C * 1.15) + ' 100%)',
  };
}`;

/* ---------------------------------------------------------- window chrome -- */

function chromeMarkup(kind, title, width) {
  if (kind === 'none') return '';
  const dark = kind.endsWith('-dark');
  const lights = `
    <span class="light" style="background:#ff5f57"></span>
    <span class="light" style="background:#febc2e"></span>
    <span class="light" style="background:#28c840"></span>`;

  if (kind.startsWith('mac')) {
    return `<div class="chrome mac ${dark ? 'dark' : ''}">
      <div class="lights">${lights}</div>
      ${title ? `<div class="title">${escapeHtml(title)}</div>` : ''}
    </div>`;
  }

  return `<div class="chrome browser ${dark ? 'dark' : ''}">
    <div class="lights">${lights}</div>
    <div class="omnibox" style="max-width:${Math.max(120, width - 190)}px">
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
        <rect x="3.2" y="7" width="9.6" height="7" rx="1.4"/><path d="M5.4 7V4.8a2.6 2.6 0 0 1 5.2 0V7"/>
      </svg>
      <span>${escapeHtml(title || 'example.com')}</span>
    </div>
  </div>`;
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ----------------------------------------------------------- annotations -- */

/**
 * Coordinates are in source-image CSS pixels — i.e. natural pixels divided by
 * `--scale`, the same space the shot is laid out in. Anything else forces the
 * caller to redo the DPR arithmetic every time they move an arrow 4px.
 */
function annotationMarkup(items, ctx) {
  if (!items.length) return '';
  const { accent } = ctx;

  const shapes = items.map((item, index) => {
    const { type } = item;
    if (type === 'box' || type === 'highlight') {
      return `<div class="anno-box" style="left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px"></div>`;
    }
    if (type === 'spotlight') {
      return `<div class="anno-spot" style="left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px"></div>`;
    }
    if (type === 'blur') {
      return `<div class="anno-blur" style="left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px"></div>`;
    }
    if (type === 'pixelate') {
      /*
       * Done on a canvas, not with a CSS transform.
       *
       * The obvious trick — lay the image out small and scale it back up with
       * `transform` — does not pixelate, because Chromium rasterises a
       * transformed layer at its *final* composited resolution and simply draws
       * the image sharp. The pixels have to actually be thrown away, which means
       * drawing through a small canvas with smoothing off.
       *
       * Worth preferring over `blur` for anything that must not be recoverable:
       * a Gaussian blur is a convolution and, with the font and layout known, a
       * short string like a six-digit code can be brute-forced back out of it.
       * Quantising to blocks throws the information away instead.
       */
      return `<canvas class="anno-pixelate" data-x="${item.x}" data-y="${item.y}"
        data-w="${item.w}" data-h="${item.h}" data-block="${item.block ?? 10}"
        style="left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px"></canvas>`;
    }
    if (type === 'redact') {
      return `<div class="anno-redact" style="left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px"></div>`;
    }
    if (type === 'badge') {
      return `<div class="anno-badge" style="left:${item.x}px;top:${item.y}px">${escapeHtml(item.label ?? item.n ?? index + 1)}</div>`;
    }
    if (type === 'text') {
      return `<div class="anno-text" style="left:${item.x}px;top:${item.y}px;${item.width ? `max-width:${item.width}px` : ''}">${escapeHtml(item.text)}</div>`;
    }
    if (type === 'click') {
      // Two rings rather than one: a single circle reads as a highlight, a pair
      // reads as the moment of a click, which is what a walkthrough needs.
      const r = item.r ?? 22;
      return `<div class="anno-click" style="left:${item.x}px;top:${item.y}px;width:${r * 2}px;height:${r * 2}px;border-color:${accent}">
        <span style="border-color:${accent}"></span>
      </div>`;
    }
    if (type === 'cursor') {
      // The macOS arrow, drawn rather than screenshotted, so it is the same
      // cursor at every DPR and never picks up the capturing machine's theme.
      const pointer = item.kind === 'pointer' || item.kind === 'hand';
      const glyph = pointer
        ? `<path d="M9 2.2c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8v7.1l1-2.3c.4-.9 1.4-1.3 2.3-.9.9.4 1.3 1.4.9 2.3l-3.1 7.2c-.7 1.6-2.2 2.6-3.9 2.6H8.6c-1.4 0-2.7-.7-3.4-1.9L2 12.6c-.5-.9-.2-2 .7-2.5.8-.5 1.9-.2 2.4.6l1.1 1.7V4.6c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8"/>`
        : `<path d="M4 2.2 17.4 12l-5.9.6 3.2 6.6-2.6 1.3-3.2-6.6L4 18Z"/>`;
      return `<svg class="anno-cursor" viewBox="0 0 22 22" width="${item.size ?? 26}" height="${item.size ?? 26}"
        style="left:${item.x}px;top:${item.y}px">
        <g stroke="#fff" stroke-width="1.6" stroke-linejoin="round" fill="#141416">${glyph}</g>
      </svg>`;
    }
    if (type === 'arrow') {
      const [x1, y1] = item.from;
      const [x2, y2] = item.to;
      // A slight bow reads as drawn rather than computed; the control point is
      // offset perpendicular to the line so the curve always bends the same way.
      const bend = item.bend ?? 0.18;
      const mx = (x1 + x2) / 2 - (y2 - y1) * bend;
      const my = (y1 + y2) / 2 + (x2 - x1) * bend;
      return `<svg class="anno-arrow" aria-hidden="true">
        <defs><marker id="head${index}" viewBox="0 0 10 10" refX="8.5" refY="5"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="${accent}"/></marker></defs>
        <path d="M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}" fill="none" stroke="${accent}"
          stroke-width="3" stroke-linecap="round" marker-end="url(#head${index})"/>
      </svg>`;
    }
    return '';
  });

  return `<div class="annotations">${shapes.join('\n')}</div>`;
}

/* ---------------------------------------------------------------- frame --- */

/**
 * Fade an edge out instead of cutting it.
 *
 * A crop that runs through content is a defect; a crop that *fades* through it is
 * a statement that the content continues. The mask goes on a wrapper that also
 * contains the shadow, so the shadow fades with the edge — a shot that dissolves
 * into the page but still casts a hard shadow underneath looks broken.
 */
function fadeMask(edges, { shotW, shotH, reach, depth }) {
  if (!edges.length) return '';
  const R = reach;
  const stops = {
    bottom: `linear-gradient(to bottom, #000 ${R + shotH * (1 - depth)}px, transparent ${R + shotH}px)`,
    top: `linear-gradient(to top, #000 ${R + shotH * (1 - depth)}px, transparent ${R + shotH}px)`,
    right: `linear-gradient(to right, #000 ${R + shotW * (1 - depth)}px, transparent ${R + shotW}px)`,
    left: `linear-gradient(to left, #000 ${R + shotW * (1 - depth)}px, transparent ${R + shotW}px)`,
  };
  const list = edges.map((e) => stops[e]).filter(Boolean).join(', ');
  const composite = edges.length > 1 ? 'mask-composite: intersect; -webkit-mask-composite: source-in;' : '';
  return `-webkit-mask-image: ${list}; mask-image: ${list}; ${composite}`;
}

function buildHtml(opts) {
  const {
    uri, imgW, imgH, pageW, pageH, shotX, shotY, shotW, shotH, radius, shadow, reach, chrome,
    chromeHeight, title, hairline, base, backgroundSize, bgLayers, transparent, annotations,
    accent, tint, dark, grain, vignette, dim, fade, fadeDepth, tilt, bleed,
  } = opts;

  const square = [...new Set([...fade, ...(bleed ?? [])])];

  // The wrapper carries the fade mask and has to be big enough to hold the shadow,
  // or the mask would cut the shadow off at a hard line.
  const R = Math.ceil(reach * 1.8) + 40;

  const corners = [
    square.includes('top') || square.includes('left') ? 0 : radius,
    square.includes('top') || square.includes('right') ? 0 : radius,
    square.includes('bottom') || square.includes('right') ? 0 : radius,
    square.includes('bottom') || square.includes('left') ? 0 : radius,
  ].map((v) => `${v}px`).join(' ');

  // A starting guess only; the page corrects it from the shot's own pixels below,
  // unless --hairline named a side explicitly.
  const rim = dark ? 'rgba(255,255,255,.14)' : 'rgba(16,20,24,.09)';

  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${pageW}px; height: ${pageH}px;
    overflow: hidden;
    background: ${transparent ? 'transparent' : base};
    ${backgroundSize ? `background-size: ${backgroundSize};` : ''}
    -webkit-font-smoothing: antialiased;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, Helvetica, Arial, sans-serif;
  }
  .bg-media { position: absolute; inset: 0; overflow: hidden; }
  .bg-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .scrim, .vignette, .grain { position: absolute; inset: 0; pointer-events: none; }
  .scrim { background: rgba(8,10,13,${dim}); }
  .vignette { background: radial-gradient(120% 100% at 50% 42%, transparent 38%, rgba(4,6,9,${vignette}) 100%); }
  .grain {
    background-image: ${GRAIN_URI};
    opacity: ${grain};
    mix-blend-mode: ${dark ? 'soft-light' : 'overlay'};
  }

  .shot-wrap {
    position: absolute;
    left: ${shotX - R}px; top: ${shotY - R}px;
    width: ${shotW + R * 2}px; height: ${shotH + R * 2}px;
    ${fadeMask(fade, { shotW, shotH, reach: R, depth: fadeDepth })}
  }
  .shot {
    position: absolute; left: ${R}px; top: ${R}px;
    width: ${shotW}px;
    border-radius: ${corners};
    overflow: hidden;
    box-shadow: ${shadow};
    ${tilt ? `transform: perspective(1900px) rotateY(${tilt}deg) rotateX(${(Math.abs(tilt) / 5).toFixed(2)}deg) scale(.94);` : ''}
    /* Promote to its own layer: without it, a large multi-layer shadow is
       rasterised into the page backing store and can band on gradients. */
    will-change: transform;
  }
  :root { --rim: ${rim}; }
  ${hairline ? `.shot::after {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    border-radius: ${corners};
    box-shadow: inset 0 0 0 1px var(--rim);
  }` : ''}
  #shot {
    display: block;
    width: ${imgW}px; height: ${imgH}px;
    /* The source is placed 1:1 on the raster; never let the UA resample it. */
    image-rendering: -webkit-optimize-contrast;
  }
  ${tint ? `.tint { position:absolute; inset:0; background:${tint}; mix-blend-mode:multiply; pointer-events:none; }` : ''}

  .chrome { display: flex; align-items: center; gap: 10px; padding: 0 12px; position: relative; }
  .chrome.mac { height: ${CHROME_HEIGHT.mac}px; background: #e9e9eb; box-shadow: inset 0 -1px 0 rgba(0,0,0,.08); }
  .chrome.mac.dark { background: #33343a; box-shadow: inset 0 -1px 0 rgba(255,255,255,.07); }
  .chrome.browser { height: ${CHROME_HEIGHT.browser}px; background: #e4e5e8; box-shadow: inset 0 -1px 0 rgba(0,0,0,.09); }
  .chrome.browser.dark { background: #2c2d31; box-shadow: inset 0 -1px 0 rgba(255,255,255,.07); }
  .lights { display: flex; gap: 7px; flex: none; }
  .light { width: 11px; height: 11px; border-radius: 50%; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.12); }
  .chrome .title {
    position: absolute; left: 0; right: 0; text-align: center;
    font-size: 12px; font-weight: 500; color: #5c5c60; pointer-events: none;
  }
  .chrome.dark .title { color: #a5a5ab; }
  .omnibox {
    display: flex; align-items: center; gap: 6px; margin-left: 6px;
    height: 26px; padding: 0 12px; border-radius: 13px;
    background: #f7f8f9; color: #5c5c60;
    font-size: 12px; white-space: nowrap; overflow: hidden;
    box-shadow: inset 0 0 0 1px rgba(0,0,0,.06);
  }
  .chrome.dark .omnibox { background: #1e1f23; color: #a5a5ab; box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
  .omnibox span { overflow: hidden; text-overflow: ellipsis; }

  .annotations { position: absolute; left: 0; top: ${chromeHeight}px; width: ${imgW}px; height: ${imgH}px; }
  .anno-box {
    position: absolute; border: 3px solid ${accent}; border-radius: 6px;
    box-shadow: 0 0 0 1px rgba(255,255,255,.5), 0 6px 18px rgba(0,0,0,.18);
  }
  .anno-spot { position: absolute; border-radius: 6px; box-shadow: 0 0 0 9999px rgba(10,13,16,.55); }
  .anno-blur { position: absolute; backdrop-filter: blur(9px) saturate(.55); border-radius: 4px; }
  .anno-redact { position: absolute; background: #14181c; border-radius: 4px; }
  .anno-pixelate { position: absolute; border-radius: 4px; display: block; }
  .anno-badge {
    position: absolute; transform: translate(-50%, -50%);
    min-width: 26px; height: 26px; padding: 0 7px; border-radius: 13px;
    background: ${accent}; color: #fff;
    font-size: 14px; font-weight: 650; font-variant-numeric: tabular-nums;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 6px rgba(0,0,0,.28), 0 0 0 2px rgba(255,255,255,.85);
  }
  .anno-text {
    position: absolute; padding: 6px 10px; border-radius: 7px;
    background: rgba(20,24,28,.92); color: #fff; font-size: 13px; line-height: 1.35;
    box-shadow: 0 4px 14px rgba(0,0,0,.24);
  }
  .anno-click {
    position: absolute; transform: translate(-50%, -50%);
    border: 2.5px solid; border-radius: 50%; opacity: .95;
  }
  .anno-click span {
    position: absolute; inset: 28%; border: 2.5px solid; border-radius: 50%;
  }
  .anno-cursor {
    position: absolute; overflow: visible;
    filter: drop-shadow(0 1.5px 2.5px rgba(0,0,0,.4));
  }
  .anno-arrow { position: absolute; inset: 0; overflow: visible; }
</style></head>
<body>
  ${bgLayers}
  ${dim ? '<div class="scrim"></div>' : ''}
  ${vignette ? '<div class="vignette"></div>' : ''}
  ${grain ? '<div class="grain"></div>' : ''}
  <div class="shot-wrap">
    <div class="shot">
      ${chromeMarkup(chrome, title, shotW)}
      <img id="shot" src="${uri}" alt="">
      ${tint ? '<div class="tint"></div>' : ''}
      ${annotationMarkup(annotations, { accent })}
    </div>
  </div>
<script>
  (async () => {
    const shot = document.getElementById('shot');
    try { await shot.decode(); } catch { /* a broken source will fail louder elsewhere */ }
    const ratio = shot.naturalWidth / shot.clientWidth;

    /*
     * Pick the hairline from the shot, not from the backdrop.
     *
     * The rim is drawn 1px inside the shot's own edge, so what it has to stand out
     * against is the shot. A light rim on a white panel draws nothing however dark
     * the ground behind it is — and that is exactly the case a backdrop-driven
     * rule gets wrong, because a light UI on ink is the common one.
     */
    if (${JSON.stringify(!opts.rimLocked)}) {
      const probe = document.createElement('canvas');
      const pw = probe.width = Math.min(shot.naturalWidth, 220);
      const ph = probe.height = Math.min(shot.naturalHeight, 220);
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      pctx.drawImage(shot, 0, 0, pw, ph);
      const px = pctx.getImageData(0, 0, pw, ph).data;
      const band = Math.max(2, Math.round(Math.min(pw, ph) * 0.07));
      let sum = 0, n = 0;
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++) {
          if (x >= band && y >= band && x < pw - band && y < ph - band) continue;
          const i = (y * pw + x) * 4;
          sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          n++;
        }
      }
      document.documentElement.style.setProperty(
        '--rim', sum / n < 118 ? 'rgba(255,255,255,.15)' : 'rgba(16,20,24,.10)',
      );
    }
    for (const canvas of document.querySelectorAll('canvas.anno-pixelate')) {
      const x = +canvas.dataset.x, y = +canvas.dataset.y;
      const w = +canvas.dataset.w, h = +canvas.dataset.h, block = +canvas.dataset.block;
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(w / block));
      small.height = Math.max(1, Math.round(h / block));
      small.getContext('2d').drawImage(shot, x * ratio, y * ratio, w * ratio, h * ratio, 0, 0, small.width, small.height);
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
    }
    window.__shotkitReady = true;
  })();
</script>
</body></html>`;
}

/**
 * Padding, as one to four values in CSS order.
 *
 * `40` all round, `40 24` for vertical/horizontal, `40 24 0` to add a bottom, or
 * `40 24 0 24` for all four. Percentages resolve against the shot's short side.
 *
 * Four values exist for one reason worth stating: a zero edge is how you bleed a
 * shot off its frame. A panel that is taller than the space it has to live in
 * should run off the bottom rather than be shrunk until its type stops being
 * readable, and that means backdrop on three sides and none on the fourth.
 */
function resolvePad(spec, shortSide, minimum, biasBottom) {
  if (spec === undefined) {
    const value = Math.max(minimum, Math.round(shortSide * 0.09));
    return { top: value, right: value, bottom: Math.round(value * 1.14), left: value, uniform: true };
  }

  const parts = String(spec).trim().split(/[\s,]+/).filter(Boolean).map((raw) => {
    const value = raw.endsWith('%') ? Math.round(shortSide * (parseFloat(raw) / 100)) : Number(raw);
    if (!Number.isFinite(value)) fail(`--pad wants numbers or percentages, got "${raw}"`);
    return value;
  });

  const [a, b, c, d] = parts;
  const box =
    parts.length === 1 ? { top: a, right: a, bottom: a, left: a }
    : parts.length === 2 ? { top: a, right: b, bottom: a, left: b }
    : parts.length === 3 ? { top: a, right: b, bottom: c, left: b }
    : parts.length === 4 ? { top: a, right: b, bottom: c, left: d }
    : fail('--pad takes one to four values');

  // The shadow falls downward, so a uniform pad needs a little more room below —
  // and the extra room is also what stops the shot looking like it is sliding off
  // the bottom. Only for the one-value form: anything more specific was asked for
  // exactly, and quietly adding 14% to it would be a bug, not a courtesy.
  if (parts.length === 1 && biasBottom && a > 0) box.bottom = Math.round(a * 1.14);

  return { ...box, uniform: parts.length === 1 };
}

/**
 * A backdrop is a base paint plus zero or more layers stacked under the shot.
 *
 * Layers rather than one CSS value because the interesting backdrops are not a
 * single paint: an image needs its own blur and scrim, and the blur-self look
 * needs the screenshot painted a second time, scaled up and defocused.
 */
function resolveBackground(spec, ctx) {
  const raw = spec === undefined || spec === true ? 'auto' : String(spec);

  if (raw === 'auto') return { kind: 'auto', layers: [], needsSample: true };
  if (raw === 'transparent' || raw === 'none') {
    return { kind: 'transparent', base: 'transparent', layers: [], dark: null };
  }

  // The shot, painted again behind itself, scaled up and defocused. Costs nothing
  // to pick and can never clash, because every colour in it came from the shot.
  if (raw === 'blur' || raw === 'blurself') {
    return {
      kind: 'blur',
      base: '#0f1114',
      needsSample: true,
      layers: [`<div class="bg-media"><img src="${ctx.uri}" alt="" style="filter:blur(${ctx.bgBlur ?? 72}px) saturate(1.55);transform:scale(1.5)"></div>`],
    };
  }

  if (raw.startsWith('image:')) {
    const file = raw.slice(6);
    if (!existsSync(file)) fail(`--bg image not found: ${file}`);
    const blur = ctx.bgBlur ?? 0;
    return {
      kind: 'image',
      base: '#12151a',
      dark: ctx.bgDim !== undefined ? ctx.bgDim > 0.2 : true,
      layers: [`<div class="bg-media"><img src="${dataUri(file)}" alt="" style="object-fit:${ctx.bgFit ?? 'cover'};${blur ? `filter:blur(${blur}px);transform:scale(1.12)` : ''}"></div>`],
    };
  }

  if (BACKDROPS[raw]) return { kind: 'named', base: BACKDROPS[raw].css, dark: BACKDROPS[raw].dark, layers: [] };

  // A mid-lightness saturated ground takes the dark rim: the shot on it is
  // usually a light UI, and a white rim on a white panel draws nothing.
  if (SOLIDS[raw]) return { kind: 'solid', base: solidCss(SOLIDS[raw]), dark: SOLIDS[raw].l < 0.55, layers: [] };

  if (MESHES[raw]) {
    const mesh = MESHES[raw];
    return { kind: 'mesh', base: `${mesh.stops.join(', ')}, ${mesh.base}`, dark: mesh.dark, layers: [] };
  }

  if (raw.startsWith('mesh:')) {
    const colors = raw.slice(5).split(',').map((c) => c.trim());
    const [base, ...rest] = colors;
    const spots = [
      '62% 56% at 10% 6%', '58% 52% at 90% 16%', '74% 62% at 50% 104%', '50% 46% at 92% 92%',
    ];
    return {
      kind: 'mesh',
      base: `${rest.map((c, i) => `radial-gradient(${spots[i % spots.length]}, ${c} 0%, transparent 64%)`).join(', ')}, ${base}`,
      dark: null, layers: [],
    };
  }

  if (raw.startsWith('grid:') || raw.startsWith('dots:')) {
    const [kind, rest] = [raw.slice(0, 4), raw.slice(5)];
    const [line, ground = '#ffffff', step = '24'] = rest.split(',').map((v) => v.trim());
    const pattern = kind === 'grid'
      ? `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`
      : `radial-gradient(circle at 1px 1px, ${line} 1.2px, transparent 0)`;
    return {
      kind: 'pattern', base: `${pattern}, ${ground}`, dark: null, layers: [],
      backgroundSize: `${step}px ${step}px`,
    };
  }

  if (raw.startsWith('linear:')) {
    const [a, b, angle = '160'] = raw.slice(7).split(',');
    return { kind: 'css', base: `linear-gradient(${angle}deg, ${a} 0%, ${b} 100%)`, dark: null, layers: [] };
  }
  if (raw.startsWith('radial:')) {
    const [a, b] = raw.slice(7).split(',');
    return { kind: 'css', base: `radial-gradient(120% 120% at 30% 0%, ${a} 0%, ${b} 100%)`, dark: null, layers: [] };
  }

  return { kind: 'css', base: raw, dark: null, layers: [] };
}

async function frameOne(input, outPath, flags) {
  const presetName = flags.preset ?? 'clean';
  const preset = PRESETS[presetName];
  if (!preset) fail(`unknown --preset "${presetName}" (have: ${Object.keys(PRESETS).join(', ')})`);

  const scale = num(flags.scale, 2);
  if (![1, 2, 3].includes(scale)) fail('--scale must be 1, 2 or 3');

  const natural = imageSize(input);
  const imgW = natural.width / scale;
  const imgH = natural.height / scale;

  const chrome = flags.chrome ?? preset.chrome;
  if (!(chrome in CHROME_HEIGHT)) fail(`unknown --chrome "${chrome}" (have: ${Object.keys(CHROME_HEIGHT).join(', ')})`);
  const chromeHeight = CHROME_HEIGHT[chrome];

  const shadowName = flags.shadow ?? preset.shadow;
  const shadow = SHADOWS[shadowName];
  if (!shadow) fail(`unknown --shadow "${shadowName}" (have: ${Object.keys(SHADOWS).join(', ')})`);

  const uri = dataUri(input);
  const bg = resolveBackground(flags.bg ?? preset.bg, {
    uri,
    bgBlur: flags['bg-blur'] === undefined ? undefined : num(flags['bg-blur']),
    bgDim: flags['bg-dim'] === undefined ? undefined : num(flags['bg-dim']),
    bgFit: flags['bg-fit'],
  });
  const transparent = bg.kind === 'transparent';

  const tilt = flags.tilt === undefined ? 0 : Math.max(-25, Math.min(25, num(flags.tilt)));

  const shortSide = Math.min(imgW, imgH);
  // A rotated shot swings its near edge outward. The transform is scaled back to
  // .94 to absorb most of that; the rest comes out of the padding, or the corner
  // that swung forward would touch the canvas edge.
  const tiltPad = tilt ? Math.ceil(shortSide * Math.abs(tilt) / 100) : 0;
  const minPad = Math.ceil(shadow.reach * 0.75) + tiltPad;
  const padWasAsked = flags.pad !== undefined;
  const pad = resolvePad(flags.pad ?? preset.pad, shortSide, minPad, true);

  // A preset's percentage is a proportion, not a promise: on a narrow shot it can
  // land under the shadow's reach, and a clipped shadow reads as a bug. The preset
  // yields; an explicit --pad is the caller's call and only gets a warning.
  for (const side of ['top', 'right', 'bottom', 'left']) {
    if (pad[side] === 0) continue;   // a zero edge is a deliberate bleed
    if (pad[side] >= minPad) continue;
    if (padWasAsked) {
      console.warn(`  note: --pad ${pad[side]} on the ${side} is tighter than the "${shadowName}" shadow reaches (${shadow.reach}px); it will be clipped there`);
    } else {
      pad[side] = side === 'bottom' ? Math.round(minPad * 1.14) : minPad;
    }
  }

  const padTop = pad.top;
  const padBottom = pad.bottom;
  const padX = pad.left;
  const padRight = pad.right;

  // An edge with no padding is one the shot runs off. Content that continues does
  // not have a rounded corner, so the corners on that edge go square — the same
  // rule --fade applies, for the same reason.
  const bleed = ['top', 'right', 'bottom', 'left'].filter((side) => pad[side] === 0);

  const shotW = imgW;
  const shotH = imgH + chromeHeight;

  let pageW = Math.ceil(shotW + padX + padRight);
  let pageH = Math.ceil(shotH + padTop + padBottom);

  if (flags.ratio) {
    const [rw, rh] = String(flags.ratio).split(/[:/x]/).map(Number);
    if (!rw || !rh) fail('--ratio wants w:h, e.g. 16:10');
    const target = rw / rh;
    if (pageW / pageH < target) pageW = Math.ceil(pageH * target);
    else pageH = Math.ceil(pageW / target);
  }

  // Snap the shot to a whole device pixel. A half-pixel offset resamples every
  // source pixel and is exactly the softness this tool exists to avoid.
  const snap = (v) => Math.round(v * scale) / scale;
  const shotX = snap(padX + (pageW - shotW - padX - padRight) / 2);
  const shotY = snap(padTop + (pageH - shotH - padTop - padBottom) / 2);

  const accent = flags.accent ?? '#e5484d';
  const tint = flags.tint ? String(flags.tint) : null;

  let annotations = [];
  if (flags.annotate) {
    const spec = String(flags.annotate);
    const json = existsSync(spec) ? readFileSync(spec, 'utf8') : spec;
    try { annotations = JSON.parse(json); } catch { fail('--annotate wants a JSON file or a JSON array'); }
    if (!Array.isArray(annotations)) fail('--annotate wants an array of shapes');
  }

  // `auto` and `blur` both need to know what colour the shot actually is: one to
  // derive the backdrop from it, the other only to decide which way the hairline
  // goes. Both answers come from one sampling pass, before the real render.
  let sampled = null;
  if (bg.needsSample) {
    sampled = await evaluateInPage(
      `<!doctype html><html><body><img id="shot" src="${uri}"></body></html>`,
      AUTO_BG_FN,
    );
    if (bg.kind === 'auto') bg.base = sampled.css;
  }

  const dark = flags.hairline === 'light' ? true
    : flags.hairline === 'dark' ? false
    : bg.dark ?? sampled?.dark ?? false;

  /*
   * Grain is off unless asked for.
   *
   * It exists to dither away 8-bit banding on a long gradient, and it does — but
   * noise is the one thing PNG cannot compress. Measured on a mesh backdrop it
   * took the file from 201 KB to 606 KB, for a ramp Chromium had already dithered
   * well enough that the banding was hard to find. Turn it on when you can
   * actually see steps, which is mostly on large, dark, low-chroma gradients.
   */
  const grain = num(flags.grain, 0);

  const fade = flags.fade
    ? String(flags.fade).split(',').map((e) => e.trim()).filter(Boolean)
    : [];
  for (const edge of fade) {
    if (!['top', 'bottom', 'left', 'right'].includes(edge)) fail(`--fade wants top/bottom/left/right, got "${edge}"`);
  }

  const html = buildHtml({
    uri, imgW, imgH, pageW, pageH, shotX, shotY, shotW, shotH,
    radius: num(flags.radius, preset.radius),
    shadow: shadow.css, reach: shadow.reach, chrome, chromeHeight, title: flags.title,
    hairline: flags.hairline === 'off' ? false : bool(flags.hairline, preset.hairline),
    base: bg.base ?? 'transparent', backgroundSize: bg.backgroundSize,
    rimLocked: flags.hairline === 'light' || flags.hairline === 'dark',
    bgLayers: (bg.layers ?? []).join('\n'),
    transparent, annotations, accent, tint, dark, grain,
    vignette: num(flags.vignette, 0), dim: num(flags['bg-dim'], 0),
    fade, fadeDepth: num(flags['fade-depth'], 0.28), tilt, bleed,
  });

  if (flags['dump-html']) {
    writeFileSync(String(flags['dump-html']), html);
    console.warn(`  wrote ${flags['dump-html']}`);
  }

  mkdirSync(resolve(outPath, '..'), { recursive: true });
  await renderHtml({
    html, width: pageW, height: pageH, scale, transparent, out: outPath, quality: num(flags.quality, 92),
  });

  const optimized = flags.optimize ? optimize(outPath) : null;

  const bytes = statSync(outPath).size;
  console.warn(
    `  ${basename(outPath)}  ${pageW * scale}×${pageH * scale}  ${(bytes / 1024).toFixed(0)} KB` +
    `  [${presetName} · ${bg.kind === 'auto' ? 'auto bg' : String(flags.bg ?? preset.bg)}` +
    `${chrome !== 'none' ? ` · ${chrome}` : ''}${fade.length ? ` · fade ${fade.join('+')}` : ''}` +
    `${tilt ? ` · tilt ${tilt}°` : ''}${optimized ? ` · ${optimized}` : ''}]`,
  );
  if (!flags.optimize && bytes > 400 * 1024) {
    console.warn(`         ${(bytes / 1024).toFixed(0)} KB — a gradient backdrop is mostly what costs this; try --optimize, or --format jpg`);
  }
}

async function cmdFrame(positional, flags) {
  const inputs = positional.filter((p) => !p.startsWith('--'));
  if (!inputs.length) fail('frame needs at least one input image');

  const outFlag = flags.out ?? flags.o;
  if (!outFlag) fail('frame needs --out <file.png> or --out <directory>');

  const many = inputs.length > 1;
  const outIsDir = many || (typeof outFlag === 'string' && (existsSync(outFlag) && statSync(outFlag).isDirectory() || !extname(outFlag)));

  for (const input of inputs) {
    if (!existsSync(input)) fail(`no such file: ${input}`);
    const suffix = flags.suffix ?? '';
    const ext = flags.format ? `.${flags.format}` : extname(input) || '.png';
    const out = outIsDir
      ? join(String(outFlag), `${basename(input, extname(input))}${suffix}${ext}`)
      : String(outFlag);
    await frameOne(input, out, flags);
  }
}

/* -------------------------------------------------------------- capture --- */

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  html { scroll-behavior: auto !important; scrollbar-width: none !important; }
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
`;

async function cmdCapture(positional, flags) {
  const url = positional[0];
  if (!url) fail('capture needs a URL (or a file:// path)');
  const out = String(flags.out ?? flags.o ?? fail('capture needs --out <file.png>'));

  const chromium = await loadPlaywright();
  if (!chromium) {
    fail('capture needs Playwright:\n  npm i -D playwright && npx playwright install chromium');
  }

  const [vw, vh] = String(flags.viewport ?? '1280x800').split(/[x×,]/).map(Number);
  const scale = num(flags.scale, 2);

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: vw, height: vh },
    deviceScaleFactor: scale,
    colorScheme: flags.theme === 'dark' ? 'dark' : 'light',
    reducedMotion: 'reduce',
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

  if (bool(flags.freeze, true)) await page.addStyleTag({ content: FREEZE_CSS });

  if (flags.hide) {
    const selectors = String(flags.hide).split(',').map((s) => s.trim()).filter(Boolean);
    await page.addStyleTag({ content: `${selectors.join(', ')} { visibility: hidden !important; }` });
  }

  if (flags.click) await page.click(String(flags.click));
  if (flags['wait-for']) await page.waitForSelector(String(flags['wait-for']), { timeout: 20000 });

  /*
   * Make lazy content load before capturing, not during.
   *
   * `loading="lazy"` images below the fold never enter the viewport in a
   * full-page screenshot, so they are still empty boxes when the shot is taken —
   * the page appears to have holes in it that a real visitor would never see.
   * Scrolling the whole document once brings them in, then we wait for them to
   * decode and return to the top so the capture starts where it should.
   */
  if (bool(flags['full-page'], false) || bool(flags['load-lazy'], false)) {
    await page.evaluate(async () => {
      const step = window.innerHeight * 0.8;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
      await Promise.all(
        [...document.images]
          .filter((img) => !img.complete)
          .map((img) => new Promise((r) => {
            img.addEventListener('load', r, { once: true });
            img.addEventListener('error', r, { once: true });
            setTimeout(r, 4000);
          })),
      );
    });
    await page.waitForTimeout(250);
  }

  // Fonts before pixels: a shot taken mid-swap shows the fallback face, which
  // is the difference between "our type" and "some type".
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(num(flags.wait, 400));

  // Park the pointer somewhere inert so no hover state leaks into the shot.
  await page.mouse.move(2, vh - 2);
  await page.waitForTimeout(120);

  mkdirSync(resolve(out, '..'), { recursive: true });

  let clip;
  let fullPage = bool(flags['full-page'], false);

  if (flags.selector) {
    /*
     * Scroll to it first, then measure.
     *
     * `boundingBox()` is viewport-relative, and a viewport screenshot can only
     * clip to what is in the viewport — so anything below the fold produced
     * "clipped area is outside the resulting image" rather than a screenshot.
     * Most things worth capturing on a marketing page are below the fold.
     */
    const locator = page.locator(String(flags.selector)).first();
    await locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(160);

    const box = await locator.boundingBox();
    if (!box) fail(`--selector "${flags.selector}" matched nothing with a box`);

    const bleed = num(flags.bleed, 0);
    let height = box.height + bleed * 2;
    if (flags['max-height']) height = Math.min(height, num(flags['max-height']));

    // An element taller than the viewport cannot be clipped out of one. Fall back
    // to a full-page pass, where clip coordinates are in page space instead.
    if (height > vh || box.y - bleed < 0) {
      fullPage = true;
      const { scrollX, scrollY, pageW, pageH } = await page.evaluate(() => ({
        scrollX: window.scrollX, scrollY: window.scrollY,
        pageW: document.documentElement.scrollWidth,
        pageH: document.documentElement.scrollHeight,
      }));
      const x = Math.max(0, box.x + scrollX - bleed);
      const y = Math.max(0, box.y + scrollY - bleed);
      clip = {
        x, y,
        width: Math.min(box.width + bleed * 2, pageW - x),
        height: Math.min(height, pageH - y),
      };
    } else {
      const x = Math.max(0, box.x - bleed);
      const y = Math.max(0, box.y - bleed);
      clip = { x, y, width: Math.min(box.width + bleed * 2, vw - x), height: Math.min(height, vh - y) };
    }
  }

  const raw = flags.preset || flags.bg || flags.chrome
    ? join(mkdtempSync(join(tmpdir(), 'shotkit-raw-')), 'raw.png')
    : out;

  await page.screenshot({
    path: raw,
    fullPage,
    omitBackground: bool(flags['omit-background'], false),
    ...(clip ? { clip } : {}),
  });
  await browser.close();

  if (raw !== out) {
    await frameOne(raw, out, flags);
  } else {
    const { width, height } = imageSize(out);
    console.warn(`  ${basename(out)}  ${width}×${height}  ${(statSync(out).size / 1024).toFixed(0)} KB`);
  }
}

/* ------------------------------------------------------------- optimize --- */

/**
 * Shrink PNGs in place, for shots produced by something other than `frame`.
 *
 * A capture pipeline that already exists does not need to be rewritten to get
 * the size win; it just needs a pass at the end.
 */
async function cmdOptimize(positional, flags) {
  const files = [];
  for (const path of positional) {
    if (!existsSync(path)) fail(`no such file: ${path}`);
    if (statSync(path).isDirectory()) {
      files.push(...readdirSync(path).filter((f) => /\.png$/i.test(f)).map((f) => join(path, f)));
    } else files.push(path);
  }
  if (!files.length) fail('optimize needs a .png file or a directory of them');

  let before = 0;
  let after = 0;
  for (const file of files.sort()) {
    const was = statSync(file).size;
    const how = optimize(file);
    const now = statSync(file).size;
    before += was;
    after += now;
    console.warn(
      `  ${basename(file)}  ${(was / 1024).toFixed(0)} KB → ${(now / 1024).toFixed(0)} KB` +
      `${how ? `  [${how}]` : '  [unchanged]'}`,
    );
  }
  const saved = before - after;
  console.warn(
    `\n  ${files.length} file${files.length === 1 ? '' : 's'}, ` +
    `${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB ` +
    `(−${Math.round((saved / before) * 100)}%)\n`,
  );
  if (flags['max-kb']) {
    const over = files.filter((f) => statSync(f).size > num(flags['max-kb']) * 1024);
    if (over.length) {
      console.warn(`  ${over.length} still over ${flags['max-kb']} KB: ${over.map((f) => basename(f)).join(', ')}\n`);
      process.exit(1);
    }
  }
}

/* ---------------------------------------------------------------- check --- */

/**
 * The defects that make a screenshot look cheap are mostly measurable.
 *
 * The one worth the most is edge bleed: a crop that runs through a line of text
 * leaves a column of half-glyphs at the boundary. It reads as carelessness from
 * across the room, and it is invisible to whoever chose the crop height, because
 * they were looking at the content and not at the edge.
 */
const CHECK_FN = `async () => {
  const img = document.getElementById('shot');
  await img.decode();
  const w = img.naturalWidth, h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);

  const lum = (x, y) => {
    const i = (y * w + x) * 4;
    const a = data[i + 3] / 255;
    // Composite onto mid grey so a transparent corner is not read as content.
    return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * a + 128 * (1 - a);
  };

  // Walk the strips just inside each edge and count sharp transitions along them.
  // Half-glyphs produce many; background or a solid border produces almost none.
  //
  // A band rather than a single line, because a 1px window border or a rounded
  // corner's antialiasing sits on top of the cut and would hide it. Depth stays
  // shallow — content that legitimately stops 8px short of the edge is a margin,
  // not a crop, and flagging it would make the check noise.
  const strip = (edge, depth) => {
    const n = edge === 'top' || edge === 'bottom' ? w : h;
    const at = (k) =>
      edge === 'top' ? lum(k, depth)
      : edge === 'bottom' ? lum(k, h - 1 - depth)
      : edge === 'left' ? lum(depth, k)
      : lum(w - 1 - depth, k);
    let transitions = 0;
    for (let k = 1; k < n; k++) if (Math.abs(at(k) - at(k - 1)) > 38) transitions++;
    return { transitions, ratio: transitions / n };
  };

  const worst = (edge) => {
    let out = { transitions: 0, ratio: 0 };
    for (let depth = 0; depth <= 4; depth++) {
      const s = strip(edge, depth);
      if (s.ratio > out.ratio) out = s;
    }
    return out;
  };

  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) { opaque = false; break; }

  return {
    width: w, height: h, opaque,
    edges: {
      top: worst('top'), bottom: worst('bottom'), left: worst('left'), right: worst('right'),
    },
  };
}`;

async function cmdCheck(positional, flags) {
  const files = [];
  for (const path of positional) {
    if (!existsSync(path)) fail(`no such file: ${path}`);
    if (statSync(path).isDirectory()) {
      files.push(...readdirSync(path).filter((f) => /\.(png|jpe?g)$/i.test(f)).map((f) => join(path, f)));
    } else files.push(path);
  }
  if (!files.length) fail('check needs a file or a directory of images');

  const maxKb = num(flags['max-kb'], 400);
  const bleedLimit = num(flags['bleed-ratio'], 0.05);
  const sizes = new Map();
  let problems = 0;

  for (const file of files.sort()) {
    const uri = dataUri(file);
    const report = await evaluateInPage(
      `<!doctype html><html><body><img id="shot" src="${uri}"></body></html>`,
      CHECK_FN,
    );
    const kb = statSync(file).size / 1024;
    const notes = [];

    for (const [edge, { transitions, ratio }] of Object.entries(report.edges)) {
      if (ratio > bleedLimit) {
        notes.push(`${edge} edge cuts through content (${transitions} sharp transitions, ${(ratio * 100).toFixed(0)}% of the edge) — crop at a boundary or widen the capture`);
      }
    }
    if (kb > maxKb) notes.push(`${kb.toFixed(0)} KB is over the ${maxKb} KB budget — try a lower --scale, or pngquant/oxipng`);
    if (Math.min(report.width, report.height) < 400) {
      notes.push(`${report.width}×${report.height} is small; if this is displayed above ~${Math.round(report.width / 2)}px it will be upscaled and soft`);
    }

    sizes.set(`${report.width}×${report.height}`, (sizes.get(`${report.width}×${report.height}`) ?? 0) + 1);

    problems += notes.length;
    console.warn(`  ${notes.length ? 'FAIL' : 'ok  '} ${basename(file)}  ${report.width}×${report.height}  ${kb.toFixed(0)} KB${report.opaque ? '' : '  (has alpha)'}`);
    for (const note of notes) console.warn(`         ${note}`);
  }

  if (files.length > 1 && sizes.size > 1) {
    console.warn(`\n  note: ${sizes.size} different sizes in this set — ${[...sizes.entries()].map(([s, n]) => `${s}×${n}`).join(', ')}`);
    console.warn('        a set that is meant to be seen together should share one size, or it will jitter in a grid');
  }

  console.warn(problems === 0 ? '\n  clean\n' : `\n  ${problems} problem${problems === 1 ? '' : 's'}\n`);
  process.exit(problems > 0 && !flags['no-fail'] ? 1 : 0);
}

/* ----------------------------------------------------------------- help --- */

const HELP = `
shotkit — screenshots that look like a product, not a bug report.

  capture <url> --out shot.png [--selector .panel] [--viewport 1280x800]
                [--scale 2] [--theme light|dark] [--full-page] [--hide "..."]
                [--wait-for sel] [--click sel] [--wait ms] [--bleed px]
                [--max-height px] [--load-lazy] [+ any frame flag, to frame in one pass]

  frame <in.png…> --out <file|dir> [--preset clean|mac|browser|hero|docs|flat|bare]
                [--bg <backdrop>] [--pad 9%|64] [--radius 12] [--ratio 16:10]
                [--shadow none|contact|soft|deep|lifted] [--scale 2]
                [--chrome none|mac|mac-dark|browser|browser-dark] [--title "…"]
                [--fade bottom,right] [--fade-depth .28] [--tilt -14]
                [--grain .2] [--vignette .25] [--bg-blur px] [--bg-dim .3] [--bg-fit cover]
                [--hairline auto|light|dark|off] [--tint <css>] [--annotate anno.json]
                [--accent #e5484d] [--optimize] [--format png|jpg] [--suffix -framed]

  check <file|dir…> [--max-kb 400] [--bleed-ratio 0.05] [--no-fail]

  optimize <file|dir…> [--max-kb 400]     shrink PNGs in place

  --bg takes:
    auto            derived from the shot's own edge pixels, in OKLCH
    blur            the shot itself, scaled up and defocused behind itself
    transparent     alpha, for placing on a page that supplies its own ground
    quiet           ${Object.keys(BACKDROPS).join(', ')}
    solid           ${Object.keys(SOLIDS).join(', ')}
    mesh            ${Object.keys(MESHES).join(', ')}
    image:<path>    a photo or wallpaper; pair with --bg-blur and --bg-dim
    grid:<line>[,<ground>,<step>]   dots:<dot>[,<ground>,<step>]
    mesh:<base>,<a>,<b>[,<c>]       linear:<a>,<b>[,deg]    radial:<a>,<b>
    …or any CSS background value

  Presets: ${Object.keys(PRESETS).join(', ')}

  --scale is the DPR the source was captured at. The source is never resampled;
  scale only sets how crisp the frame's own decoration is.
`;

/* ------------------------------------------------------------------ main -- */

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional.shift();

try {
  if (command === 'frame') await cmdFrame(positional, flags);
  else if (command === 'capture') await cmdCapture(positional, flags);
  else if (command === 'check') await cmdCheck(positional, flags);
  else if (command === 'optimize') await cmdOptimize(positional, flags);
  else if (command === 'presets') console.warn(HELP);
  else { console.warn(HELP); process.exit(command ? 1 : 0); }
} catch (error) {
  fail(error?.stack ?? String(error));
}
