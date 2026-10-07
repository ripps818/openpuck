import { S } from './state.js';
import { $ } from './util.js';
import { setField } from './protocol.js';
import { MODE_NAMES } from './status.js';

// Per-emulated-type config (must match firmware ET_* order: Xbox=0, Switch=1, DS4=2, DS5=3). Each type lists
// only the remap targets that exist on that controller. Field id sent to firmware = 40 + et*9 + k
// (k: 0..3 back paddles, 4 QAM, 5 A/B-swap, 6 trackpad-haptics, 7 LED brightness, 8 rumble). Blob v17 reads them back at p[73 + et*9 + ...].
const DPAD = {12:"D-pad Up",13:"D-pad Down",14:"D-pad Left",15:"D-pad Right"};
export const TYPE_DEFS = [
  {key:"XBOX", name:"Xbox", labels:{1:"A",2:"B",3:"X",4:"Y",5:"LB",6:"RB",7:"L3",8:"R3",9:"Back",10:"Start",11:"Guide",19:"LT",20:"RT",...DPAD}},
  {key:"SWITCH", name:"Switch", labels:{1:"A",2:"B",3:"X",4:"Y",5:"L",6:"R",7:"L-Stick",8:"R-Stick",9:"Minus",10:"Plus",11:"Home",19:"ZL",20:"ZR",...DPAD,18:"Capture / Screenshot"}},
  {key:"DS4", name:"DS4", labels:{1:"Cross",2:"Circle",3:"Square",4:"Triangle",5:"L1",6:"R1",7:"L3",8:"R3",9:"Create",10:"Options",11:"PS",19:"L2",20:"R2",...DPAD,16:"Touchpad Click"}},
  {key:"DS5", name:"DS5", labels:{1:"Cross",2:"Circle",3:"Square",4:"Triangle",5:"L1",6:"R1",7:"L3",8:"R3",9:"Create",10:"Options",11:"PS",19:"L2",20:"R2",...DPAD,16:"Touchpad Click",17:"Mute"}},
];
// Which emulated type a USB mode belongs to (mirror of firmware etypeForMode); -1 = puck mode (no type).
export function etypeForMode(m){ switch(m){case 1:case 10:return 0; case 2:case 4:return 1; case 6:case 8:case 9:return 2; case 5:case 7:return 3; default:return -1;} }
const BACK_LABELS = ["L4 (back upper-left)","R4 (back upper-right)","L5 (back lower-left)","R5 (back lower-right)"];
export const typeEls = []; // one entry per TYPE_DEFS: {sec, tab, activeDot, back[], qam, abSwap, pad, led, ledV, rumble, padStick[]}
// Trackpad -> joystick mapping (firmware PS_OFF/PS_LEFT/PS_RIGHT). Field id = PAD_STICK_FIELD0 + et*2 + pad
// (pad 0 = left trackpad, 1 = right). While mapped and touched the pad drives that stick; on release the
// stick re-centers, and an untouched mapped pad leaves the physical stick in control.
export const PAD_STICK_FIELD0 = 80;
const PAD_STICK_OPTS = [[0,"Off (touchpad)"],[1,"Left stick"],[2,"Right stick"]];
const PAD_STICK_LABELS = ["Left trackpad mapping","Right trackpad mapping"];
function mkSelect(def, includeNone){
  const sel=document.createElement("select");
  if(includeNone){ const o=document.createElement("option"); o.value=0; o.textContent="— none —"; sel.appendChild(o); }
  else { const o=document.createElement("option"); o.value=0; o.textContent="Default (per-mode)"; sel.appendChild(o); }
  for(const c of Object.keys(def.labels).map(Number).sort((a,b)=>a-b)){
    const o=document.createElement("option"); o.value=c; o.textContent=def.labels[c]; sel.appendChild(o); }
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

let curTab=0;
export function setTab(et){
  curTab=et;
  typeEls.forEach((rec,i)=>{
    rec.sec.style.display = (i===et) ? "" : "none";
    rec.tab.classList.toggle("active", i===et);
  });
}
// Strength is sent as percent/2 (field 22), so every value here must be even.
export const RUMBLE_SCALES=Array.from({length:246},(_,i)=>10+i*2);
const HD_PAD_SCALES=Array.from({length:251},(_,i)=>i*2);

export function initTypes(){
  for(const o of mkSelect(TYPE_DEFS[1],true).options){const c=o.cloneNode(true);if(+c.value===18)c.textContent="Take screenshot";$("#qamSelect").appendChild(c);}
  $("#swClickFeedback").onchange=()=>setField(230,+$("#swClickFeedback").value);
  (function buildTypeCfgs(){
    const host=document.getElementById("typeCfgs");
    const bar=document.createElement("div"); bar.style.cssText="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px";
    host.appendChild(bar);
    TYPE_DEFS.forEach((def,et)=>{
      // tab button
      const tab=document.createElement("button"); tab.className="slot-tab"; tab.style.cursor="pointer";
      tab.innerHTML='<span>'+def.name+'</span><span class="active-dot" style="display:none;font-size:11px;color:var(--acc)"> ●</span>';
      tab.onclick=()=>setTab(et); bar.appendChild(tab);
      const sec=document.createElement("div"); sec.style.cssText="background:#0e1017;border:1px solid #232a3a;border-radius:8px;padding:12px 14px;display:none";
      const rec={sec,tab,activeDot:tab.querySelector(".active-dot"),back:[],qam:null,abSwap:null,pad:null,led:null,ledV:null,rumble:null,audioHaptics:null,audioStyle:null,audioGain:null,audioGainV:null,padStick:[]};
      // A/B swap + trackpad haptics + rumble toggles
      const tog=document.createElement("div"); tog.className="row"; tog.style.cssText="display:flex;align-items:center;gap:8px 10px;margin:12px 0;flex-wrap:wrap";
      const abLbl=document.createElement("label"); abLbl.textContent="A/B + X/Y swap"; abLbl.style.cssText="flex:0 0 auto;margin:0"; tog.appendChild(abLbl);
      const ab=document.createElement("button"); ab.textContent="off"; tog.appendChild(ab);
      const padLbl=document.createElement("label"); padLbl.textContent="Trackpad haptics"; padLbl.style.cssText="flex:0 0 auto;margin:0 0 0 6px"; tog.appendChild(padLbl);
      const pad=document.createElement("button"); pad.textContent="on"; tog.appendChild(pad);
      const rumbleLbl=document.createElement("label"); rumbleLbl.textContent="Rumble"; rumbleLbl.style.cssText="flex:0 0 auto;margin:0 0 0 6px"; tog.appendChild(rumbleLbl);
      const rumble=document.createElement("button"); rumble.textContent="on"; tog.appendChild(rumble);
      if(def.key==="DS5"){
        const audLbl=document.createElement("label"); audLbl.textContent="Audio Haptics"; audLbl.style.cssText="flex:0 0 auto;margin:0 0 0 6px"; tog.appendChild(audLbl);
        const aud=document.createElement("button"); aud.textContent="on"; tog.appendChild(aud);
        rec.audioHaptics=aud;
        aud.onclick=()=>{ const on=aud.classList.contains("active"); setField(31, on?0:1); };
        // Haptics style (protocol v22): 0 rumble = the motor-style rumble, 1 tone = smooth per-actuator tones,
        // 2 split = below ~80 Hz as rumble, the rest as tones, 3 wave = the haptic channels streamed as PCM (default).
        // Clicking cycles tone -> split -> wave -> rumble.
        const styLbl=document.createElement("label"); styLbl.textContent="Haptics style"; styLbl.style.cssText="flex:0 0 auto;margin:0 0 0 6px"; tog.appendChild(styLbl);
        const sty=document.createElement("button"); sty.textContent="wave"; sty.dataset.v="3"; tog.appendChild(sty);
        rec.audioStyle=sty;
        sty.onclick=()=>{ setField(88, ((+sty.dataset.v)+1)%4); };
      }
      sec.appendChild(tog);
      rec.abSwap=ab; rec.pad=pad; rec.rumble=rumble;
      ab.onclick=()=>{ const on=ab.classList.contains("active"); setField(40+et*9+5, on?0:1); };
      pad.onclick=()=>{ const on=pad.classList.contains("active"); setField(40+et*9+6, on?0:1); };
      rumble.onclick=()=>{ const on=rumble.classList.contains("active"); setField(40+et*9+8, on?0:1); };
      // back paddles
      for(let i=0;i<4;i++){
        const row=document.createElement("div"); row.className="row";
        const lab=document.createElement("label"); lab.textContent=BACK_LABELS[i]; row.appendChild(lab);
        const sel=mkSelect(def,true); row.appendChild(sel); sec.appendChild(row);
        sel.addEventListener("change",()=>setField(40+et*9+i, +sel.value));
        rec.back.push(sel);
      }
      // QAM
      { const row=document.createElement("div"); row.className="row";
        const lab=document.createElement("label"); lab.textContent="QAM (3 dots)"; row.appendChild(lab);
        const sel=mkSelect(def,false); row.appendChild(sel); sec.appendChild(row);
        sel.addEventListener("change",()=>setField(40+et*9+4, +sel.value));
        rec.qam=sel; }
      // LED brightness
      { const row=document.createElement("div"); row.className="row";
        const lab=document.createElement("label"); lab.textContent="LED brightness"; row.appendChild(lab);
        const sl=document.createElement("input"); sl.type="range"; sl.min=0; sl.max=100; sl.step=5; row.appendChild(sl);
        const vspan=document.createElement("span"); vspan.className="val"; row.appendChild(vspan);
        function fmtLed(v){ return (+v===0)?"Auto":v+"%"; }
        sl.addEventListener("input",()=>{ vspan.textContent=fmtLed(sl.value); });
        sl.addEventListener("change",()=>setField(40+et*9+7, +sl.value));
        sec.appendChild(row);
        rec.led=sl; rec.ledV=vspan; }
      // Grip rumble strength, per type (protocol v25). The rumble style follows the mode.
      { const row=document.createElement("div"); row.className="row hide";
        const lab=document.createElement("label"); lab.textContent="Grip rumble strength"; row.appendChild(lab);
        const sel=document.createElement("select"); row.appendChild(sel); sec.appendChild(row);
        for(const v of RUMBLE_SCALES){ const o=document.createElement("option"); o.value=v; o.textContent=v+"%"+(v===200?" (default)":""); sel.appendChild(o); }
        sel.addEventListener("change",()=>setField(108+et, (+sel.value)/2));
        rec.rumbleScl=sel; }
      // Audio Haptics gain (DS5 only)
      if(def.key==="DS5"){
        const row=document.createElement("div"); row.className="row";
        const lab=document.createElement("label"); lab.textContent="Audio Haptics Gain"; row.appendChild(lab);
        // 0 = Auto (firmware default): the loudest recent haptic plays at full strength; in Wave style Auto = 100%, a real DualSense's strength
        const sl=document.createElement("input"); sl.type="range"; sl.min=0; sl.max=500; sl.step=10; row.appendChild(sl);
        const vspan=document.createElement("span"); vspan.className="val"; row.appendChild(vspan);
        sl.value=0; vspan.textContent="Auto";
        sl.addEventListener("input",()=>{ vspan.textContent=(+sl.value===0)?"Auto":sl.value+"%"; });
        sl.addEventListener("change",()=>setField(30, (+sl.value)/2));
        sec.appendChild(row);
        rec.audioGain=sl; rec.audioGainV=vspan;
      }
      // Controller speaker (DS5, protocol v26): the DualSense speaker channels played on the grips
      if(def.key==="DS5"){
        const row=document.createElement("div"); row.className="row hide";
        const lab=document.createElement("label"); lab.textContent="Controller speaker"; row.appendChild(lab);
        const sel=document.createElement("select"); row.appendChild(sel);
        for(const v of [0,25,50,75,100,150,200]){ const o=document.createElement("option"); o.value=v; o.textContent=v?v+"%":"Off (default)"; sel.appendChild(o); }
        sel.addEventListener("change",()=>setField(114,(+sel.value)/2));
        const note=document.createElement("p"); note.className="note";
        note.textContent="Plays what a game sends to the DualSense speaker (the first two channels of its audio device) through the grips, up to about 1.6 kHz, like a small speaker. Quiet audio is raised automatically, and bass is cut so it sounds rather than rumbles. 100% is full volume with the system volume at 100%; above that it gets louder but more compressed. The grips are vibration actuators, not a speaker: voices come through but sound buzzy and thin, and most other sounds just play as vibration. Off by default for that reason.";
        const wrap=document.createElement("div"); wrap.className="hide"; wrap.append(row,note); row.classList.remove("hide"); sec.appendChild(wrap);
        rec.speaker=sel; rec.speakerWrap=wrap;
      }
      // Grip limiter (protocol v27): one setting, shared by DualSense wave haptics/speaker and Switch HD rumble grips
      if(def.key==="DS5"||def.key==="SWITCH"){
        const row=document.createElement("div"); row.className="row";
        const lab=document.createElement("label"); lab.textContent="Grip limiter"; row.appendChild(lab);
        const sel=document.createElement("select"); row.appendChild(sel);
        for(const v of [50,60,70,80,90,100]){ const o=document.createElement("option"); o.value=v; o.textContent=v===100?"Off (hard clip)":v+"%"+(v===70?" (default)":""); sel.appendChild(o); }
        sel.addEventListener("change",()=>setField(115,+sel.value));
        const note=document.createElement("p"); note.className="note";
        note.textContent="Grip vibration above this level is rounded off toward full strength instead of clipping, which plays as a pop. Lower is smoother on the strongest hits, higher keeps more of their punch. One setting for DualSense audio haptics and Switch HD rumble.";
        const wrap=document.createElement("div"); wrap.className="hide"; wrap.append(row,note); sec.appendChild(wrap);
        rec.limiter=sel; rec.limiterWrap=wrap;
      }
      // trackpad -> joystick mapping (one select per pad)
      for(let pad=0; pad<2; pad++){
        const row=document.createElement("div"); row.className="row";
        const lab=document.createElement("label"); lab.textContent=PAD_STICK_LABELS[pad]; row.appendChild(lab);
        const sel=document.createElement("select");
        for(const [v,lbl] of (et===1 ? [...PAD_STICK_OPTS,[3,"D-pad on touch (Switch Pro)"],[4,"D-pad on click (Switch Pro)"]] : PAD_STICK_OPTS)){ const o=document.createElement("option"); o.value=v; o.textContent=lbl; sel.appendChild(o); }
        row.appendChild(sel); sec.appendChild(row);
        sel.addEventListener("change",()=>setField(PAD_STICK_FIELD0+et*2+pad, +sel.value));
        rec.padStick.push(sel);
      }
      // Switch Pro-only settings sit on the Switch tab, after the trackpad D-pad options they relate to
      if(def.key==="SWITCH"){
        const h=document.createElement("div"); h.className="colhead"; h.style.marginTop="12px"; h.textContent="Switch Pro mode only"; sec.appendChild(h);
        for(const id of ["swClickControls","qamSelectRow","swGyroMapBlock","swGyroOld","hdPadBlock"]) sec.appendChild(document.getElementById(id));
      }
      host.appendChild(sec); typeEls.push(rec);
    });
    setTab(0);
  })();
  for(const sel of document.querySelectorAll("select.chord")){
    MODE_NAMES.forEach((n,i)=>{ if(i===7||i===8) return;
      const o=document.createElement("option"); o.value=i; o.textContent=n; sel.appendChild(o); });
  }
  // D-pad chords offer EVERY mode, including the game/clean ones the face selects skip: those modes drop WebUSB,
  // so a chord is the only way into them, and back4+A still gets you back to Steam.
  for(const sel of document.querySelectorAll("select.chordD")){
    MODE_NAMES.forEach((n,i)=>{
      const o=document.createElement("option"); o.value=i; o.textContent=n; sel.appendChild(o); });
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
