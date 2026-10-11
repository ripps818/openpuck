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
for(const k of ['window','document','navigator','location','localStorage','history','getComputedStyle','prompt'])
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
// The modifier shows as a glyph named on hover: the toggle and every chord label follow the setting.
const mods=()=>[...document.querySelectorAll('.ic-mod')].map(e=>e.getAttribute('aria-label')+'|'+e.title);
assert.equal(mods().length,8);assert(mods().every(m=>m==='Quick Access|Quick Access'),mods().join());
assert($('#scQam .ic-mod'));assert.equal($('#qamSelectRow label .ic').title,'Quick Access');
for(const el of document.querySelectorAll('.chord,.chordD'))assert(!el.parentElement.classList.contains('hide'));
assert.deepEqual(await act(()=>$('#scQam').click()),[2,240,56]);s[46]=56;await apply();assert(mods().every(m=>m==='All four back buttons|All four back buttons'),mods().join());
for(const [id,bit] of [['scFeedback',8],['scCapture',16],['scEnabled',32]])assert.deepEqual(await act(()=>$('#'+id).click()),[2,240,s[46]^bit]);
// Switch Pro-only controls (and HD trackpad strength) live in the Switch tab of Button mapping.
const swTab=$('#swClickControls').parentElement;assert($('#typeCfgs').contains(swTab));
for(const id of ['#qamSelectRow','#swGyroMap','#hdPadScale'])assert(swTab.contains($(id)),id);
assert(!$('#swClickControls').classList.contains('hide'));assert.equal($('#swClickFeedback').value,'1');
const change=el=>act(()=>el.dispatchEvent(new w.Event('change')));
const click=$('#swClickFeedback');click.value='0';assert.deepEqual(await change(click),[2,230,0]);
const capture=$('#qamSelect');capture.value='0';assert.deepEqual(await change(capture),[2,239,0]);
// v25: grip strength per type in Button mapping (no style row); the global strength row hides.
const secs=[...$('#typeCfgs').children];
// the mapping profile cards (status v30+) are covered by tests/button_profiles/panel.cjs; this test reads the rest
const own=(sec,q)=>[...sec.querySelectorAll(q)].filter(e=>!e.closest('.prof-card'));
// Back-button and QAM labels are the glyph (full name on hover) plus the short name.
{const labs=own(secs[0],'.row label');
 assert.deepEqual(labs.slice(0,4).map(l=>l.textContent.trim()+'|'+l.querySelector('.ic').title),['L4|L4 (back upper-left)','R4|R4 (back upper-right)','L5|L5 (back lower-left)','R5|R5 (back lower-right)']);
 assert.equal(labs[4].querySelector('.ic').dataset.ic,'qam');assert.equal(labs[4].textContent.trim(),'QAM');
 // the trackpad mapping rows are labelled by the left / right pad glyph plus the word
 assert.deepEqual(own(secs[0],'.row label .ic[data-ic^=pad]').map(e=>e.title+'|'+e.nextSibling.textContent),['Left trackpad| Trackpad','Right trackpad| Trackpad']);
 // the A/B swap and Create toggles are labelled with their glyphs too
 const swapLab=labs.find(l=>l.querySelector('.ic[data-ic=A]')),createLab=own(secs[3],'.row label').find(l=>l.querySelector('.ic[data-ic=padClick]'));
 assert.deepEqual([...swapLab.querySelectorAll('.ic')].map(e=>e.dataset.ic),['A','B','X','Y']);assert(swapLab.textContent.endsWith(' swap'));
 assert.deepEqual([...createLab.querySelectorAll('.ic')].map(e=>e.dataset.ic),['view','padClick']);assert(/Create = .*touchpad click$/.test(createLab.textContent));}
const typeRow=(et,label)=>own(secs[et],'.row').find(r=>r.querySelector('label') && r.querySelector('label').textContent===label);
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
// Reset to defaults acts on the open profile only, through the same fields the controls write, and skips what the
// connected firmware predates (here v27: no Create = touchpad click yet).
const resetOf=async et=>{document.querySelector('#mapTabs .slot-tab[data-type="'+et+'"]').click();const n=writes.length;await $('#mapReset').onclick();return writes.slice(n).filter(x=>x[0]===2).map(x=>x.slice(1));};
const base=et=>[5,6,7,8,et===1?18:0,et===1?1:0,et===1?0:1,0,1].map((v,k)=>[40+et*9+k,v]);
assert.deepEqual(await resetOf(0),[...base(0),[80,0],[81,0],[108,100]]);
assert.deepEqual(await resetOf(1),[...base(1),[82,0],[83,0],[109,100],[115,70],[38,0],[230,1],[231,50],[239,18]]);
assert.deepEqual(await resetOf(2),[...base(2),[84,0],[85,0],[110,100]]);
assert.deepEqual(await resetOf(3),[...base(3),[86,0],[87,0],[111,100],[115,70],[31,1],[88,3],[30,0],[114,0]]);
{const p29=p.slice();p29[0]=29;p=p29;applyBlob(new Uint8Array(p29));const d=await resetOf(3);assert.deepEqual(d[d.length-1],[116,0]);p=p27;applyBlob(new Uint8Array(p27));}
// without the 0xAE frame the Switch-only controls are not shown, so they are not written either
applySw(null);assert(!(await resetOf(1)).some(x=>x[0]===230||x[0]===231||x[0]===239));await apply();
// declining the confirmation writes nothing
globalThis.confirm=()=>false;{const n=writes.length;await $('#mapReset').onclick();assert.equal(writes.length,n);}globalThis.confirm=()=>true;
p=p.slice(0,204);p[0]=23;await apply();
// Button mapping: one tab per profile plus the lizard map; header shows the mode and controllers.
assert.deepEqual([...document.querySelectorAll('#mapTabs .slot-tab')].map(e=>e.firstChild.textContent),['Xbox','Switch','DS4','DS5','Lizard (desktop)']);
assert.equal($('#hdrMode').textContent,'Steam');const chips=document.querySelectorAll('#hdrCtlrs .ctlr-chip');assert.equal(chips.length,1);assert(chips[0].classList.contains('off')); // one bonded, offline
// Original per-type mapping and mode controls remain present.
assert(document.querySelectorAll('.modebtn').length>=11);assert($('#lizardList'));
// The header names the mode and shows its console's glyph.
{const hg=()=>$('#hdrModeIc');
 assert(!hg().classList.contains('hide'));assert.deepEqual([hg().dataset.ic,hg().title],['sysSteam','Steam Controller']);
 for(const [mode,ic] of [[1,'sysXbox'],[4,'sysSwitch'],[5,'sysPlayStation'],[3,'sysLizard'],[11,'sysGamepad']]){p[1]=mode;await apply();assert.equal(hg().dataset.ic,ic,'mode '+mode);}
 p[1]=0;await apply();assert.equal(hg().dataset.ic,'sysSteam');}
// The remap lists draw a dropdown over each (hidden) select so every target's glyph shows beside its name.
{const gsel=sel=>sel.parentElement,btnOf=sel=>gsel(sel).querySelector('.gsel-btn'),listOf=sel=>gsel(sel).querySelector('.gsel-list');
 const sels=[...document.querySelectorAll('.gsel > select')].filter(e=>!e.closest('.prof-card'));
 // per profile: four back buttons, QAM and the two trackpad-to-stick pickers; plus the Switch QAM + View picker
 assert.equal(sels.length,4*7+1);
 for(const sel of sels){assert(sel.hidden);assert(listOf(sel).classList.contains('hide'));}
 // every target on every controller has a glyph (only the none / default entry has none), by the right name
 const g=et=>Object.fromEntries([...own(secs[et],'select')[0].options].map(o=>[o.textContent,o.dataset.glyph||'']));
 for(let et=0;et<4;et++)for(const [name,gl] of Object.entries(g(et)))if(!/^(— none —|Default)/.test(name))assert(gl,et+' '+name);
 assert.deepEqual(['A','LB','Back','Start','D-pad Up','Guide','LT'].map(n=>g(0)[n]),['A','LB','view','menu','up','guide','LT']);
 assert.deepEqual(['Minus','ZL','L','L-Stick','Capture / Screenshot'].map(n=>g(1)[n]),['minus','ZL','swL','L3','capture']);
 assert.deepEqual(['Cross','Touchpad Click','Options','PS','Mute','R2'].map(n=>g(3)[n]),['cross','padClick','menu','ps','mute','R2']);
 // picking from the list writes the same field the plain select did, and the button shows the choice
 const l4=own(secs[0],'select')[0],b=btnOf(l4),list=listOf(l4),txt=()=>b.querySelector('.gsel-txt').textContent;
 b.click();assert(!list.classList.contains('hide'));assert.equal(b.getAttribute('aria-expanded'),'true');
 const rows=[...list.children];assert.equal(rows.length,l4.options.length);
 assert(rows.every((r,i)=>!!r.querySelector('.gsel-ic .ic')===!!l4.options[i].dataset.glyph));
 assert.deepEqual(await act(()=>rows.find(r=>r.lastChild.textContent==='LB').click()),[2,40,5]);
 assert(list.classList.contains('hide'));assert.equal(l4.value,'5');assert.equal(txt(),'LB');assert.equal(b.querySelector('.ic').title,'LB (left bumper)');
 // the status poll redraws the button, but leaves it alone while the user is on it
 b.blur();p[73]=6;await apply();assert.equal(l4.value,'6');assert.equal(txt(),'RB');
 b.focus();p[73]=7;await apply();assert.equal(l4.value,'6');assert.equal(txt(),'RB');b.blur();
 p[73]=0;await apply();assert.equal(txt(),'— none —');assert.equal(b.querySelector('.ic'),null);
 // keyboard: arrows open and move, Enter picks, Escape closes
 const key=k=>b.dispatchEvent(new w.KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
 b.focus();key('ArrowDown');assert(!list.classList.contains('hide'));
 assert.deepEqual(await act(()=>{key('ArrowDown');key('Enter');}),[2,40,1]);assert.equal(txt(),'A');
 key('ArrowDown');assert(!list.classList.contains('hide'));key('Escape');assert(list.classList.contains('hide'));
 p[73]=0;await apply();b.blur();
 // the Lizard editor: every picker carries glyphs, and the summary line and modifiers are glyphs and words
 const {lzV2Render}=await mod('lizard.js');
 const field=name=>[...$('#lizardList').querySelectorAll('.lz-f')].find(f=>f.firstChild.textContent===name).querySelector('.gsel');
 const shown=g=>g.querySelector('.gsel-txt').textContent+'|'+g.querySelector('.gsel-btn .ic').title;
 const noGlyph=sel=>[...sel.options].filter(o=>o.value!=='0'&&!o.dataset.glyph).map(o=>o.textContent);
 S.lizardBindings=[{outType:1,od:[0x03,4,0x50,0,0,0,0],trig:0x20000,hold:0x80000}];lzV2Render();
 assert.equal(shown(field('Action')),'Keyboard key|Keyboard key');
 assert.deepEqual([shown(field('When pressed')),shown(field('While holding'))],['L4 (back upper-left)|L4 (back upper-left)','LB (bumper)|LB (left bumper)']);
 assert.deepEqual([shown(field('Key')),shown(field('Key 2'))],['A|A','Arrow Left|Arrow Left']);
 const lzSel=field('When pressed').querySelector('select');
 assert.deepEqual(noGlyph(lzSel),[]);
 assert.deepEqual([...lzSel.options].filter(o=>/^(Left|Right) pad/.test(o.textContent)).map(o=>o.textContent+'='+o.dataset.glyph),['Right pad click=padClickR','Left pad click=padClickL','Right pad touch=padR','Left pad touch=padL']);
 // every key, action, mouse button, source, gyro and media entry has a glyph, drawn as keycaps for the keys
 assert.deepEqual(noGlyph(field('Key').querySelector('select')),[]);assert.deepEqual(noGlyph(field('Action').querySelector('select')).filter(n=>n!=='(disabled)'),[]);
 assert.deepEqual([...field('Key').querySelector('select').options].slice(1,4).map(o=>o.dataset.glyph),['key:A','key:B','key:C']);
 // the summary: L4 while holding LB -> Ctrl + Shift + A + ... as glyphs with their words
 const sum=()=>$('#lizardList .lz-sum'),icons=el=>[...el.querySelectorAll('.ic')].map(e=>e.dataset.ic);
 assert.deepEqual(icons(sum()),['L4','LB','key:Ctrl','key:Shift','key:A','key:Arrow Left']);
 assert(/L4 while holding LB.* → Ctrl \+ Shift \+ A \+/.test(sum().textContent.replace(/\s+/g,' ')),sum().textContent);
 // modifiers are keycaps
 assert.deepEqual(icons($('#lizardList .lz-mods')),['key:Ctrl','key:Shift','key:Alt','key:Win/⌘']);
 // a mouse click, media key, scroll and gyro each get theirs
 S.lizardBindings=[{outType:2,od:[2,0,0,0,0,0,0],trig:0x4000000,hold:0},{outType:5,od:[1,0,0,0,0,0,0],trig:0x1,hold:0},{outType:4,od:[0,0,0,0,0,0,0],trig:0,hold:0},{outType:3,od:[2,1,0,0,0,0,0],trig:0,hold:0}];lzV2Render();
 assert.deepEqual([...$('#lizardList').querySelectorAll('.lz-sum')].map(icons),[['padClickL','mouseR'],['A','volUp'],['padL','wheel'],['gyro','pointer','padR']].map(a=>a));
 assert.deepEqual(noGlyph(field('Mouse button').querySelector('select')),[]);
 // picking an input from the list sets the binding and redraws
 S.lizardBindings=[{outType:1,od:[0,4,0,0,0,0,0],trig:0x20000,hold:0}];lzV2Render();
 field('When pressed').querySelector('.gsel-btn').click();
 [...field('When pressed').querySelector('.gsel-list').children].find(r=>r.lastChild.textContent==='Y').click();
 assert.equal(S.lizardBindings[0].trig,8);assert.equal(field('When pressed').querySelector('.gsel-txt').textContent,'Y');
 S.lizardBindings=[];lzV2Render();}
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
console.log('Configurator mode shortcuts, Switch tab, per-mode strength, profile reset and backup tests passed');cleanup();
})().catch(e=>{cleanup();console.error(e);process.exitCode=1;});
