import { iconEl } from './icons.js';

// A native <option> cannot hold a picture, so a <select> whose options carry data-glyph gets a button and a listbox
// drawn in its place. The <select> stays in the DOM, hidden, as the one source of truth: the panel reads its value and
// change event and writes its value. Setting a value from code does not redraw the button, so whatever sets one calls
// repaintGlyphSelects() afterwards (the status poll does).
let gselUid = 0;

export function glyphSelect(sel){
  // the select's own window rather than globals, so the panel's jsdom tests can load this too
  const win = sel.ownerDocument.defaultView;
  const wrap = document.createElement("span"); wrap.className = "gsel";
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "gsel-btn";
  const list = document.createElement("div"); list.className = "gsel-list hide"; list.id = "gsel" + (++gselUid);
  btn.setAttribute("role", "combobox"); btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-controls", list.id);
  list.setAttribute("role", "listbox");
  if(sel.parentNode) sel.replaceWith(wrap);
  sel.hidden = true; sel.tabIndex = -1; sel.setAttribute("aria-hidden", "true");
  wrap.append(sel, btn, list);

  let opts = [], active = -1, typed = "", typedAt = 0, shown = null;
  const isOpen = () => !list.classList.contains("hide");
  const glyphOf = o => o.dataset.glyph ? iconEl(o.dataset.glyph) : null;

  // the status poll sets the value every 600 ms: leave the button alone unless what it shows has changed
  function paint(){
    const o = sel.options[sel.selectedIndex] || null;
    btn.disabled = sel.disabled;
    if(isOpen()) [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === sel.selectedIndex)));
    if(shown && shown.o === o && shown.text === (o && o.textContent)) return;
    shown = {o, text: o && o.textContent};
    btn.textContent = "";
    if(!o) return;
    const g = glyphOf(o); if(g) btn.append(g);
    const t = document.createElement("span"); t.className = "gsel-txt"; t.textContent = o.textContent; btn.append(t);
  }
  function build(){
    list.textContent = ""; opts = [...sel.options];
    opts.forEach((o, i) => {
      const li = document.createElement("div"); li.className = "gsel-opt"; li.id = list.id + "-" + i;
      li.setAttribute("role", "option"); li.setAttribute("aria-selected", String(i === sel.selectedIndex));
      if(o.disabled) li.setAttribute("aria-disabled", "true");
      // every row keeps the glyph column, so the names line up where an option has no glyph
      const slot = document.createElement("span"); slot.className = "gsel-ic"; const g = glyphOf(o); if(g) slot.append(g);
      const t = document.createElement("span"); t.textContent = o.textContent;
      li.append(slot, t);
      li.addEventListener("click", () => choose(i));
      li.addEventListener("mousemove", () => setActive(i, false));
      list.append(li);
    });
  }
  function setActive(i, scroll = true){
    if(i === active || i < 0 || i >= opts.length) return;
    if(list.children[active]) list.children[active].classList.remove("active");
    active = i;
    const li = list.children[i]; li.classList.add("active"); btn.setAttribute("aria-activedescendant", li.id);
    if(scroll && li.scrollIntoView) li.scrollIntoView({block: "nearest"});
  }
  const away = e => { if(!wrap.contains(e.target)) close(); };
  function open(){
    if(sel.disabled || isOpen()) return;
    build(); active = -1;
    list.classList.remove("hide"); btn.setAttribute("aria-expanded", "true");
    // open upward when the page below is too short for the list and there is more room above
    const r = btn.getBoundingClientRect();
    list.classList.toggle("up", win.innerHeight - r.bottom < Math.min(list.scrollHeight, 320) + 8 && r.top > win.innerHeight - r.bottom);
    setActive(Math.max(0, sel.selectedIndex));
    document.addEventListener("pointerdown", away, true);
  }
  function close(){
    if(!isOpen()) return;
    list.classList.add("hide"); btn.setAttribute("aria-expanded", "false"); btn.removeAttribute("aria-activedescendant");
    active = -1; document.removeEventListener("pointerdown", away, true);
  }
  function choose(i){
    const o = opts[i]; if(!o || o.disabled) return;
    close();
    if(i !== sel.selectedIndex){ sel.selectedIndex = i; paint(); sel.dispatchEvent(new win.Event("change", {bubbles: true})); }
    btn.focus();
  }
  function step(dir){
    for(let i = active + dir; i >= 0 && i < opts.length; i += dir) if(!opts[i].disabled){ setActive(i); return; }
  }

  btn.addEventListener("click", () => isOpen() ? close() : open());
  btn.addEventListener("blur", close);
  // focus stays on the button while the pointer picks from the list
  list.addEventListener("mousedown", e => e.preventDefault());
  // the field's name is its row label; wired on first focus, when the row exists
  btn.addEventListener("focus", () => {
    if(btn.hasAttribute("aria-labelledby")) return;
    const lab = wrap.closest(".row, .lz-f"); const name = lab && lab.querySelector("label, span");
    if(name && !name.contains(wrap)){ if(!name.id) name.id = list.id + "-name"; btn.setAttribute("aria-labelledby", name.id); }
  });
  btn.addEventListener("keydown", e => {
    switch(e.key){
      case "ArrowDown": case "ArrowUp": e.preventDefault(); if(isOpen()) step(e.key === "ArrowDown" ? 1 : -1); else open(); break;
      case "Home": case "End":
        if(!isOpen()) break;
        e.preventDefault(); { const idx = opts.map((o, i) => i).filter(i => !opts[i].disabled); setActive(e.key === "Home" ? idx[0] : idx[idx.length - 1]); }
        break;
      case "Enter": case " ": e.preventDefault(); if(isOpen()) choose(active); else open(); break;
      case "Escape": if(isOpen()){ e.preventDefault(); e.stopPropagation(); close(); } break;
      case "Tab": close(); break;
      default:
        if(e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) break;
        { const now = Date.now(); typed = (now - typedAt > 700 ? "" : typed) + e.key.toLowerCase(); typedAt = now; }
        if(!isOpen()) open();
        for(let k = 0, from = typed.length > 1 ? Math.max(active, 0) : active + 1; k < opts.length; k++){
          const i = (from + k) % opts.length;
          if(!opts[i].disabled && opts[i].textContent.toLowerCase().startsWith(typed)){ setActive(i); break; }
        }
    }
  });

  wrap.repaint = paint;
  new win.MutationObserver(paint).observe(sel, {childList: true, subtree: true, attributes: true, characterData: true});
  paint();
  return wrap;
}

export function repaintGlyphSelects(){ for(const w of document.querySelectorAll(".gsel")) w.repaint(); }
