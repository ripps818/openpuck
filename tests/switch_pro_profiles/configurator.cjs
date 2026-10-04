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
const s=Array(55).fill(0);s[0]=1;s[1]=1;s[2]=0;s[38]=1;s[39]=1;s[40]=150;s[41]=5;s[42]=0;s[43]=8;s[44]=2;s[45]=18;s[46]=63;
[100,150,250,100,150,250].forEach((v,i)=>s[47+i]=v);s[53]=1;s[54]=0;
for(let i=0;i<7;i++)s[19+i]=i+1;
const apply=()=>w.eval('applyBlob(new Uint8Array('+JSON.stringify(p)+'));applySw(new Uint8Array('+JSON.stringify(s)+'))');apply();
assert(!w.document.querySelector('#calibrationCard'));assert(!w.document.querySelector('#hdWaveform'));
const styles=w.document.querySelector('#rumbleStyle');assert.deepEqual(Array.from(styles.options,o=>+o.value),[0,1,2,3,4,5,6,8]);assert.equal(styles.options[7].textContent,'HD Emulation');assert.equal(styles.value,'8');
assert.equal(w.document.querySelector('#rumbleState3').value,'8');assert.equal(w.document.querySelector('#strength01').value,'300');assert.equal(w.document.querySelector('#qamSelect').value,'18');
assert.equal(w.document.querySelector('#scQam').textContent,'Quick Access');assert.equal(w.document.querySelector('#scProfiles').textContent,'Switch profiles');
assert(w.document.querySelector('.chord').parentElement.classList.contains('hide'));
const profileChords=w.document.querySelectorAll('#swProfileChords select');assert(profileChords[3].parentElement.classList.contains('hide'));assert(!profileChords[0].parentElement.classList.contains('hide'));
w.document.querySelector('#scQam').click();assert.deepEqual(w.writes.pop(),[240,62]);s[46]=62;apply();assert.equal(w.document.querySelector('#scQam').textContent,'All four back buttons');
w.document.querySelector('#scProfiles').click();assert.deepEqual(w.writes.pop(),[240,60]);s[46]=60;apply();assert(!w.document.querySelector('.chord').parentElement.classList.contains('hide'));
w.document.querySelector('#scHaptics').click();assert.deepEqual(w.writes.pop(),[240,56]);s[46]=56;apply();for(const el of w.document.querySelectorAll('.chordD'))assert(!el.parentElement.classList.contains('hide'));
for(const [id,bit] of [['scFeedback',8],['scCapture',16],['scEnabled',32]]){w.document.querySelector('#'+id).click();assert.deepEqual(w.writes.pop(),[240,s[46]^bit]);}
const preset=w.document.querySelector('#rumbleState2');preset.value='6';preset.dispatchEvent(new w.Event('change'));assert.deepEqual(w.writes.pop(),[242,6]);
const step=w.document.querySelector('#strength12');step.value='420';step.dispatchEvent(new w.Event('change'));assert.deepEqual(w.writes.pop(),[249,210]);let before=w.writes.length;step.value='421';step.dispatchEvent(new w.Event('change'));assert.equal(w.writes.length,before);
const capture=w.document.querySelector('#qamSelect');capture.value='0';capture.dispatchEvent(new w.Event('change'));assert.deepEqual(w.writes.pop(),[239,0]);
// Original per-type mapping, mode and profile controls remain present.
assert(w.document.querySelectorAll('.modebtn').length>=11);assert.equal(w.document.querySelectorAll('#swProfileBack select').length,4);assert.equal(profileChords.length,7);
assert(w.document.querySelector('#lizardList'));assert(w.document.querySelector('#swGyroMap'));assert(w.document.querySelector('#swClickFeedback'));
const edit=w.document.querySelector('#swProfileEdit');edit.value='6';edit.dispatchEvent(new w.Event('change'));const backs=w.document.querySelectorAll('#swProfileBack select');backs[3].value='20';backs[3].dispatchEvent(new w.Event('change'));assert.deepEqual(w.writes.pop(),[229,20]);
s[46]=63;apply();w.testConnect();w.confirm=()=>true;
const bp=Array(98).fill(0);bp[0]=1;w.eval("readBlob=async()=>new Uint8Array("+JSON.stringify(p)+");readFrame=async()=>new Uint8Array("+JSON.stringify(bp)+");waitIdle=async()=>{};modalOpen=()=>{};modalStage=()=>{};modalDone=()=>{};");
const backup=w.eval('buildBackup('+JSON.stringify(p)+','+JSON.stringify(bp)+')');assert.deepEqual(Array.from(backup.config.rumblePresets),[5,0,8]);assert.deepEqual(Array.from(backup.config.strengthSteps),[200,300,500,200,300,500]);assert.equal(backup.config.shortcutFlags,63);assert(!('hdWaveform' in backup.config));assert(!('waveToggle' in backup.config));
await w.importBackup({text:async()=>JSON.stringify(backup)});for(const [f,v] of [[241,5],[243,8],[244,100],[249,250],[240,63],[239,18],[251,1],[252,0]])assert(w.writes.some(x=>x[0]===2&&x[1]===f&&x[2]===v),JSON.stringify({f,v,log:w.document.querySelector("#log").textContent,backup:backup.config}));
const bad=JSON.parse(JSON.stringify(backup));bad.config.strengthSteps[0]=301;before=w.writes.length;await w.importBackup({text:async()=>JSON.stringify(bad)});assert.equal(w.writes.length,before);
w.eval('applySw(null)');before=w.writes.length;w.confirm=()=>{throw Error('must reject incompatible restore');};await w.importBackup({text:async()=>JSON.stringify(backup)});assert.equal(w.writes.length,before);
console.log('Final configurator controls, legacy features, toggles and backup tests passed');w.close();
})().catch(e=>{cleanup();console.error(e);process.exitCode=1;});
