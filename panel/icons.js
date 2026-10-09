// Steam Controller input glyphs, drawn in currentColor so they follow the text around them. A glyph stands in for
// the input's name, so its span carries that name as the tooltip and the accessible label.
const LINE = 'fill="none" stroke="currentColor" stroke-width="1.6"';
const svg = (w, h, body) => `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="currentColor" aria-hidden="true">${body}</svg>`;

// upper-left, upper-right, lower-left, lower-right: the L4, R4, L5, R5 order of the firmware's back[] fields
const PADDLE_XY = [[7,5],[23,5],[7,15],[23,15]];
const paddles = on => svg(30, 20, PADDLE_XY.map(([x,y],i) =>
  `<ellipse cx="${x}" cy="${y}" rx="5.4" ry="3.6"${on[i] ? "" : " "+LINE+' opacity=".45"'}/>`).join(""));
const face = l => svg(18, 18, `<circle cx="9" cy="9" r="8" ${LINE}/><text x="9" y="12.6" text-anchor="middle" font-size="10" font-weight="700" font-family="system-ui,sans-serif">${l}</text>`);
const DPAD_ARM = {up:[7,1], down:[7,13], left:[1,7], right:[13,7]};
// a faint cross with the one arm solid: an outline is too thick at label size to tell the arms apart
const dpad = dir => svg(20, 20, `<path d="M7 1h6v6h6v6h-6v6H7v-6H1V7h6z" opacity=".35"/><rect x="${DPAD_ARM[dir][0]}" y="${DPAD_ARM[dir][1]}" width="6" height="6" rx="1"/>`);

const ICONS = {
  qam: ["Quick Access", svg(30, 16, `<rect x="1" y="1" width="28" height="14" rx="7" ${LINE}/><circle cx="9" cy="8" r="1.9"/><circle cx="15" cy="8" r="1.9"/><circle cx="21" cy="8" r="1.9"/>`)],
  back4: ["All four back buttons", paddles([1,1,1,1])],
  L4: ["L4 (back upper-left)", paddles([1,0,0,0])],
  R4: ["R4 (back upper-right)", paddles([0,1,0,0])],
  L5: ["L5 (back lower-left)", paddles([0,0,1,0])],
  R5: ["R5 (back lower-right)", paddles([0,0,0,1])],
  A: ["A", face("A")], B: ["B", face("B")], X: ["X", face("X")], Y: ["Y", face("Y")],
  up: ["D-pad Up", dpad("up")], down: ["D-pad Down", dpad("down")],
  left: ["D-pad Left", dpad("left")], right: ["D-pad Right", dpad("right")],
  // the Select-side button: Back on Xbox, Minus on Switch, Create on PlayStation
  view: ["View (Minus on Switch)", svg(20, 18, `<rect x="6.5" y="1.5" width="12" height="9" rx="2" ${LINE}/><rect x="1.5" y="7" width="12" height="9.5" rx="2"/>`)],
};

// a no-op when the glyph is already there: the status poll refills the modifier ones every 600 ms, and swapping the
// SVG under the pointer would drop its tooltip
export function fillIcon(el, name){
  if(el.dataset.ic === name && el.firstChild) return;
  const [label, art] = ICONS[name];
  el.dataset.ic = name; el.classList.add("ic"); el.setAttribute("role", "img");
  el.setAttribute("aria-label", label); el.title = label; el.innerHTML = art;
}
export function iconEl(name){ const el = document.createElement("span"); fillIcon(el, name); return el; }
// static markup names its glyphs with data-ic
export function initIcons(){ for(const el of document.querySelectorAll("[data-ic]")) fillIcon(el, el.dataset.ic); }
