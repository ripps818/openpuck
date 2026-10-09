import { S } from './state.js';
import { $, fmtDur, log, setSlider } from './util.js';
import { LIZARD_TAB, RUMBLE_SCALES, TYPE_DEFS, currentType, etypeForMode, setTab, swStatusApply, typeEls } from './types.js';
import { refreshRfStatus } from './rf.js';
import { renderCtlrChips, renderSlotTabs } from './slots.js';
import { renderHangLog, trailAdd } from './diag.js';
import { checkUpdateNotice, updateFwGate, updateVersionUI } from './firmware.js';
import { syncMapNav, syncNav } from './nav.js';
import { syncMotionCap } from './motion.js';

export const MODE_NAMES = ["Steam","Xbox 360","Switch HORIPAD","Lizard","Switch Pro","PS5 DualSense","PS4 DualShock","PS5 DualSense (single HID)","PS4 DualShock (single HID)","PS3 DualShock","Original Xbox","DirectInput","SInput"];
// display order for mode lists (MODE_NAMES is indexed by the firmware's mode number); single-HID after their base
export const MODE_ORDER = [0, 3, 1, 10, 4, 2, 9, 6, 8, 5, 7, 11, 12];
// one line per mode for the Mode page (shown for the running mode, or the mode button under the pointer/focus)
const MODE_DESC = [
  "The Steam Controller puck: Steam Input sees a genuine Steam Controller. Without Steam running it works as a keyboard and mouse.",
  "Xbox 360 controller (XInput), the most widely supported. Back buttons and trackpads follow the Xbox mapping tab.",
  "Basic Switch pad: buttons and sticks, no gyro or rumble.",
  "Keyboard and mouse only, even while Steam is running. Bindings are on the Lizard mapping tab.",
  "Switch Pro Controller with gyro and HD rumble, for a Switch console or PC.",
  "DualSense with gyro, touchpad and 4-channel audio haptics (PC).",
  "DualShock 4 with gyro and touchpad (PC).",
  "The DualSense as a bare single-HID device, for PC games that refuse composite devices (e.g. Fortnite). One controller; the panel can't connect in this mode.",
  "The DualShock 4 as a bare single-HID device. One controller; the panel can't connect in this mode.",
  "DualShock 3 / Sixaxis with motion and rumble, for a real PS3. The panel can't connect in this mode.",
  "Controller S for a real Original Xbox console (a PC needs a driver for it). Uses the Xbox mapping tab; LB/RB become White/Black.",
  "For flight and space sims: every analog input live at once, split over two joysticks (sticks, triggers and buttons; trackpads and gyro). Trackpad axes hold their position until a pad click re-centres them.",
  "The open SDL-native protocol: SDL3 and Steam Input read sticks, analog triggers, gyro, both trackpads and battery, with rumble back from the host.",
];
export function showModeDesc(m){
  const el = $("#modeDesc"); if(!MODE_NAMES[m]){ el.textContent = ""; return; }
  el.innerHTML = `<b>${MODE_NAMES[m]}</b>: ${MODE_DESC[m]}`;
}
export const CHORD_FIELD = [17, 18, 19];          // back4 + B/X/Y
export const CHORD_DPAD_FIELD = [34, 35, 36, 37]; // back4 + D-pad left/up/right/down (firmware protocol >= 18)
const CHORD_DPAD_DEF = [9, 8, 7, 2];       // firmware defaults: PS3, DS4 game, PS5 game, Switch HORIPAD
export function applySw(s){
  S.lastSw=s;
  swStatusApply(s);
  $("#shortcutToggles").classList.toggle("hide",!s);
  $("#hdPadBlock").classList.toggle("hide",!s);
  $("#qamSelectRow").classList.toggle("hide",!s);
  if(!s) return;
  if(document.activeElement!==$("#qamSelect")) $("#qamSelect").value=s[45];
  if(document.activeElement!==$("#hdPadScale")) $("#hdPadScale").value=s[40]*2;
  const flags=s[46],enabled=!!(flags&32);
  for(const [id,bit] of SC_BITS){const el=$("#"+id);el.textContent=id==="scQam"?((flags&bit)?"Quick Access":"All four back buttons"):((flags&bit)?"on":"off");el.classList.toggle("active",!!(flags&bit));}
  for(const rec of typeEls)rec.qam.parentElement.classList.toggle("hide",enabled && !!(flags&1));
  for(const el of document.querySelectorAll(".chord,.chordD")){const lab=el.parentElement.querySelector("label");if(lab)lab.textContent=lab.textContent.replace(/^(back4|Quick Access)/,(flags&1)?"Quick Access":"back4");}
}
export function applyBlob(p){
  for(const rec of typeEls) for(const sel of rec.padStick) for(const o of sel.options) if(+o.value>=3) o.disabled=p[0]<23;
  S.lastP=p; // remember for Export (carries every config field the panel shows)
  window._lastBlobTs=Date.now(); // feeds the host-side heartbeat watchdog (hard-wedge detection)
  // Lazy, capability-gated lizard-map load: only after a blob proves the puck speaks v16+ (the op-0x11 dump).
  // On older firmware 0x11 is dropped silently and readLizard() would block the endpoint forever, so we must
  // NEVER send it blind at connect. One-shot per connection (reset in openDevice). Run by the poll loop once this
  // poll is done (startPolling): started from here it raced this poll's own reads on the shared IN pipe.
  if(!S.lizardLoaded && p[0]>=16){ S.lizardLoaded=true; S.lizardLoadDue=true; }
  const mode=p[1], mDiv=p[2], mFric=p[3]; // p[4..11] mirror the active type (per-type block below is authoritative)
  const slot=p[10], up=p[11], f1=(p[12]|(p[13]<<8));
  const newps=(p.length>16?(p[15]|(p[16]<<8)):0), persistMode=(p.length>22?p[22]:0);
  const chord=(p.length>25)?[p[23],p[24],p[25]]:[3,1,4];
  // D-pad chords land at the tail of the v18 payload (firmware p[182..185] = payload p[180..183]).
  const dpadCap=(p[0]>=18 && p.length>183);
  const chordD=dpadCap?[p[180],p[181],p[182],p[183]]:CHORD_DPAD_DEF;
  const polls=(p.length>27?(p[26]|(p[27]<<8)):0);
  const loopUs=(p.length>29?(p[28]|(p[29]<<8)):0);
  const worstIdx=(p.length>30?p[30]:0), worstUs=(p.length>32?(p[31]|(p[32]<<8)):0);
  const WORST=["webusb","ctrl.task","serial","rfdiag","rflink","haptic","led"];
  const pollUs=(p.length>34?(p[33]|(p[34]<<8)):0);
  const pollIntended=(p.length>14?p[14]*100:0);
  const logEnabled=(p.length>35?p[35]:0);
  for(const el of document.querySelectorAll(".logonly")) el.style.display = logEnabled ? "" : "none";
  for(const b of document.querySelectorAll(".modebtn")) b.classList.toggle("active", +b.dataset.mode===mode);
  if(!document.querySelector(".modebtn:hover, .modebtn:focus-visible")) showModeDesc(mode);
  $("#hdrMode").textContent = MODE_NAMES[mode] || ("mode "+mode);
  $("#mouseCard").style.opacity = (mode===1||mode===3)?1:0.5;
  // The custom map applies ONLY to pure Lizard mode. Firmware v28+ edits the saved map from any mode;
  // before that the map ops hit the running map, which outside Lizard mode is the built-in defaults, so a save
  // there would overwrite the saved map with them. Older firmware gets a switch-mode note instead of the editor.
  const lizCap=p[0]>=16, lizAnyMode=p[0]>=28, lizEdit=mode===3||lizAnyMode;
  $("#mapTabLizard").classList.toggle("hide", !lizCap);
  $("#mapTabLizard .active-dot").style.display = mode===3 ? "" : "none";
  if(!lizCap && currentType()===LIZARD_TAB) setTab(0);
  $("#lzEditor").classList.toggle("hide", !lizEdit);
  $("#lzModeNote").classList.toggle("hide", lizEdit);
  $("#lzOtherMode").classList.toggle("hide", mode===3);
  $("#lzCurMode").textContent = MODE_NAMES[mode] || ("mode "+mode);
  const battery=(p.length>36?p[36]:0);
  // Switch Pro gyro mapping (protocol v19, firmware p[186] = payload p[184]). Older firmware has no such
  // setting at all -> the select hides (see #swGyroMap below). p[51..53] are the reserved bytes that used to
  // carry rumble strength / Switch report rate / Switch gyro scale, all removed settings.
  const gyroMapCap=(p[0]>=19 && p.length>184);
  const swGyroLegacy=gyroMapCap?p[184]:0;
  // Rumble shaping (protocol v21): firmware p[53]/p[195] = payload p[51]/p[193]. Strength is percent/2.
  const rumbleCap=(p[0]>=21 && p.length>193);
  const rumbleScale=rumbleCap?p[51]*2:200;
  // Reconciled firmware advertises RF recovery in the append-only v22 byte (firmware p[196] -> JS p[194]).
  // Keep the old p[179] check so the same panel can still talk to the hardware-validated pre-reconcile RF build.
  S.rfCapable=(p.length>194 && p[194]===0x52) || (p.length>179 && p[179]===0x52);
  const rfCard=$("#rfRecoveryCard"); if(rfCard) rfCard.classList.toggle("hide", !S.rfCapable);
  if(S.rfCapable&&Date.now()-S.rfLastRefresh>(S.rfHandoffActive||S.rfHopPending||S.rfSurveyRunning||S.rfSurveyPending?100:S.rfBuilderActive?500:2000)) refreshRfStatus(false);
  const rssi=(p.length>37?p[37]:0);

  // per-slot link status (protocol v8, p.length >= 73)
  const hasSlotsData = p.length >= 73;
  if (hasSlotsData) {
    const bondedN = p[60];
    S.g_slotData = [];
    for (let s=0; s<4; s++) {
      const base = 61 + s*3;
      if (p.length >= base+3) {
        // only include bonded slots (a slot with up=0 could be bonded but offline)
        // check if the slot appears at all in the bonded map by checking if bondedN covers it;
        // the firmware only sets non-zero battery/rssi for actually-bonded slots
        const slotUp = !!p[base];
        const slotBatt = p[base+1];
        const slotRssi = p[base+2];
        // slot is "bonded" if firmware included it in bondedN coverage
        // we populate slotData for all 4 and renderSlotTabs skips gaps
        S.g_slotData[s] = {up: slotUp, battery: slotBatt, rssi: slotRssi};
      }
    }
    // keep only bonded slots by cross-referencing bondedN
    // firmware sends bondedSlotCount but not a slot bitmask; use battery>0 || rssi>0 || up as presence hint
    // simpler: just count how many of the 4 slots have any non-zero data OR are marked up
    // Actually the firmware always writes all 4 slots; we filter by the bond system's "used" flag via presence.
    // For clean display: we'll show tabs only for slots that have ever had a reply OR are bonded (battery/rssi set).
    // The firmware sets g_battery[s]=0 and g_linkRssi[s]=0 for unused slots, so 0/0/0 = not bonded.
    // But a bonded offline slot also has 0/0/0 initially. We rely on bondedN for count and show the first bondedN slots
    // that have g_slot[s].used — but we can't easily know which slots are used from the blob.
    // Best heuristic: show all 4 slots if bondedN==4, otherwise use slot indices where battery or rssi != 0 OR up==1,
    // OR fall back to showing slots 0..bondedN-1 if none have data yet (device just booted).
    let bondedSlots = [];
    for (let s=0; s<4; s++) {
      if (S.g_slotData[s] && (S.g_slotData[s].up || S.g_slotData[s].battery || S.g_slotData[s].rssi)) bondedSlots.push(s);
    }
    // fallback: if no data yet (all offline, just booted), show slots 0..bondedN-1
    if (bondedSlots.length === 0 && bondedN > 0) {
      for (let s=0; s<bondedN; s++) bondedSlots.push(s);
    }
    // remove slotData for non-bonded slots so tabs don't appear for them
    const bondedSet = new Set(bondedSlots);
    for (let s=0; s<4; s++) { if (!bondedSet.has(s)) S.g_slotData[s] = null; }
    // clamp active slot to a valid bonded slot
    if (!S.g_slotData[S.g_activeSlot]) S.g_activeSlot = bondedSlots[0] || 0;
    // v13: per-slot link stats (fw p[145..180] -> js index 143..178): each controller's own
    // polls/delivered/new/crc/noRx/relay, so the tabs no longer show every controller merged into one number
    if (p.length >= 179) {
      for (let s=0; s<4; s++) {
        if (!S.g_slotData[s]) continue;
        const b = 143 + s*9;
        S.g_slotData[s].stats = { polls: p[b]|(p[b+1]<<8), f1: p[b+2]|(p[b+3]<<8),
                                newps: p[b+4]|(p[b+5]<<8), crc: p[b+6], norx: p[b+7], relay: p[b+8] };
      }
    }
    renderSlotTabs(bondedN);
  } else {
    // old firmware: single-slot display
    $("#slotTabs").style.display="none";
    $("#stLink").innerHTML = up? '<span class="pill up">connected</span>' : '<span class="pill dn">idle / asleep</span>';
    $("#stBatt").textContent = (up && battery)? battery+"%" : (battery ? battery+"% (saved)" : "—");
    $("#stRssi").textContent = (up && rssi)? ("-"+rssi+" dBm") : "offline";
    renderCtlrChips([{slot:0, up:!!up, battery, rssi}]);
  }

  // global stats
  $("#stRate").textContent = up? f1+" /s" : "0 /s (idle)";
  $("#stNew").textContent = up? newps+" /s" : "0 /s (idle)";
  // Poll TX + RF-fail counts: shown ALWAYS (even when the link reads down) so a wedge is diagnosable --
  // polls>0 here while Delivered is "—" means the puck is still polling but getting no usable replies.
  $("#stPolls").textContent = polls+" /s";
  { const crc=(p.length>117?p[117]:0), norx=(p.length>118?p[118]:0), heal=(p.length>119?p[119]:0);
    const rf=(p.length>130?(p[129]|(p[130]<<8)):0);
    $("#stRfFail").innerHTML = crc+" · "+norx+" · "+heal + (rf?' · <span class="pill dn">ring '+rf+'</span>':"");
    // ring fault = we caught+recovered a relay-ring corruption that would otherwise be an invisible IRQ-off
    // watchdog hang. Log each new one (persists across the device reset + panel reconnect).
    if(rf>(window._ringFault||0)) log("⚠ RING FAULT #"+rf+" recovered — caught a relay-ring desync/corruption (would have hung loop with IRQs off)");
    window._ringFault=rf; }
  // v12: relay-frame rate + clock fingerprint (browser index = firmware index − 2)
  { const relay=(p.length>121?(p[120]|(p[121]<<8)):null);
    $("#stRelay").textContent = relay==null ? "—" : (relay+" /s"); }
  if(p.length>125){
    const LF=["stopped","RC","xtal","synth"], HF=["RC","?","xtal","?"];
    const lf=p[122], hf=p[123], upm=(p[124]|(p[125]<<8));
    const lfBad=(lf!==2), hfBad=(hf!==2), upmBad=(upm && (upm<985||upm>1015));
    const tag=(t,bad)=> bad ? '<span class="pill dn">'+t+'</span>' : t;
    $("#stClock").innerHTML = tag(LF[lf]||lf, lfBad)+" / "+tag(HF[hf]||hf, hfBad);
    $("#stUsPerMs").innerHTML = upm ? tag(""+upm, upmBad) : "—";
  }
  // v12: LIVE loop heartbeat — curStage (firmware p[129]) + ms-since-beat (p[130], 40ms units). Updates even
  // while loop() is wedged (blob is pushed from the SOF interrupt), so a hang shows "STALLED @ <stage>" live.
  if(p.length>128){
    const STAGE=["webusb","ctrl.task","serial","rfdiag","rflink","haptic","led","usbmount","usbtx"];
    const cur=p[127], stallMs=p[128]*40, name=(STAGE[cur]||("stage "+cur));
    if(stallMs>=200){
      $("#stLoopState").innerHTML='<span class="pill dn">STALLED @ '+name+' '+stallMs+'ms</span>';
      if(!window._stallEpisode) trailAdd("STALLED @ "+name+" ("+stallMs+"ms, soft wedge — usbd still alive)");
      // Latch+log the stall so it survives the imminent watchdog reset + panel reconnect (host-side log
      // persists). Log once per episode + keep escalating if it climbs toward the ~8s watchdog.
      if(!window._stallEpisode || stallMs>window._stallPeak+800){
        window._stallEpisode=true; window._stallPeak=stallMs;
        log("⚠ LOOP STALL @ "+name+" ("+stallMs+"ms) — watchdog reset imminent");
      }
    } else {
      if(window._stallEpisode) trailAdd("running again — stall recovered without a reset (peaked "+window._stallPeak+"ms)");
      window._stallEpisode=false; window._stallPeak=0;
      $("#stLoopState").innerHTML='<span class="pill up">running</span>';
    }
  }
  // v12: least-ever free stack on the usbd task (words). Low = overflow risk (multi-controller haptic-relay
  // hang hypothesis). Firmware p[141] -> browser p[139]. Red under 24 words (~96B), amber under 48.
  if(p.length>140){ const usbdW=(p[139]|(p[140]<<8));
    $("#stUsbdStack").innerHTML = usbdW<24 ? ('<span class="pill dn">'+usbdW+'</span>')
      : (usbdW<48 ? ('<span class="pill" style="background:#3a3216;color:#e5c76b">'+usbdW+'</span>') : (""+usbdW));
  }
  $("#stLoop").textContent = loopUs? loopUs+" µs" : "—";
  $("#stWorst").textContent = loopUs? (WORST[worstIdx]||worstIdx)+" "+worstUs+"µs" : "—";
  $("#stPollPer").textContent = up? (pollUs+" / "+pollIntended+" µs") : "—";
  // last-boot reset cause (protocol v11): a single classified code (firmware classifies it from RESETREAS +
  // a GPREGRET2 marker) plus the raw RESETREAS. Codes match RR_* in fault_diag.h. Earlier firmware (<v11)
  // didn't send this -> guard on length and leave the tile blank.
  const RR_NAMES = ["unknown","power-on","pin/replug","watchdog (hang)","CPU lockup",
                    "HARDFAULT","reboot","soft reset","wake-from-off"];
  const RR_FAULT = new Set([3,4,5]); // watchdog / lockup / hardfault = a real crash worth reporting (#72)
  if (p.length > 113) {
    const code = p[109];
    const raw = ((p[110]|(p[111]<<8)|(p[112]<<16)|(p[113]<<24))>>>0);
    const name = RR_NAMES[code] || ("code "+code);
    // v12: which loop stage was stuck when the last watchdog/lockup hang fired (0xFF = last boot wasn't a hang)
    const STAGE_NAMES = ["webusb","ctrl.task","serial","rfdiag","rflink","haptic","led","usbmount","usbtx"];
    const hangStage = (p.length>126 ? p[126] : 0xFF);
    let label = name;
    if (hangStage!==0xFF) label += " @ "+(STAGE_NAMES[hangStage]||("stage "+hangStage));
    $("#stReset").innerHTML = RR_FAULT.has(code) ? ('<span class="pill dn">'+label+'</span>') : label;
    // v12: PC/LR captured by the WDT pre-reset ISR (browser idx = firmware−2: hangPC@131, hangLR@135)
    const hpc=(p.length>134?((p[131]|(p[132]<<8)|(p[133]<<16)|(p[134]<<24))>>>0):0);
    const hlr=(p.length>138?((p[135]|(p[136]<<8)|(p[137]<<16)|(p[138]<<24))>>>0):0);
    const hx=v=>"0x"+v.toString(16).padStart(8,"0");
    const el = $("#resetHist");
    if (el) el.textContent = "RESETREAS=0x"+raw.toString(16).padStart(8,"0")
      + (hangStage!==0xFF ? "  hung in: "+(STAGE_NAMES[hangStage]||hangStage) : "")
      + (hpc ? "  hang PC="+hx(hpc)+" LR="+hx(hlr) : "")
      + (S.stabLastRun ? "  ·  stability: stayed up "+fmtDur(S.stabLastRun.secs)+" before this reset" : "");
    if (hpc && hpc!==window._hangPC){ window._hangPC=hpc; log("⚑ HANG PC="+hx(hpc)+" LR="+hx(hlr)+" — send me this; I'll map it to the stuck function"); }
    // append the queued reset to the running hang log, now that we have this boot's reason/PC/stack
    if (S.pendingHang){
      const usbdW2=(p.length>140?(p[139]|(p[140]<<8)):0);
      S.hangLog.unshift({ time:new Date(S.pendingHang.t).toLocaleTimeString(), uptime:S.pendingHang.uptimeSecs,
        reason:name, stage:(hangStage!==0xFF)?(STAGE_NAMES[hangStage]||("stage"+hangStage)):"",
        pc:hpc?hx(hpc):"", lr:hlr?hx(hlr):"", usbd:usbdW2 });
      trailAdd("reconnected — last reset: "+name
        +(hangStage!==0xFF?(" @ "+(STAGE_NAMES[hangStage]||("stage "+hangStage))):"")
        +(hpc?(" PC="+hx(hpc)):"")
        +(S.pendingHang.uptimeSecs!=null?("  (up "+fmtDur(S.pendingHang.uptimeSecs)+" before it)"):""));
      try{ localStorage.setItem("opk_trail_rrfp", code+"/"+raw.toString(16)+"/"+hangStage+"/"+hpc.toString(16)); }catch(e){}
      S.pendingHang=null; renderHangLog();
    }
    // Page wasn't open when it reset (refresh / closed browser): a fault-class boot still lands in the trail,
    // once per distinct reset -- fingerprinted + persisted so every later page load doesn't re-log the same one.
    else if (RR_FAULT.has(code)){
      const fp=code+"/"+raw.toString(16)+"/"+hangStage+"/"+hpc.toString(16);
      if(localStorage.getItem("opk_trail_rrfp")!==fp){
        try{ localStorage.setItem("opk_trail_rrfp", fp); }catch(e){}
        trailAdd("connected — last boot was a "+label+(hpc?(" PC="+hx(hpc)):"")+" (page wasn't open to catch it live)");
      }
    }
    // Auto-load the flight-recorder trail once per connection when the last boot was a real crash (watchdog/
    // lockup/hardfault) -- the trail is the post-mortem of what wedged the board. Deferred to the poll loop so
    // it doesn't nest transferIn inside this refresh.
    if (RR_FAULT.has(code) && !window._flightAuto){ window._flightAuto=true; window._autoFlight=true; }
  }

  // per-type trackpad->stick mapping (blob v20, firmware p[187..194] -> JS p[185..192])
  const padStickCap=(p[0]>=20 && p.length>192);
  const gitDirty=(p.length>38?p[38]:0); let buildId="";
  for(let i=39;i<51 && i<p.length && p[i];i++) buildId+=String.fromCharCode(p[i]);
  $("#stBuild").innerHTML = buildId
    ? (buildId + (gitDirty ? ' <span class="pill dn">dirty</span>' : ' <span class="pill up">clean</span>'))
    : "—";
  $("#updInstalled").textContent = buildId || "—"; // mirrored on the Firmware-update tab
  updateVersionUI();
  updateFwGate(); // (re)evaluate the firmware-tab gate on every blob — version is at p[0]
  checkUpdateNotice(); // needs BOTH the installed version (this blob) and relCache (fetched on connect)
  setSlider("mDiv",mDiv); setSlider("mFric",mFric);
  $("#persistMode").textContent = persistMode? "on":"off"; $("#persistMode").classList.toggle("active",!!persistMode);
  { const la=((p.length>179 && p[179] === 0xEE) || (p.length>197 && p[197] === 0xEE)); $("#isMachineInternal").textContent = la?"on":"off"; $("#isMachineInternal").classList.toggle("active",!!la); }
  // per-type button config (blob v10/v17): 4 types x 9 bytes. readBlob() strips the 2-byte [0xA5][len] header, so
  // the firmware's buffer index 75 lands at JS index 73 here.
  if(p.length>=73+TYPE_DEFS.length*9){
    const activeEt=etypeForMode(mode);
    typeEls.forEach((rec,et)=>{
      const q=73+et*9;
      const back=[p[q],p[q+1],p[q+2],p[q+3]], qam=p[q+4], ab=p[q+5], pad=p[q+6], led=p[q+7], rum=p[q+8];
      rec.back.forEach((sel,i)=>{ if(document.activeElement!==sel) sel.value=back[i]; });
      if(document.activeElement!==rec.qam) rec.qam.value=qam;
      rec.abSwap.textContent=ab?"on":"off"; rec.abSwap.classList.toggle("active",!!ab);
      if(document.activeElement!==rec.pad) rec.pad.value=pad;
      rec.rumble.textContent=rum?"on":"off"; rec.rumble.classList.toggle("active",!!rum);
      if(rec.audioHaptics){
        const audOn = (p.length>196)?(p[196]!==0):true;
        rec.audioHaptics.textContent=audOn?"on":"off";
        rec.audioHaptics.classList.toggle("active",audOn);
      }
      if(rec.audioStyle){
        const v = (p.length>203 && p[203]<=3)?p[203]:1;
        rec.audioStyle.dataset.v=v;
        rec.audioStyle.textContent=["rumble","tone","split","wave"][v];
        rec.audioStyle.classList.toggle("active",v!==0);
      }
      if(rec.speaker){
        const cap=p[0]>=26 && p.length>206;
        rec.speakerWrap.classList.toggle("hide",!cap);
        if(cap && document.activeElement!==rec.speaker) rec.speaker.value=p[206]*2;
      }
      if(rec.limiter){
        const cap=p[0]>=27 && p.length>207;
        rec.limiterWrap.classList.toggle("hide",!cap);
        if(cap && document.activeElement!==rec.limiter) rec.limiter.value=p[207];
      }
      if(rec.audioGain && p.length>195){
        const gain = p[195]*2;
        if(document.activeElement!==rec.audioGain){
          rec.audioGain.value = gain;
          rec.audioGainV.textContent = (gain===0)?"Auto":gain + "%";
        }
      }
      if(document.activeElement!==rec.led){ rec.led.value=led; rec.ledV.textContent=(led===0)?"Auto":led+"%"; }
      rec.padStick.forEach((sel,pad)=>{
        // hidden entirely on firmware too old to speak the mapping, so the panel never shows a dead control
        sel.parentNode.classList.toggle("hide", !padStickCap);
        if(padStickCap && document.activeElement!==sel) sel.value=p[185+et*2+pad];
      });
      // dot marks the type matching the current puck mode
      rec.activeDot.style.display = (et===activeEt) ? "" : "none";
    });
    // open the tab for the current mode's type on first load (then leave the user's choice alone)
    if(!S.tabInited){ S.tabInited=true; setTab(mode===3 && lizCap ? LIZARD_TAB : (activeEt>=0?activeEt:0)); syncMapNav(); }
  }
  $("#imuOnRow").classList.toggle("hide", p[0]<28); // op 0x29 (status v28+)
  syncMotionCap(p); // op 0x2A (status v28+)
  // v28+: the motion view writes this line from the selected controller; the blob's copy is whichever slot was
  // polled last, so with a second controller bonded it would keep flipping to that one's (offline) zeros
  if(p.length>=60 && p[0]<28){ const s16=(o)=>{ let v=p[o]|(p[o+1]<<8); return v>32767?v-65536:v; };
    const ax=s16(54),ay=s16(56),az=s16(58);
    const amag=Math.round(Math.sqrt(ax*ax+ay*ay+az*az));
    $("#stImu").textContent = `a=(${ax}, ${ay}, ${az})  |a|=${amag}`;
  }
  { const sel=$("#swGyroMap");
    $("#swGyroMapBlock").classList.toggle("hide", !gyroMapCap);
    $("#swGyroOld").classList.toggle("hide", gyroMapCap);
    if(gyroMapCap && document.activeElement!==sel) sel.value=swGyroLegacy; }
  { const scl=$("#rumbleScale");
    $("#rumbleBlock").classList.toggle("hide", !rumbleCap);
    $("#rumbleOld").classList.toggle("hide", rumbleCap);
    if(rumbleCap){
      // a strength set from the console can land between the presets -- show the nearest one
      if(document.activeElement!==scl) scl.value=RUMBLE_SCALES.reduce((a,b)=>Math.abs(b-rumbleScale)<Math.abs(a-rumbleScale)?b:a);
    }
    // v25: grip strength is per type (Button mapping tabs); the global row then hides
    const perType=(p[0]>=25 && p.length>213);
    scl.parentElement.classList.toggle("hide", perType);
    typeEls.forEach((rec,et)=>{
      rec.rumbleScl.parentElement.classList.toggle("hide", !perType);
      if(!perType) return;
      const pct=p[210+et]*2;
      if(document.activeElement!==rec.rumbleScl) rec.rumbleScl.value=RUMBLE_SCALES.reduce((a,b)=>Math.abs(b-pct)<Math.abs(a-pct)?b:a);
    }); }
  { const trigCap=(p[0]>=24 && p.length>205), ti=$("#trigInner"), to=$("#trigOuter");
    $("#trigCard").classList.toggle("hide", !trigCap);
    if(trigCap){
      // a value set elsewhere can be odd -- show the nearest option
      const near=(sel,v)=>[...sel.options].map(o=>+o.value).reduce((a,b)=>Math.abs(b-v)<Math.abs(a-v)?b:a);
      if(document.activeElement!==ti) ti.value=near(ti,p[204]);
      if(document.activeElement!==to) to.value=near(to,p[205]);
    } }
  { const ledCap = (p.length >= 201);
    $("#ledBlock").classList.toggle("hide", !ledCap);
    $("#ledOld").classList.toggle("hide", ledCap);
    if(ledCap){
      const ledMode = p[197], ledPinA = p[198], ledPinB = p[199], ledPolarity = p[200];
      const ledModeB = p.length >= 202 ? p[201] : 3;
      const ledPolarityB = p.length >= 203 ? p[202] : 1;
      const modeSel = $("#ledMode"), modeASel = $("#ledModeA"), modeBSel = $("#ledModeB");
      const polASel = $("#ledPolarityA"), polBSel = $("#ledPolarityB");
      const preSel = $("#ledPreset");
      const pinAIn = $("#ledPinA"), pinBIn = $("#ledPinB");
      if(document.activeElement !== modeSel) modeSel.value = ledMode;
      if(modeASel && document.activeElement !== modeASel) modeASel.value = ledMode;
      if(modeBSel && document.activeElement !== modeBSel) modeBSel.value = ledModeB;
      if(polASel && document.activeElement !== polASel) polASel.value = ledPolarity;
      if(polBSel && document.activeElement !== polBSel) polBSel.value = ledPolarityB;
      if(document.activeElement !== pinAIn) pinAIn.value = ledPinA;
      if(document.activeElement !== pinBIn) pinBIn.value = ledPinB;
      const customFocused = $("#ledCustomPins").contains(document.activeElement);
      if(document.activeElement !== preSel && !customFocused){
        let preset = "custom";
        if(ledPinA === 24 && ledPinB === 255 && ledPolarity === 1) preset = "supermini";
        else if(ledPinA === 11 && ledPinB === 255 && ledPolarity === 0) preset = "nordic_dongle";
        else if(ledPinA === 3 && ledPinB === 255 && ledPolarity === 1) preset = "feather";
        else if(ledPinA === 4 && ledPinB === 255 && ledPolarity === 1) preset = "feather_conn";
        if(preSel.value !== "custom" || preset === "custom"){
          preSel.value = preset;
          const isCustom = (preset === "custom");
          $("#ledCustomPins").classList.toggle("hide", !isCustom);
          if($("#ledModeRow")) $("#ledModeRow").classList.toggle("hide", isCustom);
        }
      }
    } }
  for(const sel of document.querySelectorAll("select.chord")){ if(document.activeElement!==sel) sel.value=chord[+sel.dataset.i]; }
  $("#dpadChords").classList.toggle("hide", !dpadCap);
  $("#dpadOld").classList.toggle("hide", dpadCap);
  if(dpadCap) for(const sel of document.querySelectorAll("select.chordD")){ if(document.activeElement!==sel) sel.value=chordD[+sel.dataset.i]; }
  syncNav(); // cards above may have appeared or hidden (lizard, triggers, RF, logging build)
}
export const SC_BITS=[['scQam',1],['scFeedback',8],['scCapture',16],['scEnabled',32]];
