const fs=require('fs'),path=require('path'),assert=require('assert'),{pathToFileURL}=require('url');
const {JSDOM}=require('jsdom');
const js=path.join(__dirname,'../../panel');
const html=fs.readFileSync(path.join(__dirname,'../../docs/index.html'),'utf8');
let cleanup=()=>{};
(async()=>{
// load the page with its scripts off, expose the browser globals the panel modules use, import them
const dom=new JSDOM(html,{url:'http://localhost/'}),w=dom.window;
const timers=[],setIntervalNode=setInterval;globalThis.setInterval=(...a)=>{const t=setIntervalNode(...a);timers.push(t);return t;};
cleanup=()=>{timers.forEach(clearInterval);w.close();};
for(const k of ['window','document','navigator','location','localStorage','history','getComputedStyle','prompt'])
  Object.defineProperty(globalThis,k,{value:k==='window'?w:(typeof w[k]==='function'?w[k].bind(w):w[k]),configurable:true,writable:true});
globalThis.confirm=()=>true;globalThis.fetch=async()=>({ok:false,json:async()=>[]});
const mod=f=>import(pathToFileURL(path.join(js,f)).href);
await mod('app.js');
const {S}=await mod('state.js'),{applyBlob}=await mod('status.js');
const $=sel=>document.querySelector(sel),$$=sel=>[...document.querySelectorAll(sel)];

// a v30 status blob: slot 0 (and optionally 1) up; the reset cause is a firmware byte p[111] = browser p[109]
const blob=(bonded,rr,raw,stage)=>{
  const p=Array(230).fill(0);p[0]=30;p[60]=bonded;
  for(let s=0;s<bonded;s++){p[61+s*3]=1;p[62+s*3]=80;p[63+s*3]=50;}
  p[109]=rr;[0,1,2,3].forEach(i=>{p[110+i]=(raw>>>(8*i))&255;});p[126]=stage===undefined?0xFF:stage;
  return new Uint8Array(p);
};
const pill=()=>$('#stReset .pill');

// the build id is shown once, in the Version card
assert(!$('#stBuild'));assert($('#stVersionBuild'));
// the Status page is separate cards, with the reset cause in a card of its own
const cards=$$('#pgStatus .card').map(c=>c.querySelector('h2').textContent);
const tabs=()=>$$('#slotTabs .slot-tab').map(b=>b.textContent);
assert.deepEqual(cards,['Version','Controller','Radio','Puck health','Last reset','Stability test','Preview data (debug)']);
assert($('#stVersionBuild').closest('.card').classList.contains('span'),'Version spans both columns');
assert($('#stReset').closest('.card').querySelector('h2').textContent==='Last reset');
// the stability test is a debug card of its own, stacked under Last reset
assert($('#stabBtn').closest('.card').querySelector('h2').textContent==='Stability test'&&$('#stabBtn').closest('.card').classList.contains('debugonly'));
assert($('#stabBtn').closest('.card').classList.contains('span')&&$('#stabBtn').closest('.card').previousElementSibling===$('#stReset').closest('.stack'));
// all five sit in the one grid, and Last reset is stacked right under Puck health in the same column
assert($$('#pgStatus .card').every(c=>c.closest('.mapgrid')&&c.closest('.mapgrid').parentElement.id==='pgStatus'));
const health=$('#stLoopState').closest('.card'),reset=$('#stReset').closest('.card');
assert(health.parentElement.classList.contains('stack')&&health.nextElementSibling===reset);
// the selected controller's traffic and fails are in Radio with the other link counters; Controller keeps link, battery, signal
const radio=$('#stRelay').closest('.card'),ctrl=$('#stLink').closest('.card');
assert(['#stSlotPolls','#stSlotF1','#stSlotFail','#stHeal','#stTopChannel'].every(id=>radio.contains($(id))));
assert(['#stBatt','#stRssi'].every(id=>ctrl.contains($(id)))&&!ctrl.contains($('#stSlotFail')));

// puck-wide totals repeat the Controller card with one controller, so they show only with two or more
applyBlob(blob(1,1,0));
assert($$('.multi-only').length===1&&$('.multi-only').classList.contains('off')&&['#stRate','#stNew','#stPolls','#stRfFailAll'].every(id=>$('.multi-only').contains($(id))),'hidden with one controller');
applyBlob(blob(2,1,0));
assert(!$('.multi-only').classList.contains('off'),'shown with two');
// the ring fault pill moved to the heal cell; the totals show crc and noRx only
const p2=Array.from(blob(2,1,0));p2[117]=3;p2[118]=4;p2[119]=5;p2[129]=2;applyBlob(new Uint8Array(p2));
assert.equal($('#stRfFailAll').textContent,'3 · 4');assert(/^5 · /.test($('#stHeal').textContent)&&$('#stHeal .pill.dn'));

// Last reset: normal starts are green, crashes red with the stuck stage, and an unclassified cause is named
// from the chip's flags (bit 20 is USB power waking it) rather than "unknown"
applyBlob(blob(1,1,0));assert(pill().classList.contains('up')&&pill().textContent==='power-on');
assert.equal($('#resetBits').textContent,'none (power-on)  (RESETREAS 0x00000000)');
applyBlob(blob(1,6,4));assert(pill().classList.contains('up')&&/restart/.test($('#resetWhat').textContent));
applyBlob(blob(1,3,2,4));assert(pill().classList.contains('dn')&&pill().textContent==='watchdog (hang) @ rflink');
assert(/Stuck in: rflink/.test($('#resetWhat').textContent)&&/watchdog/.test($('#resetBits').textContent));
applyBlob(blob(1,5,4));assert(pill().classList.contains('dn')&&pill().textContent==='HARDFAULT');
applyBlob(blob(1,0,0x100000));assert.equal(pill().textContent,'wake (USB power)');assert(pill().classList.contains('up'));
assert(/USB power/.test($('#resetWhat').textContent)&&!/unknown/i.test($('#stReset').textContent));
applyBlob(blob(1,0,0x40000));assert.equal(pill().textContent,'debugger');assert(!pill().classList.contains('up')&&!pill().classList.contains('dn'));
applyBlob(blob(1,0,0));assert.equal(pill().textContent,'unknown');assert.equal($('#resetBits').textContent,'none (power-on)  (RESETREAS 0x00000000)');
applyBlob(blob(1,0,0x80000000));assert.equal($('#resetBits').textContent,'unrecognised  (RESETREAS 0x80000000)');
// the PC / LR line shows only when the hang left them
assert($('#resetHist').parentElement.classList.contains('hide'));
const hang=Array.from(blob(1,3,2,4));[0x12,0x34,0x00,0x08].forEach((b,i)=>{hang[131+i]=b;});[0x56,0x78,0x00,0x08].forEach((b,i)=>{hang[135+i]=b;});
applyBlob(new Uint8Array(hang));assert(!$('#resetHist').parentElement.classList.contains('hide')&&/PC=0x08003412 LR=0x08007856/.test($('#resetHist').textContent));
// debug preview: fake controllers fill the slots the puck doesn't have, and a fake reset shows in the Last reset card;
// turning them off brings the real data back (the real blob is kept as received)
{const {S:st}=await mod('state.js');
 st.fake.controllers=3;st.fake.reset='usb';applyBlob(blob(1,1,0));
 assert.deepEqual(tabs(),['Controller 1','Controller 2','Controller 3']);
 assert(!$('.multi-only').classList.contains('off'));assert.equal(pill().textContent,'wake (USB power)');
 assert.equal(st.realP[60],1);
 st.fake.controllers=2;st.fake.reset='watchdog';applyBlob(blob(1,1,0));
 assert.deepEqual(tabs(),['Controller 1','Controller 2']);assert(pill().classList.contains('dn')&&/rflink/.test(pill().textContent));
 st.fake.controllers=0;st.fake.reset='';applyBlob(st.realP);
 assert.equal($('#slotTabs').style.display,'none');assert($('.multi-only').classList.contains('off'));assert.equal(pill().textContent,'power-on');}
console.log('Status page cards, multi-controller totals and Last reset card tests passed');cleanup();
})().catch(e=>{cleanup();console.error(e);process.exitCode=1;});
