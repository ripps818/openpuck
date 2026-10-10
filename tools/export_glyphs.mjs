// Writes the panel's glyphs to docs/glyphs/*.svg for the README. GitHub strips inline <svg> and an <img>-embedded SVG
// has no text colour to inherit, so currentColor is baked to a grey that reads on both light and dark themes.
import { mkdirSync, writeFileSync } from "node:fs";
import { ICONS } from "../panel/icons.js";

const OUT = new URL("../docs/glyphs/", import.meta.url);
const GREY = "#8b949e";
const NAMES = [
  "qam", "back4", "L4", "R4", "L5", "R5", "A", "B", "X", "Y",
  "up", "down", "left", "right", "padClick", "padClickL", "padClickR",
  "steam", "LB", "RB", "LT", "RT", "L3", "R3", "menu", "view",
];

mkdirSync(OUT, { recursive: true });
for (const name of NAMES) {
  const art = ICONS[name][1].replaceAll("currentColor", GREY)
    .replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
  writeFileSync(new URL(`${name}.svg`, OUT), art + "\n");
}
console.log(`wrote ${NAMES.length} glyphs to docs/glyphs/`);
