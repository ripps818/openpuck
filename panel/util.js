
export function fmtDur(s){ s=Math.round(s); return s>=60 ? (Math.floor(s/60)+"m "+(s%60)+"s") : (s+"s"); }
export const $ = s=>document.querySelector(s);
// Debug UI gate: developer/diagnostic controls (stability test, clear-stuck-buzz, land-all-0x87) and the
// forensic cards (Hang log, Loop-state trail, Flight recorder) only show with ?debug=true in the URL.
// Everything still RUNS regardless (the trail keeps recording to localStorage, stability auto-resume works)
// -- only the UI is hidden, so adding ?debug=true after an unattended incident still shows the history.
export const DEBUG_UI = new URLSearchParams(location.search).get("debug")==="true";
// Firmware updates are beta: the Firmware update page stays locked until the user accepts the risks there, and
// the choice is kept in this browser. ?beta=true (the old beta-mode link) also unlocks it.
const FWUP_KEY="opk_fwup_enabled";
export function fwupEnabled(){
  if(new URLSearchParams(location.search).get("beta")==="true") return true;
  try{ return localStorage.getItem(FWUP_KEY)==="1"; }catch(e){ return false; }
}
export function setFwupEnabled(on){
  try{ if(on) localStorage.setItem(FWUP_KEY,"1"); else localStorage.removeItem(FWUP_KEY); }catch(e){}
  if(!on){ const u=new URL(location.href); if(u.searchParams.has("beta")){ u.searchParams.delete("beta"); history.replaceState(null,"",u); } }
}
export function log(m){ const l=$("#log"); l.textContent=(new Date().toLocaleTimeString()+"  "+m+"\n"+l.textContent).slice(0,2000); }
export function fmtSlider(id,v){ return id==="hapBlockS" ? v+" s" : ""+v; }
export function setSlider(id,v){ const el=$("#"+id); if(document.activeElement!==el){ el.value=v; } $("#"+id+"V").textContent=fmtSlider(id,el.value); }
