/* =====================================================================
   Панель лінтера кешфлоу (спільна для букмарклета на сторінці CRM
   і для «Помічника кешфлоу»). Вигляд — у стилі самого CRM.
   CFPanel.mount(container, {
     api,          // CFLinter.makeApi(...)
     rulesDoc,     // вміст rules.json
     storage: { saveFile(name, mime, data) , pickFile(accept) → {name, text} },
     applyAllowed, // true — режим редагування можна вмикати (APPLY: true / програма)
     bankTab,      // false — без вкладки «Звірка з банком» (у «Помічнику» є своя)
     apprTab,      // false — без вкладки «Погодження» (реєстр працює лише на сторінці CRM)
     userId,       // ID користувача CRM — перевірити права на кешфлоу (GET user/{id}); без нього не перевіряються
     ai,           // async ({records, retry}) → відповідь «Помічника кешфлоу» для «Підказок ШІ»; без нього картки немає
     title, onClose
   })
   За замовчуванням — лише перегляд (dry-run). Зміни — тільки в режимі
   редагування: людина сама позначає зміни (окремо статтю й проєкт, або
   групою), потім резервна копія й підтвердження.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../core/rules-engine.js'), require('../core/crm-model.js'), require('../core/linter.js'), require('../core/xlsx.js'), () => require('./bank-panel.js'), () => require('./approvals-tab.js'), require('./combo.js'), require('../core/drafts.js'));
  else root.CFPanel = factory(root.CFRules, root.CFModel, root.CFLinter, root.CFXlsx, () => root.CFBankPanel, () => root.CFApprovalsTab, root.CFCombo, root.CFDrafts);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (R, M, L, X, bankModule, apprModule, Cmb, CFD) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // форматери створюються один раз: toLocaleString робить новий на кожен виклик (у таблиці записів — сотні)
  const NF2 = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), NF0 = new Intl.NumberFormat('uk-UA');
  const fmt = x => NF2.format(Number(x));
  const fmt0 = x => NF0.format(Math.round(Number(x)));
  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  // Остання резервна копія — ще й в IndexedDB цього сайту (на випадок, якщо файл не завантажився); localStorage CRM не займає.
  const IDB = {
    open() { return new Promise((res, rej) => { const r = indexedDB.open('cf_linter', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async get(k) { try { const db = await IDB.open(); return await new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch (e) { return undefined; } },
    async set(k, v) { try { const db = await IDB.open(); return await new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = t.onabort = () => res(false); }); } catch (e) { return false; } },
    async del(k) { try { const db = await IDB.open(); await new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = t.onerror = t.onabort = res; }); } catch (e) {} },
  };
  const today = () => M.kyivNow().slice(0, 10);
  const stamp = () => M.kyivNow().replace('T', '_').replace(':', '-');
  /* Спільний період «Звірки з банком» і «Статей і проєктів» (cfl_period, 16.11.2026; те саме — в ui/bank-panel/04): останній
     звірений чи перевірений СЬОГОДНІ. Одна вкладка підхоплює період іншої; іншого дня — як і раніше, сьогодні. «Погодження» — окремо. */
  const sharedPeriod = () => { const v = LS.get('cfl_period', null), ok = s => /^\d{4}-\d\d-\d\d$/.test(String(s || '')); return v && v.day === today() && ok(v.from) && ok(v.to) && v.from <= v.to ? v : null; };
  const savePeriod = (from, to, by) => { const v = { from, to, day: today(), by, n: Date.now() }; LS.set('cfl_period', v); return v; };
  // стаття підходить запису за типом: дохідна — надходженню, витратна — витраті (тип невідомий — не перевіряється)
  const artTypeOk = (article, recType) => { const t = recType === 'income' ? 1 : recType === 'expense' ? 2 : null; return !!article && (article.type == null || t == null || article.type === t); };
  // у «Статтях і проєктах» є позначені, але не застосовані зміни — перевірка місяця із «Закриття місяця» їх не чіпає
  const hasPendingWork = s => !!(s && s.editMode && !s.applyDone && (s.selected > 0 || s.manual > 0));
  /* Статус окремого правила в записі — словами, для колонки «Статус · правила». */
  const RULE_ST = { ok: 'збігається', fix: 'виправити', review: 'перевірити', 'manual-422': 'лише вручну в CRM', 'locked-auto': 'не змінюється (лід / авто)',
    'locked-date': 'до межі — лише довідка', overridden: 'перекрито іншим правилом' };
  const ST_CLS = { fix: 'st-fix', review: 'st-review', 'manual-422': 'st-manual', 'locked-auto': 'st-locked', 'locked-date': 'st-locked', ok: 'st-ok', overridden: 'st-ok', kept: 'st-ok' };
  const dmy = iso => iso.split('-').reverse().join('.');
  const lastPart = s => String(s || '').split(' / ').pop();
  const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
  const nRec = n => `${n} ${plural(n, 'запис', 'записи', 'записів')}`;
  const changeKey = c => c.field === 'category' ? c.to.category_id + '/' + c.to.operation_id : String(c.to);

  /* Один вигляд для всіх вкладок — палітра й форми реєстру погоджень (його панель — у вкладці «Погодження»): м'які сірі поля без
     рамок, картки й кнопки з радіусом 8–12 px, темна основна кнопка, сегментовані перемикачі, статуси — «пігулки» з м'яким фоном.
     Шрифт — Open Sans, як у crm.example.com. Рамки й відступи заголовків і плашок скидаємо явно: у вкладці «Лінтер»
     Помічника є свої загальні h3/.warn/.err (app.css), а панель має виглядати так само, як на сторінці CRM (07.11.2026). */
  const CSS = `
.cfl{--ink:#1A1C1E;--text:#55565B;--muted:#727A82;--faint:#9CA3AF;--field:#F4F7F9;--field2:#E8EDF1;--line:#ECEFF3;--bg:#F4F6F8;--dark:#2A2C32;
  --blue:#1F6FD1;--accent:#1F8FFF;--red:#E5484D;--ok:#00806B;--ok-bg:#E3F5F1;--warn:#9A5B00;--warn-bg:#FFF2DE;--err:#C2410C;--err-bg:#FFECE5;--info:#1F6FD1;--info-bg:#EAF2FF;
  font:14px/1.45 "Open Sans","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;color:var(--text)}
.cfl-host{background:var(--bg);min-height:100%}
.cfl *{box-sizing:border-box}.cfl [hidden]{display:none!important}
.cfl .hdr{position:sticky;top:0;z-index:5}
.cfl .top{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--dark);color:#fff;padding:12px 20px}
.cfl .tabs{display:flex;gap:4px;background:#fff;padding:0 20px;border-bottom:1px solid var(--line)}
.cfl .tabs span{padding:11px 14px 9px;cursor:pointer;font-weight:600;font-size:13px;color:var(--muted);border-bottom:2px solid transparent;user-select:none}
.cfl .tabs span:hover{color:var(--ink)}.cfl .tabs span.on{color:var(--ink);border-bottom-color:var(--ink)}
.cfl .top h2{color:#fff;font-size:16px;font-weight:700;margin:0}
.cfl .top .meta{color:#b9bac0;font-size:12px;margin-top:2px}.cfl .top .lnk{background:rgba(255,255,255,.12);color:#fff}.cfl .top .lnk:hover{background:rgba(255,255,255,.2)}
.cfl .top .x{background:rgba(255,255,255,.08);border:0;color:#fff;width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:16px;margin:0;padding:0;display:inline-flex;align-items:center;justify-content:center}.cfl .top .x:hover{background:rgba(255,255,255,.18);color:#fff}.cfl .top .x + .x{margin-left:6px}
.cfl .wrap{padding:16px 20px 28px}
.cfl h3{font-size:15px;color:var(--ink);margin:0 0 12px;font-weight:600;border:0;padding:0}
.cfl .card{background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 2px rgba(42,44,50,.04);padding:16px 18px;margin:0 0 14px}
.cfl .muted{color:var(--muted)}.cfl .small{font-size:12px}.cfl .bad{color:var(--err);font-weight:600}.cfl .ok{color:var(--ok);font-weight:600}
.cfl label{cursor:pointer}
.cfl button{font:inherit;font-size:13px;font-weight:600;height:34px;padding:0 14px;margin:0 8px 6px 0;border-radius:8px;border:0;background:var(--field);color:var(--text);cursor:pointer;white-space:nowrap}
.cfl button:hover:not(:disabled){background:var(--field2);color:var(--ink)}
.cfl button.primary{background:var(--dark);color:#fff}.cfl button.primary:hover:not(:disabled){background:#3A3D45;color:#fff}
.cfl button.danger{background:var(--red);color:#fff}.cfl button.danger:hover:not(:disabled){background:#D13B40;color:#fff}
.cfl button.quiet{background:transparent;color:var(--muted)}.cfl button.quiet:hover:not(:disabled){background:var(--field);color:var(--ink)}
.cfl button:disabled{opacity:.45;cursor:default}
.cfl button:focus-visible,.cfl input:focus-visible,.cfl select:focus-visible,.cfl summary:focus-visible{outline:none;box-shadow:0 0 0 2px rgba(31,143,255,.45)}
.cfl input[type=date],.cfl select{font:inherit;font-size:13px;height:34px;padding:0 10px;border:0;border-radius:8px;background:var(--field);color:var(--ink)}
.cfl input[type=checkbox]{width:16px;height:16px;accent-color:var(--dark);vertical-align:middle;cursor:pointer;margin:0 4px 0 0}
.cfl .row{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin:6px 0}
.cfl .lbl{font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px}
.cfl .lst{max-height:170px;overflow:auto;border-radius:8px;padding:6px 10px;background:#fff;margin:8px 0}
.cfl .lst label{display:block;white-space:nowrap;padding:2px 0}
.cfl details{border-radius:10px;padding:8px 12px;background:var(--field);min-width:320px;flex:1 1 320px}
.cfl summary{cursor:pointer;font-size:13px;color:var(--ink);font-weight:600}
.cfl details.hint{background:transparent;padding:0;min-width:0;flex:none;margin:8px 0 0}
.cfl details.hint>summary{color:var(--muted);font-size:12px}.cfl details.hint>summary:hover{color:var(--ink)}
.cfl details.hint>div{margin-top:6px;font-size:13px;color:var(--muted);max-width:980px}
.cfl .mode{display:inline-block;padding:4px 9px;border-radius:6px;font-weight:700;font-size:12px}
.cfl .mode.view{background:rgba(71,183,190,.25);color:#bff0f3}.cfl .mode.edit{background:var(--red);color:#fff}
.cfl .chips{display:flex;flex-wrap:wrap;gap:6px}
.cfl .chips span{display:inline-flex;align-items:center;padding:4px 11px;border-radius:999px;cursor:pointer;font-weight:600;font-size:12px;user-select:none;opacity:.45;box-shadow:inset 0 0 0 1px transparent}
.cfl .chips span:hover{opacity:.8}.cfl .chips span.on{opacity:1;box-shadow:inset 0 0 0 1px currentColor}
.cfl .st-fix{background:var(--warn-bg);color:var(--warn)}
.cfl .st-review{background:var(--info-bg);color:var(--info)}
.cfl .st-manual{background:var(--err-bg);color:var(--err)}
.cfl .st-locked{background:var(--field);color:var(--muted)}
.cfl .st-ok{background:var(--ok-bg);color:var(--ok)}
.cfl .badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600;white-space:nowrap}
.cfl .warn,.cfl .err,.cfl .info,.cfl .good{padding:10px 14px;margin:8px 0;border-radius:10px;font-size:13px;border:0}
.cfl .warn{background:var(--warn-bg);color:#6B4300}
.cfl .err{background:var(--err-bg);color:#9A3412;white-space:pre-wrap}
.cfl .info{background:var(--info-bg);color:#1B4F8F}
.cfl .good{background:var(--ok-bg);color:#00644F;font-weight:600}
.cfl table.cl{border-spacing:0}.cfl table.cl td{padding:10px 8px;vertical-align:top;border-top:1px solid var(--line);border-bottom:0}.cfl table.cl tr:first-child td{border-top:0}
.cfl table.cl td.ic{width:28px;font-size:16px;text-align:center}.cfl table.cl tr:hover>td{background:transparent}
.cfl table.cl ul{margin:4px 0 0;padding-left:18px;font-size:12px;color:var(--text)}
.cfl table.cl details{background:transparent;padding:0;min-width:0;margin-top:4px}.cfl table.cl details>summary{font-size:12px;color:var(--muted)}
.cfl .groups{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:10px}
.cfl .grp{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:#fff;display:flex;gap:10px;align-items:flex-start}
.cfl .grp.on{border-color:var(--dark);box-shadow:inset 0 0 0 1px var(--dark)}
.cfl .grp .t{color:var(--ink);font-weight:600}
.cfl .grp .s{font-size:12px;color:var(--muted);margin-top:2px}
.cfl .lnk{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;background:rgba(42,44,50,.06);color:var(--ink);cursor:pointer;font-weight:600;font-size:12px;line-height:1;vertical-align:1px;white-space:nowrap;user-select:none}.cfl .lnk:hover{background:rgba(42,44,50,.12)}
.cfl .tbl{max-height:64vh;overflow:auto;border:1px solid var(--line);border-radius:12px;background:#fff}
.cfl table{border-collapse:separate;border-spacing:0;width:100%}
.cfl table.recs{table-layout:fixed;min-width:1000px}
.cfl .cmt{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:13px}
.cfl .acc{font-size:12px;color:#7a7b80}
.cfl th{position:sticky;top:0;z-index:1;background:#FAFBFC;color:var(--muted);font-size:12px;font-weight:600;text-align:left;padding:10px;border-bottom:1px solid var(--line);white-space:nowrap}
.cfl td{background:#fff;padding:10px;vertical-align:top;border-bottom:1px solid var(--line)}
.cfl tr:last-child>td{border-bottom:0}
.cfl tr:hover>td{background:#FAFBFC}
.cfl td.n{text-align:right;white-space:nowrap;color:var(--ink);font-weight:600}
.cfl .id{color:var(--blue);font-weight:700}
.cfl .chg{display:flex;gap:4px;align-items:flex-start;margin:2px 0;line-height:1.35}
.cfl .chg .f{color:var(--muted);font-size:12px;min-width:52px}
.cfl .chg .from{color:var(--muted)}
.cfl .chg .to{color:var(--ink);font-weight:600}
.cfl .rules{font-size:12px;color:var(--muted);margin-top:4px}
.cfl .rl{color:var(--text);margin-top:3px;line-height:1.35}.cfl .rl b{font-weight:600}.cfl .rl .rid{color:var(--faint);font-size:11px;white-space:nowrap}
.cfl .rs-fix{color:var(--warn)}.cfl .rs-review{color:var(--info)}.cfl .rs-manual-422{color:var(--err)}.cfl .rs-ok,.cfl .rs-overridden,.cfl .rs-locked-auto,.cfl .rs-locked-date{color:var(--muted)}
.cfl .modal-bg{position:fixed;inset:0;background:rgba(42,44,50,.45);z-index:2147483646;display:flex;align-items:center;justify-content:center}
.cfl .modal{background:#fff;border-radius:12px;max-width:760px;width:94vw;max-height:88vh;overflow:auto;padding:20px 22px;box-shadow:0 12px 40px rgba(42,44,50,.25)}
.cfl .modal h3{margin:0 0 10px}
.cfl pre{background:var(--field);padding:10px;border-radius:8px;overflow:auto;max-height:240px;white-space:pre-wrap}
.cfl .edit-cell select{max-width:280px}
.cfl .box{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:8px 0}
.cfl table.bal{table-layout:fixed;min-width:980px;border-spacing:0}.cfl th.n{text-align:right}
.cfl table.bal td{border-bottom:0}
.cfl table.bal tr.acc td{border-top:1px solid var(--line)}.cfl table.bal tr.sub td,.cfl table.bal tr.det td{border-top:0;padding-top:2px}
.cfl table.bal tr.sub td{font-size:13px;line-height:1.5;padding-bottom:12px}
.cfl td.cnt{white-space:normal;font-size:13px;line-height:1.35}.cfl td.act{white-space:nowrap;text-align:right}
.cfl td.act button{margin:0 0 0 4px;padding:0 10px;height:30px}.cfl td.act button.det-btn{width:84px;padding:0}.cfl button.eye{width:32px;padding:0!important;display:inline-flex;align-items:center;justify-content:center;color:var(--text);vertical-align:middle}
.cfl tr.hid button.eye{color:var(--faint)}
.cfl tr.gh td,.cfl tr.gh:hover td{background:var(--field);border-top:1px solid var(--line);padding:8px 10px;color:var(--ink);font-weight:600;font-size:13px}
.cfl tr.hid td{opacity:.55}
.cfl .an{color:var(--ink);font-weight:600}
.cfl td.nt,.cfl .nt{font-size:12px;line-height:1.35}.cfl .nt{margin-top:4px}
.cfl td.mt{text-align:right;white-space:nowrap}.cfl td.mt .v{color:var(--ink);font-weight:600}.cfl td.mt .bk{color:var(--muted);font-size:12px}.cfl td.mt .ok,.cfl td.mt .bad{font-size:12px}
.cfl tr.s-ok td:first-child,.cfl tr.s-timing td:first-child,.cfl tr.s-pay td:first-child{box-shadow:inset 3px 0 0 #2BB5A0}.cfl tr.s-bad td:first-child{box-shadow:inset 3px 0 0 var(--red)}.cfl tr.s-part td:first-child,.cfl tr.s-xfer td:first-child{box-shadow:inset 3px 0 0 var(--accent)}
.cfl tr.det td,.cfl tr.det:hover td{background:#FBFCFD}.cfl table.amts{border-spacing:0;margin-top:4px}.cfl table.amts th{position:static;background:var(--field);padding:6px 8px}
.cfl table.amts td{padding:6px 8px;font-size:12px;vertical-align:top}
.cfl td .lnk{margin-left:4px}
.cfl td.mt input.man{display:block;width:100%;max-width:120px;margin:2px 0 0 auto}.cfl input.man{width:128px;font:inherit;font-size:13px;height:30px;padding:0 8px;border:0;border-radius:8px;background:var(--field);text-align:right;color:var(--ink)}
.cfl input.man:focus{outline:none;box-shadow:0 0 0 2px rgba(31,143,255,.45)}.cfl input.badin{background:var(--err-bg);box-shadow:inset 0 0 0 1px var(--red)}
.cfl table.xf{min-width:980px}.cfl table.xf td{vertical-align:top}.cfl table.xf input.xcom{width:100%;min-width:220px;box-sizing:border-box;font:inherit;font-size:13px;height:30px;padding:0 8px;border:0;border-radius:8px;background:var(--field);color:var(--ink)}
.cfl table.xf textarea.xcom{display:block;width:100%;min-width:220px;box-sizing:border-box;font:inherit;font-size:13px;line-height:1.35;padding:6px 8px;border:0;border-radius:8px;background:var(--field);color:var(--ink);resize:vertical}.cfl table.xf textarea.xcom:focus{outline:none;box-shadow:0 0 0 2px rgba(31,143,255,.45)}.cfl table.xf textarea.xcom:disabled{opacity:.6}.cfl table.xf .xwhy{font-size:12px;max-width:360px}.cfl table.xf select{max-width:150px;height:30px}
.cfl .pr{padding:8px 0;border-top:1px solid var(--line);font-size:13px}.cfl .pr select{max-width:340px;margin-left:6px;height:30px}.cfl table.kv td{padding:3px 10px 3px 0;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
.cfl .seg{display:inline-flex;align-items:center;flex-wrap:wrap;gap:2px;padding:3px;border-radius:10px;background:var(--field)}
.cfl .seg button{margin:0;height:28px;padding:0 12px;border-radius:7px;background:transparent;color:var(--muted)}
.cfl .seg button:hover:not(:disabled){background:rgba(255,255,255,.7);color:var(--ink)}
.cfl .seg button.on,.cfl .seg button.on:hover:not(:disabled){background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(42,44,50,.14)}
.cfl .seg.sm button{height:26px;padding:0 10px;font-size:12px}
.cfl .seg .cnt{display:inline-block;min-width:20px;margin-left:6px;padding:0 6px;border-radius:9px;background:var(--field2);color:var(--muted);font-size:11px;line-height:18px;text-align:center}
.cfl .seg button.on .cnt{background:var(--field)}.cfl .seg .cnt.bad{background:var(--err-bg);color:var(--err)}.cfl .seg .cnt.ok{background:var(--ok-bg);color:var(--ok)}
.cfl .need{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:10px;background:var(--red);color:#fff;font-size:11px;font-weight:700;vertical-align:1px}
.cfl td.mt.dim .v,.cfl td.mt.dim .bk{color:var(--faint);font-weight:400}
.cfl .is-busy [data-b="out"] button,.cfl .is-busy [data-b="ops"] button{pointer-events:none;opacity:.45}
.cfl .ctl-row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:14px 28px}
.cfl .ctl-row .acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto}.cfl .ctl-row .acts button{margin:0}
.cfl .fld .row{margin:0;gap:8px}
.cfl .tiles{display:grid;grid-template-columns:repeat(var(--n,5),minmax(0,1fr));gap:10px;margin:0 0 14px}
@media (max-width:1100px){.cfl .tiles{grid-template-columns:repeat(3,minmax(0,1fr))}}@media (max-width:620px){.cfl .tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
.cfl button.tile{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:2px;height:auto;margin:0;padding:12px 14px;border:1px solid var(--line);border-left:3px solid var(--line);border-radius:12px;background:#fff;text-align:left;white-space:normal;font-weight:400;color:var(--text)}
.cfl button.tile:hover:not(:disabled){background:#fff;border-color:#D5DBE1;box-shadow:0 2px 8px rgba(42,44,50,.07);color:var(--text)}
.cfl .tile .tt{font-size:12px;font-weight:600;color:var(--muted)}.cfl .tile .tv{font-size:22px;font-weight:700;color:var(--ink);line-height:1.2}.cfl .tile .ts{font-size:12px;color:var(--muted)}
.cfl .tile.t-ok{border-left-color:#2BB5A0}.cfl .tile.t-ok .tv{color:var(--ok)}.cfl .tile.t-bad{border-left-color:var(--red)}.cfl .tile.t-bad .tv{color:var(--err)}
.cfl .tile.t-warn{border-left-color:#F2A93B}.cfl .tile.t-warn .tv{color:var(--warn)}
.cfl .secnav{margin:0 0 12px}.cfl .secnav .seg button{height:32px;padding:0 14px;font-size:13px}
.cfl .sub-h{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 10px}.cfl .sub-h h3{margin:0}
.cfl .empty{padding:18px;border-radius:12px;background:var(--field);color:var(--muted);font-size:13px}
.cfl tr.rg td,.cfl tr.rg:hover td{background:var(--field);cursor:pointer;color:var(--ink);font-weight:600;padding:8px 10px;border-top:1px solid var(--line)}
.cfl tr.rg .tw{display:inline-block;width:16px;color:var(--muted);transition:transform .15s}.cfl tr.rg.open .tw{transform:rotate(90deg)}
.cfl tr.rg .gs{color:var(--muted);font-weight:400;margin-left:8px}.cfl tr.rg .rgall{margin-left:10px;padding:1px 9px;font-size:12px;font-weight:400}.cfl tr.shut{display:none}
.cfl .pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.cfl-host.short{min-height:0}.cfl-host.short .wrap{padding-bottom:0}
#cfl-appr{padding:0 20px 28px;background:#F4F6F8}
#cfl-appr #pogodzh-panel{position:relative;top:auto;right:auto;left:auto;bottom:auto;z-index:auto;width:auto;max-height:none;border:1px solid #ECEFF3;border-radius:12px;box-shadow:0 1px 2px rgba(42,44,50,.04)}
#cfl-appr #pogodzh-panel .pz-head{background:#fff;color:#1A1C1E;border-bottom:1px solid #ECEFF3;padding:12px 12px 12px 18px}
#cfl-appr #pogodzh-panel .pz-title{color:#1A1C1E}#cfl-appr #pogodzh-panel .pz-ver{color:#9CA3AF}
#cfl-appr #pogodzh-panel .pz-tag{background:#FFF2DE;color:#9A5B00}
#cfl-appr #pogodzh-panel .pz-ico{background:#F4F7F9;color:#55565B}#cfl-appr #pogodzh-panel .pz-ico:hover{background:#E8EDF1}
#cfl-appr #pogodzh-panel .pz-btn{font-family:"Open Sans",system-ui,sans-serif;font-weight:600}
#cfl-appr #pogodzh-panel .pz-btn.pz-primary{box-shadow:none}`;

  function mount(container, opts) {
    const rulesDoc = opts.rulesDoc, storage = opts.storage;
    const host = document.createElement('div');
    host.className = 'cfl cfl-host';
    container.appendChild(host);
    if (!document.getElementById('cfl-style')) { const st = document.createElement('style'); st.id = 'cfl-style'; st.textContent = CSS; document.head.appendChild(st); }
    else document.getElementById('cfl-style').textContent = CSS;

    /* Закриті місяці CRM (P&L → «Закриття періоду»; змінює їх лише Адмін): «закрито по РРРР-ММ» включно. Записи цих місяців
       не перевіряються: «Статті й проєкти» — лише довідка, «Звірка з банком» їх не звіряє, погодження з таким періодом ідуть
       у перший відкритий місяць. CRM не показує, які місяці закрито, тож межу лінтер запам'ятовує з першої відмови CRM
       (learn) або з позначки людини (вікно в шапці). Межа лише росте; зменшити — тим самим вікном. */
    const CLOSED_KEY = 'cfl_closed_through', closedSubs = [];
    let closedThrough = M.monthOf(LS.get(CLOSED_KEY, null));
    function setClosed(m, how) {
      closedThrough = M.monthOf(m);
      LS.set(CLOSED_KEY, closedThrough);
      updClosed();
      closedSubs.forEach(f => { try { f(closedThrough, how); } catch (e) {} });
    }
    const CL = {
      get: () => closedThrough,
      learn: m => { m = M.monthOf(m); if (m && (!closedThrough || m > closedThrough)) setClosed(m, 'crm'); },
      on: f => closedSubs.push(f),
    };
    /* Чернетки CRM (14.11.2026, core/drafts.js). Перемикач у шапці «нові записи — у кешфлоу / у чернетки»: увімкнений — «Погодження»
       і «Звірка з банком» створюють чернетки (їх потім проводить бухгалтер) і враховують чернетки у звірці та пошуку дублів;
       вимкнений — жодного запиту до чернеток, усе як раніше. Лише там, де панель може створювати записи (закладка APPLY). */
    const DRAFT_KEY = 'cfl_drafts', draftSubs = [];
    const canDraft = !!opts.applyAllowed && opts.drafts !== false && !!CFD && !!(opts.api && opts.api.post);
    let draftOn = canDraft && LS.get(DRAFT_KEY, false) === true;
    const DRF = canDraft ? Object.assign(CFD.make(opts.api, { on: () => draftOn }), { subscribe: f => draftSubs.push(f) }) : null;
    const linter = L.createLinter({ api: opts.api, rulesDoc, onProgress: onProgress, log: m => note(m), closedThrough: CL.get, onClosed: CL.learn });
    const compiled = linter.compiled;
    const articles = (rulesDoc.reference && rulesDoc.reference.articles) || [];
    const projects = Object.entries((rulesDoc.reference && rulesDoc.reference.projects) || {});
    const fixFrom = linter.fixFrom; // межа роботи з rules.json (раніші записи — лише довідка)
    const saved = LS.get('cfl_params', {});
    let RUN = null, GROUPS = [], editMode = false, applyDone = false, busy = false, groupFilter = null;
    let filter = new Set(['fix', 'review', 'manual-422', 'locked-auto', 'locked-date']);
    // вибір: id → Set полів ('category' / 'project'); нічого не позначається заздалегідь
    const selected = new Map(), manual = {};
    const B = opts.bankTab === false ? null : bankModule();
    const A = opts.apprTab === false ? null : apprModule();
    // корп. картки, запам'ятані «Звіркою з банком» у цьому браузері (нових ще немає в rules.json), — у довідник для всіх вкладок
    if (B && B.mergeLocalCards) B.mergeLocalCards(rulesDoc);
    // права на кешфлоу (з 29.10.2026 статтю, проєкт і тип змінює лише роль з правом «Повне редагування операцій Cash Flow»);
    // null — не вдалося перевірити: тоді нічого не блокуємо, відмову покаже сам CRM
    let rights = null;
    const rightsReady = opts.userId ? opts.api.get('user/' + encodeURIComponent(opts.userId)).then(M.cashflowRights).catch(() => null) : Promise.resolve(null);
    const noFull = () => !!(rights && !rights.full);

    host.innerHTML = `
<div class="hdr"><div class="top"><div><h2>${esc(opts.title || 'Лінтер кешфлоу')}</h2>
 <div class="meta">Правила ${esc(rulesDoc.version || '?')} · ${compiled.rules.length} правил${fixFrom ? ` · зміни лише для записів з ${esc(dmy(fixFrom))}` : ''} · <span data-r="closed"></span>${canDraft ? ' · <span data-r="drafts"></span>' : ''}${compiled.errors.length ? ` · <span class="bad">помилок у rules.json: ${compiled.errors.length}</span>` : ''} · <span data-r="build"></span></div></div>
 <div class="row" style="margin:0"><span class="mode view" data-r="mode">ПЕРЕГЛЯД</span>${opts.onMinimize ? '<button class="x" data-a="min" title="Згорнути — стан і результати збережуться"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 10.5h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' : ''}${opts.onClose ? '<button class="x" data-a="close" title="Закрити">✕</button>' : ''}</div></div>
${A || B ? `<div class="tabs">${A ? '<span data-tab="appr">Погодження</span>' : ''}${B ? '<span data-tab="bank">Звірка з банком</span>' : ''}<span data-tab="cat">Статті й проєкти</span></div>` : ''}</div>
<div class="wrap" data-pane="cat">
${compiled.errors.length ? `<div class="err">${esc(compiled.errors.join('\n'))}</div>` : ''}
<div class="card">
 <h3>Перевірка</h3>
 <div class="fld"><div class="lbl">Період · дата запису за Києвом, включно</div><div class="row"><input type="date" data-r="from"><span class="muted">—</span><input type="date" data-r="to">
  <span class="seg sm"><button type="button" data-r="p-t">Сьогодні</button><button type="button" data-r="p-y">Вчора</button><button type="button" data-r="p-m">Цей місяць</button>${fixFrom ? `<button type="button" data-r="p-f">З ${esc(dmy(fixFrom))}</button>` : ''}</span></div></div>
 <div class="row" style="align-items:flex-start;gap:12px 16px">
  <details><summary>Рахунки: <b data-r="accs-sum">усі</b></summary><div class="lst" data-r="accs"><span class="muted">завантажаться під час першої перевірки…</span></div>
   <button data-a="acc-load">Завантажити список рахунків</button> <span class="muted">нічого не позначено — усі рахунки</span></details>
  <details><summary>Правила: <b data-r="rules-sum">усі (${compiled.rules.length})</b></summary><label style="display:block;margin-top:6px"><input type="checkbox" data-r="rall" checked> усі</label><div class="lst" data-r="rules">${compiled.rules.map(r =>
    `<label title="${esc(r.title)}"><input type="checkbox" value="${esc(r.id)}" checked> ${esc(r.id)} — ${esc(r.title)}</label>`).join('')}</div></details>
 </div>
 <div class="row" style="margin-top:10px">
  <button class="primary" data-a="run">Перевірити (без змін)</button>
  <button data-a="xlsx" disabled>Звіт Excel</button><button data-a="csv" disabled>Звіт CSV</button>
  <span data-r="st" class="muted"></span>
 </div>
</div>
<div class="card">
 <h3>Зміни в CRM</h3>
 <div class="row">
  <label${opts.applyAllowed ? '' : ' title="Змінювати записи можна в закладці «Лінтер кешфлоу (APPLY)»"'}><input type="checkbox" data-r="edit"${opts.applyAllowed ? '' : ' disabled'}> Режим редагування</label>
 </div>
 <div class="row">
  <button data-a="selfix" disabled title="Масова зміна: позначити всі зміни рядків «виправити» (рядки «перевірити» позначаються лише вручну)">Позначити всі «виправити»</button>
  <button data-a="selnone" disabled>Зняти позначки</button>
  <button class="danger" data-a="apply" disabled>Застосувати вибране (0)</button>
  <button data-a="rollback"${opts.applyAllowed ? '' : ' disabled'}>Відкат з резервної копії…</button>
 </div>
 <div class="muted" data-r="sel-info">Нічого не позначено заздалегідь: зміни вибираєте ви — галочкою групи, рядка або окремо статтю й проєкт.</div>
 <div class="warn" data-r="rights" hidden></div>
</div>
<div data-r="notes"></div>
<div data-r="groups"></div>
<div data-r="out"></div>
</div>${A ? '<div class="wrap" data-pane="appr" hidden></div>' : ''}${B ? '<div class="wrap" data-pane="bank" hidden></div>' : ''}`;
    const $ = s => host.querySelector(`[data-r="${s}"]`);
    const btn = a => host.querySelector(`[data-a="${a}"]`);
    // яка збірка відкрита: закладка бере новішу з копії в браузері й файлу запущеного «Помічника кешфлоу» — без Помічника лишається
    // збережена копія (30.10.2026 так непомітно працювала збірка без кількох останніх оновлень); якщо в Помічнику новіша — сказати
    (async () => {
      const box = $('build');
      if (!box || typeof CF_BUILD !== 'string') return;
      const when = s => new Date(s).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      box.textContent = `збірка ${when(CF_BUILD)}`;
      let info = null;
      try {
        const ac = new AbortController(), t = setTimeout(() => ac.abort(), 2000);
        const r = await fetch(String(LS.get('cfl_helper_url', 'http://127.0.0.1:8765')).replace(/\/+$/, '') + '/api/panel/bank/status', { cache: 'no-store', signal: ac.signal });
        clearTimeout(t);
        info = r.ok ? await r.json() : null;
      } catch (e) {}
      if (!info) {
        box.insertAdjacentHTML('beforeend', ' <span title="Новіші збірки закладка бере лише із запущеного «Помічника кешфлоу»: запустіть його й натисніть закладку ще раз.">(Помічник не запущено — це копія з браузера)</span>');
      } else if (info.linter && info.linter > CF_BUILD) {
        box.insertAdjacentHTML('beforeend', ` <span class="need" title="Закрийте панель (✕) і натисніть закладку ще раз — завантажиться новіша">є новіша від ${esc(when(info.linter))} — натисніть закладку ще раз</span>`);
      }
    })();
    // період за замовчуванням — сьогодні (попередній період не відновлюється); швидкі періоди — сегментований перемикач поруч з датами,
    // у ньому позначено той, що збігається з вибраними датами
    const yday = () => new Date(Date.parse(today() + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
    // «з …» — з межі роботи, а якщо в CRM уже закрито пізніші місяці — з першого відкритого
    function floorDay() { return [fixFrom, M.openFrom(closedThrough)].filter(Boolean).sort().pop() || null; }
    function updQuick() {
      const f = $('from').value, t = $('to').value, d = today(), y = yday();
      const on = { 'p-t': f === d && t === d, 'p-y': f === y && t === y, 'p-m': f === d.slice(0, 8) + '01' && t === d && f !== d, 'p-f': !!floorDay() && f === floorDay() && t === d };
      Object.entries(on).forEach(([k, v]) => { if ($(k)) $(k).classList.toggle('on', v); });
    }
    const setPeriod = (f, t) => { $('from').value = f; $('to').value = t; updQuick(); };
    // сьогодні, або період, з яким сьогодні вже працювали (тут чи у «Звірці з банком»)
    let periodSeen = null;
    { const sp = sharedPeriod(); if (sp) periodSeen = sp.n; setPeriod(sp ? sp.from : today(), sp ? sp.to : today()); }
    // вкладку показали знову: період, звірений тим часом у «Звірці з банком», — у поля дат; перевірку запускає людина
    function syncPeriod() {
      const v = sharedPeriod();
      if (!v || v.n === periodSeen || busy) return;
      periodSeen = v.n;
      if (v.by === 'cat' || ($('from').value === v.from && $('to').value === v.to)) return;
      setPeriod(v.from, v.to);
      st(`період ${dmy(v.from)}–${dmy(v.to)} — як у «Звірці з банком»`);
    }
    ['from', 'to'].forEach(k => $(k).addEventListener('change', updQuick));
    $('p-t').onclick = () => setPeriod(today(), today());
    $('p-y').onclick = () => { const y = yday(); setPeriod(y, y); };
    $('p-m').onclick = () => setPeriod(today().slice(0, 8) + '01', today());
    if ($('p-f')) $('p-f').onclick = () => { if (floorDay()) setPeriod(floorDay(), today()); };
    // шапка: закриті місяці CRM і вікно, де їх відмітити чи виправити
    function updClosed() {
      const box = $('closed');
      if (!box) return;
      box.innerHTML = closedThrough ? `закрито в CRM по ${esc(M.monthUa(closedThrough))} — не перевіряється · <span class="lnk" data-r="closed-edit">змінити</span>`
        : 'закриті місяці CRM: <span class="lnk" data-r="closed-edit">не відмічено</span>';
      box.querySelector('[data-r="closed-edit"]').onclick = editClosed;
      if ($('p-f') && floorDay()) { $('p-f').textContent = `З ${dmy(floorDay())}`; updQuick(); }
    }
    async function editClosed() {
      const cur = today().slice(0, 7), yearAgo = `${+cur.slice(0, 4) - 1}-${cur.slice(5)}`;
      let m = [M.monthOf(fixFrom), closedThrough].filter(Boolean).sort()[0] || yearAgo; // місяці — від межі роботи до поточного
      const months = [];
      for (; m <= cur; m = M.openFrom(m).slice(0, 7)) months.push(m);
      const name = x => new Date(Date.UTC(+x.slice(0, 4), +x.slice(5) - 1, 15)).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const v = await dialog(`<h3>Закриті місяці в CRM</h3>
<p>Закритий місяць (P&amp;L → «Закриття періоду») змінює лише Адмін, тож лінтер його не перевіряє: «Статті й проєкти» показують такі записи лише для довідки, «Звірка з банком» ці місяці не звіряє, а погодження з періодом закритого місяця вносяться в перший відкритий місяць.</p>
<p>Які місяці закрито, CRM не показує. Лінтер запам'ятовує це сам, щойно CRM відмовить через закритий місяць, а тут можна відмітити заздалегідь або виправити.</p>
<p>Закрито по (включно): <select data-cm><option value="">— жоден місяць не закрито —</option>${months.map(x => `<option value="${x}"${x === closedThrough ? ' selected' : ''}>${esc(name(x))}</option>`).join('')}</select></p>`, 'Зберегти', false, 'Скасувати', bg => bg.querySelector('[data-cm]').value);
      if (v) setClosed(v.value || null, 'manual');
    }
    CL.on((m, how) => {
      if (how === 'crm') note(`CRM відмовив через закритий місяць: лінтер запам'ятав «закрито по ${M.monthUa(m)}» — ці місяці більше не перевіряються (змінити — у шапці панелі).`, 'info');
      if (!RUN || busy) return;
      // нова межа одразу діє на показаний результат: записи закритих місяців — лише довідка, позначки з них знімаються
      RUN.results = linter.evaluateAll(RUN.results.map(r => r.raw), RUN.params.ruleIds).results;
      GROUPS = groupsOf(RUN);
      for (const id of [...selected.keys()]) { const r = resById(id); if (!r || r.status === L.LOCKED_DATE) { selected.delete(id); delete manual[id]; } }
      render();
    });
    updClosed();
    // шапка: куди панель створює нові записи — у кешфлоу чи в чернетки CRM
    function updDrafts() {
      const box = $('drafts');
      if (!box) return;
      box.innerHTML = draftOn ? 'нові записи — <b>у чернетки CRM</b> · <span class="lnk" data-r="drafts-edit">змінити</span>'
        : 'нові записи — у кешфлоу · <span class="lnk" data-r="drafts-edit">у чернетки</span>';
      box.querySelector('[data-r="drafts-edit"]').onclick = editDrafts;
    }
    async function editDrafts() {
      if (busy || host.dataset.busy === '1') { await dialog('<h3>Панель саме працює</h3><p>Змініть режим після того, як вона закінчить.</p>', 'Зрозуміло', false, 'Закрити'); return; }
      if (globalThis.CF_REGISTRY_BUSY) { await dialog('<h3>Реєстр саме працює</h3><p>«Погодження» зараз перевіряють або вносять рядки. Дочекайтеся завершення й змініть режим після цього — інакше частина пакета піде в кешфлоу, а частина в чернетки.</p>', 'Зрозуміло', false, 'Закрити'); return; }
      const ok = await dialog(draftOn ? `<h3>Створювати записи одразу в кешфлоу</h3>
<p>Зараз «Погодження» і «Звірка з банком» створюють <b>чернетки</b>. Після вимкнення нові записи знову йтимуть одразу в кешфлоу, а чернетки лінтер більше не читатиме.</p>
<p><b>Увага:</b> чернетки, які ще не провели, лишаться в CRM. Операцію, для якої вже є непроведена чернетка, лінтер запропонує внести знову — щоб не було дубля, спершу проведіть або видаліть чернетки («CashFlow» → «Чернетки»).</p>`
        : `<h3>Створювати записи в чернетках</h3>
<p>Усе, що створюють «Погодження» і «Звірка з банком», піде не в кешфлоу, а в <b>чернетки CRM</b> («CashFlow» → «Чернетки»). У кешфлоу й залишки рахунків запис потрапить, коли чернетку проведе бухгалтер.</p>
<p>Щоб нічого не внести вдруге, чернетки враховуються у звірці з банком і в пошуку дублів так само, як записи; залишки CRM у звірці показуються так, ніби чернетки вже проведено.</p>
<p>Виправлення наявних записів («Виправити», «Статті й проєкти») і далі змінюють сам кешфлоу; чернеток лінтер не змінює й не видаляє.</p>`,
        draftOn ? 'Так, одразу в кешфлоу' : 'Так, у чернетки', false, 'Скасувати');
      if (!ok) return;
      draftOn = !draftOn;
      LS.set(DRAFT_KEY, draftOn);
      updDrafts();
      draftSubs.forEach(f => { try { f(draftOn); } catch (e) {} });
    }
    updDrafts();
    // режим змінили в іншій вкладці браузера з панеллю — тут він має бути той самий (інакше одна вкладка писала б у кешфлоу, інша — в чернетки)
    if (canDraft && typeof window !== 'undefined' && window.addEventListener) window.addEventListener('storage', e => {
      if (e.key !== DRAFT_KEY) return;
      const v = LS.get(DRAFT_KEY, false) === true;
      if (v === draftOn) return;
      draftOn = v;
      updDrafts();
      draftSubs.forEach(f => { try { f(draftOn); } catch (x) {} });
    });
    // вибір правил пам'ятається лише для тієї самої версії rules.json, інакше нові правила лишилися б вимкненими
    if (Array.isArray(saved.rules) && saved.rules.length && saved.rulesVersion === rulesDoc.version) {
      host.querySelectorAll('[data-r="rules"] input').forEach(i => { i.checked = saved.rules.includes(i.value); });
      $('rall').checked = saved.rules.length === compiled.rules.length;
    }

    // вкладки за порядком роботи: «Погодження» (реєстр) → «Звірка з банком» (лише читання) → «Статті й проєкти» (лінтер);
    // кожна монтується при першому відкритті. Панель реєстру — поза .cfl (у контейнері поруч), щоб стилі лінтера її не чіпали.
    const apprBox = A ? document.createElement('div') : null;
    if (apprBox) { apprBox.id = 'cfl-appr'; apprBox.hidden = true; container.appendChild(apprBox); }
    let bankMounted = false, apprMounted = false, bankPanel = null;
    function showTab(t) {
      host.querySelectorAll('.tabs [data-tab]').forEach(e => e.classList.toggle('on', e.dataset.tab === t));
      host.querySelectorAll('[data-pane]').forEach(e => { e.hidden = e.dataset.pane !== t; });
      if (apprBox) apprBox.hidden = t !== 'appr';
      host.classList.toggle('short', t === 'appr');
      $('mode').style.visibility = t === 'cat' ? '' : 'hidden'; // режим редагування стосується лише статей і проєктів
      // спільний період: вкладка, яку показали, бере період, з яким щойно працювали в іншій (лише поля дат)
      if (t === 'cat') syncPeriod();
      if (t === 'bank' && bankPanel && bankPanel.syncPeriod) bankPanel.syncPeriod();
      if (t === 'bank' && !bankMounted) { bankMounted = true; bankPanel = B.mount(host.querySelector('[data-pane="bank"]'), { api: opts.api, storage, applyAllowed: !!opts.applyAllowed, dialog, projects: rulesDoc.reference && rulesDoc.reference.projects,
        rulesDoc, rights: rightsReady, closed: CL, drafts: DRF, setBusy: on => { host.dataset.busy = on ? '1' : ''; }, lintPeriod: checkPeriod, go: showTab, aiMatch: opts.aiMatch, aiHints: opts.ai }); }
      if (t === 'appr' && !apprMounted) { apprMounted = true; A.mount(host.querySelector('[data-pane="appr"]'), apprBox, { live: !!opts.applyAllowed, rulesDoc, api: opts.api, closed: CL, drafts: DRF }); }
      LS.set('cfl_tab', t);
    }
    if (A || B) {
      host.querySelectorAll('.tabs [data-tab]').forEach(e => e.onclick = () => showTab(e.dataset.tab));
      const have = { appr: !!A, bank: !!B, cat: true }, saved = LS.get('cfl_tab', null);
      showTab(have[saved] ? saved : A ? 'appr' : 'bank');
    }

    function st(t) { $('st').textContent = t; }
    function note(t, cls) { $('notes').insertAdjacentHTML('beforeend', `<div class="${cls || 'warn'}">${esc(t)}</div>`); }
    function onProgress(p) {
      if (p.stage === 'read') st(`отримано ${p.got} із ${p.total == null ? '?' : p.total} (сторінка ${p.page}/${p.lastPage || '?'})`);
      else if (p.stage === 'backup') st(`резервна копія: ${p.done} із ${p.total}`);
      else if (p.stage === 'apply') st(`застосовано ${p.done} із ${p.total}`);
    }
    if (opts.onClose) btn('close').onclick = opts.onClose;
    if (opts.onMinimize) btn('min').onclick = opts.onMinimize;

    function updSums() {
      const rl = [...host.querySelectorAll('[data-r="rules"] input')], rc = rl.filter(i => i.checked).length;
      $('rules-sum').textContent = rc === rl.length ? `усі (${rl.length})` : `вибрано ${rc} з ${rl.length}`;
      $('rall').checked = rc === rl.length;
      const ac = host.querySelectorAll('[data-r="accs"] input:checked').length;
      $('accs-sum').textContent = ac ? `вибрано ${ac}` : 'усі';
    }
    $('rall').onchange = () => { host.querySelectorAll('[data-r="rules"] input').forEach(i => { i.checked = $('rall').checked; }); updSums(); };
    $('rules').onchange = updSums;
    $('accs').onchange = updSums;
    updSums();
    async function loadAccounts() {
      if (!linter.live) {
        st('завантажую довідники CRM…');
        const { problems } = await linter.loadReference();
        if (problems.length) note('Довідник статей у CRM не збігається з rules.json:\n' + problems.join('\n'), 'err');
        st('');
      }
      const keep = new Set((saved.accounts || []).map(Number));
      $('accs').innerHTML = (linter.live.accounts || []).filter(a => !a.deleted_at).map(a =>
        `<label><input type="checkbox" value="${a.id}"${keep.has(a.id) ? ' checked' : ''}> ${esc(a.name)} <span class="muted">(id ${a.id})</span></label>`).join('');
      updSums();
    }
    btn('acc-load').onclick = () => loadAccounts().catch(e => note(e.message, 'err'));

    function setEdit(on) {
      editMode = on;
      $('edit').checked = on;
      $('mode').className = 'mode ' + (editMode ? 'edit' : 'view');
      $('mode').textContent = editMode ? 'РЕДАГУВАННЯ' : 'ПЕРЕГЛЯД';
      render();
    }
    async function requestEdit() {
      if (!opts.applyAllowed) return false;
      if (editMode) return true;
      const ok = await dialog('<h3>Увімкнути режим редагування?</h3><p>Зміни в CRM відбуваються лише після резервної копії і вашого окремого підтвердження. Змінюються тільки стаття і проєкт.</p>', 'Увімкнути', true);
      setEdit(ok);
      return ok;
    }
    $('edit').onchange = async () => {
      if (!$('edit').checked) { setEdit(false); return; }
      $('edit').checked = false;
      await requestEdit();
    };
    function setBusy(on) {
      busy = on;
      host.dataset.busy = on ? '1' : '';
      btn('run').disabled = on;
      btn('rollback').disabled = on || !opts.applyAllowed || noFull();
      updApply();
    }
    rightsReady.then(r => {
      rights = r;
      if (!noFull()) return;
      $('rights').textContent = M.noFullText(rights) + ' Перевірка й звіт працюють; застосувати зміни й відкат не вийде.';
      $('rights').hidden = false;
      btn('rollback').disabled = true;
      updApply();
    });
    if (opts.applyAllowed && opts.startInEdit) { $('edit').checked = true; editMode = true; $('mode').className = 'mode edit'; $('mode').textContent = 'РЕДАГУВАННЯ'; }

    // перевірка за період з полів вкладки (рахунки й правила — як вибрано) → true, якщо вдалася
    async function runCheck() {
      const from = $('from').value, to = $('to').value;
      $('notes').innerHTML = '';
      if (!from || !to || from > to) { note('Перевірте період: дата «з» має бути не пізніше дати «по».', 'err'); return false; }
      const ruleIds = [...host.querySelectorAll('[data-r="rules"] input:checked')].map(i => i.value);
      if (!ruleIds.length) { note('Не вибрано жодного правила.', 'err'); return false; }
      const accountIds = [...host.querySelectorAll('[data-r="accs"] input:checked')].map(i => Number(i.value));
      LS.set('cfl_params', { from, to, rules: ruleIds, accounts: accountIds, rulesVersion: rulesDoc.version });
      periodSeen = savePeriod(from, to, 'cat').n; // період, який справді перевіряють, — спільний зі «Звіркою з банком»
      btn('run').disabled = true; $('notes').innerHTML = ''; $('out').innerHTML = ''; $('groups').innerHTML = '';
      selected.clear(); for (const k of Object.keys(manual)) delete manual[k];
      applyDone = false; groupFilter = null; HINTS = null; hintRes.clear(); aiReset();
      try {
        if (!linter.live) await loadAccounts();
        RUN = await linter.run({ from, to, accountIds, ruleIds: ruleIds.length === compiled.rules.length ? null : ruleIds });
        GROUPS = groupsOf(RUN);
        // нічого не позначається заздалегідь: зміни вибирає людина (або кнопкою «Позначити всі fix»)
        st(`готово: перевірено ${nRec(RUN.checked)}, спрацювали правила для ${RUN.results.length}`);
        btn('xlsx').disabled = btn('csv').disabled = false;
        render();
        aiAsk(false); // «Підказки ШІ» для записів без правил — у фоні, через Помічник
        return true;
      } catch (e) { note(e.message, 'err'); st('помилка'); return false; }
      finally { btn('run').disabled = false; }
    }
    btn('run').onclick = () => runCheck();
    /* «Закриття місяця» («Звірка з банком»): та сама перевірка за місяць — усі рахунки й усі правила; результат лишається в цій
       вкладці (видно, які записи виправити). → {checked, counts: {fix, review, 'manual-422', …}} */
    async function checkPeriod(from, to) {
      if (busy || btn('run').disabled) throw new Error('«Статті й проєкти» зараз зайняті — перевірте місяць ще раз за хвилину');
      /* У вкладці є позначені, але ще не застосовані зміни (галочки, ✎, узяті підказки): нова перевірка стерла б їх без запитання.
         Місяць тоді рахується окремо — показаний результат, позначки, період і вибір рахунків лишаються як були (16.11.2026). */
      if (hasPendingWork({ editMode, applyDone, selected: selected.size, manual: Object.keys(manual).length })) {
        const was = $('st').textContent;
        btn('run').disabled = true;
        try {
          if (!linter.live) await loadAccounts();
          const run = await linter.run({ from, to, accountIds: [], ruleIds: null });
          note(`«Закриття місяця» перевірило ${dmy(from)}–${dmy(to)} окремо: позначені тут зміни не зачеплено. Щоб побачити записи місяця тут — застосуйте зміни або зніміть позначки й натисніть «Перевірити».`, 'info');
          return { checked: run.checked, counts: countsOf(run) };
        } finally { btn('run').disabled = busy; st(was); }
      }
      setPeriod(from, to);
      host.querySelectorAll('[data-r="rules"] input').forEach(i => { i.checked = true; });
      host.querySelectorAll('[data-r="accs"] input').forEach(i => { i.checked = false; });
      updSums();
      if (!(await runCheck())) throw new Error(($('notes').textContent || 'перевірку не виконано').trim().slice(0, 300));
      return { checked: RUN.checked, counts: countsOf(RUN) };
    }

    // ---------- «Лишити як є» ----------
    /* Рядок перевірено свідомо — лишити як є (у CRM нічого не змінюється). Пам'ятається в цьому браузері з відбитком запису (тип,
       стаття, проєкт, сума, коментар, статус і правила): якщо запис змінять, рядок повернеться. Такі рядки не позначаються
       масово, не входять у групи змін і не рахуються в «Закритті місяця» як незроблене. */
    const KEEP = 'cfl_lint_keep', KEEPABLE = new Set(['fix', 'review', 'manual-422']);
    let keepMap = LS.get(KEEP, {});
    const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
    const keepFp = r => { const x = r.record; return hash(JSON.stringify([x.type, x.category_id, x.operation_id, x.project_id, x.amount, x.comment, r.status, r.applicable.map(a => a.id).sort()])); };
    const keptAt = r => { const k = KEEPABLE.has(r.status) && keepMap[r.record.id]; return k && k.fp === keepFp(r) ? k.at : null; };
    const stOf = r => (keptAt(r) ? 'kept' : r.status);
    const countsOf = run => { const c = {}; for (const r of run.results) { const s = stOf(r); c[s] = (c[s] || 0) + 1; } return c; };
    function setKeep(id, on) {
      const r = resById(id);
      if (!r) return;
      keepMap = LS.get(KEEP, {});
      if (on) { keepMap[id] = { fp: keepFp(r), at: today() }; setRow(r, false); } else delete keepMap[id];
      LS.set(KEEP, keepMap);
      GROUPS = groupsOf(RUN);
      render();
    }

    // ---------- «Підказки з історії» ----------
    /* Записи, яких не покриває жодне правило (RUN.rest): стаття інша, ніж зазвичай у того самого отримувача за період і
       HIST_DAYS днів до нього (L.historyHints). Шукаються лише на кнопку — історію треба дочитати з CRM. Лише підказка: стаття
       змінюється тільки після «Взяти статтю» чи ✎ і «Застосувати вибране» — як ручна правка. */
    const HIST_DAYS = 120;
    let HINTS = null; // null — не шукали; 'busy'; {list, n, err}
    const hintRes = new Map(); // id → псевдо-результат запису з підказкою (з історії чи ШІ): для ✎, «Взяти…» і плану змін
    const pseudoRes = rec => ({ record: rec, status: 'hint', changes: [], applicable: [], perRule: {}, reasons: [], fields: {} });
    const dayShift = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    async function findHints() {
      if (!RUN || HINTS === 'busy') return;
      const run = RUN;
      HINTS = 'busy';
      render();
      let out;
      try {
        // усі рахунки, період і HIST_DAYS днів до нього: отримувача могли оплачувати з іншого рахунку
        const raws = await linter.fetchRecords(dayShift(run.params.from, -HIST_DAYS), run.params.to);
        const past = raws.filter(x => !x.deleted_at).map(x => M.normalizeRecord(x, linter.live));
        out = { list: L.historyHints(run.rest || [], past), n: (run.rest || []).length };
        st(`підказки: прочитано ${nRec(raws.length)} історії, підказок ${out.list.length}`);
      } catch (e) { out = { list: [], n: (run.rest || []).length, err: e.message }; st('помилка'); }
      if (run !== RUN) return; // поки читали історію, запустили нову перевірку
      // попередні підказки з історії — геть, крім записів з уже вибраною зміною; записи «Підказок ШІ» лишаються
      for (const [id, r] of [...hintRes]) if (r.hint && !manual[id]) hintRes.delete(id);
      for (const x of out.list) hintRes.set(x.rec.id, { ...pseudoRes(x.rec), hint: x });
      HINTS = out;
      render();
    }
    // статтю можна взяти, якщо вона є в довіднику rules.json і не з маркетологом / не зарплатна (як у ✎)
    const artOk = art => {
      const [c, o] = art.split(':').map(Number), lv = linter.live || {};
      return articles.some(a => a.category_id === c && a.operation_id === o) && !(lv.marketerArts && lv.marketerArts.has(c + '/' + o)) &&
        !(lv.salaryOps && lv.salaryOps.has(o)) && c !== (lv.salaryCategoryId || 21);
    };
    // запис ЗАРАЗ у статті з маркетологом: статтю міняють лише в CRM (як у правилах — rules-engine), проєкт можна (07.11.2026)
    const inMarketerArt = rec => !!(linter.live && linter.live.marketerArts && linter.live.marketerArts.has(`${rec.category_id}/${rec.operation_id}`));
    const MK_NOTE = 'запис у статті з маркетологом — змінюють у CRM';
    function takeHint(id) {
      const r = hintRes.get(id);
      if (!r || !artOk(r.hint.art) || inMarketerArt(r.record)) return;
      const [c, o] = r.hint.art.split(':').map(Number), rec = r.record;
      manual[id] = [{ field: 'category', from: { category_id: rec.category_id, operation_id: rec.operation_id }, to: { category_id: c, operation_id: o }, toLabel: r.hint.label }];
      selected.set(id, new Set(['category']));
      render();
    }
    function hintsHtml() {
      const n = (RUN.rest || []).length;
      let h = '<div class="card"><div class="row" style="justify-content:space-between;align-items:center;margin:0 0 6px"><h3 style="margin:0">Підказки з історії <span class="muted" style="font-weight:400">· не правила</span></h3>';
      if (HINTS === null) {
        return h + `<button data-hints="1"${n ? '' : ' disabled'}>Знайти підказки</button></div><div class="muted">${n ? `Записів, яких не покриває жодне правило: ${n}. Підказка — коли стаття запису інша, ніж у більшості (від 75 %, щонайменше 4) схожих записів того самого отримувача за період і ${HIST_DAYS} днів до нього. Історію буде дочитано з CRM; нічого не змінюється.` : 'Записів, яких не покриває жодне правило, немає — підказувати нічого.'}</div></div>`;
      }
      if (HINTS === 'busy') return h + `<button disabled>Шукаю…</button></div><div class="muted">Читаю з CRM історію за ${HIST_DAYS} днів до періоду…</div></div>`;
      h += '<button data-hints="1" class="quiet">Шукати ще раз</button></div>';
      if (HINTS.err) return h + `<div class="err">Не вдалося дочитати історію з CRM: ${esc(HINTS.err)}</div></div>`;
      if (!HINTS.list.length) return h + `<div class="good">✓ Записів без правил: ${HINTS.n} — розбіжностей з історією немає.</div></div>`;
      h += `<div class="muted" style="margin:0 0 8px">Записів без правил: ${HINTS.n}; стаття інша, ніж зазвичай: ${HINTS.list.length}. ${editMode ? '«Взяти статтю» додає зміну до вибраного (як ✎); у CRM — лише після «Застосувати вибране».' : 'Щоб узяти статтю, увімкніть режим редагування.'}</div>`;
      h += `<div class="tbl"><table class="recs"><colgroup><col style="width:92px"><col style="width:130px"><col style="width:120px"><col><col style="width:290px"><col style="width:260px"></colgroup>
<tr><th>ID · дата</th><th>Рахунок</th><th>Сума</th><th>Коментар</th><th>Стаття: зараз → звична</th><th>Чому</th></tr>`;
      for (const x of HINTS.list) {
        const rec = x.rec, id = rec.id, own = manual[id], ci = rec.comment.indexOf(':'), who = ci > 2 && ci < 80 ? rec.comment.slice(0, ci).trim() : x.key;
        const act = !editMode ? '' : `<div class="row" style="margin:6px 0 0;gap:6px">${own ? `<span class="lnk" data-hdrop="${id}" title="Прибрати цю зміну з вибраного">прибрати зміну</span>`
          : inMarketerArt(rec) ? `<span class="muted">${MK_NOTE}</span>` : artOk(x.art) ? `<button class="quiet" data-take="${id}" title="Додати до вибраного зміну статті на «${esc(x.label)}»" style="height:24px;padding:0 8px;margin:0;font-size:12px">Взяти статтю</button>` : '<span class="muted">цю статтю змінюють у CRM</span>'}<button data-ed="${id}" title="Своя стаття чи проєкт" style="height:24px;padding:0 8px;margin:0">✎</button></div>`;
        h += `<tr data-id="${id}"><td><span class="id">${id}</span><br><span class="muted">${esc(dmy(rec.date))}</span></td>
<td class="acc">${esc(rec.account_names.join(' → '))}</td><td class="n">${fmt(rec.amount)} ${esc(rec.currency)}</td><td><div class="cmt" title="${esc(rec.comment)}">${esc(rec.comment)}</div></td>
<td><div class="chg"><span class="f">стаття</span><span><span class="from">${esc(rec.category_label || '—')}</span> → <span class="to">${esc(x.label)}</span></span></div>${own ? `<div class="chg"><span class="f">вручну</span><span class="to">${esc(own.map(c => c.toLabel).join('; '))}</span></div>` : ''}</td>
<td>${x.k} із ${x.n} ${plural(x.n, 'схожого запису', 'схожих записів', 'схожих записів')} «${esc(who)}» — з цією статтею<div class="rules">напр. ID ${x.ex.join(', ')}</div>${act}</td></tr>`;
      }
      return h + '</table></div></div>';
    }

    // ---------- «Підказки ШІ» (щоденна модель через «Помічник кешфлоу», з 03.11.2026; з 05.11.2026 — Claude Sonnet 5.5) ----------
    /* Ті самі записи без правил (RUN.rest) — у Claude через Помічник: ключ API лише в ньому, панель лише передає записи (opts.ai).
       Питаємо самі після кожної перевірки. Помічник пам'ятає відповіді, тож у Claude йдуть лише нові записи; поки він думає —
       перепитуємо кожні AI_POLL мс. Лише підказка: стаття чи проєкт змінюються тільки після «Взяти…» чи ✎ і «Застосувати
       вибране» — як ручна правка. */
    const AI_POLL = 3000, AI_CONF = { 'висока': 0, 'середня': 1, 'низька': 2 }, AI_CLS = { 'висока': 'st-ok', 'середня': 'st-review', 'низька': 'st-locked' };
    let AI = null, aiTimer = null, aiSeq = 0; // AI: null — не питали; {state, results, pending, failed, error, usage, model}
    const artCode = a => `${a.category_id}:${a.operation_id}`;
    const artName = a => a.group + ' / ' + (a.category === a.name ? a.name : a.category + ' / ' + a.name);
    const artByCode = new Map(articles.map(a => [artCode(a), a]));
    const projId = name => ((rulesDoc.reference && rulesDoc.reference.projects) || {})[name];
    const usd = x => '$' + NF2.format(Number(x) || 0);
    function aiReset() { clearTimeout(aiTimer); aiSeq++; AI = null; }
    async function aiAsk(retry) {
      clearTimeout(aiTimer);
      if (!opts.ai || !RUN || !(RUN.rest || []).length) return;
      const run = RUN, seq = ++aiSeq;
      if (!AI) { AI = { state: 'wait' }; renderAi(); }
      let j;
      try { j = await opts.ai({ records: L.aiRecords(run.rest, run.results.map(r => r.record)), retry: !!retry }); }
      catch (e) { j = { state: 'nohelper', error: e.message }; }
      if (run !== RUN || seq !== aiSeq) return; // поки чекали, запустили нову перевірку
      AI = j && j.state ? j : { state: 'nohelper' };
      renderAi();
      // відповіді, уже відправлені в Claude, доходять за будь-якого стану (ліміт на сьогодні настав посеред пакета, колега витратив свою
      // частку, ШІ вимкнули): опитувати, доки щось думає, — Помічник сам знімає з черги решту, і pending стає 0
      if (AI.pending) aiTimer = setTimeout(() => aiAsk(false), AI_POLL);
    }
    // стаття з маркетологом чи зарплатна — і цільова, і поточна — змінюється лише в CRM
    // … і тип статті має збігатися з типом запису: дохідну статтю на витрату ШІ підказати не може (як у ✎ і в «Звірці з банком»)
    const aiArtOk = (rec, code) => artOk(code) && !inMarketerArt(rec) && artTypeOk(artByCode.get(code), rec.type);
    // рядки картки — де ШІ пропонує іншу статтю чи проєкт, ніж зараз; спершу впевненіші
    function aiRows() {
      const out = { rows: [], agree: 0, none: 0 };
      if (!AI || !AI.results) return out;
      for (const rec of RUN.rest || []) {
        const h = AI.results[rec.id];
        if (!h) continue;
        const cur = `${rec.category_id}:${rec.operation_id}`, pid = h.p ? projId(h.p) : undefined;
        // стаття не того типу (дохідна для витрати чи навпаки) — як «ШІ не визначився»: такої підказки не показуємо
        const art = h.a && h.a !== cur && artByCode.has(h.a) && artTypeOk(artByCode.get(h.a), rec.type) ? h.a : '', prj = pid != null && pid !== rec.project_id ? h.p : '';
        if (art || prj) out.rows.push({ rec, h, art, prj });
        else if (h.a === cur) out.agree++;
        else out.none++;
      }
      const rank = x => (x.h.c in AI_CONF ? AI_CONF[x.h.c] : 3);
      out.rows.sort((x, y) => rank(x) - rank(y) || (x.rec.date < y.rec.date ? -1 : x.rec.date > y.rec.date ? 1 : x.rec.id - y.rec.id));
      return out;
    }
    function takeAi(id, field) {
      const x = aiRows().rows.find(r => r.rec.id === id);
      if (!x || !editMode) return;
      const rec = x.rec, ch = (manual[id] || []).filter(c => c.field !== field);
      if (field === 'category') {
        if (!x.art || !aiArtOk(rec, x.art)) return;
        const [c, o] = x.art.split(':').map(Number);
        ch.push({ field: 'category', from: { category_id: rec.category_id, operation_id: rec.operation_id }, to: { category_id: c, operation_id: o }, toLabel: artName(artByCode.get(x.art)), via: 'ai' });
      } else {
        if (!x.prj) return;
        ch.push({ field: 'project', from: rec.project_id, to: projId(x.prj), toLabel: 'проєкт ' + x.prj, via: 'ai' });
      }
      manual[id] = ch;
      selected.set(id, new Set(ch.map(c => c.field)));
      if (!hintRes.has(id)) hintRes.set(id, pseudoRes(rec));
      render();
    }
    function aiHtml() {
      if (!opts.ai || !RUN) return '';
      const n = (RUN.rest || []).length, S = AI && AI.state;
      // «Ще раз» — і коли виправляють у Помічнику (ключ, увімкнення, ліміт): інакше лишалось лише «Перевірити», що скидає вибрані зміни
      const retry = AI && (AI.failed || (S && S !== 'ready' && S !== 'wait')) ? '<button data-ai-retry="1" class="quiet">Ще раз</button>' : '';
      let h = `<div class="card" data-r="ai"><div class="row" style="justify-content:space-between;align-items:center;margin:0 0 6px"><h3 style="margin:0">Підказки ШІ <span class="muted" style="font-weight:400">· ${esc((AI && AI.model) || 'Claude Sonnet 5.5')} · не правила</span></h3>${retry}</div>`;
      if (!n) return h + '<div class="muted">Записів, яких не покриває жодне правило, немає — підказувати нічого.</div></div>';
      const say = {
        wait: ['muted', 'Питаю «Помічник кешфлоу»…'],
        nohelper: ['muted', 'ШІ-підказки працюють через «Помічник кешфлоу», а він не відповідає. Запустіть «Помічник кешфлоу.bat» і натисніть «Ще раз».'],
        nokey: ['muted', 'ШІ ще не налаштовано: у вікні Помічника відкрийте «Налаштування» → «ШІ-підказки» і вставте ключ Claude API.'],
        off: ['muted', 'ШІ-підказки вимкнено в «Налаштуваннях» Помічника.'],
        nosdk: ['muted', 'Помічник ще встановлює пакет anthropic для ШІ — зачекайте хвилину й натисніть «Ще раз».'],
        badkey: ['err', 'Claude не прийняв ключ API — перевірте його в «Налаштуваннях» Помічника.'],
        limit: ['warn', `Досягнуто місячного ліміту ШІ (${usd(AI && AI.usage && AI.usage.limit)}): нові записи в Claude не йдуть, видно лише вже отримані підказки. Ліміт змінюється в «Налаштуваннях» Помічника.`],
        pace: ['warn', 'На сьогодні витрачено рівномірну частку місячного ліміту ШІ (щоб його вистачило на весь місяць): нові записи підуть у Claude завтра, видно вже отримані підказки.'],
      }[S || 'wait'];
      if (say) h += `<div class="${say[0]}">${esc(say[1])}</div>`;
      if (!AI || !AI.results) return h + '</div>';
      const { rows, agree, none } = aiRows(), got = (RUN.rest || []).filter(r => AI.results[r.id]).length;
      if (AI.pending) h += `<div class="muted" style="margin:0 0 8px">ШІ думає: готово ${got} із ${n}…</div>`;
      if (AI.error) h += `<div class="err">${esc(AI.error)}${AI.failed ? `. Без підказки лишилось ${esc(nRec(AI.failed))} — «Ще раз» надішле їх знову.` : ''}</div>`;
      if (rows.length) {
        h += `<div class="muted" style="margin:0 0 8px">Записів без правил: ${n}; ШІ пропонує іншу статтю чи проєкт: ${rows.length}. ${editMode ? '«Взяти…» додає зміну до вибраного (як ✎); у CRM — лише після «Застосувати вибране».' : 'Щоб узяти підказку, увімкніть режим редагування.'}</div>`;
        h += `<div class="tbl"><table class="recs"><colgroup><col style="width:92px"><col style="width:130px"><col style="width:120px"><col><col style="width:300px"><col style="width:290px"></colgroup>
<tr><th>ID · дата</th><th>Рахунок</th><th>Сума</th><th>Коментар</th><th>ШІ пропонує: зараз → ШІ</th><th>Чому</th></tr>`;
        for (const x of rows) {
          const rec = x.rec, id = rec.id, own = manual[id], has = f => !!(own && own.some(c => c.field === f));
          if (!hintRes.has(id)) hintRes.set(id, pseudoRes(rec)); // для ✎ і плану змін
          const take = (f, t, tip) => `<button class="quiet" data-ai-take="${id}|${f}" title="${esc(tip)}" style="height:24px;padding:0 8px;margin:0;font-size:12px">${t}</button>`;
          const acts = !editMode ? '' : `<div class="row" style="margin:6px 0 0;gap:6px">${x.art && !has('category') ? (aiArtOk(rec, x.art) ? take('category', 'Взяти статтю', `Додати до вибраного зміну статті на «${artName(artByCode.get(x.art))}»`) : `<span class="muted">${inMarketerArt(rec) ? MK_NOTE : 'цю статтю змінюють у CRM'}</span>`) : ''}${x.prj && !has('project') ? take('project', 'Взяти проєкт', `Додати до вибраного зміну проєкту на «${x.prj}»`) : ''}${own ? `<span class="lnk" data-hdrop="${id}" title="Прибрати зміни цього запису з вибраного">прибрати зміну</span>` : ''}<button data-ed="${id}" title="Своя стаття чи проєкт" style="height:24px;padding:0 8px;margin:0">✎</button></div>`;
          h += `<tr data-id="${id}"><td><span class="id">${id}</span><br><span class="muted">${esc(dmy(rec.date))}</span></td>
<td class="acc">${esc(rec.account_names.join(' → '))}</td><td class="n">${fmt(rec.amount)} ${esc(rec.currency)}</td><td><div class="cmt" title="${esc(rec.comment)}">${esc(rec.comment)}</div></td>
<td>${x.art ? `<div class="chg"><span class="f">стаття</span><span><span class="from">${esc(rec.category_label || '—')}</span> → <span class="to">${esc(lastPart(artName(artByCode.get(x.art))))}</span></span></div>` : ''}${x.prj ? `<div class="chg"><span class="f">проєкт</span><span><span class="from">${esc(rec.project_label || '—')}</span> → <span class="to">${esc(x.prj)}</span></span></div>` : ''}${own ? `<div class="chg"><span class="f">вручну</span><span class="to">${esc(own.map(c => c.toLabel).join('; '))}</span></div>` : ''}</td>
<td><span class="badge ${AI_CLS[x.h.c] || 'st-locked'}">${esc(x.h.c || '?')}</span> ${esc(x.h.w)}${acts}</td></tr>`;
        }
        h += '</table></div>';
      } else if (got && !AI.pending) h += `<div class="good">✓ ${esc(nRec(got))} без правил — ШІ згоден з поточними статтями${none ? ` (не визначився: ${none})` : ''}.</div>`;
      if (!got && S !== 'ready' && S !== 'limit' && S !== 'pace') return h + '</div>';
      const foot = [rows.length && agree ? `Ще ${nRec(agree)}: ШІ згоден з поточною статтею.` : '', rows.length && none ? `Не визначився: ${none}.` : '',
        AI.usage ? `Цього місяця ≈ ${usd(AI.usage.usd)} з ліміту ${usd(AI.usage.limit)}.` : '', 'У Claude ідуть дата, сума, рахунок, коментар, стаття й проєкт — без IBAN, номерів карток, ІПН, телефонів і e-mail.'];
      return h + `<div class="muted small" style="margin-top:8px">${esc(foot.filter(Boolean).join(' '))}</div></div>`;
    }
    function bindAi(root) {
      if (!root) return;
      root.querySelectorAll('[data-ai-take]').forEach(e => e.onclick = () => { const [id, f] = e.dataset.aiTake.split('|'); takeAi(Number(id), f); });
      root.querySelectorAll('[data-ai-retry]').forEach(e => e.onclick = () => aiAsk(true));
      root.querySelectorAll('[data-ed]').forEach(e => e.onclick = () => openEditor(Number(e.dataset.ed), e));
      root.querySelectorAll('[data-hdrop]').forEach(e => e.onclick = () => { const id = Number(e.dataset.hdrop); delete manual[id]; selected.delete(id); render(); });
    }
    // таблиці з прокруткою всередині root → [[ключ (картка data-r і номер у ній), таблиця]] — щоб прокрутка пережила перемальовування
    function tblsOf(root) {
      const n = new Map();
      return root ? [...root.querySelectorAll('.tbl')].map(t => {
        const c = t.closest('[data-r]'), b = c ? c.dataset.r : '', i = n.get(b) || 0;
        n.set(b, i + 1);
        return [`${b}#${i}`, t];
      }) : [];
    }
    // лише картка ШІ (поки ШІ думає): таблиця записів не перемальовується; відкритий у картці ✎ не зникає; прокрутка — теж
    function renderAi() {
      const box = $('ai');
      if (!box || box.querySelector('.edit-cell')) return;
      const keep = new Map(tblsOf(box).map(([k, t]) => [k, [t.scrollTop, t.scrollLeft]]));
      box.outerHTML = aiHtml();
      for (const [k, t] of tblsOf($('ai'))) { const v = keep.get(k); if (v) { t.scrollTop = v[0]; t.scrollLeft = v[1]; } }
      bindAi($('ai'));
    }

    // ---------- вибір змін ----------
    const resById = id => RUN && (RUN.results.find(x => x.record.id === id) || hintRes.get(id));
    // зміни, які можна вибрати в рядку: fix — автоматичні, review — усі (лише окремим вибором людини)
    const eligible = r => (keptAt(r) ? [] : r.status === 'fix' ? r.changes.filter(c => c.auto) : r.status === 'review' ? r.changes : []);
    const selOf = id => selected.get(id) || new Set();
    function setField(id, field, on) {
      const s = new Set(selOf(id));
      if (on) s.add(field); else s.delete(field);
      if (s.size) selected.set(id, s); else selected.delete(id);
    }
    function setRow(r, on) {
      const id = r.record.id;
      if (on) { const fs = eligible(r).map(c => c.field); if (fs.length) selected.set(id, new Set(fs)); }
      else { selected.delete(id); delete manual[id]; }
    }
    // групи масової зміни: лише рядки fix, по правилу і цільовому значенню
    function groupsOf(run) {
      const g = new Map();
      for (const r of run.results) {
        if (r.status !== 'fix' || keptAt(r)) continue;
        for (const c of r.changes) {
          if (!c.auto) continue;
          const fd = r.fields[c.field];
          const rules = fd.winners.filter(w => r.perRule[w.id] === 'fix');
          const key = rules.map(w => w.id).join('+') + '|' + c.field + '|' + changeKey(c);
          let x = g.get(key);
          if (!x) g.set(key, x = { key, field: c.field, label: (c.field === 'category' ? 'Стаття → ' : 'Проєкт → ') + lastPart(c.toLabel), title: rules.map(w => w.title).join('; '), ids: [], uah: 0, other: 0 });
          x.ids.push(r.record.id);
          if (r.record.currency === 'UAH') x.uah += Math.abs(r.record.amount); else x.other++;
        }
      }
      return [...g.values()].sort((a, b) => b.ids.length - a.ids.length);
    }
    const groupSelCount = gr => gr.ids.filter(id => selOf(id).has(gr.field)).length;

    function renderGroups() {
      if (!RUN || !GROUPS.length) { $('groups').innerHTML = ''; return; }
      const total = GROUPS.reduce((s, g) => s + g.ids.length, 0);
      let h = `<div class="card"><h3>Групи змін «виправити» <span class="muted" style="font-weight:400;font-size:13px">· ${GROUPS.length} ${plural(GROUPS.length, 'група', 'групи', 'груп')}, ${total} ${plural(total, 'зміна', 'зміни', 'змін')}</span></h3>
<div class="muted" style="margin:-6px 0 10px">${editMode ? 'Галочка групи позначає цю зміну в усіх її рядках. «Показати» — лише рядки групи в таблиці.' : (opts.applyAllowed ? 'Щоб позначати, увімкніть режим редагування.' : 'Позначати зміни можна в закладці «Лінтер кешфлоу (APPLY)».')}</div><div class="groups">`;
      for (const gr of GROUPS) {
        const n = groupSelCount(gr);
        h += `<div class="grp${n ? ' on' : ''}">${editMode ? `<input type="checkbox" data-grp="${esc(gr.key)}"${n === gr.ids.length ? ' checked' : ''}${n && n < gr.ids.length ? ' data-ind="1"' : ''}>` : ''}
<div><div class="t">${esc(gr.label)}</div><div class="s">${esc(gr.title)}</div>
<div class="s">${nRec(gr.ids.length)} · ${fmt0(gr.uah)} грн${gr.other ? ` + ${gr.other} у валюті` : ''}${editMode ? ` · позначено ${n}` : ''} · <span class="lnk" data-show="${esc(gr.key)}">${groupFilter === gr.key ? 'показати всі' : 'показати'}</span></div></div></div>`;
      }
      h += '</div></div>';
      $('groups').innerHTML = h;
      $('groups').querySelectorAll('[data-ind]').forEach(el => { el.indeterminate = true; });
      $('groups').querySelectorAll('[data-grp]').forEach(el => el.onchange = () => {
        const gr = GROUPS.find(g => g.key === el.dataset.grp);
        const on = groupSelCount(gr) < gr.ids.length;
        for (const id of gr.ids) setField(id, gr.field, on);
        render();
      });
      $('groups').querySelectorAll('[data-show]').forEach(el => el.onclick = () => { groupFilter = groupFilter === el.dataset.show ? null : el.dataset.show; render(); });
    }

    function changeLines(r) {
      const rec = r.record, id = r.record.id, sel = selOf(id), out = [];
      const can = editMode && (r.status === 'fix' || r.status === 'review') && !manual[id];
      for (const c of r.changes) {
        const from = c.field === 'category' ? rec.category_label : (rec.project_label || '—');
        const to = c.field === 'category' ? lastPart(c.toLabel) : c.toLabel;
        const box = can && (r.status === 'review' || c.auto) ? `<input type="checkbox" data-chg="${id}|${c.field}"${sel.has(c.field) ? ' checked' : ''}>` : '';
        out.push(`<div class="chg">${box}<span class="f">${c.field === 'category' ? 'стаття' : 'проєкт'}</span><span><span class="from">${esc(from)}</span> → <span class="to">${esc(to)}</span></span></div>`);
      }
      const f = r.fields;
      // поле, яке правила хочуть інше, але лінтер його не змінює (зарплатна стаття, лід/авто, до межі, стаття з маркетологом): показати, що має бути
      const why = r.status === 'manual-422' ? 'лише вручну в CRM' : r.status === 'locked-auto' ? 'лід / авто — не змінюється'
        : r.status === 'locked-date' ? (M.isClosedMonth(rec.period, closedThrough) ? 'місяць закрито — лише довідка' : 'до межі — лише довідка') : 'вручну в CRM';
      for (const k of ['category', 'project']) {
        const fd = f[k];
        if (!fd || fd.equal) continue;
        const name = k === 'category' ? 'стаття' : 'проєкт';
        if (fd.conflict) { out.push(`<div class="chg"><span class="f">${name}</span><span class="bad">конфлікт правил</span></div>`); continue; }
        if (r.changes.some(c => c.field === k)) continue;
        const from = k === 'category' ? rec.category_label : (rec.project_label || '—');
        const to = k === 'category' && fd.expected && fd.expected.kind === 'article' ? lastPart(fd.expectedLabel) : fd.expectedLabel;
        out.push(`<div class="chg"><span class="f">${name}</span><span><span class="from">${esc(from)}</span> → <span class="to">${esc(to)}</span> <span class="badge st-locked">${esc(why)}</span></span></div>`);
      }
      if (f.type && !f.type.equal) out.push('<div class="chg"><span class="f">тип</span><span>переказ між рахунками (вручну)</span></div>');
      if (f.exclude_from_pnl && !f.exclude_from_pnl.equal) out.push('<div class="chg"><span class="f">P&amp;L</span><span>не показувати (вручну)</span></div>');
      if (manual[id]) out.push(`<div class="chg"><span class="f">вручну</span><span class="to">${esc(manual[id].map(c => c.toLabel).join('; '))}</span></div>`);
      return out.join('') || '<span class="ok">✓ уже правильно</span>';
    }

    function render() {
      if (!RUN) return;
      renderGroups();
      const counts = countsOf(RUN);
      const order = ['fix', 'review', 'manual-422', 'kept', 'locked-auto', 'locked-date', 'ok'];
      let h = `<div class="card"><div class="row" style="justify-content:space-between;align-items:flex-start"><h3 style="margin:0">Записи</h3><div class="chips">${order.filter(s => (s !== 'locked-date' && s !== 'kept') || counts[s]).map(s => `<span class="${ST_CLS[s]}${filter.has(s) ? ' on' : ''}" data-f="${s}">${esc(s === 'kept' ? 'лишено як є' : s === 'locked-date' ? 'лише довідка (до межі / закритий місяць)' : L.STATUS_UA[s])}: ${counts[s] || 0}</span>`).join('')}</div></div>`;
      if (counts['locked-date']) h += `<div class="warn">${esc(nRec(counts['locked-date']))} ${[fixFrom && `до ${dmy(fixFrom)}`, closedThrough && `із закритих у CRM місяців (по ${M.monthUa(closedThrough)})`].filter(Boolean).map(esc).join(' і ')} показано лише для довідки: лінтер їх не змінює.</div>`;
      const gr = groupFilter && GROUPS.find(g => g.key === groupFilter);
      if (gr) h += `<div class="info">Показано групу «${esc(gr.label)}» (${gr.ids.length}). <span class="lnk" data-clear-group="1">Показати всі записи</span></div>`;
      const inGroup = gr ? new Set(gr.ids) : null;
      const rows = RUN.results.filter(r => (inGroup ? inGroup.has(r.record.id) : filter.has(stOf(r))));
      // порожньо — так і сказати: або змінювати нічого, або фільтр сховав усі рядки
      if (!rows.length) {
        const todo = RUN.results.some(r => KEEPABLE.has(stOf(r)));
        h += !todo ? `<div class="good">✓ Перевірено ${esc(nRec(RUN.checked))} — змінювати нічого.</div>` : '<div class="empty">Немає записів з вибраними статусами — натисніть статус угорі.</div>';
      } else {
      h += `<div class="muted" style="margin:0 0 8px">Показано ${rows.length} із ${RUN.results.length}. ${editMode ? 'Галочка рядка — усі його зміни; галочки біля статті й проєкту — окремо. Рядки «перевірити» — лише вручну. ✎ — своя стаття чи проєкт.' : 'Режим перегляду: нічого не змінюється.'}</div>`;
      h += `<div class="tbl"><table class="recs"><colgroup>${editMode ? '<col style="width:36px">' : ''}<col style="width:92px"><col style="width:130px"><col style="width:120px"><col><col style="width:290px"><col style="width:260px">${editMode ? '<col style="width:48px">' : ''}</colgroup>
<tr>${editMode ? '<th></th>' : ''}<th>ID · дата</th><th>Рахунок</th><th>Сума</th><th>Коментар</th><th>Зміни</th><th>Статус · правила</th>${editMode ? '<th></th>' : ''}</tr>`;
      for (const r of rows.slice(0, 2000)) {
        const rec = r.record, id = rec.id, el = eligible(r), sel = selOf(id);
        // 'locked-date' — і до межі, і закритий у CRM місяць (linter.js freeze): назвати те, що насправді (07.11.2026)
        const shut = M.isClosedMonth(rec.period, closedThrough), SHUT = 'місяць закрито — лише довідка';
        const rowBox = editMode && (el.length || manual[id]) ? `<input type="checkbox" data-sel="${id}"${manual[id] || (el.length && el.every(c => sel.has(c.field))) ? ' checked' : ''}${!manual[id] && sel.size && sel.size < el.length ? ' data-ind="1"' : ''}>` : '';
        h += `<tr data-id="${id}">${editMode ? `<td>${rowBox}</td>` : ''}
<td><span class="id">${id}</span><br><span class="muted">${esc(dmy(rec.date))}</span>${rec.is_lead ? '<br><span class="muted">лід</span>' : rec.is_auto ? '<br><span class="muted">авто</span>' : ''}</td>
<td class="acc">${esc(rec.account_names.join(' → '))}</td><td class="n">${fmt(rec.amount)} ${esc(rec.currency)}</td><td><div class="cmt" title="${esc(rec.comment)}">${esc(rec.comment)}</div></td>
<td>${changeLines(r)}</td>
<td><span class="badge ${ST_CLS[r.status]}">${esc(r.status === 'locked-date' && shut ? SHUT : L.STATUS_UA[r.status] || r.status)}</span>${keptAt(r) ? ` <span class="badge st-ok">лишено як є ${esc(dmy(keptAt(r)))}</span> <span class="lnk" data-unkeep="${id}" title="Повернути рядок у список">повернути</span>`
  : KEEPABLE.has(r.status) ? ` <button class="quiet" data-keep="${id}" title="Перевірено — лишити як є: рядок зникне зі списку й не рахуватиметься в «Закритті місяця». У CRM нічого не змінюється." style="height:24px;padding:0 8px;margin:0;font-size:12px">Лишити як є</button>` : ''}${r.reasons.length ? `<div class="rules">${esc(r.reasons.join('; '))}</div>` : ''}<div class="rules">${r.applicable.map(x => { const st = r.perRule[x.id]; return `<div class="rl"><b class="rs-${esc(st)}">${esc(st === 'locked-date' && shut ? SHUT : RULE_ST[st] || st)}</b> · ${esc(x.title)} <span class="rid">${esc(x.id)}</span></div>`; }).join('')}</div></td>
${editMode ? `<td>${rec.is_lead || rec.is_auto || rec.is_salary || (rec.type !== 'income' && rec.type !== 'expense') || rec.n_payments > 1 || (fixFrom && rec.date < fixFrom) || M.isClosedMonth(rec.period, closedThrough) ? '' : `<button data-ed="${id}" title="Ручна правка">✎</button>`}</td>` : ''}</tr>`;
      }
      h += '</table></div>';
      if (rows.length > 2000) h += '<div class="muted">Показано перші 2000 рядків — повний список у звіті Excel.</div>';
      }
      h += '</div>' + aiHtml() + hintsHtml();
      // галочки, фільтри й «Взяти…» перемальовують усе — прокрутка кожної таблиці (записи, «Підказки ШІ», «Підказки з історії»)
      // лишається там, де була
      const keep = new Map(tblsOf($('out')).map(([k, t]) => [k, [t.scrollTop, t.scrollLeft]]));
      $('out').innerHTML = h;
      for (const [k, t] of tblsOf($('out'))) { const v = keep.get(k); if (v) { t.scrollTop = v[0]; t.scrollLeft = v[1]; } }
      $('out').querySelectorAll('[data-ind]').forEach(e => { e.indeterminate = true; });
      $('out').querySelectorAll('[data-f]').forEach(e => e.onclick = () => { const f = e.dataset.f; filter.has(f) ? filter.delete(f) : filter.add(f); groupFilter = null; render(); });
      const cg = $('out').querySelector('[data-clear-group]');
      if (cg) cg.onclick = () => { groupFilter = null; render(); };
      $('out').querySelectorAll('[data-sel]').forEach(e => e.onchange = () => {
        const r = resById(Number(e.dataset.sel));
        const el = eligible(r), sel = selOf(r.record.id);
        setRow(r, !(manual[r.record.id] || (el.length && el.every(c => sel.has(c.field)))));
        render();
      });
      $('out').querySelectorAll('[data-chg]').forEach(e => e.onchange = () => {
        const [id, field] = e.dataset.chg.split('|');
        setField(Number(id), field, e.checked);
        render();
      });
      $('out').querySelectorAll('[data-ed]').forEach(e => e.onclick = () => openEditor(Number(e.dataset.ed), e));
      $('out').querySelectorAll('[data-keep]').forEach(e => e.onclick = () => setKeep(Number(e.dataset.keep), true));
      $('out').querySelectorAll('[data-unkeep]').forEach(e => e.onclick = () => setKeep(Number(e.dataset.unkeep), false));
      $('out').querySelectorAll('[data-hints]').forEach(e => e.onclick = () => findHints());
      $('out').querySelectorAll('[data-take]').forEach(e => e.onclick = () => takeHint(Number(e.dataset.take)));
      $('out').querySelectorAll('[data-hdrop]').forEach(e => e.onclick = () => { const id = Number(e.dataset.hdrop); delete manual[id]; selected.delete(id); render(); });
      bindAi($('ai'));
      updApply();
    }
    function planNow() {
      if (!RUN) return [];
      const ids = new Set(), fields = new Map();
      for (const [id, fs] of selected) if (fs.size) { ids.add(id); fields.set(id, fs); }
      return linter.planChanges(hintRes.size ? RUN.results.concat([...hintRes.values()]) : RUN.results, ids, manual, fields);
    }
    function updApply() {
      const plan = editMode && !applyDone ? planNow() : [];
      const nCh = plan.reduce((s, p) => s + p.changes.length, 0);
      btn('apply').disabled = !editMode || !plan.length || busy || noFull();
      btn('apply').textContent = applyDone ? 'Застосовано — натисніть «Перевірити»' : `Застосувати вибране (${plan.length})`;
      const nFix = RUN ? RUN.results.filter(r => r.status === 'fix' && !keptAt(r)).length : 0;
      btn('selfix').disabled = !editMode || !nFix || busy || applyDone;
      btn('selfix').textContent = `Позначити всі «виправити» (${nFix})`;
      btn('selnone').disabled = !editMode || !selected.size || busy || applyDone;
      $('sel-info').textContent = !editMode ? (opts.applyAllowed ? 'Режим перегляду: нічого не змінюється. Щоб вибирати зміни, увімкніть режим редагування.' : 'Режим перегляду: нічого не змінюється. Змінювати статті й проєкти можна в закладці «Лінтер кешфлоу (APPLY)».')
        : plan.length ? `Позначено ${nRec(plan.length)}, змін: ${nCh}. Перед відправкою буде вікно з прикладом запиту.`
          : 'Нічого не позначено: позначте групу, рядок або окремо статтю чи проєкт.';
    }
    // масова зміна — лише на явну дію людини; review сюди не входять (ТЗ: лише окремим вибором рядка)
    btn('selfix').onclick = () => { if (!RUN) return; for (const r of RUN.results) if (r.status === 'fix' && !keptAt(r)) setRow(r, true); render(); };
    btn('selnone').onclick = () => { for (const id of [...selected.keys()]) if (!manual[id]) selected.delete(id); render(); };

    function openEditor(id, btn) {
      const r = resById(id);
      if (!r) return;
      const rec = r.record;
      // рядок тієї таблиці, де натиснули ✎: той самий запис буває і в «Підказках ШІ», і в «Підказках з історії»
      const tr = (btn && btn.closest('tr')) || $('out').querySelector(`tr[data-id="${id}"]`);
      const wantType = rec.type === 'income' ? 1 : rec.type === 'expense' ? 2 : null;
      const lv = linter.live || {};
      const opt = articles.filter(a => (wantType == null || a.type == null || a.type === wantType) &&
        !(lv.marketerArts && lv.marketerArts.has(a.category_id + '/' + a.operation_id)) && !(lv.salaryOps && lv.salaryOps.has(a.operation_id)) && a.category_id !== (lv.salaryCategoryId || 21))
        .map(a => `<option value="${a.category_id}/${a.operation_id}">${esc(a.group + ' / ' + (a.category === a.name ? a.name : a.category + ' / ' + a.name))}</option>`).join('');
      const row = document.createElement('tr'), mk = inMarketerArt(rec); // з маркетологом — лише проєкт
      row.innerHTML = `<td colspan="20" class="edit-cell">${mk ? `Стаття: <span class="muted">${MK_NOTE}</span>` : `Стаття: <select data-e="art"><option value="">— без змін —</option>${opt}</select>`}
 Проєкт: <select data-e="prj"><option value="">— без змін —</option>${projects.map(([n, v]) => `<option value="${v}">${esc(n)}</option>`).join('')}</select>
 <button data-e="ok" class="primary">Додати до змін</button><button data-e="cancel">Скасувати</button>
 <span class="muted" data-e="note">Сума, дата, рахунок і валюта не змінюються. Статті з маркетологом і зарплатні тут не пропонуються — їх змінюють у CRM.</span></td>`;
      tr.after(row);
      if (Cmb) Cmb.enhance(row); // стаття — з пошуком
      row.querySelector('[data-e="cancel"]').onclick = () => row.remove();
      row.querySelector('[data-e="ok"]').onclick = () => {
        const artEl = row.querySelector('[data-e="art"]'), ch = [], art = artEl ? artEl.value : '', prj = row.querySelector('[data-e="prj"]').value;
        if (art) {
          const [c, o] = art.split('/').map(Number);
          if (c !== rec.category_id || o !== rec.operation_id) ch.push({ field: 'category', from: { category_id: rec.category_id, operation_id: rec.operation_id }, to: { category_id: c, operation_id: o }, toLabel: artEl.selectedOptions[0].textContent });
        }
        if (prj && Number(prj) !== rec.project_id) ch.push({ field: 'project', from: rec.project_id, to: Number(prj), toLabel: 'проєкт ' + row.querySelector('[data-e="prj"]').selectedOptions[0].textContent });
        if (!ch.length) { row.querySelector('[data-e="note"]').textContent = mk ? 'Нічого не змінено — виберіть інший проєкт.' : 'Нічого не змінено — виберіть іншу статтю або проєкт.'; return; }
        manual[id] = ch;
        selected.set(id, new Set(ch.map(c => c.field)));
        render();
      };
    }

    /* Вікно підтвердження. read(bg) — прочитати поля вікна перед закриттям: тоді «так» повертає {value}, «ні» — false.
       o.cancel — третя кнопка «Скасувати», коли «ні» — інша дія (напр. «Вибрати файл…»): тоді «Скасувати», Esc і клік поза
       вікном — null. Фокус — у вікні (для небезпечної дії — на «ні»), тож Enter не натисне вдруге кнопку під вікном. */
    function dialog(html, okText, danger, noText, read, o) {
      o = o || {};
      return new Promise(res => {
        const bg = document.createElement('div'), back = document.activeElement, quit = o.cancel ? null : false;
        bg.className = 'cfl';
        bg.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}<div class="row" style="justify-content:flex-end;margin-top:14px">
${o.cancel ? '<button data-d="cancel" class="quiet">Скасувати</button>' : ''}<button data-d="no">${esc(noText || 'Скасувати')}</button><button data-d="yes" class="${danger ? 'danger' : 'primary'}">${esc(okText || 'Так')}</button></div></div></div>`;
        const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(quit); } };
        const close = v => {
          document.removeEventListener('keydown', onKey, true);
          bg.remove();
          try { if (back && back.focus && document.contains(back)) back.focus(); } catch (e) {}
          res(v);
        };
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(bg);
        bg.querySelector('[data-d="no"]').onclick = () => close(false);
        if (o.cancel) bg.querySelector('[data-d="cancel"]').onclick = () => close(null);
        bg.querySelector('[data-d="yes"]').onclick = () => close(read ? { value: read(bg) } : true);
        const shade = bg.querySelector('.modal-bg');
        shade.addEventListener('mousedown', e => { if (e.target === shade) close(quit); });
        try { if (back && back.blur) back.blur(); } catch (e) {}
        (bg.querySelector(read ? 'input,select,textarea' : danger ? '[data-d="no"]' : '[data-d="yes"]') || bg.querySelector('[data-d="yes"]')).focus();
      });
    }

    // резервна копія й журнал: у папку Помічника без вікна «Зберегти як» (storage.keepFile), інакше — завантаженням
    const keepFile = async (name, mime, data, kind) => (storage.keepFile ? storage.keepFile(name, mime, data, kind) : (await storage.saveFile(name, mime, data), { where: 'download' }));
    const placeOf = r => (r && r.where === 'helper' ? `у папці Помічника: ${r.dir || r.path}` : 'у «Завантаженнях»');
    let kept = {}; // де лежать резервна копія й журнал останнього прогону
    async function saveJournal(journal, prefix) {
      const rows = L.journalRows(journal);
      await keepFile(`${prefix}_журнал_${stamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', X.buildXlsx([{ name: 'Журнал', rows, widths: [20, 10, 22, 18, 18, 46, 6, 16, 60] }]), 'journals');
      kept.journal = await keepFile(`${prefix}_журнал_${stamp()}.json`, 'application/json', JSON.stringify(journal, null, 1), 'journals');
      try { const all = LS.get('cfl_journal', []); LS.set('cfl_journal', all.concat(journal).slice(-500)); } catch (e) {}
    }
    function journalSummary(journal) {
      const c = {};
      for (const e of journal) c[e.result] = (c[e.result] || 0) + 1;
      const bad = journal.filter(e => e.result !== 'ok');
      const ua = k => L.RESULT_UA[k] || k;
      return `<div class="box">Результат: ${Object.entries(c).map(([k, v]) => `${esc(ua(k))}: ${v}`).join(' · ')}</div>` +
        (bad.length ? `<div class="box"><table><tr><th>ID</th><th>Результат</th><th>Примітки</th></tr>${bad.map(e => `<tr><td>${esc(e.id)}</td><td>${esc(ua(e.result))}</td><td>${esc(e.problems.join('; '))}</td></tr>`).join('')}</table></div>` : '');
    }
    // відмови CRM з оновлення 29.10.2026: закритий місяць і права
    function refusalNotes(journal) {
      const closed = journal.filter(e => e.result === 'closed-period' || e.result === 'skipped-closed').length;
      if (closed) note(`Не змінено через закритий місяць: ${nRec(closed)} (P&L → «Закриття періоду»; змінює лише Адмін).${closedThrough ? ` Лінтер пам'ятає «закрито по ${M.monthUa(closedThrough)}»: після «Перевірити» записи цих місяців буде лише для довідки.` : ''}`, 'err');
      if (journal.some(e => e.result === 'no-rights')) note(M.noFullText(rights), 'err');
    }

    btn('apply').onclick = async () => {
      const plan = planNow();
      if (!plan.length || busy) return;
      setBusy(true);
      // попередня копія в браузері лишається, якщо цей прогін нічого не змінить
      const prevBackup = await IDB.get('last_backup'), prevApplied = await IDB.get('last_backup_applied');
      const done = [];
      let out = null, wrote = false;
      kept = {};
      try {
        out = await linter.apply(plan, {
          confirm: info => dialog(`<h3>Застосувати зміни в CRM?</h3>
<p>Записів: <b>${info.count}</b>.${info.unread ? ` Ще ${info.unread} не вдалося прочитати — їх не буде змінено.` : ''} Перед першою зміною буде збережено резервну копію: файл «кешфлоу_резервна_копія_….json» і копію в цьому браузері. З неї можна зробити відкат.</p>
<p>За правилами:</p><ul>${Object.entries(info.byRule).map(([k, v]) => `<li>${esc(k)}: ${v}</li>`).join('')}</ul>
${info.sample ? `<p>Приклад запиту, який буде відправлено:</p><pre>${esc(info.sample.method + ' ' + info.sample.url + '\n' + JSON.stringify(info.sample.body, null, 2))}</pre>` : ''}
<p class="muted">Змінюються лише стаття і проєкт. По одному запису: перед зміною запис перечитується (якщо його вже змінили — пропуск), після зміни — перевіряється.</p>`, `Так, змінити ${info.count}`, true),
          saveBackup: async b => {
            const okIdb = (await IDB.set('last_backup', b)) && (await IDB.set('last_backup_applied', [])) && ((await IDB.get('last_backup')) || {}).created_at === b.created_at;
            wrote = true;
            kept.backup = await keepFile(`кешфлоу_резервна_копія_${stamp()}.json`, 'application/json', JSON.stringify(b, null, 1), 'backups');
            if (!okIdb && !(await dialog(`<h3>Копію в браузері не збережено</h3><p>Не вдалося зберегти резервну копію в цьому браузері. Файл «кешфлоу_резервна_копія_….json» — ${esc(placeOf(kept.backup))}${kept.backup.where === 'helper' ? '' : ' (якщо браузер його завантажив)'}: без нього відкат буде неможливий.</p><p>Продовжити зміни?</p>`, 'Продовжити', true))) {
              throw new Error('зміни скасовано: резервну копію в браузері не збережено (жоден запис не змінено)');
            }
          },
          onApplied: (id, b) => IDB.set('last_backup_applied', b.applied.slice()),
          onItem: (e, i, n) => {
            done.push(e);
            IDB.set('last_journal', { at: new Date().toISOString(), entries: done }); // журнал не губиться, навіть якщо вкладку закриють
            st(`застосовано ${i} із ${n} (останній: ${e.id} — ${L.RESULT_UA[e.result] || e.result})`);
          },
          saveJournal: j => saveJournal(j, 'кешфлоу'),
        });
        if (out.cancelled) { st('скасовано — нічого не змінено'); return; }
        applyDone = true;
        $('notes').insertAdjacentHTML('beforeend', journalSummary(out.journal));
        refusalNotes(out.journal);
        note(`Резервна копія — ${placeOf(kept.backup)}; журнал — ${placeOf(kept.journal)}.`, 'info');
        st('готово — перевірте журнал; щоб побачити новий стан, натисніть «Перевірити» ще раз');
      } catch (e) { note(e.message, 'err'); }
      finally {
        if (wrote && !(out && out.backup && out.backup.applied.length)) {
          if (prevBackup) { await IDB.set('last_backup', prevBackup); await IDB.set('last_backup_applied', prevApplied === undefined ? null : prevApplied); }
          else { await IDB.del('last_backup'); await IDB.del('last_backup_applied'); }
        }
        setBusy(false);
      }
    };

    btn('rollback').onclick = async () => {
      if (busy) return;
      try {
        const last = await IDB.get('last_backup');
        if (last && last.records && last.records.length) {
          const applied = await IDB.get('last_backup_applied');
          const v = await dialog(`<h3>Відкат</h3><p>У цьому браузері збережено останню резервну копію: створено ${esc(new Date(last.created_at).toLocaleString('uk-UA'))}, ${esc(nRec(last.records.length))}${Array.isArray(applied) ? `, з них лінтер змінив ${applied.length}` : ''}.</p><p>Використати її чи вибрати файл резервної копії? Файли резервних копій — у Помічнику (вкладка «Файли») або в «Завантаженнях».</p>`, 'Використати цю', false, 'Вибрати файл…', null, { cancel: true });
          if (v === null) return;
          if (v) return await rollbackFrom(Array.isArray(applied) ? { ...last, applied } : last, 'остання резервна копія з цього браузера');
        }
        const f = await storage.pickFile('.json');
        if (!f) return;
        await rollbackFrom(JSON.parse(f.text), f.name);
      } catch (e) { note('Відкат: ' + e.message, 'err'); }
    };
    async function rollbackFrom(backup, fileName) {
      const f = { name: fileName || 'резервна копія' };
      if (busy) return;
      if (noFull()) { note('Відкат: ' + M.noFullText(rights), 'err'); return; }
      if (!(await requestEdit())) { note('Відкат змінює записи — потрібен режим редагування.', 'warn'); return; }
      setBusy(true);
      kept = {};
      try {
        if (!linter.live) await loadAccounts();
        const out = await linter.rollback(backup, {
          confirm: info => dialog(`<h3>Відкат з резервної копії</h3><p>Файл: ${esc(f.name)} (створено ${esc(new Date(info.created_at).toLocaleString('uk-UA'))}).</p>
<p>Записів до повернення: <b>${info.count}</b>.${info.nochange ? ` Ще ${nRec(info.nochange)} лінтер не змінював — їх пропущено.` : ''} Записи, які змінили після лінтера, буде пропущено.${info.manual ? ` У ${info.manual} ${plural(info.manual, 'записі', 'записах', 'записах')} проєкт або стаття до лінтера були порожні — їх доведеться повернути вручну (буде в журналі).` : ''}</p>
${info.sample ? `<p>Приклад запиту:</p><pre>${esc(info.sample.method + ' ' + info.sample.url + '\n' + JSON.stringify(info.sample.body, null, 2))}</pre>` : ''}`, 'Так, повернути', true),
          onItem: (e, i, n) => st(`відкат: ${i} із ${n}`),
          saveJournal: j => saveJournal(j, 'кешфлоу_відкат'),
        });
        if (out.cancelled) { st('відкат скасовано'); return; }
        $('notes').insertAdjacentHTML('beforeend', '<h3>Відкат</h3>' + journalSummary(out.journal));
        refusalNotes(out.journal);
        if (kept.journal) note(`Журнал відкату — ${placeOf(kept.journal)}.`, 'info');
        st('відкат завершено');
      } catch (e) { note('Відкат: ' + e.message, 'err'); }
      finally { setBusy(false); }
    }

    function reportSheets() {
      const p = RUN.params;
      const info = [['Параметр', 'Значення'], ['Період з', p.from], ['Період по', p.to], ['Рахунки', p.accountIds && p.accountIds.length ? p.accountIds.join(', ') : 'усі'],
        ['Правила', p.ruleIds ? p.ruleIds.join(', ') : 'усі'], ['Версія rules.json', RUN.rulesVersion || ''],
        ['Межа роботи', fixFrom ? `записи до ${dmy(fixFrom)} — лише довідка` : 'немає'],
        ['Закриті місяці CRM', closedThrough ? `по ${M.monthUa(closedThrough)} — лише довідка` : 'не відмічено'], ['Отримано записів', RUN.fetched], ['Перевірено (без скасованих)', RUN.checked],
        ['Спрацювали правила', RUN.results.length], ['Сформовано', new Date().toLocaleString('uk-UA')], ['Режим', 'перевірка без змін (нічого не змінено)']];
      return [
        { name: 'Звіт', rows: L.reportRows(RUN, linter.live), widths: [9, 11, 28, 12, 7, 9, 60, 30, 14, 40, 34, 14, 12, 12, 40, 12], money: [3] },
        { name: 'Підсумок по правилах', rows: L.summaryRows(RUN, compiled), widths: [14, 50, 12, 9, 14, 24], money: [4] },
        { name: 'Параметри', rows: info, widths: [28, 60] },
      ];
    }
    btn('xlsx').onclick = () => storage.saveFile(`Лінтер_кешфлоу_${RUN.params.from}_${RUN.params.to}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', X.buildXlsx(reportSheets()));
    btn('csv').onclick = () => storage.saveFile(`Лінтер_кешфлоу_${RUN.params.from}_${RUN.params.to}.csv`, 'text/csv', X.toCsv(L.reportRows(RUN, linter.live)));

    return { linter, get run() { return RUN; }, get editing() { return editMode; }, get busy() { return busy; }, element: host, rollbackFrom, requestEdit, setEdit: on => opts.applyAllowed && setEdit(!!on) };
  }

  return { mount, sharedPeriod, savePeriod, artTypeOk, hasPendingWork };
}));
