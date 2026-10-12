import { S } from './state.js';
import { $, log } from './util.js';
import { send } from './protocol.js';
import { updateFwGate } from './firmware.js';
import { syncNav } from './nav.js';

// ---- ReversePuck controller dongle: paired-pucks list (0xAC frame) ----
// Payload (readFrame strips the [0xAC][len] header): [ver][flags][count] + per bond 26B:
//   [slot][alive][puuid4][iuuid4][serial16]. flags bit0=forwarding a Deck, bit1=an RF link is up.
export function applyDongleStatus(p){
  window._lastBlobTs=Date.now(); // heartbeat + waitReconnect success signal (mirrors applyBlob)
  if(S.pendingHang){ // a reconnect after a reboot: close out the hang-log row we opened on disconnect
    S.pendingHang=null;
  }
  const flags=p[1], count=p[2], bonds=[];
  for(let i=0;i<count;i++){
    const q=3+i*26; if(q+26>p.length) break;
    const dec=new TextDecoder("latin1");
    let serial=dec.decode(new Uint8Array(p.slice(q+10,q+26)));
    const z=serial.indexOf("\0"); if(z>=0) serial=serial.slice(0,z);
    serial=serial.replace(/[^\x20-\x7e]/g,"").trim(); // strip NUL padding / stray non-printables
    bonds.push({slot:p[q], alive:!!p[q+1],
      puuid:p.slice(q+2,q+6), iuuid:p.slice(q+6,q+10), serial});
  }
  renderPaired(bonds, flags);
}
function renderPaired(bonds, flags){
  const list=$("#pairedList"); if(!list) return;
  $("#pairedFwd").textContent = (flags&1) ? "forwarding a Steam Deck" : "idle";
  $("#pairedLink").textContent = (flags&2) ? "RF link up" : "no RF link";
  $("#pairedLink").className = "pill "+((flags&2)?"up":"dn");
  if(!bonds.length){ list.innerHTML='<p class="note">No pucks paired yet. Pair one with <code>scpair.py</code> (see ReversePuck/README.md), then it appears here.</p>'; return; }
  const hex=a=>[...a].map(x=>x.toString(16).padStart(2,"0")).join("");
  list.innerHTML="";
  for(const b of bonds){
    const row=document.createElement("div"); row.className="row"; row.style.cssText="align-items:center;gap:10px;margin:6px 0";
    const badge=b.alive?'<span class="pill up" style="flex:0 0 auto">live</span>':'<span class="pill" style="flex:0 0 auto">offline</span>';
    row.innerHTML=`${badge}<div style="flex:1"><div style="font-weight:600">${b.serial||"(unnamed puck)"}</div>`
      +`<div class="note" style="font-family:ui-monospace,Menlo,monospace">slot ${b.slot} · puuid ${hex(b.puuid)} · iuuid ${hex(b.iuuid)}</div></div>`;
    const rm=document.createElement("button"); rm.textContent="Remove"; rm.className="danger"; rm.style.flex="0 0 auto";
    rm.title="Un-bond this puck from the ReversePuck. You'll need to re-pair to use it again.";
    rm.onclick=async()=>{
      if(!confirm(`Remove paired puck "${b.serial||"slot "+b.slot}"?\n\nThe ReversePuck forgets this pairing; re-pair with scpair.py to use it again.`)) return;
      await send([0x30, b.slot & 0xff]); log("removed paired puck slot "+b.slot);
      // the firmware replies with a fresh 0xAC after the remove; the next poll (or this read) refreshes the list
    };
    row.appendChild(rm); list.appendChild(row);
  }
}

// Toggle the UI between the full puck panel and the reduced ReversePuck (controller dongle) panel. Called on
// every (re)connect so switching a puck<->dongle in one session lands on the right layout.
export function applyDeviceProfile(){
  const d=S.isDongle;
  // body.dongle drives the CSS that hides the puck-only Controller cards; toggling the class back on a puck
  // reconnect restores them without clobbering the debugonly/lizard inline visibility rules.
  document.body.classList.toggle("dongle", d);
  const paired=$("#pairedCard"); if(paired) paired.style.display = d ? "" : "none";
  // maintenance buttons: factory-erase is a puck-only op (0x0A); the dongle keeps DFU + wipe-board
  const fe=$("#factoryErase"); if(fe) fe.closest(".row").style.display = d ? "none" : "";
  // the GitHub "Update from a release" list is puck firmware; a dongle flashes via the local-file drop card
  const rc=$("#relCard"); if(rc) rc.style.display = d ? "none" : "";
  const ua=$("#updAvail"); if(ua && d) ua.classList.add("hide");
  updateFwGate(); // the dongle always supports panel updates
  syncNav(); // the sidebar drops the pages this device has no cards for
}
