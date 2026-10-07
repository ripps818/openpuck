import { S } from './state.js';
import { $ } from './util.js';
import { showPage } from './nav.js';

// ---- per-slot tab state ----
let g_lastKnownBattery = [0, 0, 0, 0];

function updateSlotDisplay(slotIdx) {
  const d = S.g_slotData[slotIdx];
  if (!d) { $("#stLink").innerHTML="—"; $("#stBatt").textContent="—"; $("#stRssi").textContent="—";
            $("#stSlotPolls").textContent="—"; $("#stSlotF1").textContent="—"; $("#stSlotFail").textContent="—"; return; }
  if (d.battery) g_lastKnownBattery[slotIdx] = d.battery;

  if (d.up) {
    $("#stLink").innerHTML = '<span class="pill up">connected</span>';
    $("#stBatt").textContent = d.battery ? d.battery+"%" : (g_lastKnownBattery[slotIdx] ? g_lastKnownBattery[slotIdx]+"%" : "—");
    $("#stRssi").textContent = d.rssi ? ("-"+d.rssi+" dBm") : "—";
  } else {
    $("#stLink").innerHTML = '<span class="pill dn">idle / asleep</span>';
    $("#stBatt").textContent = g_lastKnownBattery[slotIdx] ? (g_lastKnownBattery[slotIdx]+"% (saved)") : "—";
    $("#stRssi").textContent = "offline";
  }

  // blob v13: this controller's OWN rates (the global grid's numbers are the sum over all controllers)
  if (d.stats) {
    $("#stSlotPolls").textContent = d.stats.polls+" /s";
    $("#stSlotF1").textContent = d.up ? (d.stats.f1+" /s ("+d.stats.newps+" new)") : "0 /s (idle)";
    $("#stSlotFail").textContent = d.stats.crc+" · "+d.stats.norx+" · "+d.stats.relay;
  } else {
    $("#stSlotPolls").textContent="—";
    $("#stSlotF1").textContent = d.up ? "—" : "0 /s (idle)";
    $("#stSlotFail").textContent="—";
  }
}

let lastBondedCount = 0, chipsKey = "";

// Header: one chip per bonded controller (link dot, battery, signal); clicking one opens it on the Status page.
// Rebuilt only when something shown changes, so the 600 ms poll never swaps a chip out from under a click.
export function renderCtlrChips(list) {
  for (const c of list) if (c.battery) g_lastKnownBattery[c.slot] = c.battery;
  const key = JSON.stringify(list.map(c => [c.slot, c.up, c.battery, c.rssi, c.slot===S.g_activeSlot]));
  if (key === chipsKey) return;
  chipsKey = key;
  const host = $("#hdrCtlrs");
  host.innerHTML = "";
  if (!list.length) { host.innerHTML = '<span class="note" style="margin:0">no controller paired</span>'; return; }
  for (const c of list) {
    const batt = c.up && c.battery ? c.battery+"%" : (g_lastKnownBattery[c.slot] ? g_lastKnownBattery[c.slot]+"%" : "—");
    const dbm = -c.rssi, bars = !c.up || !c.rssi ? 0 : dbm >= -55 ? 4 : dbm >= -65 ? 3 : dbm >= -75 ? 2 : 1;
    const chip = document.createElement("button");
    chip.className = "ctlr-chip" + (c.up ? "" : " off");
    chip.title = "Controller "+(c.slot+1)+": "+(c.up ? "connected" : "offline")+" · battery "+batt
      +(c.up ? "" : " (last known)")+" · signal "+(c.up && c.rssi ? dbm+" dBm" : "none");
    chip.innerHTML = '<span class="dot'+(c.up ? " up" : "")+'"></span>C'+(c.slot+1)+' <span>'+batt+'</span>'
      +'<span class="bars">'+[3,5,7,10].map((h,i)=>'<i style="height:'+h+'px"'+(i<bars?' class="on"':"")+'></i>').join("")+'</span>'
      +(c.up && c.rssi ? '<span>'+dbm+' dBm</span>' : "");
    chip.onclick = () => { S.g_activeSlot = c.slot; renderSlotTabs(lastBondedCount); showPage("pgStatus"); };
    host.appendChild(chip);
  }
}

export function renderSlotTabs(bondedCount) {
  lastBondedCount = bondedCount;
  const chips = [];
  for (let s=0; s<4; s++) { const d = S.g_slotData[s]; if (d) chips.push({slot:s, up:d.up, battery:d.battery, rssi:d.rssi}); }
  renderCtlrChips(chips);
  const bar = $("#slotTabs");
  if (bondedCount <= 1) { bar.style.display="none"; updateSlotDisplay(S.g_activeSlot); return; }
  bar.style.display="flex";
  bar.innerHTML="";
  for (let s=0; s<4; s++) {
    const d = S.g_slotData[s];
    if (!d) continue;
    const btn = document.createElement("button");
    btn.className = "slot-tab" + (s===S.g_activeSlot ? " active" : "");
    const dot = document.createElement("span");
    dot.className = "dot" + (d.up ? " up" : "");
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode("Controller "+(s+1)));
    btn.onclick = () => { S.g_activeSlot=s; renderSlotTabs(bondedCount); };
    bar.appendChild(btn);
  }
  updateSlotDisplay(S.g_activeSlot);
}
