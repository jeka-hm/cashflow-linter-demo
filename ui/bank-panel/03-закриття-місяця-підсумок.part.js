  function closeReport(all, parts) {
    parts = parts || {};
    // fail — що не так, коротко (для висновку)
    const items = [], add = (key, title, fail, ok, text, list) => items.push({ key, title, fail, ok, text, list: (list || []).slice(0, 8), more: Math.max(0, (list || []).length - 8) });
    const nm = r => r.a.name, short = s => clean(s).slice(0, 70);
    // рахунки, що стосуються місяця: є записи CRM за місяць, виписка чи залишок банку, введений вручну; corpCard, зведений з рахунком
    // банку, — у рядку цього рахунку
    const accs = all.filter(r => r.status !== 'merged' && (r.R.crm.n > 0 || r.b || r.manual !== undefined));
    const cov = accs.filter(r => r.R.covered); // рахунки, виписка яких покриває весь місяць: лише по них видно операції без пари
    const reg = parts.reg;
    if (!reg) add('reg', 'Погодження внесено', 'невнесені погодження', null, 'реєстр погоджень у цьому браузері не налаштовано (⚙ у вкладці «Погодження») — не перевірено');
    else if (reg.error) add('reg', 'Погодження внесено', 'невнесені погодження', null, `реєстр не відповів: ${reg.error}`);
    else {
      const n = reg.open.length, k = reg.check.length;
      add('reg', 'Погодження внесено', 'невнесені погодження', !n && !k, n || k ? `${[n ? `не внесено: ${n}` : '', k ? `чекають рішення («перевірити»): ${k}` : ''].filter(Boolean).join(', ')} — вкладка «Погодження»`
        : `усі погоджені виплати з ${dmy(reg.from)} по ${dmy(reg.to)} внесено`,
      [...reg.open, ...reg.check].map(x => `${dmy(x.date)} · ${short(x.recipient || x.comment || '—')} · ${fmt(x.amount)}${x.action === 'перевірити' ? ' · «перевірити»' : x.status === 'помилка' ? ' · помилка' : ''}`));
    }
    // виводи з балансу ↔ погодження «% менеджера / м-рів / тімліда» (wd — CFWithdrawals.summary за місяць або {error})
    const wd = parts.wd, WT = 'Виводи з балансу — за погодженнями', WF = 'виводи з балансу';
    if (!wd) add('wd', WT, WF, null, !reg ? 'реєстр погоджень у цьому браузері не налаштовано — не перевірено' : 'не перевірено');
    else if (wd.error) add('wd', WT, WF, null, `реєстр не відповів: ${wd.error}`);
    else {
      const nBad = wd.diff + wd.none + wd.extra + wd.double.length, t0 = parts.today || today();
      add('wd', WT, WF, nBad ? false : wd.ambig || wd.wait ? null : true, !wd.n && !wd.extra ? 'погоджень «% менеджера / м-рів / тімліда» і виводів з балансу за місяць немає'
        : nBad || wd.ambig || wd.wait ? `${[wd.diff ? `сума не збігається: ${wd.diff}` : '', wd.none ? `виводу немає: ${wd.none}` : '', wd.ambig ? `не вдалося розкласти: ${wd.ambig}` : '',
          wd.wait ? `чекаємо вивід (свіже погодження): ${wd.wait}` : '',
          wd.extra ? `виводів без погодження: ${wd.extra}` : '', wd.double.length ? `схоже на витрату двічі: ${wd.double.length}` : ''].filter(Boolean).join(', ')} — розділ «Виводи з балансу»`
        : `погоджень: ${wd.n} — усі виведено (${fmt(wd.withdrawn)})`,
      [...wd.bad.map(r => `${dmy(r.a.date)} · ${short(r.a.recipient)} · ${fmt(r.a.amount)} · ${wdText(r, t0).text}`),
        ...wd.extraList.map(({ w, near }) => `${dmy(w.date)} · ${wdWho(w)} · ${fmt(w.amount)} · без погодження${near ? ` (${wdNear(near)})` : ''} · ID ${w.id}`),
        ...wd.double.map(r => `${dmy(r.a.date)} · ${short(r.a.recipient)} · ${fmt(r.a.amount)} · реєстр уніс на всю суму (ID ${r.a.id}), і є вивід з балансу — витрата двічі?`)]);
    }
    const maybeRows = r => new Set((r.R.own ? r.R.own.maybe : []).map(m => m.row));
    const missB = accs.flatMap(r => (r.R.missing ? r.R.missing.bank.filter(x => !maybeRows(r).has(x)).map(x => [r, x]) : []));
    add('bank', 'Усі операції банку є в CRM', 'операції банку без запису в CRM', cov.length ? !missB.length : null,
      !cov.length ? 'виписок за місяць немає — не перевірено' : missB.length ? `немає в CRM: ${missB.length} — внести можна в розділі «Внести в CRM»${parts.newCards ? `; серед них покупки ${parts.newCards === 1 ? 'карткою' : 'картками'}, яких лінтер не знає (${parts.newCards}) — блок «Нові корп. картки у виписці» там само` : ''}` : `рахунків з випискою: ${cov.length} — усі операції є`,
      missB.map(([r, x]) => `${dmy(x.date)} · ${nm(r)} · ${fmt(x.amount)} · ${short(x.cpty || x.purpose || '')}`));
    const own = accs.flatMap(r => (r.R.own ? r.R.own.xfers.filter(x => x.state === 'missing' || x.state === 'peer').map(x => [r, x]) : []));
    const maybe = accs.flatMap(r => (r.R.own ? r.R.own.maybe.map(m => [r, m]) : []));
    add('own', 'Перекази між своїми рахунками внесено', 'перекази між своїми', cov.length ? !own.length && !maybe.length : null,
      !cov.length ? 'виписок за місяць немає — не перевірено' : own.length || maybe.length ? `${[own.length ? `немає в CRM чи з іншим рахунком: ${own.length}` : '', maybe.length ? `рахунок «куди» невідомий: ${maybe.length}` : ''].filter(Boolean).join(', ')} — розділ «Внести в CRM»` : 'усі перекази між своїми є в CRM',
      [...own.map(([r, x]) => `${dmy(x.row.date)} · ${nm(r)} · ${fmt(x.row.amount)}${x.state === 'peer' ? ' · у CRM з іншим рахунком' : ''}`), ...maybe.map(([r, m]) => `${dmy(m.row.date)} · ${nm(r)} · ${fmt(m.row.amount)} · рахунок «куди»?`)]);
    // reps — поповнення корп. картки, записані не на ту картку власника (repointFixes; p.line — рядок для списку)
    const types = parts.types || [], blocked = types.filter(p => p.block), reps = parts.repoints || [];
    add('type', 'Типи записів правильні', 'записи з неправильним типом', !types.length && !reps.length, !types.length && !reps.length ? 'перекази й поповнення корп. карток записано переказами, на свої картки'
      : `${[types.length ? `записано витратою чи доходом замість «Переказ між рахунками»: ${types.length}${blocked.length ? ` (${types.length - blocked.length} змінить лінтер, ${blocked.length} — лише вручну в CRM)` : ''}` : '',
        reps.length ? `поповнення не на ту корп. картку: ${reps.length}` : ''].filter(Boolean).join('; ')} — розділ «Виправити»`,
      [...types.map(p => `${dmy(p.date)} · ID ${p.item.id} · ${fmt(p.amount)} · ${short(p.why)}`), ...reps.map(p => `${dmy(p.date)} · ID ${p.item.id} · ${fmt(p.amount)} · ${short(p.line || p.why)}`)]);
    // поповнення корп. картки, записане витратою, — уже в «Типах записів»: після зміни типу воно рух усередині групи рахунку й картки
    const missC = accs.flatMap(r => (r.R.missing ? r.R.missing.crm.filter(c => !(r.topups || []).includes(c)).map(c => [r, c]) : []));
    add('crm', 'Записи CRM підтверджено банком', 'записи без операції в банку', cov.length ? !missC.length : null,
      !cov.length ? 'виписок за місяць немає — не перевірено' : missC.length ? `записів без операції в банку: ${missC.length} — перевірте в CRM (інша дата, сума чи рахунок?); лінтер їх не змінює й не видаляє. Які саме — під рахунками в розділі «Рахунки»` : 'кожен запис рахунків з випискою є в банку',
      missC.map(([r, c]) => `${dmy(c.date)} · ${nm(r)} · ${fmt(c.amount)} · ID ${c.id}${c.draft ? ' (чернетка)' : ''} · ${short(c.comment || c.op || '')}`));
    const good = accs.filter(r => OK_ST.has(r.status)), bad = accs.filter(r => r.status === 'bad' || r.status === 'xfer');
    const unk = accs.filter(r => !OK_ST.has(r.status) && r.status !== 'bad' && r.status !== 'xfer');
    const why = r => (r.status === 'none' ? 'немає виписки — введіть залишок банку на кінець місяця в таблиці' : r.status === 'part' ? 'виписка не покриває весь місяць'
      : r.status === 'ccy' ? 'у CRM інша валюта рахунку — не порівнюється' : 'не перевірено');
    const diffOf = r => (r.status === 'xfer' ? 'зійдеться, коли внесете перекази між своїми' : r.R.diff && r.R.diff.close !== null && !isZero(r.R.diff.close) ? `на кінець CRM − банк = ${fmt(r.R.diff.close)}` : 'суми операцій не сходяться');
    add('bal', 'Залишки на кінець місяця збігаються з банком', 'розбіжності залишків', bad.length ? false : unk.length ? null : !!accs.length || null,
      `сходиться ${good.length} з ${accs.length}${bad.length ? `, розбіжність — ${bad.length}` : ''}${unk.length ? `, не перевірено — ${unk.length}` : ''}${parts.noHelper ? '. «Помічник кешфлоу» не відповів — виписки Привату й Моно не отримано: запустіть його й перевірте місяць ще раз' : ''}`,
      [...bad.map(r => `${nm(r)}: ${diffOf(r)}`), ...unk.map(r => `${nm(r)}: ${why(r)}`)]);
    const lint = parts.lint;
    if (!lint) add('lint', 'Статті й проєкти — за правилами', 'статті й проєкти', null, 'не перевірено');
    else if (lint.error) add('lint', 'Статті й проєкти — за правилами', 'статті й проєкти', null, `перевірка не вдалася: ${lint.error}`);
    else {
      const c = lint.counts || {}, fix = c.fix || 0, rev = c.review || 0, man = c['manual-422'] || 0;
      add('lint', 'Статті й проєкти — за правилами', 'статті й проєкти', !(fix + rev + man), fix + rev + man
        ? `${[fix ? `виправити: ${fix}` : '', rev ? `перевірити: ${rev}` : '', man ? `лише вручну в CRM: ${man}` : ''].filter(Boolean).join(', ')} — вкладка «Статті й проєкти»`
        : `перевірено записів: ${lint.checked} — усе за правилами`);
    }
    // режим чернеток: записи місяця, які є лише чернетками, у кешфлоу ще не потрапили — закривати не можна, доки їх не проведуть
    if (parts.drafts) add('drafts', 'Чернетки проведено', 'непроведені чернетки', parts.drafts.length ? false : parts.draftsEmpty ? null : true, !parts.drafts.length && parts.draftsEmpty ? `у CRM є недозаповнені чернетки (без рахунку, суми чи дати): ${parts.draftsEmpty} — лінтер їх не звіряє; перевірте в CRM («CashFlow» → «Чернетки»), чи вони не цього місяця` : parts.drafts.length ? `у місяці є непроведені чернетки: ${parts.drafts.length} — їх має провести бухгалтер («CashFlow» → «Чернетки»); звірка рахує їх як записи`
      : 'непроведених чернеток за місяць немає', parts.drafts.map(x => `${dmy(x.date)} · ${x.name} · ${fmt(x.amount)} · ID ${x.id}`));
    return { verdict: items.some(i => i.ok === false) ? 'not' : items.some(i => i.ok === null) ? 'partial' : 'ready', items };
  }
  /* Маркетолог за іменем із довідника карток («Симонович Сергій»): у списку маркетологів [{id, name}] — за прізвищем,
     а якщо з таким прізвищем кілька — ще й за ім'ям. id або null. */
  function mkByName(mks, name) {
    const w = s => String(s || '').toLowerCase().replace(/[’ʼ`']/g, '').split(/[^\p{L}]+/u).filter(x => x.length >= 2);
    const [sur, first] = w(name);
    if (!sur) return null;
    let hit = (mks || []).filter(m => w(m.name).includes(sur));
    if (hit.length > 1 && first) hit = hit.filter(m => w(m.name).some(x => x.startsWith(first.slice(0, 3))));
    return hit.length === 1 ? hit[0].id : null;
  }
  /* Правила rules.json для нового запису rec (поля — як у core/crm-model.js → normalizeRecord): стаття й проєкт зі змін правил,
     причини ручної перевірки; transfer — id правила, за яким це переказ між рахунками. */
  function ruleHints(compiled, rec) {
    const res = compiled ? R.evaluate(rec, compiled) : null;
    if (!res) return { reasons: [] };
    const out = { reasons: res.reasons.filter(s => !/^тип «переказ»/.test(s)) };
    const xr = res.applicable.find(r => r.set.type === 'transfer');
    if (xr) out.transfer = xr.id;
    const rid = f => ((res.fields[f] || {}).winners || []).map(r => r.id).join(', ');
    for (const ch of res.changes) {
      if (ch.field === 'category' && ch.to && ch.to.kind === 'article') out.art = { art: `${ch.to.category_id}/${ch.to.operation_id}`, why: `за правилом ${rid('category')}`, sure: ch.auto };
      else if (ch.field === 'project' && ch.to != null) out.proj = { id: ch.to, why: `за правилом ${rid('project')}` };
    }
    return out;
  }
