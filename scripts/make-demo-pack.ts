/**
 * Generates a placeholder pack so the board is playable before you have real photos.
 *
 *   npm run demo-pack     writes 24 portraits into packs/demo/
 *
 * The faces vary along the axes Guess Who is actually played on — hair colour and length,
 * glasses, hats, beards — so the demo board supports real questions. Replace packs/demo with
 * photos of your friends when you have them; nothing depends on this script existing.
 *
 * Output is deliberately portrait (not square) so `npm run packs` exercises its cropping.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const OUTPUT_DIR = path.join('packs', 'demo');
const WIDTH = 720;
const HEIGHT = 900;

const NAMES = [
  'Ada', 'Bram', 'Cleo', 'Dev', 'Elif', 'Fionn', 'Greta', 'Hugo',
  'Ines', 'Jonas', 'Kira', 'Liam', 'Mira', 'Nils', 'Otto', 'Pia',
  'Quinn', 'Rosa', 'Sami', 'Tove', 'Umut', 'Vera', 'Wren', 'Yuki',
];

const SKIN_TONES = ['#f4d5b5', '#e8bd93', '#cd9a6e', '#a9714a', '#7a4c30', '#54331f'];
const HAIR_COLOURS = ['#2a1b12', '#6f4520', '#c9a227', '#b34a2c', '#8e8e93', '#2f2f5c'];
const BACKGROUNDS = ['#3b5b6d', '#4a4066', '#6d4a4a', '#3f6350', '#6b5a37', '#4c4c58', '#5c3f5e'];

/** FNV-1a. Deterministic, and unlike `index * stride` it can't collapse when the stride and the
 *  list length share a factor — which silently made every face the same colour. */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(values: readonly T[], seed: string): T {
  // Non-null: the modulo keeps the index in range.
  return values[hash(seed) % values.length]!;
}

/** Seeded coin flip; `percent` is the chance of true. */
function chance(seed: string, percent: number): boolean {
  return hash(seed) % 100 < percent;
}

function portrait(name: string, _index: number): string {
  const skin = pick(SKIN_TONES, `${name}:skin`);
  const hair = pick(HAIR_COLOURS, `${name}:hair`);
  const background = pick(BACKGROUNDS, `${name}:bg`);

  const hasGlasses = chance(`${name}:glasses`, 40);
  const hasHat = chance(`${name}:hat`, 30);
  const hasBeard = chance(`${name}:beard`, 35);
  const hasLongHair = chance(`${name}:longhair`, 50);

  const centreX = WIDTH / 2;
  const headY = 400;
  const headRadiusX = 165;
  const headRadiusY = 195;

  const parts: string[] = [
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${background}"/>`,
    // Shoulders
    `<ellipse cx="${centreX}" cy="${HEIGHT + 40}" rx="330" ry="300" fill="#2b2d31"/>`,
    // Neck
    `<rect x="${centreX - 55}" y="${headY + 120}" width="110" height="150" rx="46" fill="${skin}"/>`,
  ];

  if (hasLongHair) {
    parts.push(
      `<ellipse cx="${centreX}" cy="${headY + 60}" rx="${headRadiusX + 34}" ry="${headRadiusY + 40}" fill="${hair}"/>`,
    );
  }

  parts.push(`<ellipse cx="${centreX}" cy="${headY}" rx="${headRadiusX}" ry="${headRadiusY}" fill="${skin}"/>`);

  // Hair on top, drawn as a clipped cap so it sits on the skull rather than floating.
  parts.push(
    `<path d="M ${centreX - headRadiusX} ${headY - 20}
        a ${headRadiusX} ${headRadiusY} 0 0 1 ${headRadiusX * 2} 0
        l 0 -30
        a ${headRadiusX} ${headRadiusY} 0 0 0 ${-headRadiusX * 2} 0 Z" fill="${hair}"/>`,
    `<ellipse cx="${centreX}" cy="${headY - 105}" rx="${headRadiusX - 4}" ry="105" fill="${hair}"/>`,
  );

  if (hasHat) {
    parts.push(
      `<rect x="${centreX - 210}" y="${headY - 190}" width="420" height="30" rx="15" fill="#22242a"/>`,
      `<rect x="${centreX - 120}" y="${headY - 320}" width="240" height="140" rx="18" fill="#22242a"/>`,
    );
  }

  // Eyes
  const eyeY = headY - 10;
  for (const eyeX of [centreX - 62, centreX + 62]) {
    parts.push(
      `<ellipse cx="${eyeX}" cy="${eyeY}" rx="26" ry="18" fill="#ffffff"/>`,
      `<circle cx="${eyeX}" cy="${eyeY}" r="10" fill="#2b1b12"/>`,
      `<path d="M ${eyeX - 30} ${eyeY - 34} q 30 -16 60 0" stroke="${hair}" stroke-width="9" fill="none" stroke-linecap="round"/>`,
    );
  }

  if (hasGlasses) {
    parts.push(
      `<g stroke="#1c1d20" stroke-width="8" fill="none">
         <circle cx="${centreX - 62}" cy="${eyeY}" r="42"/>
         <circle cx="${centreX + 62}" cy="${eyeY}" r="42"/>
         <path d="M ${centreX - 20} ${eyeY} h 40"/>
       </g>`,
    );
  }

  // Nose and mouth
  parts.push(
    `<path d="M ${centreX} ${eyeY + 20} q -14 46 8 52" stroke="rgba(0,0,0,0.28)" stroke-width="8" fill="none" stroke-linecap="round"/>`,
  );

  if (hasBeard) {
    parts.push(
      `<path d="M ${centreX - 118} ${headY + 40} q 118 170 236 0 q -20 150 -118 150 q -98 0 -118 -150 Z" fill="${hair}"/>`,
    );
    parts.push(`<path d="M ${centreX - 34} ${headY + 118} q 34 22 68 0" stroke="#6b3a3a" stroke-width="10" fill="none" stroke-linecap="round"/>`);
  } else {
    parts.push(
      `<path d="M ${centreX - 44} ${headY + 108} q 44 40 88 0" stroke="#7d3f3f" stroke-width="11" fill="none" stroke-linecap="round"/>`,
    );
  }

  // No name burned into the image: the square crop would slice it off, and the board renders
  // names from the manifest anyway.

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${parts.join('')}</svg>`;
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const [index, name] of NAMES.entries()) {
    // The numeric prefix both fixes board order and exercises the build script's
    // ordering-prefix stripping.
    const fileName = `${String(index + 1).padStart(2, '0')}_${name}.png`;
    await sharp(Buffer.from(portrait(name, index)))
      .png({ compressionLevel: 9 })
      .toFile(path.join(OUTPUT_DIR, fileName));
  }

  await writeFile(
    path.join(OUTPUT_DIR, 'pack.json'),
    `${JSON.stringify({ name: 'Demo Faces' }, null, 2)}\n`,
  );

  console.log(`Wrote ${NAMES.length} placeholder portraits to ${OUTPUT_DIR}/`);
  console.log('Next: npm run packs');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
