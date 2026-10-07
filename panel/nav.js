import { S } from './state.js';
import { $, fwupEnabled } from './util.js';
import { LIZARD_TAB, TYPE_DEFS, currentType, setTab } from './types.js';
import { loadReleases } from './firmware.js';

// ---- sidebar navigation: one page (<section class="page">) shown at a time ----
// A sidebar entry hides when its page has no visible card (RF on firmware without it, Debug without ?debug=true,
// every puck page on a ReversePuck dongle), so syncNav() runs after anything that changes card visibility.
// The page is mirrored in the URL hash (#status, #map-switch, #map-lizard, ...) so a reload, such as the beta
// toggle, stays put.
let curPage=null;

const pageVisible=id=>[...document.querySelectorAll("#"+id+" .card")].some(c=>getComputedStyle(c).display!=="none");
// indexed like setTab (LIZARD_TAB last); a function, since TYPE_DEFS is not initialized while modules load
const mapKeys=()=>[...TYPE_DEFS.map(d=>d.key.toLowerCase()),"lizard"];
const hashFor=(id,et)=>id.slice(2).toLowerCase()+(id==="pgMap"?"-"+mapKeys()[et]:"");

function markNav(){
  for(const el of document.querySelectorAll("#nav .nav-item")) el.classList.toggle("active",el.dataset.page===curPage);
}

export function showPage(id,et){
  // a type picked here (click or URL hash) wins over the first status blob's pick of the mode's type
  if(id==="pgMap" && et!==undefined){ setTab(et); S.tabInited=true; }
  curPage=id;
  for(const sec of document.querySelectorAll("#pages > .page")) sec.classList.toggle("hide",sec.id!==id);
  markNav();
  history.replaceState(null,"","#"+hashFor(id,currentType()));
  if(id==="pgUpdate" && fwupEnabled()) loadReleases(false); // lazy: first visit fetches the list
}

// keep the hash in step when the profile changes without a click (the first status blob opens the mode's profile)
export function syncMapNav(){ if(curPage==="pgMap") showPage("pgMap"); }

export function syncNav(){
  for(const el of document.querySelectorAll("#nav [data-page]")) el.classList.toggle("hide",!pageVisible(el.dataset.page));
  if(curPage && pageVisible(curPage)) return;
  // first load (or the shown page just emptied): the hash's page, else the first visible one
  const h=location.hash.slice(1), want=[...document.querySelectorAll("#pages > .page")].find(s=>h===s.id.slice(2).toLowerCase()||h.startsWith(s.id.slice(2).toLowerCase()+"-"));
  if(want && pageVisible(want.id)){
    const et=want.id==="pgMap"?mapKeys().indexOf(h.slice(4)):-1;
    // the lizard tab only exists on firmware with a lizard map (v16+)
    showPage(want.id, et>=0 && !(et===LIZARD_TAB && $("#mapTabLizard").classList.contains("hide"))?et:undefined);
    return;
  }
  const first=[...document.querySelectorAll("#nav .nav-item")].find(el=>!el.classList.contains("hide"));
  if(first) first.click();
}

export function initNav(){
  for(const el of document.querySelectorAll("#nav .nav-item")) el.onclick=()=>openNav(el);
}

// also used by the Button mapping profile tabs (data-page="pgMap" data-type=N), built in buildTypeCfgs
export function openNav(el){
  showPage(el.dataset.page, el.dataset.type!==undefined ? +el.dataset.type : undefined);
}
