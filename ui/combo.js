/* =====================================================================
   Пошук у довгих списках вибору (03.11.2026): <select> з багатьма варіантами (статті, маркетологи, рахунки) показується
   кнопкою, що відкриває список з полем пошуку — за словами з назви варіанта й назви групи (optgroup), у будь-якому порядку.
   Сам <select> лишається в розмітці (прихований): вибір записується в нього й викликає його «change», тож обробники вкладок
   не змінюються. Клавіші: ↑ ↓ — вибір, Enter — взяти, Esc — закрити.
   CFCombo.enhance(root, { min, variant }) — після кожного перемальовування; min — від скількох варіантів (за замовчуванням 10),
   variant 'b' — вигляд полів вікна «Помічника кешфлоу» (з рамкою). <select data-wide> (рахунки з довгими назвами) — кнопкою за будь-якої
   кількості варіантів. Назва на кнопці не обрізається, а переноситься (05.11.2026: «назви великі й не видно, на що закінчуються»).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFCombo = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[’ʼ`'"«»]/g, '').replace(/\s+/g, ' ').trim();
  // палітра — як у панелі лінтера (поле #F4F7F9, акцент #1F8FFF); 'b' — як поля вікна Помічника. «.cfl button.cmb» — сильніше за загальне
  // «.cfl button» панелі (висота 34 px, один рядок, жирний шрифт): через нього довгі назви на кнопці обрізались (05.11.2026)
  const CSS = `
.cmb,.cfl button.cmb{font:inherit;font-size:13px;font-weight:400;min-height:34px;height:auto;padding:8px 28px 8px 10px;margin:0;border:0;border-radius:8px;background:#F4F7F9;color:#1A1C1E;cursor:pointer;max-width:100%;
  display:inline-block;position:relative;text-align:left;white-space:normal;overflow-wrap:anywhere;vertical-align:middle;line-height:1.35}
.cmb::after{content:'';position:absolute;right:12px;top:50%;width:6px;height:6px;border:solid #727A82;border-width:0 1.5px 1.5px 0;transform:translateY(-70%) rotate(45deg)}
.cmb:hover:not(:disabled),.cfl button.cmb:hover:not(:disabled){background:#E8EDF1}
.cmb:focus-visible{outline:none;box-shadow:0 0 0 2px rgba(31,143,255,.45)}
.cmb:disabled,.cfl button.cmb:disabled{opacity:.45;cursor:default}
.cmb.ph,.cfl button.cmb.ph{color:#727A82}
.cmb.cmb-b{height:auto;line-height:1.45;padding:4px 26px 4px 6px;border:1px solid #c7ccd4;border-radius:6px;background:#fff}
.cmb.cmb-b:hover:not(:disabled){background:#f6f7f9}
.cmb-pop{position:fixed;z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;background:#fff;border:1px solid #ECEFF3;border-radius:10px;
  box-shadow:0 12px 32px rgba(42,44,50,.18);font:13px/1.4 "Open Sans","Segoe UI",system-ui,sans-serif;color:#1A1C1E;text-align:left}
.cmb-pop input{font:inherit;margin:8px;padding:0 10px;height:32px;border:0;border-radius:8px;background:#F4F7F9;color:#1A1C1E;outline:none;min-width:0}
.cmb-pop input:focus{box-shadow:0 0 0 2px rgba(31,143,255,.45)}
.cmb-list{overflow:auto;padding:0 6px 6px;flex:1 1 auto}
.cmb-g{padding:8px 8px 2px;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.02em}
.cmb-i{padding:6px 8px;border-radius:6px;cursor:pointer}
.cmb-i.on{background:#EAF2FF}
.cmb-i.sel{font-weight:700}
.cmb-i.nil{color:#727A82}
.cmb-none{padding:10px 8px;color:#727A82}`;
  let pop = null; // відкритий список: {el, sel, btn, off}

  function style() {
    if (document.getElementById('cfl-cmb-style')) return;
    const st = document.createElement('style');
    st.id = 'cfl-cmb-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function sync(sel, btn) {
    const o = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null, t = o ? o.textContent.trim() : '';
    btn.textContent = t || '—';
    btn.title = t;
    btn.disabled = sel.disabled;
    btn.classList.toggle('ph', !o || o.value === '');
  }
  function close() {
    if (!pop) return;
    const p = pop;
    pop = null;
    p.off();
    p.el.remove();
  }
  // під кнопкою, а якщо внизу мало місця — над нею; ширина — щонайменше 320 px, у межах вікна
  function place(el, btn) {
    const r = btn.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight, w = Math.min(Math.max(r.width, 320), vw - 16);
    const below = vh - r.bottom - 8, above = r.top - 8, up = below < 240 && above > below;
    el.style.width = `${w}px`;
    el.style.left = `${Math.max(8, Math.min(r.left, vw - w - 8))}px`;
    el.style.maxHeight = `${Math.max(160, Math.min(380, up ? above : below))}px`;
    if (up) { el.style.top = ''; el.style.bottom = `${vh - r.top + 4}px`; } else { el.style.bottom = ''; el.style.top = `${r.bottom + 4}px`; }
  }
  function open(sel, btn) {
    close();
    const el = document.createElement('div');
    el.className = 'cmb-pop';
    el.innerHTML = '<input type="text" placeholder="Пошук…" autocomplete="off" spellcheck="false" aria-label="Пошук у списку"><div class="cmb-list" role="listbox"></div>';
    document.body.appendChild(el);
    const q = el.querySelector('input'), list = el.querySelector('.cmb-list'), items = [];
    for (const ch of sel.children) {
      if (ch.tagName === 'OPTGROUP') for (const op of ch.children) items.push({ op, g: ch.label || '' });
      else if (ch.tagName === 'OPTION') items.push({ op: ch, g: '' });
    }
    items.forEach(it => { it.t = it.op.textContent.trim(); it.k = norm(`${it.t} ${it.g}`); });
    let shown = [], act = -1;
    const mark = () => {
      list.querySelectorAll('.cmb-i').forEach(d => d.classList.toggle('on', Number(d.dataset.i) === act));
      const d = list.querySelector('.cmb-i.on');
      if (!d || !d.getBoundingClientRect) return;
      // прокрутити лише сам список (scrollIntoView прокручував би й сторінку — а прокрутка сторінки закриває список)
      const lr = list.getBoundingClientRect(), dr = d.getBoundingClientRect();
      if (dr.top < lr.top) list.scrollTop -= lr.top - dr.top;
      else if (dr.bottom > lr.bottom) list.scrollTop += dr.bottom - lr.bottom;
    };
    const draw = () => {
      const words = norm(q.value).split(' ').filter(Boolean);
      shown = items.filter(it => !it.op.disabled && words.every(w => it.k.includes(w)));
      let h = '', g = null;
      shown.forEach((it, i) => {
        if (it.g !== g) { g = it.g; if (g) h += `<div class="cmb-g">${esc(g)}</div>`; }
        h += `<div class="cmb-i${it.op.selected ? ' sel' : ''}${it.op.value === '' ? ' nil' : ''}" data-i="${i}" role="option">${esc(it.t)}</div>`;
      });
      list.innerHTML = h || '<div class="cmb-none">Нічого не знайдено</div>';
      act = words.length ? (shown.length ? 0 : -1) : shown.findIndex(it => it.op.selected); // з пошуком — перший збіг, без — вибраний
      mark();
    };
    const pick = i => {
      const it = shown[i];
      if (!it) return;
      close();
      if (sel.value !== it.op.value) { sel.value = it.op.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      if (document.contains(btn)) btn.focus();
    };
    q.addEventListener('input', draw);
    q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (shown.length) { act = (act + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; mark(); }
      } else if (e.key === 'Enter') { e.preventDefault(); pick(act); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); btn.focus(); }
      else if (e.key === 'Tab') close();
    });
    list.addEventListener('mousedown', e => e.preventDefault()); // фокус лишається в полі пошуку
    list.addEventListener('click', e => { const d = e.target.closest('.cmb-i'); if (d) pick(Number(d.dataset.i)); });
    const outside = e => { if (!el.contains(e.target) && e.target !== btn) close(); };
    const scroll = e => { if (!el.contains(e.target)) close(); }; // прокрутили сторінку чи таблицю — список закривається
    document.addEventListener('mousedown', outside, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    pop = { el, sel, btn, off: () => { document.removeEventListener('mousedown', outside, true); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', close); } };
    draw();
    place(el, btn);
    mark(); // уже з висотою списку: поточний варіант (200-й із 300) видно одразу, а не перші
    q.focus();
  }
  function enhance(root, o) {
    if (!root || typeof document === 'undefined') return;
    o = o || {};
    style();
    if (pop && !document.contains(pop.btn)) close(); // перемалювали — список від старої кнопки закрити
    root.querySelectorAll('select').forEach(sel => {
      if (sel.dataset.cmb || sel.multiple || (sel.options.length < (o.min || 10) && sel.dataset.wide === undefined)) return;
      sel.dataset.cmb = '1';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cmb${o.variant ? ' cmb-' + o.variant : ''}`;
      btn.style.cssText = sel.style.cssText; // max-width, відступи — як у списку
      if (sel.offsetWidth) btn.style.minWidth = `${Math.min(sel.offsetWidth, 260)}px`;
      sync(sel, btn);
      sel.style.display = 'none';
      sel.after(btn);
      btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (pop && pop.sel === sel) close(); else open(sel, btn); });
      btn.addEventListener('keydown', e => { if (e.key === 'ArrowDown' && !(pop && pop.sel === sel)) { e.preventDefault(); open(sel, btn); } }); // Enter і пробіл — звичайний click
      sel.addEventListener('change', () => sync(sel, btn));
    });
  }
  return { enhance, close, norm };
}));
