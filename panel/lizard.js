import { S } from './state.js';
import { log } from './util.js';
import { readIn, send, waitIdle } from './protocol.js';

// ===================== Lizard (desktop) binding map =====================
// Mirrors firmware lizard_map.h. A binding is {outType, od:[7], trig, hold}. Output types and the
// per-type payload (od[]) layout must match the constants in lizard_map.h exactly.
export const LZ_MAX = 32;
const LZO = {NONE:0, KBD:1, MBTN:2, AXIS:3, SCROLL:4, CONSUMER:5};
const LZ_OUT_LABELS = {0:"(disabled)", 1:"Keyboard key", 2:"Mouse button", 3:"Mouse move", 4:"Scroll wheel", 5:"Media key"};
// Controller input bits (triton.h TB_* + virtual left-stick deflection bits). Single-bit triggers only.
const LZ_BTNS = [
  [0x1,"A"],[0x2,"B"],[0x4,"X"],[0x8,"Y"],
  [0x10,"QAM (• • •)"],[0x40,"View"],[0x4000,"Menu"],[0x10000,"Steam"],
  [0x20,"R3 (stick click)"],[0x8000,"L3 (stick click)"],
  [0x80,"R4 (back upper-right)"],[0x100,"R5 (back lower-right)"],
  [0x20000,"L4 (back upper-left)"],[0x40000,"L5 (back lower-left)"],
  [0x200,"RB (bumper)"],[0x80000,"LB (bumper)"],
  [0x800000,"R2 (trigger pull)"],[0x8000000,"L2 (trigger pull)"],
  [0x2000,"D-pad Up"],[0x400,"D-pad Down"],[0x1000,"D-pad Left"],[0x800,"D-pad Right"],
  [0x400000,"Right pad click"],[0x4000000,"Left pad click"],
  [0x200000,"Right pad touch"],[0x2000000,"Left pad touch"],
  [Math.pow(2,32),"L-stick → right"],[Math.pow(2,33),"L-stick → left"],[Math.pow(2,34),"L-stick → down"],[Math.pow(2,35),"L-stick → up"],
[Math.pow(2,36),"R-stick → right"],[Math.pow(2,37),"R-stick → left"],[Math.pow(2,38),"R-stick → down"],[Math.pow(2,39),"R-stick → up"],
];
// Keyboard modifier bits (od[0] for KBD output).
const LZ_MODS = [[0x01,"Ctrl"],[0x02,"Shift"],[0x04,"Alt"],[0x08,"Win/⌘"]];
// Curated HID keycodes (od[1] for KBD output). Value 0 = no key (modifier-only).
const LZ_KEYS = [[0,"— none —"]];
"ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach((c,i)=>LZ_KEYS.push([0x04+i,c]));
"1234567890".split("").forEach((c,i)=>LZ_KEYS.push([0x1e+i,c]));
[[0x28,"Enter"],[0x29,"Esc"],[0x2a,"Backspace"],[0x2b,"Tab"],[0x2c,"Space"],
 [0x4f,"Arrow Right"],[0x50,"Arrow Left"],[0x51,"Arrow Down"],[0x52,"Arrow Up"],
 [0x4a,"Home"],[0x4d,"End"],[0x4b,"Page Up"],[0x4e,"Page Down"],[0x49,"Insert"],[0x4c,"Delete"],
 [0x2d,"- _"],[0x2e,"= +"],[0x46,"Print Screen"]].forEach(k=>LZ_KEYS.push(k));
for(let i=0;i<12;i++) LZ_KEYS.push([0x3a+i,"F"+(i+1)]);
const LZ_MBTNS = [[1,"Left click"],[2,"Right click"],[4,"Middle click"]];
const LZ_AXIS_SRC = [[0,"Right trackpad"],[1,"Left stick"],[2,"Gyro"]];
const LZ_GYRO_ACT = [[0,"Always"],[1,"While right pad touched"],[2,"While left stick deflected"],[3,"While hold-button held"]];
const LZ_CONSUMER = [[1,"Volume +"],[2,"Volume −"]];

function lzBtnLabel(mask){ const v=Number(mask)||0; const m=LZ_BTNS.find(b=>Number(b[0])===v); return m?m[1]:(v?("0x"+v.toString(16)):""); }
// Read one [0xAA][count][count*16] frame, accumulating transferIn packets until complete.
// Gives up after 3 s (null): an unanswered 0x11 must never block the IN pipe for good.
export async function readLizard(){
  let acc=new Uint8Array(0);
  const deadline=Date.now()+3000;
  for(let guard=0; guard<64; guard++){
    const d=await readIn(256, deadline-Date.now());
    if(!d) break;
    const m=new Uint8Array(acc.length+d.length); m.set(acc); m.set(d,acc.length); acc=m;
    let i=0; while(i<acc.length && acc[i]!==0xAA) i++;
    if(i>0) acc=acc.slice(i);
    if(acc.length<2) continue;
    const count=acc[1], total=2+count*16;
    if(acc.length>=total){
      const out=[];
      for(let b=0;b<count;b++){
        const q=2+b*16;
        out.push({
          outType:acc[q],
          od:[...acc.slice(q+1,q+8)],
          trig:((acc[q+8])|(acc[q+9]<<8)|(acc[q+10]<<16)|(acc[q+11]<<24))>>>0,
          hold:((acc[q+12])|(acc[q+13]<<8)|(acc[q+14]<<16)|(acc[q+15]<<24))>>>0,
        });
      }
      return out;
    }
  }
  return null;
}
// Every lizard op sends 0x11..0x15 and then does a BLOCKING readLizard(). If the firmware doesn't implement
// the op (any pre-v16 build) it drops the byte and never replies, and the read hangs the shared endpoint. So
// every entry point bails unless a status blob has proven the puck speaks v16+.
export function lizardCapable(){ return !!(S.lastP && S.lastP[0]>=16); }

// OPENPUCK_LIZARD_MAP_V2_R_STICK
// Binding-v2 format appeared at protocol 20. Protocol 21 (upstream #224)
// claimed 0x16 for rumble-test, so the v2 map transport shifts one slot.
const LZ_MAP_V2_PROTOCOL = 20;
const LZ_MAP_V2_SHIFTED_OPS_PROTOCOL = 21;
const LZ_V1_LOW_MASK = 0x0fffffff;
const lzPow2 = bit => Math.pow(2, bit);

function lzReadLE(d,o,n){
	let v=0;
	for(let i=n-1;i>=0;i--) v=v*256+d[o+i];
	return v;
}
function lzWriteLE(out,v,n){
	v=Number(v)||0;
	for(let i=0;i<n;i++) out.push(Math.floor(v/Math.pow(2,8*i))&0xff);
}
function lzLegacyMaskToV2(v){
	v=Number(v)>>>0;
	let out=v&LZ_V1_LOW_MASK;
	if(v&0x10000000) out+=lzPow2(32);
	if(v&0x20000000) out+=lzPow2(33);
	if(v&0x40000000) out+=lzPow2(34);
	if(v&0x80000000) out+=lzPow2(35);
	return out;
}
function lzV2MaskToLegacy(v){
	v=Number(v)||0;
	let out=(v%lzPow2(28))>>>0;
	if(Math.floor(v/lzPow2(32))&1) out|=0x10000000;
	if(Math.floor(v/lzPow2(33))&1) out|=0x20000000;
	if(Math.floor(v/lzPow2(34))&1) out|=0x40000000;
	if(Math.floor(v/lzPow2(35))&1) out|=0x80000000;
	return out>>>0;
}
function lzPanelV2(){ return !!(S.lastP&&S.lastP[0]>=LZ_MAP_V2_PROTOCOL); }
function lzV2Ops(){
	const shifted=!!(S.lastP&&S.lastP[0]>=LZ_MAP_V2_SHIFTED_OPS_PROTOCOL);
	return shifted
		? {dump:0x17,set:0x18,save:0x19,reset:0x1A}
		: {dump:0x16,set:0x17,save:0x18,reset:0x19};
}
function lzHasRStickVirtual(v){ return Number(v||0)>=lzPow2(36); }

function lzV2Select(options,value,onchange,noneLabel){
	const s=document.createElement("select");
	if(noneLabel!==undefined){
		const o=document.createElement("option"); o.value="0"; o.textContent=noneLabel; s.appendChild(o);
	}
	for(const [v,label] of options){
		const o=document.createElement("option"); o.value=String(v); o.textContent=label; s.appendChild(o);
	}
	s.value=String(Number(value)||0);
	s.onchange=()=>onchange(Number(s.value));
	return s;
}
// ---- lizard editor: one block per binding, a readable summary line on top, labelled fields below ----
let lzDirty=false;
function lzSetDirty(on){ lzDirty=on; const d=document.getElementById("lzDirty"); if(d) d.classList.toggle("hide",!on); }
const lzName=(list,v)=>{ const m=list.find(x=>Number(x[0])===Number(v)); return m?m[1]:""; };
function lzSummary(b){
	const od=b.od, src=lzName(LZ_AXIS_SRC,od[0]);
	if(b.outType===LZO.AXIS) return src+" → mouse pointer"+(od[0]===2?", "+lzName(LZ_GYRO_ACT,od[1]).toLowerCase()+(od[1]===3&&b.hold?" ("+lzBtnLabel(b.hold)+")":""):"");
	if(b.outType===LZO.SCROLL) return "Left trackpad → scroll wheel";
	let out;
	if(b.outType===LZO.KBD) out=[...LZ_MODS.filter(([bit])=>od[0]&bit).map(m=>m[1]),...od.slice(1).filter(Boolean).map(k=>lzName(LZ_KEYS,k)||"key 0x"+k.toString(16))].join(" + ")||"(no key)";
	else if(b.outType===LZO.MBTN) out=lzName(LZ_MBTNS,od[0])||"mouse button";
	else if(b.outType===LZO.CONSUMER) out=lzName(LZ_CONSUMER,od[0])||"media key";
	else return "Disabled";
	const input=[b.trig?lzBtnLabel(b.trig):"",b.hold?"holding "+lzBtnLabel(b.hold):""].filter(Boolean).join(" while ");
	return (input||"no input chosen")+" → "+out;
}
function lzField(label,el){
	const f=document.createElement("div"); f.className="lz-f";
	const s=document.createElement("span"); s.textContent=label; f.append(s,el); return f;
}
export function lzV2Render(){
	const host=document.getElementById("lizardList");
	if(!host) return;
	host.innerHTML="";
	const n=S.lizardBindings.length;
	const cnt=document.getElementById("lzCount"); if(cnt) cnt.textContent=n+" / "+LZ_MAX+" bindings";
	const add=document.getElementById("lzAdd"); if(add) add.disabled=n>=LZ_MAX;
	// every edit marks the map unsaved and redraws (summary + which fields apply)
	const edit=fn=>v=>{ fn(v); lzSetDirty(true); lzV2Render(); };
	S.lizardBindings.forEach((b,idx)=>{
		if(!b.od) b.od=[0,0,0,0,0,0,0];
		while(b.od.length<7) b.od.push(0);
		const box=document.createElement("div"); box.className="lz-row";
		const head=document.createElement("div"); head.className="lz-head";
		const num=document.createElement("span"); num.className="lz-idx"; num.textContent="#"+(idx+1);
		const sum=document.createElement("span"); sum.className="lz-sum"; sum.textContent=lzSummary(b);
		// a key/click/media binding with no input never fires as intended
		const digital=b.outType===LZO.KBD||b.outType===LZO.MBTN||b.outType===LZO.CONSUMER;
		if(digital&&!b.trig&&!b.hold){ sum.classList.add("warn"); sum.textContent="⚠ "+sum.textContent; }
		const del=document.createElement("button"); del.textContent="Remove";
		del.onclick=()=>{ S.lizardBindings.splice(idx,1); lzSetDirty(true); lzV2Render(); };
		head.append(num,sum,del); box.appendChild(head);

		const fields=document.createElement("div"); fields.className="lz-fields";
		const types=Object.keys(LZ_OUT_LABELS).map(Number).map(v=>[v,LZ_OUT_LABELS[v]]);
		fields.appendChild(lzField("Action",lzV2Select(types,b.outType,edit(v=>{b.outType=v;}))));
		// analog outputs are driven by their source; only gyro "while hold-button held" reads the hold buttons
		const analog=b.outType===LZO.AXIS||b.outType===LZO.SCROLL;
		const gyroHold=b.outType===LZO.AXIS&&b.od[0]===2&&b.od[1]===3;
		if(!analog) fields.appendChild(lzField("When pressed",lzV2Select(LZ_BTNS,b.trig,edit(v=>{b.trig=v;}),"— pick input —")));
		if(!analog||gyroHold) fields.appendChild(lzField(gyroHold?"Hold button":"While holding",lzV2Select(LZ_BTNS,b.hold,edit(v=>{b.hold=v;}),"— nothing —")));
		if(b.outType===LZO.KBD){
			const mods=document.createElement("div"); mods.className="lz-mods";
			for(const [bit,label] of LZ_MODS){
				const c=document.createElement("input"); c.type="checkbox"; c.checked=!!(b.od[0]&bit);
				c.onchange=edit(()=>{ if(c.checked)b.od[0]|=bit;else b.od[0]&=~bit; });
				const l=document.createElement("label"); l.append(c,label); mods.appendChild(l);
			}
			fields.appendChild(lzField("Modifiers",mods));
			// key 1 always; each further key slot appears once the one before it is set (up to 6)
			for(let k=1;k<7;k++){
				if(k>1&&!b.od[k-1]&&!b.od[k]) break;
				fields.appendChild(lzField(k===1?"Key":"Key "+k,lzV2Select(LZ_KEYS,b.od[k],edit(v=>{b.od[k]=v;}))));
			}
		}else if(b.outType===LZO.MBTN){
			fields.appendChild(lzField("Mouse button",lzV2Select(LZ_MBTNS,b.od[0],edit(v=>{b.od[0]=v;}))));
		}else if(b.outType===LZO.AXIS){
			fields.appendChild(lzField("Source",lzV2Select(LZ_AXIS_SRC,b.od[0],edit(v=>{b.od[0]=v;}))));
			if(b.od[0]===2) fields.appendChild(lzField("Gyro active",lzV2Select(LZ_GYRO_ACT,b.od[1],edit(v=>{b.od[1]=v;}))));
		}else if(b.outType===LZO.SCROLL){
			b.od[0]=0;
			const s=document.createElement("span"); s.style.cssText="color:var(--fg);font-size:13px;padding-top:6px"; s.textContent="Left trackpad";
			fields.appendChild(lzField("Source",s));
		}else if(b.outType===LZO.CONSUMER){
			fields.appendChild(lzField("Media key",lzV2Select(LZ_CONSUMER,b.od[0],edit(v=>{b.od[0]=v;}))));
		}
		box.appendChild(fields); host.appendChild(box);
	});
	if(!n) host.innerHTML='<p class="note">No bindings. Add one, or reset to the defaults.</p>';
}

async function lzV2ReadMap(op){
	await send([op]);
	const recSize=lzPanelV2()?24:16;
	let buf=[];
	let expected=0;
	// through the shared reader, with a deadline: a reply cut short used to leave this waiting forever with
	// lizardBusy set, which stopped the status poll (NO HEARTBEAT) until stray bytes happened to complete it
	const deadline=Date.now()+3000;
	for(;;){
		const d=await readIn(256, deadline-Date.now());
		if(!d) throw new Error("lizard-map read timed out");
		for(const x of d) buf.push(x);
		if(!expected){
			let start=-1;
			for(let i=0;i+1<buf.length;i++){
				if(buf[i]===0xAA && buf[i+1]<=LZ_MAX){ start=i; break; }
			}
			if(start<0){ if(buf.length>1024)buf=[]; continue; }
			if(start) buf=buf.slice(start);
			expected=2+buf[1]*recSize;
		}
		if(buf.length>=expected) break;
	}
	const count=buf[1], out=[];
	for(let i=0;i<count;i++){
		const q=2+i*recSize, od=[];
		for(let k=0;k<7;k++) od.push(buf[q+1+k]||0);
		const trig=recSize===24?lzReadLE(buf,q+8,8):lzLegacyMaskToV2(lzReadLE(buf,q+8,4));
		const hold=recSize===24?lzReadLE(buf,q+16,8):lzLegacyMaskToV2(lzReadLE(buf,q+12,4));
		out.push({outType:buf[q]||0,od,trig,hold});
	}
	return out;
}
export async function lzV2Load(){
	if(S.lizardBusy||!S.dev)return;
	S.lizardBusy=true;
	try{
		// runs from the first status blob, while that poll is still reading its Switch frame: wait for the pipe
		await waitIdle();
		const ops=lzV2Ops();
		S.lizardBindings=await lzV2ReadMap(lzPanelV2()?ops.dump:0x11);
		lzV2Render(); lzSetDirty(false);
		const st=document.getElementById("lzStatus");
		if(st)st.textContent="loaded "+S.lizardBindings.length+" binding(s)"+(lzPanelV2()?" · map v2":" · legacy map");
	}catch(e){ log("lizard load failed: "+e.message); }
	finally{S.lizardBusy=false;}
}
export async function lzV2Save(){
	if(S.lizardBusy||!S.dev)return;
	S.lizardBusy=true;
	try{
		const v2=lzPanelV2(), ops=lzV2Ops();
		if(!v2&&S.lizardBindings.some(b=>lzHasRStickVirtual(b.trig)||lzHasRStickVirtual(b.hold)))
			throw new Error("R-stick directions require firmware protocol v20+");
		const count=Math.min(LZ_MAX,S.lizardBindings.length);
		await send([0x13,count]);
		for(let i=0;i<count;i++){
			const b=S.lizardBindings[i], cmd=[v2?ops.set:0x12,i,b.outType||0];
			for(let k=0;k<7;k++)cmd.push((b.od&&b.od[k])||0);
			if(v2){lzWriteLE(cmd,b.trig,8);lzWriteLE(cmd,b.hold,8);}
			else{lzWriteLE(cmd,lzV2MaskToLegacy(b.trig),4);lzWriteLE(cmd,lzV2MaskToLegacy(b.hold),4);}
			await send(cmd);
		}
		S.lizardBindings=await lzV2ReadMap(v2?ops.save:0x14);
		lzV2Render(); lzSetDirty(false);
		const st=document.getElementById("lzStatus"); if(st)st.textContent="saved "+count+" binding(s)";
	}catch(e){const st=document.getElementById("lzStatus");if(st)st.textContent="save failed: "+e.message;log("lizard save failed: "+e.message);}
	finally{S.lizardBusy=false;}
}
export async function lzV2Reset(){
	if(S.lizardBusy||!S.dev)return;
	if(!confirm("Reset the lizard map to the built-in defaults? This saves to the puck immediately; your bindings are lost.")) return;
	S.lizardBusy=true;
	try{
		// runs from the first status blob, while that poll is still reading its Switch frame: wait for the pipe
		await waitIdle();
		const ops=lzV2Ops();
		S.lizardBindings=await lzV2ReadMap(lzPanelV2()?ops.reset:0x15);
		lzV2Render(); lzSetDirty(false);
		const st=document.getElementById("lzStatus");if(st)st.textContent="reset to defaults";
	}catch(e){log("lizard reset failed: "+e.message);}
	finally{S.lizardBusy=false;}
}
export function lzV2Add(){
	if(S.lizardBindings.length>=LZ_MAX) return;
	S.lizardBindings.push({outType:1,od:[0,0,0,0,0,0,0],trig:0,hold:0});
	lzSetDirty(true); lzV2Render();
}
export function lzV2Reload(){
	if(lzDirty && !confirm("Discard your unsaved lizard map changes and reload it from the puck?")) return;
	lzV2Load();
}
