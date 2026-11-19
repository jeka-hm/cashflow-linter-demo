/* =====================================================================
   Вкладка «Погодження» панелі лінтера: ваш реєстр «Погодження → кешфлоу» (1.9) усередині панелі —
   та сама програма, що й окрема закладка реєстру, з тими самими налаштуваннями цього браузера
   (посилання й ключ реєстру, токени моно).
   Код реєстру — стороння програма: у публічній версії її немає; робоча збірка вбудовує її як
   CF_REGISTRY_RUN(місце, пробнийРежим). Закладка «перегляд» запускає реєстр у пробному режимі
   (ні таблиця погоджень, ні кешфлоу не змінюються), APPLY — у звичайному: погоджені витрати
   вносяться кнопками самого реєстру «2. Внести 1 (тест)» і «3. Внести всі позначені».
   Правила rules.json у погодженнях: статтю й тип рядка реєстру визначають його серверні правила, а перед перевіркою
   рядків (кнопка «1. Отримати й перевірити») вони ще проходять той самий рушій правил, що й лінтер
   (CF_REGISTRY_ROWS — гачок, який build вставляє в код реєстру):
   - поповнення корп. картки з рахунку ФОП / ТОВ (R-NP-CORPCARD-01) — переказ на рахунок corpCard; рахунок «куди» — лише картка
     того самого власника, що й рахунок «з» (reference.card_topup, уточнення 30.10.2026): за номером картки в тексті, інакше єдина
     картка власника, інакше за попередніми поповненнями в CRM (той самий отримувач з того самого рахунку), інакше порожній —
     його вибирають у реєстрі. Картку іншого власника (підказку аркуша «Корпоративні картки») панель замінює;
   - стаття й проєкт — за правилами з режимом fix.
   «Довідник» реєстру (рахунки, за якими таблиця перевіряє «Рахунок кешфлоу» і «Куди (переказ)») панель оновлює з кешфлоу сама:
   на «1. Отримати й перевірити», коли рахунки кешфлоу змінилися, і коли реєстр не прийняв рахунок, якого в «Довіднику» немає
   (тоді запис повторюється). Статті «Довідника» не змінюються; маркетологи — теж, хіба що реєстр їх ще не віддав (тоді — з кешфлоу,
   як кнопкою ⚙ → «Оновити довідник у реєстрі»).
   Змінені рядки реєстр показує як «змінено в панелі: … (rules.json)». У таблицю погоджень ці зміни не пишуться —
   лише результат внесення (статус, ID запису, рахунок «куди»). Вимикається перемикачем у вкладці.
   Дата «по» поруч із «з дати» реєстру: перевіряються й вносяться лише погодження до неї включно (порожньо — усі
   від «з дати»). Вибір «з дати» ставить ту саму дату й у «по» — тоді лише цей день. Фільтр — у тому самому гачку.
   Закриті в CRM місяці (opts.closed — від панелі, «закрито по РРРР-ММ»): рядок з періодом закритого місяця вноситься з періодом
   першого відкритого — у закритий CRM його не прийме. Якщо CRM відмовив через закритий місяць, реєстр (латка збірки) повідомляє
   CF_PERIOD_CLOSED(період рядка) — панель запам'ятовує межу.
   CFApprovalsTab.mount(pane, box, { live, rulesDoc, api, closed }) — pane: пояснення у вкладці; box: місце для панелі реєстру
   (поза .cfl, щоб стилі лінтера не чіпали реєстр).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(globalThis, require('../core/rules-engine.js'), require('../core/recon.js'), require('../core/crm-model.js'), require('../core/drafts.js'));
  else root.CFApprovalsTab = factory(root, root.CFRules, root.CFRecon, root.CFModel, root.CFDrafts);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root, R, Rc, M, CFD) {
  'use strict';
  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const norm = s => String(s || '').toLowerCase().replace(/[’ʼ`]/g, "'").replace(/\s+/g, ' ').trim();
  const isoOf = d => (/^\d{2}[-.]\d{2}[-.]\d{4}/.test(d || '') ? `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}` : String(d || '').slice(0, 10));

  const dmyOf = iso => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
  /* Картку k на дату date тримає інша людина: у довіднику карток (rules.json → reference.cards[].holders) тримач є, а в тексті
     погодження (отримувач і зміст) його не названо. Таку картку історія й підказка реєстру не підставляють. */
  function holderClash(cards, k, date, who) {
    const c = (cards || []).find(c => c && Number(c.account_id) === Number(k)), h = c && Rc.holderOf(c, date);
    return !!h && !Rc.personIn(h.name, who);
  }
  /* Рахунок «куди» для поповнення корп. картки: 1) номер картки в тексті (останні 4 цифри, зокрема з повного номера);
     2) тримач картки: в отримувачі чи тексті названо того, хто на дату погодження тримає картку (rules.json → reference.cards[].holders);
     3) історія: куди раніше йшли поповнення від цього отримувача з цього рахунку, або — якщо з цього рахунку завжди поповнюють одну
     картку і в власника вона одна — вона. Картку, яку тепер тримає інша людина (тримач у довіднику), історія не підставляє.
     Інакше null: рахунок вибирають у реєстрі.
     ok — які картки годяться (картка того самого власника, що й рахунок «з»): номер картки іншого власника → {id: null, foreign} —
     хибний або рахунок «з», або номер у тексті, вирішує людина; історія — лише серед карток, що годяться.
     ctx — {cards — довідник карток, date — день погодження (рррр-мм-дд), many — у власника рахунку «з» кілька діючих карток}.
     З кількома картками «з цього рахунку поповнюють лише цю картку» не діє: у нової картки ще немає історії — 04.11.2026 поповнення
     для нової картки Мартиненка 4546 так пішло на стару 7850. */
  function cardTarget(text, fromId, recipient, tails, hist, ok, ctx) {
    ok = ok || (() => true);
    ctx = ctx || {};
    const t = String(text || ''), who = `${recipient || ''} · ${t}`;
    const byNum = (n, why) => { const k = tails[n]; return !k || k === fromId ? null : ok(k) ? { id: k, why } : { id: null, foreign: k, why }; };
    for (const m of t.matchAll(/(?<!\d)(\d{16})(?!\d)/g)) { const r = byNum(m[1].slice(-4), `номер картки …${m[1].slice(-4)}`); if (r) return r; }
    for (const m of t.matchAll(/(?<!\d)(\d{4})(?!\d)/g)) { const r = byNum(m[1], `номер картки ${m[1]}`); if (r) return r; }
    const h = Rc.holderCard(ctx.cards, who, ctx.date, k => k !== fromId && ok(k));
    if (h && h.id) return { id: h.id, why: `картку ${h.last4} тримає ${h.name}${h.from ? ` (з ${dmyOf(h.from)})` : ''}` };
    if (hist) {
      const pick = (all, share) => {
        const map = new Map([...(all || [])].filter(([k]) => ok(k) && !holderClash(ctx.cards, k, ctx.date, who)));
        if (!map.size) return null;
        const total = [...map.values()].reduce((s, n) => s + n, 0), [k, n] = [...map].sort((a, b) => b[1] - a[1])[0];
        return n / total >= share ? k : null;
      };
      const byRecipient = recipient ? pick(hist.get(`${fromId}|${norm(recipient)}`), 0.6) : null;
      if (byRecipient) return { id: byRecipient, why: 'як попередні поповнення від цього отримувача' };
      const byAccount = ctx.many ? null : pick(hist.get(`${fromId}|*`), 0.9);
      if (byAccount) return { id: byAccount, why: 'з цього рахунку поповнюють лише цю картку' };
    }
    return null;
  }

  /* Поповнення корп. карток у CRM за 60 днів: «рахунок з|отримувач» і «рахунок з|*» → (corpCard → скільки разів).
     Отримувач — з початку коментаря «Ім'я Прізвище: …», так його пише реєстр. */
  async function loadHistory(api, corpIds) {
    if (!api || !corpIds.length) return null;
    const pad = n => String(n).padStart(2, '0'), dash = x => `${pad(x.getDate())}-${pad(x.getMonth() + 1)}-${x.getFullYear()}`;
    const to = new Date(), from = new Date(to.getTime() - 60 * 864e5);
    const hist = new Map(), add = (k, id) => { const m = hist.get(k) || new Map(); hist.set(k, m); m.set(id, (m.get(id) || 0) + 1); };
    for (let p = 1; p <= 20; p++) {
      const j = await api.get(`invoice-payment?date_from=${dash(from)}&date_to=${dash(to)}&${corpIds.map(id => `invoice_ids[]=${id}`).join('&')}&per_page=500&page=${p}`);
      for (const r of (j && j.data) || []) {
        if (r.deleted_at) continue;
        const pays = (r.payments || []).filter(x => !x.deleted_at);
        const out = pays.find(x => Number(x.operation) === 4), inn = pays.find(x => Number(x.operation) === 3);
        if (!out || !inn || !corpIds.includes(Number(inn.invoice_id))) continue;
        const who = (/^\s*([^:]{3,60}):/.exec(r.comment || '') || [])[1];
        add(`${Number(out.invoice_id)}|*`, Number(inn.invoice_id));
        if (who) add(`${Number(out.invoice_id)}|${norm(who)}`, Number(inn.invoice_id));
      }
      if (!j || !j.last_page || p >= j.last_page) break;
    }
    return hist;
  }

  /* Лише погодження до дати to (рррр-мм-дд) включно: решту рядків реєстру прибрано з rows (на місці, до перевірки),
     тож вони не перевіряються й не вносяться. → {to, kept, dropped} або null, якщо to не задано. */
  function cutByDate(rows, to) {
    if (!to || !Array.isArray(rows)) return null;
    const before = rows.length;
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i] && isoOf(rows[i].date) > to) rows.splice(i, 1);
    return { to, kept: rows.length, dropped: before - rows.length };
  }

  /* Касовий метод (уточнення 07.11.2026: «всі зп і все відносимо до періоду, в якому була операція»): період запису — місяць
     дати оплати. Реєстр (Apps Script) ставив інакше: «з 1 по N число — попередній місяць» і «Період» зі стовпця погоджень — тут
     це прибрано. Лишається лише період, змінений у панелі кешфлоу («вручну»); закритий місяць далі переносить moveClosed.
     Рядки змінюються на місці. → {changed} */
  function cashPeriod(rows) {
    const out = { changed: 0 };
    for (const e of rows || []) {
      if (!e || e.done || e.periodSrc === 'вручну') continue;
      const m = /^(\d{2})-(\d{2})-(\d{4})/.exec(String(e.date || ''));
      if (!m) continue;
      const per = `01-${m[2]}-${m[3]}`;
      if (e.period === per && !e.periodManual) continue;
      Object.assign(e, { period: per, periodManual: false, periodSrc: '' });
      out.changed++;
    }
    return out;
  }

  /* Рядки з періодом закритого в CRM місяця (through — «закрито по РРРР-ММ») → період першого відкритого місяця: у закритий
     CRM не прийме («Внесіть операцію в новий відкритий період»). Дата оплати не змінюється. Рядки змінюються на місці;
     реєстр показує «період 11.2026 (10.2026 закрито в кешфлоу)». → {moved, from: ['10.2026'], to: '11.2026'} */
  function moveClosed(rows, through) {
    const open = M.openFrom(through), out = { moved: 0, from: [], to: open ? M.monthUa(open) : null };
    if (!open || !Array.isArray(rows)) return out;
    const per = `01-${open.slice(5, 7)}-${open.slice(0, 4)}`;
    for (const e of rows) {
      if (!e || e.done || !M.isClosedMonth(e.period, through)) continue;
      const was = M.monthUa(e.period);
      Object.assign(e, { period: per, periodManual: true, periodSrc: `${was} закрито в кешфлоу` });
      if (!out.from.includes(was)) out.from.push(was);
      out.moved++;
    }
    return out;
  }

  /* Корп. картку поповнюють лише з рахунку її власника (rules.json → reference.card_topup.same_owner, уточнення 30.10.2026):
     з ФОП Хоменко — на картку Хоменка, з ФОП Мазовецька — на картку Мазовецької, з ТОВ — на картку цього ТОВ.
     → { own — діючі картки власника рахунку «з» (null — власника не видно з назви, обмеження немає), owner — хто це,
         ok(id) — чи годиться картка: того самого власника і діюча (не «майбутня корп карта …», не неактуальна) }. */
  function topupScope(rulesDoc, invoices, fromId) {
    const ref = (rulesDoc && rulesDoc.reference) || {};
    const on = !(ref.card_topup && ref.card_topup.same_owner === false);
    const accs = Object.entries(invoices || {}).map(([id, a]) => ({ id: Number(id), name: (a && a.name) || '', deleted_at: a && a.deleted_at }));
    const from = (invoices || {})[fromId];
    const own = on && from ? Rc.ownerCards({ name: from.name }, accs) : null;
    const nameOf = id => ((invoices || {})[id] || {}).name || '';
    return { own, owner: own ? Rc.ownerOf(from.name) : null, ok: id => !Rc.CARD_OFF.test(nameOf(id)) && (!own || own.some(a => a.id === Number(id))) };
  }

  /* Рядки реєстру → за rules.json. rows — рядки реєстру (змінюються на місці, до перевірки реєстром);
     invoices — {id: {name, currency_id}} рахунки CRM; pnl — довідник статей реєстру [{name, cat, op, need}]
     (переказ між рахунками — cat 0 / op 0); hist — loadHistory або null. Повертає підсумок для вкладки. */
  function applyRules(rows, invoices, pnl, rulesDoc, hist, needMk) {
    invoices = invoices || {};
    pnl = pnl || [];
    const compiled = R.compileRules(rulesDoc);
    const cards = (rulesDoc && rulesDoc.reference && rulesDoc.reference.cards) || []; // корп. картки з довідника (перевипущені — номер не в назві)
    const tails = Rc.cardTails(Object.entries(invoices).map(([id, a]) => ({ id: Number(id), name: (a && a.name) || '' })), null, cards);
    const xfer = pnl.find(x => x.cat === 0 && x.op === 0);
    const nameOf = id => (invoices[id] || {}).name || `ID ${id}`;
    const today = new Date().toISOString().slice(0, 10);
    const sum = { checked: 0, transfers: 0, target: 0, owner: 0, category: 0, project: 0, marketer: 0, notes: [] };
    const cptyMks = (rulesDoc && rulesDoc.reference && rulesDoc.reference.counterparty_marketers) || []; // маркетолог за контрагентом (ФОП Власич → Сливко)
    for (const e of rows || []) {
      if (!e || e.done || e.taxOf || e.tax) continue;
      sum.checked++;
      const from = Number(e.invoice_id) || null, acc = from ? invoices[from] : null;
      const parts = [e.comment, e.content, e.recipient].map(x => String(x || '').trim()).filter(Boolean);
      const text = parts.filter((x, i) => !parts.slice(0, i).some(y => y.includes(x))).join(' · ');
      const date = isoOf(e.date);
      const num = v => (v == null || v === '' ? null : Number(v));
      const rec = { id: 0, date, period: e.period ? isoOf(e.period) : date.slice(0, 8) + '01', created: today, text, comment: text, n_payments: 1,
        type: e.transfer ? 'transfer' : 'expense', category_id: e.transfer ? null : num(e.pnl_category_id), operation_id: e.transfer ? null : num(e.pnl_operation_id),
        project_id: num(e.project_id), account_ids: from ? [from] : [], account_names: acc ? [acc.name] : [], amount: Number(e.amount) || 0, currency: '',
        is_lead: false, is_auto: false, is_salary: false };
      const res = R.evaluate(rec, compiled);
      const why = [];
      const xr = res && !e.transfer && res.applicable.find(r => r.set.type === 'transfer');
      if (xr) {
        if (!xfer) { sum.notes.push(`${e.key || ''}: за ${xr.id} це переказ, але в довіднику реєстру немає статті «Переказ між рахунками»`); continue; }
        Object.assign(e, { transfer: true, pnl_category_id: xfer.cat, pnl_operation_id: xfer.op, category: xfer.name, needCategory: false, badCategory: '', marketer: '', marketer_id: null });
        sum.transfers++;
      } else if (res && !e.transfer) {
        for (const ch of res.changes) {
          if (!ch.auto) continue;
          const rid = ((res.fields[ch.field] || {}).winners || []).map(r => r.id).join(', ');
          if (ch.field === 'category' && ch.to && ch.to.kind === 'article') {
            const opt = pnl.find(x => x.cat === ch.to.category_id && x.op === ch.to.operation_id);
            if (!opt) { sum.notes.push(`${e.key || ''}: за ${rid} стаття «${ch.toLabel}», але її немає в довіднику реєстру`); continue; }
            Object.assign(e, { pnl_category_id: opt.cat, pnl_operation_id: opt.op, category: opt.name, needCategory: false, badCategory: '' });
            sum.category++;
            why.push(`стаття «${opt.name}» — ${rid}`);
          } else if (ch.field === 'project' && ch.to != null) {
            Object.assign(e, { project_id: ch.to, location_id: ch.to });
            sum.project++;
            why.push(`проєкт «${ch.toLabel}» — ${rid}`);
          }
        }
      }
      // маркетолог за контрагентом (rules.json → reference.counterparty_marketers: «ФОП Власич …» → Євген Сливко) — для статті з рекламним
      // бюджетом, якщо реєстр маркетолога не дав; вибраного людиною не чіпаємо. «Потрібен маркетолог» — як у самому реєстрі: стаття
      // позначена в «Довіднику» (need) або CRM вимагає маркетолога (needMk — marketer_add_balance з CRM)
      const art = !e.transfer && pnl.find(x => x.cat === Number(e.pnl_category_id) && x.op === Number(e.pnl_operation_id));
      const cm = art && (art.need || (needMk && needMk[`${art.cat}:${art.op}`])) && !e.marketer_id ? Rc.cptyMarketer(cptyMks, text) : null;
      if (cm) {
        Object.assign(e, { marketer_id: cm.id, marketer: cm.name });
        sum.marketer++;
        why.push(`маркетолог «${cm.name}» — за контрагентом «${cm.cpty}»`);
      }
      // рахунок «куди» поповнення корп. картки: і для рядків, що щойно стали переказом за правилами, і для переказів, які реєстр
      // уже має переказом на корп. картку (його підказка з аркуша «Корпоративні картки» шукає людину в тексті й не дивиться,
      // з якого рахунку платять, — так поповнення з ФОП Мазовецька йшло на картку ТОВ)
      const topup = xr || (e.transfer && (e.to_invoice_id ? Rc.isCorp(invoices[e.to_invoice_id])
        : !!((R.evaluate({ ...rec, type: 'expense' }, compiled) || { applicable: [] }).applicable.find(r => r.set.type === 'transfer'))));
      if (topup) {
        const sc = topupScope(rulesDoc, invoices, from), was = Number(e.to_invoice_id) || null;
        // у власника кілька діючих карток (з 04.11.2026 — у кожного ФОП по дві): картку визначає номер у тексті, тримач чи отримувач
        const ctx = { cards, date, many: !!(sc.own && sc.own.length > 1) }, who = `${e.recipient || ''} · ${text}`;
        let to = null, foreign = null;
        // 16.11.2026: рахунок «куди», який закладка реєстру сама підставила з підказки аркуша «Корпоративні картки» (toAuto) ще до
        // цих правил, — не вибір людини: номер картки в тексті, тримач і історія сильніші за нього (інакше поповнення «картки 4546»
        // знову йшло б на 7850 — як 04.11.2026, лише іншим шляхом). Вибране людиною (стовпець «Куди (переказ)») не чіпається.
        const auto = !!(was && e.toAuto && e.toSuggest && Number(e.toSuggest.invoice_id) === was);
        if (!was || !sc.ok(was) || auto) {
          to = cardTarget(text, from, e.recipient, tails, hist, sc.ok, ctx);
          if (to && to.foreign) { foreign = to; to = null; }
          if (!to && !foreign && sc.own && sc.own.length === 1) to = { id: sc.own[0].id, why: `єдина картка ${sc.owner}` };
          const sug = e.toSuggest && invoices[e.toSuggest.invoice_id] ? Number(e.toSuggest.invoice_id) : null;
          if (!to && !foreign && sug && (auto || sug !== was) && sc.ok(sug) && !holderClash(cards, sug, date, who)) to = { id: sug, why: 'підказка реєстру' };
          e.to_invoice_id = to ? to.id : null;
          e.toAuto = !!to;
          // підпис «за аркушем «Корпоративні картки» реєстру» — лише коли картку справді дав реєстр
          if (e.toSuggest && (!to || to.id !== sug)) e.toSuggest = null;
        }
        const card = to ? `«${nameOf(to.id)}» (${to.why})` : '';
        const nums = (sc.own || []).map(a => Object.keys(tails).find(t => tails[t] === a.id) || Rc.nameTail(a) || `ID ${a.id}`);
        const pick = foreign ? `${foreign.why} — це картка «${nameOf(foreign.foreign)}» іншого власника, а платять з «${nameOf(from)}»: перевірте рахунок «з» або виберіть картку`
          : ctx.many ? `у ${sc.owner} ${nums.length} ${nums.length < 5 ? 'діючі корп. картки' : 'діючих корп. карток'} (${nums.join(', ')}) — виберіть картку; з номером картки в погодженні («поповнення корп картки ${nums[nums.length - 1]}») вона підбереться сама`
          : sc.owner ? `виберіть картку ${sc.owner}` : 'виберіть рахунок «куди»';
        if (was && !sc.ok(was)) {
          sum.owner++;
          why.push(`рахунок «куди»: «${nameOf(was)}» — ${Rc.CARD_OFF.test(nameOf(was)) ? 'цієї картки немає або рахунок неактуальний' : `картка іншого власника, а платять з «${nameOf(from)}» (корп. картку поповнюють лише з рахунку її власника)`}; ${card ? `стало ${card}` : pick}`);
        } else if (xr) why.push(`переказ на корп. картку${card ? ` ${card}` : was ? '' : ` — ${pick}`} — ${xr.id}`);
        else if (!was || (auto && e.to_invoice_id !== was)) why.push(`рахунок «куди» — ${card || pick}`);
        if (xr && e.to_invoice_id) sum.target++;
      }
      if (why.length) e.edited = [...new Set((e.edited || []).concat(why.map(w => `${w} (rules.json)`)))];
    }
    return sum;
  }

  /* Підказка реєстру для рахунку «куди», коли рядок стає переказом у таблиці реєстру (латка збірки REGISTRY_TO): номер картки
     в тексті чи її тримач (rules.json) — сильніші за підказку; картка іншого власника, ніж рахунок «з», чи картка, яку тепер тримає
     інша людина, замінюється карткою цього власника (якщо вона одна) або відкидається. */
  function ownerSuggest(row, sug, invoices, rulesDoc) {
    if (!row || !invoices) return sug;
    const sc = topupScope(rulesDoc, invoices, Number(row.invoice_id) || null);
    const accs = Object.entries(invoices).map(([id, a]) => ({ id: Number(id), name: (a && a.name) || '' }));
    const text = [row.comment, row.content, row.recipient].filter(Boolean).join(' · ');
    const cards = (rulesDoc && rulesDoc.reference && rulesDoc.reference.cards) || [], date = isoOf(row.date) || null;
    const t = cardTarget(text, Number(row.invoice_id) || null, row.recipient, Rc.cardTails(accs, null, cards), null, sc.ok,
      { cards, date, many: !!(sc.own && sc.own.length > 1) });
    const sugOk = !!(sug && invoices[sug.invoice_id] && sc.ok(sug.invoice_id) && !holderClash(cards, sug.invoice_id, date, `${row.recipient || ''} · ${text}`));
    if (t && t.id) return sug && Number(sug.invoice_id) === t.id ? sug : { invoice_id: t.id, name: invoices[t.id].name || '', why: t.why };
    // 16.11.2026: у тексті — номер картки іншого власника: хибний або рахунок «з», або номер — вирішує людина, як і в applyRules
    // (підказка реєстру тут не підставляється: рядок лишається з «потрібен рахунок «куди»»)
    if (t && t.foreign) return null;
    if (sugOk) return sug;
    const id =!t && sc.own && sc.own.length === 1 ? sc.own[0].id : null;
    return id ? { invoice_id: id, name: invoices[id].name || '', why: `єдина картка ${sc.owner}` } : null;
  }

  /* Рахунок «куди», вибраний вручну (редактор рядка чи таблиця реєстру; латка REGISTRY_TO): корп. картка іншого власника, ніж
     рахунок «з», або картка, якої ще немає, — текст відмови; інакше ''. Перекази не на корп. картку не обмежуються. */
  function ownerBad(fromId, toId, invoices, rulesDoc) {
    const to = (invoices || {})[toId];
    if (!to || !Rc.isCorp(to) || Number(fromId) === Number(toId)) return '';
    const sc = topupScope(rulesDoc, invoices, Number(fromId) || null);
    if (sc.ok(toId)) return '';
    if (Rc.CARD_OFF.test(to.name || '')) return `«${to.name}» — цієї картки ще немає або рахунок неактуальний: виберіть діючу картку`;
    const from = ((invoices || {})[fromId] || {}).name || `рахунок ${fromId}`;
    return sc.own && !sc.own.length ? `у кешфлоу немає корп. картки ${sc.owner}, а з «${from}» поповнюють лише її (rules.json → reference.card_topup)`
      : `корп. картку поповнюють лише з рахунку її власника: з «${from}» — лише на картку ${sc.owner} (rules.json → reference.card_topup)`;
  }

  /* «Довідник» реєстру — рахунки кешфлоу (аркуш «Довідник», стовпці A–E). За ним таблиця «Реєстр» перевіряє «Рахунок кешфлоу» (M)
     і «Куди (переказ)» (AA): рахунок, якого в «Довіднику» немає, Apps Script пише як «назва [id]», і перевірка його не пропускає —
     «Дані, введені в клітинку AA5, не відповідають установленим для неї правилам перевірки даних». «Довідник» оновлює лише кнопка
     ⚙ → «Оновити довідник у реєстрі» (дія ref): Apps Script 1.8 не віддає свій список рахунків, тож закладка реєстру сама його
     не оновлює. Тут — та сама дія ref, але змінюються лише рахунки: статті передаються порожнім списком (Apps Script лишає наявні),
     маркетологи — ті, що реєстр щойно віддав (R), тож вони теж не змінюються. Якщо реєстр їх ще не віддав (результати з черги
     відправляються на початку «1. Отримати й перевірити»), — з кешфлоу, як їх бере кнопка ⚙ (і вкладка «Звірка з банком»). */
  const MK_IDS = [193, 1249, 1324, 124, 208, 1297, 1328];
  const regAccounts = list => Object.values(list || {}).map(a => [Number(a && a.id), String(a && a.name != null ? a.name : '').trim(), Number(a && a.currency_id) || 0])
    .filter(a => a[0] > 0 && a[1]).sort((x, y) => x[0] - y[0]);
  const regMarketers = R2 => (R2 || []).map(m => [Number(m.id), String(m.name || '').replace(/\s*\[\d+\]\s*$/, '').trim()]).filter(m => m[0] > 0 && m[1]);
  const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
  const VALIDATION = /правилам перевірки даних|data validation/i;
  const ACC_MISSING = /рахунк\p{L}*\s+\S+\s+немає в довіднику реєстру/iu;
  const ACC_COLS = { M: '«Рахунок кешфлоу»', AA: '«Куди (переказ)»' }; // стовпці «Реєстру» з переліком рахунків «Довідника»
  const ACC_KEYS = ['transfer_to', 'transfer_name', 'invoice_id', 'invoice_name'];
  const withAccounts = p => !!p && ((p.fields && ACC_KEYS.some(k => p.fields[k] != null && p.fields[k] !== '')) ||
    (p.results || p.items || []).some(r => r && (ACC_KEYS.some(k => r[k] != null && r[k] !== '') || r.acc != null)));
  function renameIn(p, names) { // свіжі назви рахунків у тому, що реєстр запише ще раз
    const fix = (o, idK, nameK) => { if (o && nameK in o && names.has(Number(o[idK]))) o[nameK] = names.get(Number(o[idK])); };
    for (const o of [p.fields, ...(p.results || [])]) { fix(o, 'transfer_to', 'transfer_name'); fix(o, 'invoice_id', 'invoice_name'); }
  }
  function registryRef(o) { // o: { api, live }
    let recent = null; // {fp, at} — останнє оновлення «Довідника» з цієї панелі
    const KEY = 'cfl_reg_accounts'; // хеш реєстру (посилання) → відбиток рахунків кешфлоу, з якими «Довідник» оновлено востаннє
    const remember = (url, fp) => { if (!url) return; const s = LS.get(KEY, {}); s[fnv(String(url))] = fp; LS.set(KEY, s); };
    async function fresh(O) {
      if (o.api) { try { const j = await o.api.get('invoice?get_all=1'), a = Array.isArray(j) ? j : (j && j.data) || []; if (a.length >= 10) return regAccounts(a); } catch (e) { /* далі — рахунки, які реєстр уже прочитав */ } }
      return regAccounts(O && O.invoices);
    }
    // маркетологи для дії ref: ті, що реєстр віддав (без змін), інакше — з кешфлоу, як кнопка ⚙ (працюють і мають роль «маркетолог» /
    // «маркетинг» або є в її списку). → {list, crm}
    async function marketers(R2) {
      const own = regMarketers(R2);
      if (own.length || !o.api) return { list: own, crm: false };
      try {
        const j = await o.api.get('user/?all=true'), a = Array.isArray(j) ? j : (j && j.data) || [];
        return { list: a.filter(u => u && u.is_working !== false && ((u.role && /маркетолог|маркетинг/i.test(u.role.name || '')) || MK_IDS.includes(Number(u.id))))
          .map(u => [Number(u.id), String(u.name || '').trim()]).filter(m => m[0] > 0 && m[1]), crm: true };
      } catch (e) { return { list: [], crm: false }; }
    }
    async function push(list, mk, post, say, url, tail) {
      const r = await post({ action: 'ref', accounts: list, pnl: [], marketers: mk.list });
      const fp = fnv(JSON.stringify(list));
      recent = { fp, at: Date.now() };
      remember(url, fp);
      say(`«Довідник» реєстру: рахунки оновлено з кешфлоу — ${r && r.accounts != null ? r.accounts : list.length} (${mk.crm ? 'статті — без змін, маркетологи — з кешфлоу, як кнопкою ⚙' : 'статті й маркетологи — без змін'})${tail}.`, 'ok');
    }
    return {
      // «1. Отримати й перевірити»: реєстр не віддав свій список рахунків — оновити «Довідник», якщо рахунки кешфлоу змінилися
      // з минулого оновлення з цієї панелі (і один раз — уперше)
      async accounts(O, post, say, url, R2) {
        if (!o.live || !url || !O) return;
        const list = regAccounts(O.invoices);
        if (list.length < 10) return;
        const fp = fnv(JSON.stringify(list)), seen = LS.get(KEY, {});
        if (seen[fnv(String(url))] === fp) return;
        const mk = await marketers(R2);
        if (!mk.list.length) return;
        try { await push(list, mk, post, say, url, ''); }
        catch (e) {
          remember(url, fp); // до наступної зміни рахунків не повторювати
          say(`«Довідник» реєстру не оновлено: ${String(e.message).replace(/^Реєстр: /, '')} — натисніть ⚙ → «Оновити довідник у реєстрі».`, 'err');
        }
      },
      // реєстр не прийняв запис: рахунку немає в його «Довіднику» (новий чи перейменований у кешфлоу) — оновити «Довідник» і
      // повторити запис (один раз). → true — повторити
      async refused(p, err, post, say, again, O, url, R2) {
        err = String(err || '');
        const cell = (/(?:клітинк\p{L}*|cell)\s+([A-Z]{1,3})(\d+)/iu.exec(err) || []);
        const accCol = cell[1] ? ACC_COLS[cell[1].toUpperCase()] : null;
        if (!o.live || !p || p.action === 'ref' || p.action === 'accounts' || !withAccounts(p)) return false;
        if (!(VALIDATION.test(err) && (accCol || !cell[1])) && !ACC_MISSING.test(err)) return false;
        const where = accCol ? `стовпець ${accCol} аркуша «Реєстр», клітинка ${cell[1]}${cell[2]}` : 'аркуш «Реєстр»';
        if (again) {
          say(`Реєстр знову не прийняв запис (${where}), хоча «Довідник» щойно оновлено з кешфлоу. Мабуть, цей рахунок у кешфлоу неактуальний (у назві «неактуальн…» чи «not actual») — тоді його немає й у переліку «Довідника»: виберіть інший рахунок.`, 'err');
          return false;
        }
        const mk = await marketers(R2);
        if (!mk.list.length) { say(`Реєстр не прийняв рахунок (${where}): його немає в «Довіднику» реєстру. Натисніть ⚙ → «Оновити довідник у реєстрі» і збережіть ще раз.`, 'err'); return false; }
        const list = await fresh(O);
        if (list.length < 10) return false;
        const fp = fnv(JSON.stringify(list));
        if (recent && recent.fp === fp && Date.now() - recent.at < 10 * 60000) {
          say(`Реєстр не прийняв запис (${where}), хоча «Довідник» щойно оновлено з кешфлоу — мабуть, рахунок у кешфлоу неактуальний: виберіть інший.`, 'err');
          return false;
        }
        say(`Реєстр не прийняв рахунок (${where}): у його «Довіднику» немає цього рахунку — «Довідник» оновлювали до того, як рахунок завели чи перейменували в кешфлоу. Оновлюю «Довідник»…`);
        try { await push(list, mk, post, say, url, ' — записую ще раз'); }
        catch (e) { say(`«Довідник» реєстру не оновлено: ${String(e.message).replace(/^Реєстр: /, '')} — натисніть ⚙ → «Оновити довідник у реєстрі» і збережіть ще раз.`, 'err'); return false; }
        renameIn(p, new Map(list.map(a => [a[0], a[1]])));
        return true;
      },
    };
  }

  /* Той самий текст погодження й запису кешфлоу. Запис, внесений вручну, — скопійовані клітинки погодження («Отримувач⇥Хто
     погодив⇥Призначення»), реєстр пише «Отримувач: Призначення». Слова й числа без розділових знаків: числа — однакові з обох
     боків, слова погодження — щонайменше 90 % у записі, слова запису — щонайменше 75 % у погодженні. */
  const words = s => String(s || '').toLowerCase().replace(/[’ʼ'`]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  function sameText(a, b) {
    const A = new Set(words(a)), B = new Set(words(b));
    if (A.size < 3 || B.size < 3) return false;
    const nums = S => [...S].filter(w => /\d/.test(w));
    if (nums(A).some(w => !B.has(w)) || nums(B).some(w => !A.has(w))) return false;
    const n = [...A].filter(w => B.has(w)).length;
    return n / A.size >= 0.9 && n / B.size >= 0.75;
  }
  /* Підказка «та сама виплата двічі»: у пакеті перевірки ще рядок того самого отримувача з тією самою сумою й датою оплати —
     напр., податки, які реєстр рахує з рядка виплати («Податки 10 % з … (на руки …)»), і окреме погодження «податки із зп вище»
     (30.10.2026, Сидорук, двічі 909,78). Внесені, прив'язані до запису кешфлоу й «не вносити» не рахуються. → текст або '' */
  const NF2 = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rowSum = e => [e.amount, e.amountAccount, e.amountUah, e.rowAmount].map(Number).find(x => x > 0) || 0;
  const busyRow = e => !e.done && e.state !== 'журнал' && e.state !== 'вже є';
  function twinNote(row, rows) {
    const s = rowSum(row), w = words(row.recipient || row.recipientText).join(' '), d = String(row.date || '').slice(0, 10);
    if (!busyRow(row) || !s || !w || !d) return '';
    const twins = (rows || []).filter(r => r !== row && busyRow(r) && String(r.date || '').slice(0, 10) === d && Math.abs(rowSum(r) - s) < 0.005 &&
      words(r.recipient || r.recipientText).join(' ') === w);
    if (!twins.length) return '';
    const tax = [row, ...twins].some(r => /податк/i.test(`${r.comment || ''} ${r.category || ''}`));
    const other = String(twins[0].comment || twins[0].recipient || '').replace(/\s+/g, ' ').trim();
    return `у цьому пакеті ще ${twins.length === 1 ? 'рядок' : `${twins.length} рядки, напр.`} «${other.length > 70 ? other.slice(0, 70) + '…' : other}» на ${NF2.format(s)} тієї ж дати — `
      + `схоже на ${tax ? 'ті самі податки' : 'ту саму виплату'}: вносьте один, інший — «не вносити» (якщо це не окремі виплати)`;
  }
  /* «Можливий дубль» реєстру (та сама сума, але з іншого рахунку), який насправді та сама виплата: у кешфлоу запис з тим самим
     текстом, ще не прив'язаний до іншого рядка, і жоден інший рядок цієї перевірки з рахунком цього запису його не пояснює.
     row — рядок реєстру {comment, invoice_id, amount}; found — кандидати реєстру [{id, invoice_id, day, comment, taken}];
     rows — усі рядки перевірки. → кандидат або null */
  function sameDup(row, found, rows) {
    for (const f of found || []) {
      if (f.taken || !sameText(row.comment, f.comment)) continue;
      const mine = (rows || []).some(r => r !== row && !r.done && Number(r.invoice_id) === Number(f.invoice_id) &&
        Math.abs(Number(r.amount) - Number(row.amount)) < 0.005 && sameText(r.comment, f.comment));
      if (!mine) return f;
    }
    return null;
  }

  /* 16.11.2026. «Вже є» реєстру — це «та сама сума з того самого рахунку за ±3 дні»; ні тип запису, ні рахунок «куди», ні текст він
     не порівнює. Так погодження-витрата прив'язувалось до переказу на картку (і навпаки), поповнення картки 4546 — до переказу на
     7850 (у ФОП дві картки, круглі суми однакові), виплата одній людині — до запису про іншу: рядок мовчки ставав «вже є», у «Реєстр»
     ішов ID чужого запису, і погодження більше ніколи не пропонувалось. Латки REGISTRY_DUP дають кандидату op (тип платежу: 2 —
     витрата, 4 — переказ) і to (рахунок «куди» переказу).
     kindClash — інший тип або інший рахунок «куди»: текст, чим відрізняється, або ''. Кандидат без op (стара закладка) — ''. */
  function kindClash(row, f, nameOf) {
    if (!row || !f || f.op == null) return '';
    const nm = id => `«${nameOf ? nameOf(id) : `ID ${id}`}»`, xf = Number(f.op) === 4;
    if (!!row.transfer !== xf) return xf ? `там переказ${f.to ? ` на ${nm(f.to)}` : ''}, а погодження — витрата` : `там витрата, а погодження — переказ${row.to_invoice_id ? ` на ${nm(row.to_invoice_id)}` : ''}`;
    if (xf && f.to && row.to_invoice_id && Number(f.to) !== Number(row.to_invoice_id)) return `там переказ на ${nm(f.to)}, а погодження — на ${nm(row.to_invoice_id)}`;
    return '';
  }
  /* Витрата з того самого рахунку на ту саму суму, але про іншого отримувача: у коментарі запису немає жодного слова з отримувача
     погодження (прізвище — за першими 5 літерами, щоб «Петренку» = «Петренко») і текст не той самий. Порожній коментар чи
     отримувач — порівнювати нічого, не розбіжність. Перекази не перевіряються: у їхніх коментарях людини зазвичай немає. */
  function payeeClash(row, f) {
    if (!row || !f || row.transfer || f.op == null || Number(f.op) === 4) return false;
    const who = words(row.recipient || row.recipientText).filter(w => w.length >= 4 && !/\d/.test(w)), cw = words(f.comment);
    if (!who.length || !cw.length || sameText(row.comment, f.comment)) return false;
    return !who.some(w => cw.some(c => c.length >= 4 && c.slice(0, 5) === w.slice(0, 5)));
  }
  const cut60 = s => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > 60 ? s.slice(0, 60) + '…' : s; };
  /* Кандидати «вже є» (той самий рахунок і сума, ще не прив'язані) → ті, до яких можна прив'язати (латка REGISTRY_DUP,
     CF_REGISTRY_SAME): інший тип / рахунок «куди» — прибрано (рядок піде в «можливий дубль», див. dupFound); спершу — ті, де
     отримувача названо. Якщо найкращий — про іншого отримувача, рядок лишається «вже є», але без позначки і з row.cfLook:
     прив'язати його — рішення людини (позначка), а не панелі. */
  function sameFound(row, list, nameOf) {
    const ok = (list || []).filter(f => !kindClash(row, f, nameOf));
    const named = ok.filter(f => !payeeClash(row, f)), out = named.concat(ok.filter(f => !named.includes(f)));
    if (out.length && !named.length) {
      const f = out[0];
      row.cfLook = `схожий запис у кешфлоу: ID ${f.id} від ${f.day}, «${cut60(f.comment)}» — та сама сума з цього рахунку, але отримувача «${cut60(row.recipient || row.recipientText)}» `
        + 'в ньому не названо. Перевірте: якщо це та сама виплата — позначте рядок (прив’яжеться до цього запису, новий не створиться); '
        + 'якщо інша — не позначайте: внесіть її в кешфлоу з отримувачем у коментарі, тоді «1. Отримати й перевірити» прив’яже вже її';
    }
    return out;
  }
  /* «Можливий дубль» реєстру (CF_REGISTRY_DUP): 1) та сама виплата з іншого рахунку (sameDup) — позначку вимкнено; 2) запис на ту
     саму суму з цього рахунку, але іншого типу чи на іншу картку (kindClash) — не прив'язано й не внесено: row.cfLook каже, що
     перевірити; позначка — «це окрема виплата», тоді створиться новий запис. */
  function dupFound(row, found, rows, nameOf) {
    const hard = (found || []).filter(f => f.same && !f.taken && kindClash(row, f, nameOf));
    const f = sameDup(row, (found || []).filter(x => !hard.includes(x)), rows);
    if (f) { row.cfSame = { id: f.id, acc: f.invoice_id, day: f.day }; row.checked = false; } else delete row.cfSame;
    if (!f && hard.length) {
      const h = hard[0];
      row.cfLook = `схожий запис у кешфлоу: ID ${h.id} від ${h.day}${h.comment ? `, «${cut60(h.comment)}»` : ''} — та сама сума з цього рахунку, але ${kindClash(row, h, nameOf)}. `
        + 'Не прив’язано й не внесено — перевірте: якщо погодження — окрема виплата, позначте рядок (створиться новий запис); '
        + `якщо це вона й є — виправте запис ID ${h.id} у кешфлоу або статтю чи рахунок «куди» рядка (✎) і натисніть «1. Отримати й перевірити»`;
    }
  }

  /* «Потрібна правка в реєстрі» → рядки таблиці реєстру (уточнення 30.10.2026: внести можна й те, чого Apps Script не зрозумів).
     notReady — [{key, recipient, amountText, reason}] від Apps Script («Вносити» = «перевірити»; «так», але немає суми, дати оплати,
     рахунку чи період не розпізнано); bankRows — рядки «Реєстру» дією bank (лише читання): {key, date рррр-мм-дд, recipient, comment,
     action, status, id, acc, cur, amount (у валюті рахунку), amounts, textAmount, category, transfer, toAcc, tax, source}.
     Стаття — з реєстру, якщо вона є в «Довіднику» (pnl), інакше обирають у таблиці; рахунок — з реєстру чи «Звідки оплата», інакше
     обирають; період — місяць дати оплати (касовий метод, 07.11.2026); проєкт — Україна (змінити — ✎). Позначки немає
     (check): вносять, лише коли позначать; вибране в таблиці реєстр записує в «Реєстр» дією edit, як для інших рядків.
     Не додаються (лишаються в списку): податки ЗП, «ні», уже внесені, ті, що вже в таблиці, без дати. → {rows, left} */
  function fromNotReady(notReady, bankRows, ctx) {
    const byKey = new Map((bankRows || []).map(x => [String(x.key), x])), inv = ctx.invoices || {}, pnl = ctx.pnl || [];
    const p2 = n => String(n).padStart(2, '0'), rows = [], left = [];
    for (const n of notReady || []) {
      const x = byKey.get(String(n.key));
      if (!x || x.tax || x.id || (x.status && x.status !== 'помилка') || x.action === 'ні' || (ctx.have && ctx.have.has(String(x.key))) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(x.date || '')) { left.push(n); continue; }
      const lab = String(x.category || '').trim(), m = /\[(\d+):(\d+)\]\s*$/.exec(lab);
      const pn = lab ? pnl.find(p => p.name === lab) || (m ? pnl.find(p => p.id === `${m[1]}:${m[2]}`) : null) || null : null;
      const transfer = !!x.transfer || !!(pn && pn.cat === 0), acc = x.acc && inv[x.acc] ? Number(x.acc) : null;
      const [y, mo, d] = x.date.split('-').map(Number);
      const why = /^«перевірити» — перевірте в реєстрі/.test(n.reason || '') ? '«перевірити»' : String(n.reason || 'потрібна правка');
      const row = {
        key: String(x.key), date: `${p2(d)}-${p2(mo)}-${y} ${ctx.time || '12:00'}`, period: `01-${p2(mo)}-${y}`, periodManual: false, periodSrc: '',
        needAccount: true, invoice_id: acc, invoice_name: '', currency_id: null, currency: '', amount: null,
        rowAmount: (x.amounts || [])[0] || x.textAmount || null, rowCurrency: x.cur || 'UAH', amountAccount: null,
        amountUah: acc && Number(inv[acc].currency_id) === 1 && x.amount > 0 ? x.amount : null,
        source: x.source || '', recipient: x.recipient || n.recipient || '', recipientText: x.recipient || n.recipient || '',
        comment: x.comment || x.recipient || n.recipient || '', approvalDate: '', retry: false,
        pnl_category_id: pn && !transfer ? pn.cat : null, pnl_operation_id: pn && !transfer ? pn.op : null, category: pn ? pn.name : '',
        needCategory: !pn && !transfer, needMarketer: false, marketer_id: null, marketer: '', location_id: 1, project_id: 1,
        check: true, cfNotReady: true, checkNote: `у реєстрі ${why} — перевірте статтю, рахунок і суму тут (вибране запишеться в реєстр)`,
      };
      if (!pn && lab) row.badCategory = lab;
      if (acc) row.suggest = { invoice_id: acc, name: inv[acc].name || '', from: x.source || '' };
      if (transfer) Object.assign(row, { transfer: true, to_invoice_id: x.toAcc && inv[x.toAcc] ? Number(x.toAcc) : null, to_name: '' });
      rows.push(row);
    }
    return { rows, left };
  }
  // дата з ключа рядка реєстру («ДД.ММ.РРРР#…») → рррр-мм-дд або ''
  const keyDay = k => { const m = /^(\d{2})\.(\d{2})\.(\d{4})#/.exec(String(k || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const shiftDay = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const regDay = s => String(s || '').slice(6, 10) + String(s || '').slice(3, 5) + String(s || '').slice(0, 2); // «ДД-ММ-РРРР …» → ррррммдд

  /* Запит дублів рядка — точно той, що робить реєстр у перевірці (дата ± dupDays днів, та сама сума); k, v — його форматування й
     розбір дат («ДД-ММ-РРРР»). */
  function dupUrl(e, U, k, v) {
    const t = v(e.date), n = new Date(t), a = new Date(t);
    n.setDate(n.getDate() - U); a.setDate(a.getDate() + U);
    return `/api/invoice-payment?date_from=${k(n)}&date_to=${k(a)}&amount_from=${e.amount}&amount_to=${e.amount}&per_page=100`;
  }
  /* Запити по n одночасно, у порядку списку. → Map(url → Promise відповіді; null — запит не вдався, тоді реєстр спитає сам) */
  function pool(urls, get, n) {
    const map = new Map(), jobs = [];
    for (const url of urls) {
      if (map.has(url)) continue;
      let done;
      map.set(url, new Promise(r => { done = r; }));
      jobs.push(() => Promise.resolve().then(() => get(url)).then(done, () => done(null)));
    }
    let i = 0;
    const run = () => (i < jobs.length ? jobs[i++]().then(run) : null);
    for (let w = 0; w < n; w++) run();
    return map;
  }

  /* Поля таблиці реєстру з назвою рахунку, рахунку «куди», статті й маркетолога (у реєстрі — 200 px) — завширшки з назву, щоб було
     видно, на що вона закінчується (05.11.2026: «назви великі і не видно на що закінчуються»): ширина — за вибраним значенням чи
     введеним пошуком, від 200 до 560 px; таблиця реєстру прокручується вбік, якщо не вміщується. Повна назва — ще й у підказці. */
  const FIT = '#pogodzh-panel td input.pz-field[data-acc-in],#pogodzh-panel td input.pz-field[data-to-in],#pogodzh-panel td input.pz-field[data-cat-in],#pogodzh-panel td input.pz-field[data-mk-in]';
  let ruler = null;
  function textWidth(el, s) {
    if (!s) return 0;
    try {
      ruler = ruler || document.createElement('canvas').getContext('2d');
      const cs = getComputedStyle(el);
      ruler.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return ruler.measureText(s).width;
    } catch (e) { return s.length * 7.2; }
  }
  function fitField(el) {
    const s = [el.dataset.label, el.value, el.placeholder].filter(Boolean);
    const w = Math.round(Math.min(Math.max(...s.map(t => textWidth(el, t)), 0) + 34, 560));
    el.style.width = `${Math.max(w, 200)}px`;
    el.style.maxWidth = 'none'; // у реєстрі поля в рядку (.pz-in) — не ширші за 260 px
    el.title = el.dataset.label || el.value || '';
  }
  const fitFields = box => box.querySelectorAll(FIT).forEach(fitField);
  function mount(pane, box, opts) {
    opts = opts || {};
    const live = !!opts.live, doc = opts.rulesDoc || null;
    pane.innerHTML = `<div class="card" style="margin-bottom:12px">
<div class="row" style="margin:0"><span class="pill ${live ? 'st-fix' : 'st-review'}" data-ap="mode">${live ? 'Зміни дозволено — вносить у кешфлоу' : 'Перегляд — пробний режим'}</span>
<span class="muted">${live ? 'Погоджені витрати вносять кнопки реєстру «2. Внести 1 (тест)» і «3. Внести всі позначені». Далі — «Звірка з банком», потім «Статті й проєкти».'
    : 'Реєстр показує, що вніс би; ні таблиця погоджень, ні кешфлоу не змінюються. Вносити — у закладці «Лінтер кешфлоу (APPLY)».'}</span></div>
<div data-ap="rules" style="margin-top:10px"></div>
<div class="row" data-ap="again" hidden><span class="muted">Реєстр закрито.</span><button data-ap="open">Відкрити реєстр ще раз</button></div></div>`;
    const rulesBox = pane.querySelector('[data-ap="rules"]');
    // upTo — дата «по» (рррр-мм-дд, '' — без обмеження); cut — що прибрала остання перевірка
    let last = null, hist = null, histAt = 0, upTo = '', cut = null;
    const closedTo = () => (opts.closed ? opts.closed.get() : null);
    function draw() {
      const n = cut ? cut.kept : 0, rowsW = n % 10 === 1 && n % 100 !== 11 ? 'рядок' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'рядки' : 'рядків';
      let dates = !cut ? '' : `<div class="muted small">Дати: по ${esc(cut.to.split('-').reverse().join('.'))} — перевіряються й вносяться ${n} ${rowsW}${cut.dropped ? `; пізніших дат не показано: ${cut.dropped}` : ''}${!n && cut.dropped ? ' — дата «по» раніша за «з дати»?' : ''}.</div>`;
      if (closedTo()) dates += `<div class="muted small">Закрито в кешфлоу по ${esc(M.monthUa(closedTo()))}: погодження з періодом цих місяців вносяться з періодом ${esc(M.monthUa(M.openFrom(closedTo())))} (дата оплати — та сама).</div>`;
      if (!doc) { rulesBox.innerHTML = dates; return; }
      // правила rules.json діють завжди (перемикач прибрано 31.10.2026 на прохання користувача)
      let h = `<div class="muted small">Правила rules.json ${esc(String(doc.version || '').split(' ')[0])}: поповнення корп. картки — переказ на картку власника рахунку «з», стаття й проєкт — за правилами «виправити».`;
      if (last && !last.error) h += ` Остання перевірка: рядків ${last.checked}; переказів на корп. картку — ${last.transfers}${last.transfers ? ` (рахунок «куди» визначено: ${last.target}${last.target < last.transfers ? `, решту виберіть у реєстрі` : ''})` : ''}${last.owner ? `, картку іншого власника замінено — ${last.owner}` : ''}, стаття за правилами — ${last.category}, проєкт — ${last.project}${last.marketer ? `, маркетолог за контрагентом — ${last.marketer}` : ''}; змінені рядки позначено «змінено в панелі … (rules.json)».`;
      h += '</div>';
      if (last && last.error) h += `<div class="err">Правила не застосовано: ${esc(last.error)}</div>`;
      else if (last && last.notes.length) h += `<div class="warn" style="margin:6px 0 0">${last.notes.map(esc).join('<br>')}</div>`;
      rulesBox.innerHTML = h + dates;
    }
    // «Довідник» реєстру (латки збірки REGISTRY_REF): оновлення рахунків, коли кешфлоу їх змінив, і повтор запису, який реєстр не прийняв
    /* Чернетки CRM (латка збірки REGISTRY_DRAFTS, core/drafts.js): у режимі чернеток запити закладки реєстру йдуть через call —
       створення запису стає створенням чернетки, а пошук дублів і перевірка створеного бачать і чернетки. Вимкнено — як раніше. */
    let draftCall = null, draftS = null;
    root.CF_REGISTRY_DRAFTS = opts.drafts && CFD ? { on: () => opts.drafts.on(), isDraft: id => !!(draftCall && draftCall.isDraft(id)),
      call: (S, m, u, b) => { if (draftS !== S) { draftS = S; draftCall = CFD.registry(S); } return draftCall(m, u, b); } } : null;
    // напис угорі вкладки: куди реєстр вносить — у кешфлоу чи в чернетки CRM
    const modePill = () => { const p = pane.querySelector('[data-ap="mode"]'); if (p && live) p.textContent = opts.drafts && opts.drafts.on() ? 'Зміни дозволено — створює чернетки CRM' : 'Зміни дозволено — вносить у кешфлоу'; };
    modePill();
    if (opts.drafts && opts.drafts.subscribe) opts.drafts.subscribe(() => {
      dupCache = null; // запам'ятані відповіді пошуку дублів — для іншого режиму
      modePill();
      // рядки, перевірені в іншому режимі («вже є» могло означати чернетку), — перевірити заново (латка REGISTRY_DRAFTS)
      if (root.CF_REGISTRY_STALE) { try { root.CF_REGISTRY_STALE('режим чернеток змінено — натисніть «1. Отримати й перевірити»'); } catch (e) {} }
    }); // запам'ятані відповіді пошуку дублів — для іншого режиму
    const ref = registryRef({ api: opts.api, live });
    root.CF_REGISTRY_ACCOUNTS = (O, post, say, url, R2) => ref.accounts(O, post, say, url, R2);
    root.CF_REGISTRY_REFUSED = (p, err, post, say, again, O, url, R2) => ref.refused(p, err, post, say, again, O, url, R2);
    // підказка «куди» з таблиці реєстру (латка REGISTRY_TO) — лише картка власника рахунку «з»
    let lastInv = null;
    root.CF_REGISTRY_TO = (row, sug) => (doc && lastInv ? ownerSuggest(row, sug, lastInv, doc) : sug);
    // рахунок «куди», вибраний вручну, — картка власника рахунку «з» (інакше реєстр показує відмову й нічого не записує)
    root.CF_REGISTRY_TO_BAD = (fromId, toId) => (doc && lastInv ? ownerBad(fromId, toId, lastInv, doc) : '');
    // «можливий дубль» (латка REGISTRY_DUP): у кешфлоу та сама виплата з іншого рахунку — позначку вимкнено, новий запис не створюється
    // підказка в «Перевірці» (латка REGISTRY_TWINS): той самий отримувач, сума й дата ще в одному рядку пакета
    root.CF_REGISTRY_TWINS = (row, rows) => twinNote(row, rows);
    const accName = id => ((lastInv || {})[id] || {}).name || `ID ${id}`;
    root.CF_REGISTRY_DUP = (row, found, rows) => dupFound(row, found, rows, accName);
    // «вже є» (латка REGISTRY_DUP, 16.11.2026): прив'язувати лише до запису того самого типу й рахунку «куди»; інший отримувач — без позначки
    root.CF_REGISTRY_SAME = (row, list) => sameFound(row, list, accName);
    // перевірка дублів (латки REGISTRY_FAST): реєстр питав кешфлоу по одному рядку з паузою 300 мс; ті самі запити тепер ідуть наперед,
    // по 4 одночасно (ліміт кешфлоу — 360 запитів за хвилину), а реєстр бере відповідь звідси. Лише на час однієї перевірки:
    // повторна перевірка рядка (після правки, внесення) питає кешфлоу сама, свіжими даними.
    let dupCache = null;
    root.CF_REGISTRY_PREFETCH = (rows, U, k, v, S) => {
      dupCache = null;
      if (!rows || typeof S !== 'function') return;
      const urls = rows.filter(e => !e.done && e.date && Number(e.amount) >= 1 && (e.invoice_id || !e.needAccount)).map(e => dupUrl(e, U, k, v));
      dupCache = { at: Date.now(), map: pool(urls, url => S('GET', url), 4) };
    };
    root.CF_REGISTRY_CACHED = url => (dupCache && Date.now() - dupCache.at < 5 * 60000 && dupCache.map.get(url)) || null;
    // гачок у коді реєстру: викликається з рядками до їх перевірки (build вставляє виклик перед циклом перевірки); say — журнал реєстру
    // notReady — «Потрібна правка в реєстрі» (масив реєстру: що лишиться, те він покаже внизу); A — його запит до Apps Script;
    // prevDay («з 1 по N число» реєстру) з 07.11.2026 не діє: касовий метод — період за місяцем оплати (cashPeriod)
    root.CF_REGISTRY_ROWS = async (rows, O, L, say, notReady, A) => {
      lastInv = (O && O.invoices) || null;
      // «Потрібна правка в реєстрі» → рядки таблиці без позначки (дані — дією bank, лише читання); у списку внизу лишається решта
      if (Array.isArray(notReady) && notReady.length && typeof A === 'function') {
        const days = notReady.map(x => keyDay(x.key)).filter(Boolean).sort();
        try {
          if (days.length) {
            const bank = await A('bank', { from: shiftDay(days[0], -7), to: shiftDay(days[days.length - 1], 7) });
            const d0 = (rows.find(r => /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}/.test(r.date || '')) || {}).date;
            const res = fromNotReady(notReady, bank && bank.rows, { invoices: (O && O.invoices) || {}, pnl: L || [],
              time: d0 ? d0.slice(11, 16) : '12:00', have: new Set(rows.map(r => String(r.key))) });
            for (const r of res.rows) { const i = rows.findIndex(x => regDay(x.date) > regDay(r.date)); rows.splice(i < 0 ? rows.length : i, 0, r); }
            notReady.splice(0, notReady.length, ...res.left);
            const k = res.rows.length;
            if (k && typeof say === 'function') say(`«Потрібна правка в реєстрі»: ${k} ${k % 10 === 1 && k % 100 !== 11 ? 'рядок' : k % 10 >= 2 && k % 10 <= 4 && (k % 100 < 12 || k % 100 > 14) ? 'рядки' : 'рядків'} — у таблиці, без позначки: оберіть, чого бракує (стаття, рахунок, сума — ✎), і позначте, щоб внести; вибране запишеться в реєстр.`);
          }
        } catch (e) {
          if (typeof say === 'function') say(`Рядки «Потрібна правка в реєстрі» не додано в таблицю (${String(e.message).replace(/^Реєстр: /, '')}) — вони в списку внизу.`, 'err');
        }
      }
      cut = cutByDate(rows, upTo);
      if (cut && typeof say === 'function') say(`Лише погодження по ${cut.to.split('-').reverse().join('.')}: ${cut.kept} з ${cut.kept + cut.dropped}${cut.dropped ? ` (пізніших дат — ${cut.dropped}: не перевіряються й не вносяться)` : ''}.`);
      // касовий метод: період — місяць дати оплати (до перенесення із закритого місяця)
      const cp = cashPeriod(rows);
      if (cp.changed && typeof say === 'function') say(`Касовий метод: у ${cp.changed} ${cp.changed % 10 === 1 && cp.changed % 100 !== 11 ? 'рядку' : 'рядках'} період — місяць оплати (реєстр ставив попередній місяць за «з 1 по N число» чи «Період» з погоджень).`);
      const mv = moveClosed(rows, closedTo());
      if (mv.moved && typeof say === 'function') say(`Період ${mv.from.join(', ')} закрито в кешфлоу (по ${M.monthUa(closedTo())}): рядків ${mv.moved} вноситься з періодом ${mv.to}, дата оплати — та сама.`);
      if (!doc) { draw(); return; }
      try {
        const invoices = (O && O.invoices) || {};
        const corpIds = Object.entries(invoices).filter(([, a]) => Rc.isCorp(a)).map(([id]) => Number(id));
        if (opts.api && (!hist || Date.now() - histAt > 10 * 60000)) {
          try { hist = await loadHistory(opts.api, corpIds); histAt = Date.now(); } catch (e) { hist = null; }
        }
        last = applyRules(rows, invoices, L, doc, hist, O && O.needMk);
      } catch (e) { last = { error: e.message }; }
      draw();
    };
    // реєстр (латка збірки REGISTRY_CLOSED): CRM не створив запис, бо місяць закрито — панель запам'ятовує межу
    root.CF_PERIOD_CLOSED = per => { if (opts.closed) opts.closed.learn(per); };
    if (opts.closed) opts.closed.on(draw);
    draw();
    const again = pane.querySelector('[data-ap="again"]');
    const sync = () => { again.hidden = !!box.querySelector('#pogodzh-panel'); };
    // дата «по» поруч із «з дати» реєстру; вибір «з дати» ставить ту саму дату й сюди — тоді лише цей день
    function addTo() {
      const from = box.querySelector('#pogodzh-panel [data-el="from"]');
      if (!from || !from.closest('label') || box.querySelector('[data-cf="to"]')) return;
      from.closest('label').insertAdjacentHTML('afterend', '<label class="pz-from" title="Лише погодження до цієї дати включно: перевіряються й вносяться тільки вони. Порожньо — усі від «з дати». Коли вибираєте «з дати», сюди ставиться та сама дата — тоді лише цей день.">по <input class="pz-field" type="date" data-cf="to"></label>');
      const to = box.querySelector('[data-cf="to"]');
      to.value = upTo;
      const take = () => { upTo = to.value; };
      const follow = () => { if (from.value) { upTo = from.value; to.value = from.value; } };
      ['input', 'change'].forEach(ev => { to.addEventListener(ev, take); from.addEventListener(ev, follow); });
    }
    new MutationObserver(() => { sync(); addTo(); fitFields(box); }).observe(box, { childList: true, subtree: true });
    // пишуть у полі пошуку — поле росте разом із текстом
    box.addEventListener('input', e => { if (e.target && e.target.matches && e.target.matches(FIT)) fitField(e.target); });
    function run() {
      if (typeof root.CF_REGISTRY_RUN !== 'function') { pane.querySelector('.card').insertAdjacentHTML('beforeend', '<div class="err">У цій збірці немає реєстру погоджень.</div>'); return; }
      root.CF_REGISTRY_RUN(box, !live);
      setTimeout(sync, 800); // реєстр не відкрився (наприклад, не той сайт) — показати кнопку
    }
    pane.querySelector('[data-ap="open"]').onclick = run;
    run();
  }
  return { mount, applyRules, cardTarget, loadHistory, cutByDate, cashPeriod, moveClosed, topupScope, ownerSuggest, ownerBad, registryRef, regAccounts, regMarketers, sameText, sameDup, kindClash, payeeClash, sameFound, dupFound, dupUrl, pool, fromNotReady, twinNote };
}));
