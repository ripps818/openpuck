import { S } from './state.js';
import { $, fwupEnabled, log, setFwupEnabled } from './util.js';
import { USB_FILTERS, startPolling } from './protocol.js';
import { MODE_NAMES } from './status.js';

// Firmware update via the UF2 picker: selectedUf2 = {name, image} (image = the app binary extracted from the
// .uf2 at pick time, so a bad file is rejected before anything is sent). dfuBusy blocks re-entry while an
// update is in flight.
let selectedUf2=null, dfuBusy=false;
export function updateUf2UI(){
  const sel=$("#uf2Sel"), flash=$("#uf2Flash");
  if(!sel || !flash) return;
  sel.textContent = selectedUf2
    ? selectedUf2.name+" — app image "+Math.round(selectedUf2.image.length/1024)+" KiB, parsed OK"
      +(selectedUf2.updatable ? "" : " — ⚠ no panel-update support in this image (flashing it = drag-and-drop only afterwards)")
    : "no file selected";
  flash.disabled = dfuBusy || !selectedUf2;
  flash.title = selectedUf2
    ? "Send " + selectedUf2.name + " to the puck over WebUSB, verify it, and apply it on reboot"
    : "Pick a .uf2 file first";
}
// ---- Firmware update: UF2 file -> staged flash over WebUSB, applied on reboot ----
// Flow: parse the .uf2 into the raw app image, stream it over THIS WebUSB connection (ops 0x20/0x21/0x22,
// strict ping-pong on the firmware's 0xAB acks) into spare flash high in the puck's app region, let the
// firmware CRC32-verify what actually landed and commit the one-page "apply on reboot" record, then send a
// plain reboot (0x23) — the puck copies staged->app from RAM on the way up and re-enumerates on the new
// firmware, where this panel auto-reconnects. Corruption safety (matches fw_update.h in the firmware):
//   - nothing is armed until the staged bytes verify IN FLASH, so any failure/disconnect/power-cut during
//     the transfer leaves the current firmware completely untouched;
//   - the boot-time apply orders its writes so an interruption leaves the board app-less (UF2 bootloader
//     mass-storage recovery), never a crash-looping half image.
const UF2_MAGIC0=0x0A324655, UF2_MAGIC1=0x9E5D5157, UF2_MAGIC_END=0x0AB16F30, UF2_FAMILY=0xADA52840;
const APP_BASE=0x26000, FWUP_MAX_IMG=0x60000; // nRF52840 app base; staging cap (fw_update.h FWUP_MAX_IMG)
// Extract the contiguous application image from a .uf2 (gaps filled with 0xFF, length padded to a word).
// Throws on anything that is not an nRF52840 app-region UF2 — the firmware re-checks everything, but a bad
// file should fail at pick time, not after a reboot.
function uf2ToImage(buf){
  if(!buf.byteLength || buf.byteLength%512) throw new Error("not a UF2 (size is not a multiple of 512)");
  const dv=new DataView(buf), blocks=[]; let lo=Infinity, hi=0;
  for(let off=0; off<buf.byteLength; off+=512){
    if(dv.getUint32(off,true)!==UF2_MAGIC0 || dv.getUint32(off+4,true)!==UF2_MAGIC1 || dv.getUint32(off+508,true)!==UF2_MAGIC_END)
      throw new Error("bad UF2 block magic at offset "+off);
    const flags=dv.getUint32(off+8,true), addr=dv.getUint32(off+12,true), len=dv.getUint32(off+16,true);
    if(flags&0x00000001) continue; // NOT_MAIN_FLASH
    if((flags&0x00002000) && dv.getUint32(off+28,true)!==UF2_FAMILY)
      throw new Error("UF2 family 0x"+dv.getUint32(off+28,true).toString(16)+" is not nRF52840 (0xada52840)");
    if(len<1 || len>476) throw new Error("bad UF2 payload size "+len);
    blocks.push({addr,len,off}); lo=Math.min(lo,addr); hi=Math.max(hi,addr+len);
  }
  if(!blocks.length) throw new Error("UF2 contains no flash data");
  if(lo!==APP_BASE) throw new Error("image base 0x"+lo.toString(16)+" is not the app region (0x26000) — not an OpenPuck app UF2");
  if(hi-lo>FWUP_MAX_IMG) throw new Error("image is "+Math.round((hi-lo)/1024)+" KiB — over the 384 KiB staged-update cap; flash it via UF2 DFU + drag-and-drop");
  const img=new Uint8Array((hi-lo+3)&~3).fill(0xFF); // firmware stages whole words
  for(const b of blocks) img.set(new Uint8Array(buf,b.off+32,b.len), b.addr-lo);
  return img;
}
// CRC32 (IEEE, reflected, init/xorout 0xFFFFFFFF) — must match crc32Step/crc32Flash in fw_update.cpp
function crc32(u8){
  let c=0xFFFFFFFF;
  for(let i=0;i<u8.length;i++){
    c^=u8[i];
    for(let k=0;k<8;k++) c=(c>>>1)^(0xEDB88320&-(c&1));
  }
  return (~c)>>>0;
}
const u32le=v=>[v&0xFF,(v>>>8)&0xFF,(v>>>16)&0xFF,(v>>>24)&0xFF];
const dfuSleep=ms=>new Promise(r=>setTimeout(r,ms));
// Firmware built from this branch onward embeds this tag (fw_update.cpp FWUP_TAG). An image WITHOUT it
// still flashes fine — but the puck it leaves behind can't do panel updates, so we warn before the
// lock-yourself-out-to-drag-and-drop move (all releases up to 0.9.6 predate panel updates).
function imagePanelUpdatable(image){
  return new TextDecoder("latin1").decode(image).includes("OPK-FWUP-v1");
}
const FWUP_ERR=["ok","command out of sequence","image too big for this puck's free flash","offset resync",
  "staged bytes failed CRC verify","staged image has no valid vector table"];
// Ack reader ([0xAB][5][status][nextOff u32 LE]). One persistent transferIn at a time: a wait that times out
// leaves its read PENDING for the next wait — issuing a second concurrent read would silently eat the data
// the first one eventually resolves with. If one read carries several acks (a retried command double-acks),
// only the LAST — the firmware's newest state — is returned, so stale acks collapse instead of accumulating.
let fwupRead=null;
async function fwupAckWait(timeoutMs){
  const deadline=Date.now()+timeoutMs;
  for(;;){
    const remain=deadline-Date.now();
    if(remain<=0) return null;
    if(!fwupRead) fwupRead=S.dev.transferIn(S.epIn, 64);
    const r=await Promise.race([fwupRead, dfuSleep(remain).then(()=>"timeout")]);
    if(r==="timeout") return null;
    fwupRead=null;
    if(r.status!=="ok") continue;
    const d=new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    let ack=null;
    for(let i=0;i+6<d.length;i++)
      if(d[i]===0xAB && d[i+1]===5)
        ack={status:d[i+2], off:(d[i+3]|(d[i+4]<<8)|(d[i+5]<<16)|(d[i+6]<<24))>>>0};
    if(ack) return ack;
  }
}
const fwupSend=cmd=>S.dev.transferOut(S.epOut, new Uint8Array(cmd));
// send a control op (begin/end/abort — all idempotent on the firmware side) and wait; resend on timeout
async function fwupCtl(cmd, timeoutMs, label){
  for(let t=0;t<3;t++){
    await fwupSend(cmd);
    const a=await fwupAckWait(timeoutMs);
    if(a) return a;
  }
  throw new Error("no response to "+label);
}
async function fwupRun(image){
  const kb=Math.round(image.length/1024);
  fwupRead=null; // never reuse a read pending against a previous session/device
  // drain anything stale on the IN pipe (leftover ack from an aborted run, a late status blob)
  while(await fwupAckWait(400)!==null){}
  log("firmware update: staging "+kb+" KiB into the puck's spare flash — input may stutter briefly during page erases");
  let a=await fwupCtl([0x20,...u32le(image.length),...u32le(crc32(image))],4000,"begin");
  if(a.status) throw new Error("begin rejected: "+(FWUP_ERR[a.status]||("code "+a.status)));
  // Chunk loop: send one chunk, then read acks until one shows progress. A TIMEOUT resends (covers a truly
  // lost command); a stale no-progress ack (the surplus twin of a resent chunk) is read past WITHOUT
  // resending, so retries can't snowball. The ack's nextOff is authoritative — the firmware skips duplicate
  // chunks and re-acks, flash words are never written twice — so every path resynchronizes here.
  // A puck that is still enumerated but has stopped acking would otherwise be resent to for hours: give up
  // after this many back-to-back ack timeouts (10 s at 2.5 s each; a page erase is ~85 ms).
  const MAX_STALLS=4;
  let off=0, sends=0, stalls=0, lastShown=-1;
  const maxSends=Math.ceil(image.length/128)*2+64;
  while(off<image.length){
    const len=Math.min(128,image.length-off);
    await fwupSend([0x21,...u32le(off),len,...image.subarray(off,off+len)]);
    if(++sends>maxSends) throw new Error("transfer not converging at offset "+off);
    for(let reads=0;reads<8;reads++){
      a=await fwupAckWait(2500);
      if(a===null){ // timeout: resend this chunk
        if(++stalls>=MAX_STALLS) throw new Error("the puck stopped responding at "+Math.floor(off*100/image.length)+"%");
        break;
      }
      if(a.status===3){ off=a.off; break; } // firmware says where it wants us — resend from there
      if(a.status!==0) throw new Error("chunk rejected at offset "+off+": "+(FWUP_ERR[a.status]||("code "+a.status)));
      if(a.off>off){ off=a.off; stalls=0; break; } // progress
      // else: stale ack — keep reading, the real one is behind it
    }
    const pct=Math.floor(off*50/image.length)*2;
    if(pct!==lastShown){ lastShown=pct; modalStage("Sending to the puck", pct); }
  }
  modalStage("Verifying on the puck", null); // firmware CRC32s the staged flash, then commits the record
  a=await fwupCtl([0x22],8000,"verify+commit");
  if(a.status) throw new Error("verify+commit rejected: "+(FWUP_ERR[a.status]||("code "+a.status)));
  log("image staged + CRC-verified on the puck — update armed");
  modalStage("Rebooting", null);
  try{ await fwupSend([0x23]); }catch(e){} // device drops mid-call; that's the point
  log("rebooting to apply: the puck goes dark ~5 s while the new firmware is written, then re-enumerates — the panel reconnects itself");
}
// ---- blocking modal: the ONLY interactive surface while an update runs (it covers everything else) ----
export function modalStage(txt,pct){
  const f=$("#updFill"), p=$("#updPct");
  $("#updStage").textContent=txt;
  f.classList.remove("bad");
  if(pct==null){ f.classList.add("pulse"); f.style.width="100%"; p.textContent=""; }
  else{ f.classList.remove("pulse"); f.style.width=pct+"%"; p.textContent=pct+"%"; }
}
export function modalOpen(title){
  $("#updTitle").textContent=title;
  $("#updDetail").textContent="";
  $("#updClose").classList.add("hide"); // no way out mid-update: closing wouldn't stop the puck anyway
  $("#updModal").classList.remove("hide");
  modalStage("Preparing…",null);
}
export function modalDone(ok,msg,failTitle){
  const f=$("#updFill");
  f.classList.remove("pulse");
  f.style.width="100%";
  f.classList.toggle("bad",!ok);
  $("#updStage").textContent = ok ? "Done" : (failTitle||"Update failed");
  $("#updPct").textContent="";
  $("#updDetail").textContent=msg;
  $("#updClose").classList.remove("hide");
}

function blobBuildId(p){
  if(!p) return "";
  let s=""; for(let i=39;i<51 && i<p.length && p[i];i++) s+=String.fromCharCode(p[i]);
  return s;
}
// Update-available notice (topbar): shown when the connected puck reports a release-shaped build (x.y.z)
// older than the newest non-prerelease on GitHub. Dev builds report a git hash, which doesn't parse — no
// nagging about "updates" for firmware newer than any release. Click = jump to the Firmware update tab.
function verTriple(s){
  const m=/^(\d+)\.(\d+)\.(\d+)/.exec(s||"");
  return m ? [+m[1],+m[2],+m[3]] : null;
}
export function checkUpdateNotice(){
  const el=$("#updAvail");
  if(!fwupEnabled()){ el.classList.add("hide"); return; }
  const inst=verTriple(blobBuildId(S.lastP));
  const rel=(relCache||[]).find(r=>!r.prerelease && relAsset(r,false));
  const latest=rel ? verTriple(rel.tag_name) : null;
  const newer = !!(S.dev && inst && latest &&
    (latest[0]>inst[0] || (latest[0]===inst[0] &&
     (latest[1]>inst[1] || (latest[1]===inst[1] && latest[2]>inst[2])))));
  el.classList.toggle("hide", !newer);
  if(newer) el.textContent="⬆ update "+rel.tag_name+" available";
}

// Firmware-tab gate: the connected puck must speak status v15+ (the 0x20..0x24 update ops) for ANY of the
// update tab to be usable. Too old => banner explains + both cards go inert until a capable build is flashed
// the manual way once.
// The update also needs Steam mode: in PS5 mode a transfer stalled at 46% and never recovered, while the same
// image flashed from Steam mode. Steam is the only mode it has been verified in.
const UPDATE_MODE=0;
const modeBlocksUpdate=()=>!S.isDongle && !!S.lastP && S.lastP[0]>=15 && S.lastP[1]!==UPDATE_MODE;
const modeBlockMsg=()=>"This puck is in "+(MODE_NAMES[S.lastP[1]]||"another")+" mode. Firmware updates are only "
  +"supported in Steam mode, so switch to it first (hold the shortcut modifier and press A on the controller), "
  +"then come back here.";
export function updateFwGate(){
  const verOk = S.isDongle || !!(S.lastP && S.lastP[0]>=15);
  const modeBlocked = modeBlocksUpdate();
  const ok = verOk && !modeBlocked;
  $("#updGate").classList.toggle("hide", ok);
  $("#updGateTitle").textContent = modeBlocked ? "Switch to Steam mode to update"
    : "Panel updates not supported by this firmware";
  if(!ok) $("#updGateMsg").textContent = modeBlocked ? modeBlockMsg() :
    "This puck is running "+(blobBuildId(S.lastP)||"an unknown build")+" (status v"+(S.lastP?S.lastP[0]:"?")
    +"), which predates panel updates (needs v15+), so updating from this page is disabled. One manual flash "
    +"gets you back: click “UF2 DFU” on the Device page, then drag a panel-update-capable .uf2 onto the UF2BOOT "
    +"drive it mounts. Every update after that happens right here.";
  for(const c of document.querySelectorAll(".fwupcard")) c.classList.toggle("gated", !ok);
}
// The Firmware update page shows only the risk card until the user enables updates (beta).
export function syncFwupLock(){
  const on=fwupEnabled();
  $("#pgUpdate").classList.toggle("locked", !on);
  $("#fwupOn").classList.toggle("hide", !on);
}
export function updateVersionUI(){
  const build=blobBuildId(S.lastP), proto=S.lastP ? S.lastP[0] : 0;
  const dirty=S.lastP && S.lastP.length>38 ? S.lastP[38] : 0;
  $("#stVersionBuild").innerHTML = build
    ? (build + (dirty ? ' <span class="pill dn">dirty</span>' : ' <span class="pill up">clean</span>'))
    : "—";
  $("#hdrFw").textContent = build ? build+(dirty ? " · dirty" : "") : "—";
  $("#stVersionProto").textContent = proto ? ("v"+proto) : "—";
  $("#stVersionUpdate").textContent = proto >= 15 ? "supported" : (proto ? "manual UF2 only" : "—");
}
// after the apply-reboot: resolved once the puck is back.
// Returns true if the panel auto-reconnected and received a fresh status blob (desktop), "appeared"
// if the puck is visible in getDevices() but openDevice() couldn't be called without a user gesture
// (Android Chrome), or false on timeout.
async function waitReconnect(t0,ms){
  const deadline=Date.now()+ms;
  // seenGone: the puck must disconnect before we can declare it "back".  It is often already gone
  // by the time this runs (fwupRun sent the reboot command and returned), so initialise from dev.
  let seenGone=!S.dev;
  while(Date.now()<deadline){
    if(S.dev && window._lastBlobTs>t0) return true;
    if(!S.dev) seenGone=true;
    if(seenGone && !S.dev){
      try{
        const ds=await navigator.usb.getDevices();
        if(ds.some(x=>USB_FILTERS.some(f=>f.vendorId===x.vendorId))) return "appeared";
      }catch(_e){}
    }
    await dfuSleep(400);
  }
  return false;
}
// One update end-to-end: pre-flight checks, confirm, modal up, image acquired (may download), streamed,
// applied, reconnect observed. getImage runs INSIDE the modal so release downloads show progress there.
async function runUpdate(title, confirmText, getImage){
  if(dfuBusy) return;
  if(!S.dev){ log("connect to the device first — the update travels over this WebUSB connection"); return; }
  // The dongle always speaks the update ops; only gate a PUCK on its status-blob version.
  if(!S.isDongle && (!S.lastP || S.lastP[0]<15)){
    log("this puck's firmware ("+(blobBuildId(S.lastP)||"?")+", status v"+(S.lastP?S.lastP[0]:"?")+") predates panel updates (needs v15+) — flash a panel-update-capable build once via UF2 DFU + drag-and-drop, then this works");
    return;
  }
  if(modeBlocksUpdate()){ log(modeBlockMsg()); return; }
  if(!confirm(confirmText)) return;
  dfuBusy=true; updateUf2UI(); modalOpen(title);
  S.polling=false;        // the IN pipe belongs to the update acks now
  await dfuSleep(800);  // let an in-flight status poll finish its read first
  const t0=Date.now(), oldBuild=blobBuildId(S.lastP);
  try{
    const image=await getImage();
    if(!imagePanelUpdatable(image) &&
       !confirm("⚠ DOWNGRADE WARNING\n\nThis image predates panel updates (releases up to 0.9.6 do). It will "
        +"flash fine, but the puck it leaves behind CANNOT be updated from this panel — getting off it again "
        +"means UF2 DFU + drag-and-drop.\n\nFlash it anyway?"))
      throw new Error("cancelled — the selected image doesn't support panel updates");
    await fwupRun(image);
    modalStage("Applying on the puck",null);
    $("#updDetail").textContent="the puck goes dark ~5 s while the new firmware is written, then re-enumerates";
    const result=await waitReconnect(t0,40000);
    if(result===true){
      const nb=blobBuildId(S.lastP);
      modalDone(true,"Update applied — the puck is back and running build "+(nb||"?")+(oldBuild&&nb!==oldBuild?" (was "+oldBuild+")":""));
    }else if(result==="appeared"){
      // The puck re-enumerated but the browser couldn't auto-open it (requires a user gesture on
      // Android Chrome).  The update landed — the user just needs to tap Connect.
      modalDone(true,"Update applied — the puck is back. Tap Connect to reconnect.");
    }else{
      modalDone(false,"The update was sent and armed, but the puck didn't reconnect within 40 s. Unplug/replug it. "
        +"If it mounts as a UF2BOOT drive, drag the .uf2 onto the drive to recover — the bootloader is intact.");
    }
  }catch(e){
    log("firmware update FAILED: "+e.message);
    modalDone(false,e.message+" — nothing was applied; the running firmware is untouched.");
    // best-effort disarm; a wedged puck may never complete the write, which must not leave the panel busy
    try{ await Promise.race([fwupSend([0x24]), dfuSleep(2000)]); }catch(_e){}
    if(S.dev) startPolling();
  }finally{
    dfuBusy=false; updateUf2UI();
  }
}

// ---- local-file source: drag-and-drop or file picker ----
async function pickUf2(f){
  try{
    const image=uf2ToImage(await f.arrayBuffer());
    selectedUf2={name:f.name, image, updatable:imagePanelUpdatable(image)};
    log("UF2 ready: "+f.name+" — app image "+Math.round(image.length/1024)+" KiB, CRC32 0x"+crc32(image).toString(16).padStart(8,"0"));
  }catch(err){
    selectedUf2=null;
    log("UF2 rejected: "+err.message);
  }
  updateUf2UI();
}

// ---- release source: list from the GitHub API, binaries from the CORS-reachable firmware mirror ----
// api.github.com sends Access-Control-Allow-Origin:* but release-asset downloads redirect to a CDN that does
// NOT, so the release workflow mirrors every OpenPuck .uf2 onto the repo's orphan `firmware` branch and the
// panel fetches it from raw.githubusercontent.com (which is CORS-clean). Fallbacks: the API asset endpoint
// (in case GitHub ever fixes its CDN), then a plain new-tab download + the local-file card.
// releases come from the repo hosting this page (<owner>.github.io/<repo>/ on GitHub Pages); served from
// anywhere else (localhost, a file) it uses this fork
const REL_REPO=(()=>{
  const h=location.hostname.toLowerCase(), m=/^([a-z0-9-]+)\.github\.io$/.exec(h);
  const repo=location.pathname.split("/").filter(Boolean)[0];
  return m && repo ? m[1]+"/"+repo : "ripps818/openpuck";
})();
let relCache=null;
// firmware-mirror manifest: asset name -> {panelUpdate}. Written by the release workflow, which scans each
// .uf2 for the FWUP_TAG capability string. null = manifest unreachable (then releases just go unbadged; the
// byte-scan warning at flash time still catches an unsupported image).
let relManifest=null;
// tri-state: true = a puck running this release can be panel-updated, false = it cannot (drag-and-drop only
// to get off it), null = unknown (no manifest)
function relPanelUpdatable(rel){
  if(!relManifest) return null;
  const known=[relAsset(rel,false),relAsset(rel,true)].filter(a=>a && relManifest[a.name]);
  if(!known.length) return null; // not mirrored (yet) — unknown, don't badge (mirror step lags a fresh release by ~a minute)
  return known.some(a=>relManifest[a.name].panelUpdate);
}
async function downloadAsset(asset){
  modalStage("Downloading "+asset.name,0);
  let resp=null;
  try{
    const r=await fetch("https://raw.githubusercontent.com/"+REL_REPO+"/firmware/"+asset.name,{cache:"no-store"});
    if(r.ok) resp=r;
  }catch(e){}
  if(!resp){
    try{
      const r=await fetch(asset.url,{headers:{Accept:"application/octet-stream"}});
      if(r.ok) resp=r;
    }catch(e){}
  }
  if(!resp){
    window.open(asset.browser_download_url,"_blank","noopener");
    throw new Error(asset.name+" isn't on the firmware mirror yet and GitHub's asset CDN blocks in-page downloads. "
      +"It's downloading in a new tab instead — drop the file on the local-file card above.");
  }
  const total=+resp.headers.get("content-length") || asset.size || 0;
  const reader=resp.body.getReader(), parts=[]; let got=0;
  for(;;){
    const {done,value}=await reader.read();
    if(done) break;
    parts.push(value); got+=value.length;
    if(total) modalStage("Downloading "+asset.name, Math.min(99,Math.floor(got*100/total)));
  }
  const buf=new Uint8Array(got); let o=0;
  for(const p of parts){ buf.set(p,o); o+=p.length; }
  return uf2ToImage(buf.buffer);
}
function relAsset(rel,factory){
  const suffix=factory ? "factory-reset" : "standard";
  return rel.assets.find(a=>a.name==="OpenPuck-"+rel.tag_name+"-"+suffix+".uf2")
      || rel.assets.find(a=>new RegExp("^OpenPuck-.*-"+suffix+"\\.uf2$").test(a.name)) || null;
}
function flashRelease(rel,factory){
  const asset=relAsset(rel,factory);
  if(!asset){ log("release "+rel.tag_name+" has no "+(factory?"factory-reset":"standard")+" .uf2 asset"); return; }
  const kb=Math.round((asset.size||0)/1024);
  runUpdate("Updating to "+rel.tag_name+(factory?" (factory reset)":""),
    "Update the puck to "+rel.tag_name+(factory
      ? " using the FACTORY RESET build?\n\nOn its first boot it wipes ALL settings and the controller pairing — you must re-pair the controller afterwards."
      : "?")
    +"\n\n"+asset.name+" ("+kb+" KiB) is downloaded, sent over WebUSB, verified on the puck, and applied on an "
    +"automatic reboot. A failed or interrupted transfer leaves the current firmware untouched.",
    ()=>downloadAsset(asset));
}
// Release notes come straight from GitHub (rel.body: markdown written by a human in the release UI).
// Render a deliberately small subset -- headings, bullets, `code`, **bold**, links, and bare/markdown URLs
// -- from ESCAPED text, so nothing in a release body can inject markup into the panel.
function relNotesHtml(md){
  const esc=t=>t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return esc((md||"").replace(/\r\n/g,"\n").trim())
    .replace(/`([^`\n]+)`/g,(m,c)=>"<code>"+c+"</code>")
    .replace(/\*\*([^*\n]+)\*\*/g,(m,b)=>"<b>"+b+"</b>")
    .replace(/^(#{1,6})\s+(.+)$/gm,(m,h,t)=>"<b>"+t+"</b>")
    .replace(/^\s*[-*]\s+/gm,"• ")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
             (m,t,u)=>'<a href="'+u+'" target="_blank" rel="noopener">'+t+"</a>")
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
             (m,pre,u)=>pre+'<a href="'+u+'" target="_blank" rel="noopener">'+u+"</a>");
}
function renderReleases(){
  const list=$("#relList");
  list.textContent="";
  let shown=0;
  for(const rel of relCache){
    const std=relAsset(rel,false), fac=relAsset(rel,true);
    if(!std && !fac) continue;
    shown++;
    const item=document.createElement("div"); item.className="rel-item";
    const row=document.createElement("div"); row.className="rel-row";
    const ver=document.createElement("span"); ver.className="ver"; ver.textContent=rel.tag_name;
    const date=document.createElement("span"); date.className="date";
    date.textContent=(rel.published_at||"").slice(0,10);
    const name=document.createElement("span"); name.className="grow note"; name.style.margin="0";
    name.textContent=rel.name && rel.name!==rel.tag_name ? rel.name : "";
    const lab=document.createElement("label");
    const cb=document.createElement("input"); cb.type="checkbox"; cb.disabled=!fac;
    lab.appendChild(cb); lab.appendChild(document.createTextNode("factory reset"));
    lab.title=fac ? "Flash the -factory-reset build: wipes settings + pairing once on first boot"
                  : "this release has no factory-reset build";
    const btn=document.createElement("button"); btn.textContent="Flash "+rel.tag_name;
    btn.onclick=()=>flashRelease(rel,cb.checked);
    row.append(ver,date,name);
    // Pre-release marking is read live from the GitHub API on every refresh, so un-marking a release on
    // GitHub makes the badge disappear here as soon as the list is reloaded.
    if(rel.prerelease){
      const pre=document.createElement("span"); pre.className="pill pre";
      pre.textContent="pre-release";
      pre.title="Marked as a pre-release on GitHub: a test build, not the recommended version. "
        +"It flashes like any other release, and the update notice never points at it.";
      row.appendChild(pre);
    }
    if(relPanelUpdatable(rel)===false){
      const pill=document.createElement("span"); pill.className="pill dn";
      pill.textContent="no panel updates";
      pill.title="This build predates panel-update support: it flashes fine from here, but a puck running it "
        +"can only be updated again via UF2 DFU + drag-and-drop.";
      row.appendChild(pill);
    }
    row.append(lab,btn);
    item.appendChild(row);
    if((rel.body||"").trim()){
      const det=document.createElement("details"); det.className="rel-notes";
      const sum=document.createElement("summary"); sum.textContent="release notes";
      const body=document.createElement("div"); body.className="body";
      body.innerHTML=relNotesHtml(rel.body);
      det.append(sum,body);
      item.appendChild(det);
    }
    list.appendChild(item);
  }
  if(!shown) list.textContent="no releases with OpenPuck .uf2 assets found";
}
export async function loadReleases(force){
  if(relCache && !force) return;
  const list=$("#relList");
  list.textContent="loading…";
  try{
    const [r,mr]=await Promise.all([
      // no-store: the pre-release flag and the notes are edited on GitHub after the fact, and a cached
      // list would keep showing the stale state after a refresh.
      fetch("https://api.github.com/repos/"+REL_REPO+"/releases?per_page=15",
            {cache:"no-store",headers:{Accept:"application/vnd.github+json"}}),
      fetch("https://raw.githubusercontent.com/"+REL_REPO+"/firmware/manifest.json",{cache:"no-store"})
        .catch(()=>null),
    ]);
    if(!r.ok) throw new Error("GitHub API "+r.status);
    try{ relManifest=(mr && mr.ok) ? await mr.json() : null; }catch(e){ relManifest=null; }
    relCache=(await r.json()).filter(x=>!x.draft);
    renderReleases();
    checkUpdateNotice(); // the connect-time blob usually lands before this fetch does
  }catch(e){
    list.innerHTML='could not load releases ('+e.message.replace(/</g,"&lt;")
      +') — <a href="https://github.com/'+REL_REPO+'/releases" target="_blank" rel="noopener" style="color:var(--acc2)">open the releases page</a> and use the local-file card';
    relCache=null;
  }
}

export function initFirmware(){
  $("#updClose").onclick=()=>$("#updModal").classList.add("hide");
  $("#updAvail").onclick=()=>$("#navUpdate").click();
  $("#uf2File").onchange=async(e)=>{
    const f=e.target.files && e.target.files[0];
    e.target.value=""; // allow re-picking the same filename after a rebuild
    if(f) await pickUf2(f);
  };
  // a file dropped anywhere the dropzone isn't listening (e.g. while gated) must not navigate the page to it
  window.addEventListener("dragover",e=>e.preventDefault());
  window.addEventListener("drop",e=>e.preventDefault());
  {
    const dz=$("#uf2Drop");
    dz.onclick=()=>$("#uf2File").click();
    dz.ondragover=e=>{ e.preventDefault(); dz.classList.add("drag"); };
    dz.ondragleave=()=>dz.classList.remove("drag");
    dz.ondrop=async e=>{
      e.preventDefault(); dz.classList.remove("drag");
      const f=e.dataTransfer.files && e.dataTransfer.files[0];
      if(f) await pickUf2(f);
    };
  }
  $("#uf2Flash").onclick=()=>{
    if(!selectedUf2) return;
    runUpdate("Flashing "+selectedUf2.name,
      "Flash "+selectedUf2.name+" ("+Math.round(selectedUf2.image.length/1024)+" KiB)?\n\n"
      +"The image is sent over WebUSB into spare flash (~15 s), verified on the puck, and applied on an automatic "
      +"reboot (~5 s dark). Nothing is armed until it verifies, so a failed or interrupted transfer leaves the "
      +"current firmware untouched. Worst case (power cut during the apply itself) the puck comes back as the "
      +"UF2BOOT drive for drag-and-drop recovery — it cannot end up half-flashed.",
      async()=>selectedUf2.image);
  };
  $("#relRefresh").onclick=()=>loadReleases(true);
  $("#fwupEnable").onclick=()=>{ setFwupEnabled(true); syncFwupLock(); loadReleases(false); checkUpdateNotice(); };
  $("#fwupDisable").onclick=()=>{ setFwupEnabled(false); syncFwupLock(); checkUpdateNotice(); };
  syncFwupLock();
}
