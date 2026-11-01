# OpenPortrait logo

The mark is one stroke and one ring that read as both **O** and **P**. The ring is also a lens, with a vermilion dot at its center.

## Files

| File | Use |
|---|---|
| `openportrait-logo.svg` / `-dark.svg` | Horizontal logo for light or dark backgrounds (site header, README) |
| `openportrait-logo-stacked.svg` / `-dark.svg` | Stacked logo (splash, login screen, social) |
| `openportrait-logo@2x.png` / `-dark@2x.png` | Raster logo where SVG isn't accepted |
| `openportrait-mark.svg` / `-dark.svg` | Mark alone, no tile |
| `openportrait-mark-mono-black.svg` / `-white.svg` | One-color mark (print, embossing, watermarks) |
| `openportrait-icon.svg` | App icon, 64px and up |
| `openportrait-icon-512.png` / `-256.png` | Unraid app icon, Docker Hub, GitHub social preview |
| `openportrait-icon-small.svg` / `favicon.svg` | Heavier icon drawn for 16–48px |
| `favicon.ico` | 16, 32, 48px |
| `apple-touch-icon.png` (180, full bleed) / `icon-192.png` | iOS home screen, PWA manifest |

The wordmark is converted to outlines, so no fonts are needed.

## Colors

| Token | Light | Dark |
|---|---|---|
| Ink | `#171613` | `#f1ebe0` |
| Paper | `#f3eee5` | `#151412` |
| Lens (accent) | `#c2461f` | `#e46a40` |

The app icon tile is always Ink `#171613` with a Paper mark and the `#e46a40` lens.

## Type

Wordmark: Hanken Grotesk SemiBold, tracking −22. The website pairs it with Instrument Serif for headlines.

## Rules

- Clear space around the logo: at least the diameter of the lens ring's hole.
- Smallest size: logo 120px wide, mark 16px (use the small icon below 48px).
- Don't recolor the lens, outline the mark, add effects, or set the wordmark in another font.

## HTML head

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```
