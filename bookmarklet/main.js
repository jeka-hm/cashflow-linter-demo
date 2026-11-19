/* Запуск лінтера на сторінці crm.example.com (букмарклет або консоль).
   Токен — localStorage.token (як у реєстрі v1.10), запити — на той самий домен.
   Без window.CF_LINTER_CONFIG = { APPLY: true } режим редагування недоступний. */
(() => {
  'use strict';
  if (!/(^|\.)crm\.example\.com$/.test(location.hostname)) { alert('Лінтер кешфлоу: відкрийте crm.example.com під своїм логіном'); return; }
  const CFG = window.CF_LINTER_CONFIG || {};
  try { delete window.CF_LINTER_CONFIG; } catch (e) { window.CF_LINTER_CONFIG = undefined; } // прапорець діє лише на один запуск
  const BUILD = typeof CF_BUILD === 'string' ? CF_BUILD : '', APPLY = String(CFG.APPLY === true);
  const old = document.getElementById('cfl-panel');
  // та сама збірка в тому самому режимі вже відкрита (можливо, згорнута) — просто показати її: стан і результати не губляться
  if (old && BUILD && old.dataset.build === BUILD && old.dataset.apply === APPLY) { restore(old); return; }
  // зайнято: лінтер застосовує зміни чи відкат, або реєстр у вкладці «Погодження» вносить записи (його кнопки вимкнено)
  const busyIn = el => !!(el && (el.querySelector('.cfl[data-busy="1"]') || el.querySelector('#pogodzh-panel button[data-a="check"]:disabled')));
  const BUSY_MSG = 'Лінтер кешфлоу ще застосовує зміни, відкат або вносить погодження — дочекайтеся завершення.';
  if (busyIn(old)) { restore(old); alert(BUSY_MSG); return; }
  if (old) { old.remove(); removePill(); }
  const token = () => (localStorage.getItem('token') || '').replace(/^"|"$/g, '');
  if (!token()) { alert('Лінтер кешфлоу: немає токена — увійдіть у CRM'); return; }

  async function rawFetch(method, path, body) {
    const headers = { Authorization: 'Bearer ' + token(), Accept: 'application/json' };
    const form = typeof FormData !== 'undefined' && body instanceof FormData; // створення переказу — FormData, як у формі сайту й реєстрі погоджень
    if (body && !form) headers['Content-Type'] = 'application/json';
    const r = await fetch(location.origin + '/api/' + path, { method, headers, body: body ? (form ? body : JSON.stringify(body)) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text: json ? '' : text.slice(0, 500), retryAfter: Number(r.headers.get('Retry-After')) || 0 };
  }
  const api = CFLinter.makeApi(rawFetch, { minInterval: 300 });
  const helperUrl = () => { try { return String(JSON.parse(localStorage.getItem('cfl_helper_url')) || 'http://127.0.0.1:8765').replace(/\/+$/, ''); } catch (e) { return 'http://127.0.0.1:8765'; } };
  const b64 = data => {
    const u = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const storage = {
    saveFile(name, mime, data) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data], { type: mime }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    },
    /* Резервні копії й журнали — тихо в папку даних «Помічника кешфлоу» (без вікна «Зберегти як»); без Помічника — звичайне завантаження.
       → {where: 'helper', path} або {where: 'download'} */
    async keepFile(name, mime, data, kind) {
      try {
        const ac = new AbortController(), t = setTimeout(() => ac.abort(), 5000);
        const r = await fetch(helperUrl() + '/api/panel/files/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: ac.signal,
          body: JSON.stringify({ name, kind, base64: b64(data) }) });
        clearTimeout(t);
        const j = await r.json();
        if (r.ok && j && j.ok) return { where: 'helper', path: j.path, dir: j.dir };
      } catch (e) {}
      storage.saveFile(name, mime, data);
      return { where: 'download' };
    },
    pickFile(accept) {
      return new Promise(res => {
        const i = document.createElement('input');
        i.type = 'file'; i.accept = accept;
        i.onchange = async () => { const f = i.files[0]; res(f ? { name: f.name, text: await f.text() } : null); };
        i.click();
      });
    },
  };
  // «Підказки ШІ»: записи без правил — у «Помічник кешфлоу» (ключ Claude API лише в ньому); не відповідає — картка так і скаже
  // ms — скільки чекати: Помічник, що «завис» (консоль у режимі виділення, Google Диск не відповідає), не має лишати картку на «Питаю…» назавжди
  async function helperPost(path, body, ms) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(helperUrl() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(body), signal: ac.signal });
      const j = await r.json().catch(e => { if (e && e.name === 'AbortError') throw e; return null; });
      if (!r.ok || !j) throw new Error((j && j.error) || `Помічник: HTTP ${r.status}`);
      return j;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(`«Помічник кешфлоу» не відповів за ${Math.round(ms / 1000)} с`);
      throw e;
    } finally { clearTimeout(t); }
  }
  const helperAi = body => helperPost('/api/panel/ai/hints', body, 30000); // відомі підказки — одразу, решта йде в Claude у фоні
  // «Зіставлення ШІ» у «Звірці з банком»: залишок (операції банку без погодження ↔ погодження без операції) — у Claude через Помічник;
  // відповідь Claude чекаємо (до 10 хв — велика відповідь)
  const helperAiMatch = body => helperPost('/api/panel/ai/match', body, 600000);
  const panel = document.createElement('div');
  panel.id = 'cfl-panel';
  panel.dataset.build = BUILD;
  panel.dataset.apply = APPLY;
  // на весь екран (згорнути — кнопкою з рискою)
  panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;overflow:auto;background:#f7f7f7;z-index:2147483000;padding:0';
  document.body.appendChild(panel);
  CFPanel.mount(panel, {
    api, rulesDoc: CF_RULES, storage, applyAllowed: CFG.APPLY === true,
    userId: (localStorage.getItem('user_id') || '').replace(/^"|"$/g, '') || null, // права на кешфлоу — як їх читає сам CRM (GET user/{id})
    title: 'Лінтер кешфлоу' + (CFG.APPLY === true ? ' — зміни дозволено' : ''), onClose: () => { if (busyIn(panel)) alert(BUSY_MSG); else { panel.remove(); removePill(); } },
    onMinimize: () => minimize(panel), ai: helperAi, aiMatch: helperAiMatch,
    // вкладка «Погодження» — лише у збірці з реєстром погоджень (у публічній версії його немає: це сторонній код)
    apprTab: typeof globalThis.CF_REGISTRY_RUN === 'function',
  });

  // ---------- згортання: панель ховається, у куті — кнопка «Лінтер кешфлоу», яка повертає її такою, як була ----------
  function minimize(p) {
    p.style.display = 'none';
    removePill();
    const pill = document.createElement('div');
    pill.id = 'cfl-pill';
    pill.title = 'Розгорнути панель лінтера';
    pill.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:9px 14px;border-radius:20px;background:#2a2c32;color:#fff;font:600 13px/1 "Open Sans","Segoe UI",Arial,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.3);cursor:pointer;user-select:none';
    pill.innerHTML = '<span data-dot style="width:8px;height:8px;border-radius:50%;background:#0095d4"></span><span data-t>Лінтер кешфлоу</span><span style="opacity:.7">▴</span>';
    pill.onclick = () => restore(p);
    document.body.appendChild(pill);
    // поки згорнуто: якщо лінтер чи реєстр щось виконує — помітно на кнопці
    pill._t = setInterval(() => {
      const busy = !!(p.querySelector('.cfl[data-busy="1"]') || p.querySelector('#pogodzh-panel button[data-a="check"]:disabled'));
      pill.querySelector('[data-dot]').style.background = busy ? '#efbb3d' : '#0095d4';
      pill.querySelector('[data-t]').textContent = busy ? 'Лінтер кешфлоу · працює…' : 'Лінтер кешфлоу';
    }, 1500);
  }
  function removePill() { const pill = document.getElementById('cfl-pill'); if (pill) { clearInterval(pill._t); pill.remove(); } }
  function restore(p) { p.style.display = ''; removePill(); }
})();
