const fs=require('fs'),path=require('path'),assert=require('assert'),{pathToFileURL}=require('url');
const {JSDOM}=require('jsdom');
const js=path.join(__dirname,'../../panel');
const html=fs.readFileSync(path.join(__dirname,'../../docs/index.html'),'utf8');
let cleanup=()=>{};
(async()=>{
// The panel source is ES modules under panel/: load the page (scripts off), expose the browser globals they use, import them.
const dom=new JSDOM(html,{url:'http://localhost/'}),w=dom.window;
const timers=[],setIntervalNode=setInterval;globalThis.setInterval=(...a)=>{const t=setIntervalNode(...a);timers.push(t);return t;};
cleanup=()=>{timers.forEach(clearInterval);w.close();};
for(const k of ['window','document','navigator','location','localStorage','prompt'])
  Object.defineProperty(globalThis,k,{value:k==='window'?w:(typeof w[k]==='function'?w[k].bind(w):w[k]),configurable:true,writable:true});
globalThis.confirm=()=>true;globalThis.fetch=async()=>({ok:false,json:async()=>[]});
const mod=f=>import(pathToFileURL(path.join(js,f)).href);
await mod('app.js');
const {S}=await mod('state.js'),{applyBlob,applySw}=await mod('status.js'),{buildBackup,importBackup}=await mod('backup.js');
// Fork layout: v23 status blob + the separate 0xAE Switch Pro / shortcut frame (readFrame strips [0xAE][len]).
let p=Array(204).fill(0);p[0]=23;p[60]=1;p[193]=8;p[51]=100;
const s=Array(55).fill(0);s[0]=1;s[38]=1;s[39]=1;s[40]=150;s[45]=18;s[46]=57;
const bp=Array(98).fill(0);bp[0]=1;
// Fake puck on the real WebUSB path: every OUT transfer is recorded, every IN transfer answers the last opcode.
const writes=[];let op=0;
const frame=(m,a)=>({status:'ok',data:new DataView(new Uint8Array([m,a.length,...a]).buffer)});
S.dev={serialNumber:'test',
  transferOut:async(ep,b)=>{const a=Array.from(b);writes.push(a);op=a[0];return {status:'ok'};},
  transferIn:async()=>op===0x27?frame(0xAE,s):op===0x09?frame(0xA7,bp):op>=0x11&&op<=0x1A?frame(0xAA,[]):frame(0xA5,p)};
const settle=()=>new Promise(r=>setTimeout(r,30));
const lastSet=()=>writes.filter(x=>x[0]===2).pop();
const apply=async()=>{applyBlob(new Uint8Array(p));applySw(new Uint8Array(s));await settle();};await apply();
const $=sel=>document.querySelector(sel);
const act=async fn=>{const n=writes.length;fn();await settle();return writes.slice(n).filter(x=>x[0]===2).pop();};
// Rumble style is automatic: no style pickers, rumble presets, strength steps, D-pad haptic toggle or save button.
for(const id of ['rumbleStyle','rumbleState1','strengthSteps','scHaptics','shortcutSave','hdTuning','calibrationCard','hdWaveform','swProfilesCard','scProfiles','swProfileChords'])assert(!$('#'+id),id);
assert.equal($('#qamSelect').value,'18');
// Shortcut toggles live in the Mode shortcuts card; every chord is available.
assert(!$('#shortcutToggles').classList.contains('hide'));assert($('#shortcutToggles').closest('.card').querySelector('.chord'));
assert.equal($('#scQam').textContent,'Quick Access');
for(const el of document.querySelectorAll('.chord,.chordD'))assert(!el.parentElement.classList.contains('hide'));
assert.deepEqual(await act(()=>$('#scQam').click()),[2,240,56]);s[46]=56;await apply();assert.equal($('#scQam').textContent,'All four back buttons');
for(const [id,bit] of [['scFeedback',8],['scCapture',16],['scEnabled',32]])assert.deepEqual(await act(()=>$('#'+id).click()),[2,240,s[46]^bit]);
// Switch Pro-only controls (and HD trackpad strength) live in the Switch tab of Button mapping.
const swTab=$('#swClickControls').parentElement;assert($('#typeCfgs').contains(swTab));
for(const id of ['#qamSelectRow','#swGyroMap','#hdPadScale'])assert(swTab.contains($(id)),id);
assert(!$('#swClickControls').classList.contains('hide'));assert.equal($('#swClickFeedback').value,'1');
const change=el=>act(()=>el.dispatchEvent(new w.Event('change')));
const click=$('#swClickFeedback');click.value='0';assert.deepEqual(await change(click),[2,230,0]);
const capture=$('#qamSelect');capture.value='0';assert.deepEqual(await change(capture),[2,239,0]);
// v25: grip strength per type in Button mapping (no style row); the global strength row hides.
const secs=[...$('#typeCfgs').children].slice(1);
const typeRow=(et,label)=>[...secs[et].querySelectorAll('.row')].find(r=>r.querySelector('label') && r.querySelector('label').textContent===label);
const scl=et=>typeRow(et,'Grip rumble strength').querySelector('select');
for(let et=0;et<4;et++)assert(!typeRow(et,'Rumble style'));
assert(scl(1).parentElement.classList.contains('hide'));assert(!$('#rumbleScale').parentElement.classList.contains('hide'));
const p25=p.concat(Array(10).fill(0));p25[0]=25;[100,75,50,100].forEach((v,i)=>p25[210+i]=v);
p=p25;applyBlob(new Uint8Array(p25));
assert($('#rumbleScale').parentElement.classList.contains('hide'));assert(!scl(0).parentElement.classList.contains('hide'));
assert.equal(scl(0).value,'200');assert.equal(scl(1).value,'150');
scl(2).value='300';assert.deepEqual(await change(scl(2)),[2,110,150]);
const b25=buildBackup(p25,[1].concat(Array(97).fill(0)));
assert.equal(b25.config.types[0].rumbleScale,200);assert(!('rumbleStyle' in b25.config.types[0]) && !('rumbleStyle' in b25.config));
// v26: the DualSense tab's controller speaker volume (blob p[208] = JS p[206], percent/2; field 114), hidden before v26.
const spk=secs.map(sec=>[...sec.querySelectorAll('.row')].find(r=>r.querySelector('label') && r.querySelector('label').textContent==='Controller speaker')).filter(Boolean);
assert.equal(spk.length,1);assert(spk[0].parentElement.classList.contains('hide'));
const p26=p25.slice();p26[0]=26;p26[206]=50;p=p26;applyBlob(new Uint8Array(p26));
assert(!spk[0].parentElement.classList.contains('hide'));const spkSel=spk[0].querySelector('select');assert.equal(spkSel.value,'100');
spkSel.value='0';assert.deepEqual(await change(spkSel),[2,114,0]);
// v27: one grip limiter knee (blob p[209] = JS p[207], percent; field 115) on the DS5 and Switch tabs, hidden before v27.
const lim=secs.map(sec=>[...sec.querySelectorAll('.row')].find(r=>r.querySelector('label') && r.querySelector('label').textContent==='Grip limiter')).filter(Boolean);
assert.equal(lim.length,2);for(const r of lim)assert(r.parentElement.classList.contains('hide'));
const p27=p26.slice();p27[0]=27;p27[207]=80;p=p27;applyBlob(new Uint8Array(p27));
for(const r of lim){assert(!r.parentElement.classList.contains('hide'));assert.equal(r.querySelector('select').value,'80');}
const limSel=lim[1].querySelector('select');limSel.value='100';assert.deepEqual(await change(limSel),[2,115,100]);
p=p.slice(0,204);p[0]=23;await apply();
// Original per-type mapping and mode controls remain present.
assert(document.querySelectorAll('.modebtn').length>=11);assert($('#lizardList'));
s[46]=57;await apply();
const backup=buildBackup(p,bp);
assert.equal(backup.config.shortcutFlags,57);for(const k of ['swProfiles','rumblePresets','strengthSteps','rumbleSlot','strengthSlots','rumbleStyle'])assert(!(k in backup.config),k);
const removedField=x=>x[0]===2&&(x[1]===39||(x[1]>=104&&x[1]<=107)||(x[1]>=190&&x[1]<230)||(x[1]>=241&&x[1]<=252));
let before=writes.length;await importBackup({text:async()=>JSON.stringify(backup)});
for(const [f,v] of [[240,57],[239,18]])assert(writes.some(x=>x[0]===2&&x[1]===f&&x[2]===v),JSON.stringify({f,v,log:$("#log").textContent}));
assert(!writes.slice(before).some(removedField));
// an older backup carrying removed settings still imports; their fields are never sent
const old=JSON.parse(JSON.stringify(backup));Object.assign(old.config,{swProfiles:Array(37).fill(0),rumbleStyle:5,rumblePresets:[5,0,8],strengthSteps:[200,300,500,200,300,500],rumbleSlot:1,strengthSlots:[0,1]});
before=writes.length;await importBackup({text:async()=>JSON.stringify(old)});assert(writes.length>before);assert(!writes.slice(before).some(removedField));
const bad=JSON.parse(JSON.stringify(backup));bad.config.hdPadScale=301;before=writes.length;await importBackup({text:async()=>JSON.stringify(bad)});assert.equal(writes.length,before);
applySw(null);before=writes.length;globalThis.confirm=()=>{throw Error('must reject incompatible restore');};await importBackup({text:async()=>JSON.stringify(backup)});assert.equal(writes.length,before);
assert(lastSet());
console.log('Configurator mode shortcuts, Switch tab, per-mode strength and backup tests passed');cleanup();
})().catch(e=>{cleanup();console.error(e);process.exitCode=1;});
