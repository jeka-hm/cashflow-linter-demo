    // ---------- «Зіставлення ШІ»: операції банку ↔ погодження реєстру ↔ записи CRM (core/matching.js; з 05.11.2026) ----------
    /* Списання періоду на рахунках з випискою (без переказів між своїми, покупок корп. карткою й комісій банку): ЗП на транзит — 'pay'
       (з кількістю карток пакета Привату), податки із ЗП з рахунку ТОВ — 'tax', решта — 'exp'; пара в CRM — з звірки (R.pairs).
       Погодження — ті самі рядки реєстру, що читає «Виводи з балансу» (без «% менеджера» — вони там, без податків, переказів і «ні»).
       → {key, res: MT.match, byX: рядок виписки → операція, byBank: операція → пара, banked: рахунки з випискою} або null */
    function mtCalc(all) {
      if (!S.items || !S.wd.rows) return null;
      const key = [S.gen, S.from, S.to, S.wd.ver || 0, S.wd.busy ? 'b' + S.wd.seq : '', S.bv].join('|');
      if (S.mt && S.mt.key === key) return S.mt;
      const bank = [], byX = new Map(), banked = new Set();
      for (const r of all) {
        if (r.status === 'merged' || r.status === 'ccy' || !r.b || !r.R.covered) continue;
        banked.add(r.a.id);
        const RR = r.R, owner = Rc.ownerOf(r.a.name) || '';
        // за правилом у CRM не вноситься (кошти броніків: їхня ЗП і податки, rules.json → bronik_accounts) — погоджень на них немає, у ШІ не йдуть;
        // платіж і його повернення (разом 0) — теж; рядок групи «суми не 1:1» має запис CRM (перший запис групи), 08.11.2026
        const ruled = new Set((RR.ruled || []).map(o => o.row)), grp = new Map();
        (RR.multi || []).forEach(g => g.bank.forEach(x => grp.set(x, g)));
        r.b.rows.forEach((x, i) => {
          if (!(x.amount < 0) || x.date < S.from || x.date > S.to || ruled.has(x) || (grp.get(x) && grp.get(x).why === 'refund')) return;
          // вид з переказів між своїми (ownKind): own — переказ на наш рахунок, maybe — схоже на нього, pay — ЗП на транзит, card — на особисту картку
          const ko = RR.own && RR.own.kinds.get(x), k0 = ko ? ko.kind : null, t = Rc.cardTail(x.purpose), pur = cyr(x.purpose);
          if (k0 === 'own' || k0 === 'maybe' || (t && S.dir.cards[t]) || FEE_RE.test(pur)) return;
          const kind = k0 === 'pay' ? 'pay' : PAY_TAX_RE.test(pur) && /^ТОВ\s/.test(owner) ? 'tax' : 'exp', pk = kind === 'pay' ? payPacket(x) : null;
          const pr = RR.pairs && RR.pairs.get(x), g = grp.get(x);
          const b = { id: `${r.a.id}|${x.date}|${x.time || ''}|${Math.round(x.amount * 100)}|${x.ref || i}`, x, acc: r.a.id, owner, date: x.date, amount: r2(-x.amount), kind,
            cards: pk && pk.cards ? pk.cards : 0, packet: pk ? pk.id : '', cpty: clean(x.cpty), text: clean(x.purpose),
            crm: pr || (g && g.crm[0]) || null, crmIds: pr ? [pr.id] : g ? g.crm.map(c => c.id) : [] };
          bank.push(b);
          byX.set(x, b);
        });
      }
      // фірма рахунку погодження — для пакета ЗП: погодження «з 8112», а заплатили пакетом з 8296 тієї самої фірми
      const firm = new Map(), firmOf = id => { if (!firm.has(id)) firm.set(id, Rc.ownerOf(nameOf(id)) || ''); return firm.get(id); };
      /* «% менеджера / м-рів» (WD.parseApproval) — у «Виводах з балансу», але оплачене через зарплатний проєкт («зп ПРИКЛАД», «зп Маркет») чи з
         рахунку, з якого йдуть пакети ЗП, входить у пакет Привату (05–06.11.2026),
         тож у набір пакета воно йде (pct; 1:1 — ні). Сума — на руки (textAmount): «Сума» такого рядка в реєстрі — лише податки; «Вносити»
         = «ні» тут не відсіює («% менеджера» не через зарплатний проєкт реєстр не вносить, а банк його сплатив) — 16.11.2026 */
      const payAcc = new Set(bank.filter(b => b.kind === 'pay').map(b => b.acc));
      const ap = S.wd.rows.filter(a => a && !WD_GONE.has(a.status) && !a.tax && !a.transfer)
        .map(a => {
          const acc = a.acc != null && a.acc !== '' ? Number(a.acc) : null, pct = !!WD.parseApproval(a);
          if (pct && !(a.zp || payAcc.has(acc))) return null;
          /* «Вносити» = «ні» (не «% менеджера») — погодження, яке реєстр не вносить: повернення коштів клієнтам тощо. Раніше його тут
             не було, і операцію банку забирало чуже погодження з тією самою сумою — «Внести в CRM» відсилало в «Погодження», де такого
             рядка немає (12.11.2026, повернення Гурському 6 000,00). Тепер воно йде окремим видом (off): пара лише зі своїм рахунком і
             названим отримувачем, а вносять таку операцію в «Внести в CRM» — 18.11.2026 */
          const off = !pct && a.action === 'ні';
          return { key: String(a.key), acc, owner: acc == null ? '' : firmOf(acc), date: a.date, amount: r2(pct ? Number(a.textAmount) || 0 : Number(a.amount) || Number(a.textAmount) || 0),
            recipient: clean(a.recipient), text: clean(a.content || a.comment), crmId: Number(a.id) || 0, action: a.action, zp: !!a.zp, pct, ...(off ? { off: true } : {}) };
        })
        .filter(a => a && a.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(a.date || ''));
      const res = MT.match(bank, ap);
      // ID записів CRM, які реєстр уже вніс (будь-який рядок, і податки, і «% менеджера»): такий запис — від свого погодження, не «вже є в CRM» для іншого
      const claimed = new Set(S.wd.rows.map(a => Number(a && a.id) || 0).filter(Boolean));
      // рядки реєстру за ключем — для податків пакета ЗП («Внести в CRM»): рядок «податки» погодження — ключ + «#tax»
      const raw = new Map(S.wd.rows.filter(a => a && a.key).map(a => [String(a.key), a]));
      S.mt = { key, res, byX, byBank: new Map(res.rows.map(m => [m.bank, m])), banked, claimed, raw };
      return S.mt;
    }
    // підказки ШІ — лише для того самого розрахунку (той самий період і ті самі дані)
    const mtAiNow = () => (S.mtAi && S.lastMt && S.mtAi.key === S.lastMt.key ? S.mtAi : null);
    const apWho = a => `«${a.recipient || '—'}» ${fmt(a.amount)}`;
    function mtHtml() {
      const head = `<div class="card" data-b="mt"><div class="sub-h"><h3>Зіставлення ШІ за ${esc(dmy(S.from))}–${esc(dmy(S.to))}</h3><span class="muted small">операції банку ↔ погодження реєстру ↔ записи CRM</span></div>
<details class="hint" style="margin:0 0 10px"><summary>Як це працює</summary><div>Спершу лінтер зіставляє сам: <b>ЗП одним переказом</b> на «Ціл-ві зарах.» — це пакет Привату на N карток, тобто N людей, тож шукаються погодження на руки N людей, що разом дають суму пакета до копійки: одна людина може отримати кілька погоджень на одну картку (ЗП і премію), погодження може бути з іншого рахунку тієї самої фірми, а тімлід — отримувачем погоджень за свою команду; пара — лише якщо такий набір один. Якщо всі пакети рахунку за день разом дорівнюють усім погодженням цього дня (з «% менеджера», оплаченими через зарплатний проєкт), пакети беруть їх без поділу по людях; спершу беруться погодження дня пакета, давніші — лише коли з них набору немає; <b>інша витрата</b> — погодження з тією самою сумою (спершу з того самого рахунку, від тижня до оплати до дня після); <b>податки із ЗП</b> (ПДФО, ВЗ, ЄСВ одного дня) — групою з підсумком, бо в CRM їх розносять по людях. Що лишилось, кнопка «Зіставити решту з ШІ» відправляє в Claude через «Помічник кешфлоу» (ключ API — у Помічнику; номери рахунків і карток приховано): ШІ вибирає лише серед переданих погоджень і пояснює чому. Тут нічого не створюється й не змінюється. Операцію банку, для якої є погодження, «Внести в CRM» більше не пропонує внести — щоб не було дублю: її вносять у «Погодженні». «% менеджера / м-рів / тімліда» — у «Виводах з балансу».</div></details>`;
      if (!regCfg()) return `${head}<div class="info">Реєстр погоджень у цьому браузері не налаштовано (⚙ у вкладці «Погодження») — зіставляти немає з чим.</div></div>`;
      if (S.wd.error) return `${head}<div class="err">Реєстр погоджень не відповів: ${esc(S.wd.error)} <span class="lnk" data-b="mtretry">Спробувати ще раз</span></div></div>`;
      const T = S.lastMt;
      if (!T) return `${head}<div class="info">Читаю погодження з реєстру…</div></div>`;
      const { res } = T, ai = mtAiNow(), aiBy = new Map(((ai && ai.list) || []).map(s => [s.bank, s]));
      const pays = res.rows.filter(m => m.how === 'пакет'), ones = res.rows.filter(m => m.how === '1:1');
      const loose = res.free.bank.filter(b => b.kind !== 'pay' && !b.crm);
      const freeA = res.free.ap.filter(a => a.date >= S.from && a.date <= S.to && !a.crmId && a.action === 'так' && T.banked.has(a.acc));
      /* операція банку вже є в CRM (пара, група «суми не 1:1», ЗП за день), а погодження в реєстрі без ID: у «Погодженні» його не вносять —
         реєстр шукає дубль лише з тією самою сумою й не побачить 20 000 + 10 000 замість 30 000 (08.11.2026). Рахуються лише записи, яких
         не вніс сам реєстр (ID не належить жодному погодженню): запис іншого погодження — не «вже є» (дві однакові суми, ЗП кількох пакетів дня). */
      const extraIds = b => MT.crmIdsOf(b).filter(id => !(T.claimed && T.claimed.has(id)));
      // пара з погодженням, якого реєстр не вносить (off, 18.11.2026), — не «внести у «Погодженні»» і не «у реєстрі без ID»: її вносять у «Внести в CRM»
      const dupOf = m => !m.off && MT.crmState(m.ap) !== 'в CRM' && extraIds(m.bank).length > 0;
      const notIn = res.rows.filter(m => !m.off && MT.crmState(m.ap) !== 'в CRM' && !dupOf(m)), dupIn = res.rows.filter(dupOf);
      const DUP_TXT = 'у реєстрі погодження без ID запису CRM — у «Погодженні» не вносьте (буде дубль): у реєстрі поставте «Вносити» = «ні»';
      const crmIdsTxt = b => { const l = extraIds(b); return `ID ${l.slice(0, 4).join(', ')}${l.length > 4 ? ` і ще ${l.length - 4}` : ''}`; };
      const pill = (cls, t) => `<span class="pill ${cls}">${esc(t)}</span>`;
      const aiTxt = a => (a ? `<div class="warn" style="margin:4px 0 0;padding:4px 8px;font-weight:400">ШІ (${esc(a.conf)}): ${esc(a.ap.map(apWho).join(' + '))}${isZero(a.diff) ? ' — сума сходиться' : ` — різниця ${esc(fmt(a.diff))}`}${a.why ? `. ${esc(a.why)}` : ''}</div>` : '');
      const crmTxt = (aps, acc) => aps.map(a => `<div>${esc(a.recipient || '—')} · <b>${esc(fmt(a.amount))}</b>${acc != null && a.acc != null && a.acc !== acc ? ` <span class="muted">· погоджено з «${esc(nameOf(a.acc))}»</span>` : ''} · ${a.pct ? `<span class="muted">% з балансу${a.crmId ? ` (податки — ID ${a.crmId})` : ''}: вивід — у «Виводах з балансу»</span>` : a.crmId ? `<span class="ok">у CRM ID ${a.crmId}</span>` : '<span class="bad">не внесено</span>'}</div>`).join('');
      // чому пакет не розкладено (16.11.2026): погоджень дня немає — ЗП з відомості; їх менше, ніж у пакеті, — скільки бракує
      const ambTxt = a => (a.none ? 'погоджень на цю суму немає — схоже, ЗП з відомості бухгалтерії'
        : a.short ? `за день погоджень на ${fmt(a.short.have)}, не вистачає ${fmt(a.short.miss)} — перевірте «Звідки оплата» в погодженнях цього дня`
          : a.count >= 2 ? 'цю суму дають кілька наборів погоджень — вирішить ШІ чи ви'
            : a.big ? 'в однієї людини забагато погоджень (понад 12) — усі набори не перебрано; вирішить ШІ чи ви'
              : a.over ? 'забагато варіантів — вирішить ШІ чи ви' : 'набору погоджень на цю суму немає');
      let h = `${head}<div class="row" style="margin:0 0 10px">${pill(res.rows.length ? 'st-ok' : 'st-locked', `зійшлося з погодженнями: ${res.rows.length}`)}${notIn.length ? pill('st-manual', `з них не все в CRM: ${notIn.length} — внести у «Погодженні»`) : ''}${dupIn.length ? pill('st-review', `у CRM уже є, у реєстрі без ID: ${dupIn.length} — не вносьте вдруге`) : ''}${pays.length + res.amb.length ? pill(res.amb.length ? 'st-review' : 'st-ok', `ЗП-пакетів розкладено: ${pays.length} з ${pays.length + res.amb.length}`) : ''}${pill(loose.length ? 'st-review' : 'st-locked', `у банку без погодження: ${loose.length}`)}${pill(freeA.length ? 'st-review' : 'st-locked', `погоджено, у виписці немає: ${freeA.length}`)}</div>`;
      // ШІ — на кнопку: залишок (без погодження й без пари в CRM, нерозкладені пакети) ↔ погодження без операції
      const left = MT.aiPayload(res, nameOf), u = ai && ai.j && ai.j.usage;
      const aiState = !opts.aiMatch ? 'ШІ тут недоступний: закладка без «Помічника кешфлоу»' : S.mtBusy ? 'ШІ думає…'
        : ai && ai.error ? `ШІ не відповів: ${ai.error}` : ai && ai.empty ? 'залишку для ШІ немає'
          : ai && ai.j && ai.j.ok === false ? `ШІ не відповів: ${ai.j.error || ai.j.state_ua || ''}`
            : ai && ai.j && ai.j.state !== 'ready' && !ai.j.cached ? `ШІ не запущено: ${ai.j.state_ua}${ai.j.state === 'nokey' ? ' — ключ Claude API вставляють у Помічнику («Налаштування» → «ШІ-підказки»)' : ''}`
              : ai ? `ШІ знайшов пари: ${ai.list.length} з ${left.bank.length}${ai.j.cached ? ' (збережена відповідь)' : ''} · ${esc(ai.j.model || 'Claude')}${u ? ` · цього місяця $${Number(u.usd).toFixed(2)} з $${u.limit}` : ''}`
                : `у ШІ піде: операцій ${left.bank.length}, погоджень ${left.approvals.length}`;
      h += `<div class="row" style="margin:0 0 12px"><button class="primary" data-b="mtai"${opts.aiMatch && !S.mtBusy && left.bank.length && left.approvals.length ? '' : ' disabled'}>Зіставити решту з ШІ</button><span class="muted small">${esc(aiState)}</span></div>`;
      const tbl = (title, n, cols, body) => (n ? `<div class="lbl" style="margin:14px 0 6px">${esc(title)} · ${n}</div><div class="tbl" style="max-height:52vh"><table class="xf"><tr>${cols.map(c => `<th${c[1] ? ' class="n"' : ''}>${esc(c[0])}</th>`).join('')}</tr>${body}</table></div>` : '');
      // 1) ЗП пакетами
      const payRows = [...pays.map(m => ({ b: m.bank, m })), ...res.amb.map(a => ({ b: a.bank, amb: a }))].sort((p, q) => (p.b.date < q.b.date ? -1 : 1));
      h += tbl('ЗП одним переказом (пакети Привату)', payRows.length, [['Дата'], ['Рахунок'], ['Пакет', 1], ['Погодження на руки ↔ CRM'], ['Стан']], payRows.map(({ b, m, amb }) => {
        const stt = m ? MT.crmState(m.ap) : '', dup = !!m && dupOf(m);
        return `<tr class="${m ? (stt === 'в CRM' ? 's-ok' : dup ? 's-part' : 's-bad') : 's-part'}"><td style="white-space:nowrap">${esc(dmy(b.date))}</td><td>${esc(nameOf(b.acc))}</td>
<td class="n">${esc(fmt(b.amount))}<div class="muted" style="font-weight:400;font-size:12px">${b.cards ? `карток: ${b.cards}` : 'карток не видно'}${b.packet ? `<br>№${esc(b.packet)}` : ''}</div></td>
<td class="xwhy">${m ? crmTxt(m.ap, b.acc) : `<span class="muted">${esc(ambTxt(amb))}</span>`}${aiTxt(aiBy.get(b))}</td>
<td>${m ? (stt === 'в CRM' ? '<span class="ok">усе в CRM по людях</span>' : dup ? `<div class="warn" style="margin:0;padding:4px 8px;font-weight:400">у CRM ЗП цього дня вже є (${esc(crmIdsTxt(b))}) — ${esc(DUP_TXT)}</div>` : `<span class="bad">${esc(stt)}: внесіть у «Погодженні»</span>`) : '<span class="muted">не розкладено</span>'}</td></tr>`;
      }).join(''));
      // 2) податки із ЗП — групою; у CRM — записи «Податки…» того дня на тому самому рахунку (реєстр розносить їх по людях)
      h += tbl('Податки із ЗП', res.taxes.length, [['Дата'], ['Рахунок'], ['Платежі банку'], ['Разом', 1], ['У CRM «Податки…» того дня', 1]], res.taxes.map(g => {
        const cr = (S.items.get(g.acc) || []).filter(c => c.date === g.date && c.opc === 2 && /^\s*податк/i.test(c.comment || ''));
        return `<tr><td style="white-space:nowrap">${esc(dmy(g.date))}</td><td>${esc(nameOf(g.acc))}</td><td class="xwhy">${g.items.map(b => `<div>${esc(taxName(b.text))} ${esc(g.month)} · <b>${esc(fmt(b.amount))}</b></div>`).join('')}</td>
<td class="n">${esc(fmt(g.total))}</td><td class="n">${cr.length ? `${esc(fmt(r2(-cr.reduce((s, c) => s + c.amount, 0))))}<div class="muted" style="font-weight:400;font-size:12px">записів: ${cr.length}</div>` : '<span class="muted">—</span>'}</td></tr>`;
      }).join(''));
      // 3) одна операція — одне погодження
      h += tbl('Операції банку з погодженням', ones.length, [['Дата'], ['Рахунок'], ['Сума', 1], ['Погодження ↔ CRM'], ['Операція банку']], ones.map(m => {
        const stt = MT.crmState(m.ap), a = m.ap[0], dup = dupOf(m), inCrm = MT.crmIdsOf(m.bank);
        // off: реєстр це погодження не вносить — рядок без тривоги; операцію вносять у «Внести в CRM» (або вона вже є в CRM)
        if (m.off) return `<tr class="${inCrm.length ? 's-ok' : ''}"><td style="white-space:nowrap">${esc(dmy(m.bank.date))}</td><td>${esc(nameOf(m.bank.acc))}</td><td class="n">${esc(fmt(m.bank.amount))}</td>
<td class="xwhy"><div>${esc(a.recipient || '—')} · <b>${esc(fmt(a.amount))}</b> · <span class="muted">«Вносити» = «ні»</span></div><div class="muted">погоджено ${esc(dmy(a.date))}${a.text ? ` · ${esc(a.text.slice(0, 90))}` : ''}</div><div class="muted">${inCrm.length ? `реєстр не вносить — у CRM уже є (ID ${esc(inCrm.slice(0, 4).join(', '))})` : 'реєстр не вносить — внесіть у «Внести в CRM»'}</div></td>
<td class="muted xwhy">${esc(m.bank.cpty)}${m.bank.text ? ` · ${esc(m.bank.text.slice(0, 120))}` : ''}</td></tr>`;
        return `<tr class="${stt === 'в CRM' ? 's-ok' : dup ? 's-part' : 's-bad'}"><td style="white-space:nowrap">${esc(dmy(m.bank.date))}</td><td>${esc(nameOf(m.bank.acc))}</td><td class="n">${esc(fmt(m.bank.amount))}</td>
<td class="xwhy">${crmTxt(m.ap)}<div class="muted">погоджено ${esc(dmy(a.date))}${m.other ? ` · з рахунку «${esc(nameOf(a.acc))}» — у виписці інший` : ''}${a.text ? ` · ${esc(a.text.slice(0, 90))}` : ''}</div>${stt === 'в CRM' ? '' : dup ? `<div class="warn" style="margin:4px 0 0;padding:4px 8px;font-weight:400">операція банку вже є в CRM (${esc(crmIdsTxt(m.bank))}) — ${esc(DUP_TXT)}</div>` : '<div class="bad">не внесено — внесіть у «Погодженні»</div>'}</td>
<td class="muted xwhy">${esc(m.bank.cpty)}${m.bank.text ? ` · ${esc(m.bank.text.slice(0, 120))}` : ''}</td></tr>`;
      }).join(''));
      // 4) у банку без погодження (і без пари в CRM) — з підказкою ШІ
      h += tbl('У банку без погодження й без запису в CRM', loose.length, [['Дата'], ['Рахунок'], ['Сума', 1], ['Отримувач · призначення'], ['ШІ']], loose.map(b => `<tr><td style="white-space:nowrap">${esc(dmy(b.date))}</td><td>${esc(nameOf(b.acc))}</td><td class="n">${esc(fmt(b.amount))}</td>
<td class="xwhy">${esc(b.cpty)}${b.text ? ` · ${esc(b.text.slice(0, 140))}` : ''}${b.kind === 'tax' ? '' : ''}</td><td class="xwhy">${aiTxt(aiBy.get(b)) || '<span class="muted">—</span>'}</td></tr>`).join(''));
      // 5) погоджено, у виписці немає (рахунки з випискою за період)
      h += tbl('Погоджено, у виписці немає', freeA.length, [['Дата оплати'], ['Кому'], ['Сума', 1], ['Рахунок'], ['Зміст']], freeA.map(a => `<tr><td style="white-space:nowrap">${esc(dmy(a.date))}</td><td>${esc(a.recipient || '—')}</td><td class="n">${esc(fmt(a.amount))}</td>
<td>${esc(a.acc != null ? nameOf(a.acc) : '—')}</td><td class="muted xwhy">${esc(a.text.slice(0, 140))}</td></tr>`).join(''));
      if (!res.rows.length && !res.amb.length && !res.taxes.length && !loose.length && !freeA.length) h += '<div class="empty">За період немає ні списань для зіставлення, ні погоджень без операції.</div>';
      return h + (notIn.length ? '<div class="row" style="margin-top:10px"><span class="lnk" data-b="mtappr">Відкрити «Погодження»</span></div>' : '') + '</div>';
    }
    function bindMt() {
      const q = k => $('out').querySelector(`[data-b="${k}"]`);
      if (q('mtai')) q('mtai').onclick = mtAi;
      if (q('mtretry')) q('mtretry').onclick = () => { S.wd.error = ''; render(); };
      if (q('mtappr')) q('mtappr').onclick = () => { if (opts.go) opts.go('appr'); };
    }
    // залишок — у Claude через Помічник; відповідь лише підказує (core/matching.js → aiApply перевіряє, що пари справді є)
    async function mtAi() {
      const T = S.lastMt;
      if (!T || !opts.aiMatch || S.mtBusy) return;
      const pay = MT.aiPayload(T.res, nameOf);
      if (!pay.bank.length || !pay.approvals.length) { S.mtAi = { key: T.key, empty: true, list: [] }; render(); return; }
      S.mtBusy = true;
      render();
      try {
        const j = await opts.aiMatch(pay);
        S.mtAi = { key: T.key, j, list: MT.aiApply(T.res, (j && j.matches) || []) };
      } catch (e) {
        S.mtAi = { key: T.key, error: e.message || String(e), list: [] };
      } finally {
        S.mtBusy = false;
        render();
      }
    }
    async function checkMonth() {
      const m = $('cm').value;
      if (!m || S.busy || S.closing) return;
      $('notes').innerHTML = '';
      if (closedTo() && m <= closedTo()) { note(`${monthName(m)} уже закрито в CRM — перевіряти нічого.`, 'info'); return; }
      const b = monthBounds(m, today()), cst = t => { $('cm-st').textContent = t; };
      $('from').value = b.from; $('to').value = b.to;
      if (S.kind !== 'all') { S.kind = 'all'; $('kind').querySelectorAll('[data-kind]').forEach(x => x.classList.toggle('on', x.dataset.kind === 'all')); }
      S.close = { month: m, from: b.from, to: b.to, last: b.last, full: b.full, lint: undefined, reg: undefined, noHelper: false };
      S.closing = true;
      S.sec = 'close';
      applySec();
      $('cm-go').disabled = true;
      try {
        cst('виписки банків за місяць…');
        try { await hreq('/api/panel/bank/status'); } catch (e) { S.close.noHelper = true; }
        if (!S.close.noHelper) await fetchStatements(false);
        if (!S.items || S.from !== b.from || S.to !== b.to) { const keep = $('notes').innerHTML; await calc(); if (keep) $('notes').insertAdjacentHTML('afterbegin', keep); }
        if (!S.items || S.from !== b.from || S.to !== b.to) return; // звірка не вдалася — причина в повідомленнях вище
        render();
        cst('перевіряю «Статті й проєкти», погодження й виводи з балансу…');
        // реєстр — одним запитом: невнесені погодження з датою оплати в цьому місяці (касовий метод) і погодження для «Виводів з балансу»
        const regTo = [b.last, today()].sort()[0], w = wdWin();
        const [lint, reg] = await Promise.all([
          opts.lintPeriod ? opts.lintPeriod(b.from, b.to).catch(e => ({ error: e.message })) : Promise.resolve(null),
          wdLoad(w.from, [regTo, w.to].sort().pop()).then(j => (j ? regOpen(j, b.from, regTo) : null)).catch(e => ({ error: e.message })),
        ]);
        if (S.close && S.close.month === m) Object.assign(S.close, { lint, reg });
        render();
        const card = $('out').querySelector('[data-b="close"]');
        if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } finally { S.closing = false; cst(''); $('cm-go').disabled = S.busy || !$('cm').value; }
    }
    $('cm-go').onclick = checkMonth;
    function closeHtml(all) {
      const C = S.close;
      if (!C || C.from !== S.from || C.to !== S.to || S.kind !== 'all') return '';
      const rep = closeReport(all, { types: typeFixes(all), repoints: S.lastReps, lint: C.lint, reg: C.reg, wd: wdPart(), noHelper: C.noHelper, newCards: S.lastNewCards.length, drafts: draftItems(), draftsEmpty: S.drafts ? S.drafts.empty : 0 }), wait = C.lint === undefined, mon = monthName(C.month);
      const later = k => wait && (k === 'reg' || k === 'lint' || k === 'wd');
      const head = wait ? '<div class="info">Звірку з банком готово; перевіряю «Статті й проєкти», погодження й виводи з балансу…</div>'
        : rep.verdict === 'ready' ? `<div class="good">✓ ${esc(mon)}: можна закривати.${C.full ? '' : ` Місяць ще не закінчився — перевірте ще раз після ${esc(dmy(C.last))}.`}</div>`
        : rep.verdict === 'partial' ? `<div class="warn">${esc(mon)}: розбіжностей не знайдено, але не все перевірено (позначено «—»). Закривайте, коли перевірите й це.</div>`
        : `<div class="err">${esc(mon)}: ще не готово до закриття — ${esc(rep.items.filter(i => i.ok === false).map(i => i.fail).join(', '))}.</div>`;
      const icon = ok => (ok === true ? '<span class="ok">✓</span>' : ok === false ? '<span class="bad">✗</span>' : '<span class="muted">—</span>');
      const go = { reg: 'appr', lint: 'cat' }, sec = { bank: 'add', own: 'add', type: 'fix', crm: 'acc', bal: 'acc', wd: 'wd' };
      return `<div class="card" data-b="close"><h3>${esc(mon)} <span class="muted" style="font-weight:400">${esc(dmy(C.from))}–${esc(dmy(C.to))}</span></h3>${head}
<table class="cl">${rep.items.map(i => `<tr><td class="ic">${later(i.key) ? '<span class="muted">…</span>' : icon(i.ok)}</td><td><b>${esc(i.title)}</b>${opts.go && go[i.key] ? ` <span class="lnk" data-go="${go[i.key]}">відкрити вкладку</span>` : ''}${i.ok === false && sec[i.key] ? ` <span class="lnk" data-go-sec="${sec[i.key]}">відкрити розділ</span>` : ''}
<div class="muted">${esc(later(i.key) ? 'перевіряю…' : i.text)}</div>${!later(i.key) && i.list.length ? `<details><summary>Показати список (${i.list.length + i.more})</summary><ul>${i.list.map(x => `<li>${esc(x)}</li>`).join('')}${i.more ? `<li class="muted">і ще ${i.more}</li>` : ''}</ul></details>` : ''}</td></tr>`).join('')}</table>
<details class="hint"><summary>Хто закриває місяць</summary><div>Тут нічого не змінюється. Закриває місяць Адмін у CRM (P&amp;L → «Закриття періоду»); після цього записи місяця змінює лише він, а лінтер цей місяць більше не перевіряє.</div></details></div>`;
    }

    // ---------- нові корп. картки у виписці ----------
    /* Покупки карткою, номера якої лінтер не знає (немає ні в назві рахунку CRM, ні в довіднику rules.json): у виписці рахунку
       «4246 **** **** NNNN ДД.ММ.РРРР ГГ:ХХ:СС … продавець» (перекази на картку — не покупки). Поки картку не знають, її покупки —
       «немає в CRM» на рахунку банку, а записи на рахунку картки — «немає в банку». Рахунок картки в CRM — корп. картка власника
       рахунку банку, на яку записано найбільше цих покупок (та сама сума; дата — від дня перед покупкою до дня після проведення);
       якщо покупок у CRM немає — єдина картка власника без номера в назві, якої ще не взяла інша нова картка.
       → [{last4, debit, rows, sum, from, to, cands, sug: {id, why} | null}] */
    function newCards() {
      return S.dir && S.items ? findNewCards({ banks: S.banks, known: S.dir.cards, items: S.items, accs: S.accs || [], from: S.from, to: S.to }) : [];
    }
    function cardsHtml() {
      const list = S.lastNewCards, local = LS.get(LOCAL_CARDS, []);
      if (!list.length && !local.length) return '';
      let h = `<div class="card" data-b="cards"><div class="sub-h"><h3>Нові корп. картки у виписці</h3><span class="muted small">${list.length ? 'покупки карткою, номера якої лінтер не знає' : 'усі картки з виписок лінтер знає'}</span></div>`;
      if (list.length) h += `<details class="hint" style="margin:0 0 4px"><summary>Що це і що робити</summary><div>У CRM немає рахунку з цим номером у назві, у rules.json — картки. Поки її не знають, покупки нею — «немає в CRM» на рахунку банку, а записи на рахунку картки — «немає в банку». Виберіть рахунок картки й натисніть «Запам'ятати» — звірка й «Погодження» одразу знатимуть картку (у цьому браузері; у CRM нічого не змінюється). Щоб знали всі, і колега теж, дайте рахунку картки в CRM назву з номером («корп. картка ${esc(list[0].last4)} …») — лінтер бере номер з назви.</div></details>`;
      for (const c of list) {
        const ms = [...c.rows.reduce((m, x) => { const v = merchantOf(x.purpose); if (v) m.set(v, (m.get(v) || 0) + 1); return m; }, new Map())].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v]) => v);
        const pick = S.cp.has(c.last4) ? S.cp.get(c.last4) : c.sug ? c.sug.id : null;
        const sel = `<select data-ccard="${esc(c.last4)}" data-wide style="max-width:320px"><option value="">— рахунок картки в CRM —</option>${c.cands.map(a => `<option value="${a.id}"${a.id === pick ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`;
        const why = c.sug && pick === c.sug.id ? `<span class="muted">${esc(c.sug.why)}</span>` : !pick && c.cands.length ? '<span class="muted">цих покупок у CRM не знайдено — виберіть рахунок картки</span>' : '';
        h += `<div class="pr"><b>…${esc(c.last4)}</b> · списує з «${esc(nameOf(c.debit))}» · ${c.rows.length} ${plural(c.rows.length, 'покупка', 'покупки', 'покупок')} на ${fmt(Math.abs(c.sum))} (${esc(dmy(c.from))}–${esc(dmy(c.to))})${ms.length ? ` · ${esc(ms.join(', '))}` : ''}
<div class="row" style="margin:4px 0 0">${c.cands.length ? `${sel} <button data-cremember="${esc(c.last4)}"${pick ? '' : ' disabled'}>Запам'ятати</button> ${why}`
          : `<span class="bad" style="font-weight:400">у CRM немає корп. картки ${esc(Rc.ownerOf(nameOf(c.debit)) || 'цього власника')}: заведіть рахунок «корп. картка ${esc(c.last4)} …» — лінтер візьме номер з назви</span>`}</div></div>`;
      }
      if (local.length) h += `<div class="pr muted">Запам'ятано в цьому браузері: ${local.map(e => `…${esc(e.last4)} → «${esc(nameOf(Number(e.account_id)))}» <span class="lnk" data-cforget="${esc(e.last4)}">забути</span>`).join(' · ')}</div>`;
      return h + '</div>';
    }
    function bindCards() {
      const box = $('out');
      box.querySelectorAll('[data-ccard]').forEach(e => e.onchange = () => { S.cp.set(e.dataset.ccard, Number(e.value) || null); render(); });
      box.querySelectorAll('[data-cremember]').forEach(e => e.onclick = () => {
        const c = S.lastNewCards.find(x => x.last4 === e.dataset.cremember), id = c && (S.cp.has(c.last4) ? S.cp.get(c.last4) : c.sug && c.sug.id);
        if (!c || !id || S.busy) return;
        const card = { last4: c.last4, account_id: id, account: nameOf(id), debit_account_id: c.debit, debit_account: nameOf(c.debit),
          note: `запам'ятано у «Звірці з банком» ${dmy(today())}: покупки цією карткою — у виписці «${nameOf(c.debit)}»`, local: true };
        LS.set(LOCAL_CARDS, LS.get(LOCAL_CARDS, []).filter(x => String(x.last4) !== c.last4).concat(card));
        const ref = opts.rulesDoc ? (opts.rulesDoc.reference = opts.rulesDoc.reference || {}) : null;
        if (ref) ref.cards = (ref.cards || []).filter(x => !(x.local && String(x.last4) === c.last4)).concat(card);
        CARDS.push(card);
        S.bv++;
        render();
      });
      box.querySelectorAll('[data-cforget]').forEach(e => e.onclick = () => {
        const t = e.dataset.cforget, was = LS.get(LOCAL_CARDS, []).find(x => String(x.last4) === t);
        LS.set(LOCAL_CARDS, LS.get(LOCAL_CARDS, []).filter(x => String(x.last4) !== t));
        const ref = opts.rulesDoc && opts.rulesDoc.reference;
        if (ref && ref.cards) ref.cards = ref.cards.filter(x => !(x.local && String(x.last4) === t));
        for (let i = CARDS.length - 1; i >= 0; i--) if (CARDS[i].local && String(CARDS[i].last4) === t) CARDS.splice(i, 1);
        // зв'язок «картка → рахунок банку», запам'ятаний звіркою, — теж
        const seen = LS.get('cfl_card_into', {});
        if (was && Number(seen[was.account_id]) === Number(was.debit_account_id)) { delete seen[was.account_id]; LS.set('cfl_card_into', seen); }
        S.bv++;
        render();
      });
    }

    function matchBanks() {
      if (!S.accs) return;
      const res = Rc.matchAccounts(S.banks, S.accs, S.ccy || {}, LS.get('cfl_bank_map', {}));
      S.banks.forEach((b, i) => { b.cfId = res[i].cfId; b.note = res[i].note; b.fixed = res[i].fixed; b.service = !!res[i].service; b.second = !!res[i].second; });
      S.bv++;
    }
    function renderFiles() {
      const files = [...new Set(S.banks.map(b => b.fileName))];
      if (!files.length) { $('files').textContent = HINT; $('map').innerHTML = ''; return; }
      const fwm = new Map();
      S.banks.forEach(b => (b.warnings || []).filter(w => FILE_WARN.test(w) || FILE_SHOW.test(w)).forEach(w => {
        const k = `${b.bank === 'mono' ? 'Моно' : 'Приват'}${FILE_SHOW.test(w) && !FILE_WARN.test(w) && b.iban ? ` ${tail(b.iban)}` : ''}: ${w}`;
        if (!fwm.has(k)) fwm.set(k, new Set()); fwm.get(k).add(b.client || b.owner || ''); }));
      const fw = [...fwm].map(([k, cl]) => { const who = [...cl].filter(Boolean); return who.length ? `${k} (${who.join(', ')})` : k; });
      // той самий рахунок банку з кількох виписок (той самий IBAN) — один рядок; файл під період вибирає звірка
      const uniq = [], seenK = new Map();
      S.banks.forEach((b, i) => { const k = b.iban || `#${i}`; if (seenK.has(k)) seenK.get(k).files.push(b); else { const u = { b, i, files: [b] }; seenK.set(k, u); uniq.push(u); } });
      $('files').innerHTML = `Виписки: ${files.map(esc).join(', ')} · рахунків банку: ${uniq.length} · <span class="lnk" data-b="clear">прибрати виписки</span>${fw.length ? `<br>${fw.map(esc).join('<br>')}` : ''}`;
      $('files').querySelector('[data-b="clear"]').onclick = () => { S.banks = []; S.bv++; renderFiles(); render(); };
      if (!S.accs) { $('map').innerHTML = ''; return; }
      const n = uniq.filter(u => u.b.cfId).length;
      // потрібна дія — рахунок банку не зіставлено автоматично (не знайдено чи кілька збігів), і людина ще не вибрала ні рахунок CRM, ні «не звіряти»
      // рахунок без операцій у виписці й з нульовим залишком на звірку не впливає — дії не потребує
      // у таблиці: спершу ті, що потребують дії, далі зіставлені, наприкінці сірим — службові, порожні («звіряти нічого»), «не звіряти», ще один рахунок
      const act = ({ b, files: fl }) => !b.cfId && !b.fixed && !b.service && !b.second && fl.some(x => x.rows.length || Math.abs(Number(x.closing) || 0) >= 0.005);
      const need = uniq.filter(act).length;
      const opt = sel => '<option value="">— не звіряти —</option>' + S.accs.map(a => `<option value="${a.id}"${a.id === sel ? ' selected' : ''}>${esc(a.name)} (id ${a.id})</option>`).join('');
      $('map').innerHTML = `<details style="margin-top:8px"${S.mapOpen ? ' open' : ''}><summary>Рахунки з виписок → рахунки CRM: зіставлено ${n} з ${uniq.length}${need ? ` <span class="need" title="Рахунків банку без рахунку CRM: ${need}. Відкрийте й виберіть рахунок CRM або «— не звіряти —» (вибір запам'ятається)">потрібна дія: ${need}</span>` : ''}</summary>
<div class="tbl" style="max-height:none;margin-top:8px"><table><tr><th>Банк</th><th>Рахунок банку</th><th>Валюта</th><th>Клієнт</th><th>Виписка</th><th>Операцій</th><th>Рахунок CRM</th></tr>
${uniq.map(u => ({ ...u, k: act(u) ? 0 : u.b.cfId ? 1 : 2 })).sort((x, y) => x.k - y.k || x.i - y.i).map(({ b, i, files: fl, k }) => `<tr${k === 2 ? ' class="hid"' : ''}><td>${b.bank === 'mono' ? 'Моно' : 'Приват'}</td><td title="${esc(b.iban || '')}">${esc(tail(b.iban))}<div class="muted" style="font-size:12px">${esc(b.owner || '')}</div></td><td>${esc(b.ccy || '')}</td><td>${esc(b.client || '')}</td><td>${fl.map(x => `${esc(dmy(x.fileFrom))}–${esc(dmy(x.fileTo))}`).join('<br>')}</td><td class="n">${fl.map(x => x.rows.length).join('<br>')}</td>
<td><select data-map="${i}">${opt(b.cfId)}</select> <span class="muted">${esc(b.note || '')}</span></td></tr>`).join('')}</table></div></details>`;
      $('map').querySelector('details').ontoggle = e => { S.mapOpen = e.target.open; };
      $('map').querySelectorAll('[data-map]').forEach(s => s.onchange = () => {
        const b = S.banks[+s.dataset.map];
        b.cfId = +s.value || null;
        if (b.iban) { const map = LS.get('cfl_bank_map', {}); map[b.iban] = b.cfId || 0; LS.set('cfl_bank_map', map); } // 0 — «не звіряти», теж запам'ятовується
        matchBanks();
        renderFiles(); render();
      });
      Cmb.enhance($('map'));
    }
    /* Виписка для рахунку CRM за період: на кожен рахунок банку (IBAN) — файл, що покриває період, інакше найновіший.
       Кілька різних рахунків банку на один рахунок CRM — звіряються разом (сума залишків, усі операції). */
    function bankFor(acc, from, to) {
      const byIban = new Map();
      for (const b of S.banks) {
        if (b.cfId !== acc.id) continue;
        const k = b.iban || b.fileName;
        if (laterBank(b, byIban.get(k), from, to)) byIban.set(k, b);
      }
      const list = [...byIban.values()];
      if (list.length <= 1) return list[0] || null;
      const sum = k => (list.every(x => x[k] != null) ? r2(list.reduce((s, x) => s + x[k], 0)) : null);
      const maxOf = k => list.map(x => x[k]).filter(Boolean).sort().pop(), minOf = k => list.map(x => x[k]).filter(Boolean).sort()[0];
      return { ...list[0], rows: list.flatMap(x => x.rows), opening: sum('opening'), closing: sum('closing'), fileOpening: sum('fileOpening'), fileClosing: sum('fileClosing'),
        fileFrom: maxOf('fileFrom'), fileTo: minOf('fileTo'), iban: list.map(x => x.iban).join(' + '),
        warnings: [`рахунок CRM зіставлено з ${list.length} рахунками банку — звіряються разом`, ...list.flatMap(x => x.warnings)] };
    }

