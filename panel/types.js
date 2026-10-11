import { S } from './state.js';
import { $, log } from './util.js';
import { setField } from './protocol.js';
import { MODE_NAMES, MODE_ORDER } from './status.js';
import { openNav } from './nav.js';
import { iconEl } from './icons.js';
import { glyphSelect } from './glyphselect.js';
import { buildProfileCards, profileOp, profilesCapable, setPadStick } from './profiles.js';

// Per-emulated-type config (must match firmware ET_* order: Xbox=0, Switch=1, DS4=2, DS5=3). Each type lists
// only the remap targets that exist on that controller. Field id sent to firmware = 40 + et*9 + k
// (k: 0..3 back paddles, 4 QAM, 5 A/B-swap, 6 trackpad-haptics, 7 LED brightness, 8 rumble). Blob v17 reads them back at p[73 + et*9 + ...].
const DPAD = {12:"D-pad Up",13:"D-pad Down",14:"D-pad Left",15:"D-pad Right"};
// each label's glyph, shown beside the name in the remap lists (panel/icons.js)
export const BTN_GLYPH = {
  A:"A", B:"B", X:"X", Y:"Y", LB:"LB", RB:"RB", L3:"L3", R3:"R3", Back:"view", Start:"menu", Guide:"guide", LT:"LT", RT:"RT",
  "D-pad Up":"up", "D-pad Down":"down", "D-pad Left":"left", "D-pad Right":"right",
  L:"swL", R:"swR", "L-Stick":"L3", "R-Stick":"R3", Minus:"minus", Plus:"plus", Home:"home", ZL:"ZL", ZR:"ZR", "Capture / Screenshot":"capture",
  Cross:"cross", Circle:"circle", Square:"square", Triangle:"triangle", L1:"L1", R1:"R1", Create:"view", Options:"menu", PS:"ps", L2:"L2", R2:"R2",
  "Touchpad Click":"padClick", Mute:"mute",
};
export const TYPE_DEFS = [
  {key:"XBOX", name:"Xbox", labels:{1:"A",2:"B",3:"X",4:"Y",5:"LB",6:"RB",7:"L3",8:"R3",9:"Back",10:"Start",11:"Guide",19:"LT",20:"RT",...DPAD}},
  {key:"SWITCH", name:"Switch", labels:{1:"A",2:"B",3:"X",4:"Y",5:"L",6:"R",7:"L-Stick",8:"R-Stick",9:"Minus",10:"Plus",11:"Home",19:"ZL",20:"ZR",...DPAD,18:"Capture / Screenshot"}},
  {key:"DS4", name:"DS4", labels:{1:"Cross",2:"Circle",3:"Square",4:"Triangle",5:"L1",6:"R1",7:"L3",8:"R3",9:"Create",10:"Options",11:"PS",19:"L2",20:"R2",...DPAD,16:"Touchpad Click"}},
  {key:"DS5", name:"DS5", labels:{1:"Cross",2:"Circle",3:"Square",4:"Triangle",5:"L1",6:"R1",7:"L3",8:"R3",9:"Create",10:"Options",11:"PS",19:"L2",20:"R2",...DPAD,16:"Touchpad Click",17:"Mute"}},
];
// Which emulated type a USB mode belongs to (mirror of firmware etypeForMode); -1 = puck mode (no type).
export function etypeForMode(m){ switch(m){case 1:case 10:return 0; case 2:case 4:return 1; case 6:case 8:case 9:return 2; case 5:case 7:return 3; default:return -1;} }
// the firmware's back[] order; each label is the paddle glyph (full name on hover) plus its short name
const BACK_KEYS = ["L4","R4","L5","R5"];
export const typeEls = []; // one entry per TYPE_DEFS: {sec, tab, activeDot, back[], qam, abSwap, pad, led, ledV, rumble, padStick[]}
// Trackpad -> joystick mapping (firmware PS_OFF/PS_LEFT/PS_RIGHT). Field id = PAD_STICK_FIELD0 + et*2 + pad
// (pad 0 = left trackpad, 1 = right). While mapped and touched the pad drives that stick; on release the
// stick re-centers, and an untouched mapped pad leaves the physical stick in control.
export const PAD_STICK_FIELD0 = 80;
const PAD_STICK_OPTS = [[0,"Off (touchpad)"],[1,"Left stick","stickL"],[2,"Right stick","stickR"]];
function mkSelect(def, includeNone){
  const sel=document.createElement("select");
  if(includeNone){ const o=document.createElement("option"); o.value=0; o.textContent="— none —"; sel.appendChild(o); }
  else { const o=document.createElement("option"); o.value=0; o.textContent="Default (per-mode)"; sel.appendChild(o); }
  for(const c of Object.keys(def.labels).map(Number).sort((a,b)=>a-b)){
    const o=document.createElement("option"); o.value=c; o.textContent=def.labels[c];
    if(BTN_GLYPH[def.labels[c]]) o.dataset.glyph=BTN_GLYPH[def.labels[c]];
    sel.appendChild(o); }
  return sel;
}
// s = 0xAE frame payload: [ver][37 unused][swDpadHaptics][storageState][hdPadScale/2][4 unused]
// [swQamSelect][shortcutFlags][8 unused]
export function swStatusApply(s){
  const capable=!!s;
  $("#swClickControls").classList.toggle("hide",!capable);
  $("#swBonds").textContent=S.lastP && S.lastP.length>60?S.lastP[60]:"—";
  $("#swStorage").textContent=capable?(["Unavailable","Ready","Initialized","Save failed"][s[39]]||"Unknown"):"Not reported";
  const storageBad=capable && (s[39]===0 || s[39]===3);
  $("#swStorageWarning").classList.toggle("hide",!storageBad);
  $("#swStorageWarning").textContent=storageBad?"Saved storage needs attention. Export a backup of your current setup. Failed saves retain the previous saved files; automatic erasing is disabled for nonblank storage.":"";
  if(capable && document.activeElement!==$("#swClickFeedback")) $("#swClickFeedback").value=s[38];
}

// Button mapping tabs: 0..3 = TYPE_DEFS profiles, LIZARD_TAB = the lizard (desktop) binding map
export const LIZARD_TAB = 4;
let curTab=0;
export function setTab(et){
  curTab=et;
  typeEls.forEach((rec,i)=>{ rec.sec.style.display = (i===et) ? "" : "none"; rec.tab.classList.toggle("active", i===et); });
  $("#mapTabLizard").classList.toggle("active", et===LIZARD_TAB);
  $("#mapTypesPane").classList.toggle("hide", et===LIZARD_TAB);
  $("#mapLizardPane").classList.toggle("hide", et!==LIZARD_TAB);
  // the trackpad mouse card is one setting shared by the Xbox and Lizard profiles: show it in whichever is open
  if(et===0) typeEls[0].sec.appendChild($("#mouseCard"));
  else if(et===LIZARD_TAB) $("#mapLizardPane").appendChild($("#mouseCard"));
  if(et===LIZARD_TAB) return;
  $("#mapTypeName").textContent="· "+TYPE_DEFS[et].name;
  $("#mapUsedBy").textContent="Used by "+MODE_NAMES.filter((n,m)=>etypeForMode(m)===et).join(", ")+".";
}
export function currentType(){ return curTab; }

// Factory values for what one profile's tab shows: the firmware's g_type[] initialisers plus the globals behind
// the DualSense and Switch Pro cards. [field, value, minimum protocol version]. The Trackpad mouse card is shared
// with the Lizard profile, so it is left alone.
function typeResetFields(et){
  const key=TYPE_DEFS[et].key, sw=key==="SWITCH", ds5=key==="DS5", b=40+et*9;
  const f=[[b,5,0],[b+1,6,0],[b+2,7,0],[b+3,8,0],[b+4,sw?18:0,0],[b+5,sw?1:0,0],[b+6,sw?0:1,0],[b+7,0,0],[b+8,1,0],
    [PAD_STICK_FIELD0+et*2,0,20],[PAD_STICK_FIELD0+et*2+1,0,20],[108+et,100,25]];
  if(sw||ds5) f.push([115,70,27]);
  if(ds5) f.push([31,1,0],[88,3,22],[30,0,0],[114,0,26],[116,0,29]);
  if(sw){
    f.push([38,0,19]);
    // the 0xAE frame is absent on firmware that predates these controls
    if(S.lastSw) f.push([230,1,0],[231,50,0],[239,18,0]);
  }
  return f;
}
let mapResetBusy=false;
export async function resetTypeDefaults(et){
  if(!S.dev||mapResetBusy) return;
  const name=TYPE_DEFS[et].name, key=TYPE_DEFS[et].key;
  const prof=profilesCapable();
  const shared=key==="XBOX" ? "\n\nThe Trackpad mouse settings are shared with Lizard mode and stay as they are."
    : (key==="SWITCH"||key==="DS5") ? "\n\nThe grip limiter is one setting shared by the Switch and DS5 controller types, so it resets for both." : "";
  const what=prof ? "All three mapping profiles, and the trackpad, rumble and light settings" : "The button mapping, trackpad, rumble and light settings";
  if(!confirm("Reset the "+name+" controller type to its defaults?\n\n"+what+" go back to their factory values, and profile 1 is put in use. This saves to the puck immediately; your current choices for this controller type are lost."+shared)) return;
  mapResetBusy=true; $("#mapReset").disabled=true;
  try{
    const ver=S.lastP?S.lastP[0]:0;
    // with profiles, the mapping and trackpad -> stick fields only reach the active profile: reset every profile instead
    const b=40+et*9, mapped=new Set([b,b+1,b+2,b+3,b+4,b+5,PAD_STICK_FIELD0+et*2,PAD_STICK_FIELD0+et*2+1]);
    const fields=typeResetFields(et).filter(([field,,min])=>ver>=min && !(prof && mapped.has(field)));
    if(prof){
      for(let i=0;i<3;i++) await profileOp([0x2F,et,i]);
      await profileOp([0x30,et,0]);
      S.profileSel[et]=0;
    }
    for(const [field,value] of fields) await setField(field,value);
    log(name+" controller type reset to defaults ("+fields.length+" settings"+(prof?", 3 profiles":"")+")");
  }finally{ mapResetBusy=false; $("#mapReset").disabled=false; }
}
// Strength is sent as percent/2 (field 22), so every value here must be even.
export const RUMBLE_SCALES=Array.from({length:246},(_,i)=>10+i*2);
const HD_PAD_SCALES=Array.from({length:251},(_,i)=>i*2);

export function initTypes(){
  for(const o of mkSelect(TYPE_DEFS[1],true).options){const c=o.cloneNode(true);if(+c.value===18)c.textContent="Take screenshot";$("#qamSelect").appendChild(c);}
  glyphSelect($("#qamSelect"));
  $("#swClickFeedback").onchange=()=>setField(230,+$("#swClickFeedback").value);
  (function buildTypeCfgs(){
    const host=document.getElementById("typeCfgs"), tabs=document.getElementById("mapTabs");
    // one tab per controller type; the dot marks the type of the current mode
    const mkTab=(name,et)=>{
      const tab=document.createElement("button"); tab.className="slot-tab"; tab.dataset.page="pgMap"; tab.dataset.type=et;
      tab.innerHTML='<span>'+name+'</span><span class="active-dot" style="display:none" title="Controller type of the current mode">●</span>';
      tab.onclick=()=>openNav(tab); tabs.appendChild(tab); return tab;
    };
    TYPE_DEFS.forEach((def,et)=>{
      const tab=mkTab(def.name,et);
      // the type's page is a grid of small cards, one per area of the controller
      const sec=document.createElement("div"); sec.className="mapgrid"; sec.style.display="none";
      const rec={sec,tab,activeDot:tab.querySelector(".active-dot"),back:[],qam:null,abSwap:null,pad:null,led:null,ledV:null,rumble:null,audioHaptics:null,audioStyle:null,audioGain:null,audioGainV:null,padStick:[]};
      // firmware with mapping profiles (status v30+) shows these first and hides the single-mapping controls below
      rec.prof=buildProfileCards(sec,et,def);
      const group=title=>{ const g=document.createElement("div"); g.className="card"; const h=document.createElement("h2"); h.textContent=title; g.appendChild(h); sec.appendChild(g); return g; };
      const row=(g,label,...els)=>{ const r=document.createElement("div"); r.className="row"; const l=document.createElement("label"); l.textContent=label; r.append(l,...els); g.appendChild(r); return r; };
      const toggle=(g,label,txt)=>{ const b=document.createElement("button"); b.textContent=txt; row(g,label,b); return b; };
      // a toggle's label made of glyphs and words, like the back-button labels
      const plus=()=>{ const s=document.createElement("span"); s.className="ic-plus"; s.textContent="+"; return s; };
      const relabel=(btn,...parts)=>{ const l=btn.parentElement.querySelector("label"); l.textContent=""; l.append(...parts); };

      // back paddles
      const gBack=group("Back buttons"); gBack.classList.add("prof-legacy");
      for(let i=0;i<4;i++){
        const sel=mkSelect(def,true); row(gBack,"",glyphSelect(sel)).querySelector("label").append(iconEl(BACK_KEYS[i])," "+BACK_KEYS[i]);
        sel.addEventListener("change",()=>setField(40+et*9+i, +sel.value));
        rec.back.push(sel);
      }
      // QAM + A/B swap
      const gBtn=group("Buttons");
      { const sel=mkSelect(def,false); row(gBtn,"",glyphSelect(sel)).classList.add("prof-legacy"); const lab=sel.closest(".row").querySelector("label"); lab.append(iconEl("qam")," QAM");
        sel.addEventListener("change",()=>setField(40+et*9+4, +sel.value));
        rec.qam=sel; }
      const ab=toggle(gBtn,"","off"); ab.parentElement.classList.add("prof-legacy");
      // only the DS5 has more in this card (Create = touchpad click); elsewhere the profiles replace all of it
      if(def.key!=="DS5") gBtn.classList.add("prof-legacy");
      relabel(ab,iconEl("A"),iconEl("B"),plus(),iconEl("X"),iconEl("Y")," swap");
      // trackpad -> joystick mapping (one select per pad) + trackpad haptics
      const gPad=group("Trackpads");
      for(let pad=0; pad<2; pad++){
        const sel=document.createElement("select");
        for(const [v,lbl,glyph] of (et===1 ? [...PAD_STICK_OPTS,[3,"D-pad on touch (Switch Pro)"],[4,"D-pad on click (Switch Pro)"]] : PAD_STICK_OPTS)){ const o=document.createElement("option"); o.value=v; o.textContent=lbl; o.dataset.glyph=glyph||(v===4?(pad?"padClickR":"padClickL"):(pad?"padR":"padL")); sel.appendChild(o); }
        row(gPad,"",glyphSelect(sel)).querySelector("label").append(iconEl(pad?"padR":"padL")," Trackpad");
        sel.addEventListener("change",()=>setPadStick(et,pad,+sel.value,PAD_STICK_FIELD0+et*2+pad));
        rec.padStick.push(sel);
      }
      // 1 = controller's own haptics (ticks while moving + clicks), 2 = clicks only, 0 = off
      const pad=document.createElement("select");
      for(const [v,lbl] of [[1,"On"],[2,"Clicks only"],[0,"Off"]]){ const o=document.createElement("option"); o.value=v; o.textContent=lbl; pad.appendChild(o); }
      row(gPad,"Trackpad haptics",pad);
      pad.addEventListener("change",()=>setField(40+et*9+6, +pad.value));
      // rumble on/off, grip strength, grip limiter
      const gRum=group("Rumble");
      const rumble=toggle(gRum,"Rumble","on");
      // Grip rumble strength, per type (protocol v25). The rumble style follows the mode.
      { const sel=document.createElement("select");
        for(const v of RUMBLE_SCALES){ const o=document.createElement("option"); o.value=v; o.textContent=v+"%"+(v===200?" (default)":""); sel.appendChild(o); }
        row(gRum,"Grip rumble strength",sel).classList.add("hide");
        sel.addEventListener("change",()=>setField(108+et, (+sel.value)/2));
        rec.rumbleScl=sel; }
      // Grip limiter (protocol v27): one setting, shared by DualSense wave haptics/speaker and Switch HD rumble grips
      if(def.key==="DS5"||def.key==="SWITCH"){
        const sel=document.createElement("select");
        for(const v of [50,60,70,80,90,100]){ const o=document.createElement("option"); o.value=v; o.textContent=v===100?"Off (hard clip)":v+"%"+(v===70?" (default)":""); sel.appendChild(o); }
        sel.addEventListener("change",()=>setField(115,+sel.value));
        const note=document.createElement("p"); note.className="note";
        note.textContent="Grip vibration above this level is rounded off toward full strength instead of clipping, which plays as a pop. Lower is smoother on the strongest hits, higher keeps more of their punch. One setting for DualSense audio haptics and Switch HD rumble.";
        const wrap=document.createElement("div"); wrap.className="hide"; wrap.append(row(gRum,"Grip limiter",sel),note); gRum.appendChild(wrap);
        rec.limiter=sel; rec.limiterWrap=wrap;
      }
      // LED brightness
      { const gLed=group("Lights");
        const sl=document.createElement("input"); sl.type="range"; sl.min=0; sl.max=100; sl.step=5;
        const vspan=document.createElement("span"); vspan.className="val";
        row(gLed,"LED brightness",sl,vspan);
        function fmtLed(v){ return (+v===0)?"Auto":v+"%"; }
        sl.addEventListener("input",()=>{ vspan.textContent=fmtLed(sl.value); });
        sl.addEventListener("change",()=>setField(40+et*9+7, +sl.value));
        rec.led=sl; rec.ledV=vspan; }
      if(def.key==="DS5"){
        const gAud=group("Audio haptics");
        const aud=toggle(gAud,"Audio Haptics","on");
        rec.audioHaptics=aud;
        aud.onclick=()=>{ const on=aud.classList.contains("active"); setField(31, on?0:1); };
        // Haptics style (protocol v22): 0 rumble = the motor-style rumble, 1 tone = smooth per-actuator tones,
        // 2 split = below ~80 Hz as rumble, the rest as tones, 3 wave = the haptic channels streamed as PCM (default).
        const sty=document.createElement("select");
        for(const [v,lbl] of [[3,"Wave"],[1,"Tone"],[2,"Split"],[0,"Rumble"]]){ const o=document.createElement("option"); o.value=v; o.textContent=lbl; sty.appendChild(o); }
        row(gAud,"Haptics style",sty);
        sty.addEventListener("change",()=>setField(88, +sty.value));
        rec.audioStyle=sty;
        // Create button presses the touchpad click instead (protocol v29)
        const ct=toggle(gBtn,"","off");
        relabel(ct,iconEl("view")," Create = ",iconEl("padClick")," touchpad click");
        rec.createTouch=ct;
        ct.onclick=()=>setField(116, ct.classList.contains("active")?0:1);
        // Audio Haptics gain
        // 0 = Auto (firmware default): the loudest recent haptic plays at full strength; in Wave style Auto = 100%, a real DualSense's strength
        const sl=document.createElement("input"); sl.type="range"; sl.min=0; sl.max=500; sl.step=10;
        const vspan=document.createElement("span"); vspan.className="val";
        row(gAud,"Audio Haptics Gain",sl,vspan);
        sl.value=0; vspan.textContent="Auto";
        sl.addEventListener("input",()=>{ vspan.textContent=(+sl.value===0)?"Auto":sl.value+"%"; });
        sl.addEventListener("change",()=>setField(30, (+sl.value)/2));
        rec.audioGain=sl; rec.audioGainV=vspan;
        // Controller speaker (protocol v26): the DualSense speaker channels played on the grips
        const sel=document.createElement("select");
        for(const v of [0,25,50,75,100,150,200]){ const o=document.createElement("option"); o.value=v; o.textContent=v?v+"%":"Off (default)"; sel.appendChild(o); }
        sel.addEventListener("change",()=>setField(114,(+sel.value)/2));
        const note=document.createElement("p"); note.className="note";
        note.textContent="Plays what a game sends to the DualSense speaker (the first two channels of its audio device) through the grips, up to about 1.6 kHz, like a small speaker. Quiet audio is raised automatically, and bass is cut so it sounds rather than rumbles. 100% is full volume with the system volume at 100%; above that it gets louder but more compressed. The grips are vibration actuators, not a speaker: voices come through but sound buzzy and thin, and most other sounds just play as vibration. Off by default for that reason.";
        const wrap=document.createElement("div"); wrap.className="hide"; wrap.append(row(gAud,"Controller speaker",sel),note); gAud.appendChild(wrap);
        rec.speaker=sel; rec.speakerWrap=wrap;
      }
      ab.onclick=()=>{ const on=ab.classList.contains("active"); setField(40+et*9+5, on?0:1); };
      rumble.onclick=()=>{ const on=rumble.classList.contains("active"); setField(40+et*9+8, on?0:1); };
      rec.abSwap=ab; rec.pad=pad; rec.rumble=rumble;
      // Switch Pro-only settings get their own card on the Switch profile
      if(def.key==="SWITCH"){
        const g=group("Switch Pro mode only"); g.classList.add("span");
        for(const id of ["swClickControls","qamSelectRow","swGyroMapBlock","swGyroOld","hdPadBlock"]) g.appendChild(document.getElementById(id));
      }
      host.appendChild(sec); typeEls.push(rec);
    });
    mkTab("Lizard (desktop)",LIZARD_TAB).id="mapTabLizard";
    setTab(0);
  })();
  // The single-HID modes and PS3 drop WebUSB, so once in them a chord is the only way to switch; back4+A still
  // gets you back to Steam.
  for(const sel of document.querySelectorAll("select.chord, select.chordD")){
    MODE_ORDER.forEach(i=>{
      const o=document.createElement("option"); o.value=i; o.textContent=MODE_NAMES[i]; sel.appendChild(o); });
  }
  { const sel=document.getElementById("swGyroMap");
    for(const [lbl,v] of [["Corrected (default)",0],["Legacy (untrimmed)",1]]){
      const o=document.createElement("option"); o.value=v; o.textContent=lbl; sel.appendChild(o); }
  }
  { const sel=document.getElementById("rumbleScale");
    for(const v of RUMBLE_SCALES){
      const o=document.createElement("option"); o.value=v; o.textContent=v+"%"+(v===200?" (default)":""); sel.appendChild(o); }
  }

  // Trigger deadzone / full-press point, percent (fields 102/103, protocol v24).
  for(const [id,lo,hi,def] of [["trigInner",0,50,0],["trigOuter",50,100,100]]){ const sel=document.getElementById(id);
    for(let v=lo;v<=hi;v+=2){ const o=document.createElement("option"); o.value=v; o.textContent=v+"%"+(v===def?" (default)":""); sel.appendChild(o); }
  }


  for(const v of HD_PAD_SCALES){const o=document.createElement("option");o.value=v;o.textContent=v+"%"+(v===100?" (default)":"");$("#hdPadScale").appendChild(o);}
}
