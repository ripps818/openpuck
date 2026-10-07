import { S } from './state.js';
import { $, DEBUG_UI, fmtSlider, log } from './util.js';
import { autoConnect, connect, initProtocol, refresh, send, setField } from './protocol.js';
import { CHORD_DPAD_FIELD, CHORD_FIELD, MODE_NAMES, SC_BITS, showModeDesc } from './status.js';
import { clearJournalRf, manualJournalBuilderRf, manualSurveyRf } from './rf.js';
import { exportBackup, importBackup } from './backup.js';
import { downloadCap, startCapture, stopCapture } from './capture.js';
import { initDiag, loadFlightTrail, renderHangLog, trailAdd, updateStabUI } from './diag.js';
import { lzV2Add, lzV2Reload, lzV2Reset, lzV2Save } from './lizard.js';
import { initFirmware, updateFwGate, updateUf2UI } from './firmware.js';
import { initNav } from './nav.js';
import { initMotion } from './motion.js';
import { initTypes } from './types.js';

initDiag();
if(!DEBUG_UI) for(const el of document.querySelectorAll(".debugonly")) el.style.display="none";
initTypes();
initNav();
initProtocol();
initMotion();

// UI wiring
$("#connectBtn").onclick=connect;
initFirmware();

$("#backupExport").onclick=exportBackup;
$("#backupImport").onclick=()=>$("#backupFile").click();
$("#backupFile").onchange=async(e)=>{ const f=e.target.files[0]; if(f) await importBackup(f); e.target.value=""; };
$("#capDl").onclick=downloadCap;
$("#capStart").onclick=startCapture;
$("#capStop").onclick=stopCapture;
$("#lzAdd").onclick=lzV2Add;
$("#lzSave").onclick=lzV2Save;
$("#lzReload").onclick=lzV2Reload;
$("#lzReset").onclick=lzV2Reset;
$("#lzGoMode").onclick=()=>$('.modebtn[data-mode="3"]').click(); // confirms, then the puck reboots into Lizard
$("#stabBtn").onclick=async()=>{
  if(!S.dev){ log("connect first"); return; }
  S.stabArmed=!S.stabArmed;
  if(S.stabArmed){ await send([0x0F,1]); S.stabStart=Date.now(); S.stabLastRun=null; log("stability test STARTED — buzzing every 10s, timing uptime until reset"); trailAdd("stability test started (buzz every 10s)"); }
  else { await send([0x0F,0]); S.stabStart=0; log("stability test stopped"); trailAdd("stability test stopped"); }
  updateStabUI();
};
$("#hangClear").onclick=()=>{ S.hangLog=[]; renderHangLog(); };
$("#flightLoad").onclick=loadFlightTrail;
$("#hangCsv").onclick=()=>{
  const rows=[["time","uptime_s","reason","stage","pc","lr","usbd_free_words"]].concat(
    S.hangLog.map(e=>[e.time, e.uptime!=null?Math.round(e.uptime):"", e.reason, e.stage, e.pc, e.lr, e.usbd]));
  const csv=rows.map(r=>r.map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(",")).join("\n");
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download="openpuck-hanglog.csv"; a.click();
};
$("#hapClear").onclick=async()=>{ if(S.dev){ await send([0x07]); log("haptic re-init sent (clear stuck buzz)"); } };
$("#ctlrOff").onclick=async()=>{ if(S.dev){ await send([0x08]); log("controller power-off attempt sent — watch link status");
  trailAdd("power-off sent to controller (panel button) — stress action, correlate with what follows"); } };
$("#debugCdc").onclick=async()=>{
  if(!S.dev){ log("not connected"); return; }
  if(!confirm("Reboot with the CDC serial console enabled?\n\nThe puck reboots and comes back with a serial port (115200 baud) instead of WebUSB — this panel will disconnect and NOT reconnect until the next reboot.\n\nConnect a serial monitor to capture logs, then replug (or reboot) to return to normal WebUSB mode. The debug console auto-reverts after one boot.")) return;
  await send([0x02,20,1]); log("debug-CDC reboot sent — device disconnecting; reconnect a serial monitor at 115200 baud");
};
$("#dfuSerial").onclick=async()=>{
  if(!S.dev){ log("not connected"); return; }
  if(!confirm("Reboot into serial DFU?\n\nThe puck will disconnect immediately. Flash with adafruit-nrfutil, then replug.")) return;
  await send([0x0B]); log("serial DFU reboot sent — device disconnecting");
};
$("#dfuUf2").onclick=async()=>{
  if(!S.dev){ log("not connected"); return; }
  if(!confirm("Reboot into UF2 bootloader?\n\nThe puck will disconnect and mount as a USB drive. Drag the .uf2 file onto it to flash.")) return;
  await send([0x0C]); log("UF2 bootloader reboot sent — device disconnecting");
};
$("#factoryErase").onclick=async()=>{
  if(!S.dev){ log("not connected"); return; }
  if(!confirm("Factory erase?\n\nThis wipes ALL persistent storage on the copycat:\n  • the paired-controller bond (you'll have to re-pair)\n  • every saved setting (mode, chords, back paddles, sensitivity)\n\nThe copycat reboots to factory defaults. This CANNOT be undone.")) return;
  if(!confirm("Are you absolutely sure?\n\nThere is no recovery. The controller bond and all settings will be gone.")) return;
  const typed=prompt('Final confirmation — type  ERASE  (all caps) to wipe everything:');
  if(typed!=="ERASE"){ log("factory erase cancelled (confirmation text did not match)"); return; }
  await send([0x0A,0x45,0x52,0x53]);
  log("FACTORY ERASE sent — copycat is reformatting and rebooting to defaults. Re-pair the controller, then reconnect.");
};
// Debug-only: full board wipe. Erases the firmware itself (not just settings), leaving the board app-less so
// it mounts as the UF2 bootloader drive on every boot until OpenPuck is flashed again. Sends 0x25 + "WIPE".
$("#wipeBoard").onclick=async()=>{
  if(!S.dev){ log("not connected"); return; }
  if(!confirm("WIPE THE ENTIRE BOARD?\n\nThis is NOT a factory reset. It erases:\n  • the OpenPuck FIRMWARE itself\n  • every setting (mode, chords, back paddles, sensitivity)\n  • the paired-controller bond\n\nThe board reboots with NO firmware and mounts as the UF2 bootloader drive. It will do so on EVERY boot until you flash OpenPuck (a .uf2) back onto it. This panel will disconnect and NOT reconnect until then.\n\nThis CANNOT be undone from software.")) return;
  if(!confirm("Are you absolutely sure?\n\nThe board will be blank. The ONLY way back is to drag a .uf2 firmware file onto the UF2 drive it mounts as.")) return;
  const typed=prompt('Final confirmation — type  WIPE  (all caps) to erase the whole board:');
  if(typed!=="WIPE"){ log("board wipe cancelled (confirmation text did not match)"); return; }
  await send([0x25,0x57,0x49,0x50,0x45]);
  log("FULL BOARD WIPE sent — the board is erasing firmware + all data (~15–20 s), then reboots as a blank UF2 drive. Flash OpenPuck (.uf2) to restore it.");
};
$("#persistMode").onclick=()=>{ const on=$("#persistMode").classList.contains("active"); setField(16, on?0:1); };
$("#isMachineInternal").onclick=async()=>{
  const on=$("#isMachineInternal").classList.contains("active");
  await setField(29, on?0:0xEE);
  log("Steam Machine receiver emulation "+(on?"disabled":"enabled")+" — takes effect on next reconnect/reboot");
};
// Connection tuning: post-connect haptic block on (field 27) + seconds (field 28). (poll RX window is fixed.)
for(const id of ["mDiv","mFric"]){
  const field={mDiv:1,mFric:2}[id];
  $("#"+id).addEventListener("input", ()=>{ $("#"+id+"V").textContent=fmtSlider(id,$("#"+id).value); });
  $("#"+id).addEventListener("change", ()=>setField(field, +$("#"+id).value));
}
// per-type back/QAM/A-B-swap/haptics handlers are wired in buildTypeCfgs()
$("#rumbleTest").onclick=async()=>{ if(S.dev){ await send([0x16]); log("test rumble sent"); } };
for(const [id,bit] of SC_BITS)$('#'+id).onclick=()=>{if(S.lastSw)setField(240,S.lastSw[46]^bit);};
$("#hdPadScale").addEventListener("change",()=>setField(231,+$("#hdPadScale").value/2));
$("#qamSelect").addEventListener("change",()=>setField(239,+$("#qamSelect").value));
$("#rumbleScale").addEventListener("change", ()=>setField(22, (+$("#rumbleScale").value)/2));
$("#trigInner").addEventListener("change", ()=>setField(102, +$("#trigInner").value));
$("#trigOuter").addEventListener("change", ()=>setField(103, +$("#trigOuter").value));
$("#swGyroMap").addEventListener("change", ()=>setField(38, +$("#swGyroMap").value));
$("#ledMode").addEventListener("change", ()=>{
  const v = +$("#ledMode").value;
  setField(32, v);
  const ma = $("#ledModeA"); if(ma) ma.value = v;
});
const ma = $("#ledModeA");
if(ma) ma.addEventListener("change", ()=>{
  const v = +ma.value;
  setField(32, v);
  $("#ledMode").value = v;
});
const mb = $("#ledModeB");
if(mb) mb.addEventListener("change", ()=>setField(93, +mb.value));
const pa = $("#ledPolarityA");
if(pa) pa.addEventListener("change", ()=>setField(91, +pa.value));
const pb = $("#ledPolarityB");
if(pb) pb.addEventListener("change", ()=>setField(94, +pb.value));
$("#ledPreset").addEventListener("change", ()=>{
  const v = $("#ledPreset").value;
  const isCustom = (v === "custom");
  $("#ledCustomPins").classList.toggle("hide", !isCustom);
  if($("#ledModeRow")) $("#ledModeRow").classList.toggle("hide", isCustom);
  if(v === "supermini"){
    setField(33, 24);
    setField(90, 255);
    setField(91, 1);
    const pa = $("#ledPolarityA"); if(pa) pa.value = 1;
  } else if(v === "nordic_dongle"){
    setField(33, 11);
    setField(90, 255);
    setField(91, 0);
    const pa = $("#ledPolarityA"); if(pa) pa.value = 0;
  } else if(v === "feather"){
    setField(33, 3);
    setField(90, 255);
    setField(91, 1);
    const pa = $("#ledPolarityA"); if(pa) pa.value = 1;
  } else if(v === "feather_conn"){
    setField(33, 4);
    setField(90, 255);
    setField(91, 1);
    const pa = $("#ledPolarityA"); if(pa) pa.value = 1;
  }
});
$("#ledPinA").addEventListener("change", ()=>setField(33, +$("#ledPinA").value));
$("#ledPinB").addEventListener("change", ()=>setField(90, +$("#ledPinB").value));
for(const id of ["ledPinA", "ledPinB"]){
  const el = $("#"+id);
  if(el) el.addEventListener("keydown", e => { if(e.key === "Enter") el.blur(); });
}
$("#ledTest").onclick=async()=>{ if(S.dev){ await setField(92, 1); log("LED test flash triggered (2s)"); } };
$("#rfSurvey").onclick=()=>manualSurveyRf();
$("#rfBuilder").onclick=()=>manualJournalBuilderRf();
$("#rfJournalClear").onclick=()=>clearJournalRf();
for(const sel of document.querySelectorAll("select.chord")){
  sel.addEventListener("change", ()=>setField(CHORD_FIELD[+sel.dataset.i], +sel.value));
}
for(const sel of document.querySelectorAll("select.chordD")){
  sel.addEventListener("change", ()=>setField(CHORD_DPAD_FIELD[+sel.dataset.i], +sel.value));
}
for(const b of document.querySelectorAll(".modebtn")){
  b.onclick=()=>{ const m=+b.dataset.mode;
    const clean=(m===7||m===8||m===9);
    const msg="Switch to "+MODE_NAMES[m]+"? The copycat will reboot."+(clean?"\n\nNOTE: the single-HID PlayStation modes (and PS3) drop WebUSB + host-wake, so THIS PANEL WILL DISCONNECT and can't reach the device while it's in this mode. To get back, chord on the controller: hold "+(S.lastSw && (S.lastSw[46]&1)?"Quick Access":"all four back paddles")+" + A to return to Steam mode. The back4+D-pad chords are how you get back INTO these modes without the panel — check their assignments in the chords card first.":"");
    if(confirm(msg)){ send([0x03, m]); log("mode switch requested — device will reboot"); } };
  const back=()=>{ if(S.lastP) showModeDesc(S.lastP[1]); };
  b.onmouseenter=b.onfocus=()=>showModeDesc(+b.dataset.mode);
  b.onmouseleave=b.onblur=back;
}
updateUf2UI();
updateFwGate(); // start gated: stays inert until the first status blob proves the firmware speaks v15+
window.addEventListener("visibilitychange", ()=>{ if(document.visibilityState==="visible" && S.dev && !S.inflight) refresh(); });
window.addEventListener("focus", ()=>{ if(S.dev && !S.inflight) refresh(); });
if(!("usb" in navigator)) $("#connectBtn").outerHTML='<b style="color:var(--bad)">WebUSB not supported — use Chrome or Edge.</b>';
else autoConnect(); // reopen an already-authorized puck on load, no picker (first-ever connect still needs the button)
