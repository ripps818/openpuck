import { S } from './state.js';
import { log } from './util.js';
import { readBlob, readFrame, send, waitIdle } from './protocol.js';
import { CHORD_DPAD_FIELD } from './status.js';
import { PAD_STICK_FIELD0, TYPE_DEFS } from './types.js';
import { LZ_MAX, lizardCapable, readLizard } from './lizard.js';
import { modalDone, modalOpen, modalStage } from './firmware.js';
import { profilesCapable, profilesLoad } from './profiles.js';

// ---- Backup / clone ----
// A backup file is { magic, version, bonds[4], config{} }. bonds come from the 0x09 export (0xA7 frame); the
// config fields come from the status blob the panel already reads. Restoring replays every setting via the
// normal 0x02 setters, then sends the 0x0D bond-import which writes the pairings, applies the mode and reboots.
function hexEnc(arr){ return [...arr].map(x=>x.toString(16).padStart(2,"0")).join(""); }
function hexDec(h){ const a=[]; if(!h) return a; for(let i=0;i+1<h.length;i+=2) a.push(parseInt(h.substr(i,2),16)); return a; }
export function buildBackup(p, bp){
  const mask=bp[1], bonds=[];
  for(let s=0;s<4;s++){ const rec=bp.slice(2+s*24, 2+s*24+24);
    bonds.push({slot:s, used:!!((mask>>s)&1), rec:hexEnc(rec)}); }
  const types=[];
  for(let et=0; et<TYPE_DEFS.length; et++){ const q=73+et*9;
    const t={back:[p[q],p[q+1],p[q+2],p[q+3]], qam:p[q+4], abSwap:p[q+5], pad:p[q+6], led:p[q+7], rumble:p[q+8]};
    // pad->stick mapping only exists from protocol v20; omit on older pucks so a restore can't replay defaults
    if(p[0]>=21 && p.length>192) t.padStick=[p[185+et*2],p[186+et*2]];
    if(p[0]>=25 && p.length>213) t.rumbleScale=p[210+et]*2;
    types.push(t); }
  const cfg={ mode:p[1], mDiv:p[2], mFric:p[3], persistMode:p[22], chord:[p[23],p[24],p[25]], types };
  // D-pad chords only exist from protocol v18, the Switch gyro mapping from v19; omit the keys entirely on
  // older pucks so a restore doesn't replay defaults over a newer puck's real settings. (Backups from before
  // those settings existed carry rumble/swProRate/swGyro10 keys instead — now-removed settings, ignored.)
  if(p[0]>=18 && p.length>183) cfg.chordD=[p[180],p[181],p[182],p[183]];
  if(p[0]>=19 && p.length>184) cfg.swGyroLegacy=p[184];
  if(p.length>179) cfg.emulateSteamMachine=((p[179]===0xEE || (p.length>197 && p[197]===0xEE))?0xEE:0);
  if(p.length>=201){
    cfg.ledMode=p[197]; cfg.ledPinA=p[198]; cfg.ledPinB=p[199]; cfg.ledPolarity=p[200];
    if(p.length>=202) cfg.ledModeB=p[201];
    if(p.length>=203) cfg.ledPolarityB=p[202];
  }
  if(p[0]>=21 && p.length>=194) cfg.rumbleScale=p[51]*2;
  if(S.lastSw){
    cfg.swDpadHaptics=S.lastSw[38]; cfg.hdPadScale=S.lastSw[40]*2;
    cfg.swQamSelect=S.lastSw[45]; cfg.shortcutFlags=S.lastSw[46];
  }
  // version 2: include the lizard map so it survives a backup/restore cycle.
  // Guard on !lizardBusy to avoid a race with the one-shot lazy load (lizardExchange sets
  // lizardBusy while the initial 0x11 fetch is in flight); if the load is still pending the
  // map snapshot would be empty, which would incorrectly clear bindings on restore.
  if(S.lizardLoaded && lizardCapable() && !S.lizardBusy)
    cfg.lizardMap=S.lizardBindings.map(b=>({outType:b.outType,od:b.od.slice(),trig:b.trig>>>0,hold:b.hold>>>0}));
  // version 3: the mapping profiles (status v30+), read by exportBackup just before. The per-type back / qam /
  // abSwap / padStick keys above still describe the active profile, for a panel or puck without profiles.
  if(p[0]>=30 && S.profiles.slice(0,TYPE_DEFS.length).every(Boolean) && S.gesture){
    cfg.profiles=S.profiles.slice(0,TYPE_DEFS.length).map(t=>({active:t.active, maps:t.maps.map(m=>m.slice()), pads:t.pads.map(x=>x.slice())}));
    cfg.profileGesture={...S.gesture};
  }
  return { magic:"openpuck-backup", version:(cfg.profiles?3:cfg.lizardMap?2:1), bonds, config:cfg };
}
function downloadBackup(obj){
  const ts=new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)],{type:"application/json"}));
  a.download="openpuck-backup-"+ts+".json"; a.click();
}
export async function exportBackup(){
  if(!S.dev){ log("not connected"); return; }
  S.backupBusy=true; await waitIdle();
  try{
    // grab a fresh config snapshot, then the bond dump
    await send([0x01]); const cfg=await readBlob(); if(cfg) S.lastP=cfg;
    if(!S.lastP){ log("export: no config snapshot yet — wait a second and retry"); return; }
    await send([0x09]);
    let bp=null;
    for(let t=0; t<8 && !bp; t++) bp=await readFrame(0xA7, 2+4*24);
    if(!bp){ log("export: no bond data (firmware too old for 0x09 export — reflash)"); return; }
    if(profilesCapable()) for(let et=0;et<TYPE_DEFS.length;et++) if(!await profilesLoad(et)){ log("export: could not read the mapping profiles — retry"); return; }
    const backup=buildBackup(S.lastP, bp);
    downloadBackup(backup);
    const n=backup.bonds.filter(b=>b.used).length;
    log("exported backup — "+n+" bonded controller slot(s) + all settings");
  } finally { S.backupBusy=false; }
}
export async function importBackup(file){
  if(!S.dev){ log("not connected"); return; }
  let obj; try{ obj=JSON.parse(await file.text()); }
  catch(e){ log("import: not valid JSON"); return; }
  if(obj.magic!=="openpuck-backup" || !obj.bonds || !obj.config){ log("import: unrecognized backup file"); return; }
  const hc=obj.config;
  // swProfiles (removed feature) in older backups is ignored
  // rumbleStyle / rumblePresets / strengthSteps / rumbleSlot / strengthSlots (removed settings) in older
  // backups are ignored
  const swKeys=["swDpadHaptics","hdPadScale","swQamSelect","shortcutFlags"];
  if((swKeys.some(k=>hc[k]!==undefined) || (Array.isArray(hc.types) && hc.types.some(t=>Array.isArray(t.padStick) && t.padStick.some(v=>v>=3)))) && !S.lastSw){
    log("import: Switch Pro trackpad D-pad / HD rumble / shortcut settings require firmware with blob v23+");return;
  }
  const isInt=(v,lo,hi)=>Number.isInteger(v) && v>=lo && v<=hi;
  if(hc.rumbleScale!==undefined && (!isInt(hc.rumbleScale,10,500) || !S.lastP || S.lastP[0]<21)){ log("import: invalid or unsupported rumble strength");return; }
  if(Array.isArray(hc.types) && hc.types.some(t=>t && t.rumbleScale!==undefined && (!isInt(t.rumbleScale,10,500) || t.rumbleScale%2))){ log("import: invalid per-type rumble strength");return; }
  if((hc.swDpadHaptics!==undefined && !isInt(hc.swDpadHaptics,0,1)) ||
     (hc.hdPadScale!==undefined && (!isInt(hc.hdPadScale,0,500) || hc.hdPadScale%2)) ||
     (hc.swQamSelect!==undefined && !isInt(hc.swQamSelect,0,20)) ||
     (hc.shortcutFlags!==undefined && !isInt(hc.shortcutFlags,0,63))){
    log("import: invalid Switch Pro / HD rumble / shortcut settings");return;
  }
  const byte=v=>isInt(v,0,255);
  if(hc.profiles!==undefined && !(Array.isArray(hc.profiles) && hc.profiles.length<=TYPE_DEFS.length && hc.profiles.every(t=>t && isInt(t.active,0,2) &&
       Array.isArray(t.maps) && t.maps.length===3 && t.maps.every(m=>Array.isArray(m) && m.every(byte)) &&
       Array.isArray(t.pads) && t.pads.length===3 && t.pads.every(x=>Array.isArray(x) && x.length===2 && x.every(byte)))) ||
     (hc.profileGesture!==undefined && !(hc.profileGesture && [hc.profileGesture.enabled,hc.profileGesture.prev,hc.profileGesture.next].every(byte)))){
    log("import: invalid mapping profiles");return;
  }
  const bondedN=obj.bonds.filter(b=>b.used).length;
  if(!confirm("Restore this backup onto the CONNECTED puck (serial "+(S.dev.serialNumber||"?")+")?\n\nMake sure this is the TARGET puck, not the one you exported from — the panel only talks to the puck you last connected.\n\nThis OVERWRITES its "+bondedN+" controller pairing(s) and ALL settings, then reboots it.\n\nResult: any controller paired to the original puck will connect to this one with no re-pairing.")) return;
  log("importing onto puck "+(S.dev.serialNumber||"?"));
  S.backupBusy=true; await waitIdle();
  // Blocking progress modal (same surface the firmware updater uses): covers the page so nothing else can be
  // driven while the import replays every setting onto the puck, then closes on Done / on error.
  modalOpen("Restore backup");
  const c=obj.config;
  // Pre-count every write so the bar tracks real progress: settings (6 base fields, + 4 D-pad chords and the
  // Switch gyro mapping when the backup carries them), per-type config (9 each), the lizard bindings, 4 bond
  // slots, and the final commit.
  const typeN=Array.isArray(c.types)?Math.min(c.types.length,4):0;
  const lizardN=(Array.isArray(c.lizardMap) && lizardCapable())?Math.min(c.lizardMap.length,LZ_MAX):0;
  const ledN=(c.ledMode!==undefined?1:0)+(c.ledPinA!==undefined?1:0)+(c.ledPinB!==undefined?1:0)+(c.ledPolarity!==undefined?1:0);
  const baseN=6 + (Array.isArray(c.chordD)?4:0) + (c.swGyroLegacy!==undefined?1:0) + (c.emulateSteamMachine!==undefined?1:0) + ledN;
  const padStickN=Array.isArray(c.types)?c.types.slice(0,typeN).filter(t=>Array.isArray(t.padStick)).length*2:0;
  // mapping profiles go through their own ops when both the backup and this puck have them; the per-type
  // mapping fields would only reach the active profile, so they are skipped then
  const profN=(Array.isArray(c.profiles) && profilesCapable())?c.profiles.length:0;
  const total=baseN + typeN*9 + padStickN + profN*4 + (profN && c.profileGesture?1:0) + lizardN + 4 + 1 + (c.swDpadHaptics!==undefined?1:0) + (c.rumbleScale!==undefined?1:0) + (c.hdPadScale!==undefined?1:0) + (c.swQamSelect!==undefined?1:0) + (c.shortcutFlags!==undefined?1:0);
  let step=0, stage="";
  const tick=()=>modalStage(stage, Math.min(99,Math.floor(step*100/total)));
  try{
    // Capability probe: the connected puck MUST run firmware new enough to answer 0x09 with a 0xA7 frame,
    // otherwise it will silently ignore the 0x0D bond-import below. This is the #1 import failure: the panel
    // is connected to a puck still on old firmware. Catch it loudly instead of "nothing happened".
    modalStage("Checking puck firmware", null);
    await send([0x09]);
    let probe=null; for(let t=0;t<8 && !probe;t++) probe=await readFrame(0xA7, 2+4*24);
    if(!probe){
      log("import ABORTED — the connected puck does not support import (old firmware).");
      modalDone(false, "This puck's firmware is too old to import a backup. Flash it with the latest "
        +"OpenPuck build (the same one that produced the export), reconnect, then import again.", "Import failed");
      return;
    }
    // Every step is a write-then-read transaction (same shape as the proven 0x02 sliders): the firmware acks
    // each with a status blob, which we read back to keep the OUT pipe flowing and naturally pace the writes.
    const w=async(bytes)=>{ await send(bytes); await readBlob(); step++; tick(); };
    const sf=async(f,v)=>{ await w([0x02, f, (v|0)&0xff]); };
    // replay every setting (each persists; none reboot). mode is applied by the 0x0E commit below.
    stage="Restoring settings"; tick();
    await sf(1,c.mDiv); await sf(2,c.mFric); await sf(16,c.persistMode?1:0);
    await sf(17,c.chord[0]); await sf(18,c.chord[1]); await sf(19,c.chord[2]);
    // absent in backups taken before the D-pad chords existed (or from a pre-v18 puck) -- skip, don't default
    if(Array.isArray(c.chordD)) for(let i=0;i<4;i++) await sf(CHORD_DPAD_FIELD[i], c.chordD[i]);
    // Switch Pro gyro mapping (v19+ backups only). Backups also carry rumble/swProRate/swGyro10 from the
    // removed settings; those fields no longer exist on the puck, so they are not replayed.
    if(c.swGyroLegacy!==undefined) await sf(38, c.swGyroLegacy?1:0);
    if(c.emulateSteamMachine!==undefined) await sf(29, c.emulateSteamMachine==0xEE?0xEE:0);
    if(c.ledMode!==undefined) await sf(32, c.ledMode);
    if(c.ledPinA!==undefined) await sf(33, c.ledPinA);
    if(c.ledPinB!==undefined) await sf(90, c.ledPinB);
    if(c.ledPolarity!==undefined) await sf(91, c.ledPolarity);
    if(c.ledModeB!==undefined) await sf(93, c.ledModeB);
    if(c.ledPolarityB!==undefined) await sf(94, c.ledPolarityB);
    // per-type rumble (protocol v25) when both the backup and this puck have it
    const typeRumble=S.lastP && S.lastP[0]>=25, typeRumbleDone=typeRumble && typeN>0 && c.types.some(t=>t && t.rumbleScale!==undefined);
    // c.types is absent in some very old backups created before per-type paddle/haptic config
    // was added to the panel export; guard so a missing field never crashes the import mid-flight.
    if(typeN){
      for(let et=0; et<typeN; et++){ const t=c.types[et], mapped=et<profN;
        if(mapped) step+=6+(Array.isArray(t.padStick)?2:0);
        else{
          for(let k=0;k<4;k++) await sf(40+et*9+k, t.back[k]);
          await sf(40+et*9+4, t.qam); await sf(40+et*9+5, t.abSwap?1:0);
        }
        await sf(40+et*9+6, t.pad===2?2:(t.pad?1:0)); await sf(40+et*9+7, t.led);
        await sf(40+et*9+8, t.rumble!==undefined?t.rumble:1);
        if(!mapped && Array.isArray(t.padStick)){ await sf(PAD_STICK_FIELD0+et*2, t.padStick[0]); await sf(PAD_STICK_FIELD0+et*2+1, t.padStick[1]); }
        if(typeRumble && t.rumbleScale!==undefined) await sf(108+et, t.rumbleScale/2); }
      log("settings replayed ("+(baseN+typeN*9)+" fields)");
    } else { log("settings replayed ("+baseN+" fields — no per-type config in this backup)"); }
    if(c.swDpadHaptics!==undefined) await sf(230,c.swDpadHaptics);
    // per-type strengths (v25) already restored the active type's; the legacy global one would overwrite it
    if(!typeRumbleDone && c.rumbleScale!==undefined) await sf(22,Math.round(c.rumbleScale/2));
    if(c.hdPadScale!==undefined) await sf(231,c.hdPadScale/2);
    if(c.swQamSelect!==undefined)await sf(239,c.swQamSelect);
    if(c.shortcutFlags!==undefined)await sf(240,c.shortcutFlags);
    if(profN){
      stage="Restoring mapping profiles"; tick();
      // Each op answers with the type's 0xB0 frame. Only what differs from the puck is sent: a full restore is
      // 3 x 24 entries per type, one round trip each.
      const op=async bytes=>{ await send(bytes); return readFrame(0xB0, 5, 256); };
      let n=0;
      for(let et=0; et<profN; et++){ const t=c.profiles[et];
        const cur=await op([0x2C, et]);
        if(!cur || cur[3]!==3){ throw new Error("the puck did not send its mapping profiles"); }
        const ns=cur[4], per=ns+2;
        for(let i=0;i<3;i++){
          const b=5+i*per;
          for(let src=0; src<Math.min(ns,t.maps[i].length); src++) if(cur[b+src]!==t.maps[i][src]){ await op([0x2D, et, i, src, t.maps[i][src]]); n++; }
          for(let pad=0;pad<2;pad++) if(cur[b+ns+pad]!==t.pads[i][pad]){ await op([0x31, et, i, pad, t.pads[i][pad]]); n++; }
          step++; tick();
        }
        if(cur[2]!==t.active){ await op([0x30, et, t.active]); n++; }
        step++; tick();
      }
      if(c.profileGesture){ const g=c.profileGesture; await op([0x33, 0, g.enabled?1:0, g.prev, g.next]); n++; step++; tick(); }
      log("mapping profiles restored ("+profN+" controller types, "+n+" changes)");
    }
    // restore the lizard map if the backup includes it (version 2+) and the puck speaks v16+.
    // pre-lizard-map backups simply lack c.lizardMap; skip silently so they still import cleanly.
    if(lizardN){
      stage="Restoring button map"; tick();
      const map=c.lizardMap.slice(0,LZ_MAX);
      await send([0x13, map.length&0xff]); // begin edit (set count)
      for(let i=0;i<map.length;i++){
        const b=map[i], od=(b.od||[]).slice(0,7); while(od.length<7) od.push(0);
        const t=(b.trig||0)>>>0, h=(b.hold||0)>>>0;
        await send([0x12, i, (b.outType||0)&0xff, ...od.map(x=>(x||0)&0xff),
          t&0xff,(t>>>8)&0xff,(t>>>16)&0xff,(t>>>24)&0xff,
          h&0xff,(h>>>8)&0xff,(h>>>16)&0xff,(h>>>24)&0xff]);
        step++; tick();
      }
      await send([0x14]); // commit + persist to flash
      await readLizard(); // drain the 0xAA echo so the pipe is clean for bond writes
      log("lizard map restored — "+map.length+" bindings");
    }
    // write each bond slot with its own small command [0x0D][slot][used][24-byte rec]
    stage="Restoring controller pairings"; tick();
    let n=0;
    for(let s=0;s<4;s++){
      const b=obj.bonds.find(x=>x.slot===s) || {used:false, rec:""};
      const rec=hexDec(b.rec), r24=new Array(24).fill(0);
      for(let i=0;i<24 && i<rec.length;i++) r24[i]=rec[i];
      const used=(b.used && rec.length===24)?1:0; if(used) n++;
      await w([0x0D, s, used, ...r24]);
    }
    log("wrote "+n+" bond slot(s) — committing + rebooting");
    // commit: persist bonds, apply mode, reboot (no ack — the device reboots)
    stage="Committing + rebooting"; step++; tick();
    await send([0x0E, (c.mode!==undefined?c.mode:0xFF)&0xff]);
    log("import sent — puck is cloning and rebooting. Reconnect after it returns.");
    modalDone(true, "Backup restored — the puck is cloning and rebooting. Reconnect after it returns.");
  } catch(e){
    log("import FAILED — "+e.message);
    modalDone(false, e.message+" — the import stopped partway; reconnect and retry.", "Import failed");
  } finally { S.backupBusy=false; }
}
