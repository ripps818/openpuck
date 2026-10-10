// Steam Controller input glyphs, drawn in currentColor so they follow the text around them. A glyph stands in for
// the input's name, so its span carries that name as the tooltip and the accessible label.
const LINE = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
// a bold label centred on (cx, cy); the baseline sits about a third of the size below the centre
const txt = (cx, cy, size, s) => `<text x="${cx}" y="${(cy + size * 0.36).toFixed(1)}" text-anchor="middle" font-size="${size}" font-weight="700" font-family="system-ui,sans-serif">${s}</text>`;
const svg = (w, h, body) => `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="currentColor" aria-hidden="true">${body}</svg>`;

// upper-left, upper-right, lower-left, lower-right: the L4, R4, L5, R5 order of the firmware's back[] fields
const PADDLE_XY = [[7,5],[23,5],[7,15],[23,15]];
const paddles = on => svg(30, 20, PADDLE_XY.map(([x,y],i) =>
  `<ellipse cx="${x}" cy="${y}" rx="5.4" ry="3.6"${on[i] ? "" : " "+LINE+' opacity=".45"'}/>`).join(""));
const face = l => svg(18, 18, `<circle cx="9" cy="9" r="8" ${LINE}/>${txt(9, 9, 10, l)}`);
// PlayStation face buttons: bare symbols, no ring
const PS_FACE = {
  cross: `<path d="M4.6 4.6l8.8 8.8M13.4 4.6l-8.8 8.8" ${LINE} stroke-width="1.9"/>`,
  circle: `<circle cx="9" cy="9" r="5.6" ${LINE} stroke-width="1.9"/>`,
  square: `<rect x="3.8" y="3.8" width="10.4" height="10.4" rx="1.2" ${LINE} stroke-width="1.9"/>`,
  triangle: `<path d="M9 3.2L15.2 14H2.8z" ${LINE} stroke-width="1.9"/>`,
};
const psFace = k => svg(18, 18, PS_FACE[k]);

// shoulder buttons: a flat pill; triggers: a bowl, deeper than the bumper above it
const bumper = t => svg(28, 18, `<rect x="1.5" y="4" width="25" height="10" rx="5" ${LINE}/>${txt(14, 9, t.length > 1 ? 8 : 10, t)}`);
const trigger = t => svg(28, 18, `<path d="M3 3.5Q3 1.5 5 1.5H23Q25 1.5 25 3.5V8Q25 16.5 14 16.5Q3 16.5 3 8Z" ${LINE}/>${txt(14, 8.2, 8, t)}`);
// a stick seen from above; the letter is the side, or with a direction the cap is pushed that way
const stick = l => svg(20, 18, `<circle cx="10" cy="9" r="8.4" ${LINE}/><circle cx="10" cy="9" r="5" ${LINE} opacity=".6"/>${txt(10, 9, 7, l)}`);
const STICK_DIR = {right:[1,0], left:[-1,0], down:[0,1], up:[0,-1]};
const stickDir = dir => svg(20, 18, `<circle cx="10" cy="9" r="8.4" ${LINE}/><circle cx="${10 + STICK_DIR[dir][0] * 4}" cy="${9 + STICK_DIR[dir][1] * 4}" r="3.4"/>`);

// small round buttons, drawn in a ring like the face buttons
const ring = body => svg(20, 18, `<circle cx="10" cy="9" r="8.2" ${LINE}/>${body}`);
const SMALL = {
  menu: ring(`<path d="M6 6.4h8M6 9h8M6 11.6h8" ${LINE} stroke-width="1.5"/>`),
  minus: ring(`<path d="M6 9h8" ${LINE} stroke-width="1.7"/>`),
  plus: ring(`<path d="M6 9h8M10 5v8" ${LINE} stroke-width="1.7"/>`),
  home: ring(`<path d="M5.8 9.4L10 5.6l4.2 3.8M7.2 8.6V13h5.6V8.6" ${LINE} stroke-width="1.4"/>`),
  guide: ring(`<circle cx="10" cy="9" r="3.6"/>`),
  ps: ring(txt(10, 9, 8, "PS")),
  steam: ring(txt(10, 9, 10, "S")),
};
const capture = () => svg(20, 18, `<rect x="2.5" y="2.5" width="15" height="13" rx="3" ${LINE}/><circle cx="10" cy="9" r="3.2" ${LINE}/>`);
const mute = () => svg(20, 18, `<rect x="7.4" y="1.8" width="5.2" height="8" rx="2.6" ${LINE}/><path d="M4.8 8.6a5.2 5.2 0 0 0 10.4 0M10 13.8v2.6" ${LINE}/><path d="M3 2.5L17 15.5" ${LINE} stroke-width="1.8"/>`);

// a rounded square with its top leaning in, like the controller's pads; the letter stays upright to stay legible
const PAD_TILT = 12;
const pad = (l, deg) => svg(20, 20, `<rect x="2.5" y="2.5" width="15" height="15" rx="3.5" transform="rotate(${deg} 10 10)" ${LINE}/>${txt(10, 10, 10, l)}`);
// a pad pressed down: ripples to each side of it, the click you feel. A letter names the pad, a dot is a lone touchpad
const ripples = side => [[3.4, 6, 8, 1.8], [1.4, 4, 12, 2.4]].map(([x, y, h, bulge]) =>
  `<path d="M${side < 0 ? x : 28 - x} ${y}q${side * bulge} ${h / 2} 0 ${h}" ${LINE} stroke-width="1.4"/>`).join("");
const padClick = (l, deg) => svg(28, 20, `<rect x="6.5" y="2.5" width="15" height="15" rx="3.5" transform="rotate(${deg} 14 10)" ${LINE}/>${l ? txt(14, 10, 10, l) : '<circle cx="14" cy="10" r="2.2"/>'}${ripples(-1)}${ripples(1)}`);

const DPAD_ARM = {up:[7,1], down:[7,13], left:[1,7], right:[13,7]};
// a faint cross with the one arm solid: an outline is too thick at label size to tell the arms apart
const dpad = dir => svg(20, 20, `<path d="M7 1h6v6h6v6h-6v6H7v-6H1V7h6z" opacity=".35"/><rect x="${DPAD_ARM[dir][0]}" y="${DPAD_ARM[dir][1]}" width="6" height="6" rx="1"/>`);

// Whole consoles, for the mode in the header. Plain shapes that suggest each family, not the makers' logos.
// The X is cut out of the disc (even-odd) so it needs no mask, which would clash when the same id repeats.
const xCut = (cx, cy, a, b) => "M" + [[b,a],[b,b],[a,b],[a,-b],[b,-b],[b,-a],[-b,-a],[-b,-b],[-a,-b],[-a,b],[-b,b],[-b,a]]
  .map(([x, y]) => `${(cx + (x - y) * Math.SQRT1_2).toFixed(2)} ${(cy + (x + y) * Math.SQRT1_2).toFixed(2)}`).join("L") + "Z";
const SYSTEMS = {
  sysXbox: ["Xbox", svg(20, 20, `<path fill-rule="evenodd" d="M10 1a9 9 0 1 0 0 18a9 9 0 1 0 0-18Z${xCut(10, 10, 5.8, 1.7)}"/>`)],
  // two detached halves with a stick each
  sysSwitch: ["Switch", svg(22, 20, `<rect x="1.2" y="2" width="8.2" height="16" rx="3.6" ${LINE}/><rect x="12.6" y="2" width="8.2" height="16" rx="3.6" ${LINE}/><circle cx="5.3" cy="6.6" r="1.6"/><circle cx="16.7" cy="13.4" r="1.6"/>`)],
  // the face-button diamond: triangle, circle, cross, square
  sysPlayStation: ["PlayStation", svg(20, 20, `<path d="M10 1.6l3 5.2H7z" ${LINE} stroke-width="1.3"/><circle cx="16.4" cy="10" r="2.8" ${LINE} stroke-width="1.3"/><path d="M7.6 14.6l4.8 4.8M12.4 14.6l-4.8 4.8" ${LINE} stroke-width="1.3"/><rect x="1.2" y="7.4" width="5.6" height="5.6" rx=".6" ${LINE} stroke-width="1.3"/>`)],
  // a body with the two trackpads
  sysSteam: ["Steam Controller", svg(26, 18, `<rect x="1" y="2.5" width="24" height="13" rx="6.5" ${LINE}/><circle cx="8.4" cy="9" r="3.2" ${LINE}/><circle cx="17.6" cy="9" r="3.2" ${LINE}/>`)],
  sysLizard: ["Desktop (mouse and keyboard)", svg(16, 20, `<rect x="2" y="1.5" width="12" height="17" rx="6" ${LINE}/><path d="M8 1.5v6.5M2 8h12" ${LINE}/>`)],
  // d-pad on the left, two buttons on the right
  sysGamepad: ["Gamepad", svg(26, 18, `<rect x="1" y="2.5" width="24" height="13" rx="6.5" ${LINE}/><path d="M6.4 6.6v4.8M4 9h4.8" ${LINE}/><circle cx="17" cy="10.4" r="1.4"/><circle cx="20.6" cy="7.8" r="1.4"/>`)],
};

const ICONS = {
  qam: ["Quick Access", svg(30, 16, `<rect x="1" y="1" width="28" height="14" rx="7" ${LINE}/><circle cx="9" cy="8" r="1.9"/><circle cx="15" cy="8" r="1.9"/><circle cx="21" cy="8" r="1.9"/>`)],
  back4: ["All four back buttons", paddles([1,1,1,1])],
  L4: ["L4 (back upper-left)", paddles([1,0,0,0])],
  R4: ["R4 (back upper-right)", paddles([0,1,0,0])],
  L5: ["L5 (back lower-left)", paddles([0,0,1,0])],
  R5: ["R5 (back lower-right)", paddles([0,0,0,1])],
  A: ["A", face("A")], B: ["B", face("B")], X: ["X", face("X")], Y: ["Y", face("Y")],
  cross: ["Cross", psFace("cross")], circle: ["Circle", psFace("circle")], square: ["Square", psFace("square")], triangle: ["Triangle", psFace("triangle")],
  LB: ["LB (left bumper)", bumper("LB")], RB: ["RB (right bumper)", bumper("RB")],
  L1: ["L1 (left bumper)", bumper("L1")], R1: ["R1 (right bumper)", bumper("R1")],
  swL: ["L (left shoulder)", bumper("L")], swR: ["R (right shoulder)", bumper("R")],
  LT: ["LT (left trigger)", trigger("LT")], RT: ["RT (right trigger)", trigger("RT")],
  L2: ["L2 (left trigger)", trigger("L2")], R2: ["R2 (right trigger)", trigger("R2")],
  ZL: ["ZL (left trigger)", trigger("ZL")], ZR: ["ZR (right trigger)", trigger("ZR")],
  L3: ["L3 (left stick click)", stick("L")], R3: ["R3 (right stick click)", stick("R")],
  stickL: ["Left stick", stick("L")], stickR: ["Right stick", stick("R")],
  lsRight: ["Left stick right", stickDir("right")], lsLeft: ["Left stick left", stickDir("left")],
  lsDown: ["Left stick down", stickDir("down")], lsUp: ["Left stick up", stickDir("up")],
  rsRight: ["Right stick right", stickDir("right")], rsLeft: ["Right stick left", stickDir("left")],
  rsDown: ["Right stick down", stickDir("down")], rsUp: ["Right stick up", stickDir("up")],
  up: ["D-pad Up", dpad("up")], down: ["D-pad Down", dpad("down")],
  left: ["D-pad Left", dpad("left")], right: ["D-pad Right", dpad("right")],
  menu: ["Menu (Start on Xbox, Options on PlayStation)", SMALL.menu],
  minus: ["Minus", SMALL.minus], plus: ["Plus", SMALL.plus], home: ["Home", SMALL.home],
  guide: ["Guide", SMALL.guide], ps: ["PS", SMALL.ps], steam: ["Steam", SMALL.steam],
  capture: ["Capture", capture()], mute: ["Mute", mute()],
  padL: ["Left trackpad", pad("L", PAD_TILT)], padR: ["Right trackpad", pad("R", -PAD_TILT)],
  padClick: ["Touchpad click", padClick("", 0)],
  padClickL: ["Left trackpad click", padClick("L", PAD_TILT)], padClickR: ["Right trackpad click", padClick("R", -PAD_TILT)],
  // the Select-side button: Back on Xbox, Minus on Switch, Create on PlayStation. Minus has its own ring glyph for the
  // Switch profile's lists, where it sits beside Plus.
  view: ["View (Back on Xbox, Minus on Switch, Create on PlayStation)", svg(20, 18, `<rect x="6.5" y="1.5" width="12" height="9" rx="2" ${LINE}/><rect x="1.5" y="7" width="12" height="9.5" rx="2"/>`)],
  ...SYSTEMS,
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
