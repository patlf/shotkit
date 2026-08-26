# Recipes and the annotation spec

Read this when annotating, batching a set, or wiring `check` into CI. The SKILL.md covers
everything else.

## Contents

- [Annotation shapes](#annotation-shapes)
- [How many annotations](#how-many-annotations)
- [Finding coordinates](#finding-coordinates)
- [Batching a set](#batching-a-set)
- [Store and social sizes](#store-and-social-sizes)
- [CI](#ci)
- [Flag reference](#flag-reference)

## Annotation shapes

`--annotate` takes a JSON file or a JSON array on the command line. Coordinates are in
**source-image CSS pixels**: natural pixels ÷ `--scale`. Origin is the top-left of the
screenshot itself, not of the padded canvas — so an arrow does not move when you change
`--pad`.

```json
[
  { "type": "spotlight", "x": 16, "y": 236, "w": 316, "h": 156 },
  { "type": "box",       "x": 16, "y": 236, "w": 316, "h": 156 },
  { "type": "badge",     "x": 22, "y": 240, "label": "1" },
  { "type": "arrow",     "from": [250, 180], "to": [200, 300], "bend": 0.18 },
  { "type": "text",      "x": 120, "y": 150, "text": "Every edge is editable", "width": 220 },
  { "type": "blur",      "x": 16, "y": 88, "w": 200, "h": 22 },
  { "type": "pixelate",  "x": 16, "y": 88, "w": 210, "h": 24, "block": 9 },
  { "type": "redact",    "x": 16, "y": 60, "w": 140, "h": 18 },
  { "type": "click",     "x": 300, "y": 130, "r": 22 },
  { "type": "cursor",    "x": 296, "y": 126, "kind": "pointer", "size": 30 }
]
```

| Type | Fields | Notes |
| --- | --- | --- |
| `box` | `x y w h` | Accent outline with a white keyline, so it survives on dark and light UI alike. `highlight` is an alias. |
| `spotlight` | `x y w h` | Dims everything outside the rectangle. Pair with `box` when the region also needs an outline. Only ever use one per image — two spotlights dim each other's subject. |
| `badge` | `x y` + `label` or `n` | Centred on the point, not offset from it. For numbered walkthroughs. |
| `arrow` | `from [x,y]` `to [x,y]`, optional `bend` | Bowed; `bend: 0` is straight, negative bends the other way. The head is at `to`. |
| `text` | `x y text`, optional `width` | Dark pill, light type. Legible on any background, which a bare coloured label is not. |
| `blur` | `x y w h` | Backdrop blur. Reads as "redacted but real". **Not** safe redaction. |
| `pixelate` | `x y w h`, optional `block` (default 10) | Quantises to blocks on a canvas. This is the safe one: a blur is a convolution and can be inverted with enough knowledge of the font and layout; blocks throw the information away. |
| `redact` | `x y w h` | Solid block. When even the shape of the content is sensitive. |
| `click` | `x y`, optional `r` | Two concentric rings at the point. A single circle reads as a highlight; a pair reads as the moment of a click. |
| `cursor` | `x y`, optional `kind` (`arrow`/`pointer`), `size` | A drawn macOS cursor — same at every DPR, and it never picks up the capturing machine's theme. `x y` is the tip. |

Shapes draw in array order, so put `spotlight` first and everything else after it.

`--accent` sets the colour for boxes, arrows and badges. Default `#e5484d`. Use the product's
own accent when it reads on both themes; fall back to red-orange when it does not, because the
annotation layer needs to be visibly *not part of* the UI.

## How many annotations

One idea per image. A screenshot with six numbered badges is a diagram wearing a screenshot
costume, and the reader has to do the work of a legend. If there are six things to say, that is
six images or one real diagram.

The exception is a deliberate numbered walkthrough, where the numbers *are* the content and
the reader is expected to read them in order.

## Finding coordinates

Do not guess. Ask the page, in the same units the annotation spec uses:

```bash
node -e '
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(process.argv[1]);
  console.log(await p.locator(process.argv[2]).first().boundingBox());
  await b.close();
})()' "http://localhost:3000" ".pricing-card"
```

If the shot was clipped with `--selector`, subtract that element's `x`/`y` from every box you
measure — the clip made its top-left the new origin.

For a screenshot you did not capture, `--dump-html out.html` writes the frame's markup; open it
in a browser and use devtools to place things, then transcribe.

## Batching a set

One command, one preset, one scale:

```bash
node "$S" frame raw/*.png --out shots/ --preset clean --scale 2 --suffix ""
node "$S" check shots/
```

`--out` is treated as a directory when there is more than one input or when it has no extension.
`--suffix` appends to each output name, for keeping raw and framed side by side.

If the set has light and dark variants, run twice with different backdrops rather than letting
`--bg auto` pick per file — auto is derived per image, and across a set that produces eight
slightly different greys that read as a mistake:

```bash
node "$S" frame raw/*-dark.png --out shots/ --preset clean --bg ink
ls raw/*.png | grep -v -- '-dark' | xargs node "$S" frame --out shots/ --preset clean --bg paper
```

## Bleeding a shot off its frame

A zero edge in `--pad` means the shot runs off that side instead of sitting inside a margin, and
the corners on that edge square themselves off — content that continues does not have a rounded
corner. It is the right move whenever the shot is much taller than the space it has to live in:

```bash
node "$S" frame panel.png --out tile.png --scale 3 \
    --bg "linear:#fbfcfd,#e4eaee" --pad "30 30 0" --radius 12 --shadow contact
```

Containing the whole thing instead would mean scaling it down until its type stopped being
readable, which costs more than the bleed does. Match the shadow to the padding while you are
here — `soft` reaches 64px and will be clipped square by a 30px margin.

## Backdrop cost

Backdrops are most of the file. Measured on one 888×1146 shot:

| | PNG |
| --- | --- |
| `--bg paper` (flat-ish gradient) | 60 KB |
| `--bg aurora` (mesh) | 201 KB |
| `--bg aurora --grain .4` | 606 KB |
| `--bg aurora --optimize` | 70 KB |
| `--bg aurora --format jpg` | 118 KB |
| `--bg cobalt --optimize` (solid) | 63 KB |

Grain is the expensive one, and it buys less than it looks like it should — Chromium already
dithers its own gradients well enough that the banding is hard to find. Reach for it only when
you can see steps, which in practice means large, dark, low-chroma ramps.

`--optimize` is the better lever, and it beats JPEG here because palette quantisation leaves
glyph edges alone where JPEG rings around them. Reach for `--format jpg` instead when the
backdrop is a photograph.

## Store and social sizes

`--ratio` pads out to an exact aspect ratio with the same backdrop, centring the shot. It only
ever adds space, so nothing is cropped.

```bash
# Chrome Web Store marquee
node "$S" frame raw.png --out promo.png --preset hero --ratio 5:2

# OpenGraph card
node "$S" frame raw.png --out og.png --preset mac --ratio 1.91:1 --bg dusk
```

Store listings usually reject alpha channels and enforce exact pixel sizes. `--ratio` gets the
proportion right; the exact size still needs a resize step, and `sips -z H W out.png` on macOS
or a Playwright pass will do it. Some stores also reject PNGs with an alpha channel even when
it is fully opaque — strip it with
`python3 -c "from PIL import Image; Image.open('p.png').convert('RGB').save('p.png')"`.

## CI

`check` exits non-zero when it finds a problem, so it drops straight into a verify script:

```json
{ "scripts": { "check:shots": "shotkit check public/shots" } }
```

Thresholds: `--max-kb` (default 400), `--bleed-ratio` (default 0.05 — the fraction of an edge
that has to be busy before it counts as a cut). Raise `--bleed-ratio` if the design deliberately
bleeds content off an edge; `--no-fail` reports without failing.

Regenerating shots in CI only works if the capture is deterministic — same viewport, same seeded
data, same fonts installed. If it is not, `check` on committed images is still worth having.

## Flag reference

### capture

| Flag | Default | |
| --- | --- | --- |
| `--out` | — | required |
| `--selector` | — | clip to the first match's box |
| `--bleed` | `0` | px of context around `--selector` |
| `--max-height` | — | cap the clip height |
| `--viewport` | `1280x800` | |
| `--scale` | `2` | device pixel ratio |
| `--theme` | `light` | `light` or `dark` |
| `--full-page` | off | |
| `--hide` | — | comma-separated selectors to make invisible |
| `--click` | — | selector to click before capturing |
| `--wait-for` | — | selector to wait for |
| `--wait` | `400` | extra settle time, ms |
| `--freeze` | on | animations, transitions, caret, scrollbars |
| `--omit-background` | off | transparent page background |

Any `frame` flag passed to `capture` frames the result in the same pass.

### frame

| Flag | Default | |
| --- | --- | --- |
| `--out` | — | file, or directory for multiple inputs |
| `--preset` | `clean` | `clean` `mac` `browser` `hero` `docs` `flat` `bare` |
| `--bg` | preset | `auto`, `blur`, `transparent`, a quiet or mesh name, `image:<path>`, `grid:`/`dots:`, `mesh:`/`linear:`/`radial:`, or any CSS value |
| `--bg-blur` | `0` (`72` for `blur`) | px of defocus on an image or blur-self backdrop |
| `--bg-dim` | `0` | scrim over the backdrop, `0`–`1` |
| `--bg-fit` | `cover` | `cover` or `contain`, for `image:` |
| `--grain` | `0` | noise over the backdrop, `0`–`1`. Costly in PNG; see below |
| `--vignette` | `0` | corner darkening, `0`–`1` |
| `--fade` | — | `top`/`bottom`/`left`/`right`, comma-separated |
| `--fade-depth` | `0.28` | how far in the fade begins |
| `--tilt` | `0` | perspective rotation in degrees, clamped ±25 |
| `--optimize` | off | pngquant → oxipng → Pillow palette quantisation |
| `--pad` | preset | One to four values in CSS order (`40`, `40 24`, `40 24 0`, `40 24 0 24`); px or `%` of the shot's short side. A preset's value is clamped up to the shadow's reach; an explicit one is not |
| `--radius` | preset | px |
| `--shadow` | preset | `none` `contact` `soft` `deep` `lifted` |
| `--chrome` | preset | `none` `mac` `mac-dark` `browser` `browser-dark` |
| `--title` | — | title bar text, or the URL for browser chrome |
| `--hairline` | `auto` | `auto`, `light`, `dark` or `off`. Auto measures the shot and inverts against it |
| `--scale` | `2` | the DPR the **source** was captured at |
| `--ratio` | — | `w:h`, pads out only |
| `--annotate` | — | JSON file or inline array |
| `--accent` | `#e5484d` | annotation colour |
| `--tint` | — | CSS colour multiplied over the shot |
| `--format` | source ext | `png` or `jpg` |
| `--quality` | `92` | jpeg only |
| `--suffix` | — | appended to output names |
| `--dump-html` | — | write the frame markup for debugging |

### check

| Flag | Default | |
| --- | --- | --- |
| `--max-kb` | `400` | file size budget |
| `--bleed-ratio` | `0.05` | busy-edge threshold |
| `--no-fail` | off | report without a non-zero exit |
