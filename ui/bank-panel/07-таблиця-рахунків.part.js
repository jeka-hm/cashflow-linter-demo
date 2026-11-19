    // ---------- таблиця ----------
    /* corpCard без своєї виписки, картка якого (номер у призначенні) списує з рахунку банку, зіставленого з рахунком CRM, —
       звіряється разом із цим рахунком. Якщо номер трапляється у виписках кількох рахунків — з тим, де покупок більше. */
    function cardsInto(cards) {
      const own = new Set(S.banks.filter(b => b.cfId).map(b => b.cfId)), votes = new Map();
      for (const b of S.banks) {
        if (!b.cfId) continue;
        for (const x of b.rows) {
          const t = Rc.cardTail(x.purpose), k = t && cards[t];
          if (!k || k === b.cfId || own.has(k)) continue;
          const v = votes.get(k) || new Map();
          votes.set(k, v);
          v.set(b.cfId, (v.get(b.cfId) || 0) + 1);
        }
      }
      return new Map([...votes].map(([k, v]) => [k, [...v].sort((x, y) => y[1] - x[1])[0][0]]));
    }
    function rows() {
      const { from, to } = S, man = LS.get('cfl_bank_manual', {});
      const byId = new Map(S.accs.map(a => [a.id, a]));
      S.dir = Rc.ownDirectory(S.banks, S.accs, S.items, LS.get('cfl_own_map', {}), CARDS);
      // з якого рахунку списує картка, видно з покупок у виписці; побачене раніше пам'ятається — і в день без покупок картка звіряється разом із рахунком.
      // Рахунок із довідника карток (debit_account_id) — сильніший за побачене
      const seen = LS.get('cfl_card_into', {});
      for (const [k, p] of cardsInto(S.dir.cards)) seen[k] = p;
      for (const c of CARDS) if (Number(c.debit_account_id) > 0) seen[Number(c.account_id)] = Number(c.debit_account_id);
      LS.set('cfl_card_into', seen);
      // рахунки, що платять ЗП через транзитний рахунок (переказ на нього видно у виписці); побачене раніше пам'ятається —
      // і в день без такого переказу записи ЗП у CRM поштучно не звіряються
      const payAccs = LS.get('cfl_pay_accs', {});
      for (const b of S.banks) if (b.cfId && b.rows.some(x => Rc.payRow(x, S.dir))) payAccs[b.cfId] = 1;
      LS.set('cfl_pay_accs', payAccs);
      const withBank = new Set(S.banks.filter(b => b.cfId).map(b => b.cfId));
      S.into = new Map(Object.entries(seen).map(([k, p]) => [Number(k), Number(p)]).filter(([k, p]) => byId.has(k) && byId.has(p) && withBank.has(p) && !withBank.has(k)));
      const cardsOf = new Map();
      for (const [k, p] of S.into) cardsOf.set(p, (cardsOf.get(p) || []).concat(k));
      const list = S.accs.map(a => {
        const ccy = (S.ccy || {})[a.currency_id] || '';
        if (S.into.has(a.id)) {
          // corpCard, що звіряється разом з рахунком банку: тут — лише його рух у CRM і залишок
          const R = Rc.periodRecon(null, S.items.get(a.id) || [], Number(a.balance), from, to, undefined, { kind: S.kind });
          return { a, g: groupOf(a), ccy, b: null, R, warn: [], status: 'merged', into: S.into.get(a.id), offset: S.offsets ? S.offsets.get(a.id) : undefined };
        }
        const b = bankFor(a, from, to), cards = cardsOf.get(a.id) || [], ids = [a.id, ...cards];
        const cf = cards.length ? Rc.groupItems(S.items, ids) : (S.items.get(a.id) || []);
        const bal = r2(ids.reduce((s, id) => s + Number(byId.get(id).balance), 0));
        const m = !b && man[a.id] ? man[a.id][to] : undefined;
        // into — corpCard → рахунок, з яким він звіряється: переказ у CRM на рахунок картки (R-NP-CORPCARD-01) — той самий, що у виписці на рахунок банку
        const R = Rc.periodRecon(b, cf, bal, from, to, m, b ? { dir: S.dir, group: new Set(ids), owner: `${b.owner || ''} ${b.client || ''}`, kind: S.kind, cards, into: S.into,
          salary: c => salaryArt(c.art), payroll: !!payAccs[a.id], skip: BRON_ACC.has(a.id) ? bronSkip : null, calc: BRON_SHARE.has(a.id) ? bronCalc : null } : { kind: S.kind });
        const warn = [...new Set([...R.warnings, ...(b ? b.warnings : [])].filter(w => !FILE_WARN.test(w)))];
        // у CRM частина валютних рахунків ведеться в гривні («2 Євр Маркет Приват ТОВ» — UAH): суми напряму не порівнюються — без різниць
        const otherCcy = !!(b && b.ccy && ccy && b.ccy !== ccy);
        if (otherCcy) { warn.unshift(`у CRM рахунок ведеться в ${ccy}, у банку — ${b.ccy}: суми не порівнюються`); R.diff = null; R.amounts = []; R.ok = false; R.own = null;
          // і без «немає в CRM / в банку»: інакше плитки й «Закриття місяця» рахували всі операції такого рахунку як розбіжності
          R.missing = { bank: [], crm: [] }; R.covered = false; }
        // з фільтром типу залишок, введений вручну, не порівнюється — потрібна виписка
        // сходиться без пояснених різниць: лише ЗП через транзит (і дати) — «крім ЗП», лише дати проведення — «крім дат», інше (комісії LiqPay
        // окремими записами, платіж з поверненням, рух броніків, розрахункові записи) — «з поясненнями»
        const aw = R.adjWhy || [], st = R.pay && aw.every(w => w === 'pay' || w === 'timing') ? 'pay' : aw.every(w => w === 'timing') ? 'timing' : 'expl';
        const status = !R.bank ? 'none' : otherCcy ? 'ccy' : R.ok ? 'ok' : R.timingOk ? st : R.xferOnly ? 'xfer' : (R.covered || (R.source === 'manual' && R.kind === 'all')) ? 'bad' : 'part';
        // поповнення корп. картки, записане витратою: за правилами це переказ на corpCard. Витрата на самому corpCard — покупка картою,
        // навіть якщо в коментарі «на корп картку» (як виняток у R-NP-CORPCARD-01)
        const topups = cf.filter(x => x.opc === 2 && x.date >= from && x.date <= to && isTopup(x.comment) && !Rc.isCorp(byId.get(x.acc)));
        return { a, g: groupOf(a), ccy, b, R, warn, status, manual: m, offset: S.offsets ? S.offsets.get(a.id) : undefined, cards, topups, cf };
      });
      // corpCard, зведений з рахунком банку, — окремо його покупки: з виписки рахунку (номер картки в призначенні) проти витрат
      // картки в CRM; без пари — з тієї самої звірки рахунку (у рядку рахунку вони теж є)
      for (const r of list) {
        if (r.status !== 'merged') continue;
        const p = list.find(x => x.a.id === r.into);
        if (!p || !p.b || !p.R.covered) continue;
        const mine = x => { const t = Rc.cardTail(x.purpose); return !!t && Number(S.dir.cards[t]) === r.a.id; };
        const inP = x => x.date >= from && x.date <= to;
        r.card = { bank: p.b.rows.filter(x => x.amount < 0 && inP(x) && mine(x)), crm: (S.items.get(r.a.id) || []).filter(x => x.opc === 2 && inP(x)),
          missB: (p.R.missing ? p.R.missing.bank : []).filter(mine), missC: (p.R.missing ? p.R.missing.crm : []).filter(c => c.acc === r.a.id) };
      }
      // кошти броніків: на кожне надходження — запис «1.5% від бронювання» на рахунку share_account_id (та сама частка, ±3 дні)
      for (const r of list) {
        const cfg = BRON_LIST.find(a => Number(a.account_id) === r.a.id), inc = ((r.R && r.R.ruled) || []).filter(o => o.why === BRON_IN).map(o => o.row);
        if (!cfg || !inc.length) continue;
        const sh = list.find(x => x.a.id === Number(cfg.share_account_id)), pct = Number(cfg.share_pct) || 1.5;
        const free = new Set(((sh && sh.R && sh.R.calc) || []).map(o => o.crm)), miss = [];
        for (const x of inc) {
          const want = Math.round(x.amount * pct) / 100, c = [...free].find(c => Math.abs(c.amount - want) < 0.005 && Math.abs(dayDiff(c.date, x.date)) <= 3);
          if (c) free.delete(c); else miss.push([x, want]);
        }
        r.bron = !sh ? '' : miss.length ? `«${pct}% від бронювання» на «${sh.a.name}» немає для ${miss.length} з ${inc.length} надходжень: ${miss.slice(0, 6).map(([x, w]) => `${dmy(x.date)} ${fmt(x.amount)} (≈ ${fmt(w)})`).join(', ')}${miss.length > 6 ? ' …' : ''}.`
          : `«${pct}% від бронювання» на «${sh.a.name}» є для всіх ${inc.length} надходжень.`;
      }
      return list;
    }
    // чому рахунок корп. картки не звіряється: номера немає, покупок з номером у виписках немає, банку немає в API
    function cardWhy(a) {
      const tails = Object.entries(S.dir.cards || {}).filter(([, k]) => Number(k) === a.id).map(([t]) => t);
      // той самий номер у назвах кількох рахунків (новий рахунок картки завели, а старий не перейменували) — лінтер не вгадує
      const own = Rc.nameTail(a), twins = own ? (S.accs || []).filter(b => b.id !== a.id && Rc.nameTail(b) === own) : [];
      const to = own ? Number((S.dir.cards || {})[own]) || 0 : 0;
      if (!tails.length && to && to !== a.id) return `номер ${own} є й у назві діючого рахунку «${nameOf(to)}» — покупки цією карткою звіряються з ним`;
      if (!tails.length && twins.length) return `номер ${own} є ще в назві «${twins.map(b => b.name).join('», «')}» — лінтер не знає, котрий рахунок картки: залиште номер в одному, а старий рахунок позначте «неактуальний» (або вкажіть картку в rules.json)`;
      // «корп картка на майбутнє …» — картки ще немає: не звіряється й не поповнюється, доки в назві не з'явиться номер
      if (!tails.length && /майбутн/i.test(a.name || '')) return 'картка ще не діє («на майбутнє» в назві) — коли нею почнуть платити, дайте рахунку назву з номером картки';
      if (!tails.length && Rc.CARD_OFF.test(a.name || '')) return 'рахунок картки позначено неактуальним';
      if (!tails.length) return 'номера картки немає ні в назві рахунку, ні в rules.json — якщо у виписці є її покупки, див. «Нові корп. картки» в розділі «Внести в CRM»';
      if (/chase|wise|stripe|erste|payoneer/i.test(a.name || '')) return 'виписки цього банку немає в API — залишок картки можна ввести вручну';
      const into = Number(LS.get('cfl_card_into', {})[a.id]) || 0; // з довідника карток чи з покупок, побачених раніше
      if (into && into !== a.id) return `списує з рахунку «${nameOf(into)}», а виписки цього рахунку за період немає`;
      return `покупок карткою …${tails.join(', …')} у виписках за період немає — тож не видно, з якого рахунку вона списує`;
    }
    /* Пропозиції переказів між своїми. Переказ між двома нашими рахунками видно у виписках обох — це один переказ (дата — зі сторони
       списання). Окремо — corpCard, на якому в CRM зараз витрат більше, ніж поповнень: пропонується поповнення з рахунку, з якого картка списує. */
    function proposals(all) {
      const byId = new Map(S.accs.map(a => [a.id, a])), raw = [];
      for (const r of all) {
        if (!r.R.own) continue;
        const kinds = r.R.own.kinds, cents = y => Math.round(y.amount * 100);
        for (const x of r.R.own.xfers) {
          if (x.state !== 'missing') continue;
          const out = x.row.amount < 0;
          // скільки таких переказів (той самий рахунок «куди», знак і сума) у виписці рахунку за ±3 дні — перед створенням «вже є» лише тоді,
          // коли в CRM їх стільки ж (як p.peers у записів; 07.11.2026). Операція поза періодом — за рахунком контрагента
          const peers = r.b.rows.filter(y => cents(y) === cents(x.row) && Math.abs(dayDiff(y.date, x.row.date)) <= 3 &&
            (kinds.get(y) ? kinds.get(y).peer === x.peer : y === x.row || (!!y.cpIban && y.cpIban === x.row.cpIban))).length;
          raw.push({ src: 'own', acc: r.a.id, from: out ? r.a.id : x.peer, to: out ? x.peer : r.a.id, amount: Math.abs(x.row.amount), date: x.row.date, time: x.row.time, row: x.row, bank: r.b,
            peers: Math.max(1, peers), rowKey: x.row.ref || r.b.rows.indexOf(x.row) });
        }
      }
      raw.sort((x, y) => (x.acc === x.from ? 0 : 1) - (y.acc === y.from ? 0 : 1));
      const res = [];
      for (const p of raw) {
        const twin = res.find(q => q.src === 'own' && !q.twin && q.acc !== p.acc && q.from === p.from && q.to === p.to && Math.round(q.amount * 100) === Math.round(p.amount * 100) && Math.abs(dayDiff(q.date, p.date)) <= 3);
        if (twin) twin.twin = p; else res.push(p);
      }
      for (const r of all) {
        if (r.status !== 'merged' || !(Number(r.a.balance) < -0.005)) continue;
        // корп. картку поповнюють лише з рахунку її власника (rules.json → card_topup): картка іншого власника — лише з поясненням
        const other = !topupCards(r.into).some(a => a.id === r.a.id);
        res.push({ src: 'card', acc: r.into, from: r.into, to: r.a.id, amount: r2(-Number(r.a.balance)), date: today(), time: '', other });
      }
      for (const p of res) {
        // з операцією банку в ключі: два однакові перекази одного дня — два рядки, кожен зі своєю позначкою, сумою й коментарем
        p.key = `${p.src}:${p.from}>${p.to}:${Math.round(p.amount * 100)}:${p.date}${p.src === 'own' ? `:${p.rowKey}` : ''}`;
        p.sameCcy = (byId.get(p.from) || {}).currency_id === (byId.get(p.to) || {}).currency_id;
        p.old = !!(fixFrom && p.date < fixFrom); // межа роботи (rules.json → fix_from): раніше лінтер нічого не створює
        // рух уже є в CRM записом іншого типу — не створювати переказ, а змінити тип запису (інакше рух порахується двічі; 07.11.2026)
        const ot = p.src === 'own' ? xferOtherType(p, S.items.get(p.from), S.items.get(p.to)) : null;
        p.typeNote = !ot ? '' : ot.draft ? `цей рух уже є чернеткою ID ${ot.id} іншого типу — виправте її в CRM («CashFlow» → «Чернетки»), а не створюйте переказ`
          : `цей рух уже є в CRM записом ID ${ot.id} іншого типу — змініть його тип у «Виправити» → «Записи з неправильним типом», а не створюйте переказ`;
        if (!S.xp.has(p.key)) S.xp.set(p.key, { on: false, amount: p.amount, proj: defaultProject(p.from, p.to), comment: defaultComment(p) });
      }
      return res;
    }
    const xok = p => p.sameCcy && !p.old && !p.other && !p.typeNote; // переказ можна створити тут
    // проєкт — як в останньому переказі між цими рахунками (у поповнень корп. карток він різний: Україна, Британія, США)
    function defaultProject(from, to) {
      const last = list => list.filter(x => x.proj).sort((x, y) => (x.date < y.date ? 1 : -1))[0];
      const hit = last((S.items.get(to) || []).filter(x => x.opc === 3 && x.peer === from)) || last((S.items.get(to) || []).filter(x => x.opc === 3)) || last((S.items.get(from) || []).filter(x => x.opc === 4));
      return hit ? hit.proj : (LS.get('cfl_xfer_proj', null) || (projects[0] || [])[1] || 1);
    }
    function defaultComment(p) {
      const head = `Переказ між рахунками: ${nameOf(p.from)} → ${nameOf(p.to)}`;
      if (p.src === 'card') return `Поповнення корп. картки: ${nameOf(p.from)} → ${nameOf(p.to)} (у CRM витрат з картки було більше, ніж поповнень)`;
      // продаж валюти — коментар, як його вже пишуть у CRM: «Продаж 495.00 EUR з «…» за курсом банку 50.35 = 24 923.25 грн → «…»»
      const fx = /в[іi]д\s+продажу\s+([\d\s.,]*\d)\s*(USD|EUR|GBP|PLN|CZK|CHF)(?:\s+по\s+курсу\s+([\d.,]+))?/iu.exec(String(p.row.purpose || ''));
      if (fx) return `Продаж ${fx[1].trim()} ${fx[2].toUpperCase()} з «${nameOf(p.from)}»${fx[3] ? ` за курсом банку ${fx[3]}` : ''} = ${Number(p.amount).toFixed(2)} грн → «${nameOf(p.to)}»`.slice(0, 250);
      return `${head}. ${String(p.row.purpose || '').replace(/\s+/g, ' ').trim()}`.slice(0, 250);
    }
    const dcell = d => (d === null || d === undefined ? '' : isZero(d) ? '<div class="ok">✓</div>' : `<div class="bad">Δ ${fmt(d)}</div>`);
    function metric(r, k, extra) {
      const R = r.R, bank = R.bank ? R.bank[k] : null;
      const unit = r.status === 'ccy' && bank !== null && bank !== undefined ? ' ' + esc(r.b.ccy) : '';
      // різниця залишків видна й з фільтром типу (на статус тоді не впливає)
      return `<td class="mt"><div class="v">${fmt(R.crm[k])}</div><div class="bk">${extra !== undefined ? extra : 'банк ' + fmt(bank) + unit}</div>${R.diff ? dcell(R.diff[k]) : ''}</td>`;
    }
    // значок-око: рахунок показано (відкрите) / сховано (закрите)
    const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    function subHtml(r) {
      const R = r.R;
      if (!R.diff || r.status === 'ccy') return '';
      const out = [];
      if (R.covered && R.amounts.length) {
        const l = lacks(R), canRec = R.missing && R.missing.bank.some(x => R.kinds.get(x) !== 'own');
        if (l.miss) out.push(`<div><b class="bad">Немає в CRM:</b> ${esc(l.miss)}${canRec ? ' <span class="muted">— внести: розділ «Внести в CRM»</span>' : ''}</div>`);
        if (l.extra) out.push(`<div><b class="bad">Немає в банку (є лише в CRM):</b> ${esc(l.extra)} <span class="muted">— перевірте в CRM (інша дата, сума чи рахунок?)</span></div>`);
      }
      // пояснені різниці: суми не 1:1 і покупки карткою, які банк провів в інший день
      const kindOk = t => S.kind === 'all' || S.kind === ((t.bank || t.crm).amount > 0 ? 'credit' : 'debit');
      const G = (R.multi || []).filter(g => S.kind === 'all' || (R.kinds ? R.kinds.get(g.bank[0]) : null) === S.kind), T = R.timing || [];
      // у банку переказ між своїми, а в CRM — витрата чи дохід (у «переказах між рахунками» те саме пише розділ переказів нижче)
      if ((R.cross || []).length && S.kind !== 'own') out.push(`<div class="warn" style="margin:4px 0">${esc(R.cross.map(p => `${dmy(p.bank.date)} ${fmt(Math.abs(p.bank.amount))} — у банку переказ між своїми, а в CRM записано як ${p.crm.op} (ID ${p.crm.id}): за правилами це «Переказ між рахунками» — змінити можна в розділі «Виправити».`).join(' '))}</div>`);
      // групи одного виду — одним рядком: «Покупки картки за день: …; …»
      for (const w of [...new Set(G.map(g => g.why || ''))]) {
        const gs = G.filter(g => (g.why || '') === w), shown = gs.slice(0, 12);
        out.push(`<div class="muted">${esc(GW_HEAD[w] || GW_HEAD[''])}: ${esc(shown.map(groupText).join('; '))}${gs.length > shown.length ? esc(` і ще ${gs.length - shown.length}`) : ''}${w === 'refund' ? ' — у CRM не вносяться' : gs.some(g => g.diff) ? '' : ' — сходиться'}.</div>`);
      }
      // рух, який за правилом компанії в CRM не вноситься (кошти броніків), і розрахункові записи без руху в банку (1.5 % від бронювання)
      const RL = (R.ruled || []).filter(o => S.kind === 'all' || (R.kinds && R.kinds.get(o.row)) === S.kind);
      if (RL.length) {
        const part = (f, n) => { const l = RL.filter(f); return l.length ? `${n} ${l.length} на ${fmt(Math.abs(r2(l.reduce((s, o) => s + o.row.amount, 0))))}` : ''; };
        out.push(`<div class="muted">За правилом у CRM не вносяться (кошти броніків, rules.json → bronik_accounts): ${esc([part(o => o.why === BRON_IN, 'надходжень'), part(o => /ЗП/.test(o.why), 'переказів ЗП'), part(o => /податк/.test(o.why), 'податків')].filter(Boolean).join(', '))} — поза звіркою, не «немає в CRM»; перекази між своїми звіряються як завжди.${r.bron ? ` ${esc(r.bron)}` : ''}</div>`);
      }
      const CA = (R.calc || []).filter(o => S.kind === 'all' || Rc.crmKind(o.crm) === S.kind);
      if (CA.length) out.push(`<div class="muted">Розрахункові записи без руху в банку: ${CA.length} «1.5% від бронювання» на ${esc(fmt(r2(CA.reduce((s, o) => s + o.crm.amount, 0))))} — дохід з коштів броніків, у банку його немає (не «немає в банку»).</div>`);
      const later = T.filter(t => t.kind === 'later' && kindOk(t)), after = T.filter(t => t.kind === 'after' && kindOk(t)), pend = T.filter(t => t.kind === 'pending' && kindOk(t));
      if (later.length) out.push(`<div class="muted">Банк провів пізніше (покупки карткою; у CRM — за датою покупки): ${esc(later.map(t => `${dmy(t.bank.date)} ${fmt(Math.abs(t.bank.amount))} — покупка ${dmy(t.buy)}, у CRM ID ${t.crm.id} від ${dmy(t.crm.date)}`).join(' · '))}.</div>`);
      if (after.length) out.push(`<div class="muted">У CRM за період, а банк провів після нього: ${esc(after.map(t => `ID ${t.crm.id} ${fmt(Math.abs(t.crm.amount))} — проведено ${dmy(t.bank.date)}`).join(' · '))}.</div>`);
      if (pend.length) out.push(`<div class="muted">Ще не проведено банком (покупки карткою — банк проводить їх за 1–3 дні): ${esc(pend.map(t => `ID ${t.crm.id} ${fmt(Math.abs(t.crm.amount))}${t.crm.comment ? ` (${clean(t.crm.comment).slice(0, 40)})` : ''}`).join(' · '))}.</div>`);
      const sg = v => (v > 0 ? '+' : '') + fmt(v);
      // ЗП через транзитний рахунок: у банку — переказ одним платежем, у CRM — записи по людях; поштучно не звіряється
      const P = R.pay;
      if (P) {
        const sB = r2(P.bank.reduce((s, x) => s + x.amount, 0)), sC = r2(P.crm.reduce((s, c) => s + c.amount, 0)), d = r2(sC - sB);
        const via = [...new Set(P.bank.map(x => clean(x.cpty)).filter(Boolean))].map(n => `«${n}»`).join(', ');
        out.push(`<div class="muted">ЗП через транзитний рахунок${via ? ' ' + esc(via) : ''} поштучно не звіряється: у банку ${P.bank.length ? `${P.bank.length} ${plural(P.bank.length, 'переказ', 'перекази', 'переказів')} на ${fmt(Math.abs(sB))}` : 'переказів за період немає'}, ` +
          `у CRM ${P.crm.length ? `${P.crm.length} ${plural(P.crm.length, 'запис', 'записи', 'записів')} зі статтями ЗП на ${fmt(Math.abs(sC))}` : 'записів ЗП за період немає'}${isZero(d) ? ' — суми однакові' : `; різниця CRM − банк ${sg(d)}`} ` +
          '(у CRM ЗП — по людях за днем погодження, банк платить одним переказом). Кожен переказ ЗП видно й можна внести в розділі «Внести в CRM».</div>');
      }
      const AW = { pay: 'ЗП через транзит', timing: 'різниць у датах проведення', liqpay: 'комісій LiqPay (у CRM — окремими записами)', refund: 'платежів з поверненням', ruled: 'руху броніків', calc: 'розрахункових записів 1.5 %' };
      const ws = (R.adjWhy || []).map(w => AW[w]).filter(Boolean), wsTxt = ws.length > 1 ? `${ws.slice(0, -1).join(', ')} і ${ws[ws.length - 1]}` : ws[0] || 'цих різниць';
      if (R.timingOk) out.push(`<div class="ok" style="font-weight:400">Без ${esc(wsTxt)} рахунок сходиться.</div>`);
      // «бракує переказів між своїми» (xferOnly), а решта різниці пояснена (броніки, LiqPay, дати проведення…): різниця — без поясненого,
      // тобто лише ці перекази, а не вся сира різниця з рухом броніків (08.11.2026)
      const XA = S.kind === 'all' && !R.timingOk && R.xferOnly && R.adj ? R.adj : null; // з фільтром «перекази» броніки й 1.5 % не діють
      if (XA) out.push(`<div class="muted">Без ${esc(wsTxt)} бракує лише переказів між своїми (нижче) — після їх внесення рахунок зійдеться.</div>`);
      const D = XA || R.diff, why = R.xferOnly ? 'перекази між своїми, яких немає в CRM (нижче)' : 'через суми вище';
      const dOpen = S.kind === 'all' && !R.timingOk ? D.open : null, dPer = D.cred !== null && D.deb !== null && !R.timingOk ? r2(D.cred - D.deb) : null;
      // з фільтром типу — коротко: залишки не сходяться (усе разом — «Що звіряти: усе»)
      if (S.kind !== 'all' && R.diff.close !== null && !isZero(R.diff.close)) out.push(`<div class="bad" style="font-weight:400">Залишок не сходиться: на кінець ${esc(dmy(S.to))} CRM − банк = ${sg(R.diff.close)}${R.diff.open !== null && !isZero(R.diff.open) ? `, на початок ${esc(dmy(S.from))} — ${sg(R.diff.open)}` : ''}. Причину видно в «Що звіряти: усе».</div>`);
      if (dOpen !== null && !isZero(dOpen)) out.push(`<div class="muted">Різниця залишку (CRM − банк): на початок ${esc(dmy(S.from))} — ${sg(dOpen)}, накопичено раніше; ${dPer === null ? 'обороти не порівнюються' : isZero(dPer) ? 'за період нової немає' : `за період ${sg(dPer)} (${why})`}.</div>`);
      else if (dPer !== null && !isZero(dPer)) out.push(`<div class="muted">Різниця за період (CRM − банк): ${sg(dPer)} — ${why}.</div>`);
      if (r.cards && r.cards.length) out.push(`<div class="muted">Разом з ${r.cards.map(k => `«${esc(nameOf(k))}»`).join(', ')} — ${r.cards.length === 1 ? 'картка списує' : 'картки списують'} з цього рахунку.</div>`);
      const own = S.kind === 'all' || S.kind === 'own' ? R.own : null, dirW = x => (x.row.amount < 0 ? 'на' : 'з');
      if (own) {
        const miss = own.xfers.filter(x => x.state === 'missing');
        if (miss.length) out.push(`<div><b class="bad">Переказів між своїми немає в CRM:</b> ${esc(miss.map(x => `${dmy(x.row.date)} ${dirW(x)} «${nameOf(x.peer)}» ${fmt(Math.abs(x.row.amount))}`).join(' · '))} — створити можна в розділі «Внести в CRM».</div>`);
        const typ = own.xfers.filter(x => x.state === 'type' || x.state === 'peer');
        if (typ.length) out.push(`<div class="warn" style="margin:4px 0">${typ.map(x => esc(x.state === 'type'
          ? `${dmy(x.row.date)} ${fmt(Math.abs(x.row.amount))} — переказ ${dirW(x)} «${nameOf(x.peer)}», а в CRM записано як ${x.item.op} (ID ${x.item.id}): за правилами це «Переказ між рахунками» — змінити можна в розділі «Виправити».`
          : `${dmy(x.row.date)} ${fmt(Math.abs(x.row.amount))} — переказ ${dirW(x)} «${nameOf(x.peer)}», а в CRM переказ ${x.item.peer ? `з рахунком «${nameOf(x.item.peer)}»` : 'з іншим рахунком'} (ID ${x.item.id}).`)).join('<br>')}</div>`);
        if (own.maybe.length) out.push(`<div class="muted">Схоже на перекази між своїми, але рахунок «куди» невідомий: ${own.maybe.length} — виберіть його в розділі «Внести в CRM».</div>`);
      }
      if (r.topups && r.topups.length) out.push(`<div class="warn" style="margin:4px 0">Поповнення корп. картки записано в CRM витратою: ${esc(r.topups.map(x => `ID ${x.id} (${dmy(x.date)}, ${fmt(Math.abs(x.amount))})`).join(', '))} — за правилами це переказ на рахунок корп. картки; змінити можна в розділі «Виправити».</div>`);
      return out.join('');
    }
