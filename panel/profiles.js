import { S } from './state.js';
import { held, log } from './util.js';
import { readFrame, send, setField } from './protocol.js';
import { BTN_GLYPH, TYPE_DEFS, typeEls } from './types.js';
import { iconEl } from './icons.js';
import { glyphSelect, repaintGlyphSelects } from './glyphselect.js';
import { lzIsDirty, lzV2Load } from './lizard.js';

// ---- Mapping profiles (firmware status v30+: ops 0x2C..0x33, frame 0xB0) ----
// Each emulated type keeps three profiles; one is active. A profile gives every button (a "source") the button it
// acts as (a "target"), plus the two trackpad -> stick settings. This page edits the SELECTED profile, which is
// not necessarily the active one. Older firmware has no profiles: the cards built here stay hidden and the
// per-type controls of panel/types.js keep driving the single mapping through the older fields.
export const PROFILES_MIN_VER = 30;
export const profilesCapable = () => !!(S.dev && S.lastP && S.lastP[0] >= PROFILES_MIN_VER);
// Lizard mode's profiles are type 4 in the same ops. Their bindings go through the lizard ops (panel/lizard.js),
// which edit the profile chosen with op 0x34; the 0xB0 frame for it has no sources.
export const LZ_TYPE = 4;

// The firmware's RemapSource order. own = the target code a source acts as by default (the type's label for it
// names the button); the paddles, QAM and trackpad clicks have names of their own.
const SOURCES = [
  {own:1}, {own:2}, {own:3}, {own:4}, {own:5}, {own:6}, {own:7}, {own:8}, {own:9}, {own:10}, {own:11},
  {own:12}, {own:13}, {own:14}, {own:15},
  {name:"L4", glyph:"L4"}, {name:"R4", glyph:"R4"}, {name:"L5", glyph:"L5"}, {name:"R5", glyph:"R5"},
  {name:"QAM", glyph:"qam"}, {name:"Left trackpad click", glyph:"padClickL"}, {name:"Right trackpad click", glyph:"padClickR"},
  {own:19, suffix:" (full pull)"}, {own:20, suffix:" (full pull)"},
];
const GROUPS = [
  ["Face buttons", [0,1,2,3]], ["Shoulders and triggers", [4,5,22,23]], ["Sticks", [6,7]],
  ["Menu buttons", [8,9,10]], ["D-pad", [11,12,13,14]], ["Back buttons", [15,16,17,18]], ["Quick Access and trackpads", [19,20,21]],
];
// the targets a map can point at beyond the type's own labels: the trackpad clicks (21/22), "none" is 0
const PAD_TARGETS = {21:["Left pad click","padClickL"], 22:["Right pad click","padClickR"]};
// the buttons the profile switch may use: no shortcut or chord uses them (LB, RB, L3, R3, Select-side, Start-side)
const GESTURE_SOURCES = [4,5,6,7,8,9];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const nameOf = (def, i) => { const s = SOURCES[i]; return s.name || (def.labels[s.own] + (s.suffix || "")); };
const glyphOf = (def, i) => { const s = SOURCES[i]; return s.glyph || BTN_GLYPH[def.labels[s.own]]; };
const sel0 = et => (S.profileSel[et] | 0);

function targetOptions(def){
  const opts = [[0, "— none —", null]];
  for(const c of Object.keys(def.labels).map(Number).sort((a, b) => a - b)) opts.push([c, def.labels[c], BTN_GLYPH[def.labels[c]]]);
  for(const c of [21, 22]) opts.push([c, PAD_TARGETS[c][0], PAD_TARGETS[c][1]]);
  return opts;
}
function fillTargets(sel, def){
  sel.textContent = "";
  for(const [v, lbl, glyph] of targetOptions(def)){ const o = document.createElement("option"); o.value = v; o.textContent = lbl; if(glyph) o.dataset.glyph = glyph; sel.appendChild(o); }
}
// a stored code this type has no name for (a reserved or macro code written by newer software) stays visible
function showValue(sel, v){
  let o = [...sel.options].find(x => +x.value === v);
  if(!o){ o = document.createElement("option"); o.value = v; o.textContent = "Other (" + v + ")"; o.dataset.extra = "1"; sel.appendChild(o); }
  sel.value = v;
}
const dropExtras = sel => { for(const o of [...sel.options]) if(o.dataset.extra) o.remove(); };

// ---- the exchange: one op, answered with the type's 0xB0 frame ----
// A frame is [1][type][active][profiles][sources], then each profile's targets and its two pad settings, then
// (when present) the gesture [enabled][prev][next]. The counts come from the frame, so a firmware that grows
// either one still reads.
function applyFrame(p){
  if(p.length < 5 || p[0] !== 1 || p[1] > LZ_TYPE) return false;
  if(p[1] === LZ_TYPE){
    if(!p[3]) return false;
    S.profiles[LZ_TYPE] = {active: p[2], count: p[3]};
    if(p.length >= 8) S.gesture = {enabled: p[5], prev: p[6], next: p[7]};
    if(S.profileSel[LZ_TYPE] === undefined || S.profileSel[LZ_TYPE] >= p[3]) S.profileSel[LZ_TYPE] = p[2];
    renderLizardProfiles(); renderGesture();
    return true;
  }
  const et = p[1], np = p[3], ns = p[4], per = ns + 2;
  if(!np || !ns || p.length < 5 + np * per) return false;
  const maps = [], pads = [];
  for(let i = 0; i < np; i++){ const b = 5 + i * per; maps.push(Array.from(p.slice(b, b + ns))); pads.push([p[b + ns], p[b + ns + 1]]); }
  S.profiles[et] = {active: p[2], maps, pads};
  if(p.length >= 5 + np * per + 3){ const g = 5 + np * per; S.gesture = {enabled: p[g], prev: p[g + 1], next: p[g + 2]}; }
  if(S.profileSel[et] === undefined || S.profileSel[et] >= np) S.profileSel[et] = p[2];
  renderProfiles(et);
  return true;
}
// Send one op and take the frame it answers with. Like a setting write, it waits for the status poll to finish
// and holds the pipe while it talks.
export async function profileOp(bytes){
  if(!profilesCapable()) return false;
  for(let i = 0; i < 60 && (S.inflight || S.rfBusy || S.fieldBusy); i++) await sleep(5);
  S.fieldBusy = true;
  try{
    await send(bytes);
    const p = await readFrame(0xB0, 5, 256);
    return !!p && applyFrame(p);
  }catch(e){ log("profile op err: " + e.message); return false; }
  finally{ S.fieldBusy = false; }
}
export async function profilesLoad(et){
  if(et !== LZ_TYPE) return profileOp([0x2C, et]);
  // the puck keeps the profile its lizard ops edit until it reboots, so a reloaded page says which one it shows
  return await profileOp([0x2C, et]) && profileOp([0x34, sel0(LZ_TYPE)]);
}

// The status blob carries each type's active profile (JS p[209], two bits each). The first blob that shows
// profile support queues every type; after that only a type whose active profile changed on the controller.
export function profilesNoteBlob(p){
  if(!profilesCapable() || p.length <= 209) return;
  for(let et = 0; et < TYPE_DEFS.length; et++){
    const have = S.profiles[et];
    if(!have || have.active !== ((p[209] >> (2 * et)) & 3)) S.profileLoadDue.add(et);
  }
}
// The Lizard profile in use rides the 0xAE frame (byte 47 of its payload), which is read on every poll too.
export function profilesNoteSw(s){
  if(!profilesCapable() || !s || s.length <= 47) return;
  const have = S.profiles[LZ_TYPE];
  if(!have || have.active !== s[47]) S.profileLoadDue.add(LZ_TYPE);
}
export async function profilesDrain(){
  for(const et of [...S.profileLoadDue]){ S.profileLoadDue.delete(et); await profilesLoad(et); }
}

// ---- the UI: three cards per type, built by buildProfileCards (types.js) ----
const recs = []; // by type: {strip, use, copy, copyFrom, reset, nintendo, title, sources[], gesture{...}, cards[]}

export function buildProfileCards(sec, et, def){
  const card = cls => { const c = document.createElement("div"); c.className = "card prof-card " + (cls || ""); sec.appendChild(c); return c; };
  const head = (c, text) => { const h = document.createElement("div"); h.className = "card-head"; const t = document.createElement("h2"); t.textContent = text; h.appendChild(t); c.appendChild(h); return t; };
  const ps = def.key === "DS4" || def.key === "DS5";
  const rec = {sources: [], cards: []};

  // the three profiles: which one is edited, and which one the puck is using
  const cA = card("span hide"); rec.cards.push(cA);
  head(cA, "Mapping profile");
  const strip = document.createElement("div"); strip.className = "slot-tabs prof-strip"; cA.appendChild(strip);
  rec.tabs = [0, 1, 2].map(i => {
    const b = document.createElement("button"); b.className = "slot-tab"; b.dataset.profile = i;
    b.innerHTML = '<span>Profile ' + (i + 1) + '</span><span class="active-dot" style="display:none" title="In use">●</span>';
    b.onclick = () => { S.profileSel[et] = i; renderProfiles(et); };
    strip.appendChild(b); return b;
  });
  const acts = document.createElement("div"); acts.className = "row prof-acts"; cA.appendChild(acts);
  const btn = (txt, title, fn) => { const b = document.createElement("button"); b.textContent = txt; b.title = title; b.onclick = fn; acts.appendChild(b); return b; };
  rec.use = btn("Use this profile", "Make this the profile the controller uses now", () => profileOp([0x30, et, sel0(et)]));
  const copySel = document.createElement("select"); copySel.title = "The profile to copy over this one";
  acts.appendChild(copySel); rec.copyFrom = copySel;
  rec.copy = btn("Copy over this profile", "Replace this profile with a copy of the one chosen on the left", () => {
    const from = +copySel.value, to = sel0(et);
    if(from === to || !confirm("Replace profile " + (to + 1) + " with a copy of profile " + (from + 1) + "?")) return;
    return profileOp([0x32, et, from, to]);
  });
  rec.nintendo = btn(ps ? "Swap Cross/Circle and Square/Triangle" : "Apply Nintendo layout",
    ps ? "Exchange which button acts as Cross and Circle, and as Square and Triangle" : "Exchange A and B, and X and Y",
    () => profileOp([0x2E, et, sel0(et)]));
  rec.reset = btn("Reset this profile", "Put this profile's mapping back to the factory one", () => {
    if(!confirm("Reset profile " + (sel0(et) + 1) + " of the " + def.name + " controller type to its factory mapping?\n\nIts button map and trackpad settings are replaced. The other profiles stay as they are.")) return;
    return profileOp([0x2F, et, sel0(et)]);
  });
  const note = document.createElement("p"); note.className = "note"; note.textContent = "A dot marks the profile in use. Hold the shortcut modifier and press the switch buttons set below on the controller to step through them; it buzzes the profile's number.";
  cA.appendChild(note);

  // every button and what it acts as
  const cB = card("span hide"); rec.cards.push(cB);
  rec.title = head(cB, "Button map");
  const grid = document.createElement("div"); grid.className = "mapsrc"; cB.appendChild(grid);
  for(const [title, ids] of GROUPS){
    const g = document.createElement("div"); g.className = "mapsrc-group";
    const h = document.createElement("h3"); h.textContent = title; g.appendChild(h);
    for(const i of ids){
      const r = document.createElement("div"); r.className = "row"; const l = document.createElement("label");
      const gl = glyphOf(def, i); if(gl) l.append(iconEl(gl), " "); l.append(nameOf(def, i));
      const s = document.createElement("select"); fillTargets(s, def);
      r.append(l, glyphSelect(s)); g.appendChild(r);
      s.addEventListener("change", () => profileOp([0x2D, et, sel0(et), i, +s.value]));
      rec.sources[i] = s;
    }
    grid.appendChild(g);
  }

  // the switch buttons: one setting for the whole puck, shown on every type
  const cC = card("hide"); rec.cards.push(cC);
  head(cC, "Switch profiles from the controller");
  const g = rec.gesture = {};
  const onoff = document.createElement("button"); onoff.textContent = "on";
  const rOn = document.createElement("div"); rOn.className = "row"; const lOn = document.createElement("label"); lOn.textContent = "Profile switch";
  rOn.append(lOn, onoff); cC.appendChild(rOn);
  const mk = text => {
    const s = document.createElement("select");
    for(const i of GESTURE_SOURCES){ const o = document.createElement("option"); o.value = i; o.textContent = nameOf(def, i); const gl = glyphOf(def, i); if(gl) o.dataset.glyph = gl; s.appendChild(o); }
    const r = document.createElement("div"); r.className = "row"; const l = document.createElement("label"); l.textContent = text;
    r.append(l, glyphSelect(s)); cC.appendChild(r); return s;
  };
  g.onoff = onoff; g.prev = mk("Previous profile"); g.next = mk("Next profile");
  const send3 = (en, pv, nx) => profileOp([0x33, et, en, pv, nx]);
  onoff.onclick = () => send3(S.gesture && S.gesture.enabled ? 0 : 1, +g.prev.value, +g.next.value);
  g.prev.addEventListener("change", () => send3(S.gesture && S.gesture.enabled ? 1 : 0, +g.prev.value, +g.next.value));
  g.next.addEventListener("change", () => send3(S.gesture && S.gesture.enabled ? 1 : 0, +g.prev.value, +g.next.value));
  const n2 = document.createElement("p"); n2.className = "note";
  n2.textContent = "Hold the shortcut modifier (set in Mode shortcuts) and press one of these buttons; the controller buzzes the new profile's number. The two buttons are hidden from the game while the modifier is held. This works whether or not the mode shortcuts are on, and applies to every controller type.";
  cC.appendChild(n2);

  recs[et] = rec;
  return rec;
}

// ---- the Lizard tab: a profile strip above its bindings editor ----
let lz = null;
export function buildLizardProfiles(){
  const card = document.getElementById("lizardCard"), editor = document.getElementById("lzEditor");
  const box = document.createElement("div"); box.className = "prof-lz hide";
  const strip = document.createElement("div"); strip.className = "slot-tabs prof-strip"; box.appendChild(strip);
  lz = {box};
  lz.tabs = [0, 1, 2].map(i => {
    const b = document.createElement("button"); b.className = "slot-tab"; b.dataset.profile = i;
    b.innerHTML = '<span>Profile ' + (i + 1) + '</span><span class="active-dot" style="display:none" title="In use">●</span>';
    b.onclick = () => lzOpen(i);
    strip.appendChild(b); return b;
  });
  const acts = document.createElement("div"); acts.className = "row prof-acts"; box.appendChild(acts);
  const btn = (txt, title, fn) => { const b = document.createElement("button"); b.textContent = txt; b.title = title; b.onclick = fn; acts.appendChild(b); return b; };
  lz.use = btn("Use this profile", "Make this the profile Lizard mode uses", () => profileOp([0x30, LZ_TYPE, sel0(LZ_TYPE)]));
  lz.copyFrom = document.createElement("select"); lz.copyFrom.title = "The profile to copy over this one"; acts.appendChild(lz.copyFrom);
  lz.copy = btn("Copy over this profile", "Replace this profile's bindings with a copy of the one chosen on the left", async () => {
    const from = +lz.copyFrom.value, to = sel0(LZ_TYPE);
    if(from === to || !confirm("Replace Lizard profile " + (to + 1) + " with a copy of profile " + (from + 1) + "?" + (lzIsDirty() ? "\n\nYour unsaved changes to it are lost." : ""))) return;
    if(await profileOp([0x32, LZ_TYPE, from, to])) await lzV2Load();
  });
  lz.title = document.createElement("p"); lz.title.className = "note"; box.appendChild(lz.title);
  card.insertBefore(box, editor);
}
// show another profile's bindings: point the puck's lizard editor at it, then read them
async function lzOpen(i){
  if(i === sel0(LZ_TYPE)) return;
  if(lzIsDirty() && !confirm("Discard your unsaved changes to Lizard profile " + (sel0(LZ_TYPE) + 1) + "?")) return;
  const prev = sel0(LZ_TYPE);
  S.profileSel[LZ_TYPE] = i;
  if(await profileOp([0x34, i])) await lzV2Load();
  else { S.profileSel[LZ_TYPE] = prev; renderLizardProfiles(); }
}
export function lizardProfileSel(){ return profilesCapable() && S.profiles[LZ_TYPE] ? sel0(LZ_TYPE) : null; }
function renderLizardProfiles(){
  const st = S.profiles[LZ_TYPE];
  if(!lz || !st) return;
  const sel = sel0(LZ_TYPE);
  lz.tabs.forEach((b, i) => {
    b.classList.toggle("hide", i >= st.count);
    b.classList.toggle("active", i === sel);
    b.querySelector(".active-dot").style.display = i === st.active ? "" : "none";
  });
  lz.use.disabled = sel === st.active;
  if(!held(lz.copyFrom)){
    const keep = +lz.copyFrom.value, from = [...Array(st.count).keys()].filter(i => i !== sel);
    lz.copyFrom.textContent = "";
    for(const i of from){ const o = document.createElement("option"); o.value = i; o.textContent = "Copy from profile " + (i + 1); lz.copyFrom.appendChild(o); }
    if(from.includes(keep)) lz.copyFrom.value = keep;
  }
  lz.title.textContent = "Editing profile " + (sel + 1) + (sel === st.active ? ", the one Lizard mode uses." : ". Lizard mode uses profile " + (st.active + 1) + ".") +
    " Switch between them on the controller with the shortcut modifier and the profile switch buttons (set on any controller type's tab).";
}

// the cards this firmware can use, and the older controls it cannot
export function syncProfileVisibility(){
  const on = profilesCapable();
  if(lz) lz.box.classList.toggle("hide", !on);
  recs.forEach(rec => rec && rec.cards.forEach(c => c.classList.toggle("hide", !on)));
  // its own class, not .hide: the QAM row is also hidden while QAM is the shortcut modifier
  for(const el of document.querySelectorAll(".prof-legacy")) el.classList.toggle("prof-off", on);
}

export function renderProfiles(et){
  const rec = recs[et], st = S.profiles[et];
  if(!rec || !st) return;
  const sel = Math.min(sel0(et), st.maps.length - 1);
  S.profileSel[et] = sel;
  rec.tabs.forEach((b, i) => {
    b.classList.toggle("active", i === sel);
    b.querySelector(".active-dot").style.display = i === st.active ? "" : "none";
  });
  rec.use.disabled = sel === st.active;
  rec.use.classList.toggle("active", false);
  // copy from any profile but the one being edited
  const from = [...Array(st.maps.length).keys()].filter(i => i !== sel);
  if(!held(rec.copyFrom)){
    const keep = +rec.copyFrom.value;
    rec.copyFrom.textContent = "";
    for(const i of from){ const o = document.createElement("option"); o.value = i; o.textContent = "Copy from profile " + (i + 1); rec.copyFrom.appendChild(o); }
    if(from.includes(keep)) rec.copyFrom.value = keep;
  }
  rec.title.textContent = "Button map · profile " + (sel + 1) + (sel === st.active ? " (in use)" : "");
  const map = st.maps[sel];
  rec.sources.forEach((s, i) => {
    if(!s || held(s)) return;
    dropExtras(s);
    if(i < map.length) showValue(s, map[i]);
  });
  // the trackpad -> stick selects of this type's Trackpads card show the selected profile's
  const pads = typeEls[et];
  if(pads && pads.padStick) pads.padStick.forEach((s, pad) => { if(!held(s)) s.value = st.pads[sel][pad]; });
  renderGesture();
}
// the switch buttons are puck-wide: every type's card shows them
function renderGesture(){
  if(S.gesture) recs.forEach(r => {
    if(!r) return;
    const g = r.gesture;
    g.onoff.textContent = S.gesture.enabled ? "on" : "off"; g.onoff.classList.toggle("active", !!S.gesture.enabled);
    if(!held(g.prev)) g.prev.value = S.gesture.prev;
    if(!held(g.next)) g.next.value = S.gesture.next;
  });
  repaintGlyphSelects();
}

// The Trackpads card of a type writes through here, so it follows the profile being edited.
export async function setPadStick(et, pad, value, field){
  if(profilesCapable() && S.profiles[et]) return profileOp([0x31, et, sel0(et), pad, value]);
  return setField(field, value);
}
