/* Закладка-завантажувач лінтера кешфлоу (вміст dist/*.bookmarklet.txt).
   Сам лінтер — файл dist/cashflow_linter.js, підписаний ключем розробника (ECDSA P-256; відкритий ключ — KEY нижче).
   Звідки код: з двох — збереженої в IndexedDB сайту CRM копії та файлу із запущеного «Помічника кешфлоу» — береться новіший
   (за міткою CF_BUILD); якщо немає жодного, людина один раз вибирає файл. Виконується лише код з дійсним підписом, тому після
   оновлень закладку не перетягують заново. Повний код у закладці Firefox не зберігає: його межа — 65 536 символів.
   __CFG__ і __KEY__ заповнює build. void — щоб браузер не підмінив сторінку результатом виразу (так робить Firefox для javascript:-закладок). */
void (async () => {
  const CFG = __CFG__, KEY = __KEY__, MARK = '\n//# CFL-SIG ';
  if (!/(^|\.)crm\.example\.com$/.test(location.hostname)) { alert('Лінтер кешфлоу: відкрийте crm.example.com під своїм логіном'); return; }
  // та сама база, що й для резервних копій панелі: cf_linter / kv; v === null — видалити
  const kv = (k, v) => new Promise(ok => {
    const r = indexedDB.open('cf_linter', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => ok(undefined);
    r.onsuccess = () => {
      const t = r.result.transaction('kv', v === undefined ? 'readonly' : 'readwrite'), s = t.objectStore('kv');
      const q = v === undefined ? s.get(k) : v === null ? s.delete(k) : s.put(v, k);
      t.oncomplete = () => ok(v === undefined ? q.result : true);
      t.onerror = t.onabort = () => ok(undefined);
    };
  });
  const pub = crypto.subtle.importKey('jwk', KEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  // текст файлу → { text, code, build }, якщо підпис дійсний; інакше null
  async function check(text) {
    const i = typeof text === 'string' ? text.lastIndexOf(MARK) : -1;
    if (i < 0) return null;
    const code = text.slice(0, i + 1);
    try {
      const sig = Uint8Array.from(atob(text.slice(i + MARK.length).trim()), c => c.charCodeAt(0));
      if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await pub, sig, new TextEncoder().encode(code))) return null;
    } catch (e) { return null; }
    const m = /\nvar CF_BUILD = '([^']*)';/.exec(code);
    return { text, code, build: m ? m[1] : '' };
  }
  let best = await check(await kv('signed'));
  let helper = 'http://127.0.0.1:8765'; // адресу Помічника можна змінити так само, як для вкладки «Звірка з банком»
  try { const h = JSON.parse(localStorage.getItem('cfl_helper_url')); if (typeof h === 'string' && h) helper = h.replace(/\/+$/, ''); } catch (e) {}
  try {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 2500);
    const r = await fetch(helper + '/dist/cashflow_linter.js', { cache: 'no-store', signal: ac.signal });
    const fresh = r.ok ? await check(await r.text()) : null;
    clearTimeout(t);
    if (fresh && (!best || fresh.build > best.build)) { best = fresh; await kv('signed', fresh.text); }
  } catch (e) {} // Помічник не запущено — працюємо зі збереженою копією
  if (!best) best = await pick();
  if (!best) return;
  kv('bundle', null); // копія від закладки попередньої версії більше не потрібна
  window.CF_LINTER_CONFIG = CFG;
  (0, eval)(best.code);

  function pick() {
    return new Promise(ok => {
      const old = document.getElementById('cfl-loader');
      if (old) old.remove();
      const w = document.createElement('div');
      w.id = 'cfl-loader';
      w.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;width:min(460px,calc(100vw - 32px));background:#fff;color:#2a2c32;font:14px/1.45 "Open Sans","Segoe UI",Arial,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3);border-radius:6px;padding:16px 18px';
      const btn = 'font:inherit;font-size:13px;font-weight:700;height:32px;padding:0 16px;margin:8px 8px 0 0;border-radius:4px;cursor:pointer;border:1px solid ';
      w.innerHTML = `<b style="font-size:15px">Лінтер кешфлоу</b>
<p style="margin:8px 0">Найпростіше — запустіть «Помічник кешфлоу» і натисніть закладку ще раз: лінтер завантажиться з нього сам. Або виберіть файл <b>cashflow_linter.js</b> з папки <b>dist</b> лінтера — це потрібно один раз: далі браузер його пам'ятає.</p>
<p data-e style="display:none;color:#c43a3a;margin:6px 0"></p>
<button data-p style="${btn}#0095d4;background:#0095d4;color:#fff">Вибрати файл…</button><button data-c style="${btn}#eaeaeb;background:#fff;color:#55565b">Скасувати</button>
<input type="file" accept=".js,text/javascript" hidden>`;
      document.body.appendChild(w);
      const inp = w.querySelector('input'), err = w.querySelector('[data-e]');
      w.querySelector('[data-p]').onclick = () => inp.click();
      w.querySelector('[data-c]').onclick = () => { w.remove(); ok(null); };
      inp.onchange = async () => {
        const f = inp.files[0];
        inp.value = '';
        if (!f) return;
        const c = await check(await f.text());
        if (!c) {
          err.style.display = 'block';
          err.textContent = `«${f.name}» — не той файл або його змінено: підпис не збігається. Потрібен cashflow_linter.js з папки dist лінтера.`;
          return;
        }
        await kv('signed', c.text);
        w.remove();
        ok(c);
      };
    });
  }
})().catch(e => alert('Лінтер кешфлоу: ' + e.message));
