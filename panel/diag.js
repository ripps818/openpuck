import { S } from './state.js';
import { $, fmtDur, log } from './util.js';
import { send } from './protocol.js';

export function renderHangLog(){
  const out=$("#hangOut"), sum=$("#hangSummary"); if(!out) return;
  if(!S.hangLog.length){ out.textContent=""; sum.textContent="no resets logged yet"; return; }
  const ups=S.hangLog.filter(e=>e.uptime!=null).map(e=>e.uptime);
  const avg=ups.length?Math.round(ups.reduce((a,b)=>a+b,0)/ups.length):null;
  sum.textContent = S.hangLog.length+" reset(s)"+(avg!=null?("  ·  avg uptime "+fmtDur(avg)):"");
  const pad=(s,n)=>String(s).padEnd(n);
  out.textContent = pad("time",11)+pad("uptime",9)+pad("reason",16)+pad("stage",10)+pad("PC",11)+"usbd\n"
    + S.hangLog.map(e=>pad(e.time,11)+pad(e.uptime!=null?fmtDur(e.uptime):"-",9)+pad(e.reason,16)+pad(e.stage||"-",10)+pad(e.pc||"-",11)+(e.usbd!=null?e.usbd:"-")).join("\n");
}
export function updateStabUI(){
  const btn=$("#stabBtn"), st=$("#stabStatus");
  if(!btn) return;
  btn.textContent = S.stabArmed ? "Stop stability test" : "Test stability";
  btn.classList.toggle("active", S.stabArmed);
  let txt="";
  if(S.stabArmed && S.dev && S.stabStart) txt="up "+fmtDur((Date.now()-S.stabStart)/1000);
  else if(S.stabArmed && !S.dev) txt="reconnecting…";
  if(S.stabLastRun) txt += (txt?"  ·  ":"")+"last run: "+fmtDur(S.stabLastRun.secs);
  st.textContent = txt||"—";
}

// ---- Loop-state trail (persistent) ----
// Every transition of the Loop pill lands here with a wall-clock timestamp, persisted in localStorage --
// unlike the pill (live-only) and the in-page logs (a refresh wipes them), this survives page refreshes and
// device reboots, so a hang that happened while nobody was watching is still on record. Newest first, capped;
// cleared only by the Clear button.
const TRAIL_KEY="opk_loop_trail", TRAIL_MAX=400;
let loopTrail=[]; try{ loopTrail=JSON.parse(localStorage.getItem(TRAIL_KEY))||[]; }catch(e){ loopTrail=[]; }
export function trailAdd(m){
  loopTrail.unshift({t:Date.now(), m});
  if(loopTrail.length>TRAIL_MAX) loopTrail.length=TRAIL_MAX;
  try{ localStorage.setItem(TRAIL_KEY, JSON.stringify(loopTrail)); }catch(e){}
  renderTrail();
}
function renderTrail(){
  const out=$("#trailOut"), sum=$("#trailSummary"); if(!out) return;
  sum.textContent = loopTrail.length ? (loopTrail.length+" event(s) — newest first") : "no events yet";
  out.textContent = loopTrail.length
    ? loopTrail.map(e=>new Date(e.t).toLocaleString()+"  "+e.m).join("\n") : "—";
}
// ---- Live wedge reporter (0xA9) ----
// The firmware's SOF callback streams this while loop() is stuck. On boards that wipe retained RAM across the
// watchdog reset (so the flight recorder / hang stage come back blank), this is the only way to see WHERE it
// hung -- captured live, over the panel, in the ~8s before the watchdog fires. Log once per wedge episode.
const WEDGE_STAGE=["webusb","ctrl.task","serial","rfdiag","rflink","haptic","led","usbmount","usbtx"];
export function onWedge(stage, stallMs){
  const name=WEDGE_STAGE[stage]||("stage "+stage);
  if(!window._wedgeEp) trailAdd("WEDGED @ "+name+" ("+stallMs+"ms — live 0xA9 report; watchdog reset imminent)");
  if(!window._wedgeEp || stallMs > (window._wedgePeak||0)+500){
    window._wedgeEp=true; window._wedgePeak=stallMs;
    log("🛑 LOOP WEDGED @ "+name+" (stuck "+stallMs+"ms) — this is where it hangs; watchdog reset imminent");
    const el=$("#flightWedge"); if(el) el.innerHTML=' &nbsp;<span class="pill dn">last wedge: '+name+' ('+stallMs+'ms)</span>';
  }
}
// ---- Flight recorder (0xA8 stream) ----
// The firmware keeps a .noinit ring of the last high-level events (usbd SET/GET, relays, RF up/down, radio
// self-heal, USB mount/suspend, bond flash writes, per-250ms heartbeats) that survives a watchdog reset. On
// 0x10 it streams them: one header (T=2, vitals@wedge + counts), then entries (T=1), then an end (T=0). We
// pump 0x10 (restart) then 0x10 (continue) until the end frame, accumulating across FIFO-sized batches.
let flightHdr=null, flightEvents=[];
const FR_EVT=["none","beat","SET","GET","relay","rf-up","rf-DN","HEAL!","mount","SUSPEND","resume","OFF","RINGF","save"];
function frEvtName(e){ return FR_EVT[e]!==undefined?FR_EVT[e]:("evt"+e); }
export async function loadFlightTrail(){
  if(!S.dev||S.flightBusy) return; S.flightBusy=true;
  $("#flightSummary").textContent="loading…";
  flightHdr=null; flightEvents=[];
  const STAGE_NAMES=["webusb","ctrl.task","serial","rfdiag","rflink","haptic","led","usbmount","usbtx"];
  try{
    let restart=true, done=false, guard=0, acc=new Uint8Array(0);
    while(!done && guard++<600){
      await send([0x10, restart?1:0]); restart=false;
      const r=await S.dev.transferIn(S.epIn,192);
      if(r.status!=="ok") break;
      const d=new Uint8Array(r.data.buffer);
      const m=new Uint8Array(acc.length+d.length); m.set(acc); m.set(d,acc.length); acc=m;
      let i=0;
      while(i<acc.length){
        if(acc[i]!==0xA8){ i++; continue; }
        if(i+2>acc.length) break;
        const L=acc[i+1]; if(i+2+L>acc.length) break;
        const f=acc.slice(i+2,i+2+L); i+=2+L;
        const T=f[0];
        if(T===0){ done=true; break; }
        else if(T===2 && L>=27){
          flightHdr={ count:f[1]|(f[2]<<8), total:f[3]|(f[4]<<8),
            loopPerSec:f[5]|(f[6]<<8), stallMs:f[7], stage:f[8],
            usbdStk:f[9]|(f[10]<<8), loopStk:f[11]|(f[12]<<8),
            heap:((f[13]|(f[14]<<8)|(f[15]<<16)|(f[16]<<24))>>>0),
            pollsps:f[17]|(f[18]<<8), relayps:f[19]|(f[20]<<8),
            crc:f[21], norx:f[22], heal:f[23]|(f[24]<<8), ringF:f[25]|(f[26]<<8) };
        } else if(T===1 && L>=9){
          const dt=((f[1]|(f[2]<<8)|(f[3]<<16)|(f[4]<<24))>>>0);
          flightEvents.push({dt, evt:f[5], stage:f[6], arg:f[7]|(f[8]<<8)});
        }
      }
      acc=acc.slice(i);
    }
  }catch(e){ log("flight err: "+e.message); }
  S.flightBusy=false;
  renderFlight(STAGE_NAMES);
}
function renderFlight(STAGE_NAMES){
  const h=flightHdr, out=$("#flightOut"), sum=$("#flightSummary"), wedge=$("#flightWedge");
  const stage=s=>(STAGE_NAMES[s]||("st"+s));
  if(!h || (h.count===0 && flightEvents.length===0)){
    sum.textContent="no trail — last boot wasn't a hang, or the recorder didn't survive this board's reset";
    wedge.textContent=""; out.textContent="—"; return;
  }
  const hx=v=>"0x"+v.toString(16).padStart(4,"0");
  sum.textContent="showing "+flightEvents.length+" of "+h.total+" events before the last hang";
  // usbd stack free trending to 0 is the leading overflow suspect -> flag it inline.
  const usbdFlag=(h.usbdStk>0 && h.usbdStk<16)?" ⚠LOW":"";
  wedge.innerHTML=" &nbsp;<b>@wedge:</b> stuck in "+stage(h.stage)+", stall "+h.stallMs+"ms, loop "+h.loopPerSec+"/s"
    +" · usbdStk "+h.usbdStk+"w"+usbdFlag+" · loopStk "+h.loopStk+"w · heap "+h.heap+"B"
    +" · poll "+h.pollsps+" relay "+h.relayps+" crc "+h.crc+" norx "+h.norx+" heal "+h.heal+" ringF "+h.ringF;
  const pad=(s,n)=>(""+s).padEnd(n);
  out.textContent =
    pad("Δms",8)+pad("event",9)+pad("stage",10)+"arg\n"
    +"".padEnd(30,"─")+"\n"
    + flightEvents.map(e=>pad("-"+e.dt,8)+pad(frEvtName(e.evt),9)+pad(stage(e.stage),10)+hx(e.arg)).join("\n");
}

export function initDiag(){
  setInterval(updateStabUI, 500);
  $("#trailClear").onclick=()=>{ loopTrail=[]; try{ localStorage.removeItem(TRAIL_KEY); }catch(e){} renderTrail(); log("loop-state trail cleared"); };
  renderTrail();
  // ---- Host-side heartbeat watchdog (hard-wedge detection) ----
  // The STALLED pill and the 0xA9 reporter both rely on the puck still SENDING while loop() is wedged -- which
  // only holds for soft wedges where the usbd task + SOF IRQ stay alive. The LOCKUP/hardfault-class hangs (#72)
  // kill the whole MCU: USB goes silent, transferIn just pends, and the panel would freeze forever showing the
  // last state it rendered ("running"). Only the host can see that class of hang, so detect it here: connected
  // but no status blob for >2.5s (poll cadence is 600ms) => flip the pill and log the episode. The capture /
  // backup / flight paths pause the blob poll legitimately, so they're excluded.
  setInterval(()=>{
    if(!S.dev || !window._lastBlobTs || S.capturing || S.backupBusy || S.flightBusy) return;
    const age=Date.now()-window._lastBlobTs;
    if(age>2500){
      const secs=Math.round(age/1000);
      $("#stLoopState").innerHTML='<span class="pill dn">NO HEARTBEAT '+secs+'s — hard wedge</span>';
      if(!window._hbLostEp){ window._hbLostEp=true;
        log("🛑 heartbeat lost — no status blob for "+secs+"s: hard wedge (USB stack dead too, so the live wedge reporter can't run) — check the flight trail after the reset");
        trailAdd("HEARTBEAT LOST — no status for "+secs+"s (hard wedge: USB silent, whole MCU likely stopped)");
        const el=$("#flightWedge"); if(el) el.innerHTML=' &nbsp;<span class="pill dn">last wedge: hard (no heartbeat)</span>';
      }
    } else if(window._hbLostEp){ window._hbLostEp=false;
      trailAdd("heartbeat back — status blobs resumed without a reset");
    }
  }, 1000);
}
