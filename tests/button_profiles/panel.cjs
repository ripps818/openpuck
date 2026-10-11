const fs=require('fs'),path=require('path'),assert=require('assert'),{pathToFileURL}=require('url');
const {JSDOM}=require('jsdom');
const js=path.join(__dirname,'../../panel');
const html=fs.readFileSync(path.join(__dirname,'../../docs/index.html'),'utf8');
let cleanup=()=>{};
(async()=>{
// The mapping profile cards (status v30+): load the panel modules against a fake puck that keeps the profiles the
// way btnmap.cpp does and answers every op 0x2C..0x33 with the type's 0xB0 frame.
const dom=new JSDOM(html,{url:'http://localhost/'}),w=dom.window;
const timers=[],setIntervalNode=setInterval;globalThis.setInterval=(...a)=>{const t=setIntervalNode(...a);timers.push(t);return t;};
cleanup=()=>{timers.forEach(clearInterval);w.close();};
for(const k of ['window','document','navigator','location','localStorage','history','getComputedStyle','prompt'])
  Object.defineProperty(globalThis,k,{value:k==='window'?w:(typeof w[k]==='function'?w[k].bind(w):w[k]),configurable:true,writable:true});
let confirms=[];globalThis.confirm=m=>{confirms.push(m);return true;};globalThis.fetch=async()=>({ok:false,json:async()=>[]});
const mod=f=>import(pathToFileURL(path.join(js,f)).href);
await mod('app.js');
const {S}=await mod('state.js'),{applyBlob,applySw}=await mod('status.js'),{typeEls,setTab}=await mod('types.js');
const {profilesDrain}=await mod('profiles.js'),{buildBackup,importBackup}=await mod('backup.js');

// the firmware's default map (remapDefaultMap): every source itself, paddles LB/RB/L3/R3, QAM none
const DEF=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,5,6,7,8,0,21,22,19,20];
const fresh=()=>[0,1,2,3].map(()=>({active:0,maps:[0,1,2].map(()=>DEF.slice()),pads:[[0,0],[0,0],[0,0]]}));
let model=fresh(),gesture=[1,4,5];
const dump=et=>{const m=model[et],a=[1,et,m.active,3,24];for(let i=0;i<3;i++)a.push(...m.maps[i],...m.pads[i]);return a.concat(gesture);};
const swap=c=>({1:2,2:1,3:4,4:3})[c]||c;
const ops=[],writes=[];let last=null;
function onOp(a){
  const [op,et,x,y,z]=a,m=model[et];
  if(op===0x2D)m.maps[x][y]=z;
  else if(op===0x2E)for(let i=0;i<4;i++)m.maps[x][i]=swap(m.maps[x][i]);
  else if(op===0x2F){m.maps[x]=DEF.slice();m.pads[x]=[0,0];}
  else if(op===0x30)m.active=x;
  else if(op===0x31)m.pads[x][y]=z;
  else if(op===0x32){m.maps[y]=m.maps[x].slice();m.pads[y]=m.pads[x].slice();}
  else if(op===0x33)gesture=[x,y,z];
}
// status v30 blob (JS indices): p[209] = each type's active profile, two bits per type
let p=Array(210).fill(0);p[0]=30;p[193]=8;p[51]=100;
const s=Array(55).fill(0);s[0]=1;s[46]=57;
const frame=(mk,a)=>({status:'ok',data:new DataView(new Uint8Array([mk,a.length,...a]).buffer)});
S.dev={serialNumber:'test',
  transferOut:async(ep,b)=>{const a=Array.from(b);writes.push(a);last=a;if(a[0]>=0x2C&&a[0]<=0x33){ops.push(a);onOp(a);}return {status:'ok'};},
  transferIn:async()=>last&&last[0]>=0x2C&&last[0]<=0x33?frame(0xB0,dump(last[1])):last&&last[0]===0x27?frame(0xAE,s):last&&last[0]===0x09?frame(0xA7,[1].concat(Array(97).fill(0))):frame(0xA5,p)};
const settle=()=>new Promise(r=>setTimeout(r,30));
const activeBits=()=>model.reduce((v,m,et)=>v|(m.active<<(2*et)),0);
const apply=async()=>{p[209]=activeBits();applyBlob(new Uint8Array(p));applySw(new Uint8Array(s));await settle();};
const opsOf=async fn=>{const n=ops.length;await fn();await settle();return ops.slice(n);};
const change=(sel,v)=>{sel.value=String(v);sel.dispatchEvent(new w.Event('change'));};
const cards=et=>[...typeEls[et].sec.querySelectorAll('.prof-card')];
const legacy=()=>[...document.querySelectorAll('.prof-legacy')];
const shown=el=>!el.classList.contains('hide');

// v29 firmware: no profile cards, the single-mapping controls stay
p[0]=29;await apply();
assert.equal(cards(0).length,3);for(let et=0;et<4;et++)assert(cards(et).every(c=>!shown(c)));
const legacyShown=el=>!el.classList.contains('prof-off');
assert.equal(legacy().length,4*3);assert(legacy().every(legacyShown));
assert.equal(S.profileLoadDue.size,0);

// v30: the cards appear, the paddle / QAM / swap controls go, and every type is queued for a load
p[0]=30;model[2].active=1;await apply();
assert(cards(0).every(shown));assert(legacy().every(e=>!legacyShown(e)));
assert.deepEqual([...S.profileLoadDue].sort(),[0,1,2,3]);
assert.deepEqual((await opsOf(profilesDrain)).map(a=>a.slice(0,2)),[[0x2C,0],[0x2C,1],[0x2C,2],[0x2C,3]]);
assert.equal(S.profileLoadDue.size,0);assert.deepEqual(S.gesture,{enabled:1,prev:4,next:5});
// a blob with the same active profiles queues nothing; a profile switched on the controller reloads that type
await apply();assert.equal(S.profileLoadDue.size,0);
model[1].active=2;await apply();assert.deepEqual([...S.profileLoadDue],[1]);await profilesDrain();

const rec=et=>typeEls[et].prof;
const dots=et=>rec(et).tabs.map(b=>b.querySelector('.active-dot').style.display!=='none');
// the editor opens on the profile in use, marked by its dot
assert.deepEqual(dots(2),[false,true,false]);assert.deepEqual(rec(2).tabs.map(b=>b.classList.contains('active')),[false,true,false]);
assert.equal(rec(2).title.textContent,'Button map · profile 2 (in use)');assert(rec(2).use.disabled);
assert.deepEqual(dots(1),[false,false,true]);

// PlayStation types name the face buttons by their symbols, and so does their layout preset
const labels=et=>rec(et).sources.map(sel=>sel.closest('.row').querySelector('label').lastChild.textContent.trim());
assert.deepEqual(labels(3).slice(0,4),['Cross','Circle','Square','Triangle']);
assert.deepEqual(labels(0).slice(0,4),['A','B','X','Y']);
assert.deepEqual(labels(0).slice(15,24),['L4','R4','L5','R5','QAM','Left trackpad click','Right trackpad click','LT (full pull)','RT (full pull)']);
for(const et of [2,3]){
  assert.equal(rec(et).nintendo.textContent,'Swap Cross/Circle and Square/Triangle');
  const names=[...rec(et).sources[0].options].map(o=>o.textContent);
  assert(!names.some(n=>/^[ABXY]$/.test(n)),names.join());assert(names.includes('Cross')&&names.includes('Touchpad Click'));
}
assert.equal(rec(0).nintendo.textContent,'Apply Nintendo layout');assert.equal(rec(1).nintendo.textContent,'Apply Nintendo layout');
// targets a type does not have are not offered: Capture is Switch-only
const has=(et,c)=>[...rec(et).sources[0].options].some(o=>+o.value===c);
assert(has(1,18)&&!has(0,18)&&!has(2,18));assert(has(3,17)&&!has(2,17));
// every source shows its stored target
assert.deepEqual(rec(0).sources.map(sel=>+sel.value),DEF);

// edits address the profile being edited, not the active one
setTab(0);rec(0).tabs[1].click();
assert.equal(rec(0).title.textContent,'Button map · profile 2');assert(!rec(0).use.disabled);
assert.deepEqual(await opsOf(()=>change(rec(0).sources[15],1)),[[0x2D,0,1,15,1]]);
assert.equal(model[0].maps[1][15],1);assert.equal(model[0].maps[0][15],5);assert.equal(rec(0).sources[15].value,'1');
assert.deepEqual(await opsOf(()=>rec(0).nintendo.click()),[[0x2E,0,1]]);
assert.deepEqual(rec(0).sources.slice(0,4).map(sel=>+sel.value),[2,1,4,3]);
assert.deepEqual(await opsOf(()=>rec(0).use.click()),[[0x30,0,1]]);
assert.deepEqual(dots(0),[false,true,false]);assert(rec(0).use.disabled);
// copy offers the other two profiles and asks first
rec(0).tabs[2].click();
assert.deepEqual([...rec(0).copyFrom.options].map(o=>+o.value),[0,1]);
rec(0).copyFrom.value='1';confirms=[];
assert.deepEqual(await opsOf(()=>rec(0).copy.click()),[[0x32,0,1,2]]);assert.equal(confirms.length,1);
assert.deepEqual(model[0].maps[2],model[0].maps[1]);assert.equal(rec(0).sources[15].value,'1');
globalThis.confirm=()=>false;assert.deepEqual(await opsOf(()=>rec(0).reset.click()),[]);globalThis.confirm=m=>{confirms.push(m);return true;};
assert.deepEqual(await opsOf(()=>rec(0).reset.click()),[[0x2F,0,2]]);assert.deepEqual(model[0].maps[2],DEF);

// the Trackpads card follows the profile being edited, and writes to it
const pads=typeEls[0].padStick;
rec(0).tabs[1].click();
{const n=writes.length;assert.deepEqual(await opsOf(()=>change(pads[0],2)),[[0x31,0,1,0,2]]);assert(!writes.slice(n).some(x=>x[0]===2));}
rec(0).tabs[0].click();assert.equal(pads[0].value,'0');
rec(0).tabs[1].click();assert.equal(pads[0].value,'2');
// the status blob's trackpad bytes (the active profile's) do not overwrite the edited profile's
rec(0).tabs[2].click();model[0].pads[2]=[0,0];await apply();assert.equal(pads[0].value,'0');rec(0).tabs[1].click();await apply();assert.equal(pads[0].value,'2');

// a code this panel has no name for (a macro slot, say) is shown, not dropped
model[0].maps[1][10]=130;S.profileLoadDue.add(0);await opsOf(profilesDrain);
assert.equal(rec(0).sources[10].value,'130');assert.equal(rec(0).sources[10].selectedOptions[0].textContent,'Other (130)');
model[0].maps[1][10]=11;S.profileLoadDue.add(0);await opsOf(profilesDrain);
assert(![...rec(0).sources[10].options].some(o=>o.dataset.extra));assert.equal(rec(0).sources[10].value,'11');

// the profile switch is one setting for the whole puck, shown on every type
assert.equal(rec(3).gesture.onoff.textContent,'on');assert.equal(rec(3).gesture.prev.value,'4');
assert.deepEqual([...rec(3).gesture.prev.options].map(o=>o.textContent),['L1','R1','L3','R3','Create','Options']);
assert.deepEqual(await opsOf(()=>rec(3).gesture.onoff.click()),[[0x33,3,0,4,5]]);
assert.equal(rec(0).gesture.onoff.textContent,'off');
assert.deepEqual(await opsOf(()=>change(rec(0).gesture.next,7)),[[0x33,0,0,4,7]]);assert.equal(rec(2).gesture.next.value,'7');

// Reset to defaults resets all three profiles and puts profile 1 in use; the mapping fields are not written
{setTab(0);const n=writes.length;await $reset();
 const sent=writes.slice(n);
 assert.deepEqual(sent.filter(x=>x[0]>=0x2C&&x[0]<=0x33),[[0x2F,0,0],[0x2F,0,1],[0x2F,0,2],[0x30,0,0]]);
 const fields=sent.filter(x=>x[0]===2).map(x=>x[1]);
 for(const f of [40,41,42,43,44,45,80,81])assert(!fields.includes(f),'field '+f);
 assert(fields.includes(46)&&fields.includes(48)&&fields.includes(108));
 assert(model[0].maps.every(m=>m.join()===DEF.join()));assert.equal(model[0].active,0);}
async function $reset(){await document.querySelector('#mapReset').onclick();await settle();}

// Backup: the profiles and the switch buttons ride along, and a restore sends only what differs
model[3].maps[2][0]=4;model[3].pads[2]=[1,2];model[3].active=2;gesture=[1,6,7];
await apply();await profilesDrain();
const b=buildBackup(p,[1].concat(Array(97).fill(0)));
assert.equal(b.version,3);assert.equal(b.config.profiles.length,4);
assert.deepEqual(b.config.profiles[3],{active:2,maps:model[3].maps,pads:model[3].pads});
assert.deepEqual(b.config.profileGesture,{enabled:1,prev:6,next:7});
// restore onto a puck at factory profiles
model=fresh();gesture=[1,4,5];
{const n=ops.length,nw=writes.length;await importBackup({text:async()=>JSON.stringify(b)});
 const sent=ops.slice(n),edits=sent.filter(x=>x[0]!==0x2C);
 assert.deepEqual(edits,[[0x30,1,2],[0x30,2,1],[0x2D,3,2,0,4],[0x31,3,2,0,1],[0x31,3,2,1,2],[0x30,3,2],[0x33,0,1,6,7]]);
 assert.equal(sent.filter(x=>x[0]===0x2C).length,4);
 // the per-type mapping fields would only reach the active profile: they are left to the profile ops
 const mapped=new Set();for(let et=0;et<4;et++){for(let k=0;k<6;k++)mapped.add(40+et*9+k);mapped.add(80+et*2);mapped.add(81+et*2);}
 const fields=writes.slice(nw).filter(x=>x[0]===2).map(x=>x[1]);
 assert(fields.includes(46));assert(!fields.some(f=>mapped.has(f)),fields.join());}
assert.deepEqual(model[3].maps[2][0],4);assert.equal(model[3].active,2);assert.deepEqual(gesture,[1,6,7]);
// a backup without profiles (older panel) still writes the per-type mapping fields
{const old=JSON.parse(JSON.stringify(b));delete old.config.profiles;delete old.config.profileGesture;old.version=1;
 const n=writes.length;await importBackup({text:async()=>JSON.stringify(old)});
 const sent=writes.slice(n);assert(!sent.some(x=>x[0]>=0x2D&&x[0]<=0x33));assert(sent.some(x=>x[0]===2&&x[1]===40));}
// a malformed profile list is refused before anything is written
{const bad=JSON.parse(JSON.stringify(b));bad.config.profiles[0].maps[0][3]=300;
 const n=writes.length;await importBackup({text:async()=>JSON.stringify(bad)});assert.equal(writes.length,n);}

console.log('Mapping profile panel: visibility, loading, labels, edits, copy/reset, trackpads, gesture, reset to defaults and backup tests passed');cleanup();
})().catch(e=>{cleanup();console.error(e);process.exitCode=1;});
