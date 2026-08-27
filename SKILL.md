---
name: shotkit
description: >-
  Produce screenshots that look like a product shipped them — the way Shottr, CleanShot X
  or Screely do it: a clean deterministic capture, cropped at a real boundary, on a backdrop
  with padding, rounded corners, a layered shadow, optional macOS or browser window chrome,
  and arrows/numbered badges/blur redaction where they help. Use this whenever a screenshot
  is going to be *seen by someone else* — a marketing or landing page, a README or docs page,
  a changelog, a release post, an app store or Chrome Web Store listing, a slide, a design
  review — and whenever someone says their screenshots look bad, flat, cheap, amateur,
  inconsistent, blurry or "like a bug report", or asks to add a device frame, drop shadow,
  gradient background, padding or annotations to an image. Also use it to audit a set of
  existing screenshots for clipped text, wrong resolution and mismatched sizes. Do NOT use it
  for screenshots you take to verify your own work or to debug a layout — those want the raw
  pixels, and framing them just wastes time.
---

# Polished screenshots

A screenshot that will be looked at by a stranger is a piece of design, and it fails in
predictable ways. This skill is a renderer (`scripts/shotkit.mjs`) plus the judgment about
when to reach for which part of it.

## The one rule

**A frame cannot rescue a bad capture.** Padding, shadow and a mac window around a shot whose
text is cut mid-glyph makes the defect *more* obvious, not less — you have drawn a nice border
around the mistake and lit it. Spend the effort in this order:

1. **Capture** clean and deterministic
2. **Crop** at a boundary the UI actually has
3. **Frame** it
4. **Check** it

Most bad screenshots are lost at step 1 or 2, and no amount of step 3 gets them back.

## Quick start

```bash
# Installed into this project (npx skills add patlf/shotkit):
S="node .claude/skills/shotkit/scripts/shotkit.mjs"
# Installed globally (npx skills add -g patlf/shotkit):
# S="node $HOME/.claude/skills/shotkit/scripts/shotkit.mjs"
# Installed as a dependency of the project:
# S="npx shotkit"

# Capture a live page and frame it in one pass
$S capture http://localhost:3000 --out shots/hero.png \
    --selector ".app-shell" --viewport 1440x900 --preset mac --title "Acme"

# Frame a screenshot you already have (or one from ⌘⇧4 / Shottr / CleanShot)
$S frame raw.png --out shots/hero.png --preset clean

# Frame a whole set consistently
$S frame raw/*.png --out shots/ --preset clean --scale 2

# Audit what you have
$S check shots/

# Shrink PNGs a pipeline you already have produced
$S optimize shots/ --max-kb 400
```

No dependencies. It uses Playwright if the project has it, otherwise a local Chrome/Chromium.
`capture` needs Playwright; `frame` and `check` work with either.

## Step 0 — Decide the style once

A set of screenshots has one style or it has none. Settle it before the first capture, apply it
to every shot, and say it out loud — the next person to add a screenshot has to be able to match
it without guessing.

**Derive it from the project if the project says anything, and only ask when it doesn't.** In
order:

| Read | What it settles |
| --- | --- |
| `PRODUCT.md`, `DESIGN.md` | Register, which is the decision everything else follows from. A product that describes itself as a tool, an instrument, something you work *in* takes `auto` or a quiet backdrop and no mesh — a campaign surface behind a working UI reads as a product that is being sold rather than used. A product whose landing page *is* the product can carry `solid` or `mesh`. |
| The existing screenshots | If the repo already ships shots, match them. `check` a directory to read back the sizes, and look at what preset, backdrop and padding they used. A set half in the old style is worse than a set entirely in either. |
| The design tokens | The CSS custom properties, the theme file, the Tailwind config. A backdrop built from the product's own surface colours belongs to the page in a way a named backdrop never quite does — pass them as `linear:<a>,<b>` rather than reaching for the table below. |
| Where the shot will sit | A README renders on both a light and a dark GitHub page, so `docs` or `bare`. A tile or card that already has its own shadow and radius takes `bare`. A hero sits on a surface the page already owns. |
| Whether the product has themes | If the site or the docs ship light and dark, so do the screenshots — two captures, `<picture>` + `prefers-color-scheme`. This is not a style question and does not need asking. |

If those come back empty — no PRODUCT.md, no existing shots, nothing in the tokens — ask once,
in a single round. Four questions at most, each carrying a default, and then proceed:

1. **Where will these be seen?** README / docs / landing page / changelog or social / store listing
2. **How loud?** Quiet, derived from the shot *(default)* — or one saturated house colour
3. **Is "this is an app" part of the message?** No chrome *(default)* / macOS window / browser with URL bar
4. **Light, dark, or both?**

Do not ask what is already sitting in the repo, and do not ask a fifth question. The point is to
avoid rendering forty images in a style the project was never going to accept — not to run a
survey before every screenshot.

Either way, state the choice in one line before rendering anything — *"clean preset, `auto`
backdrop, no chrome, light and dark, 30px padding"* — so it gets corrected once instead of forty
times. Then record it where the project keeps its design decisions, next to the command that
reproduces the set. A style nobody wrote down lasts exactly as long as the session that chose it.

**Replacing an existing set is the same decision, plus one.** Old shots were captured at some
scale, cropped at some height and framed in some style, and the new ones have to agree with the
layout that was built around them, not just with each other. Measure the slot they go into before
you capture: the rendered width in the page, the breakpoint where that width changes, and whether
anything crops or bleeds them. Then capture at a scale that covers the largest of those.

## Step 1 — Capture

`capture` applies the hygiene that separates a repeatable shot from a lucky one. It waits for
`document.fonts.ready` (a shot taken mid-swap shows the fallback face, which is the difference
between *our* type and *some* type), freezes animations and transitions, hides the caret and
the scrollbars, forces `prefers-reduced-motion`, and parks the pointer in a corner so no stray
hover state leaks in.

Everything else is on you, and it is the part that matters:

- **Real content, not lorem ipsum.** Placeholder text in a marketing shot tells the reader the
  product has nothing to show.
- **No relative timestamps.** "3 minutes ago" dates the screenshot the moment it is published.
- **Nothing personal.** Real names, emails, avatars, API keys, internal URLs, "Downloads (847)".
  Use `--hide` for banners and `blur`/`redact` annotations for anything that survives.
- **Match the reader's theme.** If the page has light and dark modes, capture `--theme light`
  and `--theme dark` and serve them with a `<picture>` + `prefers-color-scheme` source. A
  light-mode screenshot on a dark-mode page is a jarring white rectangle.
- **`--scale 2`.** A 1× capture upscaled into a 2× layout goes soft exactly where the type is
  smallest, which is where the reader is looking.

Useful flags: `--selector` clips to an element (measured, not guessed), `--bleed` adds context
around it — but check the result, because bleed catches whatever is next to the element.
`--click` and `--wait-for` drive the UI into the state worth showing. `--full-page` for whole
pages.

## Step 2 — Crop where the UI has a seam

This is the step people skip. A crop height picked because it "looked about right" lands
wherever it lands, which is usually the middle of a row of text.

Cut at a divider, a section heading, a card edge, the end of a list — somewhere the UI already
has a horizontal line. If nothing is close, change the viewport or the scroll position instead
of accepting a cut through a word. `check` finds these after the fact, but the cheap fix is to
pick the boundary while you still have the page open.

Deliberately bleeding content off an edge is a legitimate device — it says "this continues"
rather than "this is all there is." It only works when it is obviously intentional: the cut
runs through a large region or a whole repeated row, never through a single line of type.

## Step 3 — Frame

Use the preset chosen in Step 0 for the entire set. Mixing presets is what makes a gallery look
assembled from whatever was lying around.

| Preset | Backdrop | Chrome | Use for |
| --- | --- | --- | --- |
| `clean` | derived from the shot | none | The default. A UI region, a panel, a component. |
| `mac` | derived | macOS title bar | A desktop app, or a whole window. |
| `browser` | slate | URL bar | Anything where "this is a website" is the point. |
| `hero` | derived | macOS | Above the fold. Generous padding, tall shadow. |
| `docs` | transparent | none | Inline in a README or docs page. |
| `flat` | derived | none | Dense grids, where shadows on every tile become noise. |
| `bare` | transparent | none | Rounded corners only, for placing on a page that supplies its own background. |

Three things the renderer does that are worth knowing about, because they are the things
that usually get done wrong by hand:

- **The shadow is stacked, not single.** Six layers from a tight contact shadow out to a wide
  ambient one. A single `0 20px 60px rgba(0,0,0,.3)` produces a uniform grey halo with no
  contact, which is the clearest tell of a screenshot that was decorated rather than lit.
- **The source is never resampled.** It is placed at exactly `naturalWidth / --scale` CSS px on
  a whole device pixel. `--scale` tells the renderer what DPR the source was captured at — it
  does not resize anything. Get it wrong and you lose the sharpness you captured at 2× for.
- **The hairline follows the shot, not the backdrop.** The rim is drawn 1px inside the shot's own
  edge, so what it has to stand out against is the shot: a light UI takes a dark rim and a dark UI
  takes a light one, whatever is behind them. It is measured from the shot's pixels at render
  time; override with `--hairline light|dark|off`.

If the shot is going into a card or tile that already has its own shadow and radius, use `bare`
or `docs`. Two shadows on one object looks like a mistake, because it is one.

## Backdrops

`--bg` is the single biggest lever on how a screenshot reads. Run
`$S` with no arguments for the full list.

| | |
| --- | --- |
| **`auto`** *(default)* | Samples the shot's own edge pixels and derives a backdrop from them in OKLCH, with chroma capped hard. The pair reads as one object under one light, and it can never clash — every colour in it came from the shot. |
| **`blur`** | The screenshot itself, painted again behind itself, scaled up and defocused. CleanShot's signature look. Same guarantee as `auto`, more depth, more bytes. |
| **quiet** — `paper` `slate` `sand` `mint` `blush` `arctic` `dusk` `ink` `graphite` | Low-chroma two-stop gradients. Use when the screenshot has to be *read* — a docs page, a feature walkthrough, a comparison table. |
| **solid** — `cobalt` `azure` `teal` `emerald` `lemon` `amber` `tangerine` `crimson` `fuchsia` `violet` | One saturated hue, lit from the top-left: the lightness swings ±0.055 and the hue rotates a few degrees warm toward the light. Loud, confident, and still a single colour rather than a gradient effect. The house style for changelogs, release posts and social cards, where a set reads as a set because only the hue changes. |
| **mesh** — `aurora` `ember` `tide` `orchid` `moss` `sunset` `noir` `porcelain` | A base colour with three offset radial bleeds, which is what makes a mesh read as light rather than as a gradient. Use at the top of a landing page, where the image is an object on a surface and the surface is allowed to be one. `porcelain` is the only light member. |
| **`image:<path>`** | A photo or wallpaper. Pair with `--bg-blur 40` and `--bg-dim .45` — an unblurred photo behind a UI screenshot makes the UI unreadable, every time. |
| **`grid:` / `dots:`** | `grid:#dfe3e8,#f8f9fa,26` — line colour, ground, step. Reads as technical rather than promotional; good for developer products. |
| **`transparent`** | Real alpha, including through the shadow. For placing on a page that supplies its own ground. |
| custom | `mesh:<base>,<a>,<b>`, `linear:<a>,<b>[,deg]`, `radial:<a>,<b>`, or any CSS background value. |

The `solid` family is generated from one OKLCH triple per hue rather than written as CSS.
Interpolating a gradient between two saturated sRGB colours dips in chroma through the middle and
goes muddy; in OKLCH the hue and saturation hold along the ramp, so it reads as one colour lit
unevenly. Each chroma is 95% of the most sRGB can hold at that lightness and hue, solved rather
than eyeballed — asking for more does not get more, because the browser gamut-maps the two stops
by different amounts and bends the ramp. Adding a hue is one line in `SOLIDS`.

That ceiling is also why the warm ones are light: yellow at full chroma simply *is* an L≈0.87
colour, and a dark saturated yellow is olive. **A light backdrop needs a bigger shadow** — a white
panel on `lemon` is only 1.5:1, so pair it with `--shadow deep`, which is what separates them.

Two knobs that finish a backdrop: `--vignette .25` darkens the corners, which pushes the shot
forward without touching its own contrast. `--grain .2` dithers away 8-bit banding on a long
gradient — leave it off unless you can actually see steps, because noise is the one thing PNG
cannot compress and it roughly tripled the file in testing.

**Saturated backdrops are expensive.** A mesh backdrop costs ~200 KB of PNG where a flat one
costs 60. `--optimize` quantises to a 256-entry palette with error diffusion, which is what
palette encoders are good at on flat-ish art like this — measured at 201 KB → 70 KB with no
banding that survives looking for it. It is opt-in rather than automatic because a screenshot
with a photograph in it would not fare as well. It uses `pngquant` or `oxipng` when they are
installed and falls back to Pillow, and it never quantises an image with real transparency,
which would turn a soft shadow edge into a hard one.

## Bleeding a shot off its frame

`--pad` takes one to four values in CSS order, and a zero edge is how you bleed: `--pad "30 30 0"`
puts backdrop on three sides and none on the fourth, so the shot runs off the bottom. The corners
on a zero edge square themselves off, because content that continues does not have a rounded
corner.

Reach for it when the shot is much taller than the space it has to live in. Containing the whole
thing means scaling it down until the type stops being readable, which costs the reader more than
the crop does. Match the shadow to the padding: `soft` reaches 64px and a 30px margin will clip it
square.

## When the crop has to cut anyway

`--fade bottom` dissolves an edge into the backdrop instead of slicing it. The mask covers the
shadow too, so the shot does not dissolve while still casting a hard shadow underneath, and the
corners on that edge go square because content that continues does not have a rounded corner.
`--fade-depth` controls how far in the fade starts (default `0.28`).

This is the honest fix when a panel is genuinely taller than the space: a hard cut says "this is
all there is" and is wrong, a fade says "this continues" and is true. It is not a licence to skip
Step 2 — a fade through a single line of type still looks like an accident.

## Other things worth reaching for

- **`--tilt -14`** puts the shot in perspective. Cheap, and it dates fast — use it on a landing
  page hero and nowhere else. Clamped to ±25°, and the padding grows to hold the corner that
  swings forward.
- **`--tint`** multiplies a colour over the shot. Useful for a background layer in a stack, bad
  for anything the reader is meant to read.
- **`--ratio 16:9`** pads out to an exact proportion for OpenGraph cards and store listings. It
  only ever adds space, so nothing is cropped.

## Step 4 — Check

```bash
$S check shots/
```

Reports, and exits non-zero on:

- **an edge that cuts through content** — the band just inside each edge is scanned for the
  sharp light/dark transitions that half-glyphs produce
- images over the file-size budget (`--max-kb`, default 400)
- images too small for where they will be displayed
- **a set whose members are different sizes** — the thing that makes a grid jitter

`check` reads the pixels, so it catches what review misses: whoever chose the crop was looking
at the content, not at the boundary.

`optimize <dir>` applies the same quantisation as `--optimize` to files that came from somewhere
else, so an existing capture pipeline gets the size win without being rewritten. Both belong in a
verify script — `check` exits non-zero on a finding.

## Annotations

Arrows, numbered badges, highlight boxes, spotlight dimming, blur, pixelation, solid redaction,
a drawn macOS cursor and a click indicator. Coordinates are in source-image CSS pixels — natural
pixels divided by `--scale`, the same space the shot is laid out in.

Prefer `pixelate` over `blur` for anything that must not be recoverable. A Gaussian blur is a
convolution, and with the font and layout known a short string like a six-digit code can be
brute-forced back out of it; quantising to blocks throws the information away instead.

```bash
$S frame raw.png --out out.png --preset clean --annotate anno.json --accent "#e5484d"
```

The full shape spec, and guidance on how many annotations one image can carry, is in
`references/recipes.md`. Read it when you are annotating; skip it otherwise.

## Where this goes wrong

| Symptom | Cause |
| --- | --- |
| Soft or fuzzy type | `--scale` does not match the DPR the source was captured at |
| Shadow cut off square at the canvas edge | `--pad` is tighter than the shadow reaches; raise it or use a shorter `--shadow` |
| Shot floats with no separation on a dark backdrop | Dark shadow on dark ground does nothing — the hairline carries it; keep `--hairline` on |
| Backdrop fights the UI | `--bg auto` sampled a colourful banner at the edge; name a backdrop instead |
| Photo backdrop makes the UI unreadable | `image:` without `--bg-blur` and `--bg-dim` |
| File is 600 KB | A gradient backdrop, or `--grain`. Try `--optimize`, or `--format jpg` |
| Text visible through a `blur` annotation | Use `pixelate` or `redact` — blur is not redaction |
| Set looks messy in a grid | Mixed presets or mixed sizes — `check` a directory to confirm |
| Framed shot looks worse than the raw one | The shot is going somewhere that already frames it; use `bare` |

## Sources other than a browser

`frame` takes any PNG or JPEG, so a macOS `⌘⇧4`, a Shottr or CleanShot export, a simulator
recording still, or a Figma export all go through the same pipeline. macOS window captures
already carry a rounded alpha corner and the system's own shadow — capture with
`screencapture -o` to suppress that shadow, then let `frame` supply a consistent one, or the two
shadows will stack.

## Using this outside Claude Code

`scripts/shotkit.mjs` is a plain Node CLI with no dependencies and no knowledge of any agent
harness, so nothing here is tied to one tool. For another agent, either point it at this SKILL.md
or copy the `## The one rule` and `## Quick start` sections into that project's `AGENTS.md`.
