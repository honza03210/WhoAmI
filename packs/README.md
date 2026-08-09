# Photo packs

A pack is a folder of photos. Drop images in, run `npm run packs`, and you have a board.

```
packs/
  classmates/
    pack.json          optional
    01_Ada.jpg
    02_Bram Smith.png
    ...
```

```bash
npm run packs                # build every pack that changed
npm run packs -- --force     # re-encode everything
npm run packs -- classmates  # build one pack
```

Output goes to `public/packs/` (gitignored — it's generated) and ships as ordinary static
assets: same-origin, so no Discord CSP problems, and Cloudflare doesn't bill static asset
requests.

## Names

The filename becomes the character's name:

| Filename | Name |
|---|---|
| `Ada.jpg` | Ada |
| `01_Ada.jpg` | Ada — a leading `01_`, `01-`, `01.`, or `01 ` orders the board and is stripped |
| `Bram_Smith.png` | Bram Smith — underscores become spaces |
| `Anne-Marie.jpg` | Anne-Marie — hyphens are kept |

Anything the rules get wrong, override in `pack.json`:

```json
{
  "name": "Class of '18",
  "names": {
    "03_weird-filename.jpg": "Zoë O'Brien"
  }
}
```

`name` is the pack's display name (defaults to the folder name). Both fields are optional.

## What the build does

- Applies EXIF orientation, so portrait phone photos don't land sideways
- Crops to square biased toward the busiest region, which for a portrait is the face
- Emits two WebP sizes per character: `<slug>.webp` (256px tile) and `<slug>@full.webp` (512px)
- Writes `manifest.json` per pack and a top-level `index.json`
- Skips re-encoding when outputs are newer than the source, and deletes outputs whose source
  photo is gone

A 24-photo pack lands around 280 KB total, so a full board is a few tens of KB of tiles.

## Sizing

The classic Guess Who board is 24 (4×6) and the build nudges you toward it, but any count of 2
or more works. The UI lays out 4 columns on narrow frames (phones, Discord's picture-in-picture
layout) and 6 when there's room.

## The demo pack

`packs/demo/` holds 24 generated placeholder portraits so the board works before you have real
photos. They vary along the axes the game is actually played on — hair colour and length,
glasses, hats, beards, skin tone, background — so it's genuinely playable.

Regenerate with `npm run demo-pack`. Delete the folder whenever you like; nothing depends on it.
