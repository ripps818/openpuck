import { S } from './state.js';
import { $, fmtDur, log } from './util.js';
import { applyBlob, applySw } from './status.js';
import { applyDeviceProfile, applyDongleStatus } from './dongle.js';
import { loadFlightTrail, onWedge, renderHangLog, trailAdd, updateStabUI } from './diag.js';
import { checkUpdateNotice, loadReleases } from './firmware.js';

let ifNum=0;

// Every VID an OpenPuck can enumerate under — the picker/auto-reconnect can only see a device whose VID is
// listed here, so a new mode with a new identity MUST be added (1209 = DirectInput, 2E8A = SInput).
export const USB_FILTERS=[{vendorId:0x28DE},{vendorId:0x045E},{vendorId:0x057E},{vendorId:0x0F0D},{vendorId:0x054C},{vendorId:0x1209},{vendorId:0x2E8A}];
// Acquire+set up an already-chosen USBDevice (shared by the manual picker and the no-picker auto-reconnect).
async function openDevice(d){
  try{
    S.dev=d;
    pendingInRead=null;
    await S.dev.open();
    if(S.dev.configuration===null) await S.dev.selectConfiguration(1);
    let found=null;
    for(const itf of S.dev.configuration.interfaces){
      const a=itf.alternate;
      if(a.interfaceClass!==0xFF) continue;
      if(a.interfaceSubClass===0x5D) continue;
      let bin=0,bout=0;
      for(const e of a.endpoints){ if(e.type==="bulk"){ if(e.direction==="in")bin=e.endpointNumber; else bout=e.endpointNumber; } }
      if(bin&&bout){ found={ifNum:itf.interfaceNumber, epIn:bin, epOut:bout}; break; }
    }
    if(!found){ log("no WebUSB bulk vendor interface — reflash firmware with WebUSB enabled, or another app may be holding the device"); S.dev=null; return false; }
    ifNum=found.ifNum; S.epIn=found.epIn; S.epOut=found.epOut;
    await S.dev.claimInterface(ifNum);
    await S.dev.controlTransferOut({requestType:"class", recipient:"interface", request:0x22, value:0x01, index:ifNum});
    S.isDongle = (S.dev.productId === 0x1302); // ReversePuck controller dongle vs a puck (0x1304 / real)
    const kind = S.isDongle ? "ReversePuck" : "puck";
    $("#connState").textContent="connected"; $("#connState").className="pill up";
    $("#connState").title = S.dev.serialNumber ? (kind+" serial "+S.dev.serialNumber) : "";
    $("#connectBtn").textContent="Reconnect";
    $("#panel").classList.remove("hide");
    applyDeviceProfile(); // show the controller UI + hide puck-only cards (or vice-versa)
    log(`connected — ${kind} ${S.dev.serialNumber||"?"} (VID ${S.dev.vendorId.toString(16)} PID ${S.dev.productId.toString(16)} iface ${ifNum})`);
    // resume a stability test across the reset: re-arm the firmware buzz and start timing the next run
    // (puck-only: the dongle has no stability-test / haptic path)
    if(S.stabArmed && !S.isDongle){ await send([0x0F,1]); S.stabStart=Date.now(); log("stability test resumed — timing next run"); }
    updateStabUI();
    // The lizard-map dump (0x11 -> 0xAA) is loaded LAZILY, gated on the firmware advertising v16+ (see
    // applyBlob). Older firmware (every pre-lizard build, including the v15 updater builds) silently drops
    // 0x11, and readLizard()'s blocking transferIn would then hang forever -- wedging the status poll the
    // firmware-update gate depends on. So we never send 0x11 until a status blob proves the puck speaks v16.
    S.lizardLoaded=false;
    startPolling();
    // GitHub releases are PUCK firmware; skip the fetch for a dongle (it flashes via the local-file card).
    if(!S.isDongle) loadReleases(false); // background, cached: feeds the update-available notice + pre-warms the update tab
    return true;
  }catch(e){ log("connect failed: "+e.message); S.dev=null; return false; }
}
// Manual connect: shows the Chrome device picker (needed once, to authorize the device).
export async function connect(){
  try{ const d = await navigator.usb.requestDevice({filters:USB_FILTERS}); await openDevice(d); }
  catch(e){ log("connect failed: "+e.message); }
}
// No-picker reconnect: reopen a device already authorized this browser. Returns true if it connected.
export async function autoConnect(){
  if(S.dev) return true;
  try{
    const ds = await navigator.usb.getDevices();
    const d = ds.find(x=>USB_FILTERS.some(f=>f.vendorId===x.vendorId));
    if(d) return await openDevice(d);
  }catch(e){}
  return false;
}
function onGone(){
  // if a stability test is running, this disconnect is the reset that ended the run -- record its uptime
  // (kept in-page so it survives the reset + reconnect, shown next to Last reset).
  let up=null;
  if(S.stabArmed && S.stabStart){ up=(Date.now()-S.stabStart)/1000; S.stabLastRun={secs:up}; log("⏱ stability: stayed up "+fmtDur(up)+", then reset"); S.stabStart=0; }
  // if the PREVIOUS reset was never classified (no full blob landed between two resets), flush it as
  // "unclassified" instead of silently overwriting it -- every reset must leave a row.
  if(S.pendingHang){
    S.hangLog.unshift({ time:new Date(S.pendingHang.t).toLocaleTimeString(), uptime:S.pendingHang.uptimeSecs,
      reason:"unclassified", stage:"", pc:"", lr:"", usbd:null });
    renderHangLog();
    trailAdd("note: the previous reset was never classified — no full status blob arrived before this disconnect");
  }
  // queue a hang-log entry; the reason/PC/stack are filled from the first blob after reconnect
  S.pendingHang = { t: Date.now(), uptimeSecs: up };
  trailAdd("device disconnected"+(up!=null?(" after "+fmtDur(up)+" up"):"")+" — reset or replug; reason logged on reconnect");
  window._flightAuto=false; // re-arm the one-shot flight-trail auto-load for the next reconnect
  window._wedgeEp=false; window._wedgePeak=0; // re-arm the live wedge logger for the next wedge episode
  window._lastBlobTs=0; window._hbLostEp=false; // re-arm the heartbeat watchdog (don't fire on a stale pre-reset timestamp)
  S.polling=false; S.dev=null; S.tabInited=false; pendingInRead=null; // re-default the config tab to the mode on next connect
  const preSel=$("#ledPreset"); if(preSel) preSel.value="default";
  checkUpdateNotice(); // no device = no notice
  $("#connState").textContent="reconnecting…"; $("#connState").className="pill dn";
  $("#panel").classList.add("hide");
  log("device disconnected (mode-switch / watchdog reboot) — auto-reconnecting when it returns");
  // The puck re-enumerates after a reboot; retry without the picker. The "connect" event also triggers this,
  // but poll a few times in case the event is missed.
  let tries=0;
  const iv=setInterval(async()=>{ if(S.dev||tries++>40){ clearInterval(iv); return; } if(await autoConnect()) clearInterval(iv); }, 500);
}
export async function send(bytes){
  if(!S.dev) return;
  try{ await S.dev.transferOut(S.epOut, new Uint8Array(bytes)); }
  catch(e){ log("write err: "+e.message); }
}
let pendingInRead = null;
// Read one framed reply and return its payload (with the 2-byte [marker][len] header stripped). The blob and
// the bond-export dump share the same framing, distinguished by the marker byte (0xA5 status, 0xA7 bonds).
export async function readFrame(marker, minLen, readLen, timeoutMs=1500){
  try{
    // largest frame (status blob) spans multiple USB-FS packets; read generously to capture it in one call.
    // readLen is overridable: the dongle's 0xAC paired-pucks list reaches 213 B (8 pucks) and needs 256.
    if(!pendingInRead) pendingInRead = S.dev.transferIn(S.epIn, readLen||256);
    const r = await Promise.race([
      pendingInRead,
      new Promise((_, rej)=>setTimeout(()=>rej(new Error("timeout")), timeoutMs))
    ]);
    pendingInRead = null;
    if(r.status!=="ok"||r.data.byteLength<2) return null;
    const d=new Uint8Array(r.data.buffer);
    // Live wedge reporter (0xA9): emitted from the firmware's SOF callback (usbd task) while loop() is stalled --
    // the ONLY signal that survives a loop wedge on boards that wipe retained RAM across the reset. Scan for it
    // in every read so it surfaces regardless of which frame we were after. Payload: [stage][stallMs u16].
    for(let w=0; w+4<d.length; w++){
      if(d[w]===0xA9 && d[w+1]===3){ onWedge(d[w+2], d[w+3]|(d[w+4]<<8)); break; }
    }
    let i=0; while(i<d.length && d[i]!==marker) i++;
    if(i+2>d.length) return null;
    const len=d[i+1];
    // truncated read (transfer ended mid-frame): applying a half blob silently skips every late field --
    // reset cause, pendingHang classification, stack stats -- so drop the whole frame and retry next poll.
    if(i+2+len>d.length) return null;
    const p=d.slice(i+2, i+2+len);
    return p.length>=(minLen||0) ? p : null;
  }catch(e){
    if(e.message === "timeout") return null;
    pendingInRead = null;
    if(S.dev) log("read err: "+e.message);
    return null;
  }
}
export async function readBlob(){ return readFrame(0xA5, 12); }
// v23+: the Switch Pro / HD rumble / shortcut settings ride a separate 0xAE frame (op 0x27) because
// the status blob is already at the 255-byte frame limit. Call after applyBlob so lastP is current.
async function readSw(){
  if(!S.lastP || S.lastP[0]<23){ applySw(null); return; }
  await send([0x27]);
  const s=await readFrame(0xAE, 55);
  if(s) applySw(s);
}
export async function refresh(){
  if(!S.dev||S.inflight||S.capturing||S.backupBusy||S.flightBusy||S.lizardBusy||S.rfBusy||S.fieldBusy) return; S.inflight=true;
  // try/finally: an exception anywhere in here (applyBlob included) must never leave inflight latched true --
  // that would silently kill all future polls and read as a fake "heartbeat lost".
  try{
    if(S.isDongle){ await send([0x01]); const p=await readFrame(0xAC, 3, 256); if(p) applyDongleStatus(p); }
    else { await send([0x01]); const p=await readBlob(); if(p){ applyBlob(p); await readSw(); } }
  }
  catch(e){ log("refresh err: "+e.message); }
  finally{ S.inflight=false; }
}
// let any in-flight poll read settle before we drive the shared endpoints ourselves
export async function waitIdle(){ for(let i=0;i<60 && S.inflight;i++) await new Promise(r=>setTimeout(r,5)); }
export async function setField(field,value){
  if(!S.dev) return;
  for(let i=0; i<60 && (S.inflight || S.rfBusy || S.fieldBusy); i++) await new Promise(r=>setTimeout(r,5));
  S.fieldBusy=true;
  try{
    await send([0x02, field, value&0xff]);
    const p=await readBlob();
    if(p){ applyBlob(p); await readSw(); }
  }catch(e){
    log("setField err: "+e.message);
  }finally{
    S.fieldBusy=false;
  }
}
export async function startPolling(){
  S.polling=true; await refresh();
  while(S.polling && S.dev){
    await new Promise(r=>setTimeout(r,600)); await refresh();
    if(window._autoFlight){ window._autoFlight=false; await loadFlightTrail(); }
  }
}

export function initProtocol(){
  // Auto-reconnect when an authorized puck (re)appears — no button, no picker.
  navigator.usb && navigator.usb.addEventListener("connect", e=>{ if(!S.dev) autoConnect(); });
  navigator.usb && navigator.usb.addEventListener("disconnect", e=>{ if(e.device===S.dev) onGone(); });
}
