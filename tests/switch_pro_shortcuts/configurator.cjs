const fs=require('fs'),path=require('path'),assert=require('assert');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync(path.join(__dirname,'../../docs/index.html'),'utf8');
let cleanup=()=>{};
(async()=>{
const dom=new JSDOM(html,{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window;cleanup=()=>w.close();w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;w.fetch=async()=>({ok:false,json:async()=>[]});
w.eval(html.split('<script>')[1].split('</script>')[0]+"\nwindow.testConnect=()=>{dev={serialNumber:'test'};};");
w.eval("loadLizard=async()=>{};lizardCapable=()=>false;window.writes=[];setField=async(f,v)=>window.writes.push([f,v]);send=async bytes=>window.writes.push(Array.from(bytes));");
// Fork layout: v23 status blob + the separate 0xAE Switch Pro / shortcut frame (readFrame strips [0xAE][len]).
const p=Array(204).fill(0);p[0]=23;p[60]=1;p[193]=8;p[51]=100;
const s=Array(55).fill(0);s[0]=1;s[38]=1;s[39]=1;s[40]=150;s[45]=18;s[46]=57;
const apply=()=>w.eval('applyBlob(new Uint8Array('+JSON.stringify(p)+'));applySw(new Uint8Array('+JSON.stringify(s)+'))');apply();
const $=sel=>w.document.querySelector(sel);
// Rumble style is automatic: no style pickers, rumble presets, strength steps, D-pad haptic toggle or save button.
for(const id of ['rumbleStyle','rumbleState1','strengthSteps','scHaptics','shortcutSave','hdTuning','calibrationCard','hdWaveform','swProfilesCard','scProfiles','swProfileChords'])assert(!$('#'+id),id);
assert.equal($('#qamSelect').value,'18');
// Shortcut toggles live in the Mode shortcuts card; every chord is available.
assert(!$('#shortcutToggles').classList.contains('hide'));assert($('#shortcutToggles').closest('.card').querySelector('.chord'));
assert.equal($('#scQam').textContent,'Quick Access');
for(const el of w.document.querySelectorAll('.chord,.chordD'))assert(!el.parentElement.classList.contains('hide'));
$('#scQam').click();assert.deepEqual(w.writes.pop(),[240,56]);s[46]=56;apply();assert.equal($('#scQam').textContent,'All four back buttons');
for(const [id,bit] of [['scFeedback',8],['scCapture',16],['scEnabled',32]]){$('#'+id).click();assert.deepEqual(w.writes.pop(),[240,s[46]^bit]);}
// Switch Pro-only controls (and HD trackpad strength) live in the Switch tab of Button mapping.
const swTab=$('#swClickControls').parentElement;assert($('#typeCfgs').contains(swTab));
for(const id of ['#qamSelectRow','#swGyroMap','#hdPadScale'])assert(swTab.contains($(id)),id);
assert(!$('#swClickControls').classList.contains('hide'));assert.equal($('#swClickFeedback').value,'1');
const click=$('#swClickFeedback');click.value='0';click.dispatchEvent(new w.Event('change'));assert.deepEqual(w.writes.pop(),[230,0]);
const capture=$('#qamSelect');capture.value='0';capture.dispatchEvent(new w.Event('change'));assert.deepEqual(w.writes.pop(),[239,0]);
// v25: grip strength per type in Button mapping (no style row); the global strength row hides.
const secs=[...$('#typeCfgs').children].slice(1);
const typeRow=(et,label)=>[...secs[et].querySelectorAll('.row')].find(r=>r.querySelector('label') && r.querySelector('label').textContent===label);
const scl=et=>typeRow(et,'Grip rumble strength').querySelector('select');
for(let et=0;et<4;et++)assert(!typeRow(et,'Rumble style'));
assert(scl(1).parentElement.classList.contains('hide'));assert(!$('#rumbleScale').parentElement.classList.contains('hide'));
const p25=p.concat(Array(10).fill(0));p25[0]=25;[100,75,50,100].forEach((v,i)=>p25[210+i]=v);
w.eval('applyBlob(new Uint8Array('+JSON.stringify(p25)+'))');
assert($('#rumbleScale').parentElement.classList.contains('hide'));assert(!scl(0).parentElement.classList.contains('hide'));
assert.equal(scl(0).value,'200');assert.equal(scl(1).value,'150');
scl(2).value='300';scl(2).dispatchEvent(new w.Event('change'));assert.deepEqual(w.writes.pop(),[110,150]);
const b25=w.eval('buildBackup('+JSON.stringify(p25)+','+JSON.stringify([1].concat(Array(97).fill(0)))+')');
assert.equal(b25.config.types[0].rumbleScale,200);assert(!('rumbleStyle' in b25.config.types[0]) && !('rumbleStyle' in b25.config));
// v26: the DualSense tab's controller speaker volume (blob p[208] = JS p[206], percent/2; field 114), hidden before v26.
const spk=secs.map(sec=>[...sec.querySelectorAll('.row')].find(r=>r.querySelector('label') && r.querySelector('label').textContent==='Controller speaker')).filter(Boolean);
assert.equal(spk.length,1);assert(spk[0].parentElement.classList.contains('hide'));
const p26=p25.slice();p26[0]=26;p26[206]=50;w.eval('applyBlob(new Uint8Array('+JSON.stringify(p26)+'))');
assert(!spk[0].parentElement.classList.contains('hide'));const spkSel=spk[0].querySelector('select');assert.equal(spkSel.value,'100');
spkSel.value='0';spkSel.dispatchEvent(new w.Event('change'));assert.deepEqual(w.writes.pop(),[114,0]);
apply();
// Original per-type mapping and mode controls remain present.
assert(w.document.querySelectorAll('.modebtn').length>=11);assert($('#lizardList'));
s[46]=57;apply();w.testConnect();w.confirm=()=>true;
const bp=Array(98).fill(0);bp[0]=1;w.eval("readBlob=async()=>new Uint8Array("+JSON.stringify(p)+");readFrame=async()=>new Uint8Array("+JSON.stringify(bp)+");waitIdle=async()=>{};modalOpen=()=>{};modalStage=()=>{};modalDone=()=>{};");
const backup=w.eval('buildBackup('+JSON.stringify(p)+','+JSON.stringify(bp)+')');
assert.equal(backup.config.shortcutFlags,57);for(const k of ['swProfiles','rumblePresets','strengthSteps','rumbleSlot','strengthSlots','rumbleStyle'])assert(!(k in backup.config),k);
const removedField=x=>x[0]===2&&(x[1]===39||(x[1]>=104&&x[1]<=107)||(x[1]>=190&&x[1]<230)||(x[1]>=241&&x[1]<=252));
let before=w.writes.length;await w.importBackup({text:async()=>JSON.stringify(backup)});
for(const [f,v] of [[240,57],[239,18]])assert(w.writes.some(x=>x[0]===2&&x[1]===f&&x[2]===v),JSON.stringify({f,v,log:$("#log").textContent}));
assert(!w.writes.slice(before).some(removedField));
// an older backup carrying removed settings still imports; their fields are never sent
const old=JSON.parse(JSON.stringify(backup));Object.assign(old.config,{swProfiles:Array(37).fill(0),rumbleStyle:5,rumblePresets:[5,0,8],strengthSteps:[200,300,500,200,300,500],rumbleSlot:1,strengthSlots:[0,1]});
before=w.writes.length;await w.importBackup({text:async()=>JSON.stringify(old)});assert(w.writes.length>before);assert(!w.writes.slice(before).some(removedField));
const bad=JSON.parse(JSON.stringify(backup));bad.config.hdPadScale=301;before=w.writes.length;await w.importBackup({text:async()=>JSON.stringify(bad)});assert.equal(w.writes.length,before);
w.eval('applySw(null)');before=w.writes.length;w.confirm=()=>{throw Error('must reject incompatible restore');};await w.importBackup({text:async()=>JSON.stringify(backup)});assert.equal(w.writes.length,before);
console.log('Configurator mode shortcuts, Switch tab, per-mode strength and backup tests passed');w.close();
})().catch(e=>{cleanup();console.error(e);process.exitCode=1;});
