import { S } from './state.js';
import { $, held, log } from './util.js';
import { setField } from './protocol.js';
import { MODE_NAMES, MODE_ORDER } from './status.js';
import { openNav } from './nav.js';
import { iconEl } from './icons.js';
import { glyphSelect } from './glyphselect.js';
import { buildPadClick, buildProfileCards, padClickLock, profileOp, profilesCapable, setPadStick } from './profiles.js';

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
// padTargets: the trackpad click targets (codes 21 left, 22 right) a mode does something with. Xbox 360 mode clicks
// its mouse with them (22 the left button, 21 the right); the PlayStation modes press that half of the touchpad;
// the Switch modes have no use for them, so they are not offered.
const PS_PADS = {21:["Touchpad click, left half","padClickL"],22:["Touchpad click, right half","padClickR"]};
export const TYPE_DEFS = [
  {key:"XBOX", name:"Xbox", labels:{1:"A",2:"B",3:"X",4:"Y",5:"LB",6:"RB",7:"L3",8:"R3",9:"Back",10:"Start",11:"Guide",19:"LT",20:"RT",...DPAD},
    padTargets:{21:["Mouse right click","mouseR"],22:["Mouse left click","mouseL"]}},
  {key:"SWITCH", name:"Switch", labels:{1:"A",2:"B",3:"X",4:"Y",5:"L",6:"R",7:"L-Stick",8:"R-Stick",9:"Minus",10:"Plus",11:"Home",19:"ZL",20:"ZR",...DPAD,18:"Capture / Screenshot"}, padTargets:{},
    haptics:{rumble:100}},
  {key:"DS4", name:"DS4", labels:{1:"Cross",2:"Circle",3:"Square",4:"Triangle",5:"L1",6:"R1",7:"L3",8:"R3",9:"Create",10:"Options",11:"PS",19:"L2",20:"R2",...DPAD,16:"Touchpad Click"}, padTargets:PS_PADS},
  {key:"DS5", name:"DS5", labels:{1:"Cross",2:"Circle",3:"Square",4:"Triangle",5:"L1",6:"R1",7:"L3",8:"R3",9:"Create",10:"Options",11:"PS",19:"L2",20:"R2",...DPAD,16:"Touchpad Click",17:"Mute"}, padTargets:PS_PADS},
];
// Grip strength (percent) and haptic style a type starts with: the firmware's g_typeRumbleScaleDefault and kHapticStyleDefault
const typeDefaults=def=>({rumble:200,style:3,click:26,tick:0,tickGain:11,knee:85,lift:1,trig:1,dpad:1,...def.haptics});
// movement-tick spacing: 0 leaves the ticks to the controller (fixed strength), 1..4 have the puck play them, a wider to a
// narrower distance apart
export const PAD_TICK_LABELS=["Controller's own","Sparse","Normal","Dense","Densest"];
// click step 0..31 to dB (mirror of firmware padClickGainDb): -20..-1, then +1..+12; 0 dB is the legacy haptic stop
export const clickDb=step=>step<20?step-20:step-19;
// Which emulated type a USB mode belongs to (mirror of firmware etypeForMode); -1 = puck mode (no type).
export function etypeForMode(m){ switch(m){case 1:case 10:return 0; case 2:case 4:return 1; case 6:case 8:case 9:return 2; case 5:case 7:return 3; default:return -1;} }
// the firmware's back[] order; each label is the paddle glyph (full name on hover) plus its short name
const BACK_KEYS = ["L4","R4","L5","R5"];
export const typeEls = []; // one entry per TYPE_DEFS: {sec, tab, activeDot, back[], qam, abSwap, pad, led, ledV, rumble, padStick[]}
// Trackpad -> joystick mapping (firmware PS_OFF/PS_LEFT/PS_RIGHT). Field id = PAD_STICK_FIELD0 + et*2 + pad
// (pad 0 = left trackpad, 1 = right). While mapped and touched the pad drives that stick; on release the
// stick re-centers, and an untouched mapped pad leaves the physical stick in control.
export const PAD_STICK_FIELD0 = 80;
// What touching a pad does, per type and pad. 0 is what the pad does with no mapping: the touchpad on the
// PlayStation types, the mouse on the Xbox right pad, nothing on the rest. 5 ignores the touch; it is offered
// only where 0 does something, as "Off" already is nothing. The D-pad modes read the pad in Switch Pro mode only.
export const PAD_DISABLED = 5;
function padTouchOptions(def, pad){
  const off = def.key==="XBOX" ? (pad ? "Mouse" : "Off") : def.key==="SWITCH" ? "Off" : "Touchpad, "+(pad ? "right" : "left")+" half";
  const o = [[0,off]];
  if(off !== "Off") o.push([PAD_DISABLED,"Disabled"]);
  o.push([1,"Left stick","stickL"],[2,"Right stick","stickR"]);
  o.push([3,"D-pad on touch"],[4,"D-pad on click"]);
  return o;
}
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
  lizardHapticsApply(s);
  const capable=!!s;
  // firmware with the per-type D-pad click feedback shows it on every tab instead
  const perTypeDpad=!!(S.lastP && S.lastP.length>hapIndex(HAP.DPAD,3));
  $("#swClickControls").classList.toggle("hide",!capable || perTypeDpad);
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
  if(et===0) typeEls[0].mouseHost.appendChild($("#mouseCard"));
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
    [PAD_STICK_FIELD0+et*2,0,20],[PAD_STICK_FIELD0+et*2+1,0,20],[108+et,typeDefaults(TYPE_DEFS[et]).rumble/2,25],
    [hapField(HAP.CLICK,et),typeDefaults(TYPE_DEFS[et]).click,30],[hapField(HAP.TICK,et),typeDefaults(TYPE_DEFS[et]).tick,30],
    [hapField(HAP.TICKGAIN,et),typeDefaults(TYPE_DEFS[et]).tickGain,30]];
  // firmware before protocol 30 has one limiter for both types, and the style only on the DualSense
  const perType=S.lastP && S.lastP[0]>=30;
  if(sw||ds5) f.push(perType ? [hapField(HAP.KNEE,et),typeDefaults(TYPE_DEFS[et]).knee,30] : [115,70,27]);
  if((sw||ds5) && S.lastP && S.lastP.length>hapIndex(HAP.LIFT,et)) f.push([hapField(HAP.LIFT,et),typeDefaults(TYPE_DEFS[et]).lift,30]);
  if(ds5 && S.lastP && S.lastP.length>hapIndex(HAP.TRIG,et)) f.push([hapField(HAP.TRIG,et),typeDefaults(TYPE_DEFS[et]).trig,30]);
  if(S.lastP && S.lastP.length>hapIndex(HAP.DPAD,et)) f.push([hapField(HAP.DPAD,et),typeDefaults(TYPE_DEFS[et]).dpad,30]);
  const style=typeDefaults(TYPE_DEFS[et]).style;
  if(sw) f.push([hapField(HAP.STYLE,et),style,30]);
  if(ds5) f.push([31,1,0],perType ? [hapField(HAP.STYLE,et),style,30] : [88,style,22],[30,0,0],[114,0,26],[116,0,29]);
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
    : ((key==="SWITCH"||key==="DS5") && !(S.lastP && S.lastP[0]>=30)) ? "\n\nThe grip limiter is one setting shared by the Switch and DS5 controller types on this firmware, so it resets for both." : "";
  const what=prof ? "All three mapping profiles, and the trackpad, rumble and light settings" : "The button mapping, trackpad, rumble and light settings";
  if(!confirm("Reset the "+name+" controller type to its defaults?\n\n"+what+" go back to their factory values, and profile 1 is put in use. This saves to the puck immediately; your current choices for this controller type are lost."+shared)) return;
  mapResetBusy=true; $("#mapReset").disabled=true;
  try{
    const ver=S.lastP?S.lastP[0]:0;
    // with profiles, the mapping and trackpad -> stick fields only reach the active profile: reset every profile instead
    const b=40+et*9, mapped=new Set([b,b+1,b+2,b+3,b+4,b+5,PAD_STICK_FIELD0+et*2,PAD_STICK_FIELD0+et*2+1,116]);
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
// Protocol 30 keeps the per-type settings in one grid (firmware HAP_* in config.h): WebUSB field
// 120 + 4 * setting + type, status blob byte 216 + 4 * setting + type (index 214 + ... here, the header being cut).
// The release before it (29) has one limiter for all types (field 115) and the style on the DualSense only (field 88).
export const HAP={KNEE:0,STYLE:1,CLICK:2,TICK:3,TICKGAIN:4,LIFT:5,TRIG:6,DPAD:7};
// per setting, in HAP order: the backup key and its range
export const HAP_KEYS=[["limiter",50,100],["hapticStyle",0,3],["padClick",0,31],["padTick",0,4],["padTickGain",0,31],["softBoost",0,4],["triggerHaptics",0,3],["dpadClick",0,1]];
export const hapField=(k,et)=>120+4*k+et;
export const hapIndex=(k,et)=>214+4*k+et;
export const hapValue=(p,k,et)=>p[hapIndex(k,et)];
export const perTypeHaptics=()=>!!(S.lastP && S.lastP[0]>=30);
const HAPTIC_STYLES=[[3,"Wave"],[1,"Tone"],[2,"Split"],[0,"Rumble"]];
export const RUMBLE_SCALES=Array.from({length:246},(_,i)=>10+i*2);
const HD_PAD_SCALES=Array.from({length:251},(_,i)=>i*2);

// Lizard mode's trackpad haptics (v30): WebUSB fields 156..159, 0xAE payload s[48..51] = Trackpad haptics,
// click strength, tick spacing, tick strength (g_lizardHaptic in config.h)
const LZH_FIELD0 = 156, LZH_INDEX0 = 48;
const LZH_DEFAULTS = [1, 26, 0, 11];
const fmtLzClick=(pos,dflt)=>{ const db=clickDb(pos); return (db>0?"+":"")+db+" dB"+(pos===dflt?" (default)":""); };
function initLizardHaptics(){
  const ctl=[$("#lzHapMode"),$("#lzHapClick"),$("#lzHapTick"),$("#lzHapTickG")];
  ctl.forEach((el,k)=>el.addEventListener("change",()=>setField(LZH_FIELD0+k,+el.value)));
  $("#lzHapClick").addEventListener("input",()=>{ $("#lzHapClickV").textContent=fmtLzClick(+$("#lzHapClick").value,LZH_DEFAULTS[1]); });
  $("#lzHapTick").addEventListener("input",()=>{ $("#lzHapTickV").textContent=PAD_TICK_LABELS[+$("#lzHapTick").value]; });
  $("#lzHapTickG").addEventListener("input",()=>{ $("#lzHapTickGV").textContent=fmtLzClick(+$("#lzHapTickG").value,LZH_DEFAULTS[3]); });
}
export function lizardHapticsValues(s){
  return (s && S.lastP && S.lastP[0]>=30 && s.length>LZH_INDEX0+3) ? Array.from(s.slice(LZH_INDEX0,LZH_INDEX0+4)) : null;
}
function lizardHapticsApply(s){
  const v=lizardHapticsValues(s);
  $("#lzHapOld").classList.toggle("hide",!!v);
  $("#lzHapControls").classList.toggle("hide",!v);
  if(!v) return;
  const [mode,click,tick,tickG]=v;
  if(!held($("#lzHapMode"))) $("#lzHapMode").value=mode;
  if(!held($("#lzHapClick"))){ $("#lzHapClick").value=click; $("#lzHapClickV").textContent=fmtLzClick(click,LZH_DEFAULTS[1]); }
  if(!held($("#lzHapTick"))){ $("#lzHapTick").value=tick; $("#lzHapTickV").textContent=PAD_TICK_LABELS[tick]||tick; }
  if(!held($("#lzHapTickG"))){ $("#lzHapTickG").value=tickG; $("#lzHapTickGV").textContent=fmtLzClick(tickG,LZH_DEFAULTS[3]); }
  // as on the other types: click strength needs haptics on or clicks only, ticks need On
  $("#lzHapClick").disabled=(mode===0); $("#lzHapTick").disabled=(mode!==1); $("#lzHapTickG").disabled=(mode!==1||tick===0);
}

export function initTypes(){
  initLizardHaptics();
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
      // with profiles the whole card is replaced: its Create switch is a preset now
      gBtn.classList.add("prof-legacy");
      relabel(ab,iconEl("A"),iconEl("B"),plus(),iconEl("X"),iconEl("Y")," swap");
      // Trackpads: a column per pad, what touching it does and what its click acts as. Their haptics have their own card below.
      const gPad=group("Trackpads"); gPad.classList.add("span");
      const cols=document.createElement("div"); cols.className="mapsrc"; gPad.appendChild(cols);
      for(let pad=0; pad<2; pad++){
        const col=document.createElement("div"); col.className="mapsrc-group pad-col"; cols.appendChild(col);
        const h=document.createElement("h3"); h.append(iconEl(pad?"padR":"padL")," "+(pad?"Right":"Left")+" trackpad"); col.appendChild(h);
        const sel=document.createElement("select");
        for(const [v,lbl,glyph] of padTouchOptions(def,pad)){ const o=document.createElement("option"); o.value=v; o.textContent=lbl; if(v!==PAD_DISABLED) o.dataset.glyph=glyph||(v===4?(pad?"padClickR":"padClickL"):(pad?"padR":"padL")); sel.appendChild(o); }
        row(col,"Touch",glyphSelect(sel));
        sel.addEventListener("change",()=>{ padClickLock(et); setPadStick(et,pad,+sel.value,PAD_STICK_FIELD0+et*2+pad); });
        rec.padStick.push(sel);
        buildPadClick(et,pad,col);
      }
      { const note=document.createElement("p"); note.className="note";
        note.textContent={
          XBOX:"In Xbox 360 mode the right trackpad moves a mouse pointer while its Touch is Mouse, and a click acts as set here: by default the right pad is the left mouse button and the left pad the right one. Disabled stops the pointer; the click is separate. The Original Xbox has no mouse.",
          SWITCH:"A click does nothing in the Switch modes unless you map it to a button here. The D-pad modes read the trackpad themselves, so they work whatever Click is set to.",
        }[def.key] || "A trackpad that is disabled, drives a stick or acts as a D-pad no longer reports as a touchpad, but its click still presses the touchpad unless you map Click to something else.";
        note.textContent+=" On D-pad on click, the click presses the D-pad instead.";
        gPad.appendChild(note); }
      // one grid cell for Trackpad feedback and the small cards under it (Adaptive triggers, Lights), balancing the Rumble column
      const stackL=document.createElement("div"); stackL.className="stack";
      const gPadH=group("Trackpad feedback"); gPad.after(stackL); stackL.append(gPadH);
      // 1 = controller's own haptics (ticks while moving + clicks), 2 = clicks only, 0 = off
      const pad=document.createElement("select");
      for(const [v,lbl] of [[1,"On"],[2,"Clicks only"],[0,"Off"]]){ const o=document.createElement("option"); o.value=v; o.textContent=lbl; pad.appendChild(o); }
      row(gPadH,"Trackpad haptics",pad);
      pad.addEventListener("change",()=>setField(40+et*9+6, +pad.value));
      // D-pad click feedback (every type): a pulse when a trackpad in a D-pad mode is clicked
      { const sel=document.createElement("select");
        for(const [v,lbl] of [[1,"On (default)"],[0,"Off"]]){ const o=document.createElement("option"); o.value=v; o.textContent=lbl; sel.appendChild(o); }
        sel.addEventListener("change",()=>setField(hapField(HAP.DPAD,et),+sel.value));
        const note=document.createElement("p"); note.className="note";
        note.textContent="A short pulse on a trackpad that is a D-pad each time its direction changes, so sliding from down to down-right is felt without lifting your finger, and on each click while Trackpad haptics is Off (with it on, every click already pulses).";
        const wrap=document.createElement("div"); wrap.className="hide"; wrap.append(row(gPadH,"D-pad feedback",sel),note); gPadH.appendChild(wrap);
        rec.dpad=sel; rec.dpadWrap=wrap; }
      // Click strength (protocol v30): the slider position is the firmware's step, weak -> strong.
      // Movement ticks: the controller plays its own at a fixed strength (spacing 0); any other spacing has the puck play them at the tick strength.
      { const gHap=document.createElement("div"); gHap.className="hide";
        const click=document.createElement("input"); click.type="range"; click.min=0; click.max=31; click.step=1;
        const clickV=document.createElement("span"); clickV.className="val";
        const fmtClick=(pos,key="click")=>{ const db=clickDb(pos); return (db>0?"+":"")+db+" dB"+(pos===typeDefaults(def)[key]?" (default)":""); };
        click.addEventListener("input",()=>{ clickV.textContent=fmtClick(+click.value); });
        click.addEventListener("change",()=>setField(hapField(HAP.CLICK,et), +click.value));
        const tick=document.createElement("input"); tick.type="range"; tick.min=0; tick.max=4; tick.step=1;
        const tickV=document.createElement("span"); tickV.className="val";
        tick.addEventListener("input",()=>{ tickV.textContent=PAD_TICK_LABELS[+tick.value]; });
        tick.addEventListener("change",()=>setField(hapField(HAP.TICK,et), +tick.value));
        const tickG=document.createElement("input"); tickG.type="range"; tickG.min=0; tickG.max=31; tickG.step=1;
        const tickGV=document.createElement("span"); tickGV.className="val";
        tickG.addEventListener("input",()=>{ tickGV.textContent=fmtClick(+tickG.value,"tickGain"); });
        tickG.addEventListener("change",()=>setField(hapField(HAP.TICKGAIN,et), +tickG.value));
        const note=document.createElement("p"); note.className="note";
        note.textContent="Click strength applies to the clicks the puck sends itself: Clicks only, the PlayStation modes and the Switch D-pad click feedback. Movement ticks only play with Trackpad haptics On. The controller plays its own ticks and clicks at a fixed strength; choose a spacing and the puck plays both instead, ticks at the Tick strength and clicks at the Click strength, pausing the ticks around a click. Back on Controller's own they return at once. Clicks only has no ticks. Tick spacing and strength are untested on the Steam Controller 2.";
        gHap.append(row(gPadH,"Click strength",click,clickV),row(gPadH,"Tick spacing",tick,tickV),row(gPadH,"Tick strength",tickG,tickGV),note);
        gPadH.appendChild(gHap);
        Object.assign(rec,{padHap:gHap,padClick:click,padClickV:clickV,padClickFmt:fmtClick,padTick:tick,padTickV:tickV,padTickG:tickG,padTickGV:tickGV}); }
      // the Xbox pointer's speed is one setting shared with Lizard mode: setTab() moves its card in or out of here
      if(def.key==="XBOX"){ rec.mouseHost=document.createElement("div"); rec.mouseHost.className="pad-mouse"; gPad.appendChild(rec.mouseHost); }
      // Rumble is the game's rumble; Haptics is how the grips play the haptic signal, with the same controls in the
      // same order on the Switch and DS5 tabs. A Switch game sends one signal, HD rumble, so its haptics strength is
      // the grip rumble strength. A DualSense game sends motor rumble and audio haptics apart, each with its own.
      const gRum=group("Rumble");
      // one grid cell for Rumble and the Haptics card under it, so they stack at any column count
      const stack=document.createElement("div"); stack.className="stack"; gRum.before(stack); stack.append(gRum);
      const rumble=toggle(gRum,"Rumble","on");
      const sw=def.key==="SWITCH", ds5=def.key==="DS5";
      const gHapt=(sw||ds5)?group("Haptics"):null;
      if(gHapt) stack.append(gHapt);
      if(ds5){
        const aud=toggle(gHapt,"Haptics","on");
        rec.audioHaptics=aud;
        aud.onclick=()=>{ const on=aud.classList.contains("active"); setField(31, on?0:1); };
      }
      // Haptics style (Switch from protocol v30, DualSense from v22): 0 rumble = the stronger band as motor rumble,
      // 1 tone = smooth per-actuator tones, 2 split = the low band as rumble and the rest as tones, 3 wave = the
      // signal streamed to the grips as PCM (default)
      let sty=null;
      if(sw||ds5){
        sty=document.createElement("select");
        for(const [v,lbl] of HAPTIC_STYLES){ const o=document.createElement("option"); o.value=v; o.textContent=v===typeDefaults(def).style?lbl+" (default)":lbl; sty.appendChild(o); }
        const note=document.createElement("p"); note.className="note";
        note.textContent=sw ? "How the grips play HD rumble. Wave streams both bands as a waveform. Tone plays each side's stronger band as a smooth tone. Split plays the low band as rumble and the high band as a tone. Rumble plays the stronger band as plain motor rumble. The trackpads always play the high band as tones."
          : "How the grips play the game's haptics audio. Wave streams it as sent, like a real DualSense. Tone plays each side as a smooth tone. Split plays the lows as rumble and the rest as tones. Rumble plays it as plain motor rumble.";
        const wrap=document.createElement("div"); wrap.append(row(gHapt,"Style",sty),note); gHapt.appendChild(wrap);
        if(sw){
          sty.addEventListener("change",()=>setField(hapField(HAP.STYLE,et),+sty.value));
          wrap.classList.add("hide"); rec.hdStyle=sty; rec.hdStyleWrap=wrap;
        } else {
          sty.addEventListener("change",()=>setField(perTypeHaptics()?hapField(HAP.STYLE,et):88, +sty.value));
          rec.audioStyle=sty;
        }
      }
      // Grip rumble strength, per type (protocol v25). The rumble style follows the mode. On the Switch it is the
      // haptics strength.
      { const sel=document.createElement("select");
        for(const v of RUMBLE_SCALES){ const o=document.createElement("option"); o.value=v; o.textContent=v+"%"+(v===typeDefaults(def).rumble?" (default)":""); sel.appendChild(o); }
        const wrap=document.createElement("div"); wrap.className="hide";
        wrap.appendChild(row(sw?gHapt:gRum,sw?"Strength":"Grip rumble strength",sel));
        const note=document.createElement("p"); note.className="note";
        note.textContent=sw ? "Switch games send all their vibration as HD rumble, so this is also the rumble strength. Wave stops getting stronger at 100%: past that a full-strength effect overdrives the grips and they grind. Higher strengths still apply to the Tone, Split and Rumble styles."
          : ds5 ? "The game's motor rumble. The haptics below have their own strength." : "";
        if(note.textContent) wrap.appendChild(note);
        (sw?gHapt:gRum).appendChild(wrap);
        sel.addEventListener("change",()=>setField(108+et, (+sel.value)/2));
        rec.rumbleScl=sel; rec.rumbleSclWrap=wrap; }
      if(ds5){
        // Haptics strength: the audio gain. 0 = Auto (firmware default): the loudest recent haptic plays at full
        // strength; Wave skips the auto gain, so there Auto is a fixed 100%
        const sl=document.createElement("input"); sl.type="range"; sl.min=0; sl.max=500; sl.step=10;
        const vspan=document.createElement("span"); vspan.className="val";
        row(gHapt,"Strength",sl,vspan);
        const gainLabel=v=>+v?v+"%":+sty.value===3?"Auto (100%)":"Auto";
        sl.value=0; vspan.textContent=gainLabel(0);
        sl.addEventListener("input",()=>{ vspan.textContent=gainLabel(sl.value); });
        sty.addEventListener("change",()=>{ vspan.textContent=gainLabel(sl.value); });
        sl.addEventListener("change",()=>setField(30, (+sl.value)/2));
        rec.audioGain=sl; rec.audioGainV=vspan; rec.audioGainLabel=gainLabel;
        const gnote=document.createElement("p"); gnote.className="note";
        gnote.textContent="Auto evens out each game's level in the Tone, Split and Rumble styles; in Wave it is 100%, a real DualSense's strength. Wave stops getting stronger at 250%: past that a full-strength haptic track overdrives the grips and they grind. Higher strengths still apply to the Tone, Split and Rumble styles.";
        gHapt.appendChild(gnote);
      }
      // Grip limiter (protocol v27, per controller type from v30): the Switch's HD rumble grips and the DualSense's wave haptics/speaker
      if(sw||ds5){
        const sel=document.createElement("select");
        for(const v of [50,60,70,80,85,90,95,100]){ const o=document.createElement("option"); o.value=v; o.textContent=v===100?"Off (hard clip)":v+"%"+(v===85?" (default)":""); sel.appendChild(o); }
        sel.addEventListener("change",()=>setField(perTypeHaptics()?hapField(HAP.KNEE,et):115,+sel.value));
        const note=document.createElement("p"); note.className="note";
        note.textContent="Grip vibration above this level is rounded off toward full strength instead of clipping, which plays as a pop. Lower is smoother on the strongest hits, higher keeps more of their punch. It shapes the waveform streamed to the grips (the Wave style, and the DualSense speaker). Each controller type has its own.";
        const wrap=document.createElement("div"); wrap.className="hide"; wrap.append(row(gHapt,"Grip limiter",sel),note); gHapt.appendChild(wrap);
        rec.limiter=sel; rec.limiterWrap=wrap;
      }
      // Soft boost: raises quiet passages of the stream to the grips, up to 1.5x / 2x / 3x / 4x
      if(sw||ds5){
        const sel=document.createElement("select");
        for(const [v,lbl] of [[0,"Off"],[1,"Gentle (up to 1.5×)"],[2,"Low (up to 2×)"],[3,"Medium (up to 3×)"],[4,"High (up to 4×)"]]){ const o=document.createElement("option"); o.value=v; o.textContent=lbl+(v===typeDefaults(def).lift?" (default)":""); sel.appendChild(o); }
        sel.addEventListener("change",()=>setField(hapField(HAP.LIFT,et),+sel.value));
        const note=document.createElement("p"); note.className="note";
        note.textContent="Raises quiet haptics, like soft footsteps, so you can feel them. Strong hits are left as they are. The grips play even very soft vibration, but a hand barely notices it below a few percent of full strength. Applies to the Wave style.";
        const wrap=document.createElement("div"); wrap.className="hide"; wrap.append(row(gHapt,"Soft boost",sel),note); gHapt.appendChild(wrap);
        rec.lift=sel; rec.liftWrap=wrap;
      }
      // Adaptive triggers: where the DualSense trigger effects are felt; its own group, as it isn't part of the grip stream
      if(ds5){
        const gTrig=group("Adaptive triggers"); gTrig.classList.add("hide");
        stackL.append(gTrig);
        const sel=document.createElement("select");
        for(const [v,lbl] of [[0,"Off"],[1,"Trackpads"],[2,"Grips"],[3,"Trackpads and grips"]]){ const o=document.createElement("option"); o.value=v; o.textContent=lbl+(v===typeDefaults(def).trig?" (default)":""); sel.appendChild(o); }
        sel.addEventListener("change",()=>setField(hapField(HAP.TRIG,et),+sel.value));
        const note=document.createElement("p"); note.className="note";
        note.textContent="The Steam Controller has no trigger motors, so a game's adaptive-trigger effects are played here: a tick for each step the trigger goes into a resistance zone, a sharp click when a weapon trigger breaks, and trigger vibration as a buzz. R2 plays on the right, L2 on the left. A trigger held still stays quiet.";
        row(gTrig,"Trigger haptics",sel); gTrig.appendChild(note);
        rec.trig=sel; rec.trigWrap=gTrig;
      }
      // LED brightness
      { const gLed=group("Lights"); stackL.append(gLed);
        const sl=document.createElement("input"); sl.type="range"; sl.min=0; sl.max=100; sl.step=5;
        const vspan=document.createElement("span"); vspan.className="val";
        row(gLed,"LED brightness",sl,vspan);
        function fmtLed(v){ return (+v===0)?"Auto":v+"%"; }
        sl.addEventListener("input",()=>{ vspan.textContent=fmtLed(sl.value); });
        sl.addEventListener("change",()=>setField(40+et*9+7, +sl.value));
        rec.led=sl; rec.ledV=vspan; }
      if(ds5){
        // Create button presses the touchpad click instead (protocol v29)
        const ct=toggle(gBtn,"","off");
        relabel(ct,iconEl("view")," Create = ",iconEl("padClick")," touchpad click");
        rec.createTouch=ct;
        ct.onclick=()=>setField(116, ct.classList.contains("active")?0:1);
        // Controller speaker (protocol v26): the DualSense speaker channels played on the grips
        const sel=document.createElement("select");
        for(const v of [0,25,50,75,100,150,200]){ const o=document.createElement("option"); o.value=v; o.textContent=v?v+"%":"Off (default)"; sel.appendChild(o); }
        sel.addEventListener("change",()=>setField(114,(+sel.value)/2));
        const note=document.createElement("p"); note.className="note";
        note.textContent="Plays what a game sends to the DualSense speaker (the first two channels of its audio device) through the grips, up to about 1.6 kHz, like a small speaker. Quiet audio is raised automatically, and bass is cut so it sounds rather than rumbles. 100% is full volume with the system volume at 100%; above that it gets louder but more compressed. The grips are vibration actuators, not a speaker: voices come through but sound buzzy and thin, and most other sounds just play as vibration. Off by default for that reason.";
        const wrap=document.createElement("div"); wrap.className="hide"; wrap.append(row(gHapt,"Controller speaker",sel),note); gHapt.appendChild(wrap);
        rec.speaker=sel; rec.speakerWrap=wrap;
      }
      ab.onclick=()=>{ const on=ab.classList.contains("active"); setField(40+et*9+5, on?0:1); };
      rumble.onclick=()=>{ const on=rumble.classList.contains("active"); setField(40+et*9+8, on?0:1); };
      rec.abSwap=ab; rec.pad=pad; rec.rumble=rumble;
      // Switch Pro-only settings get their own card on the Switch profile
      if(def.key==="SWITCH"){
        const g=group("Switch Pro mode only"); g.classList.add("span"); rec.prof.cards[2].after(g); // right below the Button map card
        for(const id of ["swGyroMapBlock","swGyroOld"]) g.appendChild(document.getElementById(id));
        // the D-pad click feedback and the HD trackpad strength belong with the trackpad feedback
        for(const id of ["swClickControls","hdPadBlock"]) gPadH.appendChild(document.getElementById(id));
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
