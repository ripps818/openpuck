import { S } from './state.js';
import { $ } from './util.js';

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

export function renderSlotTabs(bondedCount) {
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
