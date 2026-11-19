    // ---------- перекази між своїми: список пропозицій ----------
    function xferHtml(all) {
      const props = S.lastProps = proposals(all);
      const prompts = all.flatMap(r => (r.R.own ? r.R.own.maybe.map(m => ({ r, m })) : []));
      const nMap = Object.keys(LS.get('cfl_own_map', {})).length;
      const reset = nMap ? `<div class="muted small" style="margin:10px 0 0">Збережений вибір рахунків «куди»: ${nMap} <span class="lnk" data-b="ownreset">скинути</span></div>` : '';
      if (!props.length && !prompts.length) return reset ? `<div class="card">${reset}</div>` : '';
      const can = !!opts.applyAllowed, on = props.filter(p => xok(p) && S.xp.get(p.key).on);
      const projOpt = sel => projects.map(([n, v]) => `<option value="${v}"${Number(v) === Number(sel) ? ' selected' : ''}>${esc(n)}</option>`).join('');
      let h = `<div class="card" data-b="xfer"><div class="sub-h"><h3>Перекази між своїми рахунками</h3><span class="muted small">у виписці є, у CRM немає${props.length ? ` · ${props.length}` : ''}${prompts.length ? ` · рахунок «куди» невідомий: ${prompts.length}` : ''}</span></div>
<details class="hint" style="margin:0 0 10px"><summary>Що створюється</summary><div>Переказ між своїми рахунками є у виписці (або корп. картка в CRM пішла в мінус), а в CRM переказу немає. Створюється запис «Переказ між рахунками» — той самий запит, що й у вашому реєстрі погоджень: та сама валюта, без статті. Нічого не позначено заздалегідь.</div></details>`;
      if (props.length) {
        h += `<div class="tbl" style="max-height:none"><table class="xf"><tr><th></th><th>Дата</th><th>З рахунку → на рахунок</th><th class="n">Сума</th><th>Проєкт</th><th>Коментар у CRM</th><th>Підстава</th></tr>`;
        for (const p of props) {
          const st = S.xp.get(p.key), dis = !xok(p);
          // поповнення цієї картки, можливо, вже є — записане на іншу картку власника («Поповнення не на ту картку» у «Виправити»)
          const rp = p.src === 'card' ? S.lastReps.filter(q => q.to === p.to && !q.block) : [];
          const rpNote = rp.length ? `<div class="warn" style="margin:4px 0 0;padding:4px 8px">можливо, поповнення вже є, але записане на картку ${esc([...new Set(rp.map(q => cardNum(q.was)))].join(', '))}: ${esc(rp.map(q => `ID ${q.item.id} (${dmy(q.date).slice(0, 5)}, ${fmt(q.amount)})`).join(', '))} — спершу <span class="lnk" data-go-sec="fix">«Виправити»</span> → «Поповнення не на ту картку»</div>` : '';
          const why = p.src === 'card' ? `«${nameOf(p.to)}»: у CRM зараз ${fmt(-p.amount)} — витрат з картки більше, ніж поповнень`
            : `${p.bank && p.bank.bank === 'mono' ? 'Моно' : 'Приват'} ${dmy(p.row.date)}${p.row.time ? ' ' + p.row.time : ''}: ${p.row.cpty || '—'} · ${p.row.purpose || ''}${p.twin ? ' (видно у виписках обох рахунків)' : ''}`;
          h += `<tr data-xk="${esc(p.key)}"${dis ? ' class="hid"' : ''}><td>${dis ? '' : `<input type="checkbox" data-xon${st.on ? ' checked' : ''}${can ? '' : ' disabled'}>`}</td><td>${esc(dmy(p.date))}</td>
<td>${esc(nameOf(p.from))} →<br>${esc(nameOf(p.to))}${!p.sameCcy ? '<div class="bad" style="font-weight:400">різна валюта рахунків — це «Обмін», внесіть вручну</div>' : p.old ? `<div class="bad" style="font-weight:400">до ${esc(dmy(fixFrom))} лінтер нічого не створює</div>`
  : p.other ? '<div class="bad" style="font-weight:400">картка іншого власника: корп. картку поповнюють лише з рахунку її власника — перевірте, чиї це покупки</div>'
  : p.typeNote ? `<div class="bad" style="font-weight:400">${esc(p.typeNote).replace('«Виправити»', '<span class="lnk" data-go-sec="fix">«Виправити»</span>')}</div>` : ''}${rpNote}</td>
<td class="n">${p.src === 'card' && can && !dis ? `<input class="man" data-xamt value="${esc(Number(st.amount).toFixed(2).replace('.', ','))}" inputmode="decimal" title="Суму поповнення можна змінити">` : esc(fmt(st.amount))}</td>
<td><select data-xproj${can && !dis ? '' : ' disabled'}>${projOpt(st.proj)}</select></td>
<td><textarea class="xcom" data-xcom rows="${comRows(st.comment)}"${can && !dis ? '' : ' disabled'}>${esc(st.comment)}</textarea></td><td class="muted xwhy">${esc(why)}</td></tr>`;
        }
        h += `</table></div><div class="row" style="margin-top:8px"><button class="primary" data-b="xcreate"${can && on.length && !S.busy ? '' : ' disabled'}>Створити позначені (${on.length})</button>
${can ? '<button class="quiet" data-b="xall">Позначити всі</button><button class="quiet" data-b="xnone">Зняти позначки</button>' : ''}
<span class="muted small">${can ? 'Уперше створіть один переказ і перевірте його в CRM — потім решту.' : 'Створювати перекази можна в закладці «Лінтер кешфлоу (APPLY)»; тут — лише перегляд.'}</span></div>`;
      }
      if (prompts.length) {
        h += `<div style="margin-top:14px"><div class="lbl">Схоже на переказ між своїми — виберіть рахунок «куди» <span style="font-weight:400">(вибір запам'ятається за рахунком контрагента)</span></div>`;
        for (const { r, m } of prompts) {
          const x = m.row, opts2 = S.accs.filter(a => a.currency_id === r.a.currency_id && a.id !== r.a.id).sort((p, q) => (Rc.isCorp(q) - Rc.isCorp(p)) || p.name.localeCompare(q.name, 'uk'));
          h += `<div class="pr">${esc(dmy(x.date))} <b>${esc(fmt(x.amount))}</b> · «${esc(r.a.name)}» · ${esc(x.cpty || '—')} · ${esc(x.purpose || '')} <span class="muted">(${esc(m.why)})</span>
 <select data-own="${esc(m.key)}"><option value="">— куди —</option><option value="0">не переказ між рахунками CRM — внести витратою чи надходженням</option>${opts2.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>`;
        }
        h += '</div>';
      }
      return h + reset + '</div>';
    }
    function bindXfer() {
      const box = $('out'), keyOf = e => e.closest('[data-xk]').dataset.xk, q = k => box.querySelector(`[data-b="${k}"]`);
      // галочка — лише лічильник на кнопці, без перемальовування (перерахунок звірки на кожен клік був помітним)
      const upd = () => { const n = S.lastProps.filter(p => xok(p) && S.xp.get(p.key).on).length, b = q('xcreate');
        if (b) { b.textContent = `Створити позначені (${n})`; b.disabled = !(opts.applyAllowed && n && !S.busy); } };
      box.querySelectorAll('[data-xon]').forEach(e => e.onchange = () => { S.xp.get(keyOf(e)).on = e.checked; upd(); });
      box.querySelectorAll('[data-xproj]').forEach(e => e.onchange = () => { S.xp.get(keyOf(e)).proj = +e.value; LS.set('cfl_xfer_proj', +e.value); });
      box.querySelectorAll('[data-xcom]').forEach(e => { comField(e); e.onchange = () => { S.xp.get(keyOf(e)).comment = oneLine(e.value); }; });
      box.querySelectorAll('[data-xamt]').forEach(e => e.onchange = () => {
        const v = parseNum(e.value);
        if (v === null || v <= 0) { e.classList.add('badin'); e.title = 'Потрібна сума більше нуля, наприклад 12 345,67'; return; }
        e.classList.remove('badin');
        S.xp.get(keyOf(e)).amount = r2(v);
      });
      box.querySelectorAll('[data-own]').forEach(e => e.onchange = () => {
        if (e.value === '') return;
        const map = LS.get('cfl_own_map', {});
        map[e.dataset.own] = Number(e.value) || 0;
        LS.set('cfl_own_map', map);
        S.bv++;
        render();
      });
      if (q('xall')) q('xall').onclick = () => { S.lastProps.filter(xok).forEach(p => { S.xp.get(p.key).on = true; }); render(); };
      if (q('xnone')) q('xnone').onclick = () => { S.lastProps.forEach(p => { S.xp.get(p.key).on = false; }); render(); };
      if (q('xcreate')) q('xcreate').onclick = () => createMany(S.lastProps.filter(p => xok(p) && S.xp.get(p.key).on), XFER);
      if (q('ownreset')) q('ownreset').onclick = () => { LS.set('cfl_own_map', {}); S.bv++; render(); };
    }

    // ---------- операції банку, яких немає в CRM: список «створити запис» ----------
    // рахунок CRM для операції: покупка корп. карткою (номер у призначенні) — на corpCard, що звіряється з цим рахунком; інакше — сам рахунок
    const targetOf = (x, r) => { const t = Rc.cardTail(x.purpose), k = t && S.dir.cards[t]; return k && (r.cards || []).includes(k) ? k : r.a.id; };
    /* Маркетолог за контрагентом (rules.json → reference.counterparty_marketers): «ФОП Власич Оксана …» → Євген Сливко. {id, n: 0, sure: true, name, cpty} або null. */
    const CPTY_MK = (opts.rulesDoc && opts.rulesDoc.reference && opts.rulesDoc.reference.counterparty_marketers) || [];
    const cptyMk = x => { const m = Rc.cptyMarketer(CPTY_MK, `${x.cpty || ''} ${x.purpose || ''}`); return m ? { id: m.id, n: 0, sure: true, name: m.name, cpty: m.cpty } : null; };
    /* Маркетолог покупки корп. карткою — хто тримає картку на дату покупки (CARDS → holders). {id, n: 0, sure: true, holder, from} або null. */
    const VENDOR_PEOPLE = ((opts.rulesDoc && opts.rulesDoc.reference && opts.rulesDoc.reference.vendor_people) || []).map(v => { try { return { ...v, re: new RegExp(v.vendor_regex, 'iu') }; } catch (e) { return null; } }).filter(v => v && v.person);
    const vendorPerson = x => VENDOR_PEOPLE.find(v => v.re.test(` ${x.purpose || ''}`)) || null;
    function holderMk(acc, x) {
      const c = CARDS.find(c => Number(c.account_id) === acc);
      const h = c && holderOf(c, Rc.cardDate(x.purpose) || x.date);
      // картку тримають двоє (holders[].also) — хто саме купував, з виписки не видно: маркетолога вибирає людина
      const id = h && !(h.also && h.also.length) && S.mks && S.mks.length ? mkByName(S.mks, h.name) : null;
      return id ? { id, n: 0, sure: true, holder: h.name, from: h.from || '' } : null;
    }
    /* Операції банку без пари в CRM (periodRecon → missing.bank) → пропозиції створити запис. Перекази між своїми — у списку переказів;
       те, що лінтер не створює (зарплата, еквайринг, «за правилом — переказ», сума є в CRM з іншою датою, дата до межі роботи), — з причиною в block. */
    /* Пакет ЗП Привату для переказу на транзитний рахунок: у виписці транзитного рахунку («Ціл-ві зарах.») той самий день і сума —
       «#…#ПОПОВНЕННЯ ЗП/КАРТОК ПРОМIНЬ. Пакет:261103PB000059296003,реф.проєкту:…,карток:1». → {id, cards} або null */
    function payPacket(x) {
      for (const b of S.banks) {
        if (b.cfId || !(S.dir && S.dir.pay && S.dir.pay.has(b.iban))) continue;
        const y = b.rows.find(y => y.date === x.date && Math.round(y.amount * 100) === Math.round(x.amount * 100) && /пакет/i.test(y.purpose || ''));
        const m = y && /пакет\s*:?\s*([0-9A-Z]{8,})/i.exec(y.purpose), k = y && /карток\s*:?\s*(\d+)/i.exec(y.purpose);
        if (m) return { id: m[1], cards: k ? Number(k[1]) : null };
      }
      return null;
    }
    /* ЗП через транзитний рахунок (переказ «Заробітна плата за жовтень 2026» на «Ціл-ві зарах.…»): поштучно з CRM не звіряється — у CRM
       ЗП вносять по людях, а банк платить одним переказом на пакет. З 05.11.2026 такий переказ теж видно в «Внести в CRM» (раніше —
       лише підсумком під рахунком), з пакетом Привату й тим, скільки записів ЗП за період без пари в банку є на рахунку: внести його
       можна, якщо цієї ЗП у CRM ще немає (стаття зарплатна — ризиковано). */
    // статті ЗП, якими на рахунку вже записано ЗП (за кількістю записів) — підказка для ЗП через транзит: [{art, n}]
    function salaryArtsOf(items) {
      const cnt = new Map();
      for (const c of items || []) if (c.opc === 2 && c.art && salaryArt(c.art) && !c.lead) cnt.set(c.art, (cnt.get(c.art) || 0) + 1);
      return [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([art, n]) => ({ art, n }));
    }
    function payComment(x) {
      const pk = payPacket(x);
      return `${clean(x.purpose) || 'Заробітна плата'}${pk ? ` (пакет Привату №${pk.id} від ${dmy(x.date).slice(0, 5)}${pk.cards ? `, карток: ${pk.cards}` : ''})` : ''}`.slice(0, 250);
    }
    /* історія рахунку (120 днів до періоду) і записи періоду — одним масивом, той самий об'єкт, поки ті самі масиви: на ньому
       тримається кеш схожості (simBase), тож слова й частоти рахуються раз на рахунок, а не на кожну операцію */
    const PAST = new Map(), NONE = [];
    function pastOf(acc) {
      const h = S.hist.get(acc) || NONE, i = (S.items && S.items.get(acc)) || NONE;
      let v = PAST.get(acc);
      if (!v || v.h !== h || v.i !== i || v.n !== h.length + i.length) PAST.set(acc, v = { h, i, n: h.length + i.length, list: h.concat(i) });
      return v.list;
    }
    /* Підписка юриста (доступ до платформи) серед надходжень (16.11.2026): сума дорівнює ціні тарифу з rules.json → reference.subscriptions
       (Start / PRO / PREMIUM на 1, 3 чи 12 місяців; платник міг округлити на гривню вгору: 1 699 → 1 700). Замовлення в CRM для неї немає,
       тож це не «оплата клієнта через лід», а запис зі статтею «Підписки юристів» і коментарем, як їх пишуть у CRM:
       «Підписка PRO 1 міс. — Квітка Дар'я Ігорівна: переказ 02.10.2026 на «ФОП … Універсал»». Впевнено — коли й призначення про
       програмний продукт; лише сума — «перевірте». → {plan, months, price, sure} або null. */
    const SUBS = (opts.rulesDoc && opts.rulesDoc.reference && opts.rulesDoc.reference.subscriptions) || null;
    const SUB_RE = SUBS && SUBS.purpose_regex ? new RegExp(SUBS.purpose_regex, 'iu') : null;
    const SUB_ART = SUBS && ARTS.some(a => a.key === SUBS.article && a.type === 1) ? SUBS.article : '';
    function subOf(x, acc) {
      // лише гривневий рахунок (449,00 EUR — не тариф) і не повернення коштів (огляд 16.11.2026)
      const a = S.accs.find(v => v.id === acc);
      if (!SUB_ART || !(x.amount > 0) || !a || Number(a.currency_id) !== 1 || /поверн/iu.test(cyr(x.purpose))) return null;
      const c = Math.round(x.amount * 100);
      for (const pl of SUBS.plans || []) for (const [m, price] of Object.entries(pl.prices || {})) {
        const pc = Math.round(Number(price) * 100);
        if (c === pc || c === pc + 100) return { plan: pl.name, months: Number(m), price: Number(price), sure: !!SUB_RE && SUB_RE.test(cyr(x.purpose)) };
      }
      return null;
    }
    // платник підписки: «… від Голованівської Наталії Миколаївни» в призначенні — за кого платять; контрагент — хто переказав
    function subComment(x, s, acc) {
      // транзитний рахунок банку чи платіжної системи — не платник
      const who = /транз\.?\s*рахунок|^GO_|(?:^|\s)(?:АТ|ПАТ|АБ)\s|банк/iu.test(cyr(x.cpty)) ? '' : clean(x.cpty), m = /\sвід\s+(\p{Lu}[\p{L}'’ʼ-]+(?:\s+\p{Lu}[\p{L}'’ʼ-]+){1,2})/u.exec(clean(x.purpose)), forWhom = m ? m[1] : '';
      const name = forWhom && who && !forWhom.toLowerCase().startsWith(who.toLowerCase().split(' ')[0].slice(0, 4)) ? `${forWhom} (платник ${who})` : who || forWhom || 'платник';
      return `Підписка ${s.plan} ${s.months} міс.${Math.round(x.amount * 100) !== Math.round(s.price * 100) ? ` (${fmt(s.price)} → ${fmt(x.amount)})` : ''} — ${name}: переказ ${dmy(x.date)} на «${nameOf(acc)}»`.slice(0, 250);
    }
    /* Пакет(и) ЗП, з якого сплачено податок x (16.11.2026): банк платить ВЗ і ПДФО тією самою хвилиною, що й пакет, і кожен дорівнює
       пакет / 18 (на руки / 0,9 × 5 %) — прив'язка за сумою; ЄСВ (1,00 чи справжній) і податок з іншою сумою — до пакетів тієї самої
       хвилини (± 2 хв: 13.11.2026 податки о 14:35, пакет о 14:36). pays — перекази рахунку на транзит. → рядки виписки (зазвичай один) */
    const minOf = t => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    function taxPackets(pays, x) {
      const day = pays.filter(y => y.date === x.date), c = Math.abs(Math.round(x.amount * 100));
      if (!day.length) return [];
      const byAmt = ESV_RE.test(cyr(x.purpose)) ? [] : day.filter(y => Math.abs(Math.round(Math.abs(y.amount) * 100 / 18) - c) <= 1);
      if (byAmt.length) return byAmt;
      const t = minOf(x.time);
      return t === null ? [] : day.filter(y => { const u = minOf(y.time); return u !== null && Math.abs(u - t) <= 2; });
    }
    // стаття реєстру погоджень («Назва [категорія:операція]») → стаття панелі (витрата), якщо така є
    const artOfCat = lab => { const m = /\[(\d+):(\d+)\]\s*$/.exec(String(lab || '')), k = m ? `${m[1]}/${m[2]}` : ''; return k && ARTS.some(a => a.key === k && a.type === 2) ? k : ''; };
    function recProposals(all) {
      const out = [], t0 = today();
      for (const r of all) {
        const R = r.R;
        if (!R.missing || !r.b || r.status === 'ccy') continue;
        const payB = r.b.rows.filter(y => { if (!(y.amount < 0)) return false; const k = R.own && R.own.kinds.get(y); return k ? k.kind === 'pay' : Rc.payRow(y, S.dir); });
        // запис CRM з парою 1:1 до платежу податку банку — податок цілим платежем (ЄСВ 1,00, ПДФО рядком виписки, щойно внесений тут), а не
        // «податки по людях»: він не блокує ВЗ чи ПДФО того дня як «дубль» (08.11.2026). Запис по людях («Податки 10 % з …», «…*2= … податки
        // із …») лишається, навіть з парою: його сума може випадково дорівнювати ВЗ дня (5 % + 5 % з двох однакових ЗП = 10 % з однієї)
        const taxWhole = new Set([...(R.pairs || [])].filter(([y, c]) => PAY_TAX_RE.test(cyr(y.purpose)) && (TAX_PAID.test(cyr(c.comment)) || !TAX_PERSON.test(cyr(c.comment)))).map(([, c]) => c));
        const near = new Map(R.amounts.filter(a => a.near.length).map(a => [Math.round(a.amount * 100), a.near]));
        // ЗП через транзитний рахунок — окремі рядки рахунку; у примітці — записи ЗП за період без пари в банку
        const payC = R.pay ? R.pay.crm : [], payCtx = { n: payC.length, sum: r2(-payC.reduce((s, c) => s + c.amount, 0)) };
        const list = R.missing.bank.filter(x => R.kinds.get(x) !== 'own').map(x => [x, false]).concat((R.pay ? R.pay.bank : []).map(x => [x, true]));
        for (const [x, isPay] of list) {
          const c = isPay ? { src: 'pay' } : classify(x), cents = Math.round(x.amount * 100), acc = isPay ? r.a.id : targetOf(x, r);
          const src = c.src || (x.amount < 0 ? 'exp' : 'inc'), op = x.amount < 0 ? 2 : 1;
          const p = { src, op, acc, bankAcc: r.a.id, amount: r2(Math.abs(x.amount)), date: x.date, time: x.time, row: x, bank: r.b, comment: isPay ? payComment(x) : recComment(x, src),
            block: c.block || '', payroll: c.payroll || '', payRow: isPay, payCtx: isPay ? payCtx : null, packet: isPay ? payPacket(x) : null };
          p.key = `rec:${acc}:${cents}:${x.date}:${x.ref || r.b.rows.indexOf(x)}`;
          // покупка корп. карткою: у CRM — за датою (і часом) покупки з призначення, а не за днем проведення банком (07.11.2026)
          const card = op === 2 && !!Rc.cardTail(x.purpose) && Rc.isCorp(S.accs.find(a => a.id === acc)), buy = card ? Rc.cardDate(x.purpose) : null;
          if (buy && buy !== x.date) { p.buy = buy; p.buyTime = cardTime(x.purpose); }
          const rec0 = { id: 0, date: x.date, period: x.date.slice(0, 8) + '01', created: t0, text: p.comment, comment: p.comment, n_payments: 1,
            type: op === 1 ? 'income' : 'expense', category_id: null, operation_id: null, project_id: null, account_ids: [acc], account_names: [nameOf(acc)], amount: p.amount,
            currency: '', is_lead: false, is_auto: false, is_salary: false };
          p.rule = ruleHints(compiled, rec0);
          const sub = !isPay && src === 'inc' && !p.block ? subOf(x, acc) : null;
          // лише сума тарифу (без слів про програмний продукт) — тільки підказка: кругла сума — здебільшого оплата замовлення (ліда)
          if (sub && !sub.sure) p.sub = sub;
          if (sub && sub.sure) {
            p.sub = sub; p.comment = subComment(x, sub, acc);
            if (!p.rule.art) p.rule = { ...p.rule, art: { art: SUB_ART, sure: sub.sure, why: `підписка юриста ${sub.plan} на ${sub.months} міс.: сума тарифу ${fmt(sub.price)}${sub.sure ? ' і призначення про програмний продукт' : ''}` } };
          }
          // переказ на особисту картку власника ФОП (не рахунок CRM): у CRM — витрата за тим, на що пішли гроші
          if (R.own && R.own.kinds.get(x) && R.own.kinds.get(x).kind === 'card') p.ownCard = R.own.kinds.get(x).why;
          if (!p.block && near.has(cents)) p.block = `у CRM є запис з цією сумою з іншою датою: ${near.get(cents).map(o => `ID ${o.id} від ${dmy(o.date)}`).join(', ')}`;
          if (!p.block && p.rule.transfer) p.block = `за правилом ${p.rule.transfer} це переказ між рахунками — внесіть його переказом`;
          if (!p.block && fixFrom && (p.buy || x.date) < fixFrom) p.block = `до ${dmy(fixFrom)} лінтер нічого не створює`;
          const past = pastOf(acc);
          // податок із ЗП з рахунку ТОВ — група «рахунок | день | місяць у призначенні»; стаття — лише з попередніх платежів податків,
          // внесених одним записом («… Сплата ПДФО за вересень 2026»), а не за випадковими словами
          if (!isPay && op === 2 && PAY_TAX_RE.test(cyr(x.purpose)) && /^ТОВ\s/.test(Rc.ownerOf(nameOf(acc)) || '')) {
            p.taxKey = `${acc}|${x.date}|${((TAX_MONTH.exec(cyr(x.purpose)) || [])[1] || '').toLowerCase()}`;
            p.taxName = taxName(x.purpose);
            // пакет ЗП цього податку й ВЗ + ПДФО банку з того самого пакета — для «податки цієї ЗП вносяться по людях» (нижче, з «Зіставленням ШІ»)
            p.taxPk = taxPackets(payB, x);
            if (p.taxPk.length) {
              const pk = new Set(p.taxPk);
              p.taxBank = r2(r.b.rows.filter(y => y.date === x.date && y.amount < 0 && PAY_TAX_RE.test(cyr(y.purpose)) && !ESV_RE.test(cyr(y.purpose)) && taxPackets(payB, y).some(z => pk.has(z))).reduce((s, y) => s - y.amount, 0));
            }
            /* податки дня вже є в CRM по людях («Податки 10 % з …», «9405,56*2=…»), але сума інша (частину внесли іншим днем, когось
               не внесли): ВЗ чи ПДФО цілим платежем не пропонується — буде дубль (08.11.2026, звірка жовтня). ЄСВ по людях не вносять — його можна. */
            if (!p.block && !ESV_RE.test(cyr(x.purpose))) {
              // запис про податки із ЗП: по людях (TAX_PERSON) або з назвою податку; не «(разом з податками)» у ЗП, не єдиний податок і не ЄСВ самого ФОП
              const taxRec = c => { const t = cyr(c.comment); return c.amount < 0 && c.opc === 2 && Rc.TAX_REC.test(c.comment || '') && !/коміс\p{L}*\s+liqpay/iu.test(c.comment || '') && !taxWhole.has(c) && (TAX_PERSON.test(t) || !TAX_OTHER.test(t)); };
              const day = (r.cf || []).filter(c => c.date === x.date && taxRec(c));
              // день, коли банк сам платив ВЗ чи ПДФО, — податки по людях того дня належать його платежам, а не цьому (огляд 16.11.2026)
              const taxDaysB = new Set(r.b.rows.filter(y => y.amount < 0 && y.date !== x.date && PAY_TAX_RE.test(cyr(y.purpose)) && !ESV_RE.test(cyr(y.purpose))).map(y => y.date));
              // податки по людях без пари в банку за сусідні дні (±3): їх внесли іншим днем, ніж банк сплатив (13.10.2026: у банку одним днем, у CRM — 12, 14 і 15.10)
              const nearP = day.length ? [] : ((R.missing && R.missing.crm) || []).filter(c => c.date !== x.date && !taxDaysB.has(c.date) && Math.abs(dayDiff(c.date, x.date)) <= 3 && taxRec(c) && TAX_PERSON.test(cyr(c.comment)));
              if (nearP.length) {
                const ds = [...new Set(nearP.map(c => c.date))].sort();
                p.block = `у CRM поруч (${ds.map(dmy).join(', ')}) є податки по людях без пари в банку: ${nearP.length} ${plural(nearP.length, 'запис', 'записи', 'записів')} на ${fmt(Math.abs(r2(nearP.reduce((t, c) => t + c.amount, 0))))} — схоже, цей платіж уже внесено по людях іншою датою; цілим не вносьте, інакше буде дубль (різницю перевірте в записах по людях)`;
              }
              if (day.length) {
                const bd = r.b.rows.filter(y => y.date === x.date && y.amount < 0 && PAY_TAX_RE.test(cyr(y.purpose)) && !ESV_RE.test(cyr(y.purpose)));
                const s = l => fmt(Math.abs(r2(l.reduce((t, y) => t + y.amount, 0))));
                p.block = `у CRM за ${dmy(x.date)} уже є податки по людях: ${day.length} ${plural(day.length, 'запис', 'записи', 'записів')} на ${s(day)} (у банку ВЗ + ПДФО за день — ${s(bd)}) — платіж податку цілим не вносьте, інакше буде дубль; різницю перевірте в записах по людях`;
              }
            }
          }
          // ЗП через транзит: статтю не вгадуємо (зарплатну потім не змінити) — лише підказка, якими статтями ЗП рахунку вже записано.
          // Податок із ЗП — теж без історії (16.11.2026): три платежі 06.11.2026, внесені цілими з «Розробкою», стали «історією» для всіх
          // наступних податків ПРИКЛАД (і відділу продажів) — кожен внесений так податок підсилював помилку. Стаття податку — від його ЗП (нижче)
          if (!p.rule.art && !isPay && !p.taxKey) p.hist = histArt(past, x, op);
          if (isPay || p.taxKey) p.payArts = salaryArtsOf(past);
          // скільки таких операцій (сума, знак, рахунок CRM) у виписці за ±3 дні — для перевірки дублів перед створенням
          p.peers = r.b.rows.filter(y => Math.round(y.amount * 100) === cents && Math.abs(dayDiff(y.date, x.date)) <= 3 && targetOf(y, r) === acc).length;
          const art = p.rule.art ? p.rule.art.art : p.hist ? p.hist.art : '';
          let st = S.rp.get(p.key);
          if (!st) S.rp.set(p.key, st = { on: false, art, proj: p.rule.proj ? p.rule.proj.id : recProject(acc), comment: p.comment, ta: false, tp: false, mk: null, tm: false });
          else if (!st.ta && !st.art && art) st.art = art; // історія рахунку підвантажилась після першого показу
          // стаття з рекламним бюджетом: маркетолог — за контрагентом (rules.json, напр. ФОП Власич → Сливко), хто тримає корп. картку
          // на дату покупки (довідник карток), інакше як у найближчих за датою схожих записах рахунку (маркетолог запису — з імені в
          // коментарі: у списку записів CRM його немає; лише той, хто зараз є в списку маркетологів)
          const needMk = op === 2 && artIssue(st.art) === 'marketer';
          p.mk = needMk ? cptyMk(x) || holderMk(acc, x) || histMk(past, x, st.art, S.mks) : null;
          if (p.mk && S.mks && S.mks.length && !S.mks.some(m => m.id === p.mk.id)) p.mk = null;
          if (!st.tm) st.mk = p.mk ? p.mk.id : null;
          // покупка корп. карткою: зразок — найближчий схожий запис картки з цією статтею (для реклами — і з цим маркетологом)
          const ref = card || needMk ? histRef(past, x, st.art, needMk ? st.mk : null, S.mks) : null;
          // проєкт за людиною — як у «Погодженнях», де ім'я є в тексті: правила проєкту rules.json і для маркетолога / того, хто тримає картку
          // («Симонович → США», «Сливко → Україна»), якщо за самим текстом правило проєкту не спрацювало. Маркетолог — вибраний людиною
          // або певний (за контрагентом, хто тримає картку, у всіх попередніх записах рахунку — один)
          const mkSel = artIssue(st.art) !== 'marketer' ? null : st.tm ? st.mk : p.mk && p.mk.sure ? p.mk.id : null;
          const who = op === 2 && !p.rule.proj && mkSel ? (p.mk && p.mk.id === mkSel && (p.mk.name || p.mk.holder)) || mkName(mkSel) : '';
          p.projMk = null;
          if (who) {
            const pr = ruleHints(compiled, { ...rec0, text: `${p.comment} · ${who}`, comment: `${p.comment} · ${who}` }).proj;
            if (pr) p.projMk = { id: pr.id, why: `${pr.why} — маркетолог ${who}` };
          }
          // правила для маркетолога немає — проєкт як у схожому записі рахунку з тим самим маркетологом і статтею
          // («тест США» Миколаївського на картці 3462 → США, а не найчастіший проєкт рахунку)
          p.projHist = needMk && !p.rule.proj && !p.projMk && st.mk && ref && ref.proj ? { id: ref.proj, why: `як у схожому записі з цим маркетологом: ID ${ref.id} від ${dmy(ref.date)}` } : null;
          // людина проєкт не міняла: за маркетологом, а якщо його вже немає (вибрали іншого) — як було до нього
          const auto = p.projMk || p.projHist;
          if (!st.tp && auto) { st.proj = auto.id; st.pm = true; }
          else if (!st.tp && st.pm) { st.proj = p.rule.proj ? p.rule.proj.id : recProject(acc); st.pm = false; }
          // покупка в продавця, що «належить» певній людині (rules.json → reference.vendor_people: HeyGen → Татоян Артем, США — 18.11.2026):
          // у коментарі — вона, а не той, хто тримає картку; проєкт — її, якщо людина проєкт не міняла
          const vp = card ? vendorPerson(x) : null;
          if (vp && vp.project && !st.tp) {
            const pj = projects.find(([n]) => n === vp.project);
            if (pj) { st.proj = Number(pj[1]); p.projMk = { id: Number(pj[1]), why: `покупки «${vp.title || vp.person}» — проєкт ${vp.project} (rules.json)` }; }
          }
          // коментар покупки карткою — як пишуть у CRM; поки людина його не змінювала, іде за маркетологом, статтею й проєктом
          if (card) {
            const cd = CARDS.find(k => Number(k.account_id) === acc), hd = cd && holderOf(cd, opDate(x));
            const whoName = needMk ? (st.mk && (S.mks || []).some(m => m.id === st.mk) ? mkName(st.mk) : '') : vp ? vp.person : hd && !(hd.also && hd.also.length) ? hd.name : '';
            p.cardComment = cardComment(x, { who: whoName, sameWho: w => !!whoName && mkInComment([{ id: 1, name: whoName }], w) === 1,
              art: st.art, proj: st.proj, projName: projName(st.proj), ccy: r.b.ccy, amount: p.amount, ref });
            if (!st.tc) st.comment = p.cardComment;
          }
          out.push(p);
        }
      }
      /* «Зіставлення ШІ»: операцію, для якої є погодження, тут не вносимо — інакше реєстр (він не знає про запис зі «Звірки») унесе
         ту саму виплату вдруге. Не внесене — у «Погодженні»; уже внесене (ID є), але запис CRM з іншою датою, сумою чи рахунком — перевірити.
         Підказка ШІ — лише примітка. */
      const T = S.lastMt, ai = mtAiNow();
      if (T) for (const p of out) {
        if (p.block) continue;
        const b = T.byX.get(p.row), m = b && T.byBank.get(b);
        if (m && m.off) {
          // погодження є, але реєстр його не вносить («Вносити» = «ні»: повернення коштів клієнтам тощо) — у «Погодженні» такого рядка
          // немає, тож операцію не блокуємо: її вносять тут (18.11.2026)
          const a = m.ap[0];
          p.rule = { ...p.rule, reasons: p.rule.reasons.concat(`погодження ${apWho(a)} від ${dmy(a.date)} є, але реєстр його не вносить («Вносити» = «ні») — внесіть тут`) };
        } else if (m) {
          const who = m.ap.map(a => `${apWho(a)}${a.crmId ? ` (ID ${a.crmId})` : ''}`).join(', '), stt = MT.crmState(m.ap);
          p.block = stt === 'не внесено' ? `є погодження ${who} від ${dmy(m.ap[0].date)} — вносьте ${m.ap.length > 1 ? 'їх' : 'його'} у вкладці «Погодження», інакше буде дубль («Зіставлення ШІ»)`
            : stt === 'в CRM' ? `за погодженнями це вже в CRM: ${who} — запис з іншою датою, сумою чи рахунком? Перевірте його, не вносьте вдруге («Зіставлення ШІ»)`
              : `погодження ${who}: частину вже внесено — решту вносьте у «Погодженні», не тут («Зіставлення ШІ»)`;
        } else {
          if (ai && b) {
            const s = (ai.list || []).find(x => x.bank === b);
            if (s) p.aiNote = `ШІ (${s.conf}): схоже на погодження ${s.ap.map(apWho).join(' + ')}${isZero(s.diff) ? '' : ` — різниця ${fmt(s.diff)}`}${s.why ? `. ${s.why}` : ''} — якщо так, вносьте у «Погодженні»`;
          }
          // пакет ЗП без набору погоджень: чому (16.11.2026) — погоджень дня немає (ЗП з відомості) чи їх менше, ніж у пакеті
          const a = p.payRow && b ? T.res.amb.find(z => z.bank === b) : null;
          if (a && (a.none || a.short)) p.rule = { ...p.rule, reasons: p.rule.reasons.concat(a.none ? 'погоджень на цю суму немає — схоже, ЗП з відомості бухгалтерії («Зіставлення ШІ»)'
            : `за день погоджень на ${fmt(a.short.have)}, не вистачає ${fmt(a.short.miss)} — перевірте «Звідки оплата» в погодженнях цього дня («Зіставлення ШІ»)`) };
        }
      }
      /* Податки із ЗП ↔ пакет ↔ погодження (16.11.2026). Пакет зіставлено з погодженнями — ВЗ і ПДФО з нього реєстр вносить по людях
         (рядок «податки» до кожного погодження зарплатного проєкту, ключ + «#tax»; для «% менеджера» — сам рядок) зі статтею кожної
         людини: цілим платежем їх не вносимо, навіть якщо записів по людях у CRM ще немає (наявні захисти вище бачать лише вже внесені).
         ЄСВ реєстр не вносить (і податки пакета без рядків «податки»: погодження не через зарплатний проєкт) — стаття погоджень пакета,
         якщо вона в них одна; різні — їх перелік, вибирає людина. */
      if (T) for (const p of out) {
        if (p.block || !p.taxPk || !p.taxPk.length) continue;
        const ms = p.taxPk.map(y => T.byBank.get(T.byX.get(y)));
        if (!ms.every(Boolean)) continue;
        const aps = ms.flatMap(m => m.ap), raw = k => (T.raw && T.raw.get(k)) || null;
        const tr = aps.map(a => raw(a.pct ? a.key : `${a.key}#tax`)).filter(v => v && !WD_GONE.has(v.status) && v.action !== 'ні' && Number(v.amount) > 0);
        // реєстр внесе податки лише за погодженнями з рядком «податки»: решту (погодження не через зарплатний проєкт) — сказати прямо (огляд 16.11.2026)
        const noTax = aps.filter(a => !tr.includes(raw(a.pct ? a.key : `#tax`))), gap = r2((p.taxBank || 0) - tr.reduce((s, v) => s + Number(v.amount), 0));
        if (tr.length && !ESV_RE.test(cyr(p.row.purpose))) {
          p.block = `податки цієї ЗП вносяться по людях у «Погодженні»: ${tr.length} ${plural(tr.length, 'рядок', 'рядки', 'рядків')} на ${fmt(r2(tr.reduce((s, v) => s + Number(v.amount), 0)))} (банк ВЗ + ПДФО — ${fmt(p.taxBank || 0)}) — платіж податку цілим не вносьте, інакше буде дубль («Зіставлення ШІ»)${gap > 0.05 * tr.length ? `. Реєстр покриває не все: різницю ${fmt(gap)} він не внесе${noTax.length ? ` — для погоджень ${noTax.slice(0, 4).map(a => `«${a.recipient || '—'}» ${fmt(a.amount)}`).join(', ')} рядка «податки» немає (не через зарплатний проєкт): виправте в них «Звідки оплата» й оновіть реєстр або внесіть різницю в CRM вручну` : ' — внесіть її в CRM вручну'}` : ''}`;
          continue;
        }
        const cnt = new Map();
        for (const a of aps) { const k = artOfCat((raw(a.key) || {}).category); if (k) cnt.set(k, (cnt.get(k) || 0) + 1); }
        const cats = [...cnt].sort((x, y) => y[1] - x[1]), st = S.rp.get(p.key);
        if (cats.length === 1) {
          if (!p.rule.art) p.rule = { ...p.rule, art: { art: cats[0][0], sure: false, why: `стаття погоджень цієї ЗП (${aps.length})` } };
          if (!st.ta && !st.art) st.art = p.rule.art.art;
        } else if (cats.length > 1) p.rule = { ...p.rule, reasons: p.rule.reasons.concat(`у погодженнях цієї ЗП статті різні: ${cats.map(([k, n]) => `«${artLabel(k)}» (${n})`).join(', ')} — виберіть статтю податку`) };
      }
      /* податки однієї ЗП — одна стаття: вибрана людиною (а якщо ніхто не вибирав — визначена для частини з них) ставиться й іншим.
         Група — пакет ЗП, до якого прив'язано податок (кілька пакетів однієї хвилини, зі спільним ЄСВ, — разом), і сам переказ ЗП,
         якщо на нього немає погоджень: стаття, вибрана для ЗП, іде і її податкам (16.11.2026). Податок без пакета — як було:
         «рахунок | день | місяць у призначенні». */
      const up = new Map(), root = y => { let v = y; while (up.has(v) && up.get(v) !== v) v = up.get(v); return v; };
      for (const p of out) if (p.taxPk && p.taxPk.length) { const r0 = root(p.taxPk[0]); p.taxPk.forEach(y => up.set(root(y), r0)); up.set(r0, r0); }
      const groups = new Map();
      for (const p of out) {
        const k = p.taxPk && p.taxPk.length ? root(p.taxPk[0]) : p.payRow && !p.block && up.has(p.row) ? root(p.row) : p.taxKey;
        if (!k) continue;
        if (p.payRow) p.taxName = 'ЗП';
        groups.set(k, (groups.get(k) || []).concat(p));
      }
      for (const g of groups.values()) {
        g.forEach(p => { p.taxPeers = g.filter(q => q !== p); });
        if (g.length < 2) continue;
        const sts = g.map(p => S.rp.get(p.key));
        const user = [...new Set(sts.filter(st => st.ta && st.art).map(st => st.art))];
        const auto = [...new Set(sts.filter(st => !st.ta && !st.sib && st.art).map(st => st.art))];
        const art = user.length === 1 ? user[0] : !user.length && auto.length === 1 ? auto[0] : null;
        // на сам переказ ЗП стаття з податків не переходить: зарплатну статтю ЗП вибирає лише людина
        if (art) sts.forEach((st, i) => { if (!g[i].payRow && !st.ta && st.art !== art) { st.art = art; st.sib = true; } });
      }
      return out.sort((a, b) => (a.block ? 1 : 0) - (b.block ? 1 : 0) || nameOf(a.acc).localeCompare(nameOf(b.acc), 'uk') || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
    // проєкт нового запису — найчастіший у витратах і надходженнях рахунку, інакше — останній вибраний
    function recProject(acc) {
      const cnt = new Map();
      for (const c of [...(S.items.get(acc) || []), ...(S.hist.get(acc) || [])]) if (c.proj && (c.opc === 1 || c.opc === 2)) cnt.set(c.proj, (cnt.get(c.proj) || 0) + 1);
      const top = [...cnt].sort((a, b) => b[1] - a[1])[0];
      return top ? top[0] : (LS.get('cfl_rec_proj', null) || (projects[0] || [])[1] || 1);
    }
    // записи рахунків за 120 днів до періоду — для підказки статті; без них статтю вибирають вручну
    async function loadHist(ids) {
      const gen = S.gen, need = ids.filter(id => !S.hist.has(id));
      if (!need.length || S.histBusy || !S.itemsFrom) return;
      S.histBusy = true;
      let got = new Map();
      try { got = Rc.cashflowByAccount(await pages(`invoice-payment?date_from=${dash(addDays(S.itemsFrom, -120))}&date_to=${dash(addDays(S.itemsFrom, -1))}&${need.map(id => `invoice_ids[]=${id}`).join('&')}`)); }
      catch (e) {}
      finally { S.histBusy = false; }
      if (gen !== S.gen) return;
      need.forEach(id => S.hist.set(id, got.get(id) || []));
      if (!S.busy) render();
    }
    // запис можна створити: є стаття, а для статті з рекламним бюджетом вибрано маркетолога. Зарплатна стаття — теж (ризиковано: CRM
    // не дасть такий запис змінити чи видалити; вікно створення про це попереджає)
    const ready = p => { const st = S.rp.get(p.key), iss = artIssue(st.art); return !p.block && !!st.art && (iss !== 'marketer' || (p.op === 2 && !!st.mk)); };
    const risky = p => artIssue(S.rp.get(p.key).art) === 'salary';
    /* «позначити всі»: витрати зі статтею (правило без застережень, історія рахунку або вибрано вручну); надходження — лише по одному;
       маркетолог — вибраний вручну або єдиний у всіх попередніх записах рахунку з цією статтею. Зарплатні статті, ЗП через транзитний
       рахунок і зарплатні виплати — лише по одному. */
    const bulkOk = p => {
      const st = S.rp.get(p.key);
      return ready(p) && p.op === 2 && !risky(p) && !p.payRow && !p.payroll && !p.rule.reasons.length && (st.ta || !p.rule.art || p.rule.art.sure) &&
        (artIssue(st.art) !== 'marketer' || st.tm || !!(p.mk && p.mk.sure && st.mk === p.mk.id));
    };
