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
const {S}=await mod('state.js'),{applyBlob,applySw}=await mod('status.js'),{typeEls,setTab,LIZARD_TAB}=await mod('types.js');
const {profilesDrain}=await mod('profiles.js'),{buildBackup,importBackup}=await mod('backup.js');

// the firmware's default map (remapDefaultMap): every source itself, paddles LB/RB/L3/R3, QAM none
const DEF=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,5,6,7,8,0,21,22,19,20];
const fresh=()=>[0,1,2,3].map(()=>({active:0,maps:[0,1,2].map(()=>DEF.slice()),pads:[[0,0],[0,0],[0,0]]}));
let model=fresh(),gesture=[1,4,5];
const dump=et=>{const m=model[et],a=[1,et,m.active,3,24];for(let i=0;i<3;i++)a.push(...m.maps[i],...m.pads[i]);return a.concat(gesture);};
const swap=c=>({1:2,2:1,3:4,4:3})[c]||c;
// Lizard profiles, as lizard_map.cpp keeps them: three binding lists, one in use, and the profile the lizard
// ops edit (op 0x34; until then the one in use)
const lzB=k=>({outType:1,od:[0,4+k,0,0,0,0,0],trig:2**k,hold:0});
const LZ_DEF=[lzB(0),lzB(1)],clone=m=>m.map(b=>({...b,od:b.od.slice()}));
let lzMaps=[clone(LZ_DEF),[lzB(5)],[lzB(6),lzB(7),lzB(8)]],lzActive=0,lzEdit=null,lzStage=[];
const lzTarget=()=>lzEdit===null?lzActive:lzEdit;
const le=(a,v,n)=>{for(let i=0;i<n;i++)a.push(Math.floor(v/2**(8*i))&0xff);};
const rle=(a,o,n)=>{let v=0;for(let i=n-1;i>=0;i--)v=v*256+a[o+i];return v;};
const lzFrame=m=>{const a=[0xAA,m.length];for(const b of m){a.push(b.outType,...b.od);le(a,b.trig,8);le(a,b.hold,8);}return {status:'ok',data:new DataView(new Uint8Array(a).buffer)};};
const dump4=()=>[1,4,lzActive,3,0].concat(gesture);
function onLizard(a){
  const [op,x,y]=a;
  if(op===0x13)lzStage=Array(x);
  else if(op===0x18)lzStage[x]={outType:a[2],od:a.slice(3,10),trig:rle(a,10,8),hold:rle(a,18,8)};
  else if(op===0x19)lzMaps[lzTarget()]=lzStage;
  else if(op===0x1A)lzMaps[lzTarget()]=clone(LZ_DEF);
  else if(op===0x34)lzEdit=x;
  else if(op===0x2F)lzMaps[y]=clone(LZ_DEF);
  else if(op===0x30)lzActive=y;
  else if(op===0x32)lzMaps[a[3]]=clone(lzMaps[y]);
  else if(op===0x33)gesture=a.slice(2,5);
}
const ops=[],writes=[];let last=null;
function onOp(a){
  if(a[0]===0x34||a[1]===4||(a[0]>=0x13&&a[0]<=0x1A))return onLizard(a);
  const [op,et,x,y,z]=a,m=model[et];
  if(op===0x2D)m.maps[x][y]=z;
  else if(op===0x2E){const was=[2,1,4,3].every((c,i)=>m.maps[x][i]===c);for(let i=0;i<4;i++)m.maps[x][i]=was?i+1:swap(i+1);}
  else if(op===0x2F){m.maps[x]=DEF.slice();m.pads[x]=[0,0];}
  else if(op===0x30)m.active=x;
  else if(op===0x31)m.pads[x][y]=z;
  else if(op===0x32){m.maps[y]=m.maps[x].slice();m.pads[y]=m.pads[x].slice();}
  else if(op===0x33)gesture=[x,y,z];
}
// status v30 blob (JS indices): p[209] = each type's active profile, two bits per type; p[214..229] = the per-type haptic grid
let p=Array(230).fill(0);p[0]=30;p[193]=8;p[51]=100;
for(let et=0;et<4;et++)p[210+et]=100; // per-type grip strength, percent/2
for(let k=0;k<4;k++)for(let et=0;et<4;et++)p[214+4*k+et]=[70,3,9,0][k]; // the grid holds valid values, as a puck's does
// shortcut flags: bit0 Quick Access is the modifier, 3 feedback, 4 Quick Access + Select, 5 shortcuts on
const s=Array(55).fill(0);s[0]=1;s[46]=24;
const frame=(mk,a)=>({status:'ok',data:new DataView(new Uint8Array([mk,a.length,...a]).buffer)});
// the puck's TX FIFO can be full when it answers, and then the frame is lost: dropAnswer makes the next answer
// never arrive (the pending read is satisfied by the next request instead)
let dropAnswer=false,heldRead=null;
S.dev={serialNumber:'test',
  transferOut:async(ep,b)=>{const a=Array.from(b);writes.push(a);last=a;if(a[0]>=0x2C&&a[0]<=0x34){ops.push(a);onOp(a);}else if(a[0]>=0x13&&a[0]<=0x1A)onOp(a);
    if(heldRead){const r=heldRead;heldRead=null;r();}return {status:'ok'};},
  transferIn:async()=>dropAnswer?(dropAnswer=false,new Promise(r=>heldRead=()=>r(answer()))):answer()};
const answer=()=>
  !last?frame(0xA5,(p[209]=activeBits(),p)):last[0]===0x34||(last[0]>=0x2C&&last[0]<=0x33&&last[1]===4)?frame(0xB0,dump4()):last[0]>=0x2C&&last[0]<=0x33?frame(0xB0,dump(last[1])):
    [0x17,0x19,0x1A].includes(last[0])?lzFrame(lzMaps[lzTarget()]):last[0]===0x27?frame(0xAE,(s[47]=lzActive,s)):last[0]===0x09?frame(0xA7,[1].concat(Array(97).fill(0))):frame(0xA5,(p[209]=activeBits(),p));
const settle=()=>new Promise(r=>setTimeout(r,30));
const activeBits=()=>model.reduce((v,m,et)=>v|(m.active<<(2*et)),0);
const apply=async()=>{p[209]=activeBits();s[47]=lzActive;applyBlob(new Uint8Array(p));applySw(new Uint8Array(s));await settle();};
const opsOf=async fn=>{const n=ops.length;await fn();await settle();return ops.slice(n);};
const change=(sel,v)=>{sel.value=String(v);sel.dispatchEvent(new w.Event('change'));};
const cards=et=>[...typeEls[et].sec.querySelectorAll('.prof-card')];
const legacy=()=>[...document.querySelectorAll('.prof-legacy')];
const shown=el=>!el.classList.contains('hide');

// v29 firmware: no profile cards, the single-mapping controls stay
p[0]=29;await apply();
assert.equal(cards(0).length,3);for(let et=0;et<4;et++)assert(cards(et).every(c=>!shown(c)));
const legacyShown=el=>!el.classList.contains('prof-off');
// per type: the back-button card, the QAM row and the swap row; and the Buttons card, with the DS5's Create switch
assert.equal(legacy().length,4*3+4);assert(legacy().every(legacyShown));
assert.equal(S.profileLoadDue.size,0);

// v30: the cards appear, the paddle / QAM / swap controls go, and every type is queued for a load
p[0]=30;model[2].active=1;await apply();
assert(cards(0).every(shown));assert(legacy().every(e=>!legacyShown(e)));
// the profile switch settings sit right below the profile strip, as wide as it, above the button map
for(let et=0;et<4;et++){assert.deepEqual(cards(et).map(c=>c.querySelector('h2').textContent.split(' · ')[0]),['Mapping profile','Switch profiles from the controller','Button map']);
  assert(cards(et).slice(0,2).every(c=>c.classList.contains('span')),'type '+et);}
assert.deepEqual([...S.profileLoadDue].sort(),[0,1,2,3,4]);
// the Lizard profiles too, and the puck's lizard editor is pointed at the one on screen (a reloaded page may differ)
lzEdit=2;
assert.deepEqual((await opsOf(profilesDrain)).map(a=>a.slice(0,2)),[[0x2C,0],[0x2C,1],[0x2C,2],[0x2C,3],[0x2C,4],[0x34,0]]);
assert.equal(lzEdit,0);
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
assert.deepEqual(labels(0).slice(15,24),['L4','R4','L5','R5','QAM','Click','Click','LT (full pull)','RT (full pull)']);
for(const et of [2,3]){
  assert.equal(rec(et).nintendo.textContent,'Apply Nintendo layout');
  assert(/^Swap Cross and Circle, and Square and Triangle \(A and B, X and Y trade places\)/.test(rec(et).nintendo.title),rec(et).nintendo.title);
  const names=[...rec(et).sources[0].options].map(o=>o.textContent);
  assert(!names.some(n=>/^[ABXY]$/.test(n)),names.join());assert(names.includes('Cross')&&names.includes('Touchpad Click'));
}
assert.equal(rec(0).nintendo.textContent,'Apply Nintendo layout');assert.equal(rec(1).nintendo.textContent,'Apply Nintendo layout');assert(/^Swap A and B, and X and Y/.test(rec(0).nintendo.title));
// targets a type does not have are not offered: Capture is Switch-only
const has=(et,c)=>[...rec(et).sources[0].options].some(o=>+o.value===c);
assert(has(1,18)&&!has(0,18)&&!has(2,18));assert(has(3,17)&&!has(2,17));
// every source shows its stored target
assert.deepEqual(rec(0).sources.map(sel=>+sel.value),DEF);

// each trackpad is a column of the Trackpads card: what touching it does, and what its click acts as
const padCols=et=>[...typeEls[et].sec.querySelectorAll('.pad-col')],padCard=et=>padCols(et)[0].closest('.card');
for(let et=0;et<4;et++){
  const cols=padCols(et);assert.equal(cols.length,2);
  assert.deepEqual(cols.map(c=>c.querySelector('h3').lastChild.textContent.trim()),['Left trackpad','Right trackpad']);
  assert.deepEqual(cols.map(c=>[...c.querySelectorAll('.row label')].map(l=>l.textContent)),[['Touch','Click'],['Touch','Click']]);
  assert.deepEqual(cols.map(c=>c.querySelectorAll('select')[0]),typeEls[et].padStick);
  assert.deepEqual(cols.map(c=>c.querySelectorAll('select')[1]),[rec(et).sources[20],rec(et).sources[21]]);
  assert(cols.every(c=>c.closest('.card')===padCard(et)&&!c.closest('.prof-card')));
}
const touch=(et,pad)=>[...typeEls[et].padStick[pad].options].map(o=>o.textContent);
// Disabled is offered where the pad's own use is something (touchpad, mouse); an Off pad already does nothing
// every type offers the trackpad as a D-pad
const DP=['D-pad on touch','D-pad on click'];
assert.deepEqual(touch(0,0),['Off','Left stick','Right stick',...DP]);assert.deepEqual(touch(0,1),['Mouse','Disabled','Left stick','Right stick',...DP]);
assert.deepEqual(touch(2,0),['Touchpad, left half','Disabled','Left stick','Right stick',...DP]);assert.deepEqual(touch(3,1),['Touchpad, right half','Disabled','Left stick','Right stick',...DP]);
assert(!touch(1,0).includes('Disabled')&&!touch(1,1).includes('Disabled'));
assert.deepEqual(touch(1,1),['Off','Left stick','Right stick',...DP]);
// a click can only act as what the type's mode does with it: the mouse on Xbox, the touchpad on PlayStation, nothing on Switch
const padT=et=>[...rec(et).sources[20].options].filter(o=>+o.value>=21).map(o=>o.value+'='+o.textContent+'|'+o.dataset.glyph);
assert.deepEqual(padT(0),['21=Mouse right click|mouseR','22=Mouse left click|mouseL']);
assert.deepEqual(padT(1),[]);
// Quick Access + Select: a target per controller type in the Button map card, from the status blob's p[248 + type]
{const qs=et=>rec(et).qamSelect,rowShown=et=>!qs(et).closest('.row').classList.contains('hide');
 assert([0,1,2,3].every(et=>!rowShown(et)),'hidden on a blob without it');
 while(p.length<250)p.push(0);p[246]=0;p[247]=18;p[248]=10;p[249]=0;await apply();
 assert([0,1,2,3].every(rowShown));assert.deepEqual([0,1,2,3].map(et=>qs(et).value),['0','18','10','0']);
 assert.equal([...qs(1).options].find(o=>o.value==='18').textContent,'Take screenshot');
 assert([0,1,2,3].every(et=>qs(et).closest('.card').querySelector('h2').textContent.startsWith('Button map')&&![...qs(et).options].some(o=>+o.value>20)));
 const n0=writes.length;change(qs(3),9);await new Promise(r=>setTimeout(r,30));
 assert.deepEqual(writes.slice(n0).filter(x=>x[0]===2).pop(),[2,155,9]);
 p.length=230;await apply();assert([0,1,2,3].every(et=>!rowShown(et)));}
// a pad on a D-pad mode spends its click on the D-pad, so that pad's Click is greyed out (and back with any other Touch)
for(const et of [0,1,2,3])for(const pad of [0,1]){
  const click=rec(et).sources[20+pad],other=rec(et).sources[21-pad];
  for(const v of [3,4]){await opsOf(()=>change(typeEls[et].padStick[pad],v));assert(click.disabled&&!other.disabled,'type '+et+' pad '+pad+' D-pad '+v);}
  await opsOf(()=>change(typeEls[et].padStick[pad],0));assert(!click.disabled&&!other.disabled);
}
assert.deepEqual(padT(2),['21=Touchpad click, left half|padClickL','22=Touchpad click, right half|padClickR']);assert.deepEqual(padT(3),padT(2));
assert.deepEqual([rec(0).sources[20].value,rec(0).sources[21].value],['21','22']);
// the factory entries on Switch are the pad clicks too, but nothing there uses them: they read as none
assert.deepEqual([rec(1).sources[20].value,rec(1).sources[21].value],['0','0']);assert(![...rec(1).sources[20].options].some(o=>o.dataset.extra));
// the click rows write the same entries the button map does, and the Xbox pointer and the Switch trackpad settings sit in the card
{const sel0=model[0].active;
 assert.deepEqual(await opsOf(()=>change(rec(0).sources[21],1)),[[0x2D,0,sel0,21,1]]);assert.equal(model[0].maps[sel0][21],1);
 assert.deepEqual(await opsOf(()=>change(rec(0).sources[21],22)),[[0x2D,0,sel0,21,22]]);}
assert(padCard(0).contains(document.querySelector('#mouseCard')));
// the trackpads' haptics are a card of their own, right below the pads
const fbCard=et=>padCard(et).nextElementSibling;
for(const et of [0,1,2,3])assert(fbCard(et).querySelector('h2').textContent==='Trackpad feedback'&&!fbCard(et).contains(padCols(et)[0])&&!padCard(et).contains(rec(et).dpad));
assert(fbCard(1).contains(document.querySelector('#swClickControls'))&&fbCard(1).contains(document.querySelector('#hdPadBlock'))&&!padCard(1).contains(document.querySelector('#hdPadBlock')));
assert(fbCard(2).contains(typeEls[2].dpad)&&fbCard(2).contains(typeEls[2].pad));
setTab(LIZARD_TAB);assert(!padCard(0).contains(document.querySelector('#mouseCard')));assert(document.querySelector('#mapLizardPane').contains(document.querySelector('#mouseCard')));
setTab(0);assert(padCard(0).contains(document.querySelector('#mouseCard')));
// disabling a pad is a firmware v30 value: older firmware would ignore it, so the option is not selectable there
{const dis=et=>[...typeEls[et].padStick[0].options].find(o=>o.textContent==='Disabled');
 p[0]=29;await apply();assert(dis(3).disabled);p[0]=30;await apply();assert(!dis(3).disabled);
 const sel0=model[3].active;
 assert.deepEqual(await opsOf(()=>change(typeEls[3].padStick[0],5)),[[0x31,3,sel0,0,5]]);
 assert.deepEqual(model[3].pads[sel0],[5,0]);assert.equal(typeEls[3].padStick[0].value,'5');
 assert.deepEqual(await opsOf(()=>change(typeEls[3].padStick[0],0)),[[0x31,3,sel0,0,0]]);}
// older firmware has no profile ops: the click rows hide with the cards, the touch selects stay
p[0]=29;await apply();for(let et=0;et<4;et++){assert(padCols(et).every(c=>!shown(c.querySelectorAll('.row')[1])&&shown(c.querySelectorAll('.row')[0])));}
p[0]=30;await apply();for(let et=0;et<4;et++)assert(padCols(et).every(c=>shown(c.querySelectorAll('.row')[1])));

// PlayStation types have a Create preset (it replaced the Create = touchpad click switch); the others do not
assert(!rec(0).create&&!rec(1).create&&rec(2).create&&rec(3).create);
{const sel0=model[3].active;
 assert.equal(rec(3).create.textContent,'Create = touchpad click');assert(/^Make the Create button press the touchpad/.test(rec(3).create.title));
 assert.deepEqual(await opsOf(()=>rec(3).create.click()),[[0x2D,3,sel0,8,16]]);
 assert.equal(rec(3).sources[8].value,'16');assert.equal(rec(3).create.textContent,'Revert Create button');assert(/^Put the Create button back/.test(rec(3).create.title));
 assert.equal(rec(2).create.textContent,'Create = touchpad click'); // another type's profile is not changed
 assert.deepEqual(await opsOf(()=>rec(3).create.click()),[[0x2D,3,sel0,8,9]]);
 assert.equal(rec(3).sources[8].value,'9');assert.equal(rec(3).create.textContent,'Create = touchpad click');}

// Quick Access is not mappable while it is the shortcut modifier of the enabled mode shortcuts
{const qam=()=>rec(0).sources[19],bare=()=>[...qam().options].map(o=>o.textContent).join();
 const btn=()=>qam().parentElement.querySelector('.gsel-btn');
 assert(!qam().disabled&&!btn().disabled);assert.equal(qam().value,'0');
 s[46]=57;await apply();
 assert(qam().disabled&&btn().disabled);assert.equal(btn().textContent,'Shortcut modifier');assert.equal(bare(),'Shortcut modifier');
 assert(/shortcut modifier/.test(qam().closest('.row').title));
 {const n=ops.length;btn().click();await settle();assert.equal(ops.length,n);} // nothing to pick
 // the other rows are untouched, and the stored target survives for later
 assert.equal(rec(0).sources[0].value,'1');
 for(const f of [56,32,25,24]){s[46]=f;await apply();const res=(f&33)===33;assert.equal(qam().disabled,res,'flags '+f);assert.equal(btn().textContent!=='Shortcut modifier',!res,'flags '+f);}
 assert.equal(qam().value,'0');assert(qam().options.length>5);
 // changed on another tab's type too, and while a profile other than the one in use is shown
 s[46]=57;await apply();for(let et=0;et<4;et++)assert(rec(et).sources[19].disabled,'type '+et);
 s[46]=24;await apply();for(let et=0;et<4;et++)assert(!rec(et).sources[19].disabled,'type '+et);}

// a lost answer: the panel reads the type's profiles again, so the page still shows the new mapping
{rec(0).tabs[1].click();model[0].maps[1][0]=1;model[0].maps[1][1]=2;S.profileLoadDue.add(0);await opsOf(profilesDrain);
 dropAnswer=true;const n=ops.length;rec(0).nintendo.click();await new Promise(r=>setTimeout(r,2200));
 assert.deepEqual(ops.slice(n),[[0x2E,0,1],[0x2C,0]]);assert.deepEqual(rec(0).sources.slice(0,4).map(sel=>+sel.value),[2,1,4,3]);
 const lg=document.querySelector('#log').textContent;assert(/no answer, reading the profiles again/.test(lg),lg.slice(-200));
 model[0].maps[1]=DEF.slice();model[0].maps[1][15]=5;S.profileLoadDue.add(0);await opsOf(profilesDrain);rec(0).tabs[0].click();}

// edits address the profile being edited, not the active one
setTab(0);rec(0).tabs[1].click();
assert.equal(rec(0).title.textContent,'Button map · profile 2');assert(!rec(0).use.disabled);
assert.deepEqual(await opsOf(()=>change(rec(0).sources[15],1)),[[0x2D,0,1,15,1]]);
assert.equal(model[0].maps[1][15],1);assert.equal(model[0].maps[0][15],5);assert.equal(rec(0).sources[15].value,'1');
assert.deepEqual(await opsOf(()=>rec(0).nintendo.click()),[[0x2E,0,1]]);
assert.deepEqual(rec(0).sources.slice(0,4).map(sel=>+sel.value),[2,1,4,3]);
// the button follows the state: with the face buttons exchanged it reverts them
assert.equal(rec(0).nintendo.textContent,'Revert Nintendo layout');assert(/^Put the four face buttons back/.test(rec(0).nintendo.title));
assert.equal(rec(1).nintendo.textContent,'Apply Nintendo layout'); // another type's profile is not swapped
// reverting writes the four entries, so it works on firmware that does not toggle op 0x2E
assert.deepEqual(await opsOf(()=>rec(0).nintendo.click()),[[0x2D,0,1,0,1],[0x2D,0,1,1,2],[0x2D,0,1,2,3],[0x2D,0,1,3,4]]);
assert.deepEqual(rec(0).sources.slice(0,4).map(sel=>+sel.value),[1,2,3,4]);assert.equal(rec(0).nintendo.textContent,'Apply Nintendo layout');
assert.equal(rec(0).sources[15].value,'1'); // nothing else moved
assert.deepEqual(await opsOf(()=>rec(0).nintendo.click()),[[0x2E,0,1]]);assert.deepEqual(rec(0).sources.slice(0,4).map(sel=>+sel.value),[2,1,4,3]);
// the label follows the profile being shown, too
rec(0).tabs[0].click();assert.equal(rec(0).nintendo.textContent,'Apply Nintendo layout');rec(0).tabs[1].click();assert.equal(rec(0).nintendo.textContent,'Revert Nintendo layout');
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
// previous and next sit side by side: two columns of one grid, the on/off row above them
for(let et=0;et<4;et++){const g=rec(et).gesture,grid=g.prev.closest('.mapsrc');
  assert(grid&&grid===g.next.closest('.mapsrc'),'type '+et);
  assert.deepEqual([...grid.children].map(c=>c.className+'|'+c.querySelector('label').textContent),['mapsrc-group|Previous profile','mapsrc-group|Next profile']);
  assert(g.onoff.closest('.row').compareDocumentPosition(grid)&w.Node.DOCUMENT_POSITION_FOLLOWING);}
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

// Lizard profiles: a strip above the bindings editor; the bindings go through the lizard ops
const {lzV2Load,lzV2Add,lzV2Save,lzV2Reset}=await mod('lizard.js');
const idle=async()=>{await settle();for(let i=0;i<100&&(S.lizardBusy||S.fieldBusy);i++)await settle();};
const lzBox=document.querySelector('#lizardCard .prof-lz'),lzTabs=[...lzBox.querySelectorAll('.slot-tab')];
const lzBtn=t=>[...lzBox.querySelectorAll('button')].find(b=>b.textContent===t);
const lzDots=()=>lzTabs.map(b=>b.querySelector('.active-dot').style.display!=='none');
const trigs=()=>S.lizardBindings.map(b=>b.trig);
assert(shown(lzBox));assert.deepEqual(lzDots(),[true,false,false]);assert(lzTabs[0].classList.contains('active'));
await lzV2Load();assert.deepEqual(trigs(),[1,2]);
assert(/Editing profile 1, the one Lizard mode uses/.test(lzBox.textContent));
// another profile: the puck's editor is pointed at it, then its bindings are read
{const n=ops.length;lzTabs[1].click();await idle();assert.deepEqual(ops.slice(n),[[0x34,1]]);}
assert.deepEqual(trigs(),[32]);assert(/Editing profile 2\. Lizard mode uses profile 1\./.test(lzBox.textContent));
// unsaved edits are not dropped without asking
lzV2Add();globalThis.confirm=()=>false;
{const n=ops.length;lzTabs[2].click();await idle();assert.equal(ops.length,n);assert(lzTabs[1].classList.contains('active'));}
globalThis.confirm=m=>{confirms.push(m);return true;};
lzTabs[2].click();await idle();assert.deepEqual(trigs(),[64,128,256]);assert.equal(lzEdit,2);
// saving writes the profile on screen, not the one in use, with masks above 32 bits intact
S.lizardBindings[0].trig=2**33;await lzV2Save();
assert.equal(lzMaps[2][0].trig,2**33);assert.equal(lzMaps[0][0].trig,1);
// put it in use; copy another over it; reset it
assert(!lzBtn('Use this profile').disabled);
{const n=ops.length;lzBtn('Use this profile').click();await idle();assert.deepEqual(ops.slice(n),[[0x30,4,2]]);}
assert.equal(lzActive,2);assert.deepEqual(lzDots(),[false,false,true]);assert(lzBtn('Use this profile').disabled);
assert.deepEqual([...lzBox.querySelector('select').options].map(o=>+o.value),[0,1]);
lzBox.querySelector('select').value='0';confirms=[];
{const n=ops.length;lzBtn('Copy over this profile').click();await idle();assert.deepEqual(ops.slice(n),[[0x32,4,0,2]]);}
assert.equal(confirms.length,1);assert.deepEqual(trigs(),[1,2]);assert.deepEqual(lzMaps[2],lzMaps[0]);
lzMaps[2]=[lzB(9)];confirms=[];await lzV2Reset();
assert(/Lizard profile 3/.test(confirms[0]),confirms[0]);assert.deepEqual(lzMaps[2],LZ_DEF);
// a switch made on the controller (0xAE frame byte 47) moves the dot; the editor stays on its profile
lzActive=0;await apply();assert(S.profileLoadDue.has(4));
assert.deepEqual((await opsOf(profilesDrain)).map(a=>a.slice(0,2)),[[0x2C,4],[0x34,2]]);
assert.deepEqual(lzDots(),[true,false,false]);assert(lzTabs[2].classList.contains('active'));
// older firmware: no strip
p[0]=29;await apply();assert(!shown(lzBox));p[0]=30;await apply();assert(shown(lzBox));

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
// the export reads every Lizard profile, then points the puck's editor back at the one on screen
{let text=null;const B=globalThis.Blob,U=globalThis.URL.createObjectURL;
 globalThis.Blob=class{constructor(parts){text=parts[0];}};globalThis.URL.createObjectURL=()=>'blob:test';
 w.HTMLAnchorElement.prototype.click=()=>{};
 const {exportBackup}=await mod('backup.js');
 lzMaps=[[lzB(0)],[lzB(34)],[lzB(2),lzB(3)]];lzActive=1;
 try{await exportBackup();}finally{globalThis.Blob=B;globalThis.URL.createObjectURL=U;}
 assert(text,'nothing exported: '+document.querySelector('#log').textContent.slice(-300));
 const ex=JSON.parse(text);
 assert.equal(ex.version,3);assert.equal(ex.config.lizardProfiles.active,1);
 assert.deepEqual(ex.config.lizardProfiles.maps.map(m=>m.map(b=>b.trig)),[[1],[2**34],[4,8]]);
 // for a panel without profiles, lizardMap is the profile in use, with 32-bit masks as before
 assert.equal(ex.config.lizardMap.length,1);
 assert.equal(lzEdit,2);
 // restoring writes each profile through the lizard ops, then puts the right one in use
 const saved=clone(lzMaps.flat());lzMaps=[clone(LZ_DEF),clone(LZ_DEF),clone(LZ_DEF)];lzActive=0;
 const n=ops.length;await importBackup({text:async()=>text});
 assert.deepEqual(lzMaps.map(m=>m.map(b=>b.trig)),[[1],[2**34],[4,8]]);assert.equal(lzActive,1);
 assert.deepEqual(ops.slice(n).filter(x=>x[0]===0x34||x[1]===4).map(x=>x.slice(0,3)),[[0x34,0],[0x34,1],[0x34,2],[0x30,4,1]]);
 assert(saved.length===4);
 // a malformed Lizard profile is refused before anything is written
 const bad=JSON.parse(text);bad.config.lizardProfiles.maps[1][0].od=[0,300];
 const nw=writes.length;await importBackup({text:async()=>JSON.stringify(bad)});assert.equal(writes.length,nw);}
// a backup without profiles (older panel) still writes the per-type mapping fields
{const old=JSON.parse(JSON.stringify(b));delete old.config.profiles;delete old.config.profileGesture;old.version=1;
 const n=writes.length;await importBackup({text:async()=>JSON.stringify(old)});
 const sent=writes.slice(n);assert(!sent.some(x=>x[0]>=0x2D&&x[0]<=0x33));assert(sent.some(x=>x[0]===2&&x[1]===40));}
// a Disabled pad is not a Switch Pro D-pad mode: without the 0xAE frame a backup with D-pad pads is refused, one with Disabled pads is not
{const keep=S.lastSw;
 for(const [v,imported] of [[3,false],[5,true]]){
   S.lastSw=null;const old=JSON.parse(JSON.stringify(b));delete old.config.profiles;delete old.config.profileGesture;old.version=1;
   for(const k of ["swDpadHaptics","hdPadScale","swQamSelect","shortcutFlags"])delete old.config[k]; // those need the frame on their own
   old.config.types=old.config.types.map(t=>({...t,padStick:[v,0]}));
   const n=writes.length;await importBackup({text:async()=>JSON.stringify(old)});
   assert.equal(writes.length>n,imported,'pad value '+v+': '+document.querySelector('#log').textContent.slice(0,300));}
 S.lastSw=keep;}
// a malformed profile list is refused before anything is written
{const bad=JSON.parse(JSON.stringify(b));bad.config.profiles[0].maps[0][3]=300;
 const n=writes.length;await importBackup({text:async()=>JSON.stringify(bad)});assert.equal(writes.length,n);}

// Per-type haptic settings, a grid from v30: JS p[214 + 4 * setting + et] and field 120 + 4 * setting + et (setting
// 0 limiter, 1 style). The release before it (v29) has one limiter, field 115, and the style on the DualSense only, field 88.
{const fieldsOf=async fn=>{const n=writes.length;await fn();await settle();return writes.slice(n).filter(x=>x[0]===2).map(x=>x.slice(1));};
 const hidden=el=>el.closest('.row').parentElement.classList.contains('hide');
 p[0]=29;p[207]=80;p[203]=2;await apply();
 assert.equal(typeEls[1].limiter.value,'80');assert.equal(typeEls[3].limiter.value,'80');assert(hidden(typeEls[1].hdStyle));assert.equal(typeEls[3].audioStyle.value,'2');
 assert.deepEqual(await fieldsOf(()=>change(typeEls[1].limiter,'90')),[[115,90]]);
 assert.deepEqual(await fieldsOf(()=>change(typeEls[3].audioStyle,'1')),[[88,1]]);
 p[0]=30;[60,70,80,90].forEach((v,i)=>p[214+i]=v);[0,1,2,3].forEach((v,i)=>p[218+i]=v);
 [26,1,30,12].forEach((v,i)=>p[222+i]=v);[0,3,0,4].forEach((v,i)=>p[226+i]=v);[11,0,31,20].forEach((v,i)=>p[230+i]=v);[1,2,0,1].forEach((v,i)=>p[73+i*9+6]=v); // click, tick spacing, tick strength, Trackpad haptics On/Clicks only/Off/On
 for(let et=0;et<4;et++)assert(typeEls[et].padHap.classList.contains('hide')); // hidden on v29
 await apply();
 assert.equal(typeEls[1].limiter.value,'70');assert.equal(typeEls[3].limiter.value,'90');
 assert(!hidden(typeEls[1].hdStyle));assert.equal(typeEls[1].hdStyle.value,'1');assert.equal(typeEls[3].audioStyle.value,'3');
 assert.deepEqual(await fieldsOf(()=>change(typeEls[1].limiter,'50')),[[121,50]]);
 assert.deepEqual(await fieldsOf(()=>change(typeEls[3].limiter,'100')),[[123,100]]);
 assert.deepEqual(await fieldsOf(()=>change(typeEls[1].hdStyle,'2')),[[125,2]]);
 assert.deepEqual(await fieldsOf(()=>change(typeEls[3].audioStyle,'0')),[[127,0]]);
 // Click strength, Tick spacing and Tick strength (slider position = firmware step, -20..-1 then +1..+12 dB): shown from v30, enabled by the Trackpad haptics choice
 for(let et=0;et<4;et++)assert(!typeEls[et].padHap.classList.contains('hide'));
 const clk=typeEls.map(t=>t.padClick),tck=typeEls.map(t=>t.padTick),tkg=typeEls.map(t=>t.padTickG);
 assert.deepEqual(clk.map(i=>i.value),['26','1','30','12']);assert.deepEqual(tck.map(i=>i.value),['0','3','0','4']);assert.deepEqual(tkg.map(i=>i.value),['11','0','31','20']);
 assert.deepEqual(typeEls.map(t=>t.padClickV.textContent),['+7 dB (default)','-19 dB','+11 dB','-8 dB']);
 assert.deepEqual(typeEls.map(t=>t.padTickV.textContent),["Controller's own",'Dense',"Controller's own",'Densest']);
 assert.deepEqual(typeEls.map(t=>t.padTickGV.textContent),['-9 dB (default)','-20 dB','+12 dB','+1 dB']);
 assert.deepEqual(clk.map(i=>i.disabled),[false,false,true,false]);assert.deepEqual(tck.map(i=>i.disabled),[false,true,true,false]);assert.deepEqual(tkg.map(i=>i.disabled),[true,true,true,false]);
 assert.deepEqual(await fieldsOf(()=>change(clk[0],'20')),[[128,20]]);
 assert.deepEqual(await fieldsOf(()=>change(tck[3],'2')),[[135,2]]);
 assert.deepEqual(await fieldsOf(()=>change(tkg[3],'5')),[[139,5]]);
 // Reset to defaults writes each type's own settings, not the shared fields
 // (both start on the wave with an 85% limiter; the Switch at 100% grip strength, the others at 200%)
 for(const [et,lim,sty,style,scale] of [[1,121,125,3,50],[3,123,127,3,100]]){
  setTab(et);const f=await fieldsOf(()=>$reset());
  assert.deepEqual([f.find(x=>x[0]===lim),f.find(x=>x[0]===sty),f.find(x=>x[0]===108+et),f.find(x=>x[0]===128+et),f.find(x=>x[0]===132+et),f.find(x=>x[0]===136+et)],[[lim,85],[sty,style],[108+et,scale],[128+et,26],[132+et,0],[136+et,11]]);assert(!f.some(x=>x[0]===115||x[0]===88));}
 const dflt=sel=>[...sel.options].filter(o=>o.textContent.includes('(default)')).map(o=>o.value);
 assert.deepEqual(dflt(typeEls[1].hdStyle),['3']);assert.deepEqual(dflt(typeEls[1].rumbleScl),['100']);assert.deepEqual(dflt(typeEls[3].rumbleScl),['200']);
 // the backup carries the whole grid and replays it by field
 await apply();
 {const b=buildBackup(p,[1].concat(Array(97).fill(0)));
  assert.deepEqual(b.config.types.map(t=>[t.limiter,t.hapticStyle,t.padClick,t.padTick,t.padTickGain]),[[60,0,26,0,11],[70,1,1,3,0],[80,2,30,0,31],[90,3,12,4,20]]);
  const f=await fieldsOf(()=>importBackup({text:async()=>JSON.stringify(b)}));
  for(const [field,v] of [[120,60],[121,70],[125,1],[127,3],[128,26],[129,1],[130,30],[131,12],[133,3],[135,4],[136,11],[139,20]])assert(f.some(x=>x[0]===field&&x[1]===v),'field '+field);
  b.config.types[1].padClick=32;const n=writes.length;await importBackup({text:async()=>JSON.stringify(b)});assert.equal(writes.length,n);}
 p.length=230;await apply();}
console.log('Mapping profile panel: visibility, loading, labels, edits, copy/reset, trackpads, gesture, reset to defaults and backup tests passed');cleanup();
})().catch(e=>{cleanup();console.error(e);process.exitCode=1;});
