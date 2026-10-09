const fs=require('fs'),path=require('path'),assert=require('assert'),{pathToFileURL}=require('url');
const {JSDOM}=require('jsdom');
const js=path.join(__dirname,'../../panel');
const html=fs.readFileSync(path.join(__dirname,'../../docs/index.html'),'utf8');
let cleanup=()=>{};
(async()=>{
const dom=new JSDOM(html,{url:'http://localhost/'}),w=dom.window;
const timers=[],setIntervalNode=setInterval;globalThis.setInterval=(...a)=>{const t=setIntervalNode(...a);timers.push(t);return t;};
cleanup=()=>{timers.forEach(clearInterval);w.close();};
for(const k of ['window','document','navigator','location','localStorage','history','getComputedStyle','prompt'])
  Object.defineProperty(globalThis,k,{value:k==='window'?w:(typeof w[k]==='function'?w[k].bind(w):w[k]),configurable:true,writable:true});
globalThis.confirm=()=>true;globalThis.fetch=async()=>({ok:false,json:async()=>[]});
const mod=f=>import(pathToFileURL(path.join(js,f)).href);
await mod('app.js');
const {S}=await mod('state.js'),{refreshRfStatus}=await mod('rf.js');
const $=sel=>document.querySelector(sel);

// Fake puck answering RF requests with 0xAD frames: v2 pages 13 rows of the 39 even channels 4..80.
const COUNT=39,PAGE=13,DEFAULT=[18,20,22,34,42,46,52,56,68,70,72,74,76,80];
const bitsOf=chs=>{const b=Array(COUNT).fill(false);chs.forEach(c=>b[(c-4)/2]=true);return b;};
const bytesOf=bits=>{const m=[0,0,0,0,0];bits.forEach((on,i)=>{if(on)m[i>>3]|=1<<(i&7);});return m;};
const defaultBits=bitsOf(DEFAULT);
let mask=defaultBits.slice(),version=2,builder=[0,0,0,0,0,0,0];
function v2Frame(page){
  const rowStart=page*PAGE<COUNT?page*PAGE:0,rowCount=Math.min(PAGE,COUNT-rowStart);
  const f=[2,0,18,0,18,COUNT,0,0,0,0,0,0,0,rowStart,rowCount];
  for(let i=0;i<rowCount;i++){const idx=rowStart+i;f.push(4+2*idx,60+(idx%20),0,0,0,0,0,0,0);}
  const trailers=Array(29).fill(0);builder.forEach((v,i)=>trailers[4+i]=v);
  return f.concat(trailers,bytesOf(mask),bytesOf(defaultBits));
}
function v1Frame(){
  const f=[1,0,18,0,18,DEFAULT.length,0,0,0,0,0,0,0];
  for(const ch of DEFAULT)f.push(ch,60,0,0,0,0,0,0,0);
  return f.concat(Array(29).fill(0));
}
const writes=[];let reply=null;
const frame=(m,a)=>({status:'ok',data:new DataView(new Uint8Array([m,a.length,...a]).buffer)});
S.dev={serialNumber:'test',
  transferOut:async(ep,b)=>{
    const a=Array.from(b);writes.push(a);
    if(a[0]===0x2B){
      const bits=Array.from({length:COUNT},(_,i)=>!!((a[1+(i>>3)]>>(i&7))&1));
      if(bits.some(Boolean))mask=bits;
      reply=v2Frame(0);
    }else if(a[0]===2&&a[1]>=97&&a[1]<=101)reply=version===2?v2Frame(a[1]===97&&a[2]?a[2]-1:0):v1Frame();
    return {status:'ok'};
  },
  transferIn:async()=>frame(0xAD,reply||[])};
S.rfCapable=true;
const settle=()=>new Promise(r=>setTimeout(r,30));
const rows=()=>[...$('#rfJournalBody').querySelectorAll('tr')];
const row=ch=>rows().find(r=>r.dataset.rfCh===String(ch));
const boxes=()=>[...$('#rfJournalBody').querySelectorAll('input[data-rf-enable]')];
const sentMasks=n=>writes.slice(n).filter(x=>x[0]===0x2B);

// A full refresh walks every page, so all 39 channels list; the default set is the old 14-channel pool.
let n=writes.length;await refreshRfStatus();
assert.deepEqual(writes.slice(n),[[2,97,1],[2,97,2],[2,97,3]]);
assert.equal(rows().length,COUNT);assert.equal(row(4).cells[1].textContent,'4');assert(row(80));
assert(!$('#rfChannelSetRow').classList.contains('hide'));assert(!$('#rfEnabledHead').classList.contains('hide'));
assert.equal($('#rfChannelSet').value,'default');
assert.equal(boxes().filter(b=>b.checked).length,DEFAULT.length);assert(boxes().every(b=>b.disabled));
// Hop and Startup only for enabled channels
assert(row(4).querySelector('button[data-rf-hop]').disabled);assert(!row(20).querySelector('button[data-rf-hop]').disabled);
assert(row(4).querySelector('button[data-rf-startup]').disabled);assert(!row(20).querySelector('button[data-rf-startup]').disabled);
assert(/14 of 39 channels enabled/.test($('#rfChannelSetNote').textContent));

// All even channels: one op 0x2B with bits 0..38 set.
const sel=$('#rfChannelSet');
n=writes.length;sel.value='all';sel.dispatchEvent(new w.Event('change'));await settle();
assert.deepEqual(sentMasks(n),[[0x2B,0xFF,0xFF,0xFF,0xFF,0x7F]]);
await refreshRfStatus();assert.equal(sel.value,'all');assert(!row(4).querySelector('button[data-rf-hop]').disabled);

// Custom unlocks the checkboxes; each toggle writes the whole mask.
sel.value='custom';sel.dispatchEvent(new w.Event('change'));await settle();
assert(boxes().every(b=>!b.disabled));
n=writes.length;const cb4=boxes()[0];cb4.checked=false;cb4.dispatchEvent(new w.Event('change'));await settle();
assert.deepEqual(sentMasks(n),[[0x2B,0xFE,0xFF,0xFF,0xFF,0x7F]]);
await refreshRfStatus();assert.equal(sel.value,'custom');assert(row(4).querySelector('button[data-rf-hop]').disabled);

// The last enabled channel cannot be switched off.
mask=bitsOf([18]);await refreshRfStatus();
n=writes.length;const last=boxes()[(18-4)/2];assert(last.checked);last.checked=false;last.dispatchEvent(new w.Event('change'));await settle();
assert.equal(sentMasks(n).length,0);assert(last.checked);

// Default restores the firmware's default set.
n=writes.length;sel.value='default';sel.dispatchEvent(new w.Event('change'));await settle();
assert.deepEqual(sentMasks(n),[[0x2B,...bytesOf(defaultBits)]]);await refreshRfStatus();assert.equal(sel.value,'default');

// Builder progress counts enabled channels only: Ch 22 is the 3rd of 14.
builder=[3,(22-4)/2,22,10,1,0,0];await refreshRfStatus();
assert(/^Testing 3\/14 · Ch 22/.test($('#rfBuilderStatus').textContent),$('#rfBuilderStatus').textContent);
assert($('#rfChannelSet').disabled);builder=[0,0,0,0,0,0,0];

// Older firmware (v1 frame): the fixed 14-row pool and no channel-set controls.
version=1;n=writes.length;await refreshRfStatus();
assert.deepEqual(writes.slice(n),[[2,97,1]]);
assert.equal(rows().length,DEFAULT.length);assert($('#rfChannelSetRow').classList.contains('hide'));assert($('#rfEnabledHead').classList.contains('hide'));
assert(!row(20).querySelector('button[data-rf-hop]').disabled);
console.log('RF channel set panel: paging, presets, custom toggles, builder progress and v1 fallback tests passed');cleanup();
})().catch(e=>{cleanup();console.error(e);process.exitCode=1;});
