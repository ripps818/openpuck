import { S } from './state.js';
import { $, log } from './util.js';
import { readFrame, send, waitIdle } from './protocol.js';

// ---- RF recovery / journal status ----
let rfJournalClearPending=false;
let rfHandoffPhase=0, rfBuilderSaving=false, rfBuilderStartPending=false, rfSurveyGeneration=0, rfSurveyWatchActive=false, rfSurveyLockActive=false, rfSurveyLockGeneration=0, rfSurveyRetry=0, rfSurveyFailure=0, rfSurveyFailureChannel=0;
let rfHopRequestedCh=0, rfHopSawHandoff=false;
let rfPoolChannels=new Set();
const RF_DESIG=["unexplored","good","poor","mixed"];
function rfChLabel(ch){ return ch ? `Ch ${ch} · ${2400+ch} MHz` : "—"; }
function rfElapsedLabel(ms){
  if(ms<1000) return `${ms} ms`;
  const s=Math.floor(ms/1000);
  if(s<60) return `${(ms/1000).toFixed(1)} s`;
  const m=Math.floor(s/60);
  if(m<60) return `${m}m ${String(s%60).padStart(2,"0")}s`;
  const h=Math.floor(m/60);
  if(h<24) return `${h}h ${String(m%60).padStart(2,"0")}m`;
  const d=Math.floor(h/24);
  return `${d}d ${String(h%24).padStart(2,"0")}h`;
}
function applyRfStatus(p){
  if(!p || p.length<13 || p[0]!==1) return;
  const flags=p[1], current=p[2], target=p[3], startup=p[4], count=p[5];
  const writes=p[6], generation=p[7]|(p[8]<<8);
  const seq=((p[9]|(p[10]<<8)|(p[11]<<16)|(p[12]<<24))>>>0);
  $("#rfActiveCh").textContent=rfChLabel(current);
  $("#rfTargetCh").textContent=target?rfChLabel(target):"none";
  $("#rfStartupCh").textContent=rfChLabel(startup || 18);
  $("#rfJournalSeq").textContent=String(seq);
  $("#rfJournalWrites").textContent=String(writes);
  const running=!!(flags&1), pending=!!(flags&2), ambient=!!(flags&4), live=!!(flags&8), handoff=!!(flags&16);
  const tail=13+count*9;
  const hopPhase=p.length>=tail+4?p[tail]:0;
  const hopElapsed16=p.length>=tail+4?(p[tail+1]|(p[tail+2]<<8)):0;
  const hopOld=p.length>=tail+4?p[tail+3]:0;
  // The automatic-handoff trailer follows 4 handoff bytes, 7 Builder bytes,
  // and the ambient-survey channel byte. Parse it before rendering handoff state.
  const autoBase=tail+12;
  const waitReason=p.length>=autoBase+5?p[autoBase]:0;
  const neutralMs=p.length>=autoBase+5?(p[autoBase+1]|(p[autoBase+2]<<8)):0;
  const recoveryCooldown=p.length>=autoBase+5?p[autoBase+3]:0;
  const recoveryFailedTarget=p.length>=autoBase+5?p[autoBase+4]:0;
  const surveyDiagBase=autoBase+5;
  const surveyRetry=p.length>=surveyDiagBase+3?p[surveyDiagBase]:0;
  const surveyFailure=p.length>=surveyDiagBase+3?p[surveyDiagBase+1]:0;
  const surveyFailureChannel=p.length>=surveyDiagBase+3?p[surveyDiagBase+2]:0;
  const handoffElapsedBase=surveyDiagBase+3;
  rfJournalClearPending=p.length>handoffElapsedBase+8 && !!p[handoffElapsedBase+8];
  let hopElapsed=hopElapsed16;
  if(p.length>=handoffElapsedBase+8){
    const lo=((p[handoffElapsedBase]|(p[handoffElapsedBase+1]<<8)|(p[handoffElapsedBase+2]<<16)|(p[handoffElapsedBase+3]<<24))>>>0);
    const hi=((p[handoffElapsedBase+4]|(p[handoffElapsedBase+5]<<8)|(p[handoffElapsedBase+6]<<16)|(p[handoffElapsedBase+7]<<24))>>>0);
    hopElapsed=hi*4294967296+lo;
  }
  const hopPhaseText=["Idle","Waiting for neutral","Authorizing","Switching","Acquiring","Reconciling","Rolling back","Reacquiring"];
  let hopText=hopPhaseText[hopPhase]||("Phase "+hopPhase);
  if(hopPhase===1){
    if(waitReason===1) hopText="Starting hop · awaiting fresh controller reports";
    else if(waitReason===2) hopText="Input detected · waiting for neutral";
    else if(waitReason===3) hopText=`Neutral · ${Math.min(neutralMs,250)}/250 ms`;
  }
  if(hopPhase===2||hopPhase===3||hopPhase===4) hopText+=(target?` Ch ${target}`:"");
  else if(hopPhase>=5) hopText+=(hopOld?` Ch ${hopOld}`:"");
  if(hopPhase) hopText+=` · ${rfElapsedLabel(hopElapsed)}`;
  else if(recoveryCooldown) hopText=`Recovery cooldown · ${recoveryCooldown}s${recoveryFailedTarget?` · Ch ${recoveryFailedTarget} excluded`:""}`;
  if(hopPhase||!S.rfHopPending) $("#rfHandoffStatus").textContent=hopText;
  const builderBase=tail+4;
  const builderPhase=p.length>=builderBase+7?p[builderBase]:0;
  const builderIndex=p.length>=builderBase+7?p[builderBase+1]:0;
  const builderChannel=p.length>=builderBase+7?p[builderBase+2]:0;
  const builderProgress=p.length>=builderBase+7?p[builderBase+3]:0;
  const builderMask=p.length>=builderBase+7?p[builderBase+4]:0;
  const builderBest=p.length>=builderBase+7?p[builderBase+5]:0;
  const builderFailure=p.length>=builderBase+7?p[builderBase+6]:0;
  const surveyChannel=p.length>=builderBase+8?p[builderBase+7]:0;
  const builderFailureText=["","no live controller","RF workflow busy","journal storage full: turn the controller off for 2 s to free space, then on, and retry","no valid channel","final hop failed","journal save failed","journal write could not be completed","could not read controller idle timeout","startup save failed","ambient survey failed"];
  let builderText="Idle";
  if(builderPhase===1) builderText="Preparing controllers / ambient survey";
  else if(builderPhase===2) builderText=`Preparing Ch ${builderChannel} · configuring RF`;
  else if(builderPhase===3) builderText=`Testing ${Math.min(builderIndex+1,count)}/${count} · Ch ${builderChannel} (${2400+builderChannel} MHz) · ${builderProgress}%`;
  else if(builderPhase===4) builderText=`Testing ${Math.min(builderIndex+1,count)}/${count} · Ch ${builderChannel} · finalizing`;
  else if(builderPhase===5) builderText=`Testing ${Math.min(builderIndex+1,count)}/${count} · between channels`;
  else if(builderPhase===6) builderText="Selecting best channel";
  else if(builderPhase===7) builderText=`Final hop · Ch ${builderBest||builderChannel}`;
  else if(builderPhase===8) builderText=`Saving journal${builderBest?` · Ch ${builderBest}`:""}`;
  else if(builderPhase===9) builderText=`Paused · waiting for controller cohort 0x${builderMask.toString(16).toUpperCase()}`;
  else if(builderPhase===10) builderText=`Complete${builderBest?` · Ch ${builderBest} selected`:""}`;
  else if(builderPhase===11) builderText="Canceled";
  else if(builderPhase===12) builderText=`Failed · ${builderFailureText[builderFailure]||("code "+builderFailure)}`;
  $("#rfBuilderStatus").textContent=builderText;
  S.rfBuilderActive=builderPhase>=1&&builderPhase<=9;
  rfBuilderSaving=builderPhase===8;
  S.rfHandoffActive=handoff;
  rfHandoffPhase=hopPhase;
  if(rfBuilderStartPending&&builderPhase!==0) rfBuilderStartPending=false;
  $("#rfBuilder").textContent=S.rfBuilderActive?"Cancel Journal Build":rfBuilderStartPending?"Starting…":"Build RF Journal";
  syncRfBuilderDisabled();
  S.rfSurveyRunning=running;
  S.rfSurveyPending=pending;
  rfSurveyGeneration=generation;
  rfSurveyRetry=surveyRetry;
  rfSurveyFailure=surveyFailure;
  rfSurveyFailureChannel=surveyFailureChannel;
  if(rfSurveyLockActive&&(surveyFailure||(!running&&!pending&&generation!==rfSurveyLockGeneration)))
    rfSurveyLockActive=false;
  if(S.rfHopPending&&handoff) rfHopSawHandoff=true;
  if(S.rfHopPending&&!rfHopRequestedCh&&!handoff) S.rfHopPending=false;
  const surveyFailureText=["","sample timeout","incomplete scan"];
  $("#rfSurveyState").textContent=running?(surveyRetry&&surveyChannel?`retrying Ch ${surveyChannel} · ${surveyRetry}/5`:surveyChannel?`surveying Ch ${surveyChannel}`:"surveying"):pending?(handoff?"queued for handoff":"starting survey"):surveyFailure?`failed${surveyFailureChannel?` · Ch ${surveyFailureChannel}`:""} · ${surveyFailureText[surveyFailure]||(`code ${surveyFailure}`)}`:ambient?`cached #${generation}`:"not sampled";
  const body=$("#rfJournalBody"), bars=$("#rfAmbientBars"); body.innerHTML=""; bars.innerHTML=""; rfPoolChannels=new Set();
  for(let i=0;i<count;i++){
    const q=13+i*9; if(q+9>p.length) break;
    const ch=p[q], noise=p[q+1], d=p[q+2], worst=p[q+3], mean=p[q+4], conf=p[q+5], trials=p[q+6], penalty=p[q+7], recent=p[q+8];
    rfPoolChannels.add(ch);
    const tr=document.createElement("tr"); tr.dataset.rfCh=String(ch);
    const desig=RF_DESIG[d]||("state "+d);
    tr.innerHTML=`<td>${ch}${ch===current?' <span class="pill up">active</span>':''}${ch===target?' <span class="pill rf-target">target</span>':''}</td><td>${2400+ch}</td><td>${desig}</td><td>${trials?worst+'%':'—'}</td><td>${trials?mean+'%':'—'}</td><td>${trials?conf:'—'}</td><td>${trials}</td><td>${trials?penalty:'—'}</td><td>${noise?'-'+noise+' dBm':'—'}</td><td>${recent||'—'}</td>`;
    const hopCell=document.createElement("td");
    const hopBtn=document.createElement("button");
    hopBtn.textContent=ch===current?"Active":"Hop";
    hopBtn.dataset.rfHop="1";
    hopBtn.disabled=ch===current||rfSurveyLockActive||rfHopWorkflowBlocked()||S.rfHopPending||S.rfBuilderActive;
    hopBtn.style.padding="4px 8px";
    hopBtn.dataset.rfCurrent=ch===current?"1":"0";
    hopBtn.addEventListener("click",()=>hopRf(ch));
    hopCell.appendChild(hopBtn);
    const startupBtn=document.createElement("button");
    startupBtn.textContent=ch===startup?"Startup ✓":"Startup";
    startupBtn.dataset.rfStartup="1";
    startupBtn.dataset.rfStartupSelected=ch===startup?"1":"0";
    startupBtn.disabled=rfSurveyLockActive||ch===startup;
    startupBtn.style.cssText="padding:4px 8px;margin-left:6px";
    startupBtn.title="Use this channel on the next boot. This does not mark the channel good.";
    startupBtn.addEventListener("click",()=>manualStartupRf(ch));
    hopCell.appendChild(startupBtn);
    tr.appendChild(hopCell);
    body.appendChild(tr);
    const col=document.createElement("div"); col.style.cssText="flex:1;min-width:18px;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center";
    const h=noise?Math.max(6,Math.min(58,(noise-35)*1.15)):4;
    col.title=noise?`Ch ${ch}: ambient peak -${noise} dBm`:`Ch ${ch}: no ambient sample`;
    col.innerHTML=`<div style="font-size:9px;color:#8ba2c4">${noise?'-'+noise:''}</div><div style="width:100%;height:${h}px;background:currentColor;opacity:${noise?'.72':'.18'};border-radius:2px 2px 0 0"></div><div style="font-size:9px;margin-top:2px">${ch}</div>`;
    bars.appendChild(col);
  }
  syncRfSurveyControls();
}
function syncRfSurveyControls(){
  const locked=rfSurveyLockActive;
  $("#rfSurvey").disabled=locked||S.rfBuilderActive;
  for(const tr of $("#rfJournalBody").querySelectorAll("tr")){
    for(const btn of tr.querySelectorAll("button[data-rf-hop]"))
      btn.disabled=locked||S.rfHopPending||S.rfBuilderActive||btn.dataset.rfCurrent==="1"||rfHopWorkflowBlocked();
    for(const btn of tr.querySelectorAll("button[data-rf-startup]"))
      btn.disabled=locked||btn.dataset.rfStartupSelected==="1";
  }
  syncRfBuilderDisabled();
}
function rfBuilderWorkflowBlocked(){
  // Waiting-for-neutral is the automatic, pre-E4 admission phase. Firmware can
  // safely yield that phase to an explicit Builder request; every other live
  // handoff phase remains non-preemptible.
  return (S.rfHandoffActive||S.rfHopPending) && !(S.rfHandoffActive&&rfHandoffPhase===1);
}
function rfHopWorkflowBlocked(){
  // Hop itself now uses the production automatic neutral-gated path, so an
  // existing handoff remains authoritative until it reaches a terminal state.
  return S.rfHandoffActive;
}
function syncRfBuilderDisabled(){
  $("#rfBuilder").disabled=rfSurveyLockActive||rfBuilderSaving||rfBuilderStartPending||(!S.rfBuilderActive&&rfBuilderWorkflowBlocked());
  const clr=$("#rfJournalClear");
  clr.textContent=rfJournalClearPending?"Clear pending · turn controllers off":"Clear RF Journal";
  clr.disabled=rfJournalClearPending||S.rfBuilderActive||rfBuilderStartPending||rfSurveyLockActive;
}
function setRfHopButtonsDisabled(disabled){
  S.rfHopPending=!!disabled;
  for(const tr of $("#rfJournalBody").querySelectorAll("tr")){
    for(const btn of tr.querySelectorAll("button[data-rf-hop]"))
      btn.disabled=rfSurveyLockActive||S.rfHopPending||S.rfBuilderActive||btn.dataset.rfCurrent==="1"||rfHopWorkflowBlocked();
  }
  // Keep the Builder interlock synchronized with the local Hop latch as well
  // as firmware handoff state. The terminal status frame arrives before the
  // Hop finally block releases rfHopPending, so applyRfStatus() may have
  // left this DOM button disabled using the old latch value.
  syncRfBuilderDisabled();
}
function showRfHopTarget(ch){
  $("#rfTargetCh").textContent=rfChLabel(ch);
  for(const tr of $("#rfJournalBody").querySelectorAll("tr")){
    const cell=tr.cells[0]; if(!cell) continue;
    for(const badge of cell.querySelectorAll(".rf-target")) badge.remove();
    if(+tr.dataset.rfCh===ch){
      const badge=document.createElement("span"); badge.className="pill rf-target"; badge.textContent="target";
      cell.append(" ",badge);
    }
  }
}
async function waitRfUiIdle(){
  for(let i=0;i<100&&S.rfBusy&&S.dev;i++) await new Promise(resolve=>setTimeout(resolve,50));
  return !!S.dev&&!S.rfBusy;
}
async function hopRf(ch){
  if(!S.dev||S.isDongle||!S.rfCapable||!rfPoolChannels.has(ch)||rfSurveyLockActive||S.rfHopPending||S.rfBuilderActive||rfHopWorkflowBlocked()) return;
  setRfHopButtonsDisabled(true);
  rfHopRequestedCh=ch;
  rfHopSawHandoff=false;
  showRfHopTarget(ch);
  $("#rfHandoffStatus").textContent=`Requesting Ch ${ch}`;
  if(!(await waitRfUiIdle())){
    $("#rfHandoffStatus").textContent=`Hop not started · Ch ${ch}`;
    rfHopRequestedCh=0;
    setRfHopButtonsDisabled(false);
    return;
  }
  S.rfBusy=true;
  let terminal=false, sawStatus=false;
  try{
    await waitIdle(); if(!S.dev) return;
    await send([0x02,99,ch]);
    let p=await readFrame(0xAD,13,256);
    for(let i=0;i<1200&&S.dev;i++){
      if(p){
        sawStatus=true;
        const current=p[2], target=p[3], flags=p[1];
        const tail=13+p[5]*9;
        const phase=p[tail];
        const handoff=!!(flags&16);
        applyRfStatus(p);
        if(current===ch && !handoff && phase===0){ terminal=true; break; }
        if(handoff) rfHopSawHandoff=true;
        // Terminate promptly when firmware reports handoff concluded without
        // adopting the requested channel, or if the request never admitted.
        if(!handoff && phase===0 && rfHopSawHandoff){ terminal=true; break; }
        if(!handoff && phase===0 && !target && i>=10){ terminal=true; break; }
      }
      await new Promise(resolve=>setTimeout(resolve,50));
      await send([0x02,97,1]);
      p=await readFrame(0xAD,13,256);
    }
    if(sawStatus) S.rfLastRefresh=Date.now();
  }catch(e){
    $("#rfHandoffStatus").textContent=`Hop error · Ch ${ch}`;
    log("RF hop err: "+e.message);
  }
  finally{
    rfHopRequestedCh=0;
    S.rfBusy=false;
    setRfHopButtonsDisabled(false);
  }
}

async function manualStartupRf(ch){
  if(!S.dev||S.isDongle||!S.rfCapable||!rfPoolChannels.has(ch)||rfSurveyLockActive) return;
  if(!(await waitRfUiIdle())) return;
  S.rfBusy=true;
  try{
    await waitIdle(); if(!S.dev) return;
    await send([0x02,100,ch]);
    const p=await readFrame(0xAD,13,256); if(p) applyRfStatus(p);
    S.rfLastRefresh=Date.now();
  }catch(e){ log("RF startup err: "+e.message); }
  finally{ S.rfBusy=false; }
}
export async function manualJournalBuilderRf(){
  if(!S.dev||S.isDongle||!S.rfCapable||rfSurveyLockActive||rfBuilderSaving||rfBuilderStartPending) return;
  if(S.rfBuilderActive){
    if(!confirm("Cancel the RF Journal Builder? The current safe RF operation will finish, the puck will return to the channel that was active before the build, and the existing saved journal will be preserved.")) return;
    if(!(await waitRfUiIdle())) return;
    S.rfBusy=true;
    try{
      await waitIdle(); if(!S.dev) return;
      await send([0x02,101,0]);
      const p=await readFrame(0xAD,13,256); if(p) applyRfStatus(p);
      S.rfLastRefresh=Date.now();
    }catch(e){ log("RF journal builder cancel err: "+e.message); }
    finally{ S.rfBusy=false; }
    return;
  }
  const ok=confirm("RF Journal Builder\n\nPlace all connected controllers at approximately the farthest distance from the puck at which you normally use them, and leave them in their normal operating location during the test.\n\nThe puck will survey ambient RF, test all 14 recovery channels for about 60 seconds each, select the best channel, and save one completed RF journal record. The test takes roughly 15 minutes.\n\nStart the journal build?");
  if(!ok) return;
  rfBuilderStartPending=true;
  $("#rfBuilderStatus").textContent="Starting…";
  $("#rfBuilder").textContent="Starting…";
  $("#rfBuilder").disabled=true;
  if(!(await waitRfUiIdle())){
    rfBuilderStartPending=false;
    $("#rfBuilder").textContent="Build RF Journal";
    syncRfBuilderDisabled();
    return;
  }
  S.rfBusy=true;
  let sawStatus=false;
  try{
    await waitIdle(); if(!S.dev) return;
    await send([0x02,101,1]);
    // Latch the Start button until firmware positively reports either an
    // active Builder phase or a terminal failure. This closes the duplicate
    // Start window while the first RF-status response is still propagating.
    for(let i=0;i<20&&S.dev&&rfBuilderStartPending;i++){
      const p=await readFrame(0xAD,13,256);
      if(p){ sawStatus=true; applyRfStatus(p); }
      if(!rfBuilderStartPending) break;
      await new Promise(resolve=>setTimeout(resolve,100));
      await send([0x02,97,1]);
    }
    if(rfBuilderStartPending){
      rfBuilderStartPending=false;
      $("#rfBuilderStatus").textContent=sawStatus?"Start outcome unknown · waiting for RF status":"Start status unavailable";
      $("#rfBuilder").textContent="Build RF Journal";
      syncRfBuilderDisabled();
    }
    if(sawStatus) S.rfLastRefresh=Date.now();
  }catch(e){
    rfBuilderStartPending=false;
    $("#rfBuilder").textContent="Build RF Journal";
    syncRfBuilderDisabled();
    log("RF journal builder err: "+e.message);
  }
  finally{ S.rfBusy=false; }
}
export async function clearJournalRf(){
  if(!S.dev||S.isDongle||!S.rfCapable||S.rfBuilderActive||rfBuilderStartPending||rfJournalClearPending) return;
  if(!confirm("Clear the RF journal?\n\nThis erases the saved journal and forgets every channel's learned quality. The Startup channel is kept.\n\nThe puck clears it once no controller has been connected for a second: turn your controllers off for a couple of seconds, then back on.")) return;
  if(!(await waitRfUiIdle())) return;
  S.rfBusy=true;
  try{
    await waitIdle(); if(!S.dev) return;
    await send([0x02,113,1]);
    const p=await readFrame(0xAD,13,256); if(p) applyRfStatus(p);
    S.rfLastRefresh=Date.now();
  }catch(e){ log("RF journal clear err: "+e.message); }
  finally{ S.rfBusy=false; }
}
export async function manualSurveyRf(){
  if(!S.dev||S.isDongle||!S.rfCapable||rfSurveyWatchActive||rfSurveyLockActive) return;
  rfSurveyLockGeneration=rfSurveyGeneration;
  rfSurveyLockActive=true;
  rfSurveyWatchActive=true;
  syncRfSurveyControls();
  $("#rfSurveyState").textContent="requesting…";
  if(!(await waitRfUiIdle())){
    rfSurveyWatchActive=false;
    rfSurveyLockActive=false;
    syncRfSurveyControls();
    return;
  }
  S.rfBusy=true;
  const startGeneration=rfSurveyLockGeneration;
  let sawSurvey=false, sawStatus=false, terminal=false;
  try{
    await waitIdle(); if(!S.dev) return;
    await send([0x02,98,1]);
    // A successful request is reflected immediately as pending/running in the
    // dedicated RF-status frame. Poll faster than the 100-ms scanner step so
    // per-channel progress and retries remain visible.
    for(let i=0;i<400&&S.dev;i++){
      const p=await readFrame(0xAD,13,256);
      if(p){
        sawStatus=true;
        const flags=p[1], running=!!(flags&1), pending=!!(flags&2);
        const generation=p[7]|(p[8]<<8);
        applyRfStatus(p);
        if(running||pending) sawSurvey=true;
        if(rfSurveyFailure){ terminal=true; break; }
        if(!running&&!pending&&generation!==startGeneration){ terminal=true; break; }
        if(!running&&!pending&&!sawSurvey&&i>=2){
          rfSurveyLockActive=false;
          $("#rfSurveyState").textContent="Survey not started · RF workflow busy";
          terminal=true;
          break;
        }
      }
      await new Promise(resolve=>setTimeout(resolve,50));
      await send([0x02,97,1]);
    }
    if(!terminal){
      if(S.rfSurveyRunning||S.rfSurveyPending) $("#rfSurveyState").textContent=S.rfSurveyRunning?"Survey still active":"Survey queued";
      else if(!sawStatus){
        rfSurveyLockActive=false;
        $("#rfSurveyState").textContent="Survey status unavailable";
      }
    }
    if(sawStatus) S.rfLastRefresh=Date.now();
  }catch(e){
    rfSurveyLockActive=false;
    $("#rfSurveyState").textContent="Survey error";
    log("RF survey err: "+e.message);
  }
  finally{
    S.rfBusy=false;
    rfSurveyWatchActive=false;
    syncRfSurveyControls();
  }
}
export async function refreshRfStatus(survey=false){
  if(!S.dev||S.isDongle||!S.rfCapable||S.rfBusy||S.fieldBusy) return;
  S.rfBusy=true;
  try{
    await waitIdle(); if(!S.dev) return;
    await send([0x02,survey?98:97,1]);
    const p=await readFrame(0xAD,13,256); if(p) applyRfStatus(p);
    S.rfLastRefresh=Date.now();
  }catch(e){ log("RF status err: "+e.message); }
  finally{ S.rfBusy=false; }
}
