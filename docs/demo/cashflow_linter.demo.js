/* ДЕМО-ЗБІРКА: працює лише на демо-сторінці з вигаданими даними (docs/index.html). */
/* Лінтер кешфлоу crm.example.com — зібрано 2026-11-19 22:39, rules.json 1.2.21 (19.11.2026, «1.5% від бронювання» — на рахунку 4431).
   Запуск: відкрити crm.example.com під своїм логіном → F12 → Console → вставити весь файл → Enter.
   За замовчуванням — лише перегляд (dry-run). Щоб дозволити зміни, ПЕРШИМ рядком у консолі виконайте:
     window.CF_LINTER_CONFIG = { APPLY: true };
*/
(function () {
var module, exports, define; // UMD-модулі нижче реєструються в globalThis (CFRules, CFModel, CFLinter, CFXlsx, CFRecon, CFBankPanel, CFApprovalsTab, CFPanel)
/* ---- core/rules-engine.js ---- */
/* =====================================================================
   Рушій правил кешфлоу: компіляція rules.json і перевірка одного запису.
   Без залежностей: працює в браузері (букмарклет, «Помічник кешфлоу»),
   у Node (тести) і в Apps Script V8 (фаза 2 — реєстр погоджень).

   Запис на вході — нормалізований (див. crm-model.js → normalizeRecord):
     { id, date:'РРРР-ММ-ДД', period:'РРРР-ММ-01', text, type:'income'|'expense'|'transfer'|'exchange',
       category_id, operation_id, project_id, account_ids:[], account_names:[], amount, currency,
       is_lead, is_auto, is_salary }
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFRules = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATUS = { OK: 'ok', FIX: 'fix', REVIEW: 'review', MANUAL: 'manual-422', LOCKED: 'locked-auto', OVERRIDDEN: 'overridden' };
  const SEVERITY = { ok: 0, fix: 1, review: 2, 'manual-422': 3, 'locked-auto': 4 };
  // review — «псевдополе»: правило лише позначає запис для ручної перевірки (напр. «інші країни»)
  const FIELDS = ['category', 'project', 'type', 'exclude_from_pnl', 'review'];
  // через API лінтер змінює лише статтю і проєкт; тип / виключення з P&L — завжди вручну (review)
  const API_FIELDS = new Set(['category', 'project']);
  const TYPES = new Set(['income', 'expense', 'transfer', 'exchange']);
  const COND_KEYS = new Set(['comment_regex', 'text_any', 'names', 'type', 'category_in', 'category_not_in',
    'project_in', 'project_not_in', 'account_regex', 'account_in', 'amount_min', 'amount_max',
    'is_manual', 'is_lead', 'date_from', 'date_to', 'all', 'any', 'not']);
  const RULE_KEYS = new Set(['id', 'title', 'source', 'effective_from', 'effective_to', 'date_field', 'priority',
    'match', 'unless', 'set', 'on_ambiguous', 'mode', 'note', 'group', 'disabled']);

  // ---------- текст ----------
  // апостроф: ' ʼ ’ ‘ ` ´ вважаються однаковими (ТЗ, розділ 4)
  const APOS_RE = /[ʼ’‘`´ʹ′']/g;
  const normApos = s => String(s == null ? '' : s).replace(APOS_RE, "'");
  const normText = s => normApos(s).toLowerCase().replace(/\s+/g, ' ').trim();
  // латинські двійники кириличних літер (у коментарях трапляється «i» замість «і») — лише для пошуку імен
  const LAT2CYR = { a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в' };
  const fold = s => normText(s).replace(/[aceiopxykmthb]/g, ch => LAT2CYR[ch]).replace(/ё/g, 'е');
  // латинські двійники всередині кириличних слів («Комiсiя», «НIКІТЧЕНКО») → кирилиця, регістр зберігається
  const LAT_UP = { A: 'А', C: 'С', E: 'Е', I: 'І', O: 'О', P: 'Р', X: 'Х', Y: 'У', K: 'К', M: 'М', T: 'Т', H: 'Н', B: 'В' };
  const toCyr = s => normApos(s).replace(/[\p{L}]+/gu, w => /[а-яіїєґ]/i.test(w) ? w.replace(/[aceiopxykmthbACEIOPXYKMTHB]/g, ch => LAT2CYR[ch] || LAT_UP[ch]) : w);
  const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const W = '[\\p{L}\\p{N}_]';                 // «літера слова» з урахуванням кирилиці
  const NOT_W_BEFORE = '(?<![\\p{L}\\p{N}_])';
  const NOT_W_AFTER = '(?![\\p{L}\\p{N}_])';

  /* Регулярний вираз у стилі Python → RegExp JS з прапором u.
     - (?i)/(?s)/(?m) на початку → прапори; \w \W \b \B → з урахуванням кирилиці
       (у JS вони лише ASCII, тому «банківськ\w*» і «\bзп\b» без перекладу не працюють);
     - зайві екранування (\- поза [], \' тощо) прибираються — у режимі u це помилка. */
  function translateRegex(src) {
    if (typeof src !== 'string' || !src) throw new Error('порожній регулярний вираз');
    let flags = 'u', s = normApos(src), m;
    while ((m = /^\(\?([a-zA-Z]+)\)/.exec(s))) {
      for (const f of m[1]) {
        if (!'ims'.includes(f)) throw new Error(`прапор (?${f}) не підтримується`);
        if (!flags.includes(f)) flags += f;
      }
      s = s.slice(m[0].length);
    }
    if (/\(\?[imsx]+\)/.test(s)) throw new Error('прапори (?i) дозволені лише на початку виразу');
    const SYNTAX = '^$\\.*+?()[]{}|/';
    let out = '', inClass = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1];
        if (n === undefined) throw new Error('вираз закінчується на «\\»');
        i++;
        if (n === 'w') out += inClass ? '\\p{L}\\p{N}_' : W;
        else if (n === 'W') { if (inClass) throw new Error('\\W усередині [] не підтримується'); out += '[^\\p{L}\\p{N}_]'; }
        else if (n === 'b') { if (inClass) throw new Error('\\b усередині [] не підтримується'); out += `(?:(?<=${W})${NOT_W_AFTER}|${NOT_W_BEFORE}(?=${W}))`; }
        else if (n === 'B') out += `(?:(?<=${W})(?=${W})|${NOT_W_BEFORE}${NOT_W_AFTER})`;
        else if (/[a-zA-Z0-9]/.test(n) || SYNTAX.includes(n) || (inClass && n === '-')) out += '\\' + n;
        else out += n; // \' \- \" \№ … → сам символ
        continue;
      }
      if (c === '[' && !inClass) inClass = true;
      else if (c === ']' && inClass && out[out.length - 1] !== '[') inClass = false;
      out += c;
    }
    try { return new RegExp(out, flags); } catch (e) { throw new Error(`неправильний регулярний вираз «${src}»: ${e.message}`); }
  }

  /* Варіант імені → RegExp по «складеному» тексті (fold): регістр не важливий, апостроф однаковий,
     межі слова з урахуванням кирилиці. «Шелег*» — префікс (Шелега, Шелеги, Шелегу).
     Кілька слів — будь-які пробіли між ними. */
  function nameRegex(variant) {
    const v = fold(variant);
    if (!v) throw new Error('порожній варіант імені');
    const prefix = v.endsWith('*');
    const words = (prefix ? v.slice(0, -1) : v).split(' ').filter(Boolean).map(escRe);
    return new RegExp(NOT_W_BEFORE + words.join('\\s+') + (prefix ? '' : NOT_W_AFTER), 'u');
  }

  // ---------- дати ----------
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  function checkDate(v, what) {
    if (v == null) return null;
    if (typeof v !== 'string' || !ISO_DATE.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) throw new Error(`${what}: очікується дата РРРР-ММ-ДД, отримано «${v}»`);
    return v;
  }

  // ---------- довідник (назви ↔ id) ----------
  /* ref = { articles: { 'Назва' | 'Група / Назва': {category_id, operation_id, label} },
             projects: { 'Україна': 1, … }, projectNames: {1:'Україна'} }
     Будується з rules.json (розділ reference) і перевіряється по живому CRM у linter.js. */
  function buildRef(doc) {
    const articles = {}, byId = {}, projects = {}, projectNames = {}, groups = {};
    const refDoc = (doc && doc.reference) || {};
    const list = (refDoc.articles || []).map(a => ({ a, art: { kind: 'article', category_id: a.category_id, operation_id: a.operation_id, label: articleLabelOf(a), group: a.group, name: a.name } }));
    const put = (k, art, weak) => {
      const key = normText(k);
      const cur = articles[key];
      if (cur === undefined) articles[key] = weak ? { weak: art } : art;
      else if (cur === 'AMBIGUOUS' || cur === art || (cur.weak === art)) return;
      else if (cur.weak && !weak) articles[key] = art;          // точна назва статті сильніша за назву категорії
      else if (!!cur.weak === !!weak) articles[key] = 'AMBIGUOUS';
    };
    for (const { a, art } of list) {
      groups[normText(a.group)] = a.group;
      byId[a.category_id + '/' + a.operation_id] = art;
      // однозначні ключі: повна назва, «Група / Стаття», «Категорія / Стаття»
      for (const k of [art.label, `${a.group} / ${a.name}`, `${a.category || a.name} / ${a.name}`]) articles[normText(k)] = art;
    }
    for (const { a, art } of list) put(a.name, art, false);              // коротка назва статті, якщо не повторюється
    for (const { a, art } of list) put(a.category || a.name, art, true);  // назва категорії — найслабший ключ
    for (const { a, art } of list) for (const al of a.aliases || []) articles[normText(al)] = art;
    for (const k of Object.keys(articles)) if (articles[k] && articles[k].weak) articles[k] = articles[k].weak;
    for (const [name, id] of Object.entries(refDoc.projects || {})) { projects[normText(name)] = id; projectNames[id] = name; }
    return { articles, articleById: byId, projects, projectNames, groups };
  }
  // «Група / Категорія / Стаття»; якщо назва категорії = назві статті — «Група / Стаття»
  function articleLabelOf(a) {
    const cat = a.category || a.name;
    return normText(cat) === normText(a.name) ? `${a.group} / ${a.name}` : `${a.group} / ${cat} / ${a.name}`;
  }
  function resolveArticle(ref, v, where) {
    if (v && typeof v === 'object') {
      const art = ref.articleById[v.category_id + '/' + v.operation_id];
      if (!art) throw new Error(`${where}: стаття ${v.category_id}/${v.operation_id} відсутня в довіднику`);
      return art;
    }
    const art = ref.articles[normText(v)];
    if (art === 'AMBIGUOUS') throw new Error(`${where}: назва «${v}» неоднозначна — вкажіть «Група / ${v}»`);
    if (!art) throw new Error(`${where}: стаття «${v}» відсутня в довіднику (reference.articles)`);
    return art;
  }
  function resolveProject(ref, v, where) {
    if (v === null) return null;
    if (typeof v === 'number') { if (!(v in ref.projectNames)) throw new Error(`${where}: проєкт id ${v} відсутній у довіднику`); return v; }
    const id = ref.projects[normText(v)];
    if (id === undefined) throw new Error(`${where}: проєкт «${v}» відсутній у довіднику (reference.projects)`);
    return id;
  }

  // ---------- компіляція ----------
  function compileCond(c, ref, where, nameLists) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${where}: умова має бути об'єктом`);
    const out = {};
    for (const k of Object.keys(c)) {
      if (!COND_KEYS.has(k)) throw new Error(`${where}: невідоме поле умови «${k}»`);
      const v = c[k];
      switch (k) {
        case 'comment_regex': out.re = translateRegex(v); out.reSrc = v; break;
        case 'text_any': out.textAny = toArr(v, where + '.text_any').map(normText); break;
        case 'names': {
          const list = typeof v === 'string' && v.startsWith('@') ? nameLists[v.slice(1)] : v;
          if (!list) throw new Error(`${where}: список імен «${v}» не знайдено в people`);
          out.names = toArr(list, where + '.names').flat().map(x => ({ variant: x, re: nameRegex(x) }));
          break;
        }
        case 'type': out.type = toArr(v, where + '.type'); out.type.forEach(t => { if (!TYPES.has(t)) throw new Error(`${where}: невідомий тип «${t}»`); }); break;
        case 'category_in': case 'category_not_in':
          out[k] = new Set(toArr(v, where + '.' + k).map(x => { const a = resolveArticle(ref, x, where + '.' + k); return a.category_id + '/' + a.operation_id; }));
          break;
        case 'project_in': case 'project_not_in': out[k] = new Set(toArr(v, where + '.' + k).map(x => resolveProject(ref, x, where + '.' + k))); break;
        case 'account_regex': out.accRe = translateRegex(v); break;
        case 'account_in': out.accIn = new Set(toArr(v, where + '.account_in')); break;
        case 'amount_min': case 'amount_max': if (typeof v !== 'number') throw new Error(`${where}.${k}: очікується число`); out[k] = v; break;
        case 'is_manual': case 'is_lead': if (typeof v !== 'boolean') throw new Error(`${where}.${k}: очікується true/false`); out[k] = v; break;
        case 'date_from': case 'date_to': out[k] = checkDate(v, where + '.' + k); break;
        case 'all': case 'any': out[k] = toArr(v, where + '.' + k).map((x, i) => compileCond(x, ref, `${where}.${k}[${i}]`, nameLists)); break;
        case 'not': out.not = compileCond(v, ref, where + '.not', nameLists); break;
      }
    }
    return out;
  }
  function toArr(v, where) {
    const a = Array.isArray(v) ? v : [v];
    if (!a.length) throw new Error(`${where}: порожній список`);
    return a;
  }

  function compileRules(doc, opts) {
    opts = opts || {};
    const ref = opts.ref || buildRef(doc);
    const errors = [], warnings = [], rules = [], ids = new Set();
    const nameLists = {};
    for (const [k, v] of Object.entries((doc && doc.people) || {})) nameLists[k] = Array.isArray(v) ? v : v.names;
    (doc && doc.rules || []).forEach((r, idx) => {
      const where = `правило ${r && r.id ? r.id : '#' + (idx + 1)}`;
      try {
        if (!r || typeof r !== 'object') throw new Error('має бути об\'єктом');
        for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) throw new Error(`невідоме поле «${k}»`);
        if (typeof r.id !== 'string' || !/^R-[A-Z0-9-]+$/.test(r.id)) throw new Error('id має вигляд R-ЛІТЕРИ-ЦИФРИ');
        if (ids.has(r.id)) throw new Error('id повторюється');
        ids.add(r.id);
        if (!r.title) throw new Error('немає title');
        if (typeof r.priority !== 'number') throw new Error('priority має бути числом');
        if (!r.match) throw new Error('немає match');
        if (!r.set || !Object.keys(r.set).length) throw new Error('немає set');
        const from = checkDate(r.effective_from, where + '.effective_from'), to = checkDate(r.effective_to, where + '.effective_to');
        if (from && to && from > to) throw new Error('effective_from пізніше за effective_to');
        const dateField = r.date_field || 'date';
        if (!['date', 'period', 'created'].includes(dateField)) throw new Error('date_field: «date», «period» або «created»');
        const set = {}, setLabel = {};
        for (const [k, v] of Object.entries(r.set)) {
          if (k === 'category' || k === 'category_group' || k === 'category_not') {
            if (set.category) throw new Error('у set лише одне з category / category_group / category_not');
            if (k === 'category') { const a = resolveArticle(ref, v, where + '.set.category'); set.category = { kind: 'article', category_id: a.category_id, operation_id: a.operation_id, group: a.group }; setLabel.category = a.label; }
            else if (k === 'category_group') {
              const g = ref.groups[normText(v)];
              if (!g) throw new Error(`set.category_group: групи «${v}» немає в довіднику`);
              set.category = { kind: 'group', group: g }; setLabel.category = `будь-яка стаття групи «${g}» (стаття не визначена — вибрати вручну)`;
            } else {
              const arts = toArr(v, where + '.set.category_not').map(x => resolveArticle(ref, x, where + '.set.category_not'));
              set.category = { kind: 'not', keys: new Set(arts.map(a => a.category_id + '/' + a.operation_id)) };
              setLabel.category = 'не ' + arts.map(a => a.label).join(' / ') + ' (стаття не визначена — вибрати вручну)';
            }
          }
          else if (k === 'project') { set.project = resolveProject(ref, v, where + '.set.project'); setLabel.project = set.project == null ? '(без проєкту)' : ref.projectNames[set.project]; }
          else if (k === 'type') { if (v !== 'transfer') throw new Error('set.type: підтримується лише "transfer"'); set.type = 'transfer'; setLabel.type = 'переказ між рахунками'; }
          else if (k === 'exclude_from_pnl') { if (v !== true) throw new Error('set.exclude_from_pnl: лише true'); set.exclude_from_pnl = true; setLabel.exclude_from_pnl = 'не P&L / не показувати'; }
          else if (k === 'review') { if (typeof v !== 'string' || !v.trim()) throw new Error('set.review: текст причини'); set.review = v.trim(); setLabel.review = 'перевірити вручну: ' + v.trim(); }
          else throw new Error(`set: невідоме поле «${k}»`);
        }
        const mode = r.mode || 'fix';
        if (!['fix', 'review'].includes(mode)) throw new Error('mode: «fix» або «review»');
        const onAmb = r.on_ambiguous || 'review';
        if (!['review', 'skip'].includes(onAmb)) throw new Error('on_ambiguous: «review» або «skip»');
        rules.push({
          id: r.id, title: r.title, source: r.source || '', group: r.group || '', priority: r.priority,
          from, to, dateField, mode, onAmbiguous: onAmb, disabled: !!r.disabled, note: r.note || '',
          match: compileCond(r.match, ref, where + '.match', nameLists),
          unless: (r.unless || []).map((u, i) => compileCond(u, ref, `${where}.unless[${i}]`, nameLists)),
          set, setLabel, raw: r,
        });
      } catch (e) { errors.push(`${where}: ${e.message}`); }
    });
    if (!rules.length && !errors.length) warnings.push('у файлі немає жодного правила');
    // межа роботи лінтера: раніші записи — лише довідка (застосовує linter.js, рушій правил її не враховує)
    let fixFrom = null;
    try { fixFrom = checkDate(doc && doc.fix_from, 'fix_from'); } catch (e) { errors.push(e.message); }
    return { rules, errors, warnings, ref, version: doc && doc.version, fixFrom };
  }

  // ---------- перевірка ----------
  function condMatches(c, rec) {
    if (c.re && !c.re.test(rec.textApos != null ? rec.textApos : normApos(rec.text)) &&
      !c.re.test(rec.textCyr != null ? rec.textCyr : toCyr(rec.text))) return false;
    if (c.textAny) { const t = rec.textNorm != null ? rec.textNorm : normText(rec.text); if (!c.textAny.some(x => t.includes(x))) return false; }
    if (c.names) { const t = rec.textFold != null ? rec.textFold : fold(rec.text); if (!c.names.some(n => n.re.test(t))) return false; }
    if (c.type && !c.type.includes(rec.type)) return false;
    const art = rec.category_id != null ? rec.category_id + '/' + rec.operation_id : null;
    if (c.category_in && !(art && c.category_in.has(art))) return false;
    if (c.category_not_in && art && c.category_not_in.has(art)) return false;
    const proj = rec.project_id == null ? null : rec.project_id;
    if (c.project_in && !c.project_in.has(proj)) return false;
    if (c.project_not_in && c.project_not_in.has(proj)) return false;
    if (c.accRe && !(rec.account_names || []).some(n => c.accRe.test(n))) return false;
    if (c.accIn && !(rec.account_ids || []).some(id => c.accIn.has(id))) return false;
    const amt = Math.abs(Number(rec.amount) || 0);
    if (c.amount_min != null && amt < c.amount_min) return false;
    if (c.amount_max != null && amt > c.amount_max) return false;
    if (c.is_manual != null && (!rec.is_auto) !== c.is_manual) return false;
    if (c.is_lead != null && !!rec.is_lead !== c.is_lead) return false;
    if (c.date_from && rec.date < c.date_from) return false;
    if (c.date_to && rec.date > c.date_to) return false;
    if (c.all && !c.all.every(x => condMatches(x, rec))) return false;
    if (c.any && !c.any.some(x => condMatches(x, rec))) return false;
    if (c.not && condMatches(c.not, rec)) return false;
    return true;
  }
  function inEffect(rule, rec) {
    const d = rule.dateField === 'period' ? (rec.period || rec.date) : rule.dateField === 'created' ? (rec.created || rec.date) : rec.date;
    if (rule.from && (!d || d < rule.from)) return false;
    if (rule.to && (!d || d > rule.to)) return false;
    return true;
  }
  function currentValue(rec, f) {
    if (f === 'category') return rec.category_id == null ? null : { category_id: rec.category_id, operation_id: rec.operation_id };
    if (f === 'project') return rec.project_id == null ? null : rec.project_id;
    if (f === 'type') return rec.type === 'transfer' ? 'transfer' : rec.type;
    if (f === 'exclude_from_pnl') return rec.type === 'transfer' || rec.type === 'exchange';
    return undefined;
  }
  const artKey = v => v ? v.category_id + '/' + v.operation_id : 'null';
  const valKey = (f, v) => {
    if (f !== 'category') return String(v);
    if (v && v.kind === 'group') return 'group:' + v.group;
    if (v && v.kind === 'not') return 'not:' + [...v.keys].sort().join(',');
    return artKey(v);
  };
  // чи задовольняє стаття (поточна або очікувана) вимогу правила
  function satisfies(want, art, ref) {
    if (!want || want.kind === 'article' || want.kind === undefined) return artKey(want) === artKey(art);
    if (!art) return false;
    if (want.kind === 'not') return !want.keys.has(artKey(art));
    const a = ref && ref.articleById[artKey(art)];
    return !!a && a.group === want.group;
  }
  const sameVal = (f, a, b, ref) => f === 'category' ? satisfies(a, b, ref) : valKey(f, a) === valKey(f, b);
  const worse = (a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a);

  /* Перевірка одного запису. Повертає null, якщо жодне правило не застосовне.
     ctx.ruleIds — Set id вибраних правил (порожньо = усі). Пріоритети рахуються за ВСІМА правилами:
     вибір лише звужує, що показувати, тож невибране правило з вищим пріоритетом не обійдеться. */
  function evaluate(rec, compiled, ctx) {
    ctx = ctx || {};
    // запис не з normalizeRecord (рядки «Звірки з банком», погодження) — тексти один раз, а не в кожній умові кожного
    // правила; у результаті лишається сам запис (07.11.2026)
    const m = rec.textApos != null && rec.textCyr != null && rec.textNorm != null && rec.textFold != null ? rec : Object.assign(Object.create(rec), {
      textApos: rec.textApos != null ? rec.textApos : normApos(rec.text), textNorm: rec.textNorm != null ? rec.textNorm : normText(rec.text),
      textFold: rec.textFold != null ? rec.textFold : fold(rec.text), textCyr: rec.textCyr != null ? rec.textCyr : toCyr(rec.text) });
    const all = compiled.rules.filter(r => !r.disabled && inEffect(r, m) && condMatches(r.match, m) && !r.unless.some(u => condMatches(u, m)));
    const sel = ctx.ruleIds && ctx.ruleIds.size ? ctx.ruleIds : null;
    const applicable = sel ? all.filter(r => sel.has(r.id)) : all;
    if (!applicable.length) return null;
    // лід / автоматичний — важливіше за «зарплатний»: такі записи лінтер не чіпає взагалі (і вручну теж не пропонує)
    const lockReason = (rec.is_lead || rec.is_auto) ? STATUS.LOCKED : rec.is_salary ? STATUS.MANUAL : null;
    // кілька платежів у записі доходу / витрати — об'єднаний запис, лінтер такі не змінює (ТЗ, розділ 5 «Карти»)
    const multi = rec.n_payments > 1 && (rec.type === 'income' || rec.type === 'expense');
    const ref = compiled.ref;
    const fields = {}, reasons = [];
    for (const f of FIELDS) {
      const cands = all.filter(r => r.set[f] !== undefined);
      if (!cands.length || (sel && !cands.some(r => sel.has(r.id)))) continue;
      const top = Math.max(...cands.map(r => r.priority));
      const winners = cands.filter(r => r.priority === top), losers = cands.filter(r => r.priority < top);
      const cur = currentValue(rec, f);
      const fd = { field: f, winners, losers, current: cur, conflict: false, expected: null, expectedLabel: null, settable: true };
      if (f === 'review') {
        fd.equal = false;
        fd.expectedLabel = winners.map(r => r.setLabel.review).join('; ');
      } else if (f === 'category') {
        // точні статті + вимоги (група / «не ця стаття»): точна стаття має задовольняти всі вимоги
        const arts = winners.filter(r => r.set.category.kind === 'article'), cons = winners.filter(r => r.set.category.kind !== 'article');
        const keys = [...new Set(arts.map(r => artKey(r.set.category)))];
        if (keys.length > 1) fd.conflict = true;
        else if (keys.length === 1) {
          fd.expected = arts[0].set.category; fd.expectedLabel = arts[0].setLabel.category;
          if (cons.some(r => !satisfies(r.set.category, fd.expected, ref))) fd.conflict = true;
        } else {
          fd.expected = cons.length === 1 ? cons[0].set.category : { kind: 'multi', list: cons.map(r => r.set.category) };
          fd.expectedLabel = cons.map(r => r.setLabel.category).join('; ');
          fd.settable = false; // конкретної статті немає — лише перевірка
        }
        fd.equal = !fd.conflict && (fd.expected && fd.expected.kind === 'multi' ? fd.expected.list.every(w => satisfies(w, cur, ref)) : satisfies(fd.expected, cur, ref));
      } else {
        const keys = [...new Set(winners.map(r => valKey(f, r.set[f])))];
        fd.conflict = keys.length > 1;
        if (!fd.conflict) { fd.expected = winners[0].set[f]; fd.expectedLabel = winners[0].setLabel[f]; }
        fd.equal = !fd.conflict && sameVal(f, fd.expected, cur, ref);
      }
      const label = r => r.setLabel[f];
      const blocked = sel && !winners.some(r => sel.has(r.id)); // поле вирішує невибране правило з вищим пріоритетом
      if (fd.conflict) {
        const skip = winners.every(r => r.onAmbiguous === 'skip');
        fd.status = skip ? STATUS.OK : STATUS.REVIEW;
        if (!skip) reasons.push(`конфлікт правил з пріоритетом ${top}: ` + winners.map(r => `${r.id} → ${label(r)}`).join('; '));
      } else if (fd.equal) fd.status = STATUS.OK;
      else if (lockReason) fd.status = lockReason;
      else if (blocked) {
        fd.status = STATUS.REVIEW; fd.settable = false;
        reasons.push('вирішує невибране правило з вищим пріоритетом: ' + winners.map(r => `${r.id} → ${label(r)}`).join('; '));
      }
      else if (f === 'review') { fd.status = STATUS.REVIEW; reasons.push(fd.expectedLabel); }
      else if (!API_FIELDS.has(f)) { fd.status = STATUS.REVIEW; reasons.push(`${f === 'type' ? 'тип «переказ»' : 'виключення з P&L'} змінюється лише вручну`); }
      else if (multi) { fd.status = STATUS.REVIEW; fd.settable = false; reasons.push('запис з кількома платежами (об\'єднаний) — лінтер такі не змінює'); }
      else if (!fd.settable) { fd.status = STATUS.REVIEW; reasons.push('стаття має бути: ' + fd.expectedLabel); }
      else if (f === 'category' && ctx.marketerArts && ctx.marketerArts.has(artKey(fd.expected))) {
        fd.status = STATUS.REVIEW; fd.settable = false;
        reasons.push('для цільової статті CRM вимагає маркетолога (marketer_id) — змініть у CRM вручну, вибравши маркетолога');
      } else if (f === 'category' && ctx.marketerArts && cur && ctx.marketerArts.has(artKey(cur))) {
        // зараз стаття з маркетологом (рекламний бюджет): як CRM поведеться з бюджетом при зміні статті — невідомо
        fd.status = STATUS.REVIEW; fd.settable = false;
        reasons.push('запис зараз у статті з маркетологом (рекламний бюджет) — зміну статті зробіть у CRM вручну');
      } else if (winners.some(r => r.mode === 'review')) { fd.status = STATUS.REVIEW; reasons.push('правило вимагає ручного підтвердження (mode: review)'); }
      else if (f === 'category' && ctx.salaryOps && ctx.salaryOps.has(fd.expected.operation_id)) {
        fd.status = STATUS.REVIEW;
        reasons.push('цільова стаття належить до зарплатних — API може відмовити (422); підтвердіть рядок окремо');
      } else fd.status = STATUS.FIX;
      fields[f] = fd;
    }
    let status = STATUS.OK;
    for (const fd of Object.values(fields)) status = worse(status, fd.status);
    if (lockReason && status !== STATUS.OK) {
      status = lockReason;
      reasons.unshift(lockReason === STATUS.MANUAL ? 'зарплатна операція: API не змінює (HTTP 422) — змінити вручну'
        : rec.is_lead ? 'запис створено з ліда CRM — лінтер його не змінює' : 'запис створено автоматично — лінтер його не змінює');
    }
    // правило з нижчим пріоритетом, що хоче те саме конкретне значення, що й переможець, — не «перекрите»
    const agrees = (f, want, fd) => f !== 'review' && !fd.conflict && fd.expected != null &&
      (f === 'category' ? want.kind === 'article' && fd.expected.kind === 'article' && artKey(want) === artKey(fd.expected) : valKey(f, want) === valKey(f, fd.expected));
    const perRule = {};
    for (const r of applicable) {
      let st = null, lostDiff = false;
      for (const f of Object.keys(r.set)) {
        const fd = fields[f];
        if (fd.losers.includes(r) && !agrees(f, r.set[f], fd)) { if (f === 'review' || !sameVal(f, r.set[f], fd.current, ref)) lostDiff = true; continue; }
        const fst = fd.status === STATUS.OK ? STATUS.OK : (lockReason || fd.status);
        st = st == null ? fst : worse(st, fst);
      }
      perRule[r.id] = st != null ? st : (lostDiff ? STATUS.OVERRIDDEN : STATUS.OK);
    }
    const changes = [];
    if (status === STATUS.FIX || status === STATUS.REVIEW) {
      for (const f of Object.keys(fields)) {
        const fd = fields[f];
        if (API_FIELDS.has(f) && fd.settable && !fd.conflict && !fd.equal) changes.push({ field: f, from: fd.current, to: fd.expected, toLabel: fd.expectedLabel, auto: fd.status === STATUS.FIX });
      }
    }
    return { record: rec, applicable, fields, status, reasons: [...new Set(reasons)], perRule, changes };
  }

  return { STATUS, SEVERITY, FIELDS, API_FIELDS, normApos, normText, fold, toCyr, translateRegex, nameRegex, buildRef, articleLabelOf, resolveArticle, resolveProject, compileRules, condMatches, inEffect, evaluate, currentValue, satisfies };
}));

/* ---- core/crm-model.js ---- */
/* =====================================================================
   Модель даних кешфлоу crm.example.com (внутрішній API сайту).
   Визначено читанням (GET) реальних записів і коду фронтенду сайту 24.10.2026:
   - запис кешфлоу = GET /api/invoice-payment (пагінація per_page/page/last_page);
     у записі payments[]: invoice_id (рахунок), operation (1 дохід, 2 витрата,
     3/4 переказ, 5/6 обмін), pnl_category_id + pnl_operation_id (стаття), amount;
     project_id — проєкт (країна) на рівні запису;
   - зміна = PUT /api/invoice-payment/{id} з JSON лише зі зміненими полями
     (так само робить форма редагування на сторінці CashFlow).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules-engine.js'));
  else root.CFModel = factory(root.CFRules);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (R) {
  'use strict';

  // Лінтер змінює ЛИШЕ ці поля (ТЗ, розділ 6: не сума, не дата, не рахунок, не валюта)
  const PUT_FIELDS = ['pnl_category_id', 'pnl_operation_id', 'project_id'];
  const OP_TYPE = { 1: 'income', 2: 'expense', 3: 'transfer', 4: 'transfer', 5: 'exchange', 6: 'exchange' };
  const TYPE_UA = { income: 'дохід', expense: 'витрата', transfer: 'переказ', exchange: 'обмін', unknown: '?' };
  const SALARY_CATEGORY_DEFAULT = 21; // pnl/operation-config → salary.category_id

  let kyivFmt = null;
  function kyivParts(d) {
    try {
      kyivFmt = kyivFmt || new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const p = {};
      for (const x of kyivFmt.formatToParts(d)) p[x.type] = x.value;
      return { y: p.year, m: p.month, d: p.day, H: p.hour, M: p.minute };
    } catch (e) { // без ICU: Київ = UTC+2 взимку, UTC+3 влітку (остання неділя березня/жовтня)
      const y = d.getUTCFullYear();
      const lastSun = m => { const x = new Date(Date.UTC(y, m + 1, 0)); x.setUTCDate(x.getUTCDate() - x.getUTCDay()); return x; };
      const s = lastSun(2), w = lastSun(9);
      const summer = d >= new Date(s.getTime() + 3600e3) && d < new Date(w.getTime() + 3600e3);
      const t = new Date(d.getTime() + (summer ? 3 : 2) * 3600e3).toISOString();
      return { y: t.slice(0, 4), m: t.slice(5, 7), d: t.slice(8, 10), H: t.slice(11, 13), M: t.slice(14, 16) };
    }
  }
  function kyivDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    const p = kyivParts(d);
    return `${p.y}-${p.m}-${p.d}`;
  }
  // поточний київський час 'YYYY-MM-DDTHH:MM' — для дат за замовчуванням і назв файлів
  function kyivNow() { const p = kyivParts(new Date()); return `${p.y}-${p.m}-${p.d}T${p.H}:${p.M}`; }

  /* Довідник із живого CRM (для показу назв і перевірки rules.json):
     cats — GET pnl/category, ops — GET pnl/operation/, accounts — GET invoice?get_all=1,
     currencies — GET currency, config — GET pnl/operation-config. */
  /* salaryOps — операції зарплатної категорії (GET pnl/category/{salary.category_id} → operations[].id):
     записи з такими статтями API не змінює (HTTP 422 «Операції по зарплаті не доступні…»). */
  const SALARY_OPS_DEFAULT = [31, 32, 33, 34, 35, 36, 37, 38, 39, 61, 62]; // знімок 24.10.2026 (як fallback у cashflow_import.js)
  // статті, для яких CRM вимагає маркетолога: operation-config → marketer_add_balance [{category_id, operations}]
  const MARKETER_ARTS_DEFAULT = ['20/30', '20/40', '20/41', '23/42'];
  function marketerArtsOf(config) {
    const list = config && Array.isArray(config.marketer_add_balance) ? config.marketer_add_balance : null;
    if (!list) return new Set(MARKETER_ARTS_DEFAULT);
    return new Set(list.flatMap(x => (x.operations || []).map(op => `${x.category_id}/${op}`)));
  }
  function buildLiveRef({ cats, ops, accounts, currencies, config, projects, salaryOps }) {
    const catName = {}, opName = {}, accName = {}, accCcy = {}, ccy = {};
    for (const c of cats || []) catName[c.id] = c.name;
    for (const o of ops || []) opName[o.id] = o.name;
    for (const a of accounts || []) { accName[a.id] = a.name; accCcy[a.id] = a.currency_id; }
    for (const c of currencies || []) ccy[c.id] = c.code;
    return {
      catName, opName, accName, accCcy, ccy,
      projects: projects || { 1: 'Україна', 2: 'Польща', 3: 'Велика Британія', 4: 'США', 5: 'ОАЕ' },
      salaryCategoryId: (config && config.salary && config.salary.category_id) || SALARY_CATEGORY_DEFAULT,
      salaryOps: new Set((salaryOps && salaryOps.length ? salaryOps : SALARY_OPS_DEFAULT).map(Number)),
      marketerArts: marketerArtsOf(config),
    };
  }

  /* Перевірка, що статті з rules.json (reference.articles) існують у CRM з тими самими назвами. */
  function checkArticles(doc, live) {
    const problems = [];
    for (const a of (doc.reference && doc.reference.articles) || []) {
      const c = live.catName[a.category_id], o = live.opName[a.operation_id];
      if (c === undefined) problems.push(`категорії id ${a.category_id} («${a.category}») немає в CRM`);
      else if (R.normText(c) !== R.normText(a.category)) problems.push(`категорія id ${a.category_id}: у CRM «${c}», у rules.json «${a.category}»`);
      if (o === undefined) problems.push(`статті id ${a.operation_id} («${a.name}») немає в CRM`);
      else if (R.normText(o) !== R.normText(a.name)) problems.push(`стаття id ${a.operation_id}: у CRM «${o}», у rules.json «${a.name}»`);
    }
    return problems;
  }

  function articleLabel(live, catId, opId) {
    if (catId == null && opId == null) return '';
    const c = live && live.catName[catId], o = live && live.opName[opId];
    if (c && o) return R.normText(c) === R.normText(o) ? c : `${c} / ${o}`;
    return `${c || 'кат. ' + catId} / ${o || 'ст. ' + opId}`;
  }

  /* invoice-payment → нормалізований запис для рушія правил. */
  function normalizeRecord(raw, live) {
    const pays = (raw.payments || []).filter(p => !p.deleted_at);
    const ops = pays.map(p => Number(p.operation));
    let type = 'unknown';
    if (ops.some(o => o === 3 || o === 4)) type = 'transfer';
    else if (ops.some(o => o === 5 || o === 6)) type = 'exchange';
    else if (ops.includes(1)) type = 'income';
    else if (ops.includes(2)) type = 'expense';
    // головний платіж: для переказу/обміну — списання (4/6), інакше перший
    const main = pays.find(p => [4, 6].includes(Number(p.operation))) || pays[0] || {};
    const text = [raw.comment, ...pays.map(p => p.comment)].filter(Boolean).join(' | ');
    const accIds = pays.map(p => p.invoice_id);
    const accNames = pays.map(p => (p.invoice && p.invoice.name) || (live && live.accName[p.invoice_id]) || ('рахунок ' + p.invoice_id));
    const ccyId = (main.invoice && main.invoice.currency_id) || (live && live.accCcy[main.invoice_id]);
    const catId = main.pnl_category_id == null ? null : Number(main.pnl_category_id);
    const opId = main.pnl_operation_id == null ? null : Number(main.pnl_operation_id);
    const salaryCat = (live && live.salaryCategoryId) || SALARY_CATEGORY_DEFAULT;
    const salaryOps = (live && live.salaryOps) || new Set(SALARY_OPS_DEFAULT);
    // автоматичний запис (модуль ЗП, підтвердження виведення з балансу): is_manual=false або
    // дата = час створення до секунди і секунди ≠ 00 (так розпізнає cashflow_import.js → autoReason)
    const autoByTime = !!(raw.date && raw.created_at && raw.date === raw.created_at && !/:00(\.0+)?Z$/.test(raw.date));
    const rec = {
      id: raw.id,
      date: kyivDate(raw.date),
      period: raw.period ? kyivDate(raw.period).slice(0, 7) + '-01' : null,
      created: kyivDate(raw.created_at),
      text,
      textApos: R.normApos(text), textNorm: R.normText(text), textFold: R.fold(text), textCyr: R.toCyr(text),
      comment: raw.comment || '',
      type, n_payments: pays.length,
      category_id: type === 'income' || type === 'expense' ? catId : null,
      operation_id: type === 'income' || type === 'expense' ? opId : null,
      project_id: raw.project_id == null ? null : Number(raw.project_id),
      account_ids: accIds, account_names: accNames,
      amount: Number(main.amount) || 0,
      currency: (live && live.ccy[ccyId]) || (ccyId ? 'валюта ' + ccyId : ''),
      is_lead: raw.task_payment_id != null,
      // ручним вважається лише запис з явним is_manual = true; будь-що інше (false, null, немає поля) — автоматичний, не чіпаємо
      is_auto: !(raw.is_manual === true || raw.is_manual === 1 || raw.is_manual === '1') || autoByTime,
      is_edited: !!raw.is_edited,
      is_salary: pays.some(p => salaryOps.has(Number(p.pnl_operation_id)) || Number(p.pnl_category_id) === salaryCat),
      deleted: !!raw.deleted_at,
    };
    rec.category_label = articleLabel(live, rec.category_id, rec.operation_id);
    rec.project_label = rec.project_id == null ? '' : ((live && live.projects[rec.project_id]) || 'проєкт ' + rec.project_id);
    return rec;
  }

  /* Зміни від рушія правил → тіло PUT (рядкові значення, як надсилає форма сайту). */
  function buildUpdate(changes) {
    const body = {};
    for (const ch of changes) {
      if (ch.field === 'category') {
        if (!ch.to || ch.to.category_id == null || ch.to.operation_id == null) throw new Error('стаття без id');
        body.pnl_category_id = String(ch.to.category_id);
        body.pnl_operation_id = String(ch.to.operation_id);
      } else if (ch.field === 'project') {
        if (ch.to == null) throw new Error('порожній проєкт не встановлюється');
        body.project_id = String(ch.to);
      } else throw new Error(`поле «${ch.field}» лінтер не змінює`);
    }
    for (const k of Object.keys(body)) if (!PUT_FIELDS.includes(k)) throw new Error(`заборонене поле ${k}`);
    if (!Object.keys(body).length) throw new Error('немає змін');
    return body;
  }

  /* Відмова CRM на зміну чи створення запису (оновлення сайту 29.10.2026, як у його notifyFinancialError):
     закритий місяць — HTTP 422 з errors.period, бракує прав — HTTP 403. r — {status, json, text}.
     → {kind: 'closed' | 'rights' | 'invalid' (інший 422) | 'error', message} */
  const CLOSED_PERIOD_MESSAGE = 'Місяць закрито. Внесіть операцію в новий відкритий період';
  const NO_RIGHTS_MESSAGE = 'Недостатньо прав для виконання цієї дії';
  const FULL_EDIT = '«Повне редагування операцій Cash Flow»';
  function crmFailure(r) {
    const j = (r && r.json) || null, errs = j && j.errors && typeof j.errors === 'object' ? j.errors : null;
    const strs = v => [v].flat().filter(x => typeof x === 'string' && x.trim());
    if (r.status === 422 && errs && Object.prototype.hasOwnProperty.call(errs, 'period')) return { kind: 'closed', message: strs(errs.period).join(' ') || CLOSED_PERIOD_MESSAGE };
    if (r.status === 403) return { kind: 'rights', message: (j && j.message) || NO_RIGHTS_MESSAGE };
    const msg = errs ? Object.values(errs).flatMap(strs).join('; ') : '';
    return { kind: r.status === 422 ? 'invalid' : 'error', message: msg || (j && (j.message || j.error)) || (r.text ? String(r.text).slice(0, 200) : '') };
  }
  /* Те саме як помилка з текстом для журналу: put — зміна запису, post — нова операція. err.kind — як у crmFailure. */
  function crmError(r, action) {
    const f = crmFailure(r);
    const text = f.kind === 'closed' ? `місяць закрито в CRM («${f.message}»): ${action === 'post' ? 'внесіть операцію з періодом відкритого місяця' : 'змінити запис закритого місяця може лише Адмін'}`
      : f.kind === 'rights' ? `CRM: «${f.message}» — ${action === 'post' ? 'у вашої ролі немає права вносити операції' : `потрібне право ${FULL_EDIT}`}`
        : `CRM відповів HTTP ${r.status}${f.message ? ': ' + f.message : ''}`;
    return Object.assign(new Error(text), { kind: f.kind, status: r.status });
  }
  /* Права на кешфлоу з GET user/{id} → permissions.invoice. З 29.10.2026 статтю, проєкт, тип, суму змінює лише
     роль з operation_full_edit; з самим operation_edit CRM дає змінити тільки коментар. null — прав не видно. */
  function cashflowRights(user) {
    const u = user && user.data && user.data.permissions ? user.data : user;
    const p = u && u.permissions && u.permissions.invoice;
    if (!p || typeof p !== 'object') return null;
    const on = v => v === true || v === 1 || v === '1';
    return { full: on(p.operation_full_edit), edit: on(p.operation_full_edit) || on(p.operation_edit), role: (u.role && u.role.name) || '' };
  }
  const noFullText = r => `У вашої ролі${r && r.role ? ` «${r.role}»` : ''} немає права ${FULL_EDIT}: з 29.10.2026 без нього CRM дає змінити в записі лише коментар. Попросіть адміністратора CRM додати це право.`;

  /* Закриті місяці (P&L → «Закриття періоду»): CRM перевіряє період запису, лінтер пам'ятає «закрито по РРРР-ММ» включно.
     monthOf — місяць «РРРР-ММ» з 'РРРР-ММ-ДД' (period після normalizeRecord), 'ДД-ММ-РРРР' (форма CRM, реєстр) чи 'РРРР-ММ';
     сирі UTC-дати API спершу через kyivDate. openFrom — перший відкритий день після закритих: 'РРРР-ММ-01'. */
  function monthOf(s) {
    const t = String(s || '').trim();
    let m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(t);
    if (m) return `${m[1]}-${m[2]}`;
    m = /^\d{2}[-.](\d{2})[-.](\d{4})(?:\s.*)?$/.exec(t);
    return m ? `${m[2]}-${m[1]}` : null;
  }
  function openFrom(through) {
    const m = monthOf(through);
    if (!m) return null;
    let [y, mo] = m.split('-').map(Number);
    if (++mo > 12) { mo = 1; y++; }
    return `${y}-${String(mo).padStart(2, '0')}-01`;
  }
  const isClosedMonth = (period, through) => { const a = monthOf(period), b = monthOf(through); return !!(a && b && a <= b); };
  const monthUa = s => { const m = monthOf(s); return m ? `${m.slice(5)}.${m.slice(0, 4)}` : ''; };

  /* Тіло PUT для відкату: повернути значення з резервної копії.
     Порожнє значення (запис був без проєкту / без статті) API лінтер не відправляє — це поле
     потрапляє в manual («повернути вручну»), щоб не надсилати неперевірений запит. */
  function buildRestore(rawBefore, fields) {
    const rec = normalizeRecord(rawBefore, null);
    const body = {}, manual = [];
    if (fields.includes('category')) {
      if (rec.category_id == null) manual.push('стаття: у резервній копії порожня — поверніть вручну');
      else { body.pnl_category_id = String(rec.category_id); body.pnl_operation_id = String(rec.operation_id); }
    }
    if (fields.includes('project')) {
      if (rec.project_id == null) manual.push('проєкт: до лінтера був порожній — поверніть «без проєкту» вручну');
      else body.project_id = String(rec.project_id);
    }
    return { body, manual };
  }

  /* Після PUT: цільові поля мають нові значення, захищені — без змін. */
  function verifyUpdate(beforeRaw, afterRaw, body) {
    const b = normalizeRecord(beforeRaw, null), a = normalizeRecord(afterRaw, null), problems = [];
    if (body.pnl_category_id != null && String(a.category_id) !== String(body.pnl_category_id)) problems.push(`стаття: очікувалась категорія ${body.pnl_category_id}, у записі ${a.category_id}`);
    if (body.pnl_operation_id != null && String(a.operation_id) !== String(body.pnl_operation_id)) problems.push(`стаття: очікувалась ${body.pnl_operation_id}, у записі ${a.operation_id}`);
    if (body.project_id != null && String(a.project_id) !== String(body.project_id)) problems.push(`проєкт: очікувався ${body.project_id}, у записі ${a.project_id}`);
    // поля, яких немає в запиті, не мали змінитись
    if (body.pnl_operation_id == null && (a.category_id !== b.category_id || a.operation_id !== b.operation_id)) problems.push(`змінилась стаття: ${b.category_id}/${b.operation_id} → ${a.category_id}/${a.operation_id}`);
    if (body.project_id == null && a.project_id !== b.project_id) problems.push(`змінився проєкт: ${b.project_id} → ${a.project_id}`);
    if (a.period !== b.period) problems.push(`змінився період: ${b.period} → ${a.period}`);
    if (a.amount !== b.amount) problems.push(`змінилась сума: ${b.amount} → ${a.amount}`);
    if (a.date !== b.date) problems.push(`змінилась дата: ${b.date} → ${a.date}`);
    if (a.account_ids.join(',') !== b.account_ids.join(',')) problems.push(`змінився рахунок: ${b.account_ids} → ${a.account_ids}`);
    if (a.type !== b.type) problems.push(`змінився тип: ${b.type} → ${a.type}`);
    if ((afterRaw.comment || '') !== (beforeRaw.comment || '')) problems.push('змінився коментар');
    return { ok: !problems.length, problems };
  }

  return { PUT_FIELDS, OP_TYPE, TYPE_UA, SALARY_OPS_DEFAULT, SALARY_CATEGORY_DEFAULT, CLOSED_PERIOD_MESSAGE, marketerArtsOf, kyivDate, kyivNow, buildLiveRef, checkArticles, articleLabel, normalizeRecord, buildUpdate, buildRestore, verifyUpdate,
    crmFailure, crmError, cashflowRights, noFullText, monthOf, openFrom, isClosedMonth, monthUa };
}));

/* ---- core/linter.js ---- */
/* =====================================================================
   Лінтер кешфлоу: читання записів, перевірка правилами, звіт,
   застосування змін (резервна копія → підтвердження → по одному запису
   з перечитуванням → журнал) і відкат з резервної копії.
   Доступ до сайту — через адаптер api, тому той самий код працює
   у букмарклеті (fetch з токеном), у «Помічнику кешфлоу» (через локальний
   сервер) і в тестах (мок API).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules-engine.js'), require('./crm-model.js'));
  else root.CFLinter = factory(root.CFRules, root.CFModel);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (R, M) {
  'use strict';
  const S = R.STATUS;
  const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

  /* rawFetch(method, path, body) → {status, json, text, retryAfter}
     Не частіше 1 запиту на minInterval мс; HTTP 429 — пауза й повтор (ТЗ, розділ 3). */
  function makeApi(rawFetch, o) {
    o = o || {};
    const minInterval = o.minInterval == null ? 300 : o.minInterval, maxRetries = o.maxRetries == null ? 6 : o.maxRetries;
    const sleep = o.sleep || defaultSleep, now = o.now || (() => Date.now());
    let last = -Infinity, calls = 0, retries429 = 0;
    async function call(method, path, body) {
      for (let attempt = 1, blips = 0; ; attempt++) {
        // місце в черзі бронюється до паузи: кілька одночасних викликів не стартують разом
        const at = Math.max(now(), last + minInterval);
        last = at;
        if (at > now()) await sleep(at - now());
        calls++;
        let r;
        try { r = await rawFetch(method, path, body); }
        catch (e) {
          // збій мережі: читання повторюємо (1, 3, 8 с), запис — ні (повтор POST міг би створити дубль)
          if (method === 'GET' && blips < 3) { await sleep([1000, 3000, 8000][blips++]); continue; }
          throw e;
        }
        if (method === 'GET' && [500, 502, 503, 504].includes(r.status) && blips < 3) { await sleep([1000, 3000, 8000][blips++]); continue; }
        if (r.status === 429 && attempt <= maxRetries) {
          retries429++;
          if (o.log) o.log(`HTTP 429 на ${method} ${path} — пауза й повтор (${attempt}/${maxRetries})`);
          await sleep(r.retryAfter ? Math.min(Number(r.retryAfter), 30) * 1000 : 2000 * attempt);
          continue;
        }
        return r;
      }
    }
    async function get(path) {
      const r = await call('GET', path);
      if (r.status !== 200) { const e = new Error(`GET ${path}: HTTP ${r.status}`); e.status = r.status; throw e; }
      return r.json;
    }
    return { call, get, put: (path, body) => call('PUT', path, body), post: (path, body) => call('POST', path, body), stats: () => ({ calls, retries429 }) };
  }

  const pad = n => String(n).padStart(2, '0');
  const iso2dash = iso => iso.split('-').reverse().join('-'); // РРРР-ММ-ДД → ДД-ММ-РРРР (формат фільтра сайту)
  const listOf = j => Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);

  function createLinter(opts) {
    const api = opts.api, rulesDoc = opts.rulesDoc;
    const log = opts.log || (() => {}), progress = opts.onProgress || (() => {});
    const compiled = R.compileRules(rulesDoc);
    // межа роботи (rules.json → fix_from): раніші записи лише показуються, змін для них немає.
    // opts.ignoreFixFrom — лише для аналізу (регресія): впливає на звіт, але не на planChanges / apply.
    const fixFrom = compiled.fixFrom;
    // До межі — і запис з датою в межах роботи, але з періодом старого місяця (01–05.09.2026 з періодом 08.2026 — за правилом
    // «з 1 по 5 число — попередній місяць», що діяло до 07.11.2026): його зміна рухала б P&L місяця, який не виправляємо (16.11.2026)
    const oldPeriod = rec => !!(fixFrom && rec && rec.period && String(rec.period).slice(0, 7) < fixFrom.slice(0, 7));
    const beforeFloor = rec => !!(fixFrom && rec && ((rec.date && rec.date < fixFrom) || oldPeriod(rec)));
    const floorWhy = rec => (rec.date && rec.date < fixFrom ? `запис до ${dmy(fixFrom)}` : `період ${M.monthUa(rec.period)} — до ${dmy(fixFrom)}`);
    // закриті місяці CRM (P&L → «Закриття періоду», змінює лише Адмін): opts.closedThrough() → «РРРР-ММ» включно або null.
    // Запис закритого місяця (за періодом, як перевіряє CRM) — лише довідка; opts.onClosed(«РРРР-ММ») — CRM відмовив через закритий місяць
    const closedTo = () => (typeof opts.closedThrough === 'function' ? opts.closedThrough() : null);
    const inClosed = rec => !!(rec && rec.period && M.isClosedMonth(rec.period, closedTo()));
    let live = null;

    async function loadReference() {
      const cats = listOf(await api.get('pnl/category?include_archived=1'));
      const ops = listOf(await api.get('pnl/operation/'));
      const accounts = listOf(await api.get('invoice?get_all=1'));
      const currencies = listOf(await api.get('currency'));
      let config = null, salaryOps = null;
      try { config = await api.get('pnl/operation-config'); } catch (e) { log('pnl/operation-config недоступний: ' + e.message); }
      const salCat = config && config.salary && config.salary.category_id;
      if (salCat) {
        try {
          const j = await api.get(`pnl/category/${salCat}`);
          salaryOps = (((j && j.data) || j || {}).operations || []).map(o => o.id);
        } catch (e) { log('зарплатні статті не завантажено, беру знімок 24.10.2026: ' + e.message); }
      }
      live = M.buildLiveRef({ cats, ops, accounts, currencies, config, salaryOps });
      live.accounts = accounts;
      const problems = M.checkArticles(rulesDoc, live);
      return { live, problems };
    }

    /* Записи за період [from, to] (РРРР-ММ-ДД, включно), опційно лише рахунки accountIds. */
    async function fetchRecords(from, to, accountIds) {
      const base = `invoice-payment?date_from=${iso2dash(from)}&date_to=${iso2dash(to)}&per_page=${opts.perPage || 500}` +
        (accountIds && accountIds.length ? accountIds.map(id => `&invoice_ids[]=${id}`).join('') : '');
      const out = [], seen = new Set();
      let total = null;
      for (let p = 1; p <= 1000; p++) {
        const j = await api.get(`${base}&page=${p}`);
        total = j.total != null ? j.total : total;
        for (const r of j.data || []) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
        progress({ stage: 'read', got: out.length, total, page: p, lastPage: j.last_page });
        if (!j.last_page || p >= j.last_page) break;
      }
      return out;
    }

    function evaluateAll(raws, ruleIds) {
      const ctx = { ruleIds: ruleIds && ruleIds.length ? new Set(ruleIds) : null, salaryOps: live && live.salaryOps, marketerArts: live && live.marketerArts };
      const results = [], rest = [];
      let inPeriod = 0;
      for (const raw of raws) {
        if (raw.deleted_at) continue;
        inPeriod++;
        const rec = M.normalizeRecord(raw, live);
        const res = R.evaluate(rec, compiled, ctx);
        if (res) {
          if (!opts.ignoreFixFrom && beforeFloor(rec)) freeze(res, `${floorWhy(rec)} — межа роботи лінтера: лише довідка, не змінюється`);
          else if (!opts.ignoreFixFrom && inClosed(rec)) freeze(res, `місяць ${M.monthUa(rec.period)} закрито в CRM — лише довідка, не змінюється`);
          res.raw = raw; results.push(res);
        // жодне правило не спрацювало — для «Підказок з історії»: витрата чи дохід зі статтею, не лід / авто / ЗП, одна оплата, у межах роботи
        } else if ((rec.type === 'income' || rec.type === 'expense') && rec.category_id && !rec.is_lead && !rec.is_auto && !rec.is_salary &&
          rec.n_payments === 1 && !beforeFloor(rec) && !inClosed(rec)) rest.push(rec);
      }
      return { results, checked: inPeriod, rest };
    }

    async function run(params) {
      if (compiled.errors.length) throw new Error('Помилки у rules.json:\n' + compiled.errors.join('\n'));
      if (!live) {
        const { problems } = await loadReference();
        if (problems.length) throw new Error('Довідник статей у CRM не збігається з rules.json:\n' + problems.join('\n'));
      }
      const raws = await fetchRecords(params.from, params.to, params.accountIds);
      const { results, checked, rest } = evaluateAll(raws, params.ruleIds);
      return { params, results, checked, rest, fetched: raws.length, rulesVersion: compiled.version, at: new Date().toISOString() };
    }

    /* Що змінювати: id → зміни (лише стаття/проєкт). selection — Set id записів;
       review-рядки — лише ті, що позначені окремо (ТЗ, розділ 6). manual — ручні правки користувача.
       fieldsById (необов'язково) — Map id → Set полів: з запису беруться лише вибрані зміни (напр. лише проєкт). */
    function planChanges(results, selection, manual, fieldsById) {
      const plan = [];
      for (const res of results) {
        const id = res.record.id;
        if (beforeFloor(res.record) || inClosed(res.record)) continue; // до межі fix_from і закриті місяці — нічого, навіть ручні правки
        const own = manual && manual[id];
        if (own) {
          const rc = res.record;
          if (rc.is_lead || rc.is_auto || rc.is_salary || (rc.type !== 'income' && rc.type !== 'expense') || rc.n_payments > 1) continue;
          // узята «Підказка ШІ» — так і в журналі (людина вибрала її сама, як ручну правку)
          plan.push({ id, changes: own, ruleIds: [own.some(c => c.via === 'ai') ? 'ПІДКАЗКА ШІ' : 'РУЧНА ПРАВКА'], status: 'manual-edit', record: res.record });
          continue;
        }
        if (!selection || !selection.has(id)) continue;
        if (res.status !== S.FIX && res.status !== S.REVIEW) continue;
        const want = fieldsById && fieldsById.get(id);
        const ch = res.changes.filter(c => (res.status === S.REVIEW || c.auto) && (!want || want.has(c.field)));
        if (!ch.length) continue;
        // правила, що задають вибрані зміни (без перекритих і тих, що вже «ok»)
        const drivers = res.applicable.filter(r => (res.perRule[r.id] === S.FIX || res.perRule[r.id] === S.REVIEW) && ch.some(c => r.set[c.field] !== undefined)).map(r => r.id);
        plan.push({ id, changes: ch, ruleIds: drivers.length ? drivers : res.applicable.map(r => r.id), status: res.status, record: res.record });
      }
      return plan.map(p => ({ ...p, body: M.buildUpdate(p.changes) }));
    }

    function describePlan(plan) {
      const byRule = {};
      for (const p of plan) for (const r of p.ruleIds) byRule[r] = (byRule[r] || 0) + 1;
      const first = plan[0];
      return {
        count: plan.length, byRule,
        sample: first ? { method: 'PUT', url: `/api/invoice-payment/${first.id}`, body: first.body } : null,
      };
    }

    // чи дає правило ту саму зміну на свіжих даних (ручні правки не перевіряються — їх задала людина)
    const changeKey = c => c.field === 'category' ? c.to.category_id + '/' + c.to.operation_id : String(c.to);
    function stillPlanned(p, nb) {
      if (p.status === 'manual-edit') return true;
      const res = R.evaluate(nb, compiled, { salaryOps: live && live.salaryOps, marketerArts: live && live.marketerArts });
      return !!res && p.changes.every(c => res.changes.some(x => x.field === c.field && changeKey(x) === changeKey(c)));
    }

    /* Застосування. hooks: confirm(info) → bool; saveBackup(obj) — після підтвердження, до першої зміни
       (скасування не лишає резервної копії); onApplied(id, backup) — запис справді змінено (backup.applied);
       onItem(entry, i, n); saveJournal(entries). */
    async function apply(plan, hooks) {
      hooks = hooks || {};
      if (!plan.length) return { journal: [], cancelled: false };
      // 1) свіжий повний вміст кожного запису для резервної копії; запис, який не вдалося прочитати, не змінюється
      const fresh = {}, unread = {};
      for (let i = 0; i < plan.length; i++) {
        try { fresh[plan[i].id] = await api.get(`invoice-payment/${plan[i].id}`).then(j => j.data || j); }
        catch (e) { unread[plan[i].id] = e.message; }
        progress({ stage: 'backup', done: i + 1, total: plan.length });
      }
      const todo = plan.filter(p => fresh[p.id]);
      // 2) підтвердження
      const info = describePlan(todo);
      info.unread = plan.length - todo.length;
      if (hooks.confirm && !(await hooks.confirm(info))) return { journal: [], cancelled: true };
      // 3) резервна копія — до першої зміни
      const backup = {
        kind: 'cashflow-linter-backup', created_at: new Date().toISOString(), rules_version: compiled.version,
        records: todo.map(p => fresh[p.id]),
        changes: Object.fromEntries(todo.map(p => [p.id, { fields: p.changes.map(c => c.field), body: p.body, rules: p.ruleIds }])),
      };
      if (todo.length && hooks.saveBackup) await hooks.saveBackup(backup);
      backup.applied = []; // які записи лінтер справді змінив (у файлі копії цього поля немає: файл пишеться до змін)
      // 4) по одному запису: перечитати → перевірити → PUT → перечитати
      const journal = plan.filter(p => unread[p.id]).map(p => ({ time: new Date().toISOString(), id: p.id, rules: p.ruleIds.join(', '), body: p.body, before: null, after: null,
        result: 'error', http: null, problems: ['не вдалося прочитати запис для резервної копії — не змінювався: ' + unread[p.id]] }));
      let noRights = false; // CRM відмовив у правах (403) — решта запитів відмовила б так само, їх не надсилаємо
      for (let i = 0; i < todo.length; i++) {
        const p = todo[i];
        const entry = { time: new Date().toISOString(), id: p.id, rules: p.ruleIds.join(', '), body: p.body, before: snapshot(fresh[p.id]), after: null, result: '', http: null, problems: [] };
        try {
          if (noRights) { entry.result = 'skipped-rights'; entry.problems.push('не надсилалось: CRM відмовив у правах на попередньому записі'); continue; }
          // безпосередньо перед зміною: поки було відкрите вікно підтвердження, запис могли змінити
          const before = await api.get(`invoice-payment/${p.id}`).then(j => j.data || j);
          entry.before = snapshot(before);
          const nb = M.normalizeRecord(before, live);
          const drift = p.changes.filter(c => !sameCurrent(c, p.record, nb));
          if (drift.length) { entry.result = 'skipped-changed'; entry.problems.push('запис змінився після звіту — пропущено'); }
          else if (beforeFloor(nb)) { entry.result = 'skipped-locked'; entry.problems.push(`${floorWhy(nb)} — межа роботи лінтера, не змінюється`); }
          else if (inClosed(nb)) { entry.result = 'skipped-closed'; entry.problems.push(`місяць ${M.monthUa(nb.period)} закрито в CRM — запит не надсилався`); }
          else if (nb.is_lead || nb.is_auto) { entry.result = 'skipped-locked'; entry.problems.push('запис з ліда / автоматичний'); }
          else if (nb.is_salary) { entry.result = 'manual-422'; entry.problems.push('зарплатна операція — API не змінює, змінити вручну (запит не надсилався)'); }
          else if (!stillPlanned(p, nb)) { entry.result = 'skipped-changed'; entry.problems.push('за свіжими даними правило вже не дає цієї зміни — пропущено'); }
          else {
            const r = await api.put(`invoice-payment/${p.id}`, p.body);
            entry.http = r.status;
            if (r.status < 200 || r.status >= 300) noRights = refused(entry, r, nb) === 'rights';
            else {
              backup.applied.push(p.id);
              if (hooks.onApplied) await hooks.onApplied(p.id, backup);
              const after = await api.get(`invoice-payment/${p.id}`).then(j => j.data || j);
              entry.after = snapshot(after);
              const v = M.verifyUpdate(before, after, p.body);
              entry.result = v.ok ? 'ok' : 'verify-failed';
              entry.problems.push(...v.problems);
            }
          }
        } catch (e) { entry.result = 'error'; entry.problems.push(e.message); }
        finally {
          journal.push(entry);
          if (hooks.onItem) hooks.onItem(entry, i + 1, todo.length);
          progress({ stage: 'apply', done: i + 1, total: todo.length });
        }
      }
      if (hooks.saveJournal) await hooks.saveJournal(journal);
      return { journal, cancelled: false, backup };
    }
    /* CRM не прийняв PUT: результат і причина — у журнал (текст відповіді сервера, а не лише код). → kind з M.crmFailure.
       Закритий місяць — ще й opts.onClosed(період запису rec): далі цей і раніші місяці не перевіряються й запити не надсилаються. */
    function refused(entry, r, rec) {
      const f = M.crmFailure(r);
      if (f.kind === 'closed' && opts.onClosed && rec && M.monthOf(rec.period)) opts.onClosed(M.monthOf(rec.period));
      if (f.kind === 'closed') entry.result = 'closed-period';
      else if (f.kind === 'rights') entry.result = 'no-rights';
      else entry.result = r.status === 422 ? 'manual-422' : 'error';
      entry.problems.push(f.kind === 'closed' || f.kind === 'rights' ? M.crmError(r, 'put').message
        : r.status === 422 ? 'API відмовив (422) — змінити вручну' + (f.message ? ': ' + f.message : '') : `HTTP ${r.status}` + (f.message ? ': ' + f.message : ''));
      return f.kind;
    }

    /* Відкат: повернути статтю/проєкт із резервної копії для записів, які змінював лінтер.
       backup.applied (копія з браузера) — точний список змінених; у файлі його немає, тоді пропускаються
       записи, де в копії вже ті самі значення, що й після лінтера (лінтер їх не змінював). */
    async function rollback(backup, hooks) {
      hooks = hooks || {};
      if (!backup || backup.kind !== 'cashflow-linter-backup') throw new Error('це не резервна копія лінтера');
      // ID з файлу йде в адресу запиту: лише додатні цілі числа (файл могли підмінити)
      if (!Array.isArray(backup.records) || !backup.changes || backup.records.some(r => !r || !/^\d{1,9}$/.test(String(r.id)))) throw new Error('пошкоджена резервна копія');
      const applied = Array.isArray(backup.applied) ? new Set(backup.applied.map(Number)) : null;
      const items = backup.records.map(raw => ({ raw, ch: backup.changes[raw.id] })).filter(x => x.ch && (!applied || applied.has(Number(x.raw.id))));
      const plan = items.map(x => {
        const r = M.buildRestore(x.raw, x.ch.fields);
        return { id: x.raw.id, body: r.body, manual: r.manual, expectNow: x.ch.body, raw: x.raw, same: sameAsTarget(x.raw, x.ch.body) };
      });
      const act = plan.filter(p => !p.same);
      const firstPut = act.find(p => Object.keys(p.body).length);
      const info = { count: act.length, total: backup.records.length, nochange: plan.length - act.length, appliedKnown: !!applied, manual: act.filter(p => p.manual.length).length,
        sample: firstPut ? { method: 'PUT', url: `/api/invoice-payment/${firstPut.id}`, body: firstPut.body } : null, created_at: backup.created_at };
      if (hooks.confirm && !(await hooks.confirm(info))) return { journal: [], cancelled: true };
      const journal = plan.filter(p => p.same).map(p => ({ time: new Date().toISOString(), id: p.id, rules: 'ВІДКАТ', body: {}, before: null, after: null, result: 'skipped-nochange', http: null,
        problems: ['у резервній копії вже ті самі значення, що й після лінтера — лінтер цей запис не змінював'] }));
      let noRights = false;
      for (let i = 0; i < act.length; i++) {
        const p = act[i];
        const entry = { time: new Date().toISOString(), id: p.id, rules: 'ВІДКАТ', body: p.body, before: null, after: null, result: '', http: null, problems: [] };
        try {
          if (noRights) { entry.result = 'skipped-rights'; entry.problems.push('не надсилалось: CRM відмовив у правах на попередньому записі'); continue; }
          const cur = await api.get(`invoice-payment/${p.id}`).then(j => j.data || j);
          entry.before = snapshot(cur);
          const n = M.normalizeRecord(cur, live);
          const changedSince = (p.expectNow.pnl_operation_id != null && (String(n.operation_id) !== String(p.expectNow.pnl_operation_id) || String(n.category_id) !== String(p.expectNow.pnl_category_id))) ||
            (p.expectNow.project_id != null && String(n.project_id) !== String(p.expectNow.project_id));
          if (changedSince && !hooks.force) { entry.result = 'skipped-changed'; entry.problems.push('після лінтера запис змінювали — відкат пропущено'); }
          else if (inClosed(n)) { entry.result = 'skipped-closed'; entry.problems.push(`місяць ${M.monthUa(n.period)} закрито в CRM — повернути може лише Адмін (запит не надсилався)`); }
          else if (!Object.keys(p.body).length) { entry.result = 'manual'; entry.problems.push(...p.manual); }
          else {
            const r = await api.put(`invoice-payment/${p.id}`, p.body);
            entry.http = r.status;
            if (r.status < 200 || r.status >= 300) noRights = refused(entry, r, n) === 'rights';
            else {
              const after = await api.get(`invoice-payment/${p.id}`).then(j => j.data || j);
              entry.after = snapshot(after);
              const v = M.verifyUpdate(cur, after, p.body);
              entry.result = !v.ok ? 'verify-failed' : p.manual.length ? 'partial' : 'ok';
              entry.problems.push(...v.problems, ...p.manual);
            }
          }
        } catch (e) { entry.result = 'error'; entry.problems.push(e.message); }
        finally {
          journal.push(entry);
          if (hooks.onItem) hooks.onItem(entry, i + 1, act.length);
        }
      }
      if (hooks.saveJournal) await hooks.saveJournal(journal);
      return { journal, cancelled: false };
    }

    return { compiled, fixFrom, loadReference, fetchRecords, evaluateAll, run, planChanges, describePlan, apply, rollback, get live() { return live; }, set live(v) { live = v; } };
  }

  const LOCKED_DATE = 'locked-date';
  const dmy = iso => iso.split('-').reverse().join('.');
  // Запис до межі fix_from чи закритого місяця: видно, що кажуть правила, але змін не пропонується. why — причина для звіту.
  function freeze(res, why) {
    if (res.status === S.OK) return res;
    res.status = LOCKED_DATE;
    res.changes = [];
    res.reasons.unshift(why);
    for (const id of Object.keys(res.perRule)) if (res.perRule[id] !== S.OK && res.perRule[id] !== S.OVERRIDDEN) res.perRule[id] = LOCKED_DATE;
    return res;
  }

  function sameCurrent(change, recAtReport, recNow) {
    if (change.field === 'category') return recAtReport.category_id === recNow.category_id && recAtReport.operation_id === recNow.operation_id;
    if (change.field === 'project') return recAtReport.project_id === recNow.project_id;
    return true;
  }
  // у резервній копії вже цільові значення → лінтер цей запис не змінював (нічого повертати)
  function sameAsTarget(rawBefore, body) {
    const n = M.normalizeRecord(rawBefore, null);
    if (body.pnl_operation_id != null && (String(n.category_id) !== String(body.pnl_category_id) || String(n.operation_id) !== String(body.pnl_operation_id))) return false;
    if (body.project_id != null && String(n.project_id) !== String(body.project_id)) return false;
    return true;
  }
  function snapshot(raw) {
    const n = M.normalizeRecord(raw, null);
    return { category_id: n.category_id, operation_id: n.operation_id, project_id: n.project_id };
  }

  // ---------- звіт ----------
  const STATUS_ORDER = [S.FIX, S.REVIEW, S.MANUAL, S.LOCKED, LOCKED_DATE, S.OVERRIDDEN, S.OK];
  const STATUS_UA = { fix: 'виправити', review: 'перевірити', 'manual-422': 'лише вручну в CRM', 'locked-auto': 'лід / авто — не змінюється',
    'locked-date': 'до межі — лише довідка', overridden: 'перекрито іншим правилом', ok: 'збігається' };
  // результати журналу застосування й відкату — для показу людині (у журналах і логіці лишаються коди)
  const RESULT_UA = { ok: 'змінено й перевірено', 'skipped-changed': 'пропущено: запис змінили після перевірки', 'skipped-locked': 'пропущено: лід / авто чи до межі',
    'skipped-closed': 'пропущено: місяць закрито', 'closed-period': 'місяць закрито в CRM', 'no-rights': 'немає права змінювати', 'skipped-rights': 'не надсилалось: немає права',
    'verify-failed': 'перевірка після зміни не збіглась — перевірте в CRM', 'manual-422': 'лише вручну в CRM', manual: 'повернути вручну', partial: 'змінено частково',
    'skipped-nochange': 'лінтер не змінював — пропущено', error: 'помилка' };
  const r2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

  /* Рядки детального звіту: один рядок на пару «запис × правило» (колонки — ТЗ, розділ 7.4). */
  function reportRows(run, live) {
    const head = ['ID запису', 'Дата', 'Рахунок', 'Сума', 'Валюта', 'Тип', 'Коментар', 'Поточна стаття', 'Поточний проєкт',
      'Правило', 'Очікувана стаття', 'Очікуваний проєкт', 'Статус', 'Статус запису', 'Причина', 'Джерело запису'];
    const rows = [head];
    for (const res of run.results) {
      const rec = res.record;
      for (const r of res.applicable) {
        rows.push([rec.id, rec.date, rec.account_names.join(' → '), r2(rec.amount), rec.currency, M.TYPE_UA[rec.type] || rec.type, rec.comment,
          rec.category_label, rec.project_label, `${r.id} — ${r.title}`,
          r.setLabel.category || r.setLabel.type || r.setLabel.exclude_from_pnl || r.setLabel.review || '', r.setLabel.project || '',
          res.perRule[r.id], res.status, res.reasons.join('; '), rec.is_lead ? 'лід CRM' : rec.is_auto ? 'автоматичний' : 'ручний']);
      }
    }
    return rows;
  }

  /* Підсумок по правилах: скільки записів і на яку суму в кожному статусі (довгий формат). */
  function summaryRows(run, compiled) {
    const head = ['Правило', 'Назва', 'Статус', 'Записів', 'Сума, UAH', 'Інші валюти'];
    const acc = {};
    for (const res of run.results) {
      for (const r of res.applicable) {
        const st = res.perRule[r.id];
        const k = r.id + '|' + st;
        const a = acc[k] || (acc[k] = { n: 0, uah: 0, other: {} });
        a.n++;
        if (res.record.currency === 'UAH') a.uah += Math.abs(res.record.amount);
        else a.other[res.record.currency] = (a.other[res.record.currency] || 0) + Math.abs(res.record.amount);
      }
    }
    const rows = [head];
    for (const rule of compiled.rules) {
      for (const st of STATUS_ORDER) {
        const a = acc[rule.id + '|' + st];
        if (!a) continue;
        rows.push([rule.id, rule.title, st, a.n, r2(a.uah), Object.entries(a.other).map(([c, v]) => `${r2(v)} ${c}`).join('; ')]);
      }
      if (!STATUS_ORDER.some(st => acc[rule.id + '|' + st])) rows.push([rule.id, rule.title, '—', 0, 0, '']);
    }
    return rows;
  }

  /* «Підказки з історії» для записів, яких не покриває жодне правило (01.11.2026). Отримувач — початок коментаря до «:» (або перші
     слова), тип той самий. Якщо щонайменше minN інших записів цього отримувача (rest і past — нормалізовані записи, past — період і
     120 днів до нього) і ≥ minShare з них мають одну статтю, а цей запис — іншу, — підказка. Лише довідка: нічого не змінює.
     → [{rec, art: 'категорія:операція', label, n, k, key, ex: [id…]}], за датою */
  const hintKey = c => {
    const s = String(c || '').toLowerCase().replace(/[’ʼ'`]/g, ''), i = s.indexOf(':');
    return (i > 2 && i < 80 ? s.slice(0, i) : s).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !/^\d+$/.test(w)).slice(0, 3).join(' ');
  };
  function historyHints(rest, past, minN, minShare) {
    minN = minN || 4; minShare = minShare || 0.75;
    const artOf = x => `${x.category_id}:${x.operation_id || ''}`, groups = new Map();
    for (const x of past || []) {
      const k = hintKey(x.comment);
      if (!k || !x.category_id || (x.type !== 'income' && x.type !== 'expense')) continue;
      const g = `${x.type}|${k}`;
      if (!groups.has(g)) groups.set(g, new Map());
      groups.get(g).set(x.id, x); // той самий запис у періоді й в історії — один
    }
    // на групу — один раз: скільки записів і які з кожною статтею; на запис — лише відняти його самого (раніше на кожен запис група
    // копіювалась і списки статей будувались через concat — квадратично: 3000 записів групи × 300 без правил — 15 с на сторінці CRM)
    const stats = new Map();
    const statOf = gk => {
      let s = stats.get(gk);
      if (!s) {
        const m = groups.get(gk), by = new Map();
        if (m) for (const x of m.values()) { const a = artOf(x); let v = by.get(a); if (!v) by.set(a, v = []); v.push(x); }
        stats.set(gk, s = { m, n: m ? m.size : 0, by });
      }
      return s;
    };
    const out = [];
    for (const r of rest || []) {
      const key = hintKey(r.comment);
      if (!key) continue;
      const s = statOf(`${r.type}|${key}`), self = s.m && s.m.get(r.id), n = s.n - (self ? 1 : 0);
      if (n < minN) continue;
      let art = null, k = 0;
      for (const [a, xs] of s.by) { const c = xs.length - (self && artOf(self) === a ? 1 : 0); if (c > k) { art = a; k = c; } }
      if (!art || k / n < minShare || art === artOf(r)) continue;
      const xs = s.by.get(art).filter(x => x.id !== r.id);
      out.push({ rec: r, art, label: xs[0].category_label || art, n, k, key, ex: xs.slice(0, 3).map(x => x.id) });
    }
    return out.sort((a, b) => (a.rec.date < b.rec.date ? -1 : a.rec.date > b.rec.date ? 1 : 0));
  }

  /* «Підказки ШІ» (03.11.2026): записи без правил (rest) так, як їх отримає «Помічник кешфлоу» для Claude; з тексту він ще прибере
     номери рахунків, карток, телефони й e-mail. others — інші записи періоду (нормалізовані). same — статті інших записів того
     самого отримувача (як у historyHints) у періоді: [стаття, скільки], до трьох — модель бачить, як їх зазвичай класифікують. */
  function aiRecords(rest, others) {
    const groups = new Map();
    for (const x of (rest || []).concat(others || [])) {
      const k = hintKey(x.comment);
      if (!k || !x.category_id || (x.type !== 'income' && x.type !== 'expense')) continue;
      const g = `${x.type}|${k}`;
      if (!groups.has(g)) groups.set(g, new Map());
      groups.get(g).set(x.id, x);
    }
    return (rest || []).map(r => {
      const key = hintKey(r.comment), by = new Map();
      for (const x of key ? (groups.get(`${r.type}|${key}`) || new Map()).values() : []) {
        if (x.id !== r.id) by.set(x.category_label || '?', (by.get(x.category_label || '?') || 0) + 1);
      }
      return { k: r.id, date: r.date, type: r.type, amount: r.amount, ccy: r.currency, acc: (r.account_names || []).join(' → '), cmt: r.text || r.comment || '',
        art: `${r.category_id}:${r.operation_id == null ? '' : r.operation_id}`, art_label: r.category_label || '', prj: r.project_label || '',
        same: [...by].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 3) };
    });
  }

  function statusCounts(run) {
    const c = {};
    for (const res of run.results) c[res.status] = (c[res.status] || 0) + 1;
    return c;
  }

  function journalRows(journal) {
    const rows = [['Час', 'ID запису', 'Правило', 'Було (кат/ст/проєкт)', 'Стало (кат/ст/проєкт)', 'Запит PUT', 'HTTP', 'Результат', 'Примітки']];
    const f = s => s ? `${s.category_id}/${s.operation_id}/${s.project_id == null ? '—' : s.project_id}` : '';
    for (const e of journal) rows.push([e.time, e.id, e.rules, f(e.before), f(e.after), JSON.stringify(e.body), e.http == null ? '' : e.http, e.result, e.problems.join('; ')]);
    return rows;
  }

  return { makeApi, createLinter, reportRows, summaryRows, statusCounts, journalRows, STATUS_ORDER, STATUS_UA, RESULT_UA, LOCKED_DATE, historyHints, aiRecords };
}));

/* ---- core/xlsx.js ---- */
/* =====================================================================
   Мінімальний запис .xlsx (без бібліотек і CDN) та .csv.
   xlsx = zip (без стиснення) з XML аркушів; рядки — inline strings.
   sheets: [{ name, rows: [[…], …], widths: [12, 40, …], money: [3] }]
   Перший рядок кожного аркуша — заголовок (жирний, закріплений, з фільтром).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFXlsx = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const utf8 = s => new TextEncoder().encode(s);
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  function zip(files) {
    const parts = [], central = [];
    let offset = 0;
    const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = utf8(f.name), data = f.data, crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, x) => s + x.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
    let p = 0;
    for (const x of all) { out.set(x, p); p += x.length; }
    return out;
  }

  const xmlEsc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  const safeSheetName = (n, used) => {
    let s = String(n).replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31) || 'Аркуш';
    let k = 2, base = s;
    while (used.has(s)) s = (base.slice(0, 28) + ' ' + k++);
    used.add(s);
    return s;
  };

  function sheetXml(sh) {
    const rows = sh.rows || [], money = new Set(sh.money || []);
    const nCols = Math.max(1, ...rows.map(r => r.length));
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
    x += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
    if (sh.widths && sh.widths.length) x += '<cols>' + sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
    x += '<sheetData>';
    rows.forEach((row, ri) => {
      x += `<row r="${ri + 1}">`;
      row.forEach((v, ci) => {
        if (v === null || v === undefined || v === '') return;
        const ref = colName(ci) + (ri + 1);
        if (typeof v === 'number' && isFinite(v)) {
          const s = ri === 0 ? 1 : money.has(ci) ? 2 : 0;
          x += `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`;
        } else {
          let t = String(v);
          if (t.length > 32000) t = t.slice(0, 32000) + '…';
          x += `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(t)}</t></is></c>`;
        }
      });
      x += '</row>';
    });
    x += '</sheetData>';
    if (rows.length > 1) x += `<autoFilter ref="A1:${colName(nCols - 1)}${rows.length}"/>`;
    return x + '</worksheet>';
  }

  function buildXlsx(sheets) {
    const used = new Set();
    const names = sheets.map(s => safeSheetName(s.name, used));
    const files = [];
    files.push({ name: '[Content_Types].xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>') });
    files.push({ name: '_rels/.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') });
    files.push({ name: 'xl/workbook.xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>' +
      // фільтр аркуша — через визначене ім'я _xlnm._FilterDatabase (інакше Excel інколи «лагодить» файл)
      '<definedNames>' + sheets.map((s, i) => (s.rows && s.rows.length > 1) ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEsc(names[i]).replace(/'/g, "''")}'!$A$1:$${colName(Math.max(1, ...s.rows.map(r => r.length)) - 1)}$${s.rows.length}</definedName>` : '').join('') + '</definedNames>' +
      '</workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) });
    files.push({ name: 'xl/styles.xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>') });
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(s)) }));
    return zip(files);
  }

  // CSV для Excel з українською локаллю: роздільник «;», UTF-8 з BOM
  function toCsv(rows, sep) {
    sep = sep || ';';
    const cell = v => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return sep === ';' ? String(v).replace('.', ',') : String(v);
      let s = String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // текст, схожий на формулу («-30+65=95»), Excel не має виконувати
      return s.includes(sep) || /["\r\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + rows.map(r => r.map(cell).join(sep)).join('\r\n') + '\r\n';
  }

  return { buildXlsx, toCsv, crc32, zip };
}));

/* ---- core/recon.js ---- */
/* =====================================================================
   Звірка рахунків банку з кешфлоу (логіка privat_recon.js без інтерфейсу).
   Банк — json з privat_fetch.py (API Автоклієнта Привату і monobank).
   Порівнює: вхідний залишок, обороти, вихідний залишок, суми по днях,
   поштучно операції (сума до копійки; дата: спершу той самий день, далі ±1…±3).
   Залишки на дату: CRM — поточний balance рахунку мінус рух записами, датованими пізніше
   (саме так CRM і показує залишок); банк — вхідний залишок виписки плюс рух до дати.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./crm-model.js'));
  else root.CFRecon = factory(root.CFModel);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';
  const r2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
  const cents = x => Math.round(Number(x) * 100);
  const num = v => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return v;
    const m = String(v).replace(/[\s  ]/g, '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };
  const dmy2iso = s => { const m = String(s || '').match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  // номер дня запам'ятовується (07.11.2026): multiPairs порівнює кожну пару без 1:1, і розбір дат займав майже весь час звірки
  const DAYN = new Map();
  const dayNo = a => { let v = DAYN.get(a); if (v === undefined) { v = Math.floor(Date.parse(a + 'T12:00:00Z') / 864e5); DAYN.set(a, v); } return v; };
  const dayDiff = (a, b) => dayNo(a) - dayNo(b);
  let tFmt = null;
  const kyivTime = iso => { try { tFmt = tFmt || new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' }); return tFmt.format(new Date(iso)); } catch (e) { return ''; } };

  // ---------- банк: json з privat_fetch.py ----------
  function bankAccounts(json, fileName) {
    const accs = json.accounts || [json];
    return accs.map(a => {
      const bank = a.bank || json.bank || 'privat';
      const src = `${fileName || 'json'} (${bank === 'mono' ? 'API monobank' : 'API Автоклієнта'}, отримано ${json.fetched_at || '?'})`;
      const n = bank === 'mono' ? normMono(a, src, json.from, json.to) : normPrivat(a, src, json.from, json.to);
      return { ...n, bank, iban: a.acc || null, owner: a.name || '', client: a.client || json.client || '', fileName: fileName || '' };
    });
  }
  // monobank: time — Unix-час (с), amount — у копійках/центах (документація monobank)
  function normMono(a, src, from, to) {
    const res = { src, rows: [], opening: a.opening, closing: a.closing, fileFrom: from, fileTo: to, ccy: a.ccy || null, warnings: [...(a.warnings || [])] };
    let holds = 0;
    for (const t of a.transactions || []) {
      const iso = new Date(t.time * 1000).toISOString();
      if (t.hold) holds++;
      res.rows.push({ date: M.kyivDate(iso), time: kyivTime(iso), amount: r2(t.amount / 100), cpty: t.counterName || t.description || '',
        purpose: [t.description, t.comment].filter(Boolean).join(' / '), ref: t.id || '', cpIban: t.counterIban || '', cpCode: t.counterEdrpou || '' });
    }
    if (holds) res.warnings.push(`Операцій зі статусом hold (блокування суми): ${holds} — включені у звірку.`);
    res.fileOpening = res.opening; res.fileClosing = res.closing;
    return res;
  }
  function normPrivat(a, src, from, to) {
    // skipped — не проведені банком (PR_PR ≠ «r»): у звірку не йдуть, але видно в «Операції з виписок поза звіркою»
    const res = { src, rows: [], skipped: [], opening: a.opening, closing: a.closing, fileFrom: from, fileTo: to, ccy: a.ccy || null, warnings: [...(a.warnings || [])] };
    // Приват на межі сторінок віддав ту саму операцію двічі (вересень 2026, …9953): дубль за ID пропускається (07.11.2026).
    // Без ID — за референсом і всіма полями; без референсу не зливаємо: дві однакові комісії в ту саму хвилину — різні операції
    const seen = new Set(), dups = [];
    for (const t of a.transactions || []) {
      const key = t.ID ? `id:${t.ID}` : t.REF ? ['ref', t.REF, t.REFN, t.TRANTYPE, t.SUM, t.DAT_OD, t.TIM_P].join('|') : null;
      if (key && seen.has(key)) { dups.push(t); continue; }
      if (key) seen.add(key);
      const s = num(t.SUM), sign = t.TRANTYPE === 'D' ? -1 : 1;
      const row = { date: dmy2iso(t.DAT_OD), time: t.TIM_P || '', amount: r2(sign * s), cpty: t.AUT_CNTR_NAM || '', purpose: t.OSND || '', ref: (t.REF || '') + (t.REFN ? '/' + t.REFN : ''),
        cpIban: t.AUT_CNTR_ACC || '', cpCode: t.AUT_CNTR_CRF || '' };
      if (t.PR_PR && t.PR_PR !== 'r') { res.skipped.push({ ...row, why: `банк не провів операцію (статус ${t.PR_PR}: не проведена, сторнована чи забракована)` }); continue; }
      res.rows.push(row);
      if (!res.ccy && t.CCY) res.ccy = t.CCY;
    }
    if (res.skipped.length) res.warnings.push(`Пропущено ${res.skipped.length} транзакцій зі статусом PR_PR ≠ «r» (не проведені / сторновані / забраковані).`);
    if (dups.length) res.warnings.push(`Банк віддав операцію двічі — дубль пропущено (${dups.length} шт.: ${dups.slice(0, 3).map(t => `${t.DAT_OD || '?'} ${t.TRANTYPE === 'D' ? '−' : '+'}${num(t.SUM)}`).join(', ')}${dups.length > 3 ? '…' : ''}).`);
    // вхідний + рух ≠ вихідний — банк пропустив чи задвоїв операцію: попередження на будь-який період, не лише на останній день файлу
    const open = num(a.opening), close = num(a.closing);
    if (open !== null && close !== null) {
      const d = r2(open + res.rows.reduce((s, x) => s + x.amount, 0) - close);
      if (Math.abs(d) >= 0.005) res.warnings.push(`Виписка неповна: вхідний + рух ≠ вихідний на ${r2(Math.abs(d))} ${!res.ccy || res.ccy === 'UAH' ? 'грн' : res.ccy} — вивантажте заново.`);
    }
    res.fileOpening = res.opening; res.fileClosing = res.closing;
    return res;
  }

  // ---------- зіставлення рахунку банку з рахунком кешфлоу ----------
  const BANKRE = { privat: /приват|privat/i, mono: /моно|mono|універсал|universal/i };
  const bankOf = a => Object.keys(BANKRE).find(k => BANKRE[k].test(a.name + ' ' + (a.alias_en || '')));
  const Wb = x => new RegExp('(?<!\\p{L})(' + x + ')(?!\\p{L})', 'iu');
  // валюта в назві рахунку CRM: старі назви — кодом («4 USD Маркет…», «ЗЛТ»), нові (з 30.10.2026) — словом («Приват долар ТОВ…», «євро», «злотий»)
  const CCYRE = { UAH: Wb('UAH|ГРН|гривн\\p{L}*'), USD: Wb('USD|долар\\p{L}*|доллар\\p{L}*'), EUR: Wb('EUR|ЄВР|Євр|євро'), PLN: Wb('PLN|ЗЛТ|злот\\p{L}*'), GBP: Wb('GBP|фунт\\p{L}*'), AED: Wb('AED|дирхам\\p{L}*') };
  const INACTIVE = /неактуал|not actual|не актуал/i;
  // останні 4 цифри IBAN у назві рахунку CRM («Приват ТОВ СЕРВІС МАРКЕТ 8112» ↔ UA00…00008112) — найпевніший збіг
  const ibanTail = b => (b && b.iban ? String(b.iban).replace(/\s+/g, '').slice(-4) : null);
  const hasTail = (a, t) => !!t && /^\d{4}$/.test(t) && new RegExp(`(?<!\\d)${t}(?!\\d)`).test(a.name || '');
  const STOP = new Set(['фоп', 'тов', 'пп', 'ат', 'приват', 'privat', 'моно', 'mono', 'монобанк', 'monobank', 'ua', 'uah', 'грн', 'usd', 'eur', 'pln', 'універсал', 'universal']);
  const words = s => String(s || '').toLowerCase().replace(/[«»"'ʼ’`]/g, ' ').split(/[^a-zа-яіїєґ0-9]+/i).filter(w => w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w));
  // відстань редагування ≤ 1 (одна літера вставлена, пропущена чи замінена)
  function near1(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, d = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++d > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return d + (a.length - i) + (b.length - j) <= 1;
  }
  /* accounts — рахунки кешфлоу (GET invoice?get_all=1), ccyById — {1:'UAH',…}. Повертає {id, cand}. */
  function autoMatch(b, accounts, ccyById) {
    const live = accounts.filter(a => !a.deleted_at);
    // корп. картка — не рахунок банку (вона списує з рахунку ФОП / ТОВ), навіть якщо в назві є цифри
    const t = ibanTail(b), byTail = live.filter(a => bankOf(a) === b.bank && !isCorp(a) && hasTail(a, t));
    if (byTail.length) {
      const act = byTail.filter(a => !INACTIVE.test(a.name)), c = act.length ? act : byTail;
      return { id: c.length === 1 ? c[0].id : null, cand: c };
    }
    const kw = [...new Set([...words(b.client), ...words(b.owner)])];
    // слово з виписки є в назві рахунку CRM; для довгих прізвищ — і з різницею в одну літеру («Житинська» / «Житенська»)
    const score = a => { const n = a.name.toLowerCase(), nw = words(a.name); return kw.filter(w => n.includes(w) || (w.length >= 6 && nw.some(x => near1(w, x)))).length; };
    let c = live.filter(a => bankOf(a) === b.bank && !isCorp(a)).map(a => ({ a, s: score(a) })).filter(x => x.s > 0);
    if (!c.length) return { id: null, cand: [] };
    const mx = Math.max(...c.map(x => x.s));
    c = c.filter(x => x.s === mx).map(x => x.a);
    const re = CCYRE[b.ccy];
    if (re) {
      const byCcy = c.filter(a => re.test(a.name));
      if (byCcy.length) c = byCcy;
      else if (b.ccy !== 'UAH') c = [];
      else c = c.filter(a => !Object.entries(CCYRE).some(([k, r]) => k !== 'UAH' && r.test(a.name)));
    } else if (b.ccy && b.ccy !== 'UAH') c = c.filter(a => ccyById && ccyById[a.currency_id] === b.ccy); // інша валюта (CZK…) — лише рахунок CRM у ній
    const act = c.filter(a => !INACTIVE.test(a.name));
    if (act.length) c = act;
    const byCode = c.filter(a => ccyById && ccyById[a.currency_id] === b.ccy);
    if (byCode.length) c = byCode;
    return { id: c.length === 1 ? c[0].id : null, cand: c };
  }

  /* Службові рахунки Привату: масові виплати, РКО, ЗП, цільові зарахування — у CRM їх немає. */
  const SERVICE_ACC = /^\s*(мас\.?\s*вип|рко|ціл[-ь]?[а-яіїєґ]*\.?\s*зарах)/i;
  /* З них транзитні для ЗП (цільові зарахування, масові виплати): гроші там не затримуються — з рахунку йде один переказ на виплату. */
  const PAY_ACC = /^\s*(мас\.?\s*вип|ціл[-ь]?[а-яіїєґ]*\.?\s*зарах)/i;
  /* Технічні рахунки банку за балансовим рахунком в IBAN (назва в них — як у поточного): 2603 — розподільчий валютний
     (надходження з-за кордону одразу переходять на поточний 2600), 3570 — облік комісій банку. У CRM їх немає й не треба. */
  const TECH_BAL = { 2603: 'розподільчий валютний рахунок: надходження з нього одразу йдуть на поточний', 3570: 'технічний рахунок банку для комісій' };
  const balOf = iban => (/^UA\d{8}0*([1-9]\d{3})/.exec(String(iban || '').replace(/\s+/g, '')) || [])[1] || null;
  /* Зіставлення всіх рахунків виписки з рахунками CRM. saved — збережений вибір {IBAN: id рахунку CRM або 0 = «не звіряти»}.
     Службові не зіставляються; якщо кілька рахунків банку автоматично підходять до одного рахунку CRM, лишається один —
     з операціями у виписці, далі з більшим залишком (решта — «не звіряється», людина може вибрати інший).
     Той самий рахунок банку з кількох файлів виписок (той самий IBAN) — один рахунок: зіставляється один раз, а файл під період вибирає звірка.
     Повертає [{cfId, note, fixed, service, second}] у порядку banks; fixed — вибір людини; second — ще один рахунок банку для вже зіставленого. */
  function matchAccounts(banks, accounts, ccyById, saved) {
    saved = saved || {};
    const live = accounts.filter(a => !a.deleted_at), nameOf = id => (live.find(a => a.id === id) || {}).name || id;
    const keyOf = (b, i) => b.iban || `#${i}`, keys = banks.map(keyOf), one = new Map();
    banks.forEach((b, i) => {
      if (one.has(keys[i])) return;
      if (b.iban && Object.prototype.hasOwnProperty.call(saved, b.iban)) {
        const id = Number(saved[b.iban]) || null;
        one.set(keys[i], id && live.some(a => a.id === id) ? { cfId: id, note: 'збережений вибір', fixed: true } : { cfId: null, note: 'не звіряти (ваш вибір)', fixed: true });
      } else if (SERVICE_ACC.test(b.owner || '')) one.set(keys[i], { cfId: null, note: 'службовий рахунок (масові виплати, РКО, ЗП, цільові) — не звіряється', fixed: false, service: true });
      else if (TECH_BAL[balOf(b.iban)]) one.set(keys[i], { cfId: null, note: `${TECH_BAL[balOf(b.iban)]} — у CRM не потрібен, не звіряється`, fixed: false, service: true });
      else {
        const m = autoMatch(b, live, ccyById);
        // порожній рахунок (операцій немає, залишок 0), для якого в CRM рахунку немає (напр., валютні рахунки Моно): звіряти нічого — дія не потрібна
        const empty = banks.filter((x, j) => keys[j] === keys[i]).every(x => !x.rows.length && !(Math.abs(Number(x.closing) || 0) >= 0.005) && !(Math.abs(Number(x.opening) || 0) >= 0.005));
        one.set(keys[i], { cfId: m.id, note: m.id ? 'автоматично' : m.cand.length > 1 ? 'кілька збігів — виберіть' : empty ? 'у CRM такого рахунку немає; операцій і залишку теж немає — звіряти нічого' : 'не знайдено — виберіть', fixed: false, empty: !m.id && empty });
      }
    });
    const groups = new Map();
    for (const [k, r] of one) if (r.cfId && !r.fixed) { if (!groups.has(r.cfId)) groups.set(r.cfId, []); groups.get(r.cfId).push(k); }
    for (const [id, ks] of groups) {
      const taken = [...one.values()].some(r => r.fixed && r.cfId === id);
      if (ks.length < 2 && !taken) continue;
      // з кількох рахунків банку лишається той, де є операції, далі — з більшим залишком (з усіх його файлів)
      const score = k => { const list = banks.filter((b, i) => keys[i] === k); return [list.some(b => b.rows.length) ? 1 : 0, Math.max(...list.map(b => Math.abs(Number(b.closing) || 0)))]; };
      const order = new Map(ks.map((k, i) => [k, i]));
      ks.sort((x, y) => { const a = score(x), c = score(y); return c[0] - a[0] || c[1] - a[1] || order.get(x) - order.get(y); });
      ks.forEach((k, n) => {
        if (taken || n > 0) one.set(k, { cfId: null, note: `ще один рахунок банку для «${nameOf(id)}» — не звіряється (виберіть, якщо потрібен саме він)`, fixed: false, second: true });
        else one.get(k).note = `автоматично, з ${ks.length} рахунків банку — перевірте`;
      });
    }
    return keys.map(k => ({ ...one.get(k) }));
  }

  // ---------- кешфлоу рахунку ----------
  const SIGN = { 1: 1, 2: -1, 3: 1, 4: -1, 5: 1, 6: -1 };
  const OPN = { 1: 'дохід', 2: 'витрата', 3: 'переказ (вхід)', 4: 'переказ (вихід)', 5: 'обмін (вхід)', 6: 'обмін (вихід)' };
  const PAIR = { 3: 4, 4: 3, 5: 6, 6: 5 };
  /* рух рахунку з платежу x запису r; для переказу й обміну peer — рахунок другої сторони; mk — маркетолог (рекламний бюджет), як у реєстрі;
     per — місяць P&L запису «РРРР-ММ» (за ним CRM закриває місяць) */
  const itemOf = (r, x) => {
    const o = Number(x.operation), y = PAIR[o] ? (r.payments || []).find(p => p !== x && !p.deleted_at && Number(p.operation) === PAIR[o]) : null;
    const mb = r.marketer_balance_history && r.marketer_balance_history.marketer_balance;
    return { id: r.id, date: M.kyivDate(r.date), per: r.period ? M.monthOf(M.kyivDate(r.period)) : null, time: kyivTime(r.date), amount: r2(SIGN[x.operation] * Number(x.amount)), op: OPN[x.operation] || x.operation, comment: r.comment || '', lead: !!r.task_payment_id,
      opc: o, peer: y ? y.invoice_id : null, proj: r.project_id || null, art: x.pnl_category_id != null ? `${x.pnl_category_id}/${x.pnl_operation_id}` : null,
      mk: mb && mb.user_id ? Number(mb.user_id) : null, acc: Number(x.invoice_id), ...(r.draft ? { draft: true } : {}), // draft — чернетка CRM (core/drafts.js)
      ...(autoRec(r) ? { auto: true } : {}) };
  };
  /* Автоматичний запис CRM (модуль ЗП, «Підтвердження виведення коштів з балансу»): як у crm-model.normalizeRecord — ручний лише з явним
     is_manual = true, або дата = час створення до секунди. Такий запис лінтер не змінює («Записи з неправильним типом», огляд 16.11.2026). */
  const autoRec = r => !(r.is_manual === true || r.is_manual === 1 || r.is_manual === '1') || !!(r.date && r.created_at && r.date === r.created_at && !/:00(\.0+)?Z$/.test(r.date));
  /* записи invoice-payment → рух рахунку accId (знак за типом операції) */
  function cashflowItems(records, accId) {
    const items = [];
    for (const r of records) {
      if (r.deleted_at) continue;
      for (const x of r.payments || []) {
        if (x.invoice_id !== accId || x.deleted_at || !SIGN[x.operation]) continue;
        items.push(itemOf(r, x));
      }
    }
    return items;
  }
  /* те саме для всіх рахунків одразу: Map(id рахунку → рух) */
  function cashflowByAccount(records) {
    const m = new Map();
    for (const r of records) {
      if (r.deleted_at) continue;
      for (const x of r.payments || []) {
        if (x.deleted_at || !SIGN[x.operation]) continue;
        if (!m.has(x.invoice_id)) m.set(x.invoice_id, []);
        m.get(x.invoice_id).push(itemOf(r, x));
      }
    }
    return m;
  }

  // ---------- залишки на кінець дня (за Києвом) ----------
  /* CRM: balance зараз − рух записами з датою після date. items мають містити ВСІ записи рахунку, датовані після date. */
  function crmBalanceAt(balanceNow, items, date) {
    const after = r2((items || []).filter(x => x.date > date).reduce((s, x) => s + x.amount, 0));
    return { value: r2(Number(balanceNow) - after), after };
  }
  /* Банк (рахунок із bankAccounts): {value, note, warn}; value = null, якщо дата поза випискою або залишків немає. */
  function bankBalanceAt(b, date) {
    if (b.fileFrom && date < b.fileFrom) return { value: null, note: `виписка починається з ${b.fileFrom}` };
    if (b.fileTo && date > b.fileTo) return { value: null, note: `виписка лише до ${b.fileTo}` };
    const move = r2(b.rows.filter(x => x.date <= date && (!b.fileFrom || x.date >= b.fileFrom)).reduce((s, x) => s + x.amount, 0));
    const calc = b.opening == null ? null : r2(b.opening + move);
    if (b.closing != null && date === b.fileTo) {
      const warn = calc !== null && Math.abs(calc - b.closing) >= 0.005 ? `у виписці вхідний ${b.opening} + рух ${move} ≠ вихідний ${b.closing}` : '';
      return { value: r2(b.closing), note: 'вихідний залишок виписки', warn };
    }
    if (calc === null) return { value: null, note: 'у виписці немає вхідного залишку' };
    return { value: calc, note: move ? `вхідний залишок виписки + рух до ${date}` : 'вхідний залишок виписки' };
  }
  /* Банк: залишок на початок дня date (до його операцій); null, якщо виписка цього не дає. */
  function bankOpeningAt(b, date) {
    if (b.opening == null || !b.fileFrom || date < b.fileFrom || (b.fileTo && date > b.fileTo)) return null;
    return r2(b.opening + b.rows.filter(x => x.date < date && x.date >= b.fileFrom).reduce((s, x) => s + x.amount, 0));
  }

  // ---------- звірка за період: залишки, обороти, кількість операцій за кожною сумою ----------
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const sumPos = a => r2(a.filter(x => x.amount > 0).reduce((s, x) => s + x.amount, 0));
  const sumNeg = a => r2(-a.filter(x => x.amount < 0).reduce((s, x) => s + x.amount, 0));
  const dif = (c, b) => (c === null || c === undefined || b === null || b === undefined ? null : r2(c - b));
  /* Суми, кількість операцій з якими в банку і в CRM різна (сума — зі знаком, до копійки).
     near — коли в банку операцій більше: записи CRM з цією сумою за 5 днів до чи після періоду (можлива причина — інша дата). */
  function countByAmount(B, C, cfAll, from, to) {
    const m = new Map();
    const get = c => { if (!m.has(c)) m.set(c, { amount: c / 100, bank: [], crm: [] }); return m.get(c); };
    B.forEach(x => get(cents(x.amount)).bank.push(x));
    C.forEach(x => get(cents(x.amount)).crm.push(x));
    const out = [];
    for (const [c, v] of m) {
      if (v.bank.length === v.crm.length) continue;
      const near = v.bank.length > v.crm.length ? (cfAll || []).filter(x => cents(x.amount) === c && (x.date < from ? dayDiff(from, x.date) : x.date > to ? dayDiff(x.date, to) : 99) <= 5) : [];
      out.push({ ...v, nB: v.bank.length, nC: v.crm.length, d: v.crm.length - v.bank.length, near });
    }
    return { mismatched: out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)), distinct: m.size };
  }
  // ---------- перекази між своїми рахунками ----------
  const MASK = /(?:^|[^\d])\d{4,6}[\s*xх]*\*{2,}[\s*xх]*(\d{4})(?!\d)/i;
  /* «4246 **** **** 3462 08.10.2026 …» → '3462' */
  const cardTail = s => { const m = MASK.exec(String(s || '')); return m ? m[1] : null; };
  // рахунок корп. картки: старі назви «corpCard …», нові (з 30.10.2026) — «корп. картка 3462 ФОП …», «майбутня корп карта …», «corp card 9450 …»
  const isCorp = a => /corp\s*card|корп\.?\s*карт/i.test((a && a.name) || '');
  /* Власник рахунку з назви CRM: «ФОП Мазовецька Корнелія …», «корп. картка 7365 ФОП Мазовецька …» → «ФОП Мазовецька»;
     «Приват ТОВ ПРИКЛАД СЕРВІС 5608» → «ТОВ ПРИКЛАД СЕРВІС»; «… PRYKLAD MARKET INC. Chase» → «PRYKLAD MARKET INC».
     Не видно з назви (старі назви на кшталт «1 ГРН Польша ФОП») — null. */
  function ownerOf(name) {
    const s = String(name || '').replace(/\s+/g, ' ');
    let m = /(?<!\p{L})ФОП\s+(\p{L}[\p{L}'’ʼ-]*)/iu.exec(s);
    if (m) return `ФОП ${m[1]}`;
    m = /(?<!\p{L})ТОВ\s+([^\d(]*[^\d(\s])/u.exec(s);
    if (m) return `ТОВ ${m[1].trim()}`;
    m = /([A-Z][A-Z .&-]*[A-Z])\.?\s+(INC|LLC|LTD)\b/.exec(s);
    return m ? `${m[1]} ${m[2]}` : null;
  }
  // картки, якої ще немає («майбутня корп карта …»), неактуальної чи «(видалити)» не поповнюють
  const CARD_OFF = /майбутн|неактуал|not actual|\(видалити\)/i;
  /* Корп. картку поповнюють лише з рахунку її власника: з ФОП Хоменко — на картку Хоменка, з ТОВ — на картку цього ТОВ
     (уточнення 30.10.2026; rules.json → reference.card_topup). Діючі корп. картки власника рахунку from серед accounts;
     власник не видно з назви — null (обмеження немає). */
  function ownerCards(from, accounts) {
    const ow = ownerOf(from && from.name);
    if (!ow) return null;
    return (accounts || []).filter(a => a && !a.deleted_at && isCorp(a) && !CARD_OFF.test(a.name || '') && String(ownerOf(a.name)).toLowerCase() === ow.toLowerCase());
  }
  /* Маркетолог за контрагентом (rules.json → reference.counterparty_marketers [{counterparty, marketer_id, marketer}]): назва контрагента
     є в тексті (отримувач, призначення) → {id, name, cpty} або null. «ФОП Власич Оксана Володимирівна …» → Євген Сливко (уточнення 03.11.2026). */
  const lowTxt = s => String(s || '').toLowerCase().replace(/[’ʼ'`]/g, '').replace(/\s+/g, ' ');
  function cptyMarketer(list, text) {
    const t = lowTxt(text);
    const m = (list || []).find(m => m && m.counterparty && Number(m.marketer_id) > 0 && t.includes(lowTxt(m.counterparty)));
    return m ? { id: Number(m.marketer_id), name: String(m.marketer || ''), cpty: String(m.counterparty) } : null;
  }
  /* Хто тримає корп. картку на дату date (рррр-мм-дд): rules.json → reference.cards[].holders [{from?, name}] — останній з from ≤ date
     (без from — з самого початку). → {from?, name} або null. */
  function holderOf(card, date) {
    const hs = ((card && card.holders) || []).filter(h => h && h.name && (!h.from || !date || h.from <= date));
    return hs.sort((a, b) => String(a.from || '').localeCompare(String(b.from || ''))).pop() || null;
  }
  /* Людину name («Сидоричев Андрій») названо в тексті: усі слова імені (щонайменше два) — у будь-якому порядку й відмінку
     («Андрій Сидоричев», «для Андрія Сидоричева»). */
  const personWords = s => String(s || '').toLowerCase().replace(/[’ʼ`']/g, '').split(/[^\p{L}]+/u).filter(w => w.length >= 2);
  function personIn(name, text) {
    const nw = personWords(name), cw = personWords(text);
    if (nw.length < 2 || !cw.length) return false;
    return nw.every(w => cw.some(c => c === w || (w.length >= 4 && c.length <= w.length + 2 && c.startsWith(w.slice(0, -1)))));
  }
  /* Корп. картка за тримачем: у тексті (отримувач і зміст погодження, коментар запису) названо того, хто тримає картку на дату date
     (rules.json → reference.cards[].holders). ok(id рахунку картки) — які картки годяться (того самого власника, діючі).
     → {id, last4, name, from} — якщо така картка одна; {ambig: [last4…]} — якщо кілька; null — нікого не названо. */
  function holderCard(cards, text, date, ok) {
    const hit = new Map();
    for (const c of cards || []) {
      const id = Number(c && c.account_id), h = id > 0 && holderOf(c, date);
      // картку можуть тримати двоє одразу (holders[].also — 2804 з 18.11.2026: Шелега і Ларіоненко): названо будь-кого з них
      const who = h && [h.name].concat(h.also || []).find(n => personIn(n, text));
      if (!h || (ok && !ok(id)) || !who) continue;
      if (!hit.has(id)) hit.set(id, { id, last4: String(c.last4), name: who, from: h.from || null });
    }
    return hit.size === 1 ? [...hit.values()][0] : hit.size ? { ambig: [...hit.values()].map(x => x.last4) } : null;
  }
  /* Номер корп. картки з назви рахунку CRM («corpCard …_UAH_3462», «корп. картка 3462 …» → «3462») або ''. */
  function nameTail(a) {
    if (!a || a.deleted_at || !isCorp(a)) return '';
    const d = String(a.name).match(/(?<!\d)\d{4}(?!\d)/g);
    return d ? d[d.length - 1] : '';
  }
  /* Картка, запам'ятана лише в цьому браузері («Нові корп. картки у виписці» → «Запам'ятати»), застаріла: її номер уже є в назві
     рахунку CRM або рахунок картки отримав у назві інший номер (рахунок перейменували, завели новий) — назва CRM важить більше. */
  function staleLocalCard(c, accounts) {
    const t = String(c && c.last4), id = Number(c && c.account_id);
    return (accounts || []).some(a => { const n = nameTail(a); return !!n && (n === t || (a.id === id && n !== t)); });
  }
  /* Номер корп. картки → рахунок corpCard у CRM: чотири цифри з назви («corpCard …_UAH_3462», «корп. картка 3462 …») і з коментарів поповнень
     («поповнення корп картки 7365 …» — картку могли перевипустити, а назву рахунку не змінити). Номер, що веде до кількох рахунків, не береться,
     хіба що діючий рахунок серед них один (решта — «неактуальн…», «(видалити)», «майбутн…»).
     cards — картки з довідника (rules.json → reference.cards: [{last4, account_id}]): вони сильніші за назви й коментарі; запам'ятані
     лише в браузері (local) — ні, коли назви CRM уже кажуть інше (staleLocalCard). */
  function cardTails(accounts, itemsByAcc, cards) {
    const seen = new Map();
    const add = (t, id) => { if (!seen.has(t)) seen.set(t, new Set()); seen.get(t).add(id); };
    for (const a of accounts) {
      if (a.deleted_at || !isCorp(a)) continue;
      const n = nameTail(a);
      if (n) add(n, a.id);
      for (const x of (itemsByAcc && itemsByAcc.get(a.id)) || []) {
        const m = x.opc === 3 && /карт\p{L}*\s*(?:№\s*)?(\d{4})(?!\d)/iu.exec(x.comment || '');
        if (m) add(m[1], a.id);
      }
    }
    const out = {}, nameOf = id => ((accounts.find(a => a.id === id) || {}).name || '');
    for (const [t, ids] of seen) {
      // той самий номер у кількох рахунках (завели новий рахунок картки, а старий не перейменували): діючий, якщо він один
      const live = ids.size === 1 ? [...ids] : [...ids].filter(id => !CARD_OFF.test(nameOf(id)));
      if (live.length === 1) out[t] = live[0];
    }
    for (const c of cards || []) {
      if (!c || !/^\d{4}$/.test(String(c.last4)) || !(Number(c.account_id) > 0) || (c.local && staleLocalCard(c, accounts))) continue;
      out[String(c.last4)] = Number(c.account_id);
    }
    return out;
  }
  /* Довідник своїх рахунків. byKey: IBAN рахунку з виписок → рахунок CRM (null — наш рахунок, ще не зіставлений з CRM)
     і вибір людини {IBAN контрагента або «контрагент|призначення» → id рахунку CRM; 0 — «не переказ»}; cards — номер картки → corpCard;
     pay — IBAN транзитних рахунків ЗП з виписок (не зіставлені з CRM); cardList — картки з довідника (cardTails). */
  function ownDirectory(banks, accounts, itemsByAcc, ownMap, cardList) {
    const byKey = new Map(), pay = new Set();
    for (const b of banks) {
      if (!b.iban) continue;
      // технічні рахунки банку (2603, 3570) і РКО — не наші рахунки для переказів: платіж на них — комісія чи плата банку, а не
      // «схоже на переказ між своїми» (07.11.2026). Хіба що людина сама зіставила такий рахунок з CRM; транзитні рахунки ЗП лишаються
      if (!b.cfId && (TECH_BAL[balOf(b.iban)] || (SERVICE_ACC.test(b.owner || '') && !PAY_ACC.test(b.owner || '')))) continue;
      byKey.set(b.iban, b.cfId || null);
      if (!b.cfId && PAY_ACC.test(b.owner || '')) pay.add(b.iban);
    }
    for (const [k, v] of Object.entries(ownMap || {})) byKey.set(k, Number(v) || 0);
    /* Свій рахунок без виписки (Універсал ТОВ: API немає): у назві рахунку CRM — останні 4 цифри IBAN («Універсал ТОВ СЕРВІС МАРКЕТ
       МАРКЕТПЛЕЙС 0873»). Платіж від/на нього — переказ між своїми, а не дохід чи витрата (роялті Маркет → ПРИКЛАД, 12.11.2026). */
    const withBank = new Set(banks.map(b => b.cfId).filter(Boolean)), byTail = new Map();
    for (const a of accounts || []) {
      if (a.deleted_at || isCorp(a) || withBank.has(a.id) || CARD_OFF.test(a.name || '')) continue;
      const d = String(a.name || '').match(/(?<!\d)\d{4}(?!\d)/g);
      if (!d) continue;
      const t = d[d.length - 1];
      if (!byTail.has(t)) byTail.set(t, []);
      byTail.get(t).push(a);
    }
    // валютні рахунки з виписок, зіставлені з CRM, — звідки приходить гривня від продажу валюти
    const fx = banks.filter(b => b.cfId && b.ccy && b.ccy !== 'UAH');
    return { byKey, pay, cards: cardTails(accounts, itemsByAcc, cardList), byTail, fx };
  }
  // рахунок CRM без виписки, якому належить IBAN контрагента: ті самі останні 4 цифри й усі слова назви контрагента є в назві рахунку
  function tailPeer(x, dir) {
    const m = /(\d{4})$/.exec(String(x.cpIban || '')), list = m && dir.byTail ? dir.byTail.get(m[1]) : null;
    if (!list) return 0;
    const w = nameWords(x.cpty);
    const hit = w.length ? list.filter(a => { const n = new Set(nameWords(a.name)); return w.every(v => n.has(v)); }) : [];
    return hit.length === 1 ? hit[0].id : 0;
  }
  /* Операція банку — переказ на транзитний рахунок ЗП (або повернення з нього): за IBAN контрагента з виписок чи за його назвою
     («Ціл-ві зарах.…», «Мас.вип.…»), якщо виписки цього рахунку немає. */
  const payRow = (x, dir) => !!((x.cpIban && dir && dir.pay && dir.pay.has(x.cpIban)) || PAY_ACC.test(x.cpty || ''));
  // податки на ЗП: у CRM їх можуть внести одним записом із зарплатною статтею на кілька платежів банку
  const PAY_TAX = /пдфо|військов\p{L}*\s+зб[іо]р|(?<!\p{L})єсв(?!\p{L})|єдин\p{L}*\s+соц/iu;
  /* Рух групи рахунків CRM (рахунок і зведені з ним corpCard) без переказів усередині групи: поповнення корп. картки з рахунку,
     з якого вона й списує, у банку не видно — там лише покупки карткою. */
  function groupItems(itemsByAcc, ids) {
    const g = new Set(ids);
    return ids.flatMap(id => (itemsByAcc.get(id) || []).filter(x => !((x.opc === 3 || x.opc === 4) && g.has(x.peer))));
  }
  const ownKey = x => x.cpIban || `${x.cpty || ''}|${String(x.purpose || '').slice(0, 40)}`;
  const OWN_RE = /переказ\p{L}*\s+власних\s+коштів|між\s+власними\s+рахунками|на\s+корп\p{L}*\.?\s*карт|поповн\p{L}*\s+корп\p{L}*\.?\s*карт/iu;
  const TO_CARD_RE = /^\s*переказ\s+на\s+(свою\s+)?картку/iu;
  // банк пише латинські двійники літер («Гривнi вiд продажу») — «і» й «i» рівноправні
  const FX_SELL = /в[іi]д\s+продажу\s+[\d\s.,]*\d\s*(USD|EUR|GBP|PLN|CZK|CHF)(?![A-Za-z])/iu;
  const NOT_OWN_RE = /^\s*коміс|зп\s*\/\s*карток|для\s+виплат/iu;
  const nameWords = s => (String(s || '').toLowerCase().match(/[a-zа-яіїєґ'’ʼ-]{3,}/giu) || []).filter(w => !STOP.has(w));
  const sameOwner = (a, b) => { const x = new Set(nameWords(a)); return nameWords(b).some(w => x.has(w)); };
  /* Операція банку рахунку, що звіряється з групою рахунків CRM group (рахунок і його corpCard):
     {kind: 'own', peer} — контрагент — наш рахунок peer; {kind: 'maybe', why} — схоже на переказ між своїми, рахунок «куди» невідомий;
     {kind: 'pay'} — переказ на транзитний рахунок ЗП (у CRM ЗП внесено по людях — це не переказ між рахунками CRM); інакше null.
     Покупки корп. карткою (номер у призначенні) — не перекази: вони звіряються з витратами corpCard. */
  function ownKind(x, dir, group, owner) {
    const key = ownKey(x), p = dir.byKey.get(key);
    if (!p && payRow(x, dir)) return { kind: 'pay' }; // хіба що людина сама вибрала для нього рахунок CRM
    if (dir.byKey.has(key)) {
      if (p === 0 || (p && group.has(p))) return null;
      return p ? { kind: 'own', peer: p } : { kind: 'maybe', why: 'контрагент — наш рахунок, ще не зіставлений з CRM' };
    }
    const t = cardTail(x.purpose);
    if (t && dir.cards[t]) return null;
    const s = String(x.purpose || '');
    if (NOT_OWN_RE.test(s)) return null;
    const tp = tailPeer(x, dir);
    if (tp && !group.has(tp)) return { kind: 'own', peer: tp };
    /* Продаж валюти: «Продаж UAH клієнтів: Гривні від продажу 495.00 EUR по курсу 50.57» — гривня з валютного рахунку тієї самої фірми.
       У CRM це переказ між рахунками («Продаж 495.00 EUR з «Приват євро …» за курсом банку … → «Приват ТОВ …»»), а не дохід (12.11.2026).
       Валютний рахунок — єдиний рахунок цієї валюти того самого власника серед виписок, зіставлений з CRM; інакше — «виберіть рахунок». */
    const fx = x.amount > 0 && FX_SELL.exec(s);
    if (fx) {
      const mine = new Set(nameWords(owner)), same = b => { const w = nameWords(b.owner); return w.length === mine.size && w.every(v => mine.has(v)); };
      const from = (dir.fx || []).filter(b => b.ccy === fx[1].toUpperCase() && !group.has(b.cfId) && same(b));
      return from.length === 1 ? { kind: 'own', peer: from[0].cfId } : { kind: 'maybe', why: `продаж валюти (${fx[1].toUpperCase()}) — переказ з валютного рахунку` };
    }
    // переказ самому власникові ФОП на картку (Моно: «Переказ на картку»; Приват: «5363 **** **** 3912 Переказ власних коштів»), отримувач — людина
    // без «ФОП» / «ТОВ» у назві: це особиста картка, рахунку CRM для неї немає — у CRM така операція вноситься витратою (на що пішли гроші)
    const person = !/(?<!\p{L})(фоп|тов)(?!\p{L})/iu.test(x.cpty || '') && sameOwner(x.cpty, owner);
    if (person && (TO_CARD_RE.test(s) || (t && OWN_RE.test(s)))) return { kind: 'card', why: `переказ на особисту картку власника ФОП (${String(x.cpty || '').trim()})` };
    // так само — на особистий поточний рахунок власника (балансовий 2620, без номера картки: Мазовецька «Переказ власних коштів», 07.11.2026)
    if (person && balOf(x.cpIban) === '2620' && OWN_RE.test(s)) return { kind: 'card', why: `переказ на особистий рахунок власника ФОП (${String(x.cpty || '').trim()})` };
    if (OWN_RE.test(s) || (TO_CARD_RE.test(s) && sameOwner(x.cpty, owner))) return { kind: 'maybe', why: 'схоже на переказ між своїми' };
    return null;
  }
  /* Перекази між своїми на рахунку за період: B — операції банку, C — рух CRM групи (внутрішні перекази групи вже прибрано).
     Для операції з відомим рахунком «куди»: у CRM переказ саме між цими рахунками — ok; запис з тією самою сумою, але не переказ — type;
     переказ з/на інший рахунок — peer; нічого — missing (пропозиція створити переказ).
     maybe — схоже на переказ, рахунок «куди» невідомий, і запису з такою сумою в CRM немає.
     cfAll — увесь рух групи: переказ, який у CRM є з датою до ±5 днів поза періодом, — near (не пропонується; підказка «з іншою датою»). */
  function ownTransfers(B, C, dir, group, owner, cfAll, into) {
    const kinds = B.map(x => ownKind(x, dir, group, owner));
    const free = new Set(C);
    const take = pred => { for (const c of free) if (pred(c)) { free.delete(c); return c; } return null; };
    const same = (x, c) => cents(c.amount) === cents(x.amount);
    // into — Map(рахунок corpCard → рахунок, з яким він звіряється): у банку поповнення видно як переказ на рахунок, з якого картка
    // списує, а в CRM (R-NP-CORPCARD-01) — переказ на сам рахунок картки; це той самий рахунок «куди» (07.11.2026)
    const samePeer = (c, p) => c.peer === p || !!(into && c.peer != null && into.get(Number(c.peer)) === p);
    // переказ того самого напрямку; продаж валюти в CRM вносять і «обміном» (операції 5/6: ID 26152, 26153 у жовтні 2026) — це той самий
    // рух між тими самими рахунками, а не «переказ з іншим рахунком» (огляд 16.11.2026)
    const dirOk = (c, x) => (x.amount < 0 ? c.opc === 4 || c.opc === 6 : c.opc === 3 || c.opc === 5);
    const xfers = [], maybe = [], missing = new Set();
    const own = B.map((x, i) => ({ x, k: kinds[i] })).filter(o => o.k && o.k.kind === 'own');
    // 1) переказ між тими самими рахунками в тому самому напрямку
    const left = own.filter(o => {
      const c = take(c => same(o.x, c) && samePeer(c, o.k.peer) && dirOk(c, o.x));
      if (c) xfers.push({ row: o.x, peer: o.k.peer, state: 'ok', item: c });
      return !c;
    });
    // 2) решта операцій банку забирає свої записи (не перекази), щоб випадковий збіг суми не приписати переказу
    const rest = B.filter((x, i) => !(kinds[i] && kinds[i].kind === 'own')).filter(x => !take(c => same(x, c) && !(c.opc >= 3)));
    // 3) переказу немає: запис з тією самою сумою іншого типу, переказ з іншим рахунком — або нічого
    for (const o of left) {
      /* «інший тип» — лише запис поруч за датою (±3 дні, найближчий): сама сума — ще не той самий рух. Автоматичний запис «Підтвердження
         виведення коштів з балансу» 5 000 від 02.10 пропонувався змінити на переказ через переказ 5 000 від 29.10 (огляд 16.11.2026);
         далекий запис лишається собі («немає в банку»), а переказ — «немає в CRM» (пропозиція створити). */
      const typ = [...free].filter(c => same(o.x, c) && !(c.opc >= 3) && Math.abs(dayDiff(c.date, o.x.date)) <= 3)
        .sort((a, b) => Math.abs(dayDiff(a.date, o.x.date)) - Math.abs(dayDiff(b.date, o.x.date)))[0];
      let c = typ ? take(c => c === typ) : null;
      if (c) { xfers.push({ row: o.x, peer: o.k.peer, state: 'type', item: c }); continue; }
      c = take(c => same(o.x, c) && c.opc >= 3);
      if (c) { xfers.push({ row: o.x, peer: o.k.peer, state: 'peer', item: c }); continue; }
      const inP = new Set(C);
      c = (cfAll || []).find(c => !inP.has(c) && same(o.x, c) && samePeer(c, o.k.peer) && dirOk(c, o.x) && Math.abs(dayDiff(c.date, o.x.date)) <= 5);
      if (c) { xfers.push({ row: o.x, peer: o.k.peer, state: 'near', item: c }); continue; }
      xfers.push({ row: o.x, peer: o.k.peer, state: 'missing' });
      missing.add(o.x);
    }
    // 4) «схоже на переказ», для якого в CRM немає запису з такою сумою
    for (const x of rest) {
      const k = kinds[B.indexOf(x)];
      if (k && k.kind === 'maybe' && !take(c => same(x, c))) maybe.push({ row: x, why: k.why, key: ownKey(x) });
    }
    return { xfers, maybe, missing, kinds: new Map(B.map((x, i) => [x, kinds[i]]).filter(p => p[1])) };
  }

  /* Пари «операція банку — запис CRM»: з однаковою сумою, спершу найближчі за датою. Map: операція банку → запис CRM.
     maxDays — лише пари не далі стількох днів (periodRecon спершу бере близькі, далі — групи «суми не 1:1», а вже потім пари
     з іншою датою: інакше запис ліда 30 000 від 22.10 діставався чужій оплаті 30 000 від 14.10, 08.11.2026). */
  function pairRows(B, C, maxDays) {
    const byC = new Map(), lim = maxDays === undefined || maxDays === null ? Infinity : maxDays;
    for (const c of C) { const k = cents(c.amount); if (!byC.has(k)) byC.set(k, []); byC.get(k).push(c); }
    const pairs = [];
    // покупка карткою: у CRM — за датою покупки (з 07.11.2026) або проведення; відстань — до ближчої з них (інакше покупка 10.10, проведена
    // 11.10, забирала запис покупки 12.10 з тією самою сумою, 08.11.2026)
    for (const x of B) {
      const cands = byC.get(cents(x.amount));
      if (!cands) continue;
      const buy = cardDate(x.purpose);
      for (const c of cands) { const d = Math.min(Math.abs(dayDiff(x.date, c.date)), buy ? Math.abs(dayDiff(buy, c.date)) : Infinity); if (d <= lim) pairs.push([d, x, c]); }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const out = new Map(), uC = new Set();
    for (const [, x, c] of pairs) if (!out.has(x) && !uC.has(c)) { out.set(x, c); uC.add(c); }
    return out;
  }
  /* Що лишилось без пари: bank — операції банку, яких немає в CRM; crm — записи CRM, яких немає в банку. */
  function missingRows(B, C) {
    const p = pairRows(B, C), uC = new Set(p.values());
    return { bank: B.filter(x => !p.has(x)), crm: C.filter(c => !uC.has(c)) };
  }
  /* Комбінація від 2 до maxK записів з list (усі того самого знаку, що й target), сума яких до копійки дорівнює target; спершу найкоротша. */
  function subsetSum(target, list, maxK) {
    const c = list.slice(0, 18).map(x => Math.abs(cents(x.amount))), t = Math.abs(target), pick = [];
    const go = (i, sum, k) => {
      if (pick.length === k) return sum === t;
      for (let j = i; j < c.length; j++) {
        if (sum + c[j] > t) continue;
        pick.push(j);
        if (go(j + 1, sum + c[j], k)) return true;
        pick.pop();
      }
      return false;
    };
    for (let k = 2; k <= maxK; k++) if (go(0, 0, k)) return pick.map(j => list[j]);
    return null;
  }
  /* Будь-яка комбінація з list (до max перших елементів; від minK до maxK штук), сума якої до копійки дорівнює |target|.
     Перебір від більших сум з відсіканням (решти не вистачить / уже забагато) і з обмеженням кроків — без зависань на десятках записів. */
  function subsetExact(target, list, o) {
    const n = Math.min(list.length, (o && o.max) || 20), minK = (o && o.minK) || 1, maxK = (o && o.maxK) || n, t = Math.abs(cents(target));
    const it = list.slice(0, n).map(x => ({ x, c: Math.abs(cents(x.amount)) })).sort((a, b) => b.c - a.c);
    const rest = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) rest[i] = rest[i + 1] + it[i].c;
    const pick = [];
    let steps = 0;
    const go = (i, sum) => {
      if (sum === t) return pick.length >= minK;
      if (pick.length >= maxK || ++steps > 200000) return false;
      for (let j = i; j < n; j++) {
        if (sum + rest[j] < t) return false;
        if (sum + it[j].c > t) continue;
        pick.push(j);
        if (go(j + 1, sum + it[j].c)) return true;
        pick.pop();
      }
      return false;
    };
    return t > 0 && go(0, 0) ? pick.map(j => it[j].x) : null;
  }
  const sumC = list => list.reduce((s, x) => s + cents(x.amount), 0);
  const nameWordsOf = s => new Set((String(s || '').toLowerCase().replace(/[’ʼ'`]/g, '').match(/\p{L}{4,}/gu) || []).filter(w => !STOP.has(w)));
  const LEAD_NO = /(?:^|\s)Лід:\s*(\d+)/i;
  /* Суми не 1:1: одна операція банку = кілька записів CRM (наприклад, переказ на картку власника, а з неї — виплати кільком людям)
     або один запис CRM = кілька операцій банку. Того самого знаку, за ±3 дні, разом до копійки. LB, LC — без пар 1:1;
     can(x, c) — чи може операція банку x бути разом із записом c (за замовчуванням — так). → [{bank: [], crm: []}]
     З 08.11.2026 (звірка жовтня): кандидати — спершу найближчі за датою й з тим самим ім'ям платника (раніше бралися перші 18 у порядку
     виписки, і на рахунку з сотнями операцій потрібні часто не потрапляли); покупка корп. карткою — лише з записами рахунку цієї картки,
     а запис картки — лише з її покупками (o.cardOf(x) → id рахунку картки або null, o.cards — рахунки карток групи; раніше покупку
     «складало» з комісією банку в податок); переказ на особисту картку власника (o.kindOf(x) === 'card') — до 10 записів того самого дня
     (виплати менеджерам з картки); кілька замовлень одного ліда за день (у коментарі «Лід: N») — один запис для «кілька операцій банку». */
  function multiPairs(LB, LC, can, o) {
    const out = [], uB = new Set(), uC = new Set(), ok = can || (() => true);
    const cards = (o && o.cards) || null, cardOf = (o && o.cardOf) || (() => null), kindOf = (o && o.kindOf) || (() => null);
    const isBuy = x => !!(cardTail(x.purpose) && cardDate(x.purpose));
    // покупка відомою корп. карткою — з записами її рахунку або основного рахунку (покупки 3462 Хоменко пише й на ФОП), але не з податком;
    // запис рахунку картки — лише з покупками цієї картки
    const compat = (x, c) => {
      if (!cards || !cards.size) return true;
      const k = isBuy(x) ? cardOf(x) : null;
      return k ? c.acc === k || (!cards.has(c.acc) && !TAX_REC.test(c.comment || '')) : !cards.has(c.acc);
    };
    const fits = (a, b) => (a.amount < 0) === (b.amount < 0) && Math.abs(b.amount) < Math.abs(a.amount) && Math.abs(dayDiff(a.date, b.date)) <= 3;
    const big = list => [...list].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    // найближчі за датою, з тим самим ім'ям (платник у банку ↔ клієнт у коментарі) — спершу; далі більші суми
    const rank = (t, list, txt) => {
      const w = nameWordsOf(t.cpty || t.comment || '');
      const sc = y => Math.abs(dayDiff(t.date, y.date)) * 2 - ([...nameWordsOf(txt(y))].some(v => w.has(v)) ? 1 : 0);
      return list.map(y => [sc(y), y]).sort((p, q) => p[0] - q[0] || Math.abs(q[1].amount) - Math.abs(p[1].amount)).map(p => p[1]);
    };
    for (const x of big(LB)) {
      let cand = LC.filter(c => !uC.has(c) && fits(x, c) && ok(x, c) && compat(x, c)), maxK = 5;
      // до 10 записів — лише серед записів того самого дня і лише коли їх небагато: з десятків кандидатів точну суму «складе» випадково
      if (kindOf(x) === 'card') { const day = cand.filter(c => c.date === x.date); if (day.length <= 12) { cand = day; maxK = 10; } }
      const got = subsetSum(cents(x.amount), rank(x, cand, c => c.comment), maxK);
      if (got) { uB.add(x); got.forEach(c => uC.add(c)); out.push({ bank: [x], crm: got }); }
    }
    // кілька замовлень одного ліда за той самий день — разом як один запис
    const units = [], byLead = new Map();
    for (const c of LC) {
      const m = !uC.has(c) && LEAD_NO.exec(c.comment || '');
      if (!m) continue;
      const k = `${m[1]}|${c.date}|${c.amount < 0 ? '-' : '+'}`;
      if (!byLead.has(k)) byLead.set(k, []);
      byLead.get(k).push(c);
    }
    for (const list of byLead.values()) if (list.length > 1) units.push({ amount: r2(list.reduce((s, c) => s + c.amount, 0)), date: list[0].date, comment: list[0].comment, acc: list[0].acc, members: list });
    for (const c of big([...LC, ...units])) {
      const mem = c.members || [c];
      if (mem.some(z => uC.has(z))) continue;
      const cand = LB.filter(x => !uB.has(x) && fits(c, x) && mem.every(z => ok(x, z) && compat(x, z)));
      const one = c.members ? LB.find(x => !uB.has(x) && cents(x.amount) === cents(c.amount) && Math.abs(dayDiff(x.date, c.date)) <= 3 && mem.every(z => ok(x, z) && compat(x, z))) : null;
      // покупки карткою й інші операції банку в одну суму не складаються: спершу ті, на які схожий запис (реклама — покупки), далі інші
      const buys = cand.filter(isBuy), rest = cand.filter(x => !isBuy(x)), adsLike = /facebook|google|\bfb\b|meta|ads|картк/i.test(c.comment || '');
      const pools = (adsLike ? [buys, rest] : [rest, buys]).filter(p => p.length);
      let got = one ? [one] : null;
      for (const p of pools) { if (got) break; got = subsetSum(cents(c.amount), rank(c, p, x => x.cpty), 5); }
      if (got) { mem.forEach(z => uC.add(z)); got.forEach(x => uB.add(x)); out.push({ bank: got, crm: mem }); }
    }
    return out;
  }
  /* ---------- групи за ознаками операцій (звірка жовтня 2026, 08.11.2026) ----------
     Кожна функція — на операціях банку LB і записах CRM LC без пар; → [{bank, crm, why}]. Сума групи до копійки: bank = crm. */
  /* Покупки корп. карткою за день: у CRM часто один запис на всі покупки картки за день («Facebook, 1011.31+514,00+1386.43 = 2 911,74»,
     «тотал. сума по fb за 02.10.2026» — 21 покупка). Запис рахунку картки (витрата) від D ↔ покупки цією карткою з датою покупки D
     (з призначення виписки): усі разом або частина (до 24 покупок). tailsOf(id рахунку) → номери карток рахунку. */
  function cardDays(LB, LC, tailsOf) {
    const out = [], uB = new Set();
    const buys = LB.filter(x => x.amount < 0 && cardTail(x.purpose) && cardDate(x.purpose));
    if (!buys.length) return out;
    for (const c of LC.filter(c => c.opc === 2 && c.amount < 0).sort((a, b) => a.amount - b.amount)) {
      const tails = tailsOf(c.acc);
      if (!tails || !tails.length) continue;
      const cand = buys.filter(x => !uB.has(x) && tails.includes(cardTail(x.purpose)) && cardDate(x.purpose) === c.date);
      if (cand.length < 2) continue;
      // усі покупки дня — скільки б їх не було; частина — лише з ≤ 12 покупок (з більшої кількості точну суму «складе» випадково)
      const got = sumC(cand) === cents(c.amount) ? cand : cand.length <= 12 ? subsetExact(c.amount, cand, { max: 12, minK: 2 }) : null;
      if (got) { got.forEach(x => uB.add(x)); out.push({ bank: got, crm: [c], why: 'card-day' }); }
    }
    return out;
  }
  /* LiqPay: у банку — зараховано (без комісії), у CRM — оплата ліда (брутто) і окремий запис «Комісія LiqPay …» з тим самим LIQPAY ID
     (або «…, зараховано N — LiqPay ДД.ММ.РРРР»). Лід + комісія = зарахування в банку до копійки — це той самий платіж, не два записи
     «немає в банку» і не «немає в CRM». Ліда — за номером «запис N» у коментарі комісії, інакше з тією сумою за ±3 дні. */
  const LIQ_ID = /liqpay\s*id\s*:?\s*(\d{6,})/i;
  const LIQ_FEE = /коміс\p{L}*\s+liqpay/iu;
  const moneyIn = s => { const m = /зараховано\s+(\d[\d\s  ]*(?:[.,]\d{1,2})?)/i.exec(String(s || '')); return m ? cents(Number(m[1].replace(/[\s  ]/g, '').replace(',', '.'))) : null; };
  function liqpayGroups(LB, LC) {
    const out = [], uC = new Set();
    const fees = LC.filter(c => c.amount < 0 && LIQ_FEE.test(c.comment || ''));
    if (!fees.length) return out;
    for (const x of LB.filter(x => x.amount > 0 && /liqpay/i.test(`${x.purpose || ''} ${x.cpty || ''}`))) {
      const id = (LIQ_ID.exec(x.purpose || '') || [])[1];
      let f = id ? fees.find(c => !uC.has(c) && (LIQ_ID.exec(c.comment) || [])[1] === id) : null;
      if (!f) f = fees.find(c => !uC.has(c) && !LIQ_ID.test(c.comment) && moneyIn(c.comment) === cents(x.amount) && (dmy2iso(String(c.comment).replace(/^.*liqpay\s+/i, '')) || c.date) === x.date);
      if (!f) continue;
      const need = cents(x.amount) - cents(f.amount), lead = (/запис\s+(\d+)/i.exec(f.comment) || [])[1];
      const g = LC.filter(c => !uC.has(c) && c !== f && c.amount > 0 && cents(c.amount) === need && Math.abs(dayDiff(c.date, x.date)) <= 3)
        .sort((a, b) => (String(b.id) === lead) - (String(a.id) === lead) || Math.abs(dayDiff(a.date, x.date)) - Math.abs(dayDiff(b.date, x.date)))[0];
      if (!g) continue;
      uC.add(f); uC.add(g);
      out.push({ bank: [x], crm: [g, f], why: 'liqpay' });
    }
    return out;
  }
  /* Податки із ЗП за день: банк платить ВЗ + ПДФО (+ ЄСВ) кількома платежами, у CRM — податки по людях («Податки 10 % з …», «9405,56*2=…»).
     Платежі податків дня D (усі, без ЄСВ або однією хвилиною — один пакет) ↔ записи податків від D: усі разом чи частина (до 18). */
  const TAX_REC = /подат|пдфо|(?<!\p{L})єсв(?!\p{L})|військов\p{L}*\s+зб|\d\s*\*\s*2\s*=/iu;
  const ESV_RE = /(?<!\p{L})єсв(?!\p{L})|єдин\p{L}*\s+соц/iu;
  /* opt.exact — лише весь день до копійки (усі платежі податків дня, з ЄСВ або без, = усі записи податків дня), і лише коли це не пари 1:1:
     так periodRecon бере очевидний день ще до пар за сумою — інакше чужа операція з тією самою сумою (оплата постачальнику 2 000 наступного
     дня) забирала один запис «Податки 10 % з …», день не складався, і податки показувались «немає в CRM» (огляд 16.11.2026). */
  function taxDays(LB, LC, opt) {
    const out = [], uB = new Set(), uC = new Set(), exact = !!(opt && opt.exact);
    const tb = LB.filter(x => x.amount < 0 && PAY_TAX.test(x.purpose || '')), tc = LC.filter(c => c.amount < 0 && c.opc === 2 && TAX_REC.test(c.comment || '') && !LIQ_FEE.test(c.comment || ''));
    if (!tb.length || !tc.length) return out;
    for (const d of [...new Set(tb.map(x => x.date))].sort()) {
      const BD = tb.filter(x => x.date === d);
      if (!tc.some(c => c.date === d)) continue;
      const noEsv = BD.filter(x => !ESV_RE.test(x.purpose || ''));
      const byTime = list => [...new Set(list.map(x => x.time || ''))].map(t => list.filter(x => (x.time || '') === t));
      const variants = exact ? [BD, noEsv] : [BD, noEsv, ...(byTime(BD).length > 1 ? byTime(BD) : []), ...(byTime(noEsv).length > 1 ? byTime(noEsv) : [])];
      for (const V of variants) {
        if (!V.length || V.some(x => uB.has(x))) continue;
        const CD = tc.filter(c => c.date === d && !uC.has(c));
        if (!CD.length) break;
        // податок, внесений цілим платежем (кожен платіж має запис з тією самою сумою), — це пари 1:1, не група (пари потрібні «Внести в CRM»)
        if (exact && V.every(x => CD.some(c => cents(c.amount) === cents(x.amount)))) continue;
        const got = sumC(CD) === sumC(V) ? CD : !exact && CD.length <= 14 ? subsetExact(sumC(V) / 100, CD, { max: 14 }) : null;
        if (got) { V.forEach(x => uB.add(x)); got.forEach(c => uC.add(c)); out.push({ bank: V, crm: got, why: 'tax-day' }); }
      }
      if (exact) continue;
      // податки по людях у CRM рахують «10 % з …» і округлюють кожен окремо: увесь день без ЄСВ — з різницею до 1 коп. на запис (до 5 коп.)
      const CD = tc.filter(c => c.date === d && !uC.has(c)), V = noEsv.filter(x => !uB.has(x));
      const dd = sumC(CD) - sumC(V);
      if (CD.length && V.length && V.length === noEsv.length && dd !== 0 && Math.abs(dd) <= Math.min(5, CD.length)) {
        V.forEach(x => uB.add(x)); CD.forEach(c => uC.add(c));
        out.push({ bank: V, crm: CD, why: 'tax-day', diff: r2(dd / 100) });
      }
    }
    return out;
  }
  /* ЗП через транзитний рахунок за день: перекази на транзит дня D (isPay) ↔ записи ЗП (sal) від D — разом до копійки. */
  function payDays(LB, LC, isPay, sal) {
    const out = [];
    const pb = LB.filter(x => x.amount < 0 && isPay(x)), pc = LC.filter(c => c.amount < 0 && c.opc <= 2 && sal(c));
    for (const d of [...new Set(pb.map(x => x.date))].sort()) {
      const BD = pb.filter(x => x.date === d), CD = pc.filter(c => c.date === d);
      if (CD.length && sumC(BD) === sumC(CD)) out.push({ bank: BD, crm: CD, why: 'pay-day' });
    }
    return out;
  }
  /* Платіж і його повернення (той самий контрагент, та сама сума, повернення — не пізніше 14 днів, у призначенні «поверн…»):
     разом 0, у CRM не вносяться. → [{bank: [платіж, повернення], crm: [], why: 'refund'}] */
  const samePeerB = (a, b) => (a.cpCode && b.cpCode ? a.cpCode === b.cpCode : a.cpIban && b.cpIban ? a.cpIban === b.cpIban : !!a.cpty && lowTxt(a.cpty) === lowTxt(b.cpty));
  function refundPairs(LB, skip) {
    const out = [], used = new Set();
    for (const y of LB.filter(y => y.amount > 0 && /поверн/i.test(y.purpose || ''))) {
      const x = LB.filter(x => !used.has(x) && x.amount < 0 && cents(x.amount) === -cents(y.amount) && x.date <= y.date && dayDiff(y.date, x.date) <= 14 && samePeerB(x, y))
        .sort((a, b) => dayDiff(y.date, a.date) - dayDiff(y.date, b.date))[0];
      if (x) { used.add(x); used.add(y); out.push({ bank: [x, y], crm: [], why: 'refund' }); }
    }
    /* Навпаки: гроші надійшли — і їх повернули платникові (той самий контрагент, та сама сума, не пізніше 3 днів; у списанні «поверн…»
       або те саме призначення слово в слово: 17.09.2026 +60 000 і −60 000 «За послуги адвоката …» на той самий IBAN). Теж разом 0 — не
       надходження й витрата в «Внести в CRM» (огляд 16.11.2026). skip(x) — операції, що мають свій розбір (схоже на переказ між своїми). */
    const txt = s => lowTxt(String(s || '').replace(/\s+/g, ' ').trim());
    for (const y of LB.filter(y => y.amount > 0 && !used.has(y) && !(skip && skip(y)))) {
      const x = LB.filter(x => !used.has(x) && !(skip && skip(x)) && x.amount < 0 && cents(x.amount) === -cents(y.amount) && x.date >= y.date && dayDiff(x.date, y.date) <= 3 && samePeerB(x, y)
        && (/поверн/i.test(x.purpose || '') || (!!txt(y.purpose) && txt(x.purpose) === txt(y.purpose))))
        .sort((a, b) => dayDiff(a.date, y.date) - dayDiff(b.date, y.date))[0];
      if (x) { used.add(x); used.add(y); out.push({ bank: [y, x], crm: [], why: 'refund' }); }
    }
    return out;
  }
  // дата покупки карткою з призначення виписки: «4246 **** **** 7365 24.10.2026 17:03:51 …» → '2026-10-24'
  const CARD_DATE = /\*{2,}[\s*xх]*\d{4}\s+(\d{2})\.(\d{2})\.(\d{4})/i;
  const cardDate = s => { const m = CARD_DATE.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  /* Покупки карткою: банк проводить їх за 1–3 дні, а в CRM вони — за датою покупки. → [{kind, bank, crm}]
     later   — банк провів у періоді покупку, яка в CRM записана раніше (запис з тією самою сумою за дату покупки);
     after   — запис corpCard у періоді, банк провів його вже після періоду (є у виписці);
     pending — запис corpCard, а виписка закінчується раніше, ніж за 3 дні після нього: банк ще не провів.
     LB, LC — без пар; cf — увесь рух групи; cards — id corpCard групи; used — записи CRM, що вже мають пару. */
  function cardTiming(LB, LC, cf, cards, bank, to, used, from) {
    const out = [], taken = new Set(used), takenB = new Set();
    /* Операції банку й записи CRM поза періодом, що мають пару між собою (±3 дні, покупка — за датою покупки), — зайняті: покупки з тією
       самою сумою в сусідні дні — звичайна річ (у жовтні 2026 — 83 з 228). Інакше зайвий запис 31.10 «пояснювався» листопадовою покупкою,
       яка належить запису 01.11, а покупка 01.10 без запису — записом 30.09, що вже має свою операцію 30.09 (огляд 16.11.2026). */
    // пари шукаються разом з кандидатами періоду (найближчий за датою виграє; за рівної відстані — запис чи операція, що стоїть першою)
    const isAfter = c => !taken.has(c) && cards.has(c.acc) && c.opc === 2, postC = new Set(cf.filter(c => c.date > to));
    for (const [y, c] of pairRows(bank.rows.filter(y => y.date > to), [...LC.filter(isAfter), ...postC], 3)) if (postC.has(c)) takenB.add(y);
    if (from) {
      const preB = new Set(bank.rows.filter(y => y.date < from && (!bank.fileFrom || y.date >= bank.fileFrom)));
      for (const [y, c] of pairRows([...preB, ...LB.filter(x => { const d = cardDate(x.purpose); return d && d < x.date; })], cf.filter(c => c.date < from && !taken.has(c)), 3)) if (preB.has(y)) taken.add(c);
    }
    for (const x of LB) {
      const d = cardDate(x.purpose);
      if (!d || d >= x.date) continue;
      const c = cf.filter(c => !taken.has(c) && cents(c.amount) === cents(x.amount) && c.date >= addDays(d, -1) && c.date <= x.date)
        .sort((a, b) => Math.abs(dayDiff(a.date, d)) - Math.abs(dayDiff(b.date, d)))[0];
      if (c) { taken.add(c); out.push({ kind: 'later', bank: x, crm: c, buy: d }); }
    }
    for (const c of LC) {
      if (taken.has(c) || !cards.has(c.acc) || c.opc !== 2) continue;
      const y = bank.rows.find(y => !takenB.has(y) && y.date > to && cents(y.amount) === cents(c.amount) && cardDate(y.purpose) && Math.abs(dayDiff(cardDate(y.purpose), c.date)) <= 1);
      if (y) { takenB.add(y); taken.add(c); out.push({ kind: 'after', bank: y, crm: c }); }
      else if (bank.fileTo && dayDiff(bank.fileTo, c.date) <= 3) { taken.add(c); out.push({ kind: 'pending', bank: null, crm: c }); }
    }
    return out;
  }
  /* Тип для фільтра звірки. У CRM — за операцією: переказ і обмін — «між рахунками». У банку — переказ між своїми, якщо контрагент —
     наш рахунок, або в CRM ця операція записана переказом, або вона схожа на переказ і запису немає; інакше за знаком суми
     (переказ на транзитний рахунок ЗП — списання: у CRM це витрати по людях).
     pairOf(x) — запис CRM у парі з операцією банку (1:1, «кілька записів» чи покупка карткою з іншою датою) або нічого. */
  const crmKind = c => (c.opc >= 3 ? 'own' : c.opc === 1 ? 'credit' : 'debit');
  const KINDS = ['all', 'credit', 'debit', 'own'];
  function bankKinds(B, own, pairOf) {
    const out = new Map();
    for (const x of B) {
      const k = own && own.kinds.get(x), c = pairOf(x);
      out.set(x, (k && k.kind === 'own') || (c ? crmKind(c) === 'own' : !!(k && k.kind === 'maybe')) ? 'own' : x.amount > 0 ? 'credit' : 'debit');
    }
    return out;
  }

  /* Рахунок за період from…to (включно, дати за Києвом).
     bank — рахунок із bankAccounts або null; cf — рух рахунку в CRM щонайменше з (from − 5 днів) до сьогодні;
     balanceNow — поточний balance рахунку в CRM (залишки CRM — так, як їх показує CRM).
     manualClose — залишок банку на кінець періоду, введений вручну (коли виписки немає).
     own — {dir, group, owner, kind, into}: dir — шукати перекази між своїми (ownTransfers; into — Map corpCard → рахунок, з яким він звіряється). Переказ, якого немає в CRM, не потрапляє
     в «суми, що не сходяться»: він — у own.missing; xferOnly — після створення цих переказів рахунок зійдеться.
     kind — що звіряти: 'all', 'credit' (надходження), 'debit' (списання), 'own' (перекази між рахунками); з фільтром обороти,
     кількість і суми — лише цього типу, а залишки на початок і кінець не порівнюються. cards — id corpCard, зведених з рахунком.
     Пояснені різниці не рахуються в «суми, що не сходяться»: multi — одна операція = кілька записів (multiPairs);
     timing — покупки карткою, які банк провів в інший день (cardTiming); adj — різниці без них, timingOk — без них усе сходиться;
     cross — з фільтром типу: у банку переказ між своїми, а в CRM той самий рух записано витратою чи доходом (різниця лишається).
     ЗП через транзитний рахунок поштучно не звіряється: у банку — переказ одним платежем, у CRM — записи по людях зі статтями ЗП
     (own.salary(запис) → true) за днем погодження. Такі операції банку й записи без пари — у pay {bank, crm}: не в «сумах, що не
     сходяться», а їхня різниця — в adj (timingOk). Записи ЗП — лише в такі пари (multi), якщо рахунок платить ЗП через транзитний:
     у періоді є переказ на нього або own.payroll (бачили раніше).
     own.skip(операція банку, вид) → причина — за правилом не вноситься в CRM (кошти броніків): ruled [{row, why}], поза звіркою;
     own.calc(запис CRM) → причина — розрахунковий запис без руху в банку (1.5 % від бронювання): calc [{crm, why}]. Обидва — в adj.
     Групи multi з 08.11.2026 мають why: 'card-day' (покупки картки за день), 'liqpay' (лід + комісія LiqPay = зарахування), 'tax-day'
     (податки із ЗП за день), 'pay-day' (ЗП через транзит за день), 'refund' (платіж і його повернення, crm: []); без why — суми не 1:1.
     missing — решта операцій банку без пари в CRM і записів CRM без пари в банку (для пропозицій); pairs — пари 1:1 (операція → запис). */
  function periodRecon(bank, cf, balanceNow, from, to, manualClose, own) {
    const kind = own && KINDS.includes(own.kind) ? own.kind : 'all';
    const C0 = cf.filter(x => x.date >= from && x.date <= to), C = kind === 'all' ? C0 : C0.filter(c => crmKind(c) === kind);
    const crm = { open: crmBalanceAt(balanceNow, cf, addDays(from, -1)).value, close: crmBalanceAt(balanceNow, cf, to).value, cred: sumPos(C), deb: sumNeg(C), n: C.length };
    const res = { crm, bank: null, diff: null, amounts: [], distinct: 0, covered: false, warnings: [], source: '', kind };
    if (bank) {
      const covered = !!(bank.fileFrom && bank.fileTo && bank.fileFrom <= from && bank.fileTo >= to);
      const B0 = bank.rows.filter(x => x.date >= from && x.date <= to);
      const closeV = bankBalanceAt(bank, to);
      res.bank = { open: bankOpeningAt(bank, from), close: closeV.value, cred: null, deb: null, n: null };
      res.covered = covered;
      // те саме вже каже попередження файлу «Виписка неповна…» (normPrivat) — двічі не показуємо
      if (closeV.warn && !(bank.warnings || []).some(w => /^Виписка неповна/.test(w))) res.warnings.push(closeV.warn);
      if (!covered) res.warnings.push(`виписка за ${bank.fileFrom || '?'}…${bank.fileTo || '?'} не покриває період — обороти й кількість операцій не порівнюються`);
      if (covered) {
        // перекази між своїми розпізнаються на всіх операціях, а фільтр типу — вже після
        if (own && own.dir) res.own = ownTransfers(B0, C0, own.dir, own.group, own.owner, cf, own.into);
        const miss = res.own ? res.own.missing : new Set();
        const kindOf = x => (res.own && res.own.kinds.get(x) ? res.own.kinds.get(x).kind : null);
        const isOwn = x => kindOf(x) === 'own', isPay = x => kindOf(x) === 'pay';
        const sal = (own && own.salary) || (() => false), payAcc = !!(own && own.payroll) || B0.some(isPay);
        /* За правилом компанії в CRM не вносяться (own.skip(x, вид) → причина): кошти броніків, їхня ЗП і податки (rules.json →
           reference.bronik_accounts). Перекази між своїми звіряються як завжди. Такі операції — поза звіркою (ruled), з причиною. */
        res.ruled = [];
        // «схоже на переказ між своїми» (maybe: рахунок «куди» невідомий чи не зіставлений) — теж переказ, звіряється як завжди, не «кошти броніків»
        if (own && own.skip) for (const x of B0) { if (isOwn(x) || kindOf(x) === 'maybe' || miss.has(x)) continue; const why = own.skip(x, kindOf(x)); if (why) res.ruled.push({ row: x, why }); }
        const rB = new Set(res.ruled.map(o => o.row));
        // розрахункові записи CRM, руху яких у банку немає за самим правилом (1.5 % від бронювання): own.calc(запис) → причина
        res.calc = [];
        if (own && own.calc) for (const c of C0) { const why = own.calc(c); if (why) res.calc.push({ crm: c, why }); }
        const rC = new Set(res.calc.map(o => o.crm));
        let Bm = B0.filter(x => !miss.has(x) && !rB.has(x)), Cm = C0.filter(c => !rC.has(c));
        // 0) LiqPay — до пар 1:1: запис комісії прямо називає платіж (LIQPAY ID чи «запис N»), а лід з тією самою сумою інакше могла забрати чужа пара
        const groups = [], gB = new Set(), gC = new Set();
        for (const g of liqpayGroups(Bm, Cm)) { groups.push(g); g.bank.forEach(x => gB.add(x)); g.crm.forEach(c => gC.add(c)); }
        // і податки із ЗП, де день сходиться цілим (ВЗ + ПДФО банку = податки по людях у CRM), — теж до пар (огляд 16.11.2026)
        for (const g of taxDays(Bm.filter(x => !gB.has(x) && !isOwn(x)), Cm.filter(c => !gC.has(c)), { exact: true })) { groups.push(g); g.bank.forEach(x => gB.add(x)); g.crm.forEach(c => gC.add(c)); }
        Bm = Bm.filter(x => !gB.has(x)); Cm = Cm.filter(c => !gC.has(c));
        // 1) пари 1:1 за сумою в межах ±3 днів (08.11.2026: далекі пари — після груп, інакше чужий запис з тією самою сумою «з'їдав» групу)
        const P1 = res.pairs = pairRows(Bm, Cm, 3), p1c = new Set(P1.values());
        let LB = Bm.filter(x => !P1.has(x) && !isOwn(x)), LC = Cm.filter(c => !p1c.has(c));
        // 2) групи за ознаками: покупки картки за день, податки із ЗП і ЗП через транзит за день, платіж і повернення
        const cardSet = new Set((own && own.cards) || []), tails = new Map();
        for (const [t, id] of Object.entries((own && own.dir && own.dir.cards) || {})) if (cardSet.has(Number(id))) tails.set(Number(id), (tails.get(Number(id)) || []).concat(t));
        const keep = list => { for (const g of list) { groups.push(g); g.bank.forEach(x => gB.add(x)); g.crm.forEach(c => gC.add(c)); } LB = LB.filter(x => !gB.has(x)); LC = LC.filter(c => !gC.has(c)); };
        if (tails.size) keep(cardDays(LB, LC, id => tails.get(id)));
        keep(taxDays(LB, LC));
        if (payAcc) keep(payDays(LB, LC, isPay, sal));
        keep(refundPairs(LB, x => !!kindOf(x)));
        // 3) одна операція = кілька записів (і навпаки); записи ЗП складаються лише в перекази на транзитний рахунок і в податки на ЗП —
        // не у випадкову суму іншої операції; покупка корп. карткою — лише з записами рахунку цієї картки
        const cardOf = x => { const t = cardTail(x.purpose), id = t && own && own.dir && own.dir.cards ? Number(own.dir.cards[t]) : 0; return id && cardSet.has(id) ? id : null; };
        res.multi = groups.concat(multiPairs(LB, LC, payAcc ? (x, c) => !sal(c) || isPay(x) || PAY_TAX.test(x.purpose || '') : null, { cards: cardSet, cardOf, kindOf }));
        const mB = new Map(), mC = new Set();
        res.multi.forEach(g => { g.bank.forEach(x => mB.set(x, g.crm[0])); g.crm.forEach(c => mC.add(c)); });
        // 4) пари 1:1 з іншою датою (далі ніж за 3 дні)
        for (const [x, c] of pairRows(Bm.filter(x => !P1.has(x) && !mB.has(x)), Cm.filter(c => !p1c.has(c) && !mC.has(c)))) { P1.set(x, c); p1c.add(c); }
        LB = LB.filter(x => !mB.has(x) && !P1.has(x)); LC = LC.filter(c => !mC.has(c) && !p1c.has(c));
        res.timing = cardTiming(LB, LC, cf, cardSet, bank, to, new Set([...p1c, ...mC]), from);
        const tB = new Map(res.timing.filter(t => t.kind === 'later').map(t => [t.bank, t.crm]));
        const tC = new Set(res.timing.filter(t => t.kind !== 'later').map(t => t.crm));
        if (res.own) res.own.maybe = res.own.maybe.filter(m => !mB.has(m.row)); // «схоже на переказ», а в CRM це кілька записів — не переказ
        res.kinds = bankKinds(B0, res.own, x => P1.get(x) || mB.get(x) || tB.get(x));
        const B = kind === 'all' ? B0 : B0.filter(x => res.kinds.get(x) === kind);
        Object.assign(res.bank, { cred: sumPos(B), deb: sumNeg(B), n: B.length });
        // решта переказів на транзитний рахунок ЗП і записів ЗП без пари поштучно не звіряються — лише підсумок
        res.pay = null;
        if (payAcc) {
          const inB = new Set(B), inC = new Set(C);
          const pB = LB.filter(x => inB.has(x) && !mB.has(x) && !tB.has(x) && isPay(x)), pC = LC.filter(c => inC.has(c) && !mC.has(c) && !tC.has(c) && c.opc <= 2 && sal(c));
          if (pB.length || pC.length) res.pay = { bank: pB, crm: pC };
        }
        const yB = new Set(res.pay ? res.pay.bank : []), yC = new Set(res.pay ? res.pay.crm : []);
        // з фільтром типу: пара, де в банку переказ між своїми, а в CRM — витрата чи дохід, — не «немає в банку / в CRM», а cross (різний тип)
        res.cross = kind === 'all' ? [] : [...P1].filter(([x, c]) => res.kinds.get(x) !== crmKind(c) && (res.kinds.get(x) === kind || crmKind(c) === kind)).map(([x, c]) => ({ bank: x, crm: c }));
        const xB = new Set(res.cross.map(p => p.bank)), xC = new Set(res.cross.map(p => p.crm));
        // кількість за сумами — без відсутніх переказів між своїми (вони — у пропозиціях), без пояснених різниць і ЗП через транзит
        const Bc = B.filter(x => !miss.has(x) && !mB.has(x) && !tB.has(x) && !xB.has(x) && !yB.has(x) && !rB.has(x)), Cc = C.filter(c => !mC.has(c) && !tC.has(c) && !xC.has(c) && !yC.has(c) && !rC.has(c));
        const a = countByAmount(Bc, Cc, kind === 'all' ? cf : cf.filter(c => crmKind(c) === kind), from, to);
        res.amounts = a.mismatched; res.distinct = a.distinct;
        res.missing = missingRows(Bc, Cc);
      }
    } else if (manualClose !== undefined && manualClose !== null) {
      res.bank = { open: null, close: r2(manualClose), cred: null, deb: null, n: null };
      res.source = 'manual';
    }
    if (res.bank) res.diff = { open: dif(crm.open, res.bank.open), close: dif(crm.close, res.bank.close), cred: dif(crm.cred, res.bank.cred), deb: dif(crm.deb, res.bank.deb), n: res.bank.n === null ? null : crm.n - res.bank.n };
    const z = v => v === null || Math.abs(v) < 0.005;
    const keys = kind === 'all' ? ['open', 'close', 'cred', 'deb'] : ['cred', 'deb'];
    res.ok = !!res.bank && (kind === 'all' ? res.diff.close !== null && (res.covered || res.source === 'manual') : res.covered) && keys.every(k => z(res.diff[k])) && !res.amounts.length;
    // різниця лише через дати проведення покупок карткою і ЗП через транзитний рахунок: adj — різниці без них; timingOk — без них усе сходиться
    // групи, що змінюють обороти (не суму): LiqPay — у банку зараховано, у CRM лід і комісія; платіж і повернення — лише в банку
    const turnG = (res.multi || []).filter(g => g.why === 'liqpay' || g.why === 'refund');
    res.adjWhy = [...new Set([res.pay ? 'pay' : '', res.timing && res.timing.length ? 'timing' : '', ...turnG.map(g => g.why),
      res.ruled && res.ruled.length ? 'ruled' : '', res.calc && res.calc.length ? 'calc' : ''].filter(Boolean))];
    if (!res.ok && res.adjWhy.length && !res.amounts.length) {
      const adj = { open: 0, close: 0, cred: 0, deb: 0 };
      const onlyB = x => { if (kind !== 'all' && res.kinds.get(x) !== kind) return; if (x.amount > 0) adj.cred += x.amount; else adj.deb -= x.amount; adj.close -= x.amount; };
      const onlyC = c => { if (kind !== 'all' && crmKind(c) !== kind) return; if (c.amount > 0) adj.cred -= c.amount; else adj.deb += c.amount; adj.close += c.amount; };
      // ЗП (вже лише вибраного типу): у банку переказ є, а в CRM немає (+); у CRM запис є, а в банку немає (−) — як у покупок карткою
      if (res.pay) { res.pay.bank.forEach(onlyB); res.pay.crm.forEach(onlyC); }
      // за правилом не вноситься в CRM (кошти броніків) — лише в банку; розрахунковий запис (1.5 % від бронювання) — лише в CRM
      (res.ruled || []).forEach(o => onlyB(o.row));
      (res.calc || []).forEach(o => onlyC(o.crm));
      turnG.forEach(g => { g.bank.forEach(onlyB); g.crm.forEach(onlyC); });
      for (const t of res.timing || []) {
        const a = t.kind === 'later' ? t.bank.amount : t.crm.amount;
        if (kind !== 'all' && kind !== (a > 0 ? 'credit' : 'debit')) continue;
        const s = t.kind === 'later' ? 1 : -1; // банк провів у періоді те, що в CRM раніше (+), або в CRM у періоді те, що банк провів пізніше (−)
        if (a > 0) adj.cred += s * a; else adj.deb -= s * a;
        if (t.kind !== 'later') adj.close += t.crm.amount;
        else if (t.crm.date < from) adj.open += t.crm.amount;
      }
      const sub = (v, d) => (v === null ? null : r2(v - d));
      res.adj = { open: sub(res.diff.open, adj.open), close: sub(res.diff.close, adj.close), cred: sub(res.diff.cred, -adj.cred), deb: sub(res.diff.deb, -adj.deb) };
      res.timingOk = (kind !== 'all' || res.diff.close !== null) && keys.every(k => z(res.adj[k]));
    }
    if (!res.ok && res.own && res.own.missing.size && !res.own.maybe.length && !res.amounts.length && res.diff.cred !== null && (kind === 'all' || kind === 'own')) {
      const inS = r2([...res.own.missing].filter(x => x.amount > 0).reduce((s, x) => s + x.amount, 0));
      const outS = r2(-[...res.own.missing].filter(x => x.amount < 0).reduce((s, x) => s + x.amount, 0));
      // пояснені різниці (ЗП через транзит, дати проведення, LiqPay, повернення, броніки, 1.5 %) — не розбіжність: якщо без них лишаються
      // лише відсутні перекази, рахунок після їх внесення зійдеться з поясненнями (08.11.2026)
      const D = res.adj || res.diff;
      const left = [D.cred + inS, D.deb + outS].concat(kind === 'all' ? [D.open, D.close === null ? null : D.close + inS - outS] : []);
      res.xferOnly = (kind !== 'all' || res.diff.close !== null) && left.every(v => z(v === null ? null : r2(v)));
    }
    return res;
  }

  // ---------- звірка ----------
  /* opt.cOpen — вхідний залишок CRM на from (якщо не задано — сума всіх записів рахунку до from) */
  function reconcile(bank, cf, from, to, opt) {
    const inP = x => x.date >= from && x.date <= to;
    const B = bank.rows.filter(inP), C = cf.filter(inP);
    let bOpen = null, bOpenNote = '';
    if (bank.opening !== null && bank.opening !== undefined) {
      if (bank.fileFrom && bank.fileFrom > from) bOpenNote = `файл починається з ${bank.fileFrom} — вхідний залишок на ${from} не знаю`;
      else {
        const before = r2(bank.rows.filter(x => x.date < from && (!bank.fileFrom || x.date >= bank.fileFrom)).reduce((s, x) => s + x.amount, 0));
        bOpen = r2(bank.opening + before);
        bOpenNote = before ? `вхідний залишок файлу ${bank.opening} + рух до ${from} ${before}` : 'вхідний залишок виписки';
      }
    } else bOpenNote = 'у джерелі немає вхідного залишку';
    const sumPos = a => r2(a.filter(x => x.amount > 0).reduce((s, x) => s + x.amount, 0));
    const sumNeg = a => r2(-a.filter(x => x.amount < 0).reduce((s, x) => s + x.amount, 0));
    const bCred = sumPos(B), bDeb = sumNeg(B);
    const bClose = bOpen === null ? null : r2(bOpen + bCred - bDeb);
    let fileCheck = null;
    if (bank.fileOpening != null && bank.fileClosing != null) {
      const move = r2(bank.rows.reduce((s, x) => s + x.amount, 0));
      fileCheck = { calc: r2(bank.fileOpening + move), fileClosing: bank.fileClosing, move, diff: r2(bank.fileClosing - bank.fileOpening - move) };
    }
    const cOpen = opt && opt.cOpen != null ? r2(opt.cOpen) : r2(cf.filter(x => x.date < from).reduce((s, x) => s + x.amount, 0));
    const cCred = sumPos(C), cDeb = sumNeg(C), cClose = r2(cOpen + cCred - cDeb);
    // поштучно: сума до копійки; спершу той самий день, потім ±1…±3 дні
    const bL = B.map((x, i) => ({ ...x, k: i, m: null })), cL = C.map((x, i) => ({ ...x, k: i, m: null }));
    for (const tol of [0, 1, 2, 3]) {
      for (const b of bL) {
        if (b.m) continue;
        const c = cL.find(c => !c.m && cents(c.amount) === cents(b.amount) && Math.abs(dayDiff(c.date, b.date)) === tol);
        if (c) { b.m = c; c.m = b; b.tol = tol; }
      }
    }
    const days = {};
    const D = d => days[d] || (days[d] = { bIn: 0, bOut: 0, cIn: 0, cOut: 0 });
    B.forEach(x => { if (x.amount > 0) D(x.date).bIn += x.amount; else D(x.date).bOut -= x.amount; });
    C.forEach(x => { if (x.amount > 0) D(x.date).cIn += x.amount; else D(x.date).cOut -= x.amount; });
    const dayRows = Object.keys(days).sort().map(d => { const v = days[d]; return { date: d, bIn: r2(v.bIn), cIn: r2(v.cIn), dIn: r2(v.cIn - v.bIn), bOut: r2(v.bOut), cOut: r2(v.cOut), dOut: r2(v.cOut - v.bOut) }; });
    return {
      bOpen, bOpenNote, bCred, bDeb, bClose, fileCheck, cOpen, cCred, cDeb, cClose,
      dOpen: bOpen === null ? null : r2(cOpen - bOpen), dCred: r2(cCred - bCred), dDeb: r2(cDeb - bDeb), dClose: bClose === null ? null : r2(cClose - bClose),
      matched: bL.filter(b => b.m), bOnly: bL.filter(b => !b.m), cOnly: cL.filter(c => !c.m), shifted: bL.filter(b => b.m && b.tol > 0),
      dayRows, nB: B.length, nC: C.length,
    };
  }

  /* Аркуші xlsx (як у privat_recon.js): Підсумок, По днях, Банк без кешфлоу, Кешфлоу без банку, Зіставлено */
  function reportSheets(list) {
    const sum = [['Рахунок кешфлоу', 'Рахунок банку', 'Джерело', 'Період з', 'по', 'Вхідний банк', 'Вхідний кешфлоу', 'Різниця', 'Кредит банк', 'Дохід кешфлоу', 'Різниця',
      'Дебет банк', 'Витрата кешфлоу', 'Різниця', 'Вихідний банк', 'Вихідний кешфлоу', 'Різниця', 'Операцій банк', 'Операцій кешфлоу', 'Зіставлено', 'Банк без кешфлоу', 'Кешфлоу без банку']];
    const days = [['Рахунок', 'Дата', 'Кредит банк', 'Дохід кешфлоу', 'Різниця', 'Дебет банк', 'Витрата кешфлоу', 'Різниця']];
    const bo = [['Рахунок', 'Дата', 'Час', 'Сума', 'Контрагент', 'Призначення', 'Референс']];
    const co = [['Рахунок', 'Дата', 'ID запису', 'Лід CRM', 'Тип', 'Сума', 'Коментар']];
    const mt = [['Рахунок', 'Дата банк', 'Дата кешфлоу', 'Сума', 'ID кешфлоу', 'Контрагент', 'Призначення', 'Коментар кешфлоу']];
    for (const x of list) {
      const R = x.R, n = x.cfName;
      sum.push([n, x.iban || '', x.src, x.from, x.to, R.bOpen, R.cOpen, R.dOpen, R.bCred, R.cCred, R.dCred, R.bDeb, R.cDeb, R.dDeb, R.bClose, R.cClose, R.dClose, R.nB, R.nC, R.matched.length, R.bOnly.length, R.cOnly.length]);
      R.dayRows.forEach(d => days.push([n, d.date, d.bIn, d.cIn, d.dIn, d.bOut, d.cOut, d.dOut]));
      R.bOnly.forEach(b => bo.push([n, b.date, b.time, b.amount, b.cpty, b.purpose, b.ref]));
      R.cOnly.forEach(c => co.push([n, c.date, c.id, c.lead ? 'так' : '', c.op, c.amount, c.comment]));
      R.matched.forEach(b => mt.push([n, b.date, b.m.date, b.amount, b.m.id, b.cpty, b.purpose, b.m.comment]));
    }
    return [
      { name: 'Підсумок', rows: sum, widths: [34, 30, 40, 11, 11, 14, 14, 12, 14, 14, 12, 14, 14, 12, 14, 14, 12, 9, 9, 9, 9, 9], money: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] },
      { name: 'По днях', rows: days, widths: [34, 11, 14, 14, 12, 14, 14, 12], money: [2, 3, 4, 5, 6, 7] },
      { name: 'Банк без кешфлоу', rows: bo, widths: [34, 11, 7, 13, 34, 70, 18], money: [3] },
      { name: 'Кешфлоу без банку', rows: co, widths: [34, 11, 9, 8, 14, 13, 70], money: [5] },
      { name: 'Зіставлено', rows: mt, widths: [34, 11, 11, 13, 9, 34, 60, 60], money: [3] },
    ];
  }

  return { bankAccounts, autoMatch, matchAccounts, cashflowItems, cashflowByAccount, crmBalanceAt, bankBalanceAt, bankOpeningAt, countByAmount, periodRecon, reconcile, reportSheets, bankOf, r2,
    cardTail, cardTails, nameTail, staleLocalCard, isCorp, groupItems, ownDirectory, ownKey, ownKind, ownTransfers, sameOwner, pairRows, missingRows, bankKinds, crmKind, KINDS, subsetSum, subsetExact, multiPairs, cardDate, cardTiming,
    cardDays, liqpayGroups, taxDays, payDays, refundPairs, PAY_TAX, TAX_REC, payRow, balOf, ownerOf, ownerCards, CARD_OFF, cptyMarketer, holderOf, personIn, holderCard };
}));

/* ---- core/withdrawals.js ---- */
/* =====================================================================
   Виводи з балансу менеджерів і тімлідів ↔ погодження «% менеджера / м-рів / тімліда».
   CRM: кожне підтвердження виведення у вкладці «Баланс» — окремий автоматичний запис кешфлоу:
   «Підтвердження виведення коштів з балансу менеджера|тімліда <ПІБ> від ДД.ММ.РРРР по проекту <країна> на суму N грн».
   Погодження (реєстр, дія bank): «% менеджера X», «% м-ра X, тімлід Y», «% м-рів (та) тімліда Y», «% менеджерів тімлід Y»,
   «% Тл. Y і команди»… Сума — на руки (з 05.10.2026; раніше «разом з податками»: на руки / 0,9, інколи ще + 1 грн).
   Командний рядок — це вивід тімліда і виводи його менеджерів: приклад: «Малигин 56 000» = 22 000 (тімлід) + 13 000 + 6 000 +
    6 000 + 9 000. Склад команди CRM не віддає, тож він знаходиться за сумою (набір виводів, що дає рівно суму погодження, —
   лише якщо такий набір один) і запам'ятовується для наступних тижнів. Лише звірка: нічого не створює й не змінює.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFWithdrawals = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const r2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
  const cents = x => Math.round(Number(x) * 100);
  const clean = s => String(s == null ? '' : s).replace(/[   ​]/g, ' ').replace(/\s+/g, ' ').trim();
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const TOL = 100; // копійок: «разом з податками» рахували з округленням, ±1 грн

  // ---------- імена ----------
  /* «Малигін» = «Малигин», «Соловьев» = «Соловьєв»: регістр, апостроф, і/и/ї/й, е/є/ё, г/ґ — однаково */
  const fold = s => clean(s).toLowerCase().replace(/[’ʼ'`]/g, '').replace(/[іїйиы]/g, 'и').replace(/[єёэ]/g, 'е').replace(/ґ/g, 'г');
  const words = s => fold(s).split(/[^a-zа-я]+/).filter(w => w.length >= 3);
  // відстань Дамерау — Левенштейна ≤ 1: заміна, вставка, видалення чи перестановка сусідніх («Меліксетян» / «Мелікестян»)
  function near1(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) {
      if (a.slice(i + 1) === b.slice(i + 1)) return true;
      return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
    }
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    return s.slice(i) === l.slice(i + 1);
  }
  /* те саме прізвище (вже fold): однаково; відмінок — різниця лише в закінченні з голосних (і -м, -х): «Порфирова» / «Порфиров»,
     «Копинецька» / «Копинецької», «Божко» / «Божка», але «Пархович» ≠ «Пархова»; одна помилка — від 6 літер («Рахманов» / «Рохманов») */
  const END = /^[аеиоуяюмх]{0,3}$/;
  function sameName(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    let p = 0;
    while (p < s.length && s[p] === l[p]) p++;
    if (s.length >= 5 && p >= 4 && p >= s.length - 1 && /^[аеиоуяю]?$/.test(s.slice(p)) && END.test(l.slice(p))) return true;
    return s.length >= 6 && near1(a, b);
  }
  const hasName = (ws, key) => ws.some(w => sameName(w, key));

  // ---------- записи CRM ----------
  const WD_RE = /виведення коштів з балансу\s+(менеджера|т[іи]мліда|\S+)\s+(.+?)\s+від\s+(\d{2})\.(\d{2})\.(\d{4})\s+по проекту\s+(.+?)\s+на суму/i;
  /* запис кешфлоу (рух рахунку: {id, date, amount, comment, acc, opc}) → вивід {id, date, acc, amount (>0), role: lead|manager, name, ws, prj}
     або null. Позначки «(ТЛ)», «- ТЛ» у імені прибираються. */
  function parseWithdrawal(x) {
    if (!x || (x.opc != null && Number(x.opc) !== 2)) return null;
    const m = WD_RE.exec(clean(x.comment));
    if (!m) return null;
    const name = clean(m[2].replace(/\(\s*тл\s*\)|[-–—]?\s*(?<![\p{L}])тл(?![\p{L}])/giu, ' ')).replace(/[\s\-–—]+$/, '');
    return { id: x.id, date: x.date || `${m[5]}-${m[4]}-${m[3]}`, acc: x.acc != null ? Number(x.acc) : null, amount: r2(Math.abs(Number(x.amount))),
      role: /^т[іи]мліда$/i.test(m[1]) ? 'lead' : 'manager', name, ws: words(name), prj: clean(m[6]) };
  }

  // ---------- погодження ----------
  // «% м-ра», «% менеджерів», «% тімліда», «% … за період» — % з балансу; «% РОП» реєстр вносить на всю суму — не вивід
  // «тл» — межа слова Unicode (\b без прапорця u кирилиці не знає, і «% Тл. Малигин і команди» не розпізнавалось)
  const PCT_RE = /%\s?(м-р|менедж|т[іи]млід|тл(?!\p{L})|[^\d%]{2,40}за період)|виведення коштів з балансу менеджера/iu;
  const ROP_RE = /%\s?роп(?![а-яіїєґ])/i;
  const PLURAL_RE = /м-рів|менеджерів|команд/i;
  const STOP = new Set(['за', 'та', 'і', 'и', 'з', 'по', 'команди', 'команда', 'період', 'разом']);
  /* перше слово з великої літери після ключового (у тексті як є): «тімліда Копинецька І.» → «Копинецька» */
  function nameAfter(text, kw) {
    kw.lastIndex = 0;
    let m;
    while ((m = kw.exec(text))) {
      const w = /^[\s.,:]*(?:команди\s+)?([^\s,.;:()]+)/i.exec(text.slice(m.index + m[0].length));
      if (w && /^\p{Lu}/u.test(w[1]) && !STOP.has(fold(w[1]))) return w[1];
    }
    return '';
  }
  /* ім'я після прізвища key (fold) у тексті: «% менеджера Сидорук Тарас» → «тарас», «Копинецька І.» → «и» (ініціал), «Мартиненко
     Святослав, тімлід …» → «святослав»; наступне слово з малої літери чи службове («ТЛ», «тімлід») — '' (ім'я невідоме) */
  const NOT_NAME = /^(?:т[іи]млід|тл|м-р|менедж|команд)/i;
  function nextName(text, key) {
    if (!key) return '';
    const ws = clean(text).split(/[\s,;:()]+/).filter(Boolean);
    for (let i = 0; i < ws.length; i++) {
      if (!sameName(fold(ws[i]).replace(/[^a-zа-я]/g, ''), key)) continue;
      const raw = ws[i + 1] || '', nx = raw.replace(/\.+$/, '');
      if (!nx || !/^\p{Lu}/u.test(nx) || NOT_NAME.test(nx)) return '';
      const f = fold(nx).replace(/[^a-zа-я]/g, '');
      if (f.length === 1) return /\.$/.test(raw) ? f : ''; // ініціал — лише з крапкою («І.»; «І» без крапки може бути й сполучником)
      return STOP.has(f) ? '' : f;
    }
    return '';
  }
  const LEAD_KW = /(?<![\p{L}])(?:т[іи]млід\p{L}*|тл)\.?/giu;
  const TEAM_KW = /(?<![\p{L}])команд\p{L}*/giu;
  const PERSON_KW = /(?<![\p{L}])(?:м-ра|менеджера|менеджер|т[іи]мліда)(?![\p{L}])/giu;
  /* рядок реєстру (regCompact_: {key, date, recipient, content, textAmount, acc, id, action, status, share, tax, bank}) → погодження
     {key, date, recipient, content, amount, targets (копійки: на руки; «разом з податками» — ще × 0,9 і (− 1) × 0,9), team, person,
     lead, pfirst / lfirst (ім'я людини / тімліда, якщо є в тексті чи отримувачі: «Сидорук Тарас» — не вивід «Сидорук Інесси»), acc, id,
     entered (реєстр уже вніс рядок на всю суму)} або null (не % з балансу) */
  function parseApproval(r) {
    if (!r || r.tax || r.bank) return null;
    const text = clean(r.content), rec = clean(r.recipient);
    if (!PCT_RE.test(text) || ROP_RE.test(text)) return null;
    const a = Number(r.textAmount != null ? r.textAmount : r.amount);
    if (!(a > 0)) return null;
    const gross = /разом з податками/i.test(text);
    const targets = gross ? [cents(a), cents(a * 0.9), cents((a - 1) * 0.9)] : [cents(a)];
    const team = PLURAL_RE.test(text);
    const lead = nameAfter(text, LEAD_KW) || nameAfter(text, TEAM_KW);
    const person = team ? '' : nameAfter(text, PERSON_KW);
    const recKey = words(rec)[0] || '';
    const pk = fold(person).replace(/[^a-zа-я]/g, '') || (!team ? recKey : ''), lk = fold(lead).replace(/[^a-zа-я]/g, '') || (team ? recKey : '');
    // допуск ±1 грн — лише «разом з податками» (там рахували з округленням); на руки — до копійки: 9 999,01 за погодження 10 000 — розбіжність
    return { key: r.key, date: r.date, recipient: rec, content: text, amount: r2(a), gross, targets, tol: gross ? TOL : 0, team, person: pk, lead: lk,
      pfirst: nextName(text, pk) || nextName(rec, pk), lfirst: nextName(text, lk) || nextName(rec, lk),
      recKey, acc: r.acc != null ? Number(r.acc) : null, id: Number(r.id) || 0, entered: !!(Number(r.id) && !r.share) };
  }

  // ---------- набір виводів на суму ----------
  /* Набори items (у кожного c — копійки), сума яких дорівнює будь-якій із targets (± tol копійок; без tol — ± TOL). Пошук із відсіканням;
     рахується до cap наборів (2 — щоб побачити неоднозначність). → {count, sol: [items], over: true — забагато варіантів} */
  function subsets(items, targets, cap, maxNodes, tol) {
    cap = cap || 2; maxNodes = maxNodes || 400000; tol = tol == null ? TOL : tol;
    const xs = items.slice().sort((p, q) => q.c - p.c), n = xs.length, suf = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) suf[i] = suf[i + 1] + xs[i].c;
    const lo = Math.min(...targets) - tol, hi = Math.max(...targets) + tol, hit = s => targets.some(t => Math.abs(s - t) <= tol);
    let count = 0, sol = null, nodes = 0, over = false;
    const pick = [];
    (function dfs(i, s) {
      if (count >= cap || over) return;
      if (++nodes > maxNodes) { over = true; return; }
      if (hit(s)) { count++; if (!sol) sol = pick.slice(); return; }
      if (i >= n || s > hi || s + suf[i] < lo) return;
      pick.push(xs[i]);
      dfs(i + 1, s + xs[i].c);
      pick.pop();
      dfs(i + 1, s);
    }(0, 0));
    return { count, sol: sol || [], over };
  }

  /* Зіставлення. approvals — parseApproval (з report: true — показувати; false — лише щоб не вважати їхні виводи «без погодження»);
     withdrawals — parseWithdrawal; opts.teams — {тімлід (fold): [прізвища менеджерів]} з минулих звірок; opts.before / after — вікно
     дат виводу відносно дати погодження (дні, за замовчуванням 3 / 10). Спершу — найближчі дні (від дня до погодження до 3 днів
     після: зазвичай виводять того ж чи наступного дня), потім усе вікно: у місяці кілька тижневих наборів виводів тих самих людей.
     У кожному вікні: людина (вивід цієї людини на ту саму суму, до 4 частин) → команда за запам'ятаним складом → команда за сумою
     (лише однозначний набір; спершу рядки, де є вивід самого тімліда, і той самий рахунок, що в нього; поки щось знаходиться) → ще
     раз, дозволивши вивід іншого тімліда (у погодженні отримувач — не тімлід, а той, через кого платять).
     Людина — за прізвищем, а якщо в погодженні є ім'я (pfirst / lfirst) — і за ним: «Сидорук Тарас» не бере вивід «Сидорук Інесси».
     opts.today (рррр-мм-дд): погодження без виводу, якому щонайбільше opts.wait днів (3), — «wait» (вивід ще можуть зробити), не «none».
     → {rows: [{a, status: ok|diff|ambig|none|wait, how: person|learned|team, items, sum, cands}], extra: [виводи без погодження], teams} */
  function match(approvals, withdrawals, opts) {
    opts = opts || {};
    const before = opts.before == null ? 3 : opts.before, after = opts.after == null ? 10 : opts.after;
    const waitFrom = opts.today ? addDays(opts.today, -(opts.wait == null ? 3 : opts.wait)) : null;
    /* ім'я з погодження: решта слів виводу (крім прізвища) мають його містити; ініціал — перша літера; у виводі лише прізвище — гаразд.
       Ім'я порівнюється м'яко — лише щоб не сплутати різних людей з одним прізвищем: «Даниїл» = «Данил», «Микита» = «Никита» */
    const sameFirst = (x, f) => (f.length === 1 ? x[0] === f : x.slice(0, 4) === f.slice(0, 4) || sameName(x, f) || (Math.min(x.length, f.length) >= 4 && near1(x, f)));
    const firstOk = (w, key, first) => {
      if (!first) return true;
      const rest = w.ws.filter(x => !sameName(x, key));
      return !rest.length || rest.some(x => sameFirst(x, first));
    };
    const isWho = (w, key, first) => hasName(w.ws, key) && firstOk(w, key, first);
    const W = (withdrawals || []).map(w => ({ ...w, c: cents(w.amount) })).sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
    const used = new Set(), learned = {};
    Object.entries(opts.teams || {}).forEach(([k, v]) => { learned[k] = (v || []).slice(); });
    const rows = (approvals || []).map(a => ({ a, status: null, how: null, items: [], sum: 0, cands: [], ambig: false }))
      .sort((p, q) => (p.a.date < q.a.date ? -1 : p.a.date > q.a.date ? 1 : 0));
    const take = (row, items, how) => {
      items.forEach(w => used.add(w));
      Object.assign(row, { status: 'ok', how, items: items.slice().sort((p, q) => q.c - p.c), sum: r2(items.reduce((s, w) => s + w.amount, 0)) });
    };
    const leadOf = row => row.a.lead || row.a.person, leadFirst = row => (row.a.lead ? row.a.lfirst : row.a.pfirst);
    const tolOf = row => (row.a.tol != null ? row.a.tol : row.a.gross ? TOL : 0);
    // виводи тімліда — найближчого дня у вікні (ws — за датою): у ширшому вікні є й вивід наступного тижня
    const leadW = (row, ws) => { const t = ws.filter(w => w.role === 'lead' && isWho(w, leadOf(row), leadFirst(row))); return t.filter(w => w.date === (t[0] || {}).date); };
    // командний рядок: вивід тімліда + виводи менеджерів; рядок «% менеджера» тімліда (за отримувачем) — теж може бути командним
    const isTeam = row => row.a.team || leadW(row, W).length > 0;
    let win = null;
    for (const [b, f] of [[Math.min(1, before), Math.min(3, after)], [before, after]]) {
      win = a => W.filter(w => !used.has(w) && w.date >= addDays(a.date, -b) && w.date <= addDays(a.date, f));
      // 1) людина: її виводи на ту саму суму (один чи кілька, до 4)
      for (const row of rows) {
        const key = row.a.person || row.a.lead, first = row.a.person ? row.a.pfirst : row.a.lfirst;
        if (row.status || !key) continue;
        const own = win(row.a).filter(w => isWho(w, key, first));
        if (!own.length) continue;
        const s = subsets(own.slice(0, 12), row.a.targets, 2, 0, tolOf(row));
        if (s.count === 1 && s.sol.length <= 4) take(row, s.sol, 'person');
        else if (s.count > 1) take(row, s.sol.slice().sort((p, q) => p.date < q.date ? -1 : 1), 'person'); // однакові виводи — бере будь-який
      }
      // 2) команда за запам'ятаним складом
      for (const row of rows) {
        if (row.status || !isTeam(row)) continue;
        const lk = leadOf(row), mem = lk && learned[lk];
        if (!mem || !mem.length) continue;
        const ws = win(row.a), tl = leadW(row, ws), ms = ws.filter(w => w.role === 'manager' && mem.some(k => hasName(w.ws, k)));
        const s = subsets(ms, row.a.targets.map(t => t - tl.reduce((x, w) => x + w.c, 0)), 2, 0, tolOf(row));
        if (s.count === 1) take(row, tl.concat(s.sol), 'learned');
      }
      // 3) команда за сумою: однозначний набір; повторювати, поки знаходиться (кожен знайдений звужує вибір для інших).
      // Рядок, де вивід тімліда є, — першим: набір, що випадково дає суму рядка без виводів, не забере чужих менеджерів
      for (const others of [false, true]) {
        for (const needTl of [true, false]) {
          for (let found = true; found;) {
            found = false;
            for (const row of rows) {
              if (row.status || !isTeam(row)) continue;
              const ws = win(row.a), tl = leadW(row, ws), base = tl.reduce((x, w) => x + w.c, 0);
              if (needTl && !tl.length) continue;
              const pool = ws.filter(w => !tl.includes(w) && (w.role === 'manager' || others));
              const tg = row.a.targets.map(t => t - base);
              const acc = tl.length ? tl[0].acc : row.a.acc;
              let s = acc != null ? subsets(pool.filter(w => w.acc === acc), tg, 2, 0, tolOf(row)) : { count: 0, sol: [] };
              if (s.count === 0) s = subsets(pool, tg, 2, 0, tolOf(row));
              if (s.count === 1 && !s.over) { take(row, tl.concat(s.sol), 'team'); found = true; }
              else if (s.count > 1 || s.over) row.ambig = true;
            }
          }
        }
      }
    }
    // 4) решта: що є в цієї людини / тімліда (не забирається), інакше «виводу немає» / «кілька варіантів»
    for (const row of rows) {
      if (row.status) continue;
      const key = leadOf(row), ws = win(row.a);
      row.cands = key ? ws.filter(w => isWho(w, key, leadFirst(row))) : [];
      row.sum = r2(row.cands.reduce((s, w) => s + w.amount, 0));
      row.status = row.ambig ? 'ambig' : row.cands.length ? 'diff' : 'none';
      // виводу немає, але реєстр уніс погодження на всю суму — витрата в кешфлоу є, лише не через «Баланс»
      if (row.status === 'none' && row.a.entered) Object.assign(row, { status: 'ok', how: 'registry' });
      // свіже погодження: вивід зазвичай роблять того ж чи наступного дня — ще чекаємо
      else if (row.status === 'none' && waitFrom && row.a.date >= waitFrom) row.status = 'wait';
    }
    // склад команд — на наступні звірки (лише однозначно знайдені за сумою чи підтверджені)
    for (const row of rows) {
      if (row.status !== 'ok' || (row.how !== 'team' && row.how !== 'learned')) continue;
      const lk = leadOf(row), ms = row.items.filter(w => w.role === 'manager').map(w => w.ws[0]).filter(Boolean);
      if (lk && ms.length) learned[lk] = [...new Set(ms)];
    }
    const shown = new Set(rows.flatMap(r => r.cands));
    // free — усі незабрані виводи (summary покаже й ті, що схожі на погодження поза періодом)
    return { rows, extra: W.filter(w => !used.has(w) && !shown.has(w)), free: W.filter(w => !used.has(w)), teams: learned };
  }

  /* Підсумок для розділу, «Закриття місяця» й лічильника: погодження з a.report !== false; виводи за період без погодження —
     незабрані й не показані біля погодження періоду (near — погодження поза періодом, на яке вивід схожий, або null).
     wait — свіжі погодження без виводу (не розбіжність: не в none і не в лічильнику; у bad — щоб їх було видно в списку). */
  function summary(res, from, to) {
    const rep = res.rows.filter(r => r.a.report !== false), seen = new Set(rep.flatMap(r => r.cands));
    const ex = (res.free || res.extra).filter(w => !seen.has(w) && (!from || w.date >= from) && (!to || w.date <= to))
      .map(w => ({ w, near: res.rows.find(r => r.cands.includes(w)) || null }));
    const by = st => rep.filter(r => r.status === st);
    return { n: rep.length, ok: by('ok').length, diff: by('diff').length, none: by('none').length, ambig: by('ambig').length, wait: by('wait').length, extra: ex.length,
      approved: r2(rep.reduce((s, r) => s + r.a.amount, 0)), withdrawn: r2(rep.reduce((s, r) => s + (r.status === 'ok' ? r.sum : 0), 0)),
      bad: rep.filter(r => r.status !== 'ok'), extraList: ex, double: rep.filter(r => r.status === 'ok' && r.a.entered && r.how !== 'registry') };
  }

  return { parseWithdrawal, parseApproval, match, summary, subsets, sameName, fold, words };
}));

/* ---- core/matching.js ---- */
/* =====================================================================
   «Зіставлення ШІ» у «Звірці з банком» (05.11.2026): операції банку за період ↔ погодження реєстру ↔ записи CRM.
   Спершу без ШІ — за сумою, датою й рахунком:
     • ЗП одним переказом на транзитний рахунок («пакет» Привату на N карток) — погодження на руки N людей, що разом дають суму
       пакета до копійки; одна людина може отримати кілька погоджень на одну картку (приклад: пакет на 3 картки —
       двоє людей мають по два погодження, третя людина — одне). Спершу той самий рахунок, потім інші рахунки тієї самої
       фірми (погодження «з 8112», а заплатили пакетом з 8296); спершу рівно N людей, потім менше (тімлід-отримувач погодження
       за кількох людей). Лише якщо такий набір один (кілька — «неоднозначно»: вирішує ШІ чи людина);
     • ЗП за день разом (16.11.2026): усі пакети рахунку за день = усі вільні погодження цього дня до копійки (з «% менеджера» через
       зарплатний проєкт) — пакети беруть їх без поділу по людях; кілька пакетів — кожен свій набір, якщо поділ один;
     • інша витрата — одне погодження з тією самою сумою (спершу той самий рахунок і найближча дата);
     • податки із ЗП (ПДФО, ВЗ, ЄСВ одного дня й місяця) — група з підсумком: у CRM їх розносять по людях.
   Що лишилось, — ШІ через «Помічник кешфлоу» (aiPayload → Claude → aiApply): лише підказки, нічого не змінюється.
   Чисті функції; показ — ui/bank-panel.js.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFMatch = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const cents = v => Math.round(Number(v) * 100);
  const r2 = v => Math.round(Number(v) * 100) / 100;
  const dayDiff = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 864e5);

  /* Набори рівно з k елементів items ({c — копійки}) із сумою target (копійки); без k — найменший розмір від 1 до maxK.
     Рахується до cap наборів (2 — щоб побачити неоднозначність). → {count, sol, size, over — забагато варіантів, не дорахував} */
  function packs(items, target, k, o) {
    o = o || {};
    const cap = o.cap || 2, maxNodes = o.maxNodes || 200000, maxK = o.maxK || 8;
    const xs = (items || []).filter(x => x.c > 0 && x.c <= target).sort((p, q) => q.c - p.c), n = xs.length, pre = [0];
    xs.forEach((x, i) => { pre[i + 1] = pre[i] + x.c; });
    let nodes = 0, over = false;
    for (const size of k ? [k] : Array.from({ length: maxK }, (_, i) => i + 1)) {
      if (size > n) break;
      let count = 0, sol = null;
      const pick = [];
      (function dfs(i, s) {
        if (count >= cap || over) return;
        if (++nodes > maxNodes) { over = true; return; }
        const left = size - pick.length;
        if (!left) { if (s === target) { count++; if (!sol) sol = pick.map(j => xs[j]); } return; }
        for (let j = i; j <= n - left; j++) {
          if (s + pre[j + left] - pre[j] < target) break; // навіть найбільші з решти не дотягують (далі — лише менші)
          const s2 = s + xs[j].c;
          if (left > 1 && s2 + pre[n] - pre[n - left + 1] > target) continue; // навіть з найменшими рештою — забагато
          pick.push(j);
          dfs(j + 1, s2);
          pick.pop();
          if (count >= cap || over) return;
        }
      }(0, 0));
      if (count || over) return { count, sol: sol || [], size, over };
    }
    return { count: 0, sol: [], size: 0, over };
  }

  /* Хто отримує погодження: слова імені (від 3 літер, без регістру й апострофів). Погодження однієї людини — одна група: однакові
     слова чи одне ім'я містить усі слова іншого («Хоменко» = «Хоменко Всеволод»); спільне слово має бути від 4 літер, а якщо
     підходить кілька груп («Андрій» → «Андрій Полуботко» і «Андрій Балух») — окрема група. Без отримувача — кожне окремо. */
  const whoWords = s => String(s || '').toLowerCase().replace(/[’ʼ`']/g, '').split(/[^\p{L}]+/u).filter(w => w.length >= 3);
  /* Чи названо когось з names (отримувач погодження, контрагент банку) у тексті text (18.11.2026): спільне слово від 4 літер — однакове
     чи з тим самим початком без відмінкового закінчення («Гурський» = «Гурського»); латинська «i» в кириличних словах виписки — «і».
     → скільки слів збіглося (0 — нікого) */
  const nameWords = s => whoWords(String(s || '').replace(/i/g, 'і').replace(/I/g, 'І')).filter(w => w.length >= 4);
  function nameHits(names, text) {
    const a = [...new Set(nameWords(names))], b = [...new Set(nameWords(text))];
    const same = (x, y) => { if (x === y) return true; const n = Math.max(4, Math.min(x.length, y.length) - 2); return x.slice(0, n) === y.slice(0, n) && Math.abs(x.length - y.length) <= 3; };
    return a.filter(x => b.some(y => same(x, y))).length;
  }
  function people(items) {
    const gs = [];
    // спершу повні імена, потім короткі: інакше «Андрій», що трапився раніше за «Андрій Балух», приєднувався до єдиного вже
    // знайденого «Андрій Полуботко», і чи пакет однозначний, залежало від порядку рядків реєстру
    const order = (items || []).map((it, i) => ({ it, i, n: whoWords(it.a && it.a.recipient).length })).sort((p, q) => q.n - p.n || p.i - q.i);
    for (const { it } of order) {
      const w = new Set(whoWords(it.a && it.a.recipient));
      const sub = (x, y) => [...x].every(v => y.has(v)) && [...x].some(v => v.length >= 4);
      const hit = w.size ? gs.filter(g => g.w.size && (sub(w, g.w) || sub(g.w, w))) : [];
      if (hit.length === 1) { hit[0].list.push(it); if (w.size > hit[0].w.size) hit[0].w = w; }
      else gs.push({ w, list: [it] });
    }
    return gs;
  }
  /* Пакет ЗП на cards карток: набір людей (people), від кожної — одне чи кілька її погоджень, сума — target (копійки).
     exact: рівно cards людей; інакше — менше людей, але погоджень щонайменше cards (тімлід отримує погодження за свою команду).
     Варіанти однієї людини з тими самими сумами погоджень (одна з трьох премій по 13 500) — один варіант: для пакета байдуже, котре
     з однакових; а 100 + 400 і 200 + 300 — різні (у тімліда це різні люди команди) → «неоднозначно».
     → {count (до cap), sol: [item], over — забагато варіантів, не дорахував} */
  function packPeople(items, target, cards, o) {
    o = o || {};
    const cap = o.cap || 2, maxNodes = o.maxNodes || 300000, exact = o.exact !== false, maxSub = o.maxSub || 12;
    if (!(cards > 0) || !(target > 0)) return { count: 0, sol: [], over: false };
    /* в однієї людини погоджень більше, ніж перебирається (maxSub): решту раніше мовчки відкидали (8 — а «Терещенко» 05.11.2026 мав 9, з
       13.11 — 12), тож набір з дев'ятим погодженням не знаходився, а знайдений міг бути не єдиним. Тепер це «не дорахував» (over, big) —
       16.11.2026 */
    let big = false;
    const gs = people((items || []).filter(x => x.c > 0 && x.c <= target)).map(g => {
      if (g.list.length > maxSub) big = true;
      const xs = g.list.slice(0, maxSub), seen = new Map();
      for (let mask = 1; mask < 1 << xs.length; mask++) {
        let c = 0;
        const list = [];
        xs.forEach((x, i) => { if (mask & (1 << i)) { c += x.c; list.push(x); } });
        const k = list.map(x => x.c).sort((p, q) => p - q).join(',');
        if (c <= target && !seen.has(k)) seen.set(k, { c, list });
      }
      const opts = [...seen.values()].sort((p, q) => q.c - p.c);
      return { opts, max: opts.length ? opts[0].c : 0 };
    }).filter(g => g.opts.length).sort((p, q) => q.max - p.max);
    const n = gs.length, maxG = exact ? cards : cards - 1;
    if (!maxG || n < (exact ? cards : 1)) return { count: 0, sol: [], over: big, big };
    const pre = [0];
    gs.forEach((g, i) => { pre[i + 1] = pre[i] + g.max; });
    const best = (j, k) => pre[Math.min(n, j + k)] - pre[j]; // найбільше, що дадуть k людей, починаючи з j-ї (групи — за спаданням max)
    let nodes = 0, over = false, count = 0, sol = null;
    const pick = [];
    (function dfs(i, s, g, nAp) {
      if (count >= cap || over) return;
      if (++nodes > maxNodes) { over = true; return; }
      if (s === target) {
        if (exact ? g === cards : nAp >= cards) { count++; if (!sol) sol = pick.flatMap(p => p.list); }
        return;
      }
      if (g === maxG || (exact && n - i < cards - g)) return;
      for (let j = i; j < n; j++) {
        if (s + best(j, maxG - g) < target) break; // навіть найбільші з решти не дотягують
        if (exact && n - j < cards - g) break;
        for (const op of gs[j].opts) {
          if (s + op.c > target) continue;
          pick.push(op);
          dfs(j + 1, s + op.c, g + 1, nAp + op.list.length);
          pick.pop();
          if (count >= cap || over) return;
        }
      }
    }(0, 0, 0, 0));
    return { count, sol: sol || [], over: over || big, big };
  }
  /* Набори будь-якого розміру з items ({c — копійки}) на суму target; погодження з однаковою сумою взаємозамінні (один набір, а не
     кілька). Для поділу погоджень дня між пакетами того самого дня (dayTotal). → {count (до cap), sol, over} */
  function sums(items, target, o) {
    o = o || {};
    const cap = o.cap || 2, maxNodes = o.maxNodes || 300000;
    const xs = (items || []).filter(x => x.c > 0 && x.c <= target).sort((p, q) => q.c - p.c), n = xs.length, suf = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) suf[i] = suf[i + 1] + xs[i].c;
    let nodes = 0, over = false, count = 0, sol = null;
    const pick = [];
    (function dfs(i, s) {
      if (count >= cap || over) return;
      if (++nodes > maxNodes) { over = true; return; }
      if (s === target) { count++; if (!sol) sol = pick.slice(); return; }
      if (s + suf[i] < target) return;
      for (let j = i; j < n; j++) {
        if ((j > i && xs[j].c === xs[j - 1].c) || s + xs[j].c > target) continue;
        pick.push(xs[j]);
        dfs(j + 1, s + xs[j].c);
        pick.pop();
        if (count >= cap || over) return;
      }
    }(0, 0));
    return { count, sol: sol || [], over };
  }

  // податки із ЗП: місяць у призначенні («за жовтень 2026», «за 10 2026»)
  const MONTH = /за\s+(\p{L}+\s+\d{4}|\d{1,2}[.\s]+\d{4})/iu;
  /* Податки із ЗП (kind 'tax') — групи «рахунок | день | місяць у призначенні» з підсумком. → [{acc, date, month, items, total}] */
  function taxGroups(list) {
    const m = new Map();
    for (const b of list || []) {
      const month = ((MONTH.exec(b.text || '') || [])[1] || '').toLowerCase();
      const k = `${b.acc}|${b.date}|${month}`;
      if (!m.has(k)) m.set(k, { acc: b.acc, date: b.date, month, items: [], total: 0 });
      const g = m.get(k);
      g.items.push(b);
      g.total = r2(g.total + b.amount);
    }
    return [...m.values()];
  }

  /* bank — списання періоду [{id, acc, owner (фірма рахунку), date, amount (> 0), kind: 'pay' (ЗП на транзит) | 'tax' (податки із ЗП) |
     'exp', cards (карток у пакеті, 0 — невідомо), crm — пара в CRM чи null}]; ap — погодження реєстру [{key, acc, owner, date (оплати),
     amount (> 0, на руки), recipient, text, crmId (ID запису, якщо реєстр уже вніс), action}]. o — {back: днів погодження до оплати (7),
     ahead: після (1), payBack: для пакета ЗП (12)}.
     Погодження може мати zp (оплата через зарплатний проєкт) і pct («% менеджера» — на руки; лише для пакетів ЗП, не 1:1, і не
     серед free.ap: сам вивід — у «Виводах з балансу»).
     off — реєстр погодження не вносить («Вносити» = «ні»): лише пара з операцією свого рахунку, де названо отримувача (рядок off: true),
     серед free.ap таких немає.
     → {rows: [{bank, ap: [...], how: 'пакет' | '1:1', other: погодження з іншого рахунку, day: пакет зібрано «за день разом», off}],
        amb: [{bank, count, over, big: в однієї людини забагато погоджень, short: {have, miss} — погоджень дня менше, ніж у пакетах,
        none: погоджень дня немає}] — пакети без однозначного набору, taxes: групи податків,
        free: {bank: без погодження (крім податків), ap: погодження без операції}} */
  function match(bank, ap, o) {
    o = o || {};
    const back = o.back == null ? 7 : o.back, ahead = o.ahead == null ? 1 : o.ahead, payBack = o.payBack == null ? 12 : o.payBack;
    const used = new Set(), rows = [], amb = [];
    /* off — погодження, яке реєстр не вносить («Вносити» = «ні»: повернення коштів клієнтам тощо; 18.11.2026): у пакетах ЗП, «за день»
       і звичайних 1:1 участі не бере (A — без них) — лише окремий прохід нижче: той самий рахунок, сума, вікно й отримувач у виписці */
    const B = bank || [], A = (ap || []).filter(a => !a.off), OFF = (ap || []).filter(a => a.off);
    const inWin = (b, a) => dayDiff(b.date, a.date) >= -ahead && dayDiff(b.date, a.date) <= payBack;
    const done = new Map(), fail = new Map(); // пакет → пара; пакет → чому не розклався ({count, over, big, wide})
    const sumC = l => l.reduce((s, a) => s + cents(a.amount), 0);
    const take = (b, list, extra) => {
      list.forEach(a => used.add(a.key));
      const m = { bank: b, ap: list, how: 'пакет', other: list.some(a => a.acc !== b.acc), ...extra };
      rows.push(m); done.set(b, m); fail.delete(b);
    };
    /* Вільні погодження дня пакета: з того самого рахунку; якщо за ними не сходиться — зарплатного проєкту (zp: «зп ПРИКЛАД», «зп Маркет»)
       тієї самої фірми з будь-якого її рахунку (погодження «зп Маркет» записано на 8112, а пакет пішов з 8296). */
    /* Перший прохід «за день» (до 1:1) не бере погодження, для якого у виписці є своя звичайна операція з цією сумою: інакше дві
       оплати дня (оренда 30 000 + реклама 50 000) «склали» б пакет ЗП 80 000 без погоджень, а самі лишились би «без погодження» —
       і їх унесли б удруге (огляд 16.11.2026). Другий прохід (після 1:1) бачить лише те, що лишилось. */
    const has1 = a => B.some(x => x.kind === 'exp' && !done.has(x) && cents(x.amount) === cents(a.amount) && inWin(x, a));
    const dayPools = (b, first) => {
      const d = A.filter(a => !used.has(a.key) && a.date === b.date && (!first || a.pct || !has1(a)));
      return [d.filter(a => a.acc === b.acc), b.owner ? d.filter(a => a.zp && a.owner === b.owner) : []];
    };
    /* ЗП за день разом (16.11.2026): усі пакети рахунку за день = усі вільні погодження цього дня, до копійки. Погодження — рядками
       «кому погоджено», а не «на чию картку»: 05.11.2026 з ПРИКЛАД пішло два пакети (4 і 8 карток) за 25 погодженнями —
       отримувач-тімлід за команду, порожній отримувач («на картку Мефодієва як ЗП»), «% менеджерів» через зарплатний проєкт — і по
       людях (packPeople) таке не збирається. Один пакет бере всі погодження дня; кілька — кожен свій набір, якщо поділ один
       (від найменшого пакета; однакові суми взаємозамінні). Поділ не один чи суми дня не рівні — далі по людях (pack). */
    const dayTotal = first => {
      const groups = new Map();
      for (const b of B) if (b.kind === 'pay' && !done.has(b)) { const k = `${b.acc}|${b.date}`; groups.set(k, (groups.get(k) || []).concat(b)); }
      for (const G of groups.values()) {
        const total = sumC(G);
        for (const pool of dayPools(G[0], first)) {
          if (!pool.length || sumC(pool) !== total) continue;
          let rest = pool.map(a => ({ a, c: cents(a.amount) }));
          const left = G.slice().sort((p, q) => p.amount - q.amount), plan = [];
          while (left.length > 1) {
            const r = sums(rest, cents(left[0].amount), { maxNodes: o.maxNodes });
            if (r.count !== 1 || r.over) break;
            const s = new Set(r.sol);
            plan.push([left.shift(), r.sol]);
            rest = rest.filter(x => !s.has(x));
          }
          if (left.length === 1) { plan.push([left[0], rest]); plan.forEach(([b, l]) => take(b, l.map(x => x.a), { day: true })); }
          break;
        }
      }
    };
    /* Пакет з відомою кількістю карток — по людях (packPeople): той самий рахунок, потім рахунки тієї самої фірми; у кожному — спершу
       рівно cards людей, потім менше. Перший крок, де щось знайшлося, і вирішує: один набір — пара, кілька — «неоднозначно».
       Карток не видно — як було: найменший набір погоджень того самого рахунку (packs).
       Спершу — лише погодження дня пакета, і лише коли з них набору немає — за все вікно (16.11.2026): із давнішими погодженнями,
       які лишились вільними, пакет 11.11.2026 (44 000, одна картка) «знаходив» погодження іншої людини від 05.11, а пакет 13.11
       (169 400) — понад 50 випадкових наборів замість «за день бракує 26 400». */
    const tryPools = (b, free) => {
      const target = cents(b.amount), pools = [free.filter(a => a.acc === b.acc)];
      if (b.cards > 0 && b.owner) pools.push(free.filter(a => a.acc !== b.acc && a.owner === b.owner).concat(pools[0]));
      let r = { count: 0, sol: [], over: false };
      for (const pool of pools) {
        const items = pool.map(a => ({ a, c: cents(a.amount) }));
        for (const exact of b.cards > 0 ? [true, false] : [null]) {
          r = exact === null ? packs(items, target, 0, { maxNodes: o.maxNodes }) : packPeople(items, target, b.cards, { exact, maxNodes: o.maxNodes });
          if (r.count || r.over) break;
        }
        if (r.count || r.over) break;
      }
      return r;
    };
    const pack = b => {
      if (done.has(b)) return;
      const free = A.filter(a => !used.has(a.key) && inWin(b, a));
      let r = tryPools(b, free.filter(a => a.date === b.date)), wide = false;
      if (!r.count && !r.over) { r = tryPools(b, free); wide = true; }
      // пошук обірвався (over) — знайдений набір може бути не єдиним: «неоднозначно», а не пара (інакше операцію блоковано б
      // погодженнями інших людей, а погодження справжніх отримувачів лишились би вільними — і їх унесли б удруге)
      if (r.count === 1 && !r.over) take(b, r.sol.map(x => x.a));
      else fail.set(b, { count: r.count, over: r.over, big: !!r.big, wide });
    };
    const big = list => list.slice().sort((p, q) => q.amount - p.amount);
    // 0) ЗП за день разом; 1) пакети ЗП з відомою кількістю карток — найсильніша умова; 2) інші витрати — 1:1; 2а) ще раз «за день»
    // (1:1 забрало з рахунку звичайні оплати того дня — лишились погодження ЗП); 3) пакети, де карток не видно
    dayTotal(true);
    big(B.filter(b => b.kind === 'pay' && b.cards > 0)).forEach(pack);
    /* 1:1 — двома проходами: спершу всі операції з погодженнями свого рахунку, потім решта — з іншими рахунками (спершу тієї самої
       фірми, далі найближча дата). Одним проходом операція іншої фірми з тією самою сумою, що трапилась раніше, забирала погодження,
       чия пара на своєму рахунку теж є у виписці. */
    const exps = big(B.filter(x => x.kind === 'exp')), got1 = new Set();
    /* Запис CRM, з яким звірено операцію (crmIds — пара чи група «суми не 1:1»), — від погодження з тим самим ID: таке погодження
       береться першим, а погодження, чий запис звірено з іншою операцією, — останнім. Інакше дві однакові суми хрестились: внесене
       погодження діставалось чужій операції, а невнесене — операції, що вже є в CRM (08.11.2026). */
    const crmBank = new Map();
    for (const b of B) for (const id of crmIdsOf(b)) crmBank.set(id, b);
    const rank = (b, a) => (!a.crmId ? 1 : crmIdsOf(b).includes(a.crmId) ? 0 : crmBank.has(a.crmId) ? 2 : 1);
    /* Спершу — погодження, яких реєстр не вносить (off), з операцією свого рахунку: та сама сума, вікно й отримувач погодження названий у
       контрагенті чи призначенні (12.11.2026: «Гурський Олександр Олексійович — повернення коштів», 6 000,00 з «ФОП Хоменко приват»).
       Без цього операцію забирало погодження іншої людини з іншого рахунку з тією самою сумою, і «Внести в CRM» відсилало в «Погодження»,
       де такого рядка немає. Пара позначена off: вносити — у «Внести в CRM». Кілька — більше слів імені, далі найближча дата. */
    const bankWho = b => `${b.cpty || ''} ${b.text || ''}`;
    for (const b of exps) {
      const c = cents(b.amount);
      const cand = OFF.map(a => ({ a, n: used.has(a.key) || cents(a.amount) !== c || a.acc !== b.acc || dayDiff(b.date, a.date) < -ahead || dayDiff(b.date, a.date) > back ? 0 : nameHits(a.recipient, bankWho(b)) }))
        .filter(x => x.n > 0).sort((p, q) => q.n - p.n || Math.abs(dayDiff(b.date, p.a.date)) - Math.abs(dayDiff(b.date, q.a.date)));
      if (!cand.length) continue;
      used.add(cand[0].a.key);
      got1.add(b);
      rows.push({ bank: b, ap: [cand[0].a], how: '1:1', other: false, off: true });
    }
    /* Інший рахунок (другий прохід): сама сума — не пара, якщо отримувач погодження й контрагент банку — явно різні люди чи фірми:
       в обох є ім'я, і ні отримувача немає в контрагенті й призначенні, ні контрагента — в отримувачі й змісті погодження (18.11.2026:
       «Дмитро Кобзар», вивід з «ФОП Мазовецька», і повернення Гурському з «ФОП Хоменко» — обидва по 6 000,00). Таку операцію лишаємо
       без пари — вирішить ШІ чи людина. Свій рахунок (перший прохід) — як було: рахунок, сума й вікно. */
    const strangers = (b, a) => nameWords(a.recipient).length > 0 && nameWords(b.cpty).length > 0 && !nameHits(a.recipient, bankWho(b)) && !nameHits(b.cpty, `${a.recipient || ''} ${a.text || ''}`);
    for (const own of [true, false]) {
      for (const b of exps) {
        if (got1.has(b)) continue;
        const c = cents(b.amount);
        const cand = A.filter(a => {
          // «% менеджера» (pct) — лише в пакетах ЗП: сам вивід з балансу звіряють «Виводи з балансу»
          if (used.has(a.key) || a.pct || cents(a.amount) !== c || (a.acc === b.acc) !== own || (!own && strangers(b, a))) return false;
          const d = dayDiff(b.date, a.date);
          return d >= -ahead && d <= back;
        }).sort((p, q) => rank(b, p) - rank(b, q) || (b.owner && p.owner === b.owner ? 0 : 1) - (b.owner && q.owner === b.owner ? 0 : 1)
          || Math.abs(dayDiff(b.date, p.date)) - Math.abs(dayDiff(b.date, q.date)));
        if (!cand.length) continue;
        used.add(cand[0].key);
        got1.add(b);
        rows.push({ bank: b, ap: [cand[0]], how: '1:1', other: cand[0].acc != null && b.acc != null && cand[0].acc !== b.acc });
      }
    }
    dayTotal();
    big(B.filter(b => b.kind === 'pay' && !(b.cards > 0))).forEach(pack);
    /* Пакети, що не розклались: скільки погоджень дня лишилось вільними (have) проти нерозкладених пакетів цього рахунку й дня.
       short — погоджень дня менше, ніж у пакетах (13.11.2026: за день 143 000,00, пакет 169 400,00 — бракує 26 400,00: погодження ще
       з «Готівка» у «Звідки оплата»); показується, коли набору з погоджень дня немає (а «кілька наборів» дали давніші погодження).
       none — погоджень дня немає взагалі й набору немає: ЗП з відомості бухгалтерії (03.11.2026: одна сума «за вересень»). */
    for (const b of big(B.filter(x => x.kind === 'pay' && !done.has(x)))) {
      const f = fail.get(b) || { count: 0, over: false, big: false, wide: true };
      const pool = dayPools(b).find(p => p.length) || [], have = sumC(pool), need = sumC(B.filter(x => x.kind === 'pay' && !done.has(x) && x.acc === b.acc && x.date === b.date));
      const noDay = f.wide || (!f.count && !f.over);
      amb.push({ bank: b, count: f.count, over: f.over, big: f.big,
        short: noDay && have > 0 && have < need ? { have: r2(have / 100), miss: r2((need - have) / 100) } : null, none: !f.count && !f.over && !have });
    }
    const got = new Set(rows.map(m => m.bank));
    return { rows, amb, taxes: taxGroups(B.filter(b => b.kind === 'tax')),
      free: { bank: B.filter(b => b.kind !== 'tax' && !got.has(b)), ap: A.filter(a => !used.has(a.key) && !a.pct) } };
  }

  // ID записів CRM, з якими звірено операцію банку: crmIds (пара чи група «суми не 1:1», ЗП за день) або пара crm
  function crmIdsOf(b) { return b && b.crmIds && b.crmIds.length ? b.crmIds : b && b.crm && b.crm.id ? [b.crm.id] : []; }
  // стан погоджень пари в CRM: усі внесено (є ID запису), жодного, частково
  // «% менеджера» (pct) не рахується, якщо в парі є й звичайні погодження: реєстр вносить з нього лише податки, сам вивід створює CRM
  const crmState = aps => {
    const all = aps || [], own = all.filter(a => !a.pct), xs = own.length ? own : all, n = xs.filter(a => a.crmId).length;
    return n && n === xs.length ? 'в CRM' : n ? 'частково' : 'не внесено';
  };

  /* Що піде в ШІ: операції банку без пари в CRM і без погодження (і пакети ЗП, які не розклались однозначно) та погодження, що
     лишились. accName — назва рахунку. Не більше maxBank / maxAp (у Помічнику ще й приховуються номери). → {bank, approvals} */
  function aiPayload(res, accName, o) {
    o = o || {};
    const name = id => (id == null ? '' : accName ? accName(id) : String(id));
    const inAmb = new Set(((res && res.amb) || []).map(x => x.bank));
    const bank = ((res && res.free && res.free.bank) || []).filter(b => !b.crm || inAmb.has(b)).slice(0, o.maxBank || 80)
      .map(b => ({ id: b.id, date: b.date, amount: b.amount, acc: name(b.acc), cpty: b.cpty || '', text: b.text || '', kind: b.kind, ...(b.cards ? { cards: b.cards } : {}) }));
    const approvals = ((res && res.free && res.free.ap) || []).slice(0, o.maxAp || 200)
      .map(a => ({ key: a.key, date: a.date, amount: a.amount, acc: name(a.acc), recipient: a.recipient || '', text: a.text || '', entered: !!a.crmId }));
    return { bank, approvals };
  }

  /* Відповідь ШІ ([{bank, approvals: [ключі], confidence, why}]) → підказки лише з тим, що справді є серед залишку: кожне погодження —
     не більше ніж до однієї операції; різниця — сума банку мінус сума погоджень. → [{bank, ap, conf, why, diff}] */
  function aiApply(res, matches) {
    const byId = new Map(((res && res.free && res.free.bank) || []).map(b => [String(b.id), b]));
    const byKey = new Map(((res && res.free && res.free.ap) || []).map(a => [String(a.key), a]));
    const usedB = new Set(), usedA = new Set(), out = [];
    for (const m of Array.isArray(matches) ? matches : []) {
      const b = m && byId.get(String(m.bank));
      if (!b || usedB.has(b)) continue;
      const aps = [...new Set((Array.isArray(m.approvals) ? m.approvals : []).map(String))].map(k => byKey.get(k)).filter(a => a && !usedA.has(a.key));
      if (!aps.length) continue;
      usedB.add(b);
      aps.forEach(a => usedA.add(a.key));
      out.push({ bank: b, ap: aps, conf: ['висока', 'середня', 'низька'].includes(m.confidence) ? m.confidence : 'низька', why: String(m.why || '').slice(0, 300),
        diff: r2(b.amount - aps.reduce((s, a) => s + a.amount, 0)) });
    }
    return out;
  }

  return { packs, packPeople, sums, people, nameHits, match, taxGroups, crmState, crmIdsOf, aiPayload, aiApply, MONTH };
}));

/* ---- core/drafts.js ---- */
/* =====================================================================
   Чернетки кешфлоу CRM (14.11.2026). У CRM з'явились чернетки записів: /api/invoice-payment-drafts — той самий набір полів, що й
   у звичайного запису (POST /api/invoice-payment), але запис не потрапляє в кешфлоу й не змінює залишок рахунку, доки головний
   бухгалтер не «проведе» чернетку (POST …/{id}/convert). Перевірено на справжній CRM 14.11.2026:
     • GET  invoice-payment-drafts?page=&per_page= (≤ 100) → {data: [{id, status: 'draft', user_id, created_at, data: {поля форми
       рядками}, files}], last_page, total}; фільтрів за датою, сумою чи рахунком немає — список віддається весь;
     • POST invoice-payment-drafts (FormData, ті самі поля) → 201 і сама чернетка; GET …/{id}; DELETE …/{id} → 204;
     • ID чернетки — з того самого ряду номерів, що й ID записів (після запису 27230 чернетка отримала 27231): збігів ID немає;
     • у GET invoice-payment (список і за ID) чернетки немає (за ID — 404).
   Перемикач «нові записи — у чернетки» (ui/linter-panel.js): коли він увімкнений, лінтер створює чернетки, а під час звірки й пошуку
   дублів бере й чернетки — у вигляді звичайного запису (toRecord, позначка draft: true), щоб нічого не внести вдруге. Коли вимкнений —
   жодного запиту до чернеток немає, усе працює як раніше.
   Чисті функції + дві обгортки запитів: make (для opts.api панелі) і registryCall (для функції запитів закладки реєстру).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CFDrafts = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PATH = 'invoice-payment-drafts';
  const SIGN = { 1: 1, 2: -1, 3: 1, 4: -1 };
  const r2 = n => Math.round(n * 100) / 100;
  const num = v => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? null : Number(v));

  let fmt = null;
  function kyivParts(ms) {
    fmt = fmt || new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const p = {};
    for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  /* «ДД-ММ-РРРР[ ГГ:ХХ]» за Києвом (так дату надсилає форма) → ISO-час UTC; без часу — 12:00. Не дата — null. */
  function kyivIso(s) {
    const m = /^\s*(\d{2})[-.](\d{2})[-.](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(s || '')) || (() => {
      const x = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(s || ''));
      return x ? [x[0], x[3], x[2], x[1], x[4], x[5]] : null;
    })();
    if (!m) return null;
    const H = m[4] === undefined ? 12 : Number(m[4]), Mi = m[5] === undefined ? 0 : Number(m[5]);
    // неможлива дата (31-02, місяць 13, 25:70) — не дата: інакше вона «перекотилась» би на сусідній день
    const chk = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    if (H > 23 || Mi > 59 || chk.getUTCMonth() !== Number(m[2]) - 1 || chk.getUTCDate() !== Number(m[1]) || Number(m[1]) < 1) return null;
    const want = `${m[3]}-${m[2]}-${m[1]}T${String(H).padStart(2, '0')}:${String(Mi).padStart(2, '0')}`;
    for (const off of [2, 3]) { // Київ: UTC+2 взимку, UTC+3 влітку
      const ms = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), H - off, Mi);
      if (kyivParts(ms) === want) return new Date(ms).toISOString();
    }
    return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), H - 2, Mi)).toISOString(); // година переведення годинника
  }
  const kyivDay = iso => { const d = new Date(iso); return isNaN(d) ? null : kyivParts(d.getTime()).slice(0, 10); };

  /* Чернетка CRM → запис у вигляді GET invoice-payment (id, date, period, comment, payments[…]) з позначкою draft: true.
     Переказ (operation 3 + invoice_from / invoice_to) — два платежі: 4 з рахунку і 3 на рахунок, як у звичайного переказу.
     Чернетка без рахунку чи суми (недозаповнена людиною, обмін валют) — запис без платежів: у звірку не потрапляє. */
  function toRecord(d) {
    if (!d || typeof d !== 'object') return null;
    const f = (d && d.data && !Array.isArray(d.data) ? d.data : null) || {};
    const op = Number(f.operation), amount = num(f.amount);
    const pay = (acc, operation, extra) => Object.assign({ id: null, transaction_id: d.id, invoice_id: Number(acc), operation, amount, deleted_at: null }, extra || {});
    let payments = [];
    if (amount !== null && amount > 0) {
      if (op === 3 && num(f.invoice_from) && num(f.invoice_to)) payments = [pay(f.invoice_from, 4), pay(f.invoice_to, 3)];
      else if ((op === 1 || op === 2) && num(f.invoice_id)) payments = [pay(f.invoice_id, op, { pnl_category_id: num(f.pnl_category_id), pnl_operation_id: num(f.pnl_operation_id) })];
    }
    const mk = num(f.marketer_id);
    return { id: d.id, draft: true, user_id: d.user_id === undefined ? null : d.user_id, location_id: num(f.location_id), project_id: num(f.project_id), task_payment_id: null,
      comment: f.comment === undefined || f.comment === null ? '' : String(f.comment), date: kyivIso(f.date), period: kyivIso(f.period), created_at: d.created_at || null,
      updated_at: d.updated_at || null, deleted_at: null, is_manual: true, is_edited: false, payments,
      marketer_balance_history: mk ? { marketer_balance: { user_id: mk } } : null };
  }

  /* Чи підходить запис під фільтри списку invoice-payment: date_from / date_to (ДД-ММ-РРРР, день за Києвом), amount_from / amount_to
     (сума будь-якого платежу), invoice_ids[] (рахунок будь-якого платежу). Список чернеток CRM сам не фільтрує. */
  function matches(rec, query) {
    const q = typeof query === 'string' ? new URLSearchParams(query.replace(/^[^?]*\?/, '')) : query;
    const day = s => { const m = /^(\d{2})-(\d{2})-(\d{4})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
    const d = rec.date ? kyivDay(rec.date) : null, from = day(q.get('date_from')), to = day(q.get('date_to'));
    if ((from || to) && (!d || (from && d < from) || (to && d > to))) return false;
    const pays = (rec.payments || []).filter(p => !p.deleted_at);
    const lo = num(q.get('amount_from')), hi = num(q.get('amount_to'));
    if ((lo !== null || hi !== null) && !pays.some(p => (lo === null || Number(p.amount) >= lo - 0.005) && (hi === null || Number(p.amount) <= hi + 0.005))) return false;
    const ids = q.getAll('invoice_ids[]').concat(q.getAll('invoice_ids%5B%5D')).map(Number).filter(Boolean);
    if (ids.length && !pays.some(p => ids.includes(Number(p.invoice_id)))) return false;
    return true;
  }
  /* Скільки чернетки додають до залишку рахунку CRM, коли їх проведуть: Map(id рахунку → сума зі знаком). */
  function balanceEffect(records) {
    const m = new Map();
    for (const r of records || []) for (const p of r.payments || []) {
      if (p.deleted_at || !SIGN[p.operation]) continue;
      m.set(Number(p.invoice_id), r2((m.get(Number(p.invoice_id)) || 0) + SIGN[p.operation] * Number(p.amount)));
    }
    return m;
  }
  const listOf = j => (Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []));
  // у списку — лише справжні чернетки: проведена чи відхилена (якщо CRM лишає її в списку з іншим статусом) — уже не чернетка
  const isDraft = d => !!d && typeof d === 'object' && d.id !== undefined && (d.status === undefined || d.status === null || d.status === 'draft');
  const one = j => (j && j.data && !Array.isArray(j.data) && j.data.id !== undefined && j.status === undefined ? j.data : j);

  /* Тіло нової чернетки — як його зберігає сам CRM: JSON з числами (16.11.2026). Форма (FormData) дає лише рядки, CRM зберігає їх
     як є, а вікно чернетки шукає рахунок, статтю, проєкт і маркетолога суворим порівнянням (id === значення): з рядком «68» списки
     лишались порожніми — «у чернетках не вистачає даних». → об'єкт або null (не форма чи у формі файл — тоді надсилається як є). */
  const NUM_KEYS = new Set(['operation', 'amount', 'invoice_id', 'invoice_from', 'invoice_to', 'location_id', 'project_id', 'marketer_id',
    'pnl_category_id', 'pnl_operation_id', 'currency_id', 'rate', 'commission', 'show_response_in_currency']);
  function plain(form) {
    if (!form || typeof form.entries !== 'function') return null;
    const o = {};
    for (const [k, v] of form.entries()) {
      if (typeof v !== 'string') return null;
      o[k] = NUM_KEYS.has(k) && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
    }
    return o;
  }

  /* Для панелі: api — {get(path) → json (кидає помилку не на 200), post(path, body) → {status, json, …}}; on() — чи увімкнено.
     → {on, list() — усі чернетки записами, near(query) — ті, що підходять під фільтри списку, post(form) — створити чернетку
        (відповідь — як у api.post, але json = {data: запис}), get(id) — чернетка записом}. */
  function make(api, o) {
    const on = () => !!(o && o.on && o.on());
    async function list() {
      const out = new Map();
      for (let p = 1; p <= 200; p++) {
        const j = await api.get(`${PATH}?page=${p}&per_page=100`);
        for (const d of listOf(j)) if (isDraft(d)) out.set(d.id, toRecord(d));
        if (Array.isArray(j) || !j || !j.last_page || p >= j.last_page) break;
      }
      return [...out.values()];
    }
    return {
      on, list,
      near: async query => (await list()).filter(r => matches(r, query)),
      post: async form => {
        const res = await api.post(PATH, plain(form) || form); // об'єкт api надсилає як JSON
        if (!res || res.status < 200 || res.status >= 300) return res;
        const d = one(res.json);
        return Object.assign({}, res, { json: { data: d && d.id !== undefined ? toRecord(d) : d } });
      },
      get: async id => toRecord(one(await api.get(`${PATH}/${id}`))),
    };
  }

  /* Для закладки реєстру погоджень: S(метод, адреса, тіло) → json (кидає Error зі .status). У режимі чернеток:
     POST /api/invoice-payment → чернетка (відповідь — {data: запис}); GET списку — ще й чернетки, що підходять під його фільтри
     (на першій сторінці); GET за ID, якого в кешфлоу немає (404), — чернетка. Решта запитів — без змін. */
  function registry(S) {
    // список чернеток — один запит на всіх, хто питає одночасно (перевірка рядків іде по 4), і на 4 секунди; створена чернетка
    // дописується в нього, а не скидає його (інакше кожен рядок пакета перечитував би весь список)
    let cache = null;
    const ids = new Set(); // ID чернеток, які бачив реєстр: змінювати їх запитом до кешфлоу не можна
    const load = async () => {
      const out = [];
      for (let p = 1; p <= 200; p++) {
        const j = await S('GET', `/api/${PATH}?page=${p}&per_page=100`);
        for (const d of listOf(j)) if (isDraft(d)) out.push(toRecord(d));
        if (Array.isArray(j) || !j || !j.last_page || p >= j.last_page) break;
      }
      out.forEach(r => ids.add(Number(r.id)));
      return out;
    };
    const all = () => {
      if (cache && Date.now() - cache.at < 4000) return cache.promise;
      const mine = { at: Date.now(), promise: null };
      mine.promise = load().catch(e => { if (cache === mine) cache = null; throw e; });
      cache = mine;
      return mine.promise;
    };
    call.isDraft = id => ids.has(Number(id)); // чи це ID чернетки, яку бачив реєстр (для примітки в «Реєстрі»)
    return call;
    async function call(method, url, body) {
      const path = String(url).split('?')[0];
      if (method === 'POST' && path === '/api/invoice-payment') {
        let d;
        // запит реєстру заголовка Content-Type не ставить — його дає сам Blob
        const o = plain(body), json = o && typeof Blob !== 'undefined' ? new Blob([JSON.stringify(o)], { type: 'application/json' }) : body;
        try { d = one(await S('POST', `/api/${PATH}`, json)); } catch (e) { cache = null; throw e; } // чи створилась чернетка — невідомо
        const rec = d && d.id !== undefined ? toRecord(d) : null;
        if (rec) {
          ids.add(Number(rec.id));
          if (cache) { const c = cache; c.promise = c.promise.then(l => l.concat([rec])); }
        } else cache = null;
        return { data: rec || d };
      }
      if (method === 'GET' && path === '/api/invoice-payment') {
        const j = await S(method, url, body), q = new URLSearchParams(String(url).replace(/^[^?]*\?/, ''));
        if (Number(q.get('page') || 1) > 1) return j;
        const have = new Set(listOf(j).map(r => r.id)); // чернетку щойно провели — вона вже серед записів
        const extra = (await all()).filter(r => !have.has(r.id) && matches(r, q));
        if (!extra.length) return j;
        return Array.isArray(j) ? j.concat(extra) : Object.assign({}, j, { data: listOf(j).concat(extra) });
      }
      const m = /^\/api\/invoice-payment\/(\d+)$/.exec(path);
      if (m && method === 'GET') {
        try { return await S(method, url, body); } catch (e) {
          if (!e || e.status !== 404) throw e;
          const rec = toRecord(one(await S('GET', `/api/${PATH}/${m[1]}`)));
          if (rec) ids.add(Number(rec.id));
          return rec;
        }
      }
      if (m && ids.has(Number(m[1]))) { // PUT / DELETE запису, який насправді чернетка: у кешфлоу його немає (CRM відповів би 404)
        const e = new Error(`запис ${m[1]} — чернетка CRM: змініть її в CRM («CashFlow» → «Чернетки»)`);
        e.status = 409;
        throw e;
      }
      return S(method, url, body);
    }
  }
  return { PATH, toRecord, matches, balanceEffect, kyivIso, make, registry, plain };
}));

/* ---- ui/combo.js ---- */
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

/* ---- ui/bank-panel.js ---- */
/* =====================================================================
   Вкладка «Звірка з банком» панелі лінтера: рахунки за період — CRM проти банку.
   По кожному рахунку: залишок на початок і кінець періоду, надходження, списання
   і кількість операцій за кожною сумою (core/recon.js → periodRecon): суми можуть бути
   не 1:1 з банком, тому порівнюються штуки, а не пари «операція — запис».
   CRM: залишок, який показує сам CRM (balance рахунку), відкочений записами з пізнішою датою.
   Банк: виписки Привату й Моно вивантажує «Помічник кешфлоу» (ваш privat_fetch.py) на запит
   панелі; без Помічника — файл .json; для Erste, Wise, Stripe, каси — залишок вручну.
   Перекази між своїми рахунками: corpCard, картка якого списує прямо з рахунку банку, звіряється разом із цим
   рахунком (поповнення картки в CRM — рух усередині); переказ, якого немає в CRM, — у списку пропозицій.
   «Що звіряти»: усе, лише надходження, лише списання чи лише перекази між рахунками — обороти, кількість і суми
   рахуються для вибраного типу.
   Операції банку, яких немає в CRM, — у списку пропозицій «створити запис»: витрата, комісія банку чи надходження,
   стаття — за правилами rules.json, інакше як у попередніх записах рахунку з цим контрагентом, інакше її вибирають;
   для статті з рекламним бюджетом — маркетолог (список з CRM, як у реєстрі; за замовчуванням — як у попередніх записах рахунку).
   У CRM — лише GET-запити; єдиний POST — створення переказу чи запису з цих списків, лише в закладці APPLY і після
   вікна з точним запитом. Нічого не змінюється й не видаляється.
   «Нові корп. картки у виписці»: покупки карткою, номера якої лінтер не знає, — з підказкою рахунку картки в CRM (на який записано
   ці покупки) і кнопкою «Запам'ятати» (у цьому браузері, LS cfl_cards_local → довідник карток для всіх вкладок; mergeLocalCards).
   «Закриття місяця»: звірка за весь місяць, «Статті й проєкти» (opts.lintPeriod — перевірка від панелі) і погодження реєстру
   (лише читання) — пункти й висновок, чи можна закривати місяць (closeReport). opts.go(вкладка) — перейти до вкладки.
   «Виводи з балансу»: погодження «% менеджера / м-рів / тімліда» з реєстру ↔ авто-записи «Підтвердження виведення коштів з балансу…»
   (core/withdrawals.js): виведено повністю, частково, виводу немає; виводи без погодження. Лише звірка — нічого не змінює.
   CFBankPanel.mount(container, { api, storage, applyAllowed, dialog, setBusy, projects, rulesDoc, closed, lintPeriod, go })
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../core/recon.js'), require('../core/crm-model.js'), require('../core/xlsx.js'), require('../core/rules-engine.js'), require('../core/withdrawals.js'), require('./combo.js'), require('../core/matching.js'), require('../core/drafts.js'));
  else root.CFBankPanel = factory(root.CFRecon, root.CFModel, root.CFXlsx, root.CFRules, root.CFWithdrawals, root.CFCombo, root.CFMatch, root.CFDrafts);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Rc, M, X, R, WD, Cmb, MT, CFD) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // один форматер на всі суми: toLocaleString створює новий на кожен виклик, а в таблицях звірки їх сотні
  const NF2 = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt = x => (x === null || x === undefined ? '—' : NF2.format(Number(x)));
  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const r2 = Rc.r2;
  const today = () => M.kyivNow().slice(0, 10);
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dash = iso => iso.split('-').reverse().join('-'); // РРРР-ММ-ДД → ДД-ММ-РРРР (формат фільтра сайту)
  const dmy = iso => (iso ? iso.split('-').reverse().join('.') : '');
  const listOf = j => (Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []));
  const isZero = v => v !== null && v !== undefined && Math.abs(v) < 0.005;
  const parseNum = s => { const t = String(s == null ? '' : s).replace(/[\s  ']/g, '').replace('−', '-').replace(',', '.'); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null; };
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const MARGIN = 7; // днів CRM до періоду: залишок на початок і підказки «запис з іншою датою»
  // групи рахунків за назвою в CRM (у порядку показу); корпкартки — першими при пошуку, бо «Mono біла» — теж корпкартка.
  // Назви — і старі («corpCard …», «Готівка Україна», «1 PLN Polska LLC»), і нові з 30.10.2026 («корп. картка …», «Каса», «… Ерсте злотий», «… Вайз»)
  const GROUPS = [
    ['privat', 'Приват', /приват|privat/i],
    ['mono', 'Універсал (Моно)', /універсал|universal|моно|mono/i],
    ['erste', 'Erste Bank Polska', /polska|злоті в польщі|ерсте|erste/i],
    ['wise', 'Wise', /wise|вайз/i],
    ['stripe', 'Stripe', /stripe|страйп/i],
    ['corp', 'Корпоративні картки', /corp\s*card|корп\.?\s*карт/i],
    ['cash', 'Готівка', /готівк|cash|(?<!\p{L})кас[аи](?!\p{L})/iu],
    ['other', 'Інші рахунки', /[\s\S]/],
  ];
  const groupOf = a => GROUPS.find(g => g[0] === 'corp' && g[2].test(a.name || '')) || GROUPS.find(g => g[2].test(a.name || ''));
  const srcOf = b => `${b.bank === 'mono' ? 'API monobank' : 'API Привату'} · виписка ${dmy(b.fileFrom)}–${dmy(b.fileTo)}`;
  const HINT = 'Виписок ще немає. «Отримати виписки й звірити» — Приват і Моно вивантажить «Помічник кешфлоу» (ваш privat_fetch.py; програма має бути запущена). Без нього — «Додати файл .json». Для Erste, Wise, Stripe і каси залишок банку на кінець періоду можна ввести в таблиці.';
  const LIVE = 'Сьогоднішній день ще не закрито: дані банку — на момент вивантаження виписки (пізніші операції в них не ввійшли), а в CRM сьогоднішні операції можуть бути ще не внесені.';
  const HELPER_DOWN = 'Не бачу «Помічника кешфлоу»: запустіть «Помічник кешфлоу.bat» і натисніть ще раз (виписки вивантажує він, вашим privat_fetch.py). «Оновити.bat» сам зупиняє й знову запускає Помічник; якщо його не було запущено — запустіть. Якщо Помічник запущено, а помилка лишається, браузер не пускає запит до нього — тоді вивантажте виписки в самому Помічнику й додайте файл .json.';
  const ST = { ok: ['st-ok', 'сходиться'], timing: ['st-ok', 'сходиться, крім дат проведення'], pay: ['st-ok', 'сходиться, крім ЗП через транзит'], expl: ['st-ok', 'сходиться з поясненнями'], bad: ['st-manual', 'розбіжність'],
    xfer: ['st-review', 'бракує переказів між своїми'], part: ['st-review', 'неповні дані банку'], ccy: ['st-review', 'інша валюта'], merged: ['st-ok', 'звіряється з рахунком банку'], none: ['st-locked', 'немає даних банку'] };
  const ST_ORDER = ['ok', 'timing', 'pay', 'expl', 'bad', 'xfer', 'part', 'ccy', 'merged', 'none'];
  const ST_RARE = new Set(['timing', 'pay', 'expl', 'xfer', 'ccy', 'merged']); // у фільтрі — лише коли такі рахунки є
  // поповнення корп. картки, записане в CRM витратою (як у правилі R-NP-CORPCARD-01; з описками «корп каркти»), — не комісія за нього
  const CARD_TOPUP_RE = /поповн\p{L}*\s+(?:на\s+)?корп|на\s+корп\p{L}*\.?\s*ка\p{L}{0,2}т/iu;
  const isTopup = s => CARD_TOPUP_RE.test(s || '') && !/^\s*коміс/i.test(s || '');
  const dayDiff = (a, b) => Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 864e5);
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // попередження, однакові для всіх рахунків виписки, показуються один раз біля файлу
  const FILE_WARN = /^Підсумкова виписка банку є лише до/;
  // неповна виписка (вхідний + рух ≠ вихідний) чи операція, яку банк віддав двічі (recon, privat_fetch.py; 07.11.2026), — і біля файлу,
  // з номером рахунку, щоб її було видно до будь-якої звірки; у картці рахунку лишається
  const FILE_SHOW = /виписка неповна|операцію двічі/i;
  const tail = iban => (iban ? '…' + String(iban).slice(-6) : '');
  const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };

  /* Чого бракує: суми, кількість операцій з якими різна, — «немає в CRM» (у банку більше) і «немає в банку» (у CRM більше),
     окремо надходження і списання; × — скільки разів. */
  function lacks(R) {
    const miss = [], extra = [];
    for (const x of R.amounts) (x.d < 0 ? miss : extra).push({ amount: x.amount, k: Math.abs(x.d), near: x.near || [] });
    const side = list => {
      const one = x => `${fmt(Math.abs(x.amount))}${x.k > 1 ? ' ×' + x.k : ''}${x.near.length ? ` (у CRM є з іншою датою: ${x.near.slice(0, 2).map(o => dmy(o.date).slice(0, 5)).join(', ')}${x.near.length > 2 ? ` і ще ${x.near.length - 2}` : ''})` : ''}`;
      const part = (arr, label) => (arr.length ? `${label} ${arr.map(one).join(' · ')}${arr.length + arr.reduce((t, x) => t + x.k - 1, 0) > 1 ? ` (разом ${fmt(Math.abs(arr.reduce((t, x) => t + x.amount * x.k, 0)))})` : ''}` : '');
      const asc = arr => arr.slice().sort((x, y) => Math.abs(x.amount) - Math.abs(y.amount));
      return [part(asc(list.filter(x => x.amount > 0)), 'надходження'), part(asc(list.filter(x => x.amount < 0)), 'списання')].filter(Boolean).join('; ');
    };
    return { miss: side(miss), extra: side(extra) };
  }
  // «Що звіряти» (core/recon.js → periodRecon, own.kind)
  const KIND = { all: 'усе', credit: 'надходження', debit: 'списання', own: 'перекази між рахунками' };
  const KIND_ONLY = { credit: 'лише надходження', debit: 'лише списання', own: 'лише перекази між рахунками' };

  // ---------- операції банку, яких немає в CRM: що створити ----------
  const SRC = { exp: 'витрата', fee: 'комісія банку', inc: 'надходження', pay: 'ЗП через транзитний рахунок' };
  // перевіряється на тексті з кирилицею замість латинських двійників (у Привату «Комiсiя», «Списання комiсiї» — з латинською «i»)
  // «Погашення простроченої заборгованості за РКО» — теж плата банку за обслуговування (07.11.2026)
  const FEE_RE = /^\s*(?:(?:списання\s+)?коміс|плата\s+за\s+(?:обслуг|рко|користув|розрахунк|ведення)|обслуговування\s+рахунк|абонентськ\p{L}*\s+плат|погашення\s+простроч\p{L}*\s+заборгован\p{L}*\s+за\s+рко)/iu;
  // зарплата в CRM — по людях за реєстром ЗП, еквайринг — оплати замовлень (ліди): суми не 1:1 з банком, тож запис не пропонується
  const PAYROLL_RE = /зарплат|заробітн|(?<![\p{L}\d])(?:з\s*\/\s*п|зп)(?![\p{L}\d])|для\s+виплат|мас\p{L}*\.?\s*вип|ціл\p{L}*[-\s.]*\p{L}*\s*зарах|поповн\p{L}*\s+(?:зп|карток)/iu;
  // «Оплата частинами» Привату (контрагент «Розрахунки "Оплата Частинами"», «Оплата частинами.Сума договору: 1279.20 грн…», зараховано
  // 1 233,15) — теж оплата замовлення без комісії банку, як LiqPay (огляд 16.11.2026); звичайне «оплата частинами» від клієнта сюди не входить
  const ACQ_RE = /еквайр|liqpay|wayforpay|fondy|portmone|interkassa|platon|stripe|paypal|відшкод\p{L}*\s+(?:за\s+)?(?:операц|торг)|оплат\p{L}*\s+частинами[\s.,:;]*сума\s+договор|розрахунки\s+[^\p{L}\d]*оплата\s+частинами/iu;
  const STOPW = new Set(['оплата', 'оплату', 'оплати', 'послуги', 'послуг', 'згідно', 'рахунок', 'рахунку', 'договір', 'договору', 'товар', 'товари', 'товарів', 'сума',
    'призначення', 'платежу', 'платіж', 'картка', 'картки', 'карткою', 'переказ', 'коштів', 'кошти', 'покупка', 'безготівкова', 'операція', 'payment', 'card', 'with', 'from']);
  const words = s => new Set((R.toCyr(String(s || '')).toLowerCase().replace(/[’ʼ`]/g, "'").match(/\p{L}[\p{L}'-]{3,}/gu) || []).filter(w => !STOPW.has(w)));
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  // коментар у CRM — один рядок: перенесення рядків з поля прибираються
  const oneLine = clean;
  // поле коментаря — на кілька рядків, щоб увесь текст було видно (≈ 34 знаки в рядку, 2–5 рядків)
  const comRows = s => Math.min(5, Math.max(2, Math.ceil(String(s || '').length / 34)));
  // висота поля за текстом (довгі номери й назви переносяться по-різному — рахується після розкладки; у схованому розділі — rows)
  function fitCom(e) {
    if (!e.offsetParent) return;
    e.style.height = 'auto';
    e.style.height = `${Math.min(e.scrollHeight + 2, 160)}px`;
  }
  /* усі поля разом: спершу всі «auto», потім усі виміри, потім усі висоти — дві розкладки сторінки на все, а не по чотири на кожне поле
     (на сотнях рядків «Внести в CRM» кожна зміна статті чи маркетолога гальмувала) */
  function fitComs(list) {
    const vis = [...list].filter(e => e.offsetParent);
    vis.forEach(e => { e.style.height = 'auto'; });
    const hs = vis.map(e => e.scrollHeight);
    vis.forEach((e, i) => { e.style.height = `${Math.min(hs[i] + 2, 160)}px`; });
  }
  // Enter не переносить рядок, а закінчує введення (коментар CRM однорядковий); висота — за текстом під час введення (решту
  // полів підганяє applySec — разом, один раз на перемальовування)
  function comField(e) {
    e.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); e.blur(); } };
    e.oninput = () => fitCom(e);
  }
  /* Операція банку без запису в CRM: {src: 'fee' | 'exp' | 'inc', payroll?: застереження} або {block: чому лінтер запис не пропонує}.
     Зарплатну виплату (з 05.11.2026, за потреби) можна внести — з
     застереженням: у CRM ЗП зазвичай вносять по людях за реєстром ЗП.
     payroll — будь-яке застереження класифікатора (не лише про ЗП): рядок показується в «Внести в CRM» попередженням, а операція не
     потрапляє в «Позначити всі витрати зі статтею». Огляд 16.11.2026 — ще три (лише попередження, як вносити — вирішує людина):
     позика («поворотна фінансова допомога»), зняття готівки в касі банку, повернення нашого платежу. */
  const LOAN_RE = /фінансов\p{L}*\s+допомог|(?:надання|повернення|погашення)\s+(?:\p{L}+\s+)?позик|договор\p{L}*\s+позик/iu; // реальні описки: «повортної фінансовой допомоги»
  const LOAN_NOTE = 'схоже на поворотну фінансову допомогу (позику): це не дохід від клієнта і не звичайна витрата — статтю з історії не беріть; як вносити позику та її повернення — за рішенням власника';
  // Приват: контрагент «Каса Приватбанку <касир>», рахунок каси 1002, «Видача 4246 **** **** 1421 {{DABR=K7D0}}»
  const cashOut = x => x.amount < 0 && /^\s*видача(?!\p{L})/iu.test(R.toCyr(x.purpose || '')) && (/^\s*каса\s/iu.test(R.toCyr(x.cpty || '')) || Rc.balOf(x.cpIban) === '1002');
  const CASH_NOTE = 'зняття готівки в касі банку: це не оплата контрагенту — якщо готівку внесено в касу, у CRM це переказ на рахунок каси; якщо її взяв власник ФОП — витрата за тим, на що пішли гроші';
  const REFUND_IN_RE = /поверн\p{L}*\s+(?:помилков|надміру|зайво)|помилково\s+(?:сплачен|перерахован|зарахован)/iu;
  const REFUND_NOTE = 'схоже на повернення нашого платежу, а не дохід від клієнта: знайдіть витрату, яку повернули, і внесіть повернення з огляду на неї (не новим доходом «з історії»)';
  const PAYROLL_NOTE = 'зарплатна виплата: у CRM ЗП зазвичай вносять по людях (реєстр ЗП, погодження) — вносьте одним записом, лише якщо цієї ЗП у CRM ще немає';
  /* Податки із ЗП, які ТОВ платить окремими платежами (ПДФО, військовий збір, ЄСВ «за жовтень 2026»). У CRM їх розносили по людях
     зі статтею відділу («Податки з ЗП за вересень 2026 (ПДФО, ВЗ, ЄСВ) — Терещенко Роман (ЗП відділу продажів)…»), тож статтю з
     історії за словами не вгадуємо: 05.11.2026 ВЗ і ЄСВ випадково отримали «Розробку» (слово «жовтень» у ЗП розробників), а ПДФО — ні
     (слово «ПДФО» — у записах десятка відділів). Податки однієї ЗП (рахунок, день, місяць у призначенні) — одна група з однією статтею. */
  const PAY_TAX_RE = /пдфо|військов\p{L}*\s+зб[іо]р|(?<!\p{L})єсв(?!\p{L})|єдин\p{L}*\s+соц/iu;
  const ESV_RE = /(?<!\p{L})єсв(?!\p{L})|єдин\p{L}*\s+соц/iu;
  const TAX_MONTH = /за\s+(\p{L}+\s+\d{4}|\d{1,2}[.\s]+\d{4})/iu;
  const TAX_PAID = /сплата\s+(?:пдфо|військов|єсв)/iu; // запис, внесений з платежу податку банку (а не рознесений по людях)
  // запис податків по людях: «Податки 10 % з … (на руки …) — …», «1120,01*2= 2240,02 податки із …», «Податки з ЗП … — Гудимко»;
  // податок цілим платежем називає сам податок: «Сплата ПДФО за …», «ПДФО із зп …», «ЄСВ 1грн із зп …»
  // (за ознаками, а не за самим «подат»: «Військовий збір (податок із ЗП) за …» — цілим платежем)
  const TAX_PERSON = /на\s+руки|\d\s*\*\s*2\s*=|(?<!^[^\p{L}\d]*(?:сплата\s+)?(?:пдфо|військов\p{L}*\s+зб\p{L}*|єсв).*)(?:подат\p{L}*\s+\d|\d\s*%\s*подат|подат\p{L}*\s+(?:з|із|зі)\s+(?:зп|з\/п|зарплат|заробітн|\d))/iu;
  // «подат» у коментарі, але це не податки із ЗП по людях: ЗП чи % «(разом з податками)», єдиний податок, ЄСВ самого ФОП, податок на прибуток, ПДВ
  const TAX_OTHER = /разом\s+з\s+податк|єдин\p{L}*\s+подат|по\s+фоп|податок\s+на\s+прибут|(?<!\p{L})пдв(?!\p{L})/iu;
  const cyr = s => R.toCyr(String(s || '')); // латинські двійники («Сплата ЄСВ», «Комiсiя») — кирилицею
  const taxName = s => { const t = cyr(s); return /пдфо/i.test(t) ? 'ПДФО' : /військов/i.test(t) ? 'ВЗ' : /єсв|єдин\p{L}*\s+соц/iu.test(t) ? 'ЄСВ' : 'податок'; };
  function classify(x) {
    const p = R.toCyr(x.purpose || ''), t = `${p} ${R.toCyr(x.cpty || '')}`;
    // комісія — і за поповнення карток для виплат: статтю відділу правило R-COMM-02 лишає людині
    if (x.amount < 0 && FEE_RE.test(p)) return { src: 'fee' };
    if (PAYROLL_RE.test(t)) return { src: x.amount < 0 ? 'exp' : 'inc', payroll: PAYROLL_NOTE };
    if (x.amount > 0 && ACQ_RE.test(t)) return { block: 'надходження від еквайрингу чи платіжної системи: у CRM це оплати замовлень (ліди), суми не 1:1 з банком' };
    const note = LOAN_RE.test(p) ? LOAN_NOTE : cashOut(x) ? CASH_NOTE : x.amount > 0 && REFUND_IN_RE.test(p) ? REFUND_NOTE : '';
    return { src: x.amount < 0 ? 'exp' : 'inc', ...(note ? { payroll: note } : {}) };
  }
  // коментар нового запису — як у реєстрі «Отримувач: призначення»; комісія — «Комісія банку: …» (так її впізнає правило R-COMM-01)
  function recComment(x, src) {
    // зняття готівки в касі: без прізвища касира й службової мітки банку «{{DABR=K7D0}}» (огляд 16.11.2026)
    if (cashOut(x)) { const t4 = Rc.cardTail(x.purpose); return `Зняття готівки в касі банку${t4 ? `, картка *${t4}` : ''}`; }
    const p = clean(String(x.purpose || '').replace(/\s*\{\{[^{}]*\}\}/g, '')), c = clean(x.cpty);
    const t = src === 'fee' ? (/^коміс/i.test(R.toCyr(p)) ? p : `Комісія банку: ${p}`) : c && !p.toLowerCase().includes(c.toLowerCase()) ? (p ? `${c}: ${p}` : c) : p;
    return t.slice(0, 250);
  }
  // продавець у покупці карткою: «4246 **** **** 1665 02.10.2026 04:28:07 Цифровi товари: FACEBK *22AH55AK24, FACEBOOK.COM» → «FACEBK *22AH55AK24, FACEBOOK.COM»
  const VENDOR = /\*{2,}[\s*xх]*\d{4}\s+\d{2}\.\d{2}\.\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s+[^:]*:\s*(.+)$/i;
  const vendorOf = s => { const m = VENDOR.exec(String(s || '')); return m ? m[1] : ''; };
  /* Записи CRM, схожі на операцію банку x: того самого типу (opc), зі статтею, у коментарі є слово з назви контрагента чи з призначення.
     Надто загальні слова (є в понад 40 % записів, наприклад «Цифровi товари» в усіх покупках карткою) не рахуються — крім слів продавця
     в покупці карткою: «facebook» може бути в більшості покупок, але саме він і визначає статтю. */
  // слова коментаря запису — один раз на запис (записи не змінюються на місці; нові приходять новими об'єктами)
  const WORDS = new WeakMap();
  const itemWords = c => { let v = WORDS.get(c); if (!v) WORDS.set(c, v = words(c.comment)); return v; };
  // записи → {opc → кандидати, їхні слова, у скількох записах кожне слово}: не залежить від операції банку — один раз на масив записів
  // (раніше — на кожну операцію «Внести в CRM» на кожне перемальовування)
  const SIMB = new WeakMap();
  function simBase(items, opc) {
    let m = SIMB.get(items);
    if (!m) SIMB.set(items, m = new Map());
    let v = m.get(opc);
    if (!v || v.n !== items.length) {
      const cand = items.filter(c => c.opc === opc && c.art), cw = cand.map(itemWords), df = new Map();
      cw.forEach(s => s.forEach(k => df.set(k, (df.get(k) || 0) + 1)));
      m.set(opc, v = { cand, cw, df, n: items.length });
    }
    return v;
  }
  function similar(items, x, opc) {
    if (!items || !items.length) return [];
    const { cand, cw, df } = simBase(items, opc);
    if (!cand.length) return [];
    const seller = words(vendorOf(x.purpose));
    const w = [...new Set([...words(x.cpty), ...words(x.purpose)])].filter(k => seller.has(k) || !(cand.length >= 5 && df.get(k) / cand.length > 0.4));
    return cand.filter((c, i) => w.some(k => cw[i].has(k)));
  }
  /* Стаття з історії рахунку: найчастіша серед схожих записів, якщо на неї припадає щонайменше 60 % з них. {art, n, ex} або null. */
  function histArt(items, x, opc) {
    const m = similar(items, x, opc), cnt = new Map();
    for (const c of m) { const v = cnt.get(c.art) || { k: 0, ex: c }; v.k++; cnt.set(c.art, v); }
    if (!cnt.size) return null;
    const [art, v] = [...cnt].sort((a, b) => b[1].k - a[1].k)[0];
    return v.k / m.length >= 0.6 ? { art, n: v.k, ex: v.ex } : null;
  }
  /* Маркетолог за ім'ям у коментарі запису. У списку записів CRM маркетолога немає (marketer_balance_history віддає лише запит
     одного запису), а покупки корп. карткою в CRM пишуть з ім'ям: «Facebook 30.10 Ларіоненко Тимур (тест США): …». → id з mks
     [{id, name}], якщо в коментарі є всі слова його імені (будь-який порядок, відмінкове закінчення) і такий маркетолог один; інакше null. */
  const nameWords = s => String(s || '').toLowerCase().replace(/[’ʼ`']/g, '').split(/[^\p{L}]+/u).filter(w => w.length >= 2);
  function mkInComment(mks, comment) {
    const cw = nameWords(comment);
    if (!cw.length || !mks || !mks.length) return null;
    const has = w => cw.some(c => c === w || (w.length >= 4 && c.length <= w.length + 2 && c.startsWith(w.slice(0, -1))));
    const hit = mks.filter(m => { const nw = nameWords(m.name); return nw.length >= 2 && nw.every(has); });
    return hit.length === 1 ? hit[0].id : null;
  }
  // маркетолог запису історії: з запису або з імені в коментарі — один раз на запис і список маркетологів (вкладку перемальовують часто)
  const MKC = new WeakMap();
  function mkOfItem(c, mks) {
    if (c.mk) return c.mk;
    if (!mks || !mks.length) return null;
    let m = MKC.get(mks);
    if (!m) MKC.set(mks, m = new WeakMap());
    let v = m.get(c);
    if (v === undefined) m.set(c, v = mkInComment(mks, c.comment) || 0);
    return v || null;
  }
  // дата операції для порівняння з історією: покупка карткою — дата покупки з призначення
  const opDate = x => Rc.cardDate(x.purpose) || x.date;
  /* n записів list, найближчих за датою до d (рівно — новіший ID). День запису рахується один раз на запис: сортування з розбором
     дат у порівнянні на тисячах записів історії гальмувало кожну зміну статті чи маркетолога в «Внести в CRM» на секунди. */
  const DAYN = new WeakMap();
  const dayNum = c => { let v = DAYN.get(c); if (v === undefined) DAYN.set(c, v = c.date ? Math.round(Date.parse(`${c.date}T12:00:00Z`) / 864e5) : NaN); return v; };
  function nearest(list, d, n) {
    const t = d ? Math.round(Date.parse(`${d}T12:00:00Z`) / 864e5) : NaN;
    const dist = c => { const v = Math.abs(dayNum(c) - t); return Number.isFinite(v) ? v : 0; };
    // n найближчих — за один прохід (без сортування всієї історії): ближча дата, а рівно — новіший ID
    const top = [], after = (a, v, id) => a.v > v || (a.v === v && a.id < id);
    for (const c of list) {
      const v = dist(c), id = c.id || 0;
      if (top.length === n && !after(top[n - 1], v, id)) continue;
      let i = top.length;
      top.push(null);
      while (i > 0 && after(top[i - 1], v, id)) { top[i] = top[i - 1]; i--; }
      top[i] = { c, v, id };
      if (top.length > n) top.pop();
    }
    return top.map(o => o.c);
  }
  /* Маркетолог для витрати зі статтею art (рекламний бюджет): серед схожих записів рахунку з цією статтею, інакше — серед усіх записів
     рахунку з нею. Маркетолог запису — з запису (mk) або з імені в коментарі (mks — список маркетологів CRM). Рахуються до 5 записів,
     найближчих за датою до операції (корп. картку передають від маркетолога маркетологу); рівно — того, чий запис ближчий.
     {id, n, sure} або null; sure — у цих записах маркетолог один, і записів щонайменше два. */
  // підмножини записів (за статтею, маркетологом) — один раз на масив записів і список маркетологів: той самий масив щоразу, тож і кеш
  // схожості (simBase) спрацьовує, а не рахується заново на кожну операцію «Внести в CRM»
  const SUBS = new WeakMap();
  function subOf(items, key, dep, make) {
    let m = SUBS.get(items);
    if (!m) SUBS.set(items, m = new Map());
    let v = m.get(key);
    if (!v || v.n !== items.length || v.dep !== dep) m.set(key, v = { n: items.length, dep, val: make() });
    return v.val;
  }
  function histMk(items, x, art, mks) {
    items = items || [];
    const { of, withMk } = subOf(items, `mk|${art}`, mks, () => {
      const m = new Map();
      for (const c of items) {
        if (c.opc !== 2 || c.art !== art) continue;
        const id = mkOfItem(c, mks);
        if (id) m.set(c, id);
      }
      return { of: m, withMk: [...m.keys()] };
    });
    const d = opDate(x);
    const pick = list => {
      if (!list.length) return null;
      const near = nearest(list, d, 5), cnt = new Map();
      near.forEach(c => cnt.set(of.get(c), (cnt.get(of.get(c)) || 0) + 1));
      const [id, n] = [...cnt].sort((a, b) => b[1] - a[1])[0];
      return { id, n, sure: cnt.size === 1 && n >= 2 };
    };
    return pick(similar(withMk, x, 2)) || pick(withMk);
  }
  /* Зразок для покупки корп. карткою: найближчий за датою схожий запис рахунку з тією самою статтею (і маркетологом mk, якщо він є) —
     з нього сервіс, мета в дужках і проєкт. → запис або null */
  function histRef(items, x, art, mk, mks) {
    if (!art) return null;
    items = items || [];
    const list = subOf(items, `ref|${art}|${mk || ''}`, mks, () => items.filter(c => c.opc === 2 && c.art === art && (!mk || mkOfItem(c, mks) === mk)));
    return nearest(similar(list, x, 2), opDate(x), 1)[0] || null;
  }
  // сервіс покупки карткою — як його пишуть у CRM («Facebook 30.10 …», «Google Ads 19:32 …»)
  const SERVICES = [[/facebk|facebook|(?<![\p{L}])meta(?![\p{L}])/iu, 'Facebook'], [/google/i, 'Google Ads'], [/hetzner/i, 'Hetzner Online'], [/openai|chatgpt/i, 'OpenAI'],
    [/tiktok/i, 'TikTok Ads'], [/anthropic|claude\.ai/i, 'Anthropic'], [/linkedin/i, 'LinkedIn'], [/twitter|(?<![\p{L}])x corp/iu, 'X Ads']];
  // з коментаря CRM: «Hetzner Online (сервер) 14:06 Татоян Артем (розхідники PrykladM): …» → сервіс, хто, мета в дужках
  const REF_RE = /^\s*([^\d:]{2,40}?)\s+\d{1,2}[.:]\d{2}(?:\s+\d{1,2}:\d{2})?\s+([^():\d]{3,60}?)\s*(?:\(([^)]{1,60})\))?\s*[:,]/;
  const refParts = s => { const m = REF_RE.exec(String(s || '')); return m ? { svc: m[1].trim(), who: m[2].trim(), what: (m[3] || '').trim() } : null; };
  // слово статті реклами в коментарі: «(тест США)», «(реінвест Україна)»
  const ART_WORD = { '20/41': 'тест', '20/30': 'реінвест', '20/40': 'дотування' };
  const titleCase = s => String(s || '').toLowerCase().replace(/(^|[\s.-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  const CARD_TIME = /\*{2,}[\s*xх]*\d{4}\s+\d{2}\.\d{2}\.\d{4}\s+(\d{1,2}:\d{2})/i;
  /* Коментар покупки корп. карткою — як у CRM: «Facebook 30.10 17:33 Ларіоненко Тимур (тест США): 5000.00 UAH, корп. картка 7850».
     o: {who — маркетолог чи хто тримає картку, art, proj, projName, ccy, amount, ref — histRef}. Сервіс — як у зразку, інакше за
     продавцем; ім'я — як написано в зразку (той самий маркетолог); мета — як у зразку, якщо в нього та сама стаття й проєкт, інакше слово
     статті реклами й проєкт. */
  function cardComment(x, o) {
    const rp = o.ref ? refParts(o.ref.comment) : null, merch = vendorOf(x.purpose) || merchantOf(x.purpose);
    const known = SERVICES.find(([re]) => re.test(merch));
    const svc = (rp && rp.svc) || (known ? known[1] : titleCase(merchantOf(x.purpose))) || 'Покупка карткою';
    const who = o.who && rp && rp.who && o.sameWho && o.sameWho(rp.who) ? rp.who : o.who || '';
    const same = o.ref && o.ref.art === o.art && Number(o.ref.proj) === Number(o.proj);
    const what = (same && rp && rp.what) || (ART_WORD[o.art] ? [ART_WORD[o.art], o.projName].filter(Boolean).join(' ') : '');
    const t = (CARD_TIME.exec(String(x.purpose || '')) || [])[1] || '', last4 = Rc.cardTail(x.purpose);
    return `${svc} ${dmy(opDate(x)).slice(0, 5)}${t ? ' ' + t : ''}${who ? ' ' + who : ''}${what ? ` (${what})` : ''}: ${Number(o.amount).toFixed(2)} ${o.ccy || 'UAH'}${last4 ? `, корп. картка ${last4}` : ''}`.slice(0, 250);
  }
  /* Сховані рахунки таблиці «Рахунки»: вибрані людиною (значок-око; hide — cfl_bank_hide) і неактуальні за назвою («НеАктуальний …»,
     «Not actual …», «… (видалити)»), якщо людина не показала їх сама (shown — cfl_bank_shown). Рахунок, який перейменували на
     неактуальний пізніше, теж ховається. → Set id */
  const OFF_ACC = /неактуал|not actual|\(видалити\)/i;
  function hiddenAccs(accs, hide, shown) {
    const h = new Set(hide || []), sh = new Set(shown || []);
    for (const a of accs || []) if (OFF_ACC.test(a.name || '') && !sh.has(a.id)) h.add(a.id);
    return h;
  }
  // хто тримає корп. картку на дату (rules.json → reference.cards[].holders) — спільне з вкладкою «Погодження»
  const holderOf = Rc.holderOf;
  /* Поповнення корп. картки, записане не на ту картку власника (04.11.2026: у кожного ФОП по дві діючі картки, і поповнення для нової
     картки Мартиненка 4546 записалось на стару 7850). Самого поповнення в банку немає: Приват списує покупки корп. картки прямо
     з рахунку ФОП, а номер картки є в кожній покупці. Тож куди мали піти гроші, видно з коментаря поповнення і з покупок після нього.
     o: xfers — записи рахунку ФОП «переказ на корп. картку» (opc 4, peer — картка); cards — діючі картки власника тієї самої валюти
     [{id, last4, balance}] (balance — залишок у CRM зараз); tails — номер картки → id; holders — довідник карток (rules.json);
     rows, fileFrom — виписка рахунку ФОП (null — виписки немає).
     Картка, на яку мало піти поповнення (how):
       num — у коментарі номер іншої картки власника (номер саме цієї картки — поповнення правильне);
       holder — у коментарі названо того, хто на дату поповнення тримає іншу картку (тримача цієї картки — правильне);
       bank — коментар нічого не каже, а у виписці після поповнення платить лише інша картка (є покупки з її номером), цією — жодної;
              у CRM та картка в мінусі, а на цій поповнення лишилось невитраченим (її залишок не менший за суму поповнення).
     → [{item, was, to, how, num?, holder?, spent?: {n, sum}}] */
  function wrongTopups(o) {
    const out = [], cards = (o && o.cards) || [], ids = new Set(cards.map(c => c.id)), tails = (o && o.tails) || {};
    if (ids.size < 2) return out;
    const cardOf = id => cards.find(c => c.id === id);
    for (const x of o.xfers || []) {
      const was = Number(x.peer), amount = Math.abs(Number(x.amount));
      if (!ids.has(was)) continue;
      const com = String(x.comment || '');
      const nums = [...com.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map(m => m[1]).filter(n => ids.has(Number(tails[n])));
      if (nums.some(n => Number(tails[n]) === was)) continue;
      if (nums.length) { out.push({ item: x, was, to: Number(tails[nums[0]]), how: 'num', num: nums[0] }); continue; }
      const h = Rc.holderCard(o.holders, com, x.date, id => ids.has(id));
      if (h && (h.ambig || h.id === was)) continue;
      if (h) { out.push({ item: x, was, to: h.id, how: 'holder', holder: h }); continue; }
      // за випискою — лише якщо вона покриває день поповнення
      if (!o.rows || !o.fileFrom || x.date < o.fileFrom) continue;
      const by = id => o.rows.filter(y => y.amount < 0 && (Rc.cardDate(y.purpose) || y.date) >= x.date && Number(tails[Rc.cardTail(y.purpose)]) === id);
      if (by(was).length || !(Number(cardOf(was).balance) - amount >= -0.005)) continue;
      const cand = cards.filter(c => c.id !== was && Number(c.balance) < -0.005 && by(c.id).length);
      if (cand.length !== 1) continue;
      const sp = by(cand[0].id);
      out.push({ item: x, was, to: cand[0].id, how: 'bank', spent: { n: sp.length, sum: r2(-sp.reduce((s, y) => s + y.amount, 0)) } });
    }
    return out;
  }
  /* Період звірки без закритих у CRM місяців (through — «закрито по РРРР-ММ»; їх не звіряємо: змінює їх лише Адмін).
     → {from, to, cut}, де cut — перший відкритий день, якщо «з» довелось пересунути; null — увесь період закрито. */
  function clampToOpen(from, to, through) {
    const open = M.openFrom(through);
    if (!open || from >= open) return { from, to, cut: null };
    return to < open ? null : { from: open, to, cut: open };
  }
  /* Котрий з двох файлів виписки того самого рахунку банку брати за період: що покриває період, з них — що закінчується пізніше; рівно —
     завантажений пізніше (b; S.banks — у порядку завантаження): вечірнє вивантаження за сьогодні замінює ранкове (07.11.2026). */
  const coversP = (x, from, to) => !!(x.fileFrom && x.fileTo && x.fileFrom <= from && x.fileTo >= to);
  function laterBank(b, cur, from, to) {
    if (!cur) return true;
    const a = coversP(b, from, to), c = coversP(cur, from, to);
    return a !== c ? a : (b.fileTo || '') >= (cur.fileTo || '');
  }
  /* Що privat_fetch.py не вивантажив (код ≠ 0): рядки журналу після «НЕ вивантажено:» — «  ФОП … (Моно): HTTP 403 …» → ['ФОП … (Моно): HTTP 403 …'] */
  function notFetched(log) {
    const L = (log || []).map(String), i = L.map(s => /^\s*НЕ вивантажено:/.test(s)).lastIndexOf(true), out = [];
    if (i < 0) return out;
    for (const s of L.slice(i + 1)) { if (!/^\s+\S/.test(s)) break; out.push(s.trim().slice(0, 200)); }
    return out;
  }
  // виписку вивантажено не всю (07.11.2026): що саме не вийшло й що робити — решту все одно звіряємо
  function partialFetchText(log, code) {
    const miss = notFetched(log);
    return `Виписки вивантажено не всі (код ${code}). ${miss.length ? `Не вивантажено: ${miss.join('; ')}.` : 'Частину клієнтів чи банків не вивантажено — див. журнал вище (той самий є в Помічнику).'} Рахунки ${miss.length === 1 ? 'цього клієнта' : 'цих клієнтів'} звірено без нових даних банку (старіша виписка або «немає даних банку»), решту — звірено як завжди. Що робити: трохи пізніше натисніть «Вивантажити заново» (банк міг бути тимчасово недоступний); якщо помилка повторюється — перевірте токен цього клієнта у файлі токенів у папці виписок.`;
  }
  /* Переказ між своїми, якого немає в CRM, а його рух уже є записом іншого типу (витрата на рахунку «звідки» чи надходження на рахунку
     «куди», та сама сума, ±3 дні): створений переказ подвоїв би рух — тип того запису змінюють у «Виправити» (07.11.2026). → запис чи null */
  function xferOtherType(p, fromItems, toItems) {
    const c = Math.round(p.amount * 100), near = x => Math.round(Math.abs(x.amount) * 100) === c && !!x.date && Math.abs(dayDiff(x.date, p.date)) <= 3;
    return (fromItems || []).find(x => x.opc === 2 && near(x)) || (toItems || []).find(x => x.opc === 1 && near(x)) || null;
  }
  // запис invoice-payment: живі рухи рахунку inv з операцією з ops і цією сумою
  const pays = (r, inv, ops, amount) => ((r && r.payments) || []).filter(x => !x.deleted_at && Number(x.invoice_id) === inv && ops.includes(Number(x.operation)) && Math.abs(Number(x.amount) - amount) < 0.005);
  const pay = (r, inv, ops, amount) => pays(r, inv, ops, amount).length > 0;
  /* Перед створенням переказу p (near — записи рахунку «звідки» з цією сумою за ±3 дні, known — ID записів, відомих звірці):
     «вже є» — лише якщо таких переказів у CRM стільки, скільки їх у виписці (p.peers: два однакові перекази за кілька днів — не дубль);
     витрата з тією самою сумою на рахунку «звідки» — навіть відома звірці — стоп: це, можливо, той самий рух іншим типом (07.11.2026). */
  function xferCheck(near, p, amount, known, dmyOf) {
    const dup = near.filter(r => pay(r, p.from, [4], amount) && pay(r, p.to, [3], amount));
    if (dup.length && dup.length >= (p.peers || 1)) return { result: 'вже є', id: dup[0].id, note: `такий переказ уже є: ${dup.map(r => `ID ${r.id} від ${dmyOf(r.date)}`).join(', ')}${(p.peers || 1) > 1 ? ` (у виписці таких ${p.peers})` : ''}` };
    const exp = near.filter(r => pay(r, p.from, [2], amount));
    if (exp.length) return { result: 'перевірте', note: `на рахунку «звідки» є витрата з тією самою сумою за ±3 дні (ID ${exp.map(r => r.id).join(', ')}) — переказ не створено: якщо це той самий рух, змініть тип запису в «Виправити» → «Записи з неправильним типом»` };
    const fresh = near.filter(r => !known.has(r.id) && pay(r, p.from, [4], amount));
    return fresh.length ? { result: 'перевірте', note: `після звірки з'явився запис ID ${fresh.map(r => r.id).join(', ')} з тією самою сумою — переказ не створено, перевірте вручну` } : null;
  }
  // дата для CRM: 'ДД-ММ-РРРР ГГ:ХХ' і період '01-ММ-РРРР'; без часу — полудень
  const crmDate = (iso, time) => {
    const [Y, Mo, D] = iso.split('-'), t = /^\d{1,2}:\d{2}/.test(time || '') ? time.slice(0, 5).padStart(5, '0') : '12:00';
    return { date: `${D}-${Mo}-${Y} ${t}`, period: `01-${Mo}-${Y}` };
  };
  const dayOfCrm = s => { const m = /^(\d{2})-(\d{2})-(\d{4})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; }; // 'ДД-ММ-РРРР …' → РРРР-ММ-ДД
  // час покупки карткою з призначення: «4246 **** **** 7365 31.10.2026 17:33:05 …» → '17:33' (CARD_TIME — вище, у cardComment)
  const cardTime = s => { const m = CARD_TIME.exec(String(s || '')); return m ? m[1] : ''; };
  /* Дата й період нового запису з виписки. Покупка корп. карткою (p.buy) — за датою й часом покупки з призначення, як у CRM (банк
     проводить її за 1–3 дні, і покупка 31.10 потрапляла в листопад); якщо місяць покупки вже закрито в CRM (through — «закрито по»),
     період — перший відкритий місяць, дата лишається датою покупки (07.11.2026). */
  function recWhen(p, through) {
    const d = crmDate(p.buy || p.date, p.buy ? p.buyTime : p.time);
    if (p.buy && through && M.isClosedMonth(p.buy, through)) { const o = M.openFrom(through); if (o) d.period = `01-${o.slice(5, 7)}-${o.slice(0, 4)}`; }
    return d;
  }
  /* Корп. картки, які «Звірка з банком» запам'ятала в цьому браузері (нова картка: номера ще немає ні в назві рахунку CRM, ні в
     rules.json). mergeLocalCards додає їх до довідника rulesDoc.reference.cards — для всіх вкладок панелі; картка з rules.json
     з тим самим номером сильніша. → додані */
  const LOCAL_CARDS = 'cfl_cards_local';
  function mergeLocalCards(rulesDoc) {
    if (!rulesDoc) return [];
    const ref = rulesDoc.reference = rulesDoc.reference || {}, cards = ref.cards = ref.cards || [];
    const add = LS.get(LOCAL_CARDS, []).filter(c => c && /^\d{4}$/.test(String(c.last4)) && Number(c.account_id) > 0 && !cards.some(x => String(x.last4) === String(c.last4)));
    cards.push(...add.map(c => ({ ...c, local: true })));
    return add;
  }
  // продавець з рядка покупки карткою: «4246 **** **** 1665 02.10.2026 04:28:07 Цифровi товари: FACEBK *22AH55AK24, FACEBOOK.COM» → «FACEBK»
  const merchantOf = s => String(s || '').replace(/^.*?\d{2}:\d{2}(?::\d{2})?\s*/, '').replace(/^[^:]{0,40}:\s*/, '').split(',')[0].replace(/\s*\*.*$/, '').trim();
  /* Нові корп. картки у виписках: покупки карткою, номера якої немає в known (номер → рахунок corpCard: назви рахунків CRM і довідник
     rules.json). banks — рахунки з виписок (cfId — рахунок CRM), items — рух рахунків CRM (cashflowByAccount), accs — рахунки CRM.
     Рахунок картки — корп. картка власника рахунку банку, на яку в CRM записано найбільше цих покупок (та сама сума; дата — від дня
     перед покупкою до дня після проведення); без покупок у CRM — єдина картка власника без номера в назві, якої не взяла інша нова картка.
     → [{last4, debit, rows, sum, from, to, cands, sug: {id, why} | null}] */
  function findNewCards({ banks, known, items, accs, from, to }) {
    const nameOf = id => ((accs || []).find(a => a.id === id) || {}).name || `рахунок ${id}`;
    const byT = new Map();
    for (const b of banks || []) {
      if (!b.cfId) continue;
      for (const x of b.rows) {
        if (x.date < from || x.date > to || !(x.amount < 0)) continue;
        const t = Rc.cardTail(x.purpose), d = t && Rc.cardDate(x.purpose);
        if (!d || known[t]) continue;
        const g = byT.get(t) || { last4: t, rows: [], debitN: new Map() };
        byT.set(t, g);
        if (g.rows.some(y => y.date === x.date && y.amount === x.amount && y.purpose === x.purpose)) continue; // той самий рядок з двох виписок
        g.rows.push({ date: x.date, amount: x.amount, purpose: x.purpose, buy: d });
        g.debitN.set(b.cfId, (g.debitN.get(b.cfId) || 0) + 1);
      }
    }
    const corp = (accs || []).filter(a => Rc.isCorp(a));
    const out = [...byT.values()].map(g => {
      const debit = [...g.debitN].sort((a, b) => b[1] - a[1])[0][0], own = Rc.ownerOf(nameOf(debit));
      const cands = corp.filter(a => !own || String(Rc.ownerOf(a.name)).toLowerCase() === own.toLowerCase());
      const hits = new Map();
      for (const x of g.rows) for (const a of cands) {
        if ((items.get(a.id) || []).some(c => c.opc === 2 && Math.abs(Math.abs(c.amount) - Math.abs(x.amount)) < 0.005 && c.date >= addDays(x.buy, -1) && c.date <= addDays(x.date, 1))) hits.set(a.id, (hits.get(a.id) || 0) + 1);
      }
      const best = [...hits].sort((a, b) => b[1] - a[1])[0], dates = g.rows.map(x => x.date).sort();
      return { last4: g.last4, rows: g.rows, debit, cands, sum: r2(g.rows.reduce((s, x) => s + x.amount, 0)), from: dates[0], to: dates[dates.length - 1],
        sug: best ? { id: best[0], why: `у CRM на цей рахунок записано ${best[1]} з ${g.rows.length} ${plural(g.rows.length, 'покупки', 'покупок', 'покупок')}` } : null };
    });
    const taken = new Set(out.filter(c => c.sug).map(c => c.sug.id));
    for (const c of out) {
      if (c.sug) continue;
      const bare = c.cands.filter(a => !/(?<!\d)\d{4}(?!\d)/.test(a.name) && !taken.has(a.id));
      if (bare.length === 1) { c.sug = { id: bare[0].id, why: 'єдина корп. картка власника без номера в назві' }; taken.add(bare[0].id); }
    }
    return out.sort((a, b) => a.last4.localeCompare(b.last4));
  }
  /* «Закриття місяця»: межі місяця m («РРРР-ММ») — з 1-го по останній день, поточний місяць — по сьогодні (full = false:
     місяць ще не закінчився). */
  function monthBounds(m, todayIso) {
    const from = `${m}-01`, last = addDays(M.openFrom(m), -1);
    return { from, last, to: last < todayIso ? last : todayIso, full: last < todayIso };
  }
  // місяць за замовчуванням — поточний, а в перші 10 днів — попередній (його саме закривають)
  const defaultMonth = todayIso => (Number(todayIso.slice(8, 10)) <= 10 ? addDays(todayIso.slice(0, 8) + '01', -1) : todayIso).slice(0, 7);
  const monthName = m => { const s = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 15)).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' }); return s.charAt(0).toUpperCase() + s.slice(1); };
  // касовий метод (уточнення 07.11.2026): виплати 1–5 числа — у місяці оплати, тож «Закриття місяця» не читає погоджень наступного місяця
  const OK_ST = new Set(['ok', 'timing', 'pay', 'expl']);
  // «Виводи з балансу»: погодження реєстру — від 12 днів до періоду (їхні виводи можуть бути в періоді) до 3 днів після; запам'ятаний склад команд
  const WD_BACK = 12, WD_AHEAD = 3, WD_TEAMS = 'cfl_wd_teams';
  const WD_GONE = new Set(['зник у погодженнях']); // рядок прибрано з погоджень — не погодження
  const nPeople = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;
  /* Стан погодження «% з балансу» (рядок CFWithdrawals.match) — для розділу «Виводи з балансу» і «Закриття місяця». → {cls, text} */
  function wdText(r, todayIso) {
    const a = r.a, leads = r.items.filter(w => w.role === 'lead').length, mans = r.items.length - leads;
    if (r.status === 'ok') {
      if (r.how === 'registry') return { cls: 'ok', text: `виводу з балансу немає, але реєстр уніс погодження на всю суму (ID ${a.id}) — витрата в кешфлоу є` };
      const parts = leads && mans ? ` (тімлід + ${nPeople(mans, 'менеджер', 'менеджери', 'менеджерів')})` : r.items.length > 1 ? ` (${nPeople(r.items.length, 'вивід', 'виводи', 'виводів')})` : '';
      return { cls: 'ok', text: `виведено повністю${parts}${a.gross ? ' · сума погодження разом з податками: на руки × 0,9' : ''}` };
    }
    if (r.status === 'ambig') return { cls: 'warn', text: 'не вдалося розкласти: цю суму дають кілька наборів виводів — перевірте вручну' };
    if (r.status === 'wait') return { cls: 'muted', text: 'чекаємо вивід: погодження свіже (виводять зазвичай за 1–3 дні після оплати)' };
    if (r.status === 'none') return { cls: 'bad', text: `виводу ${a.date >= addDays(todayIso, -10) ? 'ще ' : ''}немає` };
    if ((a.team || r.cands.some(w => w.role === 'lead')) && r.sum < a.amount) return { cls: 'bad', text: `вивід тімліда є (${fmt(r.sum)}), а виводів менеджерів на решту ${fmt(r2(a.amount - r.sum))} не знайдено` };
    return { cls: 'bad', text: r.sum < a.amount ? `виведено частково: ${fmt(r.sum)} з ${fmt(a.amount)}` : `виведено більше, ніж погоджено: ${fmt(r.sum)} з ${fmt(a.amount)}` };
  }
  const wdWho = w => `${w.role === 'lead' ? 'тімлід ' : ''}${w.name}`;
  // вивід без погодження: схожий на погодження поза періодом (near) — з підказкою
  const wdNear = n => (n ? `схоже на погодження ${dmy(n.a.date)} «${n.a.recipient}» на ${fmt(n.a.amount)}, але сума не збігається` : '');
  /* Підсумок звірки для плиток над розділами вкладки: рахунки (з рухом, випискою чи залишком, введеним вручну; corpCard, зведений
     з рахунком банку, — у його рядку) — скільки сходиться, розбіжностей і без даних банку; операцій банку без запису (без «схоже на
     переказ» — вони в переказах), записів CRM без операції (без поповнень картки витратою — вони в типах), переказів між своїми без
     пари, записів з неправильним типом, нових корп. карток, поповнень не на ту картку (reps); covered — рахунків, виписка яких покриває період. */
  function bankSummary(all, types, newCards, reps) {
    const accs = all.filter(r => r.status !== 'merged' && (r.R.crm.n > 0 || r.b || r.manual !== undefined));
    const good = accs.filter(r => OK_ST.has(r.status)).length, bad = accs.filter(r => r.status === 'bad' || r.status === 'xfer').length;
    const maybeRows = r => new Set((r.R.own ? r.R.own.maybe : []).map(m => m.row));
    const cnt = f => accs.reduce((s, r) => s + f(r), 0);
    return { accs: accs.length, good, bad, unk: accs.length - good - bad, covered: accs.filter(r => r.R.covered).length,
      missB: cnt(r => (r.R.missing ? r.R.missing.bank.filter(x => !maybeRows(r).has(x)).length : 0)),
      missC: cnt(r => (r.R.missing ? r.R.missing.crm.filter(c => !(r.topups || []).includes(c)).length : 0)),
      own: cnt(r => (r.R.own ? r.R.own.xfers.filter(x => x.state === 'missing' || x.state === 'peer').length + r.R.own.maybe.length : 0)),
      // corpCard, зведений з рахунком банку, у мінусі в CRM — пропозиція поповнення (у переказах між своїми)
      topup: all.filter(r => r.status === 'merged' && Number(r.a.balance) < -0.005).length,
      types: (types || []).length, cards: (newCards || []).length, reps: (reps || []).length };
  }
  /* Готовність місяця до закриття. all — рахунки вкладки (rows()) за місяць, «Що звіряти: усе»; parts: types — «Записи з
     неправильним типом» (typeFixes); lint — перевірка «Статей і проєктів» {checked, counts} або {error}, null — не перевірено;
     reg — погодження з реєстру {from, open, check} або {error}, null — реєстр у цьому браузері не налаштовано; wd — «Виводи з
     балансу» за місяць (CFWithdrawals.summary) або {error}, null — не перевірено; noHelper — Помічник
     не відповів (виписок Привату й Моно немає). Пункт: ok — true (гаразд), false (є що зробити), null (не перевірено).
     → { verdict: 'ready' | 'partial' | 'not', items: [{key, title, ok, text, list}] } */
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
  function mount(el, opts) {
    const api = opts.api, storage = opts.storage;
    // чернетки CRM (core/drafts.js): opts.drafts — {on(), list(), near(запит), post(форма), get(id)}; перемикач — у шапці панелі
    const DR = opts.drafts || null, dOn = () => !!(DR && DR.on());
    // перемикач змінили — звірити заново (з чернетками чи без); якщо панель саме зайнята — одразу після того
    if (DR && DR.subscribe) DR.subscribe(() => { if (S.busy) S.redo = true; else if (S.items) calc(); }); // перемикач змінили — звірити заново (з чернетками чи без)
    // accs — рахунки з balance; items — рух рахунків із записів, датованих з itemsFrom; banks — рахунки з виписок
    // dir — довідник своїх рахунків (Rc.ownDirectory); into — corpCard → рахунок, з яким він звіряється; xp — вибір у списку переказів
    // kind — що звіряти (KIND); rp — вибір у списку «створити запис»; hist — записи рахунків за 120 днів до періоду (підказка статті);
    // cfg — pnl/operation-config (статті з маркетологом, зарплатна категорія); gen — номер звірки (запізнілі відповіді відкидаються);
    // mks — маркетологи [{id, name}] (undefined — ще не читали, null — читаються)
    // фільтр статусів «Рахунків» пам'ятається (cfl_bank_filter, 16.11.2026): щоранку не треба знову ховати «немає даних банку» тощо.
    // Статуси, де є що робити (ST_FIRST), на початку завжди показано — запам'ятаний фільтр не сховає нову розбіжність
    const ST_FIRST = new Set(['bad', 'xfer', 'part']);
    const filter0 = (() => { const v = LS.get('cfl_bank_filter', null); return new Set(Array.isArray(v) ? ST_ORDER.filter(k => v.includes(k) || ST_FIRST.has(k)) : ST_ORDER); })();
    /* Спільний період «Звірки з банком» і «Статей і проєктів» (cfl_period, 16.11.2026): останній звірений чи перевірений СЬОГОДНІ —
       одна вкладка підхоплює період іншої, і він не губиться, коли панель відкрили знову. Іншого дня — як і раніше, сьогодні. */
    const sharedPeriod = () => { const v = LS.get('cfl_period', null), ok = s => /^\d{4}-\d\d-\d\d$/.test(String(s || '')); return v && v.day === today() && ok(v.from) && ok(v.to) && v.from <= v.to ? v : null; };
    let periodSeen = null; // позначка (n) спільного періоду, яку ця вкладка вже врахувала
    const S = { accs: null, ccy: null, items: null, itemsFrom: null, from: null, to: null, banks: [], offsets: null, showHidden: false, busy: false, open: new Set(), filter: filter0,
      dir: null, into: new Map(), xp: new Map(), kind: 'all', rp: new Map(), lastRecs: [], hist: new Map(), histBusy: false, cfg: undefined, gen: 0, mapOpen: false, mks: undefined,
      tp: new Map(), lastTypes: [], cp: new Map(), lastNewCards: [], // tp — вибір у списку «Записи з неправильним типом»; cp — рахунок нової картки (номер → id)
      rpt: new Map(), lastReps: [], // rpt — вибір у списку «Поповнення не на ту картку» (ключ → {on, to})
      sec: ['acc', 'mt', 'add', 'fix', 'wd', 'close'].includes(LS.get('cfl_bank_sec', 'acc')) ? LS.get('cfl_bank_sec', 'acc') : 'acc', rg: new Map(), // sec — розділ вкладки; rg — групи «Операцій банку» (рахунок → розгорнуто)
      mt: null, lastMt: null, mtAi: null, mtBusy: false, // «Зіставлення ШІ»: розрахунок (кеш), відповідь ШІ, ШІ думає
      // bv — версія даних банку: виписки, зіставлення рахунків, картки, вибір переказів (ключ кешу «Зіставлення ШІ»; без неї після
      // повторного вивантаження виписок за той самий період «Внести в CRM» переставав блокувати операції з погодженням)
      bv: 0,
      // ra — підказки ШІ для «Внести в CRM» (операції без статті): набір, про який питали, відповіді за ключем, ще думає, запитів
      ra: { sig: '', res: {}, pending: 0, busy: false, polls: 0, timer: null },
      // wd — погодження реєстру для «Виводів з балансу»: вікно дат, рядки дії bank (null — ще не читали), помилка, номер запиту; wdm — зіставлення (кеш)
      wd: { from: null, to: null, rows: null, error: '', busy: false, seq: 0 }, wdm: null };
    const projects = Object.entries(opts.projects || { 'Україна': 1 });
    // права на кешфлоу (opts.rights — проміс від панелі): без «Повного редагування операцій Cash Flow» CRM не дасть змінити тип запису
    let rights = null;
    const noFull = () => !!(rights && !rights.full);
    if (opts.rights) opts.rights.then(r => { rights = r; if (noFull() && !S.busy && (S.lastTypes.length || S.lastReps.length)) render(); });
    // закриті місяці CRM (opts.closed — від панелі: get / learn / on): не звіряються, записи з них не змінюються й не створюються
    const CL = opts.closed || null, closedTo = () => (CL ? CL.get() : null);
    const shut = x => !!(x && x.per && M.isClosedMonth(x.per, closedTo()));
    const nameOf = id => ((S.accs || []).find(a => a.id === id) || {}).name || `рахунок ${id}`;
    const compiled = opts.rulesDoc ? R.compileRules(opts.rulesDoc) : null;
    const fixFrom = compiled && compiled.fixFrom;
    // корп. картки з довідника rules.json (номер, рахунок corpCard, з якого рахунку списує, хто тримає)
    const CARDS = ((opts.rulesDoc && opts.rulesDoc.reference && opts.rulesDoc.reference.cards) || []).filter(c => c && /^\d{4}$/.test(String(c.last4)) && Number(c.account_id) > 0);
    /* Кошти броніків (rules.json → reference.bronik_accounts; ПРАВИЛА BR-11): на рахунку броніків надходження, ЗП броніків через транзит
       і податки за них у CRM не вносяться — поза звіркою, не «немає в CRM»; дохід компанії — розрахунковий запис «1.5% від бронювання»
       на рахунку share_account_id, руху в банку в нього немає. Перекази між своїми звіряються як завжди (08.11.2026, звірка жовтня). */
    const BRON = (opts.rulesDoc && opts.rulesDoc.reference && opts.rulesDoc.reference.bronik_accounts) || null;
    const BRON_LIST = ((BRON && BRON.accounts) || []).filter(a => a && Number(a.account_id) > 0);
    const BRON_ACC = new Set(BRON_LIST.map(a => Number(a.account_id)));
    const BRON_SHARE = new Set(BRON_LIST.map(a => Number(a.share_account_id)).filter(id => id > 0));
    const BRON_RE = (() => { try { return BRON && BRON.share_regex ? new RegExp(BRON.share_regex, 'iu') : null; } catch (e) { return null; } })();
    // спершу транзит ЗП: повернення з транзитного рахунку (невдала виплата броніку) — теж ЗП броніків, а не їхні кошти з «1.5 %»
    const BRON_IN = 'кошти броніків: у CRM не вносяться — дохід компанії записується окремо, «1.5% від бронювання»';
    const bronSkip = (x, k) => (k === 'own' ? null : k === 'pay' ? 'ЗП броніків через транзитний рахунок — у CRM не вноситься'
      : x.amount > 0 ? BRON_IN : Rc.PAY_TAX.test(x.purpose || '') ? 'податки за броніків — у CRM не вносяться' : null);
    const bronCalc = c => (c.opc === 1 && BRON_RE && BRON_RE.test(c.comment || '') ? 'розрахунковий запис «1.5% від бронювання» — дохід з коштів броніків, руху в банку в нього немає' : null);
    const ARTS =((opts.rulesDoc && opts.rulesDoc.reference && opts.rulesDoc.reference.articles) || [])
      .map(a => ({ key: `${a.category_id}/${a.operation_id}`, type: a.type, group: a.group, label: R.articleLabelOf(a) }));
    const artLabel = k => (ARTS.find(a => a.key === k) || {}).label || `стаття ${k}`;
    const projName = id => (projects.find(([, v]) => Number(v) === Number(id)) || [''])[0];
    /* Особлива стаття: CRM вимагає маркетолога (рекламний бюджет) — 'marketer', його вибирають у рядку;
       зарплатна (CRM може відмовити, 422) — 'salary', такий запис тут не створюється. */
    const salaryArt = k => {
      if (!k) return false;
      const [c, o] = k.split('/').map(Number);
      return c === ((S.cfg && S.cfg.salary && S.cfg.salary.category_id) || M.SALARY_CATEGORY_DEFAULT) || M.SALARY_OPS_DEFAULT.includes(o);
    };
    function artIssue(k) {
      if (!k) return '';
      if (M.marketerArtsOf(S.cfg).has(k)) return 'marketer';
      return salaryArt(k) ? 'salary' : '';
    }
    /* Зарплатна стаття (з 05.11.2026) — запис можна створити, але це ризик: CRM не дає змінювати («Операції по зарплаті не доступні
       для редагування») і видаляти такі записи, тож помилку виправить лише адміністратор CRM. Вікно створення окремо про це попереджає. */
    const ISSUE = { marketer: 'для цієї статті CRM вимагає маркетолога — виберіть його', salary: 'зарплатна стаття: після створення CRM не дасть цей запис ні змінити, ні видалити — перевірте суму, дату, статтю й коментар' };
    // маркетологи — як у реєстрі погоджень: працюють і мають роль «маркетолог» / «маркетинг» або є в його списку
    const MK_IDS = [193, 1249, 1324, 124, 208, 1297, 1328];
    const mkName = id => ((S.mks || []).find(m => m.id === Number(id)) || {}).name || `маркетолог ID ${id}`;
    async function loadMarketers() {
      if (S.mks !== undefined) return;
      S.mks = null;
      let list = [];
      try {
        list = listOf(await api.get('user/?all=true')).filter(u => u.is_working !== false && ((u.role && /маркетолог|маркетинг/i.test(u.role.name || '')) || MK_IDS.includes(Number(u.id))))
          .map(u => ({ id: Number(u.id), name: String(u.name || '').trim() })).sort((a, b) => a.name.localeCompare(b.name, 'uk'));
      } catch (e) {} // без списку — лише маркетологи з попередніх записів рахунку
      S.mks = list;
      if (!S.busy) render();
    }
    el.innerHTML = `
<div class="card">
 <div class="ctl-row">
  <div class="fld"><div class="lbl">Період · дати за Києвом, включно</div><div class="row"><input type="date" data-b="from"><span class="muted">—</span><input type="date" data-b="to">
   <span class="seg sm"><button type="button" data-b="d-t">Сьогодні</button><button type="button" data-b="d-y">Вчора</button><button type="button" data-b="d-m">Цей місяць</button></span></div></div>
  <div class="fld"><div class="lbl">Що звіряти</div><span class="seg" data-b="kind">${Object.entries(KIND).map(([k, t]) => `<button type="button" data-kind="${k}"${k === 'all' ? ' class="on"' : ''}>${t.charAt(0).toUpperCase() + t.slice(1)}</button>`).join('')}</span></div>
  <div class="acts">
   <button class="primary" data-b="fetch" title="Приват і Моно: виписки за період вивантажить «Помічник кешфлоу» вашим privat_fetch.py, потім — звірка">Отримати виписки й звірити</button>
   <button data-b="calc" title="Звірити з уже доданими виписками, без нового вивантаження">Звірити</button>
   <button class="quiet" data-b="pick">Додати файл .json</button><input type="file" data-b="file" accept=".json,application/json" multiple hidden>
   <button class="quiet" data-b="xlsx" disabled>Звіт .xlsx</button>
  </div>
 </div>
 <div class="row" style="margin:8px 0 0"><span class="muted small" data-b="st"></span><span class="muted small" data-b="closed"></span></div>
 <div data-b="flog"></div>
 <div class="muted small" data-b="files" style="margin-top:4px"></div>
 <div data-b="map"></div>
 <details class="hint"><summary>Як читати звірку</summary><div>По кожному рахунку: залишок на початок і кінець періоду, надходження й списання — CRM проти банку, і кількість операцій за кожною сумою (суми бувають не 1:1 з банком, тому рахуються штуки). CRM — так, як його показує CRM. Угорі — підсумок; плитка відкриває свій розділ. «Зіставлення ШІ» — операції банку ↔ погодження реєстру ↔ записи CRM (пакети ЗП по людях, податки, що лишилось — ШІ на кнопку). «Внести в CRM» — чого бракує в CRM (перекази між своїми, операції банку, нові корп. картки), «Виправити» — записи з неправильним типом, «Виводи з балансу» — виводи менеджерів і тімлідів проти погоджень «% менеджера / м-рів / тімліда», «Закриття місяця» — чи можна закривати місяць. Без вашої дії в CRM нічого не змінюється.<br>«Разом з корп. карткою» — картка списує прямо з рахунку: поповнення картки в CRM — рух усередині, а покупки з виписки звіряються з витратами картки. «Різниця залишку … накопичено раніше» — щоб знайти, коли вона з'явилась, поставте ранішу дату «з».</div></details>
</div>
<div data-b="notes"></div>
<div data-b="sum"></div>
<div class="secnav"><span class="seg" data-b="nav"><button type="button" data-sec="acc">Рахунки<span class="cnt" data-n="acc" hidden></span></button><button type="button" data-sec="mt">Зіставлення ШІ<span class="cnt" data-n="mt" hidden></span></button><button type="button" data-sec="add">Внести в CRM<span class="cnt" data-n="add" hidden></span></button><button type="button" data-sec="fix">Виправити<span class="cnt" data-n="fix" hidden></span></button><button type="button" data-sec="wd">Виводи з балансу<span class="cnt" data-n="wd" hidden></span></button><button type="button" data-sec="close">Закриття місяця<span class="cnt" data-n="close" hidden></span></button></span></div>
<div class="card" data-b="closebar" hidden>
 <div class="sub-h"><h3>Закриття місяця</h3><span class="muted small">звірка за весь місяць, «Статті й проєкти», погодження й виводи з балансу — і висновок, чи можна закривати. Нічого не змінює.</span></div>
 <div class="row" style="margin:0"><select data-b="cm"></select><button class="primary" data-b="cm-go" style="margin:0">Перевірити місяць</button><span class="muted small" data-b="cm-st"></span></div>
</div>
<div data-b="out"></div>`;
    const $ = k => el.querySelector(`[data-b="${k}"]`);
    const st = t => { $('st').textContent = t; };
    const note = (t, cls) => $('notes').insertAdjacentHTML('beforeend', `<div class="${cls || 'warn'}">${esc(t)}</div>`);
    const t0 = today(), sp0 = sharedPeriod();
    $('from').value = sp0 ? sp0.from : t0; // за замовчуванням — сьогоднішній день або період, з яким сьогодні вже працювали
    $('to').value = sp0 ? sp0.to : t0;
    if (sp0) periodSeen = sp0.n;
    // вкладку показали знову: період, перевірений тим часом у «Статтях і проєктах», — у поля дат; звірку запускає людина («Звірити»)
    function syncPeriod() {
      const v = sharedPeriod();
      if (!v || v.n === periodSeen || S.busy) return;
      periodSeen = v.n;
      if (v.by === 'bank' || ($('from').value === v.from && $('to').value === v.to)) return;
      $('from').value = v.from; $('to').value = v.to;
      updQuick();
      st(`період ${dmy(v.from)}–${dmy(v.to)} — як у «Статтях і проєктах»; натисніть «Звірити»`);
    }
    // швидкі періоди — сегментований перемикач; позначено той, що збігається з вибраними датами
    function updQuick() {
      const f = $('from').value, t = $('to').value, d = today(), y = addDays(d, -1);
      $('d-y').classList.toggle('on', f === y && t === y);
      $('d-t').classList.toggle('on', f === d && t === d);
      $('d-m').classList.toggle('on', f === d.slice(0, 8) + '01' && t === d && f !== d);
    }
    const setDay = (f, t) => { $('from').value = f; $('to').value = t || f; updQuick(); onPeriod(); };
    $('d-y').onclick = () => setDay(addDays(today(), -1));
    $('d-t').onclick = () => setDay(today());
    $('d-m').onclick = () => setDay(today().slice(0, 8) + '01', today());
    updQuick();
    // розділи вкладки: «Рахунки», «Внести в CRM», «Виправити», «Виводи з балансу», «Закриття місяця» (вибір пам'ятається)
    function applySec() {
      $('nav').querySelectorAll('[data-sec]').forEach(b => b.classList.toggle('on', b.dataset.sec === S.sec));
      $('out').querySelectorAll('section[data-sec]').forEach(s => { s.hidden = s.dataset.sec !== S.sec; });
      $('closebar').hidden = S.sec !== 'close';
      LS.set('cfl_bank_sec', S.sec);
      fitComs($('out').querySelectorAll('section[data-sec]:not([hidden]) textarea.xcom')); // висота полів коментаря — коли розділ видно
    }
    $('nav').querySelectorAll('[data-sec]').forEach(b => b.onclick = () => { S.sec = b.dataset.sec; applySec(); });
    // до першої звірки — пояснення в розділах (закриття місяця — свій рядок з вибором місяця)
    function emptyOut() {
      $('out').innerHTML = ['acc', 'mt', 'add', 'fix', 'wd'].map(k => `<section data-sec="${k}"><div class="empty">Ще не звірено — виберіть період і натисніть «Отримати виписки й звірити» (або «Звірити», якщо виписки вже є).</div></section>`).join('') + '<section data-sec="close"></section>';
    }
    emptyOut();
    applySec();
    $('kind').querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
      S.kind = b.dataset.kind;
      $('kind').querySelectorAll('[data-kind]').forEach(x => x.classList.toggle('on', x === b));
      render();
    });
    $('files').textContent = HINT;
    // поки йдуть запити: головні кнопки вимкнено, решта (у таблиці) приглушена й перевіряє S.busy
    /* чернетки періоду звірки (режим чернеток; інакше undefined): по одному рядку на чернетку — для «Закриття місяця» */
    function draftItems() {
      if (!S.drafts || !S.items) return undefined;
      const seen = new Map();
      for (const [acc, list] of S.items) for (const x of list) if (x.draft && x.date >= S.from && x.date <= S.to && !seen.has(x.id)) seen.set(x.id, { id: x.id, date: x.date, amount: Math.abs(x.amount), name: nameOf(acc) });
      return [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    }
    function busy(on) {
      S.busy = on;
      ['calc', 'fetch', 'pick'].forEach(k => { $(k).disabled = on; });
      $('cm-go').disabled = on || !!S.closing || !$('cm').value;
      el.classList.toggle('is-busy', on);
      // перемикач чернеток змінили, поки панель працювала: звірити заново, щойно вона звільниться (і лише якщо є що звіряти)
      if (!on && S.redo) setTimeout(() => { if (S.busy || !S.redo) return; S.redo = false; if (S.items) calc(); }, 0);
    }
    function period() {
      const from = $('from').value, to = $('to').value;
      if (!from || !to || from > to) { note('Перевірте період: дата «з» має бути не пізніше дати «по».', 'err'); return null; }
      // закриті в CRM місяці не звіряються: «з» — не раніше першого відкритого дня
      const c = clampToOpen(from, to, closedTo());
      if (!c) {
        S.items = null; $('out').innerHTML = '';
        note(`${dmy(from)}–${dmy(to)}: ці місяці закрито в CRM (по ${M.monthUa(closedTo())}) — їх не звіряємо: змінювати їх може лише Адмін.`, 'warn');
        return null;
      }
      if (c.cut) { $('from').value = c.cut; note(`Місяці по ${M.monthUa(closedTo())} закрито в CRM — звіряю з ${dmy(c.cut)}.`, 'info'); }
      // період, який справді звіряють, — спільний з «Статтями й проєктами»
      periodSeen = Date.now();
      LS.set('cfl_period', { from: c.from, to: c.to, day: today(), by: 'bank', n: periodSeen });
      return { from: c.from, to: c.to };
    }
    function updClosed() { $('closed').textContent = closedTo() ? `· закрито в CRM по ${M.monthUa(closedTo())} — не звіряється` : ''; }
    updClosed();
    // «Закриття місяця»: місяці від межі роботи (fix_from) і першого відкритого в CRM до поточного; закриті не пропонуються
    function fillMonths() {
      const cur = today().slice(0, 7), want = $('cm').value || defaultMonth(today()), list = [];
      for (let m = [M.monthOf(fixFrom) || cur, closedTo() ? M.openFrom(closedTo()).slice(0, 7) : null].filter(Boolean).sort().pop(); m <= cur; m = M.openFrom(m).slice(0, 7)) list.push(m);
      $('cm').innerHTML = list.length ? list.map(x => `<option value="${x}"${x === want ? ' selected' : ''}>${esc(monthName(x))}</option>`).join('') : '<option value="">— відкритих місяців немає —</option>';
      $('cm-go').disabled = S.busy || !!S.closing || !list.length;
    }
    fillMonths();
    if (CL) CL.on(() => {
      updClosed();
      fillMonths();
      if (!S.items || S.busy) return;
      const c = clampToOpen(S.from, S.to, closedTo());
      if (!c) { S.items = null; $('out').innerHTML = ''; st(`${dmy(S.from)}–${dmy(S.to)}: місяці закрито в CRM — не звіряються`); return; }
      if (c.cut) { S.from = c.cut; $('from').value = c.cut; }
      render();
    });

    // ---------- читання CRM (лише GET) ----------
    async function pages(path, onPage) {
      const byId = new Map();
      for (let p = 1; p <= 1000; p++) {
        const j = await api.get(`${path}&per_page=500&page=${p}`);
        for (const r of listOf(j)) byId.set(r.id, r);
        if (onPage) onPage(p, j && j.last_page);
        if (Array.isArray(j) || !j.last_page || p >= j.last_page) break;
      }
      return [...byId.values()];
    }
    async function loadAccounts() {
      const all = new Map();
      for (let p = 1; p <= 50; p++) {
        const j = await api.get(`invoice?page=${p}&per_page=100`);
        for (const a of listOf(j)) all.set(a.id, a);
        if (Array.isArray(j) || !j.last_page || p >= j.last_page) break;
      }
      const live = [...all.values()].filter(a => !a.deleted_at);
      if (!live.some(a => a.balance !== undefined && a.balance !== null)) throw new Error('CRM не віддав залишки рахунків (поле balance у списку рахунків) — порахувати залишки неможливо.');
      S.accs = live;
      pruneLocalCards();
      if (!S.ccy) S.ccy = Object.fromEntries(listOf(await api.get('currency')).map(c => [c.id, c.code]));
    }
    // картки, запам'ятані в цьому браузері, які тепер видно з назв рахунків CRM (рахунок перейменували з номером чи завели новий), — прибрати
    function pruneLocalCards() {
      const local = LS.get(LOCAL_CARDS, []), gone = new Set(local.filter(c => Rc.staleLocalCard(c, S.accs)).map(c => String(c.last4)));
      if (!gone.size) return;
      LS.set(LOCAL_CARDS, local.filter(c => !gone.has(String(c.last4))));
      const ref = opts.rulesDoc && opts.rulesDoc.reference;
      if (ref && ref.cards) ref.cards = ref.cards.filter(x => !(x.local && gone.has(String(x.last4))));
      for (let i = CARDS.length - 1; i >= 0; i--) if (CARDS[i].local && gone.has(String(CARDS[i].last4))) CARDS.splice(i, 1);
      S.bv++;
      note(`${gone.size === 1 ? 'Картку' : 'Картки'} ${[...gone].map(t => '…' + t).join(', ')} тепер видно з назв рахунків у CRM — запам'ятане в цьому браузері прибрано.`, 'info');
    }
    async function calc() {
      $('notes').innerHTML = '';
      const p = period();
      if (!p) return;
      if (p.to === today()) note(LIVE, 'info');
      busy(true);
      let prevAccs = null;
      try {
        st('читаю рахунки й залишки CRM…');
        prevAccs = S.accs;
        await loadAccounts();
        if (S.cfg === undefined) { try { S.cfg = await api.get('pnl/operation-config'); } catch (e) { S.cfg = null; } }
        const lo = addDays(p.from, -MARGIN);
        let recs = await pages(`invoice-payment?date_from=${dash(lo)}&date_to=${dash(addDays(today(), 730))}`, (n, last) => st(`записи CRM з ${dmy(lo)}: сторінка ${n}/${last || '?'}`));
        /* Режим чернеток (перемикач у шапці): чернетки CRM звіряються як записи — щоб не внести ту саму операцію вдруге. Залишок
           рахунку CRM чернеток не містить, тому до нього додається їхня сума: звірка показує стан «коли чернетки проведуть».
           Вимкнено — жодного запиту до чернеток, усе як раніше. */
        let drafts = null; // у S — лише разом з новими записами: невдале читання не має стерти відомості про чернетки попередньої звірки
        if (dOn()) {
          st('читаю чернетки CRM…');
          let dr;
          try { dr = await DR.list(); } catch (e) {
            throw new Error(`Не вдалося прочитати чернетки CRM (${e.message}) — звірку не виконано. Якщо у вашої ролі немає доступу до чернеток, вимкніть «у чернетки» в шапці панелі.`);
          }
          const liveIds = new Set(recs.map(r => r.id));
          dr = dr.filter(r => !liveIds.has(r.id)); // чернетку щойно провели — вона вже серед записів
          // у звірку й у залишок ідуть ті самі чернетки: з рахунком, сумою й датою (недозаповнені — ні)
          const full = dr.filter(r => r.payments.length && r.date), eff = CFD.balanceEffect(full);
          S.accs = S.accs.map(a => (eff.has(a.id) ? { ...a, balance: r2(Number(a.balance) + eff.get(a.id)), balanceLive: a.balance } : a));
          const inRange = full.filter(r => M.kyivDate(r.date) >= lo);
          recs = recs.concat(inRange);
          drafts = { n: dr.length, used: inRange.length, early: full.length - inRange.length, empty: dr.length - full.length };
        }
        Object.assign(S, { items: Rc.cashflowByAccount(recs), drafts, itemsFrom: lo, from: p.from, to: p.to, offsets: null, hist: new Map(), gen: S.gen + 1 });
        Object.assign(S.wd, { rows: null, error: '' }); // погодження «Виводів з балансу» — теж заново (render прочитає реєстр)
        matchBanks(); renderFiles(); render();
        if (S.drafts) note(`Режим чернеток: враховано чернеток CRM — ${S.drafts.used}${S.drafts.n > S.drafts.used ? ` з ${S.drafts.n}` : ''}${S.drafts.early ? ` (до ${dmy(lo)} — ${S.drafts.early}: вони лише в залишках)` : ''}${S.drafts.empty ? ` (без рахунку, суми чи дати — ${S.drafts.empty}, вони не звіряються)` : ''}. Вони звіряються як записи, а залишки CRM показано так, ніби чернетки вже проведено. Нові записи теж підуть у чернетки.`, 'info');
        st(`готово: ${S.accs.length} ${plural(S.accs.length, 'рахунок', 'рахунки', 'рахунків')} за ${dmy(p.from)}–${dmy(p.to)}; залишки CRM станом на ${new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}`);
      } catch (e) {
        // звірка не вдалась: на екрані лишається попередня — з її ж залишками (інакше нові залишки змішались би зі старими записами й чернетками)
        if (prevAccs && S.items) S.accs = prevAccs;
        note(e.message, 'err'); st('помилка');
      }
      finally { busy(false); }
    }
    $('calc').onclick = calc;
    const onPeriod = () => {
      updQuick();
      let from = $('from').value;
      const to = $('to').value;
      if (!S.items || !from || !to || from > to) return;
      const c = clampToOpen(from, to, closedTo());
      if (!c) { st(`${dmy(from)}–${dmy(to)}: місяці закрито в CRM — не звіряються`); return; }
      if (c.cut) { from = c.cut; $('from').value = from; }
      if (from >= addDays(S.itemsFrom, MARGIN)) { S.from = from; S.to = to; render(); st(`період ${dmy(from)}–${dmy(to)}`); }
      else st('для ранішого періоду натисніть «Звірити»');
    };
    $('from').onchange = onPeriod;
    $('to').onchange = onPeriod;

    // ---------- виписки: Помічник кешфлоу або файл ----------
    function addBankJson(json, name) {
      if (!json || !Array.isArray(json.accounts)) throw new Error('немає списку рахунків');
      const accs = Rc.bankAccounts(json, name).filter(b => b.rows.length || b.opening != null || b.closing != null);
      if (!accs.length) throw new Error('у файлі немає ні операцій, ні залишків');
      S.banks = S.banks.filter(b => b.fileName !== name).concat(accs);
      S.bv++;
    }
    async function afterStatements() {
      if (!S.accs) { try { st('читаю рахунки CRM…'); await loadAccounts(); } catch (e) { note(e.message, 'err'); } }
      matchBanks(); renderFiles();
      if (S.items) render();
    }
    $('pick').onclick = () => $('file').click();
    $('file').onchange = async () => {
      const files = [...$('file').files];
      $('file').value = '';
      for (const f of files) {
        try { addBankJson(JSON.parse(await f.text()), f.name); } catch (e) { note(`${f.name}: не схоже на виписку з «Помічника» чи privat_fetch.py (${e.message}).`, 'err'); }
      }
      await afterStatements();
    };
    const helperUrl = () => String(LS.get('cfl_helper_url', 'http://127.0.0.1:8765')).replace(/\/+$/, '');
    async function hreq(path, init) {
      const r = await fetch(helperUrl() + path, { cache: 'no-store', ...(init || {}) });
      let j = null;
      try { j = await r.json(); } catch (e) {}
      if (!r.ok) throw Object.assign(new Error((j && j.error) || `Помічник: HTTP ${r.status}`), { helper: true });
      return j;
    }
    const flog = (lines, cls) => { $('flog').innerHTML = lines && lines.length ? `<pre class="${cls || ''}" style="margin:8px 0 0;max-height:150px">${esc(lines.join('\n'))}</pre>` : ''; };
    async function fetchStatements(force) {
      $('notes').innerHTML = '';
      const p = period();
      if (!p) return;
      if (p.to > today()) { note('Дата «по» пізніша за сьогодні.', 'err'); return; }
      // файл, вивантажений не пізніше останнього дня періоду, міг бути проміжним (день ще не закрито): беремо заново —
      // для періоду по сьогодні, якщо він старший за 30 хв, для минулого періоду — завжди (інакше вчорашні вечірні операції губились)
      const live = p.to === today();
      const stale = f => String(f.mtime || '').slice(0, 10) <= p.to && (!live || Date.now() - new Date(f.mtime).getTime() > 30 * 60000);
      const later = []; // підказки після звірки: calc() очищає повідомлення
      busy(true);
      try {
        let info;
        try { info = await hreq('/api/panel/bank/status'); } catch (e) { if (e.helper) throw e; note(HELPER_DOWN, 'err'); return; }
        // Помічник віддає лінтер із своєї папки: якщо там новіша збірка, ніж відкрита зараз, — підказати
        if (info.linter && typeof CF_BUILD === 'string' && info.linter > CF_BUILD) later.push([`Є новіша версія лінтера (зібрано ${new Date(info.linter).toLocaleString('uk-UA')}): закрийте панель (✕) і натисніть закладку ще раз.`, 'info']);
        if (!info.bank || !info.bank.script) { note(`У папці виписок Помічника (${(info.bank && info.bank.dir) || '?'}) немає privat_fetch.py — вкажіть папку в «Налаштуваннях» Помічника.`, 'err'); return; }
        const name = `виписка_ВСІ_${dmy(p.from)}_${dmy(p.to)}.json`;
        const have = (await hreq('/api/panel/bank/files')).files.find(f => f.name === name);
        // файл записано цим вивантаженням (час файлу — до хвилини, початок — до секунди), а не лишився від попереднього
        const fromJob = (f, j) => !!(f && j && j.started && String(f.mtime || '') >= String(j.started).slice(0, 16));
        if (have && !force && !stale(have) && !(info.job && info.job.running)) {
          addBankJson(await hreq('/api/panel/bank/file?name=' + encodeURIComponent(name)), name);
          flog(null);
          $('flog').innerHTML = `<div class="info">Узято вже вивантажені виписки за ${esc(dmy(p.from))}–${esc(dmy(p.to))} (файл від ${esc(have.mtime.replace('T', ' '))}). <span class="lnk" data-b="refetch">Вивантажити заново</span></div>`;
          $('flog').querySelector('[data-b="refetch"]').onclick = () => fetchStatements(true);
          // цей файл — з вивантаження, де частину не вивантажено: нагадати, чого в ньому бракує (07.11.2026)
          const j0 = info.job || {};
          if (j0.code !== 0 && j0.code != null && j0.file === name && fromJob(have, j0)) later.push([partialFetchText(j0.log, j0.code)]);
        } else {
          if (!(info.job && info.job.running)) await hreq('/api/panel/bank/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: p.from, to: p.to }) });
          let job = info.job || {};
          // Моно віддає 1 запит на хвилину: довго — лише з валютними рахунками (галочка в Помічнику) чи за період понад 31 день
          const slow = !!(info.bank && info.bank.mono_currency) || dayDiff(p.to, p.from) >= 31;
          for (let i = 0; ; i++) {
            await new Promise(r => setTimeout(r, i ? 1500 : 400));
            job = await hreq('/api/panel/bank/job');
            st(job.running ? `Помічник вивантажує виписки${job.args ? ` за ${dmy(job.args[0])}–${dmy(job.args[1])}` : ''}…${slow ? ' (Моно віддає 1 запит на хвилину — це може тривати кілька хвилин)' : ''}` : '');
            flog((job.log || []).slice(-8));
            if (!job.running) break;
          }
          /* privat_fetch.py записує файл з усім, що вдалось, і повертає код 1, якщо не вдалось хоч одного клієнта чи банку (токен, збій банку):
             такий файл звіряємо, з попередженням, чого бракує (07.11.2026). Без свіжого файлу — помилка, як і було */
          const partial = job.code !== 0 && !!job.file;
          if (partial && !fromJob((await hreq('/api/panel/bank/files')).files.find(f => f.name === job.file), job)) job.file = null;
          if (!job.file) { flog((job.log || []).slice(-15), 'err'); note(`Вивантаження завершилось з помилкою (код ${job.code}), виписок не отримано. Журнал — вище; той самий журнал є в Помічнику.`, 'err'); return; }
          if (job.args && (job.args[0] !== p.from || job.args[1] !== p.to)) later.push([`Помічник щойно вивантажив інший період (${dmy(job.args[0])}–${dmy(job.args[1])}) — натисніть «Отримати виписки й звірити» ще раз.`]);
          addBankJson(await hreq('/api/panel/bank/file?name=' + encodeURIComponent(job.file)), job.file);
          if (partial) {
            later.push([partialFetchText(job.log, job.code)]);
            flog((job.log || []).slice(-15), 'err');
            $('flog').insertAdjacentHTML('beforeend', `<div class="warn">Виписки отримано о ${new Date().toTimeString().slice(0, 5)} не всі: ${esc(job.file)}. <span class="lnk" data-b="refetch">Вивантажити заново</span></div>`);
            $('flog').querySelector('[data-b="refetch"]').onclick = () => fetchStatements(true);
          } else {
            flog(null);
            $('flog').innerHTML = `<div class="info">Виписки отримано о ${new Date().toTimeString().slice(0, 5)}: ${esc(job.file)}.</div>`;
          }
        }
        if (!S.items || S.from !== p.from || S.to !== p.to) { busy(false); await calc(); } else { if (live) note(LIVE, 'info'); await afterStatements(); }
        later.forEach(([t, c]) => note(t, c));
      } catch (e) { note(e.message, 'err'); st('помилка'); }
      finally { busy(false); }
    }
    $('fetch').onclick = () => fetchStatements(false);

    // ---------- закриття місяця: звірка за весь місяць + «Статті й проєкти» + погодження → чи можна закривати ----------
    /* Веб-застосунок реєстру, дія bank — лише читання рядків «Реєстру» й «Архіву» за датою оплати (посилання й ключ — налаштування
       реєстру в цьому браузері). → відповідь {rows, startDate, …} або null (реєстр тут не налаштовано) */
    const regCfg = () => { const c = LS.get('pogodzh_cfg_v1', null); return c && c.url && c.key ? c : null; };
    async function regFetch(from, to) {
      const cfg = regCfg();
      if (!cfg) return null;
      /* Дія bank читає «Реєстр» як є, а нові погодження потрапляють у нього лише при оновленні (дія pending — та сама, що «1. Отримати
         й перевірити» у «Погодженні»). Без неї «Звірка» не бачила погоджень останніх днів: 16.11.2026 — 5 пакетів ЗП і реінвест
         ФОП Привільної за 12–13.11 лишились «без погодження». Тому перед читанням реєстр оновлюється (не частіше ніж раз на 5 хвилин);
         не вдалось — читаємо як є і кажемо про це. */
      if (!S.wd.sync || Date.now() - S.wd.sync.at > 5 * 60 * 1000) {
        const sync = { at: Date.now(), error: '' };
        try {
          const rs = await fetch(`${cfg.url}${cfg.url.includes('?') ? '&' : '?'}action=pending&key=${encodeURIComponent(cfg.key)}`, { redirect: 'follow' });
          const js = await rs.json();
          if (!js.ok) sync.error = js.error || `HTTP ${rs.status}`; else if (js.syncError) sync.error = js.syncError;
        } catch (e) { sync.error = e.message || String(e); }
        if (sync.error) sync.at = 0; // наступного разу — ще одна спроба
        S.wd.sync = sync;
        if (sync.error) note(`Реєстр погоджень не вдалося оновити з таблиці «Погодження виплат» (${sync.error}) — погодження останніх днів можуть бути не враховані. Оновіть його у вкладці «Погодження» («1. Отримати й перевірити») і звірте ще раз.`, 'warn');
      }
      const r = await fetch(`${cfg.url}${cfg.url.includes('?') ? '&' : '?'}action=bank&key=${encodeURIComponent(cfg.key)}&from=${from}&to=${to}`, { redirect: 'follow' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    }
    /* Погодження з from по to, ще не внесені в кешфлоу. Рядки до «Починати з дати» реєстру не беруться — їх реєстр і не вносить.
       → {from, to, open: «так», check: «перевірити»} */
    function regOpen(j, from, to) {
      const start = j.startDate && j.startDate > from ? j.startDate : from;
      const rows = (j.rows || []).filter(x => x.date >= start && x.date <= to && !x.id && !['внесено', 'вже є', 'зник у погодженнях', 'змінено після внесення'].includes(x.status));
      return { from: start, to, open: rows.filter(x => x.action === 'так'), check: rows.filter(x => x.action === 'перевірити') };
    }
    // погодження для «Виводів з балансу» (S.wd); відповідь старішого запиту, ніж останній, відкидається
    async function wdLoad(from, to) {
      const seq = ++S.wd.seq;
      Object.assign(S.wd, { busy: true, error: '' });
      try {
        const j = await regFetch(from, to);
        // ver — номер прочитаних даних: кеш «Зіставлення ШІ» й «Виводів» тримається на ньому, а не на номері запиту (seq змінюється ще до
        // відповіді — і розрахунок на старих рядках лишався в кеші назавжди: після зміни періоду погодження нових днів не бачились, огляд 16.11.2026)
        if (seq === S.wd.seq) { Object.assign(S.wd, j ? { from, to, rows: j.rows || [] } : { rows: null }); S.wd.ver = (S.wd.ver || 0) + 1; }
        return j;
      } catch (e) {
        if (seq === S.wd.seq) S.wd.error = e.message || String(e);
        throw e;
      } finally {
        if (seq === S.wd.seq) S.wd.busy = false;
      }
    }
    // вікно погоджень для звірки виводів за період: від WD_BACK днів до «з» до WD_AHEAD днів після «по»
    const wdWin = () => ({ from: addDays(S.from, -WD_BACK), to: addDays(S.to, WD_AHEAD) });
    // після звірки чи зміни періоду — прочитати погодження, якщо прочитаних не вистачає (у фоні; «Закриття місяця» читає реєстр саме)
    function wdEnsure() {
      if (!S.items || S.closing || S.wd.busy || S.wd.error || !regCfg()) return;
      const w = wdWin();
      if (S.wd.rows && S.wd.from <= w.from && S.wd.to >= w.to) return;
      const show = () => { if (S.busy) setTimeout(show, 300); else render(); }; // поки йде звірка, вона сама перемалює вкладку наприкінці
      wdLoad(w.from, w.to).catch(() => {}).then(show);
    }
    /* Зіставлення виводів з балансу (усі записи «Підтвердження виведення коштів…», прочитані звіркою) з погодженнями реєстру:
       показуються погодження з датою оплати в періоді; решта — лише щоб їхні виводи не були «без погодження».
       → {res, sum, nW: виводів за період} або null (погоджень ще немає) */
    function wdCalc() {
      if (!S.items || !S.wd.rows) return null;
      const key = [S.gen, S.from, S.to, S.wd.ver || 0, S.wd.busy ? 'b' + S.wd.seq : ''].join('|');
      if (S.wdm && S.wdm.key === key) return S.wdm;
      const ap = S.wd.rows.filter(x => !WD_GONE.has(x.status)).map(x => { const a = WD.parseApproval(x); if (a) a.report = x.date >= S.from && x.date <= S.to; return a; }).filter(Boolean);
      const ws = [], seen = new Set();
      for (const list of S.items.values()) for (const x of list) { const w = !seen.has(x.id) && WD.parseWithdrawal(x); if (w) { seen.add(x.id); ws.push(w); } }
      const res = WD.match(ap, ws, { teams: LS.get(WD_TEAMS, {}), today: today() });
      LS.set(WD_TEAMS, res.teams);
      S.wdm = { key, res, sum: WD.summary(res, S.from, S.to), nW: ws.filter(w => w.date >= S.from && w.date <= S.to).length };
      return S.wdm;
    }
    // для «Закриття місяця» і лічильника: підсумок, {error} або null (реєстр не налаштовано чи ще читається)
    const wdPart = () => (S.wd.error ? { error: S.wd.error } : !regCfg() ? null : (wdCalc() || {}).sum || null);
    const WD_ROW = { ok: 's-ok', diff: 's-bad', none: 's-bad', ambig: 's-part', wait: '' }, WD_ORDER = { none: 0, diff: 1, ambig: 2, wait: 3, ok: 4 };
    // розділ «Виводи з балансу»: погодження періоду (спершу ті, що не зійшлися) і виводи без погодження
    function wdHtml() {
      const head = `<div class="card" data-b="wd"><div class="sub-h"><h3>Виводи з балансу за ${esc(dmy(S.from))}–${esc(dmy(S.to))}</h3><span class="muted small">погодження «% менеджера / м-рів / тімліда» ↔ записи «Підтвердження виведення коштів з балансу…» у CRM</span></div>
<details class="hint" style="margin:0 0 10px"><summary>Як це звіряється</summary><div>Кожне підтвердження виведення у вкладці «Баланс» CRM — окремий запис кешфлоу на одну людину. Погодження «% м-рів та тімліда» — це вивід тімліда і виводи його менеджерів разом: склад команди CRM не віддає, тож лінтер шукає набір виводів, що дає рівно суму погодження (лише якщо такий набір один), і запам'ятовує склад для наступних тижнів (у цьому браузері). Вивід шукається спершу в найближчі дні після дати оплати погодження, потім — від 3 днів до неї до 10 днів після. Погодження до 05.10.2026 «разом з податками»: на руки = сума × 0,9. Погодження, яке реєстр уніс на всю суму, — витрата в кешфлоу вже є: вивід з балансу до нього означав би витрату двічі. Лише звірка — нічого не створюється й не змінюється.</div></details>`;
      if (!regCfg()) return `${head}<div class="info">Реєстр погоджень у цьому браузері не налаштовано (⚙ у вкладці «Погодження») — звіряти виводи немає з чим.</div></div>`;
      if (S.wd.error) return `${head}<div class="err">Реєстр погоджень не відповів: ${esc(S.wd.error)} <span class="lnk" data-b="wdretry">Спробувати ще раз</span></div></div>`;
      const W = wdCalc();
      if (!W) return `${head}<div class="info">Читаю погодження з реєстру…</div></div>`;
      const s = W.sum, t0 = today(), nT = Object.keys(LS.get(WD_TEAMS, {})).length;
      const teams = nT ? `<div class="muted small" style="margin-top:10px">Запам'ятаний склад команд: ${nT} <span class="lnk" data-b="wdreset">скинути</span></div>` : '';
      const rep = W.res.rows.filter(r => r.a.report !== false).sort((p, q) => (WD_ORDER[p.status] - WD_ORDER[q.status]) || (p.a.date < q.a.date ? -1 : p.a.date > q.a.date ? 1 : 0));
      if (!rep.length && !s.extra) return `${head}<div class="empty">За період погоджень «% менеджера / м-рів / тімліда» немає${W.nW ? ` — виводи з балансу за період (${W.nW}) за погодженнями попередніх днів` : ', виводів з балансу — теж'}.</div>${teams}</div>`;
      const pill = (cls, t) => `<span class="pill ${cls}">${esc(t)}</span>`;
      let h = `${head}<div class="row" style="margin:0 0 10px"><span>Погоджень: <b>${s.n}</b>${s.n ? ` на ${esc(fmt(s.approved))}` : ''}</span>${s.ok ? pill('st-ok', `виведено повністю: ${s.ok}`) : ''}${s.diff ? pill('st-manual', `сума не збігається: ${s.diff}`) : ''}${s.none ? pill('st-manual', `виводу немає: ${s.none}`) : ''}${s.ambig ? pill('st-review', `не вдалося розкласти: ${s.ambig}`) : ''}${s.wait ? pill('st-locked', `чекаємо вивід: ${s.wait}`) : ''}${pill(s.extra ? 'st-manual' : 'st-locked', `виводів без погодження: ${s.extra}`)}${s.double.length ? pill('st-manual', `схоже на витрату двічі: ${s.double.length}`) : ''}</div>`;
      const wl = w => `<div>${esc(wdWho(w))} · <b>${esc(fmt(w.amount))}</b> · ${esc(dmy(w.date).slice(0, 5))} <span class="muted">ID ${w.id}</span></div>`;
      if (rep.length) {
        h += `<div class="tbl" style="max-height:64vh"><table class="xf"><tr><th>Дата оплати</th><th>Погодження</th><th class="n">Погоджено</th><th class="n">Виведено</th><th>Стан</th><th>Виводи з балансу (записи CRM)</th></tr>`;
        for (const r of rep) {
          const a = r.a, st = wdText(r, t0), dbl = s.double.includes(r), list = r.status === 'ok' ? r.items : r.cands;
          h += `<tr class="${WD_ROW[r.status]}"><td style="white-space:nowrap">${esc(dmy(a.date))}</td>
<td><b>${esc(a.recipient || '—')}</b><div class="muted" style="font-size:12px">${esc(a.content.slice(0, 140))}</div></td>
<td class="n">${esc(fmt(a.amount))}${a.gross ? '<div class="muted" style="font-weight:400;font-size:12px">разом з податками</div>' : ''}</td>
<td class="n">${r.status === 'ok' && r.how !== 'registry' || r.cands.length ? esc(fmt(r.sum)) : '<span class="muted">—</span>'}</td>
<td class="${st.cls === 'warn' ? '' : st.cls}" style="font-weight:${st.cls === 'bad' ? 700 : 400}">${esc(st.text)}${dbl ? `<div class="warn" style="margin:4px 0 0;padding:4px 8px;font-weight:400">реєстр уніс це погодження на всю суму (ID ${a.id}), і є вивід з балансу — витрата двічі?</div>` : ''}</td>
<td class="xwhy">${list.length ? (r.status === 'ok' ? '' : '<div class="muted">знайдено лише:</div>') + list.map(wl).join('') : r.status === 'none' || r.status === 'wait' ? `<span class="muted">шукав з ${esc(dmy(addDays(a.date, -3)))} по ${esc(dmy(addDays(a.date, 10)))}</span>` : '<span class="muted">—</span>'}</td></tr>`;
        }
        h += '</table></div>';
      }
      if (s.extra) {
        h += `<div class="lbl" style="margin:14px 0 6px">Виводи без погодження · ${s.extra}</div><div class="tbl" style="max-height:40vh"><table class="xf"><tr><th>Дата</th><th>Хто</th><th class="n">Сума</th><th>Рахунок CRM</th><th>Запис CRM</th></tr>
${s.extraList.map(({ w, near }) => `<tr class="s-bad"><td style="white-space:nowrap">${esc(dmy(w.date))}</td><td>${esc(wdWho(w))}</td><td class="n">${esc(fmt(w.amount))}</td><td>${esc(w.acc != null ? nameOf(w.acc) : '—')}</td><td>ID ${w.id}${near ? `<div class="muted xwhy">${esc(wdNear(near))}</div>` : ''}</td></tr>`).join('')}</table></div>`;
      }
      return h + teams + '</div>';
    }
    function bindWd() {
      const q = k => $('out').querySelector(`[data-b="${k}"]`);
      if (q('wdretry')) q('wdretry').onclick = () => { S.wd.error = ''; render(); };
      if (q('wdreset')) q('wdreset').onclick = () => { LS.set(WD_TEAMS, {}); S.wdm = null; render(); };
    }

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
    function rowHtml(r, hid) {
      const a = r.a, R = r.R, b = r.b, notes = [];
      const closeExtra = !b && r.status !== 'merged' ? `<input class="man" data-man="${a.id}" value="${r.manual !== undefined ? esc(Number(r.manual).toFixed(2).replace('.', ',')) : ''}" placeholder="банк: ввести" inputmode="decimal" title="Залишок у банку на кінець ${dmy(S.to)}, у валюті рахунку CRM (${esc(r.ccy)})">` : undefined;
      let cnt;
      const c = r.card, nB = c && c.missB.length, nC = c && c.missC.length;
      if (r.status === 'merged') cnt = !c ? `<div class="muted">звіряється разом з рахунком банку</div><div class="muted">операцій у CRM: ${R.crm.n}</div>`
        : !nB && !nC ? `<div class="ok">✓ покупки сходяться</div><div class="muted">карткою у виписці: ${c.bank.length} · у CRM: ${c.crm.length}</div>`
        : `<div class="bad">${[nB ? `немає в CRM: ${nB}` : '', nC ? `немає в банку: ${nC}` : ''].filter(Boolean).join(' · ')}</div><div class="muted">карткою у виписці: ${c.bank.length} · у CRM: ${c.crm.length}</div>`;
      else if (r.status === 'ccy') cnt =`<div class="muted">інша валюта — не порівнюється</div><div class="muted">операцій у CRM: ${R.crm.n}</div>`;
      else if (R.covered) cnt = R.amounts.length ? `<div class="bad">${R.amounts.length} ${R.amounts.length === 1 ? 'сума не сходиться' : R.amounts.length < 5 ? 'суми не сходяться' : 'сум не сходяться'}</div><div class="muted">операцій: CRM ${R.crm.n}, банк ${R.bank.n}</div>`
        : `<div class="ok">✓ сходиться</div><div class="muted">операцій: ${R.crm.n} · різних сум: ${R.distinct}${explained(R) ? ` · пояснено: ${explained(R)}` : ''}${R.pay ? ` · ЗП не звіряється: ${R.pay.bank.length + R.pay.crm.length}` : ''}</div>`;
      else cnt = `<div class="muted">${b ? 'виписка не покриває період' : 'потрібна виписка'}</div><div class="muted">операцій у CRM: ${R.crm.n}</div>`;
      if (b) notes.push(esc(srcOf(b) + (b.iban ? ' · ' + tail(b.iban) : '')));
      else if (r.status === 'merged') {
        notes.push(esc(`списує з рахунку «${nameOf(r.into)}» — покупки з його виписки звіряються з витратами картки`));
        const few = (xs, f) => xs.slice(0, 4).map(f).join(' · ') + (xs.length > 4 ? ` і ще ${xs.length - 4}` : '');
        if (nB) notes.push(`<span class="bad" style="font-weight:400">${esc(`покупки карткою, яких немає в CRM: ${few(c.missB, x => `${dmy(Rc.cardDate(x.purpose) || x.date)} ${fmt(Math.abs(x.amount))}${merchantOf(x.purpose) ? ' ' + merchantOf(x.purpose) : ''}`)}`)}</span>`);
        if (nC) notes.push(`<span class="bad" style="font-weight:400">${esc(`витрати картки в CRM без покупки у виписці: ${few(c.missC, x => `${dmy(x.date)} ${fmt(Math.abs(x.amount))} (ID ${x.id})`)}`)}</span>`);
        if (Number(a.balance) < -0.005) notes.push(`<span class="bad" style="font-weight:400">${esc(`баланс у CRM зараз ${fmt(Number(a.balance))}: витрат з картки більше, ніж поповнень — поповнення запропоновано в розділі «Внести в CRM»`)}</span>`);
      }
      else if (r.manual !== undefined) notes.push('залишок банку введено вручну');
      else if (Rc.isCorp(a) && S.dir) notes.push(esc(`картка не звіряється: ${cardWhy(a)}`));
      r.warn.forEach(w => notes.push(`<span class="bad" style="font-weight:400">${esc(w)}</span>`));
      if (r.offset !== undefined && !isZero(r.offset)) notes.push(`<span class="bad" title="balance рахунку в CRM мінус сума всіх його записів">залишок CRM ≠ сума записів: ${fmt(r.offset)}</span>`);
      const [cls, label] = ST[r.status];
      const canDet = R.covered && r.status !== 'ccy', det = canDet && S.open.has(a.id), sub = subHtml(r);
      let h = `<tr data-acc="${a.id}" class="acc s-${r.status}${hid ? ' hid' : ''}"><td><span class="an">${esc(a.name)}</span> <span class="muted">id ${a.id} · ${esc(r.ccy)}</span><div><span class="badge ${cls}">${label}</span></div>${notes.length ? `<div class="nt">${notes.join('<br>')}</div>` : ''}</td>
${metric(r, 'open')}${metric(r, 'cred')}${metric(r, 'deb')}${metric(r, 'close', closeExtra)}<td class="cnt">${cnt}</td>
<td class="act">${canDet ? `<button class="det-btn" data-det="${a.id}" title="${det ? 'Згорнути операції' : 'Усі операції банку й записи CRM за період — зі станом кожної'}">Деталі ${det ? '▴' : '▾'}</button>` : ''}<button class="eye" data-hide="${a.id}" title="${hid ? 'Показати рахунок у таблиці' : 'Сховати рахунок із таблиці'}">${hid ? EYE_OFF : EYE}</button></td></tr>`;
      if (sub) h += `<tr class="sub s-${r.status}${hid ? ' hid' : ''}"><td colspan="7">${sub}</td></tr>`;
      if (det) h += `<tr class="det"><td colspan="7">${detHtml(r)}</td></tr>`;
      return h;
    }
    // скільки різниць пояснено (суми не 1:1, дати проведення покупок карткою) — для вибраного типу
    const explained = R => (R.multi || []).filter(g => S.kind === 'all' || (R.kinds && R.kinds.get(g.bank[0])) === S.kind).length +
      (R.timing || []).filter(t => S.kind === 'all' || S.kind === ((t.bank || t.crm).amount > 0 ? 'credit' : 'debit')).length;
    const opB = x => `${dmy(x.date)}${x.time ? ' ' + x.time : ''} · ${x.cpty || '—'}${x.purpose ? ' · ' + x.purpose : ''}`;
    const opC = x => `${dmy(x.date)} · ID ${x.id}${x.lead ? ' (лід)' : ''} · ${x.comment || x.op}`;
    /* Пояснені групи звірки (periodRecon → multi, why) — словами: під рахунком, у «Деталях» і в звіті (08.11.2026). */
    const GW_HEAD = { '': 'Суми не 1:1', 'card-day': 'Покупки корп. картки за день — одним записом CRM', liqpay: 'LiqPay: оплата ліда + запис «Комісія LiqPay» = зарахування в банку',
      'tax-day': 'Податки із ЗП за день — у CRM по людях', 'pay-day': 'ЗП через транзит за день — у CRM по людях', refund: 'Платіж і його повернення (разом 0)' };
    const GW_SHORT = { '': 'суми не 1:1', 'card-day': 'покупки картки за день', liqpay: 'LiqPay: лід + комісія', 'tax-day': 'податки із ЗП за день', 'pay-day': 'ЗП через транзит за день', refund: 'платіж і його повернення' };
    const gSum = list => fmt(Math.abs(r2(list.reduce((s, x) => s + x.amount, 0))));
    const fewIds = (list, n) => list.slice(0, n || 6).map(c => `ID ${c.id}`).join(' + ') + (list.length > (n || 6) ? ` і ще ${list.length - (n || 6)}` : '');
    function groupText(g) {
      const b0 = g.bank[0], c0 = g.crm[0];
      if (g.why === 'refund') return `${dmy(b0.date)} ${fmt(Math.abs(b0.amount))} ${clean(b0.cpty) || ''} — повернено ${dmy(g.bank[1].date)}`;
      if (g.why === 'liqpay') return `${dmy(b0.date)} зараховано ${fmt(b0.amount)} = ID ${c0.id} (${fmt(c0.amount)}) − комісія ID ${g.crm[1].id} (${fmt(Math.abs(g.crm[1].amount))})`;
      if (g.why === 'card-day') return `картка …${Rc.cardTail(b0.purpose) || '?'} ${dmy(Rc.cardDate(b0.purpose) || b0.date)}: ${g.bank.length} ${plural(g.bank.length, 'покупка', 'покупки', 'покупок')} на ${gSum(g.bank)} = ID ${c0.id}`;
      if (g.why === 'tax-day') return `${dmy(b0.date)} ${g.bank.map(x => taxName(x.purpose)).join(' + ')} на ${gSum(g.bank)} = ${g.crm.length} ${plural(g.crm.length, 'запис', 'записи', 'записів')} (${fewIds(g.crm)})${g.diff ? ` — різниця CRM − банк ${g.diff > 0 ? '+' : ''}${fmt(g.diff)} (копійки округлення: суму запису варто змінити на банківську)` : ''}`;
      if (g.why === 'pay-day') return `${dmy(b0.date)} на ${gSum(g.bank)} = ${g.crm.length} ${plural(g.crm.length, 'запис', 'записи', 'записів')} ЗП (${fewIds(g.crm)})`;
      const bt = x => `${dmy(x.date)} ${fmt(Math.abs(x.amount))}`, ct = c => `ID ${c.id} (${fmt(Math.abs(c.amount))})`;
      return g.bank.length === 1 ? `банк ${bt(b0)} = записи CRM ${g.crm.map(ct).join(' + ')}` : g.crm.length === 1 ? `запис CRM ${ct(c0)} = операції банку ${g.bank.map(bt).join(' + ')}`
        : `операції банку ${g.bank.slice(0, 6).map(bt).join(' + ')}${g.bank.length > 6 ? ` і ще ${g.bank.length - 6}` : ''} = записи CRM ${fewIds(g.crm)} (${gSum(g.crm)})`;
    }
    // стан операції банку (side 'bank') чи запису CRM ('crm') у групі — для «Деталей»
    function groupState(g, side, it) {
      const b0 = g.bank[0], c0 = g.crm[0];
      if (g.why === 'refund') return 'платіж і його повернення — разом 0, у CRM не вносяться';
      if (g.why === 'liqpay') return side === 'bank' ? `= ID ${c0.id} (${fmt(c0.amount)}) − комісія LiqPay ID ${g.crm[1].id} (${fmt(Math.abs(g.crm[1].amount))})`
        : it === c0 ? `разом з комісією ID ${g.crm[1].id} = зарахування LiqPay ${dmy(b0.date)} ${fmt(b0.amount)}` : `комісія до ID ${c0.id}: разом = зарахування LiqPay ${dmy(b0.date)} ${fmt(b0.amount)}`;
      if (g.why === 'card-day') return side === 'bank' ? `покупки картки за ${dmy(Rc.cardDate(b0.purpose) || b0.date)}: разом (${g.bank.length}) = запис CRM ID ${c0.id}` : `= ${g.bank.length} ${plural(g.bank.length, 'покупка', 'покупки', 'покупок')} картки за ${dmy(Rc.cardDate(b0.purpose) || b0.date)} (${gSum(g.bank)})`;
      if (g.why === 'tax-day') return (side === 'bank' ? `податки дня разом (${gSum(g.bank)}) = ${g.crm.length} ${plural(g.crm.length, 'запис', 'записи', 'записів')} податків по людях` : `частина податків ${dmy(b0.date)} (${g.bank.map(x => taxName(x.purpose)).join(' + ')} на ${gSum(g.bank)})`) + (g.diff ? `; різниця CRM − банк ${fmt(g.diff)}` : '');
      if (g.why === 'pay-day') return side === 'bank' ? `= ${g.crm.length} ${plural(g.crm.length, 'запис', 'записи', 'записів')} ЗП по людях (${gSum(g.crm)})` : `частина ЗП через транзит ${dmy(b0.date)} (${gSum(g.bank)})`;
      if (side === 'bank') return g.bank.length === 1 ? `= ${g.crm.length} записи CRM (${fewIds(g.crm)})` : `разом з іншими = ${g.crm.length === 1 ? `запис CRM ID ${c0.id}` : `записи CRM ${fewIds(g.crm)}`} (${gSum(g.bank)})`;
      return g.bank.length === 1 ? `частина операції банку ${dmy(b0.date)} ${fmt(Math.abs(b0.amount))}` : `= ${g.bank.length} операції банку (${gSum(g.bank)})`;
    }
    /* Усі операції банку й записи CRM рахунку за період (з фільтром типу — лише цього типу) і стан кожної:
       пара, суми не 1:1, дата проведення, немає в CRM / в банку. → [{date, time, amount, bank, crm, state, cls}] за датою */
    function detRows(r) {
      const R = r.R, inK = (k) => S.kind === 'all' || k === S.kind, out = [];
      const B = r.b.rows.filter(x => x.date >= S.from && x.date <= S.to && inK(R.kinds.get(x)));
      const C = (r.cf || []).filter(c => c.date >= S.from && c.date <= S.to && inK(Rc.crmKind(c)));
      const pairs = R.pairs || new Map(), pairC = new Map([...pairs].map(([x, c]) => [c, x]));
      const gB = new Map(), gC = new Map(), tB = new Map(), tC = new Map();
      (R.multi || []).forEach(g => { g.bank.forEach(x => gB.set(x, g)); g.crm.forEach(c => gC.set(c, g)); });
      (R.timing || []).forEach(t => (t.kind === 'later' ? tB.set(t.bank, t) : tC.set(t.crm, t)));
      const oX = new Map((R.own ? R.own.xfers : []).map(x => [x.row, x])), maybe = new Set((R.own ? R.own.maybe : []).map(m => m.row));
      const yB = new Set(R.pay ? R.pay.bank : []), yC = new Set(R.pay ? R.pay.crm : []);
      const rlB = new Map((R.ruled || []).map(o => [o.row, o.why])), caC = new Map((R.calc || []).map(o => [o.crm, o.why]));
      for (const x of B) {
        const c = pairs.get(x), g = gB.get(x), t = tB.get(x), o = oX.get(x);
        const [state, cls] = o && o.state === 'missing' ? [`переказу на «${nameOf(o.peer)}» немає в CRM — створити можна в розділі «Внести в CRM»`, 'bad']
          : o && o.state === 'type' ? [`у CRM записано як ${o.item.op} (ID ${o.item.id}) — тип можна змінити в розділі «Виправити»`, 'bad']
          : c ? [`є в CRM${c.date !== x.date ? ` з датою ${dmy(c.date)}` : ''}`, 'ok']
          : g ? [groupState(g, 'bank', x), 'ok']
          : t ? [`банк провів пізніше: покупка ${dmy(t.buy)}, у CRM ID ${t.crm.id} від ${dmy(t.crm.date)}`, 'ok']
          : rlB.has(x) ? [`за правилом не вноситься: ${rlB.get(x)}`, 'muted']
          : maybe.has(x) ? ['схоже на переказ між своїми — виберіть рахунок «куди» в розділі «Внести в CRM»', 'bad']
          : yB.has(x) ? ['ЗП через транзитний рахунок — поштучно не звіряється (підсумок під рахунком)', 'muted']
          : ['немає в CRM', 'bad'];
        out.push({ date: x.date, time: x.time || '', amount: x.amount, bank: `${x.cpty || '—'}${x.purpose ? ' · ' + x.purpose : ''}`, crm: c ? `ID ${c.id}${c.lead ? ' (лід)' : ''}${c.draft ? ' (чернетка)' : ''} · ${c.comment || c.op}` : '', state, cls });
      }
      for (const c of C) {
        if (pairC.has(c)) continue;
        const g = gC.get(c), t = tC.get(c);
        const [state, cls] = g ? [groupState(g, 'crm', c), 'ok']
          : caC.has(c) ? [caC.get(c), 'muted']
          : t ?(t.kind === 'after' ? [`банк провів після періоду: ${dmy(t.bank.date)}`, 'ok'] : ['ще не проведено банком (покупка карткою)', 'ok'])
          : (r.topups || []).includes(c) ? ['поповнення корп. картки записано витратою — тип можна змінити в розділі «Виправити»', 'bad']
          : yC.has(c) ? ['запис ЗП — поштучно не звіряється (ЗП через транзитний рахунок)', 'muted']
          : ['немає в банку', 'bad'];
        out.push({ date: c.date, time: c.time || '', amount: c.amount, bank: '', crm: `ID ${c.id}${c.lead ? ' (лід)' : ''}${c.draft ? ' (чернетка)' : ''} · ${c.comment || c.op}`, state, cls });
      }
      return out.sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : a.date + a.time > b.date + b.time ? 1 : 0));
    }
    function detHtml(r) {
      const R = r.R, list = detRows(r), bad = list.filter(x => x.cls === 'bad').length;
      const all = `<div class="muted" style="margin-bottom:6px">Усі операції за період${S.kind !== 'all' ? ` (${esc(KIND_ONLY[S.kind])})` : ''}: банк ${list.filter(x => x.bank).length}, записів CRM ${new Set(list.filter(x => x.crm).map(x => x.crm)).size}; без пари або з іншим типом — ${bad}.</div>
<table class="amts"><tr><th>Дата</th><th class="n">Сума</th><th>Операція банку</th><th>Запис CRM</th><th>Стан</th></tr>
${list.map(x => `<tr><td style="white-space:nowrap">${esc(dmy(x.date))}${x.time ? ' ' + esc(x.time) : ''}</td><td class="n">${fmt(x.amount)}</td><td>${esc(x.bank) || '<span class="muted">—</span>'}</td><td>${esc(x.crm) || '<span class="muted">—</span>'}</td><td class="${x.cls}" style="font-weight:${x.cls === 'bad' ? 700 : 400}">${esc(x.state)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Операцій за період немає.</td></tr>'}</table>`;
      if (!R.amounts.length) return all;
      return all + `<div class="muted" style="margin:10px 0 6px">Суми, кількість операцій з якими в банку і в CRM різна (сума — зі знаком: «−» — списання). «Різниця» = CRM − банк: «−1» — однієї операції немає в CRM, «+1» — у CRM на одну більше.</div>
<table class="amts"><tr><th class="n">Сума</th><th class="n">Банк</th><th class="n">CRM</th><th class="n">Різниця</th><th>Операції банку</th><th>Записи CRM</th></tr>
${R.amounts.map(x => `<tr><td class="n">${fmt(x.amount)}</td><td class="n">${x.nB}</td><td class="n">${x.nC}</td><td class="n bad">${x.d > 0 ? '+' : ''}${x.d}</td>
<td>${x.bank.map(o => `<div>${esc(opB(o))}</div>`).join('') || '<span class="muted">—</span>'}</td>
<td>${x.crm.map(o => `<div>${esc(opC(o))}</div>`).join('') || '<span class="muted">—</span>'}${x.near.length ? `<div class="warn" style="margin:4px 0 0;padding:4px 8px">з іншою датою: ${x.near.map(o => `${esc(dmy(o.date))} (ID ${o.id})`).join(', ')}</div>` : ''}</td></tr>`).join('')}</table>`;
    }
    // підсумок звірки — плитки над розділами; плитка відкриває свій розділ
    function sumHtml(all) {
      const s = bankSummary(all, S.lastTypes, S.lastNewCards, S.lastReps), noB = !s.covered;
      const tile = (sec, cls, tt, tv, ts) => `<button type="button" class="tile ${cls}" data-go-sec="${sec}"><span class="tt">${esc(tt)}</span><span class="tv">${esc(String(tv))}</span><span class="ts">${esc(ts)}</span></button>`;
      const list = [tile('acc', s.bad ? 't-bad' : s.unk ? 't-warn' : s.accs ? 't-ok' : '', 'Рахунки сходяться', `${s.good} з ${s.accs}`, `розбіжність ${s.bad} · без даних банку ${s.unk}`),
        tile('add', noB ? '' : s.missB ? 't-bad' : 't-ok', 'Операцій банку без запису', noB ? '—' : s.missB, noB ? 'виписок за період немає' : s.missB ? 'внести — «Внести в CRM»' : 'усі є в CRM'),
        tile('add', noB ? '' : s.own + s.topup ? 't-bad' : 't-ok', 'Переказів між своїми без пари', noB ? '—' : s.own + s.topup, noB ? 'виписок за період немає'
          : s.topup ? `${s.own ? `з виписок ${s.own} · ` : ''}поповнень корп. карток: ${s.topup} — «Внести в CRM»` : s.own ? 'створити — «Внести в CRM»' : 'усі є в CRM'),
        s.reps ? tile('fix', 't-bad', 'Записів виправити', s.types + s.reps, `${s.types ? `тип: ${s.types} · ` : ''}поповнень не на ту картку: ${s.reps} — «Виправити»`)
          : tile('fix', s.types ? 't-bad' : 't-ok', 'Записів з неправильним типом', s.types, s.types ? 'змінити — «Виправити»' : 'типи правильні'),
        tile('acc', noB ? '' : s.missC ? 't-warn' : 't-ok', 'Записів CRM без операції в банку', noB ? '—' : s.missC, noB ? 'виписок за період немає' : s.missC ? 'перевірте в CRM — під рахунками' : 'кожен запис є в банку')];
      if (s.cards) list.push(tile('add', 't-warn', 'Корп. карток, яких лінтер не знає', s.cards, 'запам\'ятати — «Внести в CRM»'));
      return `<div class="tiles" style="--n:${list.length}">${list.join('')}</div>`;
    }
    // лічильники в перемикачі розділів
    function navCounts(n) {
      const set = (k, v, cls) => { const e = $('nav').querySelector(`[data-n="${k}"]`); e.hidden = v === null || v === undefined || v === 0 || v === ''; e.textContent = v; e.className = `cnt${cls ? ' ' + cls : ''}`; };
      set('acc', n && n.bad, 'bad'); set('mt', n && n.mt, n && n.mt ? 'bad' : ''); set('add', n && n.add, n && n.add ? 'bad' : ''); set('fix', n && n.fix, n && n.fix ? 'bad' : ''); set('wd', n && n.wd, n && n.wd ? 'bad' : '');
      set('close', n && n.close, n && n.close === '✓' ? 'ok' : n && n.close === '✗' ? 'bad' : '');
    }
    // фільтр статусів «Рахунків»: вибір пам'ятається в браузері (cfl_bank_filter); k — статус, null — показати всі
    function stToggle(k) {
      if (k === null) ST_ORDER.forEach(x => S.filter.add(x));
      else if (S.filter.has(k)) S.filter.delete(k);
      else S.filter.add(k);
      LS.set('cfl_bank_filter', [...S.filter]);
      render();
    }
    function render() {
      updQuick();
      if (!S.accs || !S.items) {
        emptyOut();
        $('sum').innerHTML = ''; $('xlsx').disabled = true; navCounts(null); applySec(); return;
      }
      // неактуальні за назвою рахунки сховано (і ті, що стали такими пізніше), якщо людина не показала їх сама; решта — як вибере людина
      const all = S.lastAll = rows(), hidden = hiddenAccs(S.accs, LS.get('cfl_bank_hide', []), LS.get('cfl_bank_shown', []));
      S.lastNewCards = newCards();
      S.lastReps = repointFixes(all); // до переказів: пропозиція поповнення картки в мінусі показує, що поповнення, можливо, вже є на іншій картці
      S.lastMt = mtCalc(all); // до «Внести в CRM»: операцію з погодженням там не пропонується вносити (її вносять у «Погодженні»)
      const base = all.filter(r => S.showHidden || !hidden.has(r.a.id));
      const c = k => base.filter(r => r.status === k).length, nHid = all.filter(r => hidden.has(r.a.id)).length;
      // «сховано» — окремий перемикач: з ним видно й сховані рахунки (з вибраними статусами; якщо жоден видимий статус не вибрано — усі сховані)
      const anySt = ST_ORDER.filter(k => !ST_RARE.has(k) || c(k)).some(k => S.filter.has(k));
      const vis = all.filter(r => (hidden.has(r.a.id) ? S.showHidden && (!anySt || S.filter.has(r.status)) : S.filter.has(r.status)));
      const xh = S.kind === 'all' || S.kind === 'own' ? xferHtml(all) : (S.lastProps = [], '');
      const rh = recHtml(all), th = typeHtml(all) + repointHtml(), cardsH = cardsHtml(), closeH = closeHtml(all);
      let h = `<div class="card"><div class="sub-h"><h3>Рахунки за ${esc(dmy(S.from))}–${esc(dmy(S.to))}${S.kind !== 'all' ? ` · ${esc(KIND_ONLY[S.kind])}` : ''}</h3>
<div class="chips">${ST_ORDER.filter(k => !ST_RARE.has(k) || c(k)).map(k => `<span class="${ST[k][0]}${S.filter.has(k) ? ' on' : ''}" data-st="${k}" title="Показати / сховати рахунки з цим статусом">${ST[k][1]}: ${c(k)}</span>`).join('')}${nHid ? `<span class="st-locked${S.showHidden ? ' on' : ''}" data-b="showhid" title="Показати сховані рахунки (значок-око в рядку)">сховано: ${nHid}</span>` : ''}</div></div>
<div class="row" style="margin:0 0 10px"><span class="muted small">Статуси — фільтр: натисніть, щоб показати чи сховати рахунки з таким статусом.${vis.length < base.length ? ` Показано ${vis.length} з ${base.length} — вибір пам'ятається.` : ''}</span>${vis.length < base.length ? '<button class="quiet" data-b="stall" style="margin:0">Показати всі</button>' : ''}<button class="quiet" data-b="offs" title="Читає всі записи CRM від початку — до хвилини" style="margin:0 0 0 auto">Порівняти залишки CRM із сумою записів</button></div>
${S.kind !== 'all' ? `<div class="info">Звіряються ${esc(KIND_ONLY[S.kind])}: обороти, кількість операцій і суми — лише цього типу (у CRM — за типом запису${S.kind === 'own' ? ': перекази й обміни' : ''}; у банку — ${S.kind === 'own' ? 'операції з нашими рахунками і ті, що в CRM записано переказом' : S.kind === 'credit' ? 'зарахування, крім переказів між своїми' : 'списання, крім переказів між своїми'}). Різниця залишків на початок і кінець видна (Δ), але на статус з фільтром не впливає. Усе разом — «Що звіряти: усе».</div>` : ''}`;
      if (S.offsets) {
        const off = all.filter(r => !isZero(r.offset));
        h += off.length ? `<div class="warn">У ${off.length} з ${all.length} рахунків залишок, який показує CRM, не дорівнює сумі записів рахунку (примітка в рядку). У кешфлоу цієї різниці немає: це може бути початковий залишок без запису або запис, змінений чи видалений без перерахунку залишку. З банком звіряйте залишок CRM.</div>`
          : '<div class="info">В усіх рахунках залишок CRM дорівнює сумі записів.</div>';
      }
      if (!vis.length) h += `<div class="info">${S.filter.size || S.showHidden ? 'Немає рахунків із вибраними статусами.' : 'Не вибрано жодного статусу — натисніть статус угорі.'}</div>`;
      else {
        h += `<div class="tbl acct"><table class="bal"><colgroup><col><col style="width:128px"><col style="width:128px"><col style="width:128px"><col style="width:146px"><col style="width:150px"><col style="width:140px"></colgroup>
<tr><th>Рахунок CRM</th><th class="n">Залишок на початок ${esc(dmy(S.from))}</th><th class="n">${S.kind === 'own' ? 'Перекази: надійшло' : 'Надходження'}</th><th class="n">${S.kind === 'own' ? 'Перекази: списано' : 'Списання'}</th><th class="n">Залишок на кінець ${esc(dmy(S.to))}</th><th>Кількість за сумами</th><th></th></tr>`;
        for (const g of GROUPS) {
          // у групі спершу рахунки, де є що робити (розбіжність, бракує переказів, неповні дані банку), далі — за назвою
          const gr = vis.filter(r => r.g === g).sort((x, y2) => (ST_FIRST.has(y2.status) ? 1 : 0) - (ST_FIRST.has(x.status) ? 1 : 0) || x.a.name.localeCompare(y2.a.name, 'uk'));
          if (!gr.length) continue;
          h += `<tr class="gh"><td colspan="7">${esc(g[1])}</td></tr>` + gr.map(r => rowHtml(r, hidden.has(r.a.id))).join('');
        }
        h += '</table></div><div class="muted small" style="margin-top:8px">У кожній клітинці: CRM (жирним), банк і різниця CRM − банк (✓ — збігається). Під рахунком — чого саме бракує в CRM чи в банку за період.</div>';
      }
      h += '</div>';
      $('sum').innerHTML = sumHtml(all);
      const add = doneHtml() + (cardsH + xh + rh || '<div class="empty">Вносити нічого: усе, що є у виписках, є й у CRM.</div>') + outsideHtml();
      // прокрутка кожної таблиці з прокруткою (рахунки, «Операції банку, яких немає в CRM», …) — та сама після перемальовування:
      // зміна статті чи маркетолога в довгому списку не повертає на його початок (16.11.2026). Ключ — розділ і номер таблиці в ньому
      const tbls = () => [...$('out').querySelectorAll('.tbl')].map((t, i, l) => { const s = t.closest('[data-sec]'), k = s ? s.dataset.sec : ''; return [`${k}|${l.slice(0, i).filter(o => o.closest('[data-sec]') === s).length}`, t]; });
      const keepAll = new Map(tbls().map(([k, t]) => [k, [t.scrollTop, t.scrollLeft]]));
      const was = $('out').querySelector('.tbl.acct'), keep = was ? [was.scrollTop, was.scrollLeft] : null;
      // розділи одразу з потрібним hidden: браузер розкладає лише видимий (відновлення прокрутки нижче примушує розкладку)
      const sec = (k, body) => `<section data-sec="${k}"${S.sec === k ? '' : ' hidden'}>${body}</section>`;
      $('out').innerHTML = sec('acc', h) + sec('mt', mtHtml()) + sec('add', add)
        + sec('fix', th || '<div class="empty">Виправляти нічого: записів з неправильним типом і поповнень не на ту картку немає.</div>') + sec('wd', wdHtml()) + sec('close', closeH);
      const now = S.sec === 'acc' && $('out').querySelector('.tbl.acct');
      if (now && keep) { now.scrollTop = keep[0]; now.scrollLeft = keep[1]; }
      for (const [k, t] of tbls()) { const v = keepAll.get(k); if (v && t !== now && k.split('|')[0] === S.sec && (v[0] || v[1])) { t.scrollTop = v[0]; t.scrollLeft = v[1]; } }
      const prompts = all.reduce((s, r) => s + (r.R.own ? r.R.own.maybe.length : 0), 0), sm = bankSummary(all, S.lastTypes, S.lastNewCards, S.lastReps), wdS = wdPart();
      const rep = S.close && S.close.from === S.from && S.close.to === S.to && S.kind === 'all' && S.close.lint !== undefined
        ? closeReport(all, { types: S.lastTypes, repoints: S.lastReps, lint: S.close.lint, reg: S.close.reg, wd: wdS, noHelper: S.close.noHelper, newCards: S.lastNewCards.length, drafts: draftItems(), draftsEmpty: S.drafts ? S.drafts.empty : 0 }) : null;
      navCounts({ bad: sm.bad, add: S.lastProps.filter(xok).length + S.lastRecs.filter(p => !p.block && !p.payRow).length + prompts + S.lastNewCards.length, fix: S.lastTypes.length + S.lastReps.length,
        wd: wdS && !wdS.error ? wdS.diff + wdS.none + wdS.extra + wdS.double.length : null,
        mt: S.lastMt ? S.lastMt.res.rows.filter(m => MT.crmState(m.ap) !== 'в CRM').length + S.lastMt.res.amb.length : null,
        close: rep ? (rep.verdict === 'ready' ? '✓' : rep.verdict === 'not' ? '✗' : '—') : null });
      applySec();
      $('sum').querySelectorAll('[data-go-sec]').forEach(b => b.onclick = () => { S.sec = b.dataset.goSec; applySec(); });
      // «відкрити розділ» у висновку закриття місяця: розділ і прокрутка до плиток (над перемикачем розділів)
      $('out').querySelectorAll('[data-go-sec]').forEach(b => b.onclick = () => { S.sec = b.dataset.goSec; applySec(); if ($('sum').scrollIntoView) $('sum').scrollIntoView({ block: 'start' }); });
      $('xlsx').disabled = false;
      bindXfer();
      bindRecs();
      bindTypes();
      bindRepoint();
      bindCards();
      bindWd();
      bindMt();
      wdEnsure(); // погодження для «Виводів з балансу» — у фоні, якщо прочитаних не вистачає для періоду
      // історія рахунку (записи за 120 днів до періоду): стаття, де правила її не дали; маркетолог реклами й зразок коментаря покупки карткою
      // … і проєкт: без правила проєкту він береться з записів рахунку, а в періоді їх може ще не бути (16.11.2026)
      const want = [...new Set(S.lastRecs.filter(p => !p.block && !S.hist.has(p.acc) && (!p.rule.art || !p.rule.proj || p.cardComment !== undefined || artIssue(S.rp.get(p.key).art) === 'marketer')).map(p => p.acc))];
      if (want.length && !S.histBusy) setTimeout(() => loadHist(want), 0);
      // список маркетологів — лише коли він потрібен (стаття з рекламним бюджетом)
      if (S.mks === undefined && S.lastRecs.some(p => !p.block && artIssue(S.rp.get(p.key).art) === 'marketer')) setTimeout(loadMarketers, 0);
      recAiEnsure(); // операції без статті — підказка ШІ через Помічник
      $('out').querySelectorAll('[data-man]').forEach(i => i.onchange = () => {
        const id = +i.dataset.man, man = LS.get('cfl_bank_manual', {}), t = i.value.trim();
        if (t === '') { if (man[id]) delete man[id][S.to]; }
        else {
          const v = parseNum(t);
          if (v === null) { i.classList.add('badin'); i.title = 'Потрібне число, наприклад 12 345,67'; return; }
          (man[id] = man[id] || {})[S.to] = v;
        }
        LS.set('cfl_bank_manual', man);
        render();
      });
      $('out').querySelectorAll('[data-hide]').forEach(e => e.onclick = () => {
        const id = +e.dataset.hide, h2 = new Set(LS.get('cfl_bank_hide', [])), sh = new Set(LS.get('cfl_bank_shown', []));
        // показати неактуальний за назвою — запам'ятати, що його показала людина (інакше він ховається сам)
        if (hiddenAccs(S.accs, [...h2], [...sh]).has(id)) { h2.delete(id); if (OFF_ACC.test(nameOf(id))) sh.add(id); }
        else { h2.add(id); sh.delete(id); }
        LS.set('cfl_bank_hide', [...h2]);
        LS.set('cfl_bank_shown', [...sh]);
        render();
      });
      $('out').querySelectorAll('[data-st]').forEach(e => e.onclick = () => stToggle(e.dataset.st));
      const sa = $('out').querySelector('[data-b="stall"]');
      if (sa) sa.onclick = () => stToggle(null);
      $('out').querySelectorAll('[data-det]').forEach(e => e.onclick = () => {
        const id = +e.dataset.det, open = !S.open.has(id), r = (S.lastAll || []).find(x => x.a.id === id), tr = e.closest('tr');
        if (open) S.open.add(id); else S.open.delete(id);
        if (!r || !tr) { render(); return; }
        let after = tr.nextElementSibling && tr.nextElementSibling.classList.contains('sub') ? tr.nextElementSibling : tr;
        const det = after.nextElementSibling && after.nextElementSibling.classList.contains('det') ? after.nextElementSibling : null;
        if (open && !det) after.insertAdjacentHTML('afterend', `<tr class="det"><td colspan="7">${detHtml(r)}</td></tr>`);
        if (!open && det) det.remove();
        e.textContent = `Деталі ${open ? '▴' : '▾'}`;
        e.title = open ? 'Згорнути операції' : 'Усі операції банку й записи CRM за період — зі станом кожної';
      });
      const sh = $('out').querySelector('[data-b="showhid"]');
      if (sh) sh.onclick = () => { S.showHidden = !S.showHidden; render(); };
      if (opts.go) $('out').querySelectorAll('[data-go]').forEach(e => e.onclick = () => opts.go(e.dataset.go));
      $('out').querySelector('[data-b="offs"]').onclick = offsets;
      const od = $('out').querySelector('[data-b="outside"] details');
      if (od) od.ontoggle = () => { S.outOpen = od.open; };
      Cmb.enhance($('out')); // довгі списки (статті, маркетологи, рахунки) — з пошуком
    }

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
    // ---------- підказка ШІ для операції, якій лінтер не визначив статті (з 05.11.2026; щоденна модель Помічника) ----------
    /* Операції «Внести в CRM» без статті ні за правилами, ні з історії рахунку (крім ЗП через транзит і податків із ЗП — їх розносять
       по людях) ідуть у «Помічник кешфлоу», як записи без правил із «Статей і проєктів»: ШІ підказує статтю й проєкт, а Помічник ще й
       запам'ятовує їх для тижневого перегляду правил — що лінтер сам не розпізнав. Лише підказка: «Взяти» ставить її в
       рядок, як вибір людини. Ключ — хеш ключа рядка (у Помічник не йдуть ні номер рахунку, ні референс банку). */
    const fnv = (s, h) => { for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); };
    const raKey = p => `b:${fnv(p.key, 2166136261)}${fnv(p.key, 374761393)}`;
    const raNeed = p => !p.block && !p.payRow && !p.taxKey && !p.rule.art && !p.hist;
    const raHint = p => S.ra.res[raKey(p)] || null;
    const raArt = (p, h) => { const k = h && h.a ? h.a.replace(':', '/') : ''; return ARTS.find(a => a.key === k && a.type === p.op) || null; };
    const raProj = h => (h && h.p ? projects.find(([n]) => n === h.p) || null : null);
    async function recAiAsk() {
      clearTimeout(S.ra.timer);
      const list = S.lastRecs.filter(p => raNeed(p) && S.hist.has(p.acc) && !S.rp.get(p.key).art);
      if (!opts.aiHints || !list.length) return;
      const sig = list.map(raKey).sort().join(',');
      S.ra.busy = true;
      S.ra.sig = sig;
      let j;
      try {
        j = await opts.aiHints({ records: list.map(p => ({ k: raKey(p), src: 'bank', date: p.date, type: p.op === 1 ? 'income' : 'expense', amount: p.amount,
          ccy: (p.bank && p.bank.ccy) || 'UAH', acc: nameOf(p.acc), cmt: p.comment, art: '', art_label: '', prj: '' })) });
      } catch (e) { j = null; }
      S.ra.busy = false;
      if (!j || S.ra.sig !== sig) return; // Помічник не відповів (тоді й підказок немає) чи набір уже інший
      const res = j.results || {}, fresh = Object.keys(res).filter(k => !S.ra.res[k]).length, was = S.ra.pending;
      Object.assign(S.ra.res, res);
      // ще думає — перепитати за будь-якого стану: запит, уже відправлений у Claude, доходить і після «ліміту на сьогодні» (Помічник
      // тоді знімає з черги решту, і pending сам стає 0). Довга черга (інша вкладка поставила сотні записів) — після 5 хв рідше, до години
      S.ra.pending = j.pending || 0;
      if (S.ra.pending) {
        const n = S.ra.polls++;
        if (n < 60) S.ra.timer = setTimeout(recAiAsk, 5000);
        else if (n < 170) S.ra.timer = setTimeout(recAiAsk, 30000);
        else S.ra.pending = 0; // годину без відповіді — не чекаємо (і не пишемо «підбирає»); нові операції спитають знову
      }
      if (fresh || was !== S.ra.pending) render();
    }
    // після кожного показу: нові операції без статті (історія рахунку вже прочитана) — спитати Помічник один раз
    function recAiEnsure() {
      if (!opts.aiHints || S.ra.busy) return;
      const list = S.lastRecs.filter(p => raNeed(p) && S.hist.has(p.acc) && !S.rp.get(p.key).art);
      const sig = list.map(raKey).sort().join(',');
      if (!list.length || sig === S.ra.sig) return;
      S.ra.polls = 0;
      setTimeout(recAiAsk, 0);
    }
    function recAiHtml(p, can) {
      if (!opts.aiHints || !raNeed(p)) return '';
      const h = raHint(p);
      if (!h) return S.ra.pending && S.ra.sig.split(',').includes(raKey(p)) ? '<div class="muted xwhy">ШІ підбирає статтю…</div>' : '';
      const art = raArt(p, h), pr = raProj(h);
      if (!art) return ''; // ШІ теж не визначив — без зайвого напису в кожному такому рядку
      return `<div class="xwhy" style="margin-top:4px"><span class="muted">ШІ (${esc(h.c || 'низька')}):</span> «${esc(art.label.split(' / ').slice(1).join(' / ') || art.label)}»${pr ? ` · ${esc(pr[0])}` : ''}${h.w ? `<span class="muted"> — ${esc(h.w)}</span>` : ''}${can ? ` <button class="quiet" data-rai="1" title="Поставити цю статтю${pr ? ' і проєкт' : ''} в рядок" style="height:24px;padding:0 8px;margin:0;font-size:12px">Взяти</button>` : ''}</div>`;
    }
    /* Та сама стаття — таким самим операціям (16.11.2026): 18 покупок одного сервісу з однієї картки — не 18 виборів. Лише пропозиція:
       після вибору статті в рядку з'являється кнопка «І для ще N таких самих»; вона ставить статтю в рядки без статті з тим самим
       рахунком, типом і контрагентом (покупка карткою — з тим самим сервісом). Галочок не ставить; зарплатну статтю не розносить. */
    const simKey = p => (Rc.cardTail(p.row.purpose) ? merchantOf(p.row.purpose) : clean(p.row.cpty)).toLowerCase();
    function recSame(p) {
      const k = simKey(p);
      if (k.length < 2) return [];
      return S.lastRecs.filter(q => q !== p && !q.block && !q.payRow && !q.taxKey && q.acc === p.acc && q.op === p.op && simKey(q) === k && !S.rp.get(q.key).ta && !S.rp.get(q.key).art);
    }
    // вибір статті в рядку (людиною); art '' — стаття знята
    function recPickArt(key, art) {
      const st = S.rp.get(key);
      if (!st) return;
      st.art = art; st.ta = true; st.sim = false;
      if (!art) st.on = false;
      S.rsim = art && !salaryArt(art) ? { key, art } : null;
      render();
    }
    // кнопка «І для ще N таких самих» у рядку key
    function recSpreadArt(key) {
      const p = S.lastRecs.find(x => x.key === key), art = S.rsim && S.rsim.key === key ? S.rsim.art : '';
      S.rsim = null;
      if (p && art && S.rp.get(key).art === art) for (const q of recSame(p)) Object.assign(S.rp.get(q.key), { art, ta: true, sim: true });
      render();
    }
    // на рахунку (у періоді й за 120 днів до нього) є записи з проєктом — тоді проєкт нового запису береться з них
    const projSeen = acc => [...(S.items.get(acc) || []), ...(S.hist.get(acc) || [])].some(c => c.proj && (c.opc === 1 || c.opc === 2));
    function recHtml(all) {
      // проєкт, якого людина не міняла, іде за записами рахунку й тоді, коли їх історію прочитано вже після першого показу
      // (раніше лишався «останній вибраний» з будь-якого іншого рядка — 16.11.2026); до recProposals — щоб і коментар картки був з ним
      for (const p of S.lastRecs) { const st = S.rp.get(p.key); if (st && !st.tp && !st.pm && !p.rule.proj && projSeen(p.acc)) st.proj = recProject(p.acc); }
      const props = S.lastRecs = recProposals(all);
      // нічого створювати — так і сказати (з виписками, що покривають період); перекази між своїми — у своєму списку
      const each = S.kind === 'credit' ? 'кожного надходження' : S.kind === 'debit' ? 'кожного списання' : 'кожної операції';
      if (!props.length) return S.kind !== 'own' && all.some(r => r.R.covered && r.status !== 'ccy')
        ? `<div class="card" data-b="recs"><div class="sub-h" style="margin:0"><h3>Операції банку, яких немає в CRM</h3><span class="pill st-ok">немає</span></div><div class="muted small" style="margin-top:6px">Для ${each} банку за період у CRM є запис${S.kind === 'all' && S.lastProps.length ? ' (крім переказів між своїми — їх список вище в цьому розділі)' : ''}. Створювати нічого.</div></div>` : '';
      const can = !!opts.applyAllowed, live = props.filter(p => !p.block), off = props.filter(p => p.block), nPay = live.filter(p => p.payRow).length;
      const on = live.filter(p => ready(p) && S.rp.get(p.key).on), nBulk = live.filter(bulkOk).length;
      const projOpt = sel => projects.map(([n, v]) => `<option value="${v}"${Number(v) === Number(sel) ? ' selected' : ''}>${esc(n)}</option>`).join('');
      const artOpt = (op, sel) => {
        const list = ARTS.filter(a => a.type === op), groups = [...new Set(list.map(a => a.group))];
        return `<option value="">— стаття —</option>${!sel || list.some(a => a.key === sel) ? '' : `<option value="${esc(sel)}" selected>${esc(artLabel(sel))}</option>`}` +
          groups.map(g => `<optgroup label="${esc(g)}">${list.filter(a => a.group === g).map(a => `<option value="${a.key}"${a.key === sel ? ' selected' : ''}>${esc(a.label.split(' / ').slice(1).join(' / '))}</option>`).join('')}</optgroup>`).join('');
      };
      const bankTxt = p => `${p.bank.bank === 'mono' ? 'Моно' : 'Приват'} ${dmy(p.row.date)}${p.row.time ? ' ' + p.row.time : ''}: ${p.row.cpty || '—'} · ${p.row.purpose || ''}`;
      let h = `<div class="card" data-b="recs"><div class="sub-h"><h3>Операції банку, яких немає в CRM</h3><span class="muted small">у виписці є, у CRM немає${live.length - nPay ? ` · внести можна: ${live.length - nPay}` : ''}${nPay ? ` · ЗП через транзитний рахунок: ${nPay}` : ''}${off.length ? ` · лінтер не вносить: ${off.length}` : ''}</span></div>
<details class="hint" style="margin:0 0 10px"><summary>Що створюється і звідки стаття</summary><div>У виписці операція є, а в CRM запису з такою сумою за період немає. Можна створити витрату чи надходження на рахунку CRM — той самий запит, що й у вашому реєстрі погоджень. Стаття — за правилами rules.json, інакше як у попередніх записах рахунку з цим контрагентом; без статті запис не створюється. Покупка корп. карткою отримує коментар, як їх пишуть у CRM: «Facebook 30.10 17:33 Ларіоненко Тимур (тест США): 5000.00 UAH, корп. картка 7850» — сервіс, дата покупки, маркетолог, мета, картка; доки ви коментар не змінили, він іде за вибраними маркетологом, статтею й проєктом. Зарплатну статтю (комісії відділу продажів, ЗП тощо) теж можна вибрати — але CRM не дасть потім такий запис ні змінити, ні видалити, тож вікно створення окремо про це попередить. ЗП через транзитний рахунок («Ціл-ві зарах.») — окремими рядками з пакетом Привату: у CRM ЗП зазвичай вносять по людях, тож вносьте її, лише якщо цієї ЗП у CRM ще немає. Нічого не позначено заздалегідь. Операції згруповано за рахунком CRM — натисніть рядок рахунку, щоб розгорнути чи згорнути.</div></details>`;
      // реєстр погоджень налаштовано, але ще не прочитано чи він не відповів: які операції мають погодження — не видно (огляд 16.11.2026)
      if (live.length && regCfg() && (S.wd.busy || S.wd.error || !S.wd.rows)) h += S.wd.error
        ? `<div class="warn" style="margin:0 0 8px">Реєстр погоджень не відповів (${esc(S.wd.error)}) — не видно, які з цих операцій мають погодження. Те, що має погодження, вносьте у вкладці «Погодження», інакше буде дубль; спробувати ще раз — «Звірити».</div>`
        : '<div class="info" style="margin:0 0 8px">Читаю реєстр погоджень… Поки він не прочитаний, створення вимкнено: частину цих операцій реєстр вносить сам (був би дубль).</div>';
      if (!live.length) h += '<div class="info" style="margin:0 0 8px">Створювати нічого: кожна операція банку без запису в CRM — з тих, які лінтер не вносить (причина — нижче).</div>';
      if (live.length) {
        // групи за рахунком CRM (live уже впорядковано за рахунком): за замовчуванням розгорнуто, якщо операцій небагато або рахунок один
        const nGr = new Set(live.map(p => p.acc)).size, isOpen = acc => (S.rg.has(acc) ? S.rg.get(acc) : live.length <= 25 || nGr === 1);
        h += `<div class="tbl" style="max-height:64vh"><table class="xf"><tr><th></th><th>Дата</th><th class="n">Сума</th><th>Стаття</th><th>Проєкт</th><th>Коментар у CRM</th><th>Операція банку</th></tr>`;
        let cur = null;
        for (const p of live) {
          if (p.acc !== cur) {
            cur = p.acc;
            const gr = live.filter(q => q.acc === cur), nOn = gr.filter(q => ready(q) && S.rp.get(q.key).on).length, sumG = gr.reduce((s, q) => s + (q.op === 1 ? q.amount : -q.amount), 0);
            h += `<tr class="rg${isOpen(cur) ? ' open' : ''}" data-rg="${cur}"><td colspan="7"><span class="tw">▸</span>${esc(nameOf(cur))}<span class="gs">${gr.length} ${plural(gr.length, 'операція', 'операції', 'операцій')} · ${sumG < 0 ? '−' : '+'}${esc(fmt(Math.abs(sumG)))}${nOn ? ` · позначено ${nOn}` : ''}</span>${can && nGr > 1 && gr.some(bulkOk) ? `<button class="quiet rgall" data-rgall="${cur}" title="Позначити на цьому рахунку всі витрати зі статтею — як кнопка внизу, але лише тут">позначити всі тут (${gr.filter(bulkOk).length})</button>` : ''}${can && nGr > 1 ? `<button class="quiet rgall" data-rgnone="${cur}"${nOn ? '' : ' hidden'}>зняти</button>` : ''}</td></tr>`;
          }
          const st = S.rp.get(p.key), iss = artIssue(st.art), ok = ready(p);
          const sib = st.sib && !st.ta && p.taxPeers && p.taxPeers.length ? `<div class="muted xwhy">як інші податки з тієї самої ЗП (${esc([...new Set(p.taxPeers.map(q => q.taxName))].join(', '))})</div>` : '';
          const why = !st.art ? `<div class="bad" style="font-weight:400">виберіть статтю${(p.payRow || p.taxKey) && p.payArts && p.payArts.length ? `</div><div class="muted xwhy">ЗП${p.taxKey ? ' й податки з неї' : ''} на цьому рахунку записано як: ${esc(p.payArts.map(a => `«${artLabel(a.art).split(' / ').slice(1).join(' / ') || artLabel(a.art)}» (${a.n})`).join(', '))}` : ''}</div>${recAiHtml(p, can)}`
            : iss === 'salary' ? `<div class="warn" style="margin:4px 0 0;padding:4px 8px;font-weight:400">${esc(ISSUE.salary)}</div>${sib}`
            : sib ? sib
            : st.sim ? '<div class="muted xwhy">та сама стаття, що ви вибрали для такої самої операції</div>'
            : st.ta ? (raNeed(p) && raArt(p, raHint(p)) && raArt(p, raHint(p)).key === st.art ? '<div class="muted xwhy">за підказкою ШІ</div>' : '')
            : p.rule.art && st.art === p.rule.art.art ? `<div class="muted xwhy">${esc(p.rule.art.why)}${p.rule.art.sure ? '' : ' — перевірте'}</div>`
            : p.hist && st.art === p.hist.art ? `<div class="muted xwhy">як у попередніх записах рахунку (${p.hist.n}), напр. ID ${p.hist.ex.id}: «${esc(clean(p.hist.ex.comment).slice(0, 60))}»</div>` : '';
          const warns = p.rule.reasons.concat(p.sub && !p.sub.sure ? [`сума як у тарифі підписки юриста (${p.sub.plan}, ${p.sub.months} міс.), але призначення не про програмний продукт: якщо це підписка — виберіть статтю «Підписки юристів»; оплату клієнта вносять через замовлення (лід)`]
            : p.sub ? [`схоже на підписку юриста (${p.sub.plan}, ${p.sub.months} міс.): замовлення в CRM для неї не потрібне. Якщо на цю суму на рахунку є замовлення без оплати — це оплата замовлення, вносьте її через лід`]
            : p.op === 1 && !p.payRow ? ['оплату клієнта вносять через замовлення (лід) — тут створюйте лише інші надходження: повернення, відсотки тощо'] : [],
            p.ownCard ? [`${p.ownCard}: у CRM це витрата за тим, на що пішли гроші (комісії відділу продажів, ЗП тощо), — виберіть статтю`] : [],
            p.payroll ? [p.payroll] : [],
            p.aiNote ? [p.aiNote] : [],
            p.taxKey && p.taxPeers && p.taxPeers.length ? [`податок із ЗП: у CRM податки розносили по людях зі статтями відділів, тож статтю лінтер не вгадує; вибрана для одного податку цієї ЗП ставиться й іншим (${[...new Set(p.taxPeers.map(q => q.taxName))].join(', ')} того самого дня)`] : [],
            p.payRow ? [`ЗП одним переказом на «${clean(p.row.cpty) || 'транзитний рахунок'}»${p.packet && p.packet.cards ? ` (у пакеті ${p.packet.cards} ${plural(p.packet.cards, 'картка', 'картки', 'карток')})` : ''}. У CRM ЗП вносять по людях; записів ЗП без пари в банку на рахунку за період: ${p.payCtx.n ? `${p.payCtx.n} на ${fmt(p.payCtx.sum)}` : 'немає'}. Вносьте, лише якщо цієї ЗП у CRM ще немає; ім'я — на початку коментаря.`] : []);
          const nSame = can && S.rsim && S.rsim.key === p.key && S.rsim.art === st.art ? recSame(p).length : 0;
          const same = nSame ? `<div style="margin-top:4px"><button class="quiet" data-rsame="1" title="Поставити цю статтю ще в ${nSame} ${plural(nSame, 'рядок', 'рядки', 'рядків')} без статті на цьому рахунку з тим самим контрагентом («${esc(simKey(p))}»). Галочки не ставляться." style="height:24px;padding:0 8px;margin:0;font-size:12px">І для ще ${nSame} таких самих</button></div>` : '';
          const projWhy = !st.tp && !st.pm && !p.rule.proj && !projSeen(p.acc) && projects.length > 1 ? '<div class="muted xwhy">на рахунку ще немає записів з проєктом — перевірте проєкт</div>' : '';
          h += `<tr data-rk="${esc(p.key)}" data-rgrow="${p.acc}"${isOpen(p.acc) ? '' : ' class="shut"'}><td><input type="checkbox" data-ron${st.on && ok ? ' checked' : ''}${can && ok ? '' : ' disabled'}></td><td style="white-space:nowrap">${esc(dmy(p.date))}${p.buy ? `<div class="muted" style="font-size:12px" title="Банк провів покупку ${esc(dmy(p.date))}; у CRM покупки карткою — за датою покупки">у CRM — ${esc(dmy(p.buy))}</div>` : ''}</td>
<td class="n"><span class="${p.op === 1 ? 'ok' : 'bad'}">${p.op === 1 ? '+' : '−'}${esc(fmt(p.amount))}</span><div class="muted" style="font-weight:400;font-size:12px">${esc(SRC[p.src])}</div></td>
<td><select data-rart style="max-width:230px"${can ? '' : ' disabled'}>${artOpt(p.op, st.art)}</select>${why}${iss === 'marketer' ? mkHtml(p, st, can) : ''}${same}</td>
<td><select data-rproj${can ? '' : ' disabled'}>${projOpt(st.proj)}</select>${!st.tp && p.rule.proj && Number(st.proj) === Number(p.rule.proj.id) ? `<div class="muted xwhy">${esc(p.rule.proj.why)}</div>` : !st.tp && p.projMk && Number(st.proj) === Number(p.projMk.id) ? `<div class="muted xwhy">${esc(p.projMk.why)}</div>`
  : !st.tp && p.projHist && Number(st.proj) === Number(p.projHist.id) ? `<div class="muted xwhy">${esc(p.projHist.why)}</div>` : projWhy}</td>
<td><textarea class="xcom" data-rcom rows="${comRows(st.comment)}"${can ? '' : ' disabled'}>${esc(st.comment)}</textarea></td>
<td class="muted xwhy">${esc(bankTxt(p))}${p.acc !== p.bankAcc ? `<div>покупка карткою з рахунку «${esc(nameOf(p.bankAcc))}»</div>` : ''}${warns.length ? `<div class="warn" style="margin:4px 0 0;padding:4px 8px">${warns.map(esc).join('<br>')}</div>` : ''}</td></tr>`;
        }
        h += `</table></div><div class="row" style="margin-top:8px"><button class="primary" data-b="rcreate"${can && on.length && !S.busy ? '' : ' disabled'}>Створити позначені (${on.length})</button>
${can ? `${nBulk ? `<button class="quiet" data-b="rall">Позначити всі витрати зі статтею (${nBulk})</button>` : ''}<button class="quiet" data-b="rnone">Зняти позначки</button>` : ''}
<span class="muted small">${can ? 'Уперше створіть один запис і перевірте його в CRM — потім решту. Надходження позначайте по одному.' : 'Створювати записи можна в закладці «Лінтер кешфлоу (APPLY)»; тут — лише перегляд.'}</span></div>`;
      }
      if (off.length) h += `<details style="margin-top:10px"><summary>Ще ${off.length} ${plural(off.length, 'операція без запису в CRM, яку', 'операції без запису в CRM, які', 'операцій без запису в CRM, які')} лінтер не створює</summary><div style="margin-top:6px">${off.map(p => `<div class="pr">${esc(dmy(p.date))} <b>${p.op === 1 ? '+' : '−'}${esc(fmt(p.amount))}</b> · «${esc(nameOf(p.acc))}» · ${esc(p.row.cpty || '—')} · ${esc(p.row.purpose || '')}<div class="muted">${esc(p.block)}</div></div>`).join('')}</div></details>`;
      return h + '</div>';
    }
    // ---------- операції з виписок поза звіркою: службові й незіставлені рахунки, не проведені банком ----------
    /* Щоб нічого з виписки не губилось мовчки: операції періоду на рахунках банку без рахунку CRM (службові, технічні, ще один рахунок,
       «не звіряти», не зіставлені) і не проведені банком (Приват, PR_PR ≠ «r») — з причиною. Той самий рахунок з кількох файлів — один
       (файл, що покриває період, інакше найновіший). Лише довідка. → [{b, why, list: [{x, why}]}] */
    function outsideList() {
      const { from, to } = S, inP = x => !!x.date && x.date >= from && x.date <= to, keyOf = b => b.iban || `${b.fileName}|${b.owner}`;
      const out = [], seen = new Set();
      for (const b0 of S.banks) {
        const k = keyOf(b0);
        if (seen.has(k)) continue;
        seen.add(k);
        // як у bankFor: рівно — пізніше завантажений файл
        const b = S.banks.filter(x => keyOf(x) === k).reduce((cur, x) => (laterBank(x, cur, from, to) ? x : cur), null);
        const why = b.cfId ? '' : b.note || 'рахунок банку не зіставлено з рахунком CRM';
        // рахунок з CRM, але частину руху за правилом компанії в CRM не вносять (кошти броніків) — теж тут, з причиною
        const r = b.cfId ? (S.lastAll || []).find(r => r.b === b && (r.R.ruled || []).length) : null;
        const list = (b.cfId ? (r ? r.R.ruled.map(o => ({ x: o.row, why: o.why })) : []) : b.rows.filter(inP).map(x => ({ x, why }))).concat((b.skipped || []).filter(inP).map(x => ({ x, why: x.why })));
        if (list.length) out.push({ b, why: r ? 'кошти броніків (rules.json → bronik_accounts): у CRM не вносяться, дохід — «1.5% від бронювання»' : why, list: list.sort((p, q) => (p.x.date + (p.x.time || '') < q.x.date + (q.x.time || '') ? -1 : 1)) });
      }
      return out;
    }
    function outsideHtml() {
      const groups = outsideList();
      if (!groups.length) return '';
      const n = groups.reduce((s, g) => s + g.list.length, 0);
      let h = `<div class="card" data-b="outside"><details${S.outOpen ? ' open' : ''}><summary><b>Операції з виписок поза звіркою: ${n}</b> <span class="muted small" style="font-weight:400">— службові й незіставлені рахунки, не проведені банком, кошти броніків · лише довідка</span></summary>
<div class="muted small" style="margin:8px 0 4px">Ці операції є у виписках за період, але з CRM не звіряються. Службовий рахунок (масові виплати, РКО, ЗП, цільові зарахування) і технічний рахунок банку в CRM не потрібні — гроші з них ідуть на поточний рахунок чи виплати, які звіряються там. Рахунок, не зіставлений з CRM, звірятиметься, щойно ви виберете йому рахунок CRM у «Рахунки з виписок → рахунки CRM» вище. Операцію, яку банк не провів, звіряти нічим. Кошти броніків (їхні надходження, ЗП і податки за них) за правилом компанії в CRM не вносяться — дохід компанії записується окремо, «1.5% від бронювання».</div>`;
      for (const g of groups) {
        const sum = g.list.reduce((s, o) => s + o.x.amount, 0);
        h += `<div class="lbl" style="margin:12px 0 4px">${g.b.bank === 'mono' ? 'Моно' : 'Приват'} ${esc(tail(g.b.iban))} · ${esc(g.b.owner || g.b.client || '')} · ${g.list.length} ${plural(g.list.length, 'операція', 'операції', 'операцій')} · ${sum < 0 ? '−' : '+'}${esc(fmt(Math.abs(sum)))}${g.why ? `<div style="font-weight:400">${esc(g.why)}</div>` : ''}</div>
<table class="amts"><tr><th>Дата</th><th class="n">Сума</th><th>Контрагент · призначення</th>${g.list.some(o => o.why !== g.why) ? '<th>Чому поза звіркою</th>' : ''}</tr>${g.list.map(o => `<tr><td style="white-space:nowrap">${esc(dmy(o.x.date))}${o.x.time ? ' ' + esc(o.x.time) : ''}</td><td class="n">${esc(fmt(o.x.amount))}</td><td>${esc(o.x.cpty || '—')}${o.x.purpose ? ' · ' + esc(o.x.purpose) : ''}</td>${g.list.some(q => q.why !== g.why) ? `<td class="muted">${esc(o.why)}</td>` : ''}</tr>`).join('')}</table>`;
      }
      return h + '</details></div>';
    }
    // маркетолог для статті з рекламним бюджетом: список — з CRM, за замовчуванням — як у попередніх записах рахунку
    function mkHtml(p, st, can) {
      const bad = t => `<div class="bad" style="font-weight:400">${esc(t)}</div>`;
      if (p.op !== 2) return bad('стаття з маркетологом — лише для витрат');
      if (!S.mks) return '<div class="muted xwhy">читаю список маркетологів…</div>';
      const list = S.mks.slice();
      for (const id of [st.mk, p.mk && p.mk.id]) if (id && !list.some(m => m.id === id)) list.unshift({ id, name: mkName(id) }); // список не прочитано — з попередніх записів
      if (!list.length) return bad('не вдалося прочитати список маркетологів — внесіть запис через реєстр погоджень');
      return `<select data-rmk style="max-width:230px;margin-top:4px"${can ? '' : ' disabled'}><option value="">— маркетолог —</option>${list.map(m => `<option value="${m.id}"${m.id === st.mk ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` +
        (!st.mk ? bad('виберіть маркетолога: стаття з рекламним бюджетом') : !st.tm && p.mk && st.mk === p.mk.id ? `<div class="muted xwhy">${p.mk.cpty ? `маркетолог — за контрагентом «${esc(p.mk.cpty)}» (rules.json)` : p.mk.holder ? `маркетолог — хто тримає картку${p.mk.from ? ` з ${esc(dmy(p.mk.from))}` : ''} (довідник карток у rules.json)` : `маркетолог — як у найближчих схожих записах рахунку (${p.mk.n})`}</div>` : '');
    }
    function bindRecs() {
      const box = $('out'), keyOf = e => e.closest('[data-rk]').dataset.rk, q = k => box.querySelector(`[data-b="${k}"]`);
      // галочка — лише лічильники (кнопка й «позначено N» у рядку рахунку), без перемальовування
      const upd = () => {
        const live = S.lastRecs.filter(p => !p.block), on = p => ready(p) && S.rp.get(p.key).on, b = q('rcreate'), n = live.filter(on).length;
        if (b) { b.textContent = `Створити позначені (${n})`; b.disabled = !(opts.applyAllowed && n && !S.busy); }
        box.querySelectorAll('tr.rg[data-rg]').forEach(tr => {
          const acc = Number(tr.dataset.rg), k = live.filter(p => p.acc === acc && on(p)).length, gs = tr.querySelector('.gs');
          if (gs) gs.textContent = gs.textContent.replace(/ · позначено \d+$/, '') + (k ? ` · позначено ${k}` : '');
          const no = tr.querySelector('[data-rgnone]');
          if (no) no.hidden = !k;
        });
      };
      box.querySelectorAll('[data-ron]').forEach(e => e.onchange = () => { S.rp.get(keyOf(e)).on = e.checked; upd(); });
      box.querySelectorAll('[data-rart]').forEach(e => e.onchange = () => recPickArt(keyOf(e), e.value));
      box.querySelectorAll('[data-rsame]').forEach(e => e.onclick = () => recSpreadArt(keyOf(e)));
      // підказка ШІ: стаття (і проєкт, якщо ШІ його назвав) — як вибір людини
      box.querySelectorAll('[data-rai]').forEach(e => e.onclick = () => {
        const p = S.lastRecs.find(x => x.key === keyOf(e)), h = p && raHint(p), art = p && raArt(p, h), pr = raProj(h);
        if (!art) return;
        const st = S.rp.get(p.key);
        st.art = art.key; st.ta = true;
        if (pr) { st.proj = +pr[1]; st.tp = true; }
        render();
      });
      box.querySelectorAll('[data-rmk]').forEach(e => e.onchange = () => { const st = S.rp.get(keyOf(e)); st.mk = Number(e.value) || null; st.tm = true; if (!st.mk) st.on = false; render(); });
      box.querySelectorAll('[data-rproj]').forEach(e => e.onchange = () => { const st = S.rp.get(keyOf(e)); st.proj = +e.value; st.tp = true; LS.set('cfl_rec_proj', +e.value); });
      // коментар, змінений людиною, більше не підлаштовується (покупка карткою: за маркетологом, статтею й проєктом); порожній — знову автоматичний
      box.querySelectorAll('[data-rcom]').forEach(e => { comField(e); e.onchange = () => { const st = S.rp.get(keyOf(e)); st.comment = oneLine(e.value); st.tc = !!st.comment; if (!st.tc) render(); }; });
      // рядок рахунку — розгорнути / згорнути його операції (без перемальовування)
      box.querySelectorAll('tr.rg[data-rg]').forEach(e => e.onclick = () => {
        const acc = Number(e.dataset.rg), open = !e.classList.contains('open');
        S.rg.set(acc, open);
        e.classList.toggle('open', open);
        box.querySelectorAll(`tr[data-rgrow="${acc}"]`).forEach(t => t.classList.toggle('shut', !open));
      });
      // «позначити всі тут» у рядку рахунку — те саме, що кнопка внизу, але лише для цього рахунку (16.11.2026); рядок при цьому не згортається
      box.querySelectorAll('[data-rgall]').forEach(e => e.onclick = ev => { ev.stopPropagation(); const acc = Number(e.dataset.rgall); S.lastRecs.filter(p => p.acc === acc && bulkOk(p)).forEach(p => { S.rp.get(p.key).on = true; }); S.rg.set(acc, true); render(); });
      box.querySelectorAll('[data-rgnone]').forEach(e => e.onclick = ev => { ev.stopPropagation(); const acc = Number(e.dataset.rgnone); S.lastRecs.filter(p => p.acc === acc).forEach(p => { S.rp.get(p.key).on = false; }); render(); });
      if (q('rall')) q('rall').onclick = () => { S.lastRecs.filter(bulkOk).forEach(p => { S.rp.get(p.key).on = true; S.rg.set(p.acc, true); }); render(); };
      if (q('rnone')) q('rnone').onclick = () => { S.lastRecs.forEach(p => { S.rp.get(p.key).on = false; }); render(); };
      if (q('rcreate')) q('rcreate').onclick = () => (regCfg() && !S.wd.error && (S.wd.busy || !S.wd.rows)
        ? note('Реєстр погоджень ще читається — зачекайте кілька секунд і натисніть «Створити позначені» ще раз: поки його не прочитано, не видно, які операції мають погодження.', 'warn')
        : createMany(S.lastRecs.filter(p => ready(p) && S.rp.get(p.key).on), REC));
    }

    // ---------- записи з неправильним типом: змінити на «Переказ між рахунками» ----------
    const ccyOf = id => (S.accs.find(a => a.id === id) || {}).currency_id;
    /* Корп. картку поповнюють лише з рахунку її власника (rules.json → reference.card_topup, уточнення 30.10.2026): картки, що годяться
       для поповнення з рахунку acc, — діючі картки того самого ФОП / ТОВ; власника не видно з назви — усі діючі. */
    const SAME_OWNER = !(opts.rulesDoc && opts.rulesDoc.reference && opts.rulesDoc.reference.card_topup && opts.rulesDoc.reference.card_topup.same_owner === false);
    function topupCards(acc) {
      const all = S.accs.filter(a => Rc.isCorp(a) && !Rc.CARD_OFF.test(a.name || '') && a.id !== acc);
      const own = SAME_OWNER ? Rc.ownerCards(S.accs.find(a => a.id === acc), S.accs) : null;
      return own ? own.filter(a => a.id !== acc) : all;
    }
    /* corpCard для поповнення: номер картки в коментарі, тримач картки (rules.json → holders), названий у коментарі, картка, що
       звіряється з цим рахунком (якщо одна), єдина картка власника рахунку, інакше — куди раніше поповнювали з цього рахунку
       (щонайменше 60 % переказів на corpCard). Лише картки власника рахунку (topupCards). Якщо діючих карток у власника кілька
       (з 04.11.2026 — по дві в кожного ФОП), лише номер чи тримач: нова картка ще не платила й не має історії. {id, why} або null. */
    function topupTarget(c, r) {
      const ok = new Set(topupCards(c.acc).map(a => a.id));
      for (const m of String(c.comment || '').matchAll(/(?<!\d)(\d{4})(?!\d)/g)) { const k = S.dir.cards[m[1]]; if (k && k !== c.acc && ok.has(k)) return { id: k, why: `номер картки ${m[1]} у коментарі` }; }
      const h = Rc.holderCard(CARDS, c.comment, c.date, id => ok.has(id));
      if (h && h.id) return { id: h.id, why: `у коментарі ${h.name} — ${h.from ? `з ${dmy(h.from)} ` : ''}тримач картки ${h.last4}` };
      if (ok.size > 1 && SAME_OWNER && Rc.ownerOf(nameOf(c.acc))) return null;
      const mine = (r.cards || []).filter(k => ok.has(k));
      if (mine.length === 1) return { id: mine[0], why: 'картка, що списує з цього рахунку' };
      if (ok.size === 1 && SAME_OWNER && Rc.ownerOf((S.accs.find(a => a.id === c.acc) || {}).name)) return { id: [...ok][0], why: `єдина картка ${Rc.ownerOf((S.accs.find(a => a.id === c.acc) || {}).name)}` };
      const cnt = new Map();
      for (const x of [...(S.items.get(c.acc) || []), ...(S.hist.get(c.acc) || [])]) if (x.opc === 4 && ok.has(x.peer)) cnt.set(x.peer, (cnt.get(x.peer) || 0) + 1);
      const n = [...cnt.values()].reduce((s, v) => s + v, 0), top = [...cnt].sort((a, b) => b[1] - a[1])[0];
      return top && top[1] / n >= 0.6 ? { id: top[0], why: 'куди раніше поповнювали з цього рахунку' } : null;
    }
    /* У виписці переказ між своїми, а в CRM той самий рух — витрата чи дохід (стан «type»); поповнення корп. картки, записане витратою.
       Пропозиція — змінити запис на «Переказ між рахунками». other — другий рахунок переказу; out — гроші йдуть з рахунку запису. */
    function typeFixes(all) {
      const out = [], seen = new Set();
      // запис закритого в CRM місяця (за його періодом) не пропонується: змінити його може лише Адмін
      const add = p => { if (!seen.has(p.item.id) && !shut(p.item)) { seen.add(p.item.id); out.push(p); } };
      for (const r of all) {
        if (r.status === 'ccy') continue;
        for (const x of (r.R.own ? r.R.own.xfers : [])) {
          if (x.state !== 'type' || !x.item || !(x.item.opc === 1 || x.item.opc === 2)) continue;
          add({ item: x.item, other: x.peer, fixed: true, out: x.item.amount < 0,
            why: `у виписці ${dmy(x.row.date)} — переказ ${x.row.amount < 0 ? 'на' : 'з'} «${nameOf(x.peer)}»: ${x.row.cpty || '—'} · ${x.row.purpose || ''}` });
        }
        for (const c of r.topups || []) {
          const k = topupTarget(c, r);
          add({ item: c, other: k ? k.id : null, otherWhy: k ? k.why : '', fixed: false, out: true, why: 'поповнення корп. картки записано витратою' });
        }
      }
      for (const p of out) {
        Object.assign(p, { key: `type:${p.item.id}`, acc: p.item.acc, amount: r2(Math.abs(p.item.amount)), date: p.item.date });
        if (!S.tp.has(p.key)) S.tp.set(p.key, { on: false, other: p.other });
        const st = S.tp.get(p.key);
        if (!p.fixed && !st.other && p.other) st.other = p.other;
        // не змінюються: записи з лідів, до межі роботи, переказ у рахунок іншої валюти (це «Обмін»);
        // автоматичні записи (модуль ЗП, «Підтвердження виведення коштів з балансу») і зарплатні статті — як у «Статтях і проєктах»:
        // зміна типу стерла б статтю й підтвердження виводу (огляд 16.11.2026)
        p.block = p.item.draft ? 'це чернетка CRM — лінтер її не змінює: виправте в CRM («CashFlow» → «Чернетки»)' : p.item.lead ? 'запис створено з ліда CRM — лінтер його не змінює'
          : p.item.auto ? 'запис створено автоматично (модуль ЗП, вивід з балансу) — лінтер його не змінює: якщо це справді переказ, виправте в CRM вручну'
          : salaryArt(p.item.art) ? 'зарплатна стаття — такий запис CRM змінювати не дає: якщо це справді переказ, виправте в CRM вручну'
          : fixFrom && p.date < fixFrom ? `до ${dmy(fixFrom)} лінтер нічого не змінює` : '';
      }
      // той самий переказ записано двічі (витратою на одному рахунку й доходом на другому): змінити лише один, другий — дубль
      out.forEach((p, i) => {
        if (p.block || !S.tp.get(p.key).other) return;
        const [f, t] = typeEnds(p);
        const twin = out.slice(0, i).find(q => !q.block && S.tp.get(q.key).other && typeEnds(q)[0] === f && typeEnds(q)[1] === t && Math.round(q.amount * 100) === Math.round(p.amount * 100) && Math.abs(dayDiff(q.date, p.date)) <= 3);
        if (twin) p.block = `той самий переказ, що й ID ${twin.item.id}: змініть лише його, а цей запис — дубль (видаліть його в CRM вручну)`;
      });
      return out;
    }
    // поповнення корп. картки (не fixed) — лише на картку власника рахунку запису (topupCards)
    const typeOk = p => { const st = S.tp.get(p.key); return !p.block && !!st.other && st.other !== p.acc && ccyOf(st.other) === ccyOf(p.acc) && (p.fixed || topupCards(p.acc).some(a => a.id === st.other)); };
    const typeEnds = p => { const o = S.tp.get(p.key).other; return p.out ? [p.acc, o] : [o, p.acc]; };
    function typeHtml(all) {
      const props = S.lastTypes = typeFixes(all);
      if (!props.length) return '';
      const can = !!opts.applyAllowed && !noFull(), on = props.filter(p => typeOk(p) && S.tp.get(p.key).on);
      let h = `<div class="card" data-b="types"><div class="sub-h"><h3>Записи з неправильним типом</h3><span class="muted small">за правилами це «Переказ між рахунками», а в CRM — витрата чи дохід · ${props.length}</span></div>
<details class="hint" style="margin:0 0 10px"><summary>Що змінюється</summary><div>Лінтер може змінити тип запису — так само, як форма редагування CRM: сума, дата, коментар і проєкт не змінюються. Перед зміною запис зберігається як був (резервна копія), після — перевіряється; повернути можна кнопкою. Нічого не позначено заздалегідь.</div></details>
<div class="tbl" style="max-height:none"><table class="xf"><tr><th></th><th>Дата</th><th>Запис CRM</th><th class="n">Сума</th><th>Стане</th><th>Підстава</th></tr>`;
      for (const p of props) {
        const st = S.tp.get(p.key), ok = typeOk(p), [f, t] = st.other ? typeEnds(p) : [null, null];
        const cards = p.fixed ? [] : topupCards(p.acc).filter(a => a.currency_id === ccyOf(p.acc)), owner = Rc.ownerOf(nameOf(p.acc));
        const otherSel = p.fixed ? '' : `<select data-tother data-wide style="max-width:260px"${can ? '' : ' disabled'}><option value="">— рахунок картки —</option>${cards.map(a => `<option value="${a.id}"${a.id === st.other ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`;
        const note = p.block ? `<div class="bad" style="font-weight:400">${esc(p.block)}</div>`
          : !p.fixed && !cards.length ? `<div class="bad" style="font-weight:400">у CRM немає корп. картки ${esc(owner || 'цього власника')}: картку поповнюють лише з рахунку її власника</div>`
          : !st.other ? '<div class="bad" style="font-weight:400">виберіть рахунок картки</div>'
          : !p.fixed && !cards.some(a => a.id === st.other) ? `<div class="bad" style="font-weight:400">картка іншого власника: з «${esc(nameOf(p.acc))}» поповнюють лише картку ${esc(owner || 'цього власника')}</div>`
          : ccyOf(st.other) !== ccyOf(p.acc) ? '<div class="bad" style="font-weight:400">різна валюта рахунків — це «Обмін», змініть у CRM вручну</div>'
          : !p.fixed && p.otherWhy && st.other === p.other ? `<div class="muted xwhy">${esc(p.otherWhy)}</div>` : '';
        h += `<tr data-tk="${esc(p.key)}"><td><input type="checkbox" data-ton${st.on && ok ? ' checked' : ''}${can && ok ? '' : ' disabled'}></td><td>${esc(dmy(p.date))}</td>
<td>ID ${p.item.id} · ${esc(p.item.op)} · «${esc(nameOf(p.acc))}»<div class="muted" style="font-size:12px">${esc(clean(p.item.comment).slice(0, 120))}</div></td>
<td class="n">${esc(fmt(p.amount))}</td>
<td>«Переказ між рахунками»: ${f ? `«${esc(nameOf(f))}» →<br>«${esc(nameOf(t))}»` : `«${esc(nameOf(p.acc))}» → …`}${otherSel ? `<div style="margin-top:4px">${otherSel}</div>` : ''}${note}</td>
<td class="muted xwhy">${esc(p.why)}</td></tr>`;
      }
      return h + `</table></div><div class="row" style="margin-top:8px"><button class="primary" data-b="tchange"${can && on.length && !S.busy ? '' : ' disabled'}>Змінити позначені (${on.length})</button>
${can ? '<button class="quiet" data-b="tall">Позначити всі</button><button class="quiet" data-b="tnone">Зняти позначки</button>' : ''}
<span class="muted small">${can ? 'Уперше змініть один запис і перевірте його в CRM — потім решту.' : noFull() ? esc(M.noFullText(rights)) : 'Змінювати записи можна в закладці «Лінтер кешфлоу (APPLY)»; тут — лише перегляд.'}</span></div></div>`;
    }
    function bindTypes() {
      const box = $('out'), keyOf = e => e.closest('[data-tk]').dataset.tk, q = k => box.querySelector(`[data-b="${k}"]`);
      // галочка — лише лічильник на кнопці, без перемальовування
      const upd = () => { const n = S.lastTypes.filter(p => typeOk(p) && S.tp.get(p.key).on).length, b = q('tchange');
        if (b) { b.textContent = `Змінити позначені (${n})`; b.disabled = !(opts.applyAllowed && !noFull() && n && !S.busy); } };
      box.querySelectorAll('[data-ton]').forEach(e => e.onchange = () => { S.tp.get(keyOf(e)).on = e.checked; upd(); });
      box.querySelectorAll('[data-tother]').forEach(e => e.onchange = () => { const st = S.tp.get(keyOf(e)); st.other = Number(e.value) || null; if (!st.other) st.on = false; render(); });
      if (q('tall')) q('tall').onclick = () => { S.lastTypes.filter(typeOk).forEach(p => { S.tp.get(p.key).on = true; }); render(); };
      if (q('tnone')) q('tnone').onclick = () => { S.lastTypes.forEach(p => { S.tp.get(p.key).on = false; }); render(); };
      if (q('tchange')) q('tchange').onclick = () => changeTypes(S.lastTypes.filter(p => typeOk(p) && S.tp.get(p.key).on));
    }

    // ---------- поповнення корп. картки не на ту картку власника: переспрямувати (змінити рахунок «куди» переказу) ----------
    const cardNum = id => Object.keys(S.dir.cards || {}).find(t => Number(S.dir.cards[t]) === id) || Rc.nameTail(S.accs.find(a => a.id === id)) || `ID ${id}`;
    /* Перекази «рахунок ФОП / ТОВ → його корп. картка» з MARGIN днів до періоду по кінець періоду, у власника кілька діючих карток
       тієї самої валюти: куди мали піти гроші — wrongTopups (номер чи тримач у коментарі, покупки у виписці). Записи закритого місяця
       не пропонуються (змінює їх лише Адмін), до межі роботи й з лідів — лише з поясненням. */
    function repointFixes(all) {
      const out = [], lo = addDays(S.from, -MARGIN);
      for (const r of all) {
        if (r.status === 'merged' || r.status === 'ccy' || Rc.isCorp(r.a)) continue;
        const own = topupCards(r.a.id).filter(a => a.currency_id === r.a.currency_id);
        if (own.length < 2) continue;
        const ids = new Set(own.map(a => a.id));
        const xfers = (S.items.get(r.a.id) || []).filter(x => x.opc === 4 && ids.has(Number(x.peer)) && x.date >= lo && x.date <= S.to && !shut(x));
        if (!xfers.length) continue;
        const cards = own.map(a => ({ id: a.id, last4: cardNum(a.id), balance: Number(a.balance) }));
        for (const f of wrongTopups({ xfers, cards, tails: S.dir.cards, holders: CARDS, rows: r.b ? r.b.rows : null, fileFrom: r.b ? r.b.fileFrom : null })) {
          const x = f.item, bal = id => (cards.find(c => c.id === id) || {}).balance;
          const wasH = CARDS.find(c => Number(c.account_id) === f.was), wh = wasH && holderOf(wasH, x.date);
          const why = f.how === 'num' ? `у коментарі номер картки ${f.num}`
            : f.how === 'holder' ? `у коментарі ${f.holder.name} — ${f.holder.from ? `з ${dmy(f.holder.from)} ` : ''}тримач картки ${f.holder.last4} (rules.json)${wh ? `, а картку ${cardNum(f.was)} тримає ${wh.name}` : ''}`
            : `після поповнення у виписці платить лише картка ${cardNum(f.to)} (${f.spent.n} ${plural(f.spent.n, 'покупка', 'покупки', 'покупок')} на ${fmt(f.spent.sum)}), карткою ${cardNum(f.was)} — жодної; у CRM на «${nameOf(f.to)}» ${fmt(bal(f.to))}, а на «${nameOf(f.was)}» поповнення не витрачено (залишок ${fmt(bal(f.was))})`;
          out.push({ key: `rp:${x.id}`, item: x, acc: r.a.id, was: f.was, to: f.to, how: f.how, amount: r2(Math.abs(x.amount)), date: x.date, why,
            line: `на картку ${cardNum(f.was)} замість ${cardNum(f.to)}`, cards: own.map(a => a.id),
            block: x.draft ? 'це чернетка CRM — лінтер її не змінює: виправте в CRM («CashFlow» → «Чернетки»)' : x.lead ? 'запис створено з ліда CRM — лінтер його не змінює' : fixFrom && x.date < fixFrom ? `до ${dmy(fixFrom)} лінтер нічого не змінює` : '' });
        }
      }
      for (const p of out) if (!S.rpt.has(p.key)) S.rpt.set(p.key, { on: false, to: p.to });
      return out;
    }
    const repOk = p => { const st = S.rpt.get(p.key); return !p.block && !!st && !!st.to && st.to !== p.was && p.cards.includes(st.to) && ccyOf(st.to) === ccyOf(p.was); };
    function repointHtml() {
      const props = S.lastReps;
      if (!props.length) return '';
      const can = !!opts.applyAllowed && !noFull(), on = props.filter(p => repOk(p) && S.rpt.get(p.key).on);
      let h = `<div class="card" data-b="reps"><div class="sub-h"><h3>Поповнення не на ту картку</h3><span class="muted small">переказ з рахунку на корп. картку записано на іншу картку цього власника · ${props.length}</span></div>
<details class="hint" style="margin:0 0 10px"><summary>Як це видно</summary><div>Самого поповнення корп. картки в банку немає: Приват списує покупки картки прямо з рахунку ФОП, а номер картки є в кожній покупці. Тому лінтер дивиться на коментар поповнення (номер картки, тримач з rules.json) і на покупки у виписці після нього: якщо платить лише інша картка, а ця — ні, поповнення, найпевніше, було для неї. Переспрямувати — змінити рахунок «куди» переказу, як у формі редагування CRM: сума, дата, коментар і проєкт не змінюються. Перед зміною запис зберігається як був, після — перевіряється; повернути можна кнопкою. Нічого не позначено заздалегідь.</div></details>
<div class="tbl" style="max-height:none"><table class="xf"><tr><th></th><th>Дата</th><th>Запис CRM</th><th class="n">Сума</th><th>Стане</th><th>Підстава</th></tr>`;
      for (const p of props) {
        const st = S.rpt.get(p.key), ok = repOk(p);
        const sel = `<select data-rpto data-wide style="max-width:260px"${can && !p.block ? '' : ' disabled'}>${p.cards.filter(id => id !== p.was).map(id => `<option value="${id}"${id === st.to ? ' selected' : ''}>${esc(nameOf(id))}</option>`).join('')}</select>`;
        const note = p.block ? `<div class="bad" style="font-weight:400">${esc(p.block)}</div>` : ccyOf(st.to) !== ccyOf(p.was) ? '<div class="bad" style="font-weight:400">різна валюта рахунків карток</div>' : '';
        h += `<tr data-rpk="${esc(p.key)}"><td><input type="checkbox" data-rpon${st.on && ok ? ' checked' : ''}${can && ok ? '' : ' disabled'}></td><td>${esc(dmy(p.date))}</td>
<td>ID ${p.item.id} · переказ «${esc(nameOf(p.acc))}» → «${esc(nameOf(p.was))}»<div class="muted" style="font-size:12px">${esc(clean(p.item.comment).slice(0, 120))}</div></td>
<td class="n">${esc(fmt(p.amount))}</td>
<td>«${esc(nameOf(p.acc))}» →<div style="margin-top:4px">${sel}</div>${note}</td>
<td class="muted xwhy">${esc(p.why)}</td></tr>`;
      }
      return h + `</table></div><div class="row" style="margin-top:8px"><button class="primary" data-b="rpchange"${can && on.length && !S.busy ? '' : ' disabled'}>Переспрямувати позначені (${on.length})</button>
${can ? '<button class="quiet" data-b="rpall">Позначити всі</button><button class="quiet" data-b="rpnone">Зняти позначки</button>' : ''}
<span class="muted small">${can ? 'Уперше змініть один запис і перевірте його в CRM — потім решту.' : noFull() ? esc(M.noFullText(rights)) : 'Змінювати записи можна в закладці «Лінтер кешфлоу (APPLY)»; тут — лише перегляд.'}</span></div></div>`;
    }
    function bindRepoint() {
      const box = $('out'), keyOf = e => e.closest('[data-rpk]').dataset.rpk, q = k => box.querySelector(`[data-b="${k}"]`);
      const upd = () => { const n = S.lastReps.filter(p => repOk(p) && S.rpt.get(p.key).on).length, b = q('rpchange');
        if (b) { b.textContent = `Переспрямувати позначені (${n})`; b.disabled = !(opts.applyAllowed && !noFull() && n && !S.busy); } };
      box.querySelectorAll('[data-rpon]').forEach(e => e.onchange = () => { S.rpt.get(keyOf(e)).on = e.checked; upd(); });
      box.querySelectorAll('[data-rpto]').forEach(e => e.onchange = () => { const st = S.rpt.get(keyOf(e)); st.to = Number(e.value) || null; if (!st.to) st.on = false; render(); });
      if (q('rpall')) q('rpall').onclick = () => { S.lastReps.filter(repOk).forEach(p => { S.rpt.get(p.key).on = true; }); render(); };
      if (q('rpnone')) q('rpnone').onclick = () => { S.lastReps.forEach(p => { S.rpt.get(p.key).on = false; }); render(); };
      if (q('rpchange')) q('rpchange').onclick = () => repoint(S.lastReps.filter(p => repOk(p) && S.rpt.get(p.key).on));
    }
    // переказ з тим самим рахунком «з» і новим «куди» — як форма редагування CRM (перекази між рахунками однієї валюти)
    const repBody = (from, to) => ({ operation: '3', invoice_from: String(from), invoice_to: String(to), currency_id: String(ccyOf(to)) });
    async function repoint(list) {
      if (!opts.applyAllowed || !list.length || S.busy) return;
      const reqs = list.map(p => ({ p, to: S.rpt.get(p.key).to })), n = reqs.length, p0 = reqs[0].p, b0 = repBody(p0.acc, reqs[0].to);
      const ann = k => (k === 'invoice_from' || k === 'invoice_to' ? ` — ${nameOf(+b0[k])}` : k === 'currency_id' ? ` — ${(S.ccy || {})[b0[k]] || ''}` : k === 'operation' ? ' — переказ' : '');
      const html = `<h3>Переспрямувати ${n === 1 ? 'поповнення' : `поповнення: ${n}`} на іншу корп. картку</h3>
<p>Буде відправлено ${n === 1 ? 'запит' : `${n} запити (по одному на запис)`} <code>PUT /api/invoice-payment/ID</code> — так само переказ змінює форма редагування CRM. ${n === 1 ? 'Запит' : 'Перший'} — ID ${p0.item.id} (${esc(fmt(p0.amount))}, було «${esc(nameOf(p0.acc))}» → «${esc(nameOf(p0.was))}»):</p>
<table class="kv">${Object.entries(b0).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}${esc(ann(k))}</td></tr>`).join('')}</table>
${n > 1 ? `<details><summary>Усі ${n}</summary><ul>${reqs.map(({ p, to }) => `<li>${esc(`ID ${p.item.id} ${dmy(p.date)} ${fmt(p.amount)}: «${nameOf(p.was)}» → «${nameOf(to)}»`)}</li>`).join('')}</ul></details>` : ''}
<p>Сума, дата, коментар і проєкт не змінюються. Перед зміною лінтер перечитує кожен запис (якщо його вже змінили — пропуск) і зберігає, яким він був: резервна копія — файлом і в журналі; після зміни — перевіряє, що це переказ з того самого рахунку на вибрану картку з тією самою сумою й датою.</p>`;
      if (!await opts.dialog(html, n === 1 ? 'Так, переспрямувати' : `Так, переспрямувати ${n}`, true)) return;
      busy(true);
      if (opts.setBusy) opts.setBusy(true);
      const journal = [], backup = [], backupName = `кешфлоу_резервна_копія_тип_${stamp()}.json`;
      const persist = typeJournal(journal);
      let saved = false, kept = null, noRights = false;
      try {
        for (const [i, { p, to }] of reqs.entries()) {
          persist();
          st(`переспрямовую поповнення ${i + 1} з ${n}…`);
          let wrote = false;
          const e = { at: new Date().toISOString(), action: 'переспрямування поповнення корп. картки', id: p.item.id, from: p.acc, fromName: nameOf(p.acc), was: p.was, wasName: nameOf(p.was), to, toName: nameOf(to), amount: p.amount, date: p.date, before: null, result: '', note: '' };
          journal.push(e);
          if (noRights) { e.result = 'пропущено'; e.note = NOT_SENT; continue; }
          try {
            const rec = recOf(await api.get('invoice-payment/' + p.item.id));
            if (!rec || rec.deleted_at || livePays(rec).length !== 2 || !pay(rec, p.acc, [4], p.amount) || !pay(rec, p.was, [3], p.amount)) {
              e.result = 'пропущено'; e.note = 'запис змінили після звірки — не змінено'; continue;
            }
            e.before = { op: 3, from: p.acc, to: p.was, amount: p.amount, date: M.kyivDate(rec.date) };
            backup.push({ id: p.item.id, record: rec });
            if (!saved) { saved = true; kept = await keepFile(backupName, 'application/json', JSON.stringify(backup, null, 1), 'backups'); }
            const res = await api.put('invoice-payment/' + p.item.id, repBody(p.acc, to));
            if (res.status < 200 || res.status >= 300) throw M.crmError(res, 'put');
            wrote = true;
            Object.assign(e, { result: 'перевірте', note: 'переспрямовано, перевіряю…' });
            persist();
            const after = recOf(await api.get('invoice-payment/' + p.item.id)), bad = [];
            if (!pay(after, p.acc, [4], p.amount)) bad.push(`списання з «${nameOf(p.acc)}»`);
            if (!pay(after, to, [3], p.amount)) bad.push(`зарахування на «${nameOf(to)}»`);
            if (livePays(after).length !== 2) bad.push('у записі не два рухи');
            if (after && after.date && M.kyivDate(after.date) !== p.date) bad.push(`дата ${dmy(M.kyivDate(after.date))}`);
            e.result = bad.length ? 'перевірте' : 'ok';
            e.note = bad.length ? `змінено, але не збігається: ${bad.join(', ')}` : 'переспрямовано й перевірено';
          } catch (err) {
            if (wrote) { e.result = 'перевірте'; e.note = `змінено, але не вдалося перевірити: ${err.message}`; continue; }
            noRights = failed(e, err) === 'rights';
            if (err.kind === 'closed' && CL && p.item.per) CL.learn(p.item.per);
          }
        }
      } finally {
        busy(false);
        if (opts.setBusy) opts.setBusy(false);
      }
      if (backup.length > 1 && kept && kept.where === 'helper') { try { await keepFile(backupName, 'application/json', JSON.stringify(backup, null, 1), 'backups'); } catch (e) {} }
      persist();
      await finishTypes(journal, 'Переспрямування поповнень', true);
    }
    // запит — як форма редагування CRM: лише змінені поля (JSON), непотрібні для переказу очищаються порожнім рядком
    function typeBody(p) {
      const [f, t] = typeEnds(p);
      return { operation: '3', invoice_from: String(f), invoice_to: String(t), currency_id: String(ccyOf(t)), invoice_id: '', pnl_category_id: '', pnl_operation_id: '',
        show_response_in_currency: '', ...(p.item.mk ? { marketer_id: '' } : {}) };
    }
    // як було: витрата чи дохід на рахунку запису, зі статтею й маркетологом; переспрямоване поповнення (op 3) — переказ на ту саму картку, що й був
    function restoreBody(b) {
      if (b.op === 3) return repBody(b.from, b.to);
      const c = String(ccyOf(b.acc));
      return { operation: String(b.op), invoice_id: String(b.acc), pnl_category_id: b.cat == null ? '' : String(b.cat), pnl_operation_id: b.opid == null ? '' : String(b.opid),
        show_response_in_currency: c, currency_id: c, invoice_from: '', invoice_to: '', ...(b.mk ? { marketer_id: String(b.mk) } : {}) };
    }
    const recOf = g => (g && g.data && g.data.payments ? g.data : g);
    const livePays = rec => ((rec && rec.payments) || []).filter(x => !x.deleted_at);
    const mbOf = rec => { const m = rec && rec.marketer_balance_history && rec.marketer_balance_history.marketer_balance; return m && m.user_id ? Number(m.user_id) : null; };
    async function changeTypes(list) {
      if (!opts.applyAllowed || !list.length || S.busy) return;
      const reqs = list.map(p => ({ p, body: typeBody(p) })), n = reqs.length, b0 = reqs[0].body, p0 = reqs[0].p;
      const ann = k => (k === 'invoice_from' || k === 'invoice_to' ? ` — ${nameOf(+b0[k])}` : k === 'currency_id' ? ` — ${(S.ccy || {})[b0[k]] || ''}` : b0[k] === '' ? ' — очистити' : k === 'operation' ? ' — переказ' : '');
      const html = `<h3>Змінити тип ${n === 1 ? 'запису' : `записів: ${n}`} на «Переказ між рахунками»</h3>
<p>Буде відправлено ${n === 1 ? 'запит' : `${n} запити (по одному на запис)`} <code>PUT /api/invoice-payment/ID</code> — так само запис змінює форма редагування CRM. ${n === 1 ? 'Запит' : 'Перший'} — ID ${p0.item.id} (${esc(p0.item.op)}, ${esc(fmt(p0.amount))}, «${esc(nameOf(p0.acc))}»):</p>
<table class="kv">${Object.entries(b0).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v === '' ? '""' : v)}${esc(ann(k))}</td></tr>`).join('')}</table>
${n > 1 ? `<details><summary>Усі ${n}</summary><ul>${reqs.map(({ p }) => { const [f, t] = typeEnds(p); return `<li>${esc(`ID ${p.item.id} ${dmy(p.date)} ${fmt(p.amount)}: «${nameOf(f)}» → «${nameOf(t)}»`)}</li>`; }).join('')}</ul></details>` : ''}
<p>Сума, дата, коментар і проєкт не змінюються. Якщо в записі є маркетолог (рекламний бюджет), його буде прибрано (<code>marketer_id</code> — очистити): у переказу маркетолога немає. Перед зміною лінтер перечитує кожен запис (якщо його вже змінили — пропуск) і зберігає, яким він був: резервна копія — файлом і в журналі; після зміни — перевіряє, що запис став переказом між цими рахунками з тією самою сумою й датою і без маркетолога.</p>`;
      if (!await opts.dialog(html, n === 1 ? 'Так, змінити' : `Так, змінити ${n}`, true)) return;
      busy(true);
      if (opts.setBusy) opts.setBusy(true);
      const journal = [], backup = [], backupName = `кешфлоу_резервна_копія_тип_${stamp()}.json`;
      const persist = typeJournal(journal);
      let saved = false, kept = null, noRights = false;
      try {
        for (const [i, { p, body }] of reqs.entries()) {
          persist();
          st(`змінюю тип запису ${i + 1} з ${n}…`);
          let wrote = false;
          const [f, t] = typeEnds(p);
          const e = { at: new Date().toISOString(), action: 'зміна типу на переказ між рахунками', id: p.item.id, from: f, fromName: nameOf(f), to: t, toName: nameOf(t), amount: p.amount, date: p.date, before: null, result: '', note: '' };
          journal.push(e);
          if (noRights) { e.result = 'пропущено'; e.note = NOT_SENT; continue; }
          try {
            const rec = recOf(await api.get('invoice-payment/' + p.item.id)), pays = livePays(rec);
            const x = pays.length === 1 ? pays[0] : null;
            if (!rec || rec.deleted_at || !x || Number(x.invoice_id) !== p.acc || Number(x.operation) !== p.item.opc || Math.abs(Number(x.amount) - p.amount) >= 0.005) {
              e.result = 'пропущено'; e.note = 'запис змінили після звірки — не змінено'; continue;
            }
            // щойно прочитаний запис: інша дата, ніж у звірці, автоматичний або з ліда — теж не змінюється (огляд 16.11.2026);
            // без поля is_manual у відповіді (не знаємо) — вірити списку записів, з якого зроблено звірку
            if (M.kyivDate(rec.date) !== p.date || rec.task_payment_id != null || (rec.is_manual !== undefined && [...Rc.cashflowByAccount([rec]).values()].some(l => l.some(c => c.auto)))) {
              e.result = 'пропущено'; e.note = M.kyivDate(rec.date) !== p.date ? 'дату запису змінили після звірки — не змінено' : 'запис автоматичний або з ліда — лінтер його не змінює'; continue;
            }
            e.before = { op: Number(x.operation), acc: Number(x.invoice_id), cat: x.pnl_category_id, opid: x.pnl_operation_id, mk: mbOf(rec), amount: Number(x.amount), date: M.kyivDate(rec.date) };
            backup.push({ id: p.item.id, record: rec });
            if (!saved) { // резервна копія — до першої зміни (далі доповнюється в журналі)
              saved = true;
              kept = await keepFile(backupName, 'application/json', JSON.stringify(backup, null, 1), 'backups');
            }
            // маркетолог (рекламний бюджет) — лише в записі, прочитаному щойно (у списку записів CRM його немає): у переказу його не лишаємо (07.11.2026)
            const res = await api.put('invoice-payment/' + p.item.id, mbOf(rec) ? { ...body, marketer_id: '' } : body);
            if (res.status < 200 || res.status >= 300) throw M.crmError(res, 'put');
            wrote = true;
            Object.assign(e, { result: 'перевірте', note: 'змінено, перевіряю…' });
            persist(); // журнал з «як було» — одразу після зміни, а не після всього пакета
            const after = recOf(await api.get('invoice-payment/' + p.item.id)), bad = [];
            if (!pay(after, f, [4], p.amount)) bad.push(`списання з «${nameOf(f)}»`);
            if (!pay(after, t, [3], p.amount)) bad.push(`зарахування на «${nameOf(t)}»`);
            if (after && after.date && M.kyivDate(after.date) !== p.date) bad.push(`дата ${dmy(M.kyivDate(after.date))}`);
            if (mbOf(after)) bad.push('маркетолог лишився в записі');
            e.result = bad.length ? 'перевірте' : 'ok';
            e.note = bad.length ? `змінено, але не збігається: ${bad.join(', ')}` : 'змінено й перевірено';
          } catch (err) {
            if (wrote) { e.result = 'перевірте'; e.note = `змінено, але не вдалося перевірити: ${err.message}`; continue; }
            noRights = failed(e, err) === 'rights';
            if (err.kind === 'closed' && CL && p.item.per) CL.learn(p.item.per); // далі цей місяць не звіряється
          }
        }
      } finally {
        busy(false);
        if (opts.setBusy) opts.setBusy(false);
      }
      // уся резервна копія — тим самим файлом у папці Помічника (завантаженням — ні, щоб не плодити файли; «як було» є в журналі)
      if (backup.length > 1 && kept && kept.where === 'helper') { try { await keepFile(backupName, 'application/json', JSON.stringify(backup, null, 1), 'backups'); } catch (e) {} }
      persist();
      await finishTypes(journal, 'Зміна типу на переказ', true);
    }
    // повернути як було — для записів, які лінтер щойно змінив
    async function restoreTypes(entries) {
      if (!opts.applyAllowed || !entries.length || S.busy) return;
      if (!await opts.dialog(`<h3>Повернути ${entries.length === 1 ? 'запис' : `записи: ${entries.length}`} як було</h3><p>Для кожного буде відправлено <code>PUT /api/invoice-payment/ID</code> з типом, рахунками й статтею, які були до зміни. Перший — ID ${entries[0].id}:</p><pre>${esc(JSON.stringify(restoreBody(entries[0].before), null, 2))}</pre>`, 'Так, повернути', true)) return;
      busy(true);
      if (opts.setBusy) opts.setBusy(true);
      const journal = [];
      let noRights = false;
      try {
        for (const e0 of entries) {
          const b = e0.before, e = { at: new Date().toISOString(), action: 'повернення типу як було', id: e0.id, amount: e0.amount, date: e0.date, result: '', note: '' };
          journal.push(e);
          if (noRights) { e.result = 'пропущено'; e.note = NOT_SENT; continue; }
          let wrote = false;
          try {
            const res = await api.put('invoice-payment/' + e0.id, restoreBody(b));
            if (res.status < 200 || res.status >= 300) throw M.crmError(res, 'put');
            wrote = true;
            const after = recOf(await api.get('invoice-payment/' + e0.id));
            const ok = b.op === 3 ? pay(after, b.from, [4], b.amount) && pay(after, b.to, [3], b.amount) && livePays(after).length === 2
              : pays(after, b.acc, [b.op], b.amount).length === 1 && livePays(after).length === 1;
            e.result = ok ? 'ok' : 'перевірте';
            e.note = ok ? 'повернуто й перевірено' : 'повернуто, але запис не такий, як був — перевірте в CRM';
          } catch (err) {
            if (wrote) { e.result = 'перевірте'; e.note = `повернуто, але не вдалося перевірити: ${err.message}`; continue; }
            noRights = failed(e, err) === 'rights';
          }
        }
      } finally {
        busy(false);
        if (opts.setBusy) opts.setBusy(false);
      }
      await finishTypes(journal, 'Повернення як було');
    }
    /* Журнал змін типу в браузері — після кожного запису (з «як було»), а не лише після пакета: вкладку закрили чи перезавантажили
       посеред пакета — у журналі є, які записи вже змінено і якими вони були (07.11.2026). → persist() */
    function typeJournal(journal) {
      const base = LS.get('cfl_type_journal', []);
      return () => LS.set('cfl_type_journal', base.concat(journal).slice(-500));
    }
    async function finishTypes(journal, title, persisted) {
      if (!persisted) LS.set('cfl_type_journal', LS.get('cfl_type_journal', []).concat(journal).slice(-500)); // persisted — уже збережено по одному (typeJournal)
      let saved = { where: 'download' };
      try { saved = await keepFile(`кешфлоу_тип_журнал_${stamp()}.json`, 'application/json', JSON.stringify(journal, null, 1), 'journals'); } catch (e) {}
      const cnt = {};
      journal.forEach(e => { cnt[e.result] = (cnt[e.result] || 0) + 1; });
      await calc(); // перечитати CRM: змінені записи зникнуть зі списку, рахунки перерахуються
      note(`${title}: ${Object.entries(cnt).map(([k, v]) => `${k === 'ok' ? 'зроблено й перевірено' : k} — ${v}`).join(', ')}. Журнал — ${saved.where === 'helper' ? `у папці Помічника: ${saved.path}` : '«кешфлоу_тип_журнал_….json» у «Завантаженнях»'}.`, journal.every(e => e.result === 'ok') ? 'info' : 'warn');
      journal.filter(e => e.result !== 'ok').forEach(e => note(`ID ${e.id}: ${e.note}`, BAD.includes(e.result) ? 'err' : 'warn'));
      refusalNote(journal, 'put');
      const done = journal.filter(e => e.before && (e.result === 'ok' || e.result === 'перевірте'));
      if (done.length && opts.applyAllowed) {
        $('notes').insertAdjacentHTML('beforeend', `<div class="info">Змінено записів: ${done.length}. <span class="lnk" data-b="tundo">Повернути ${done.length === 1 ? 'його' : 'їх'} як було</span></div>`);
        const links = $('notes').querySelectorAll('[data-b="tundo"]');
        links[links.length - 1].onclick = () => restoreTypes(done);
      }
    }
    // резервна копія й журнал — у папку Помічника без вікна «Зберегти як» (storage.keepFile), інакше — завантаженням
    const keepFile = async (name, mime, data, kind) => (storage.keepFile ? storage.keepFile(name, mime, data, kind) : (await storage.saveFile(name, mime, data), { where: 'download' }));
    /* Помилка запиту → рядок журналу. Відмови CRM з оновлення 29.10.2026 (M.crmError: закритий місяць — 422 errors.period,
       бракує прав — 403) — окремим результатом; після відмови в правах решту запитів не надсилаємо. → err.kind */
    const BAD = ['помилка', 'місяць закрито', 'немає прав'], NOT_SENT = 'не надсилалось: CRM відмовив у правах на попередньому записі';
    function failed(e, err) {
      e.result = err.kind === 'closed' ? 'місяць закрито' : err.kind === 'rights' ? 'немає прав' : 'помилка';
      e.note = err.message;
      return err.kind;
    }
    function refusalNote(journal, action) {
      const closed = journal.filter(e => e.result === 'місяць закрито').length;
      if (closed) note(`CRM відмовив через закритий місяць: ${closed}. Змінювати такий місяць може лише Адмін${closedTo() ? `; лінтер запам'ятав «закрито по ${M.monthUa(closedTo())}» — ці місяці більше не звіряються` : ''}.`, 'err');
      if (journal.some(e => e.result === 'немає прав')) note(action === 'post' ? 'CRM відмовив у правах вносити операції — зверніться до адміністратора CRM.' : M.noFullText(rights), 'err');
    }

    // ---------- створення в CRM: ті самі запити, що й у реєстрі погоджень 1.9 ----------
    const LOCATION = '1'; // країна призначення в кешфлоу — завжди Україна; проєкт — вибраний (уточнення 27.10.2026)
    function transferForm(p) {
      const st = S.xp.get(p.key), d = crmDate(p.date, p.time);
      const to = S.accs.find(a => a.id === p.to) || {};
      return { operation: '3', amount: String(st.amount), invoice_from: String(p.from), invoice_to: String(p.to), date: d.date, period: d.period,
        comment: st.comment || defaultComment(p), location_id: LOCATION, project_id: String(st.proj), currency_id: String(to.currency_id) };
    }
    // витрата — як «Внести» в реєстрі (operation 2, marketer_id — для статті з рекламним бюджетом); надходження — той самий запит з operation 1. Валюта — рахунку.
    function recordForm(p) {
      const st = S.rp.get(p.key), d = recWhen(p, closedTo()), [cat, op] = st.art.split('/'); // покупка карткою — за датою покупки
      const ccy = String((S.accs.find(a => a.id === p.acc) || {}).currency_id);
      const f = { operation: String(p.op), amount: String(p.amount), invoice_id: String(p.acc), date: d.date, period: d.period, comment: st.comment || p.comment,
        location_id: LOCATION, project_id: String(st.proj) };
      if (artIssue(st.art) === 'marketer' && st.mk) f.marketer_id = String(st.mk);
      return Object.assign(f, { pnl_category_id: cat, pnl_operation_id: op, show_response_in_currency: ccy, currency_id: ccy });
    }
    const formData = f => { const d = new FormData(); Object.entries(f).forEach(([k, v]) => d.append(k, v)); return d; };
    const idOf = res => { const t = res.json && res.json.data !== undefined ? res.json.data : res.json; return t && typeof t === 'object' ? (Number.isInteger(t.transaction_id) ? t.transaction_id : Array.isArray(t.payments) && Number.isInteger(t.id) ? t.id : null) : null; };
    /* Що створюється: form — поля запиту; acc — рахунок для пошуку дублів; check — перед запитом (дубль чи новий запис після звірки → не створювати);
       is — новий запис, коли CRM не повернув ID; verify — розбіжності створеного запису (дату перевіряє createMany). */
    const XFER = {
      one: 'переказ', what: n => (n === 1 ? 'переказ' : `перекази: ${n}`), how: 'так само переказ створює ваш реєстр погоджень', doing: 'створюю переказ',
      dupText: 'такого переказу ще немає (±3 дні)', title: 'Перекази між своїми', ls: 'cfl_xfer_journal', btn: 'xcreate', file: 'кешфлоу_перекази_журнал',
      form: transferForm, acc: p => p.from, action: () => 'створення переказу між рахунками',
      note: (k, v) => (k === 'invoice_from' || k === 'invoice_to' ? nameOf(+v) : ''),
      line: (p, f) => `${dmy(p.date)}: ${nameOf(p.from)} → ${nameOf(p.to)}, ${fmt(Number(f.amount))}`,
      entry: p => ({ from: p.from, fromName: nameOf(p.from), to: p.to, toName: nameOf(p.to) }),
      short: e => `${dmy(e.date)} ${e.fromName} → ${e.toName}, ${fmt(e.amount)}`,
      check: (near, p, amount, known) => xferCheck(near, p, amount, known, d => dmy(M.kyivDate(d))),
      is: (r, p, amount) => pay(r, p.from, [4], amount) && pay(r, p.to, [3], amount),
      verify: (rec, p, f, amount) => [!pay(rec, p.from, [4], amount) && `з рахунку «${nameOf(p.from)}»`, !pay(rec, p.to, [3], amount) && `на рахунок «${nameOf(p.to)}»`].filter(Boolean),
    };
    const REC = {
      one: 'запис', what: n => (n === 1 ? 'запис' : `записи: ${n}`), how: 'так само витрату вносить ваш реєстр погоджень (надходження — тим самим запитом з operation 1)', doing: 'створюю запис',
      dupText: 'на цьому рахунку ще немає запису з цією сумою за ±3 дні (стільки, скільки таких операцій у виписці)', title: 'Записи з виписки', ls: 'cfl_rec_journal', btn: 'rcreate', file: 'кешфлоу_записи_журнал',
      form: recordForm, acc: p => p.acc, action: p => `створення запису з виписки (${SRC[p.src]})${risky(p) ? ' — зарплатна стаття' : ''}`,
      risky: p => risky(p),
      note: (k, v, f) => (k === 'invoice_id' ? nameOf(+v) : k === 'operation' ? (v === '1' ? 'надходження' : 'витрата') : k === 'pnl_operation_id' ? artLabel(`${f.pnl_category_id}/${v}`)
        : k === 'marketer_id' ? mkName(v) : k === 'currency_id' ? (S.ccy || {})[v] || '' : ''),
      line: (p, f) => `${dmy(dayOfCrm(f.date) || p.date)}: «${nameOf(p.acc)}» ${SRC[p.src]} ${fmt(Number(f.amount))} — ${artLabel(`${f.pnl_category_id}/${f.pnl_operation_id}`)}${f.marketer_id ? `, маркетолог ${mkName(f.marketer_id)}` : ''}, ${projName(f.project_id)}`,
      entry: (p, f) => ({ account: p.acc, accountName: nameOf(p.acc), operation: Number(f.operation), article: `${f.pnl_category_id}/${f.pnl_operation_id}`,
        articleName: artLabel(`${f.pnl_category_id}/${f.pnl_operation_id}`), ...(f.marketer_id ? { marketer: Number(f.marketer_id), marketerName: mkName(f.marketer_id) } : {}),
        bank: `${p.row.cpty || ''} · ${p.row.purpose || ''}` }),
      short: e => `${dmy(e.date)} «${e.accountName}» ${fmt(e.amount)}`,
      check: (near, p, amount) => {
        const have = near.filter(r => pay(r, p.acc, p.op === 2 ? [2, 4, 6] : [1, 3, 5], amount));
        return have.length >= p.peers ? { result: 'вже є', id: have[0].id, note: `на рахунку вже є ${have.length} запис(и) з цією сумою за ±3 дні (ID ${have.map(r => r.id).join(', ')}), а у виписці таких операцій ${p.peers} — не створено` } : null;
      },
      is: (r, p, amount) => pay(r, p.acc, [p.op], amount),
      verify: (rec, p, f, amount) => {
        const x = pays(rec, p.acc, [p.op], amount)[0];
        if (!x) return [`рахунок «${nameOf(p.acc)}», тип чи сума`];
        const bad = Number(x.pnl_category_id) === Number(f.pnl_category_id) && Number(x.pnl_operation_id) === Number(f.pnl_operation_id) ? [] : [`стаття ${x.pnl_category_id}/${x.pnl_operation_id}`];
        // маркетолог — у marketer_balance_history запису (як його читає реєстр); якщо CRM цього поля не віддав, не перевіряється
        if (f.marketer_id && rec && 'marketer_balance_history' in rec) {
          const mb = rec.marketer_balance_history && rec.marketer_balance_history.marketer_balance;
          if (!mb || Number(mb.user_id) !== Number(f.marketer_id)) bad.push(mb ? `маркетолог ${mkName(mb.user_id)}` : 'маркетолога не збережено');
        }
        return bad;
      },
    };
    // підсумок для вікна підтвердження: скільки й на яку суму — окремо витрати, надходження, перекази й кожна валюта
    function createTotals(reqs) {
      const KIND_UA = { 1: 'надходження', 2: 'витрати', 3: 'перекази' }, m = new Map();
      for (const { f } of reqs) {
        const code = (S.ccy || {})[f.currency_id] || '', k = `${f.operation}|${code}`, v = m.get(k) || { op: f.operation, code, n: 0, sum: 0 };
        v.n++; v.sum = r2(v.sum + Number(f.amount));
        m.set(k, v);
      }
      return [...m.values()].map(v => `${KIND_UA[v.op] || 'записи'} — ${v.n} на ${fmt(v.sum)}${v.code === 'UAH' ? ' грн' : v.code ? ' ' + v.code : ''}`).join('; ');
    }
    /* Підсумок щойно зробленого — там, де людина натискала (над списками розділу «Внести в CRM»), а не лише в повідомленнях угорі
       вкладки; лишається до наступної звірки (S.done.gen — номер звірки, після якої його показано). */
    function doneHtml() {
      const d = S.done;
      if (!d || d.gen !== S.gen) return '';
      return `<div class="${d.cls}" data-b="done" style="margin:0 0 10px"><b>Щойно:</b> ${esc(d.text)}${d.bad.length ? `<ul style="margin:6px 0 0;padding-left:18px">${d.bad.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>`;
    }
    async function createMany(list, K) {
      if (!opts.applyAllowed || !list.length || S.busy) return;
      const reqs = list.map(p => ({ p, f: K.form(p) })), f0 = reqs[0].f, n = reqs.length, draft = dOn(); // режим — на весь пакет
      const ann = (k, v) => (k === 'project_id' || k === 'location_id' ? projName(v) : K.note(k, v, f0));
      // ризиковані записи (зарплатна стаття): CRM не дасть їх ні змінити, ні видалити — окреме попередження й перелік
      const risk = K.risky ? reqs.filter(({ p }) => K.risky(p)) : [];
      const riskHtml = risk.length ? `<div class="err" style="margin:10px 0"><b>Зарплатна стаття — ${risk.length} ${plural(risk.length, 'запис', 'записи', 'записів')}.</b> CRM не дає змінювати й видаляти записи із зарплатною статтею («Операції по зарплаті не доступні для редагування»): якщо в сумі, даті, статті, рахунку чи коментарі помилка, виправить її лише адміністратор CRM. Перевірте ще раз:<ul style="margin:6px 0 0">${risk.map(({ p, f }) => `<li>${esc(K.line(p, f))} — «${esc(f.comment)}»</li>`).join('')}</ul></div>` : '';
      // спершу — що саме створюється, словами: підсумок і весь перелік (до 15 рядків одразу, решта — «Ще N»); поля запиту — згорнуто (16.11.2026)
      const li = ({ p, f }) => `<li>${esc(K.line(p, f))}${f.comment ? ` <span class="muted">— «${esc(f.comment)}»</span>` : ''}</li>`;
      const html = `<h3>Створити ${K.what(n)} ${draft ? 'у чернетках CRM' : 'у CRM'}</h3>${draft ? '<div class="info" style="margin:10px 0">Режим чернеток: записи створюються в «Чернетках» кешфлоу. У кешфлоу й залишки рахунків вони потраплять, коли їх проведе бухгалтер.</div>' : ''}${draft ? '' : riskHtml}
<p><b>Разом:</b> ${esc(createTotals(reqs))}</p>
<ul style="margin:6px 0 10px;padding-left:18px">${reqs.slice(0, 15).map(li).join('')}</ul>
${n > 15 ? `<details><summary>Ще ${n - 15}</summary><ul style="margin:6px 0 10px;padding-left:18px">${reqs.slice(15).map(li).join('')}</ul></details>` : ''}
<details><summary>Технічно: запит до CRM</summary><p>Буде відправлено ${n === 1 ? 'запит' : `${n} ${plural(n, 'запит', 'запити', 'запитів')} (по одному на ${K.one})`} <code>POST /api/${draft ? CFD.PATH : 'invoice-payment'}</code> — ${draft ? 'ті самі поля, що й у звичайного запису' : K.how}. ${n === 1 ? 'Запит' : 'Перший'}:</p>
<table class="kv">${Object.entries(f0).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}${ann(k, v) ? ` — ${esc(ann(k, v))}` : ''}</td></tr>`).join('')}</table></details>
<p>Перед кожним запитом лінтер перевіряє, чи ${K.dupText}, а після — що створений запис збігається. Журнал збережеться файлом. ${draft ? 'Чернетку можна змінити чи видалити в CRM: «CashFlow» → «Чернетки».' : 'Записів лінтер не видаляє: скасувати створене можна лише вручну в CRM.'}</p>`;
      if (!await opts.dialog(html, risk.length && !draft ? `Так, створити${n > 1 ? ` ${n}` : ''} (зарплатних: ${risk.length})` : n === 1 ? 'Так, створити' : `Так, створити ${n}`, true)) return;
      busy(true); // одразу: поки читаються чернетки, друге натискання не має запустити другий пакет
      if (draft) { // чернетки мають читатися: без цього дублі не перевірити — нічого не створюємо
        try { await DR.list(); } catch (e) { busy(false); note(`Не вдалося прочитати чернетки CRM (${e.message}) — нічого не створено. Якщо у вашої ролі немає доступу до чернеток, вимкніть «у чернетки» в шапці панелі.`, 'err'); return; }
      }
      if (opts.setBusy) opts.setBusy(true);
      const known = new Set([...S.items.values()].flatMap(v => v.map(x => x.id)));
      const journal = [];
      // журнал — у браузері після кожного запису, а не після всього пакета: закрита чи перезавантажена вкладка не губить, що вже створено (07.11.2026)
      const base = LS.get(K.ls, []), persist = () => LS.set(K.ls, base.concat(journal).slice(-500));
      let noRights = false;
      // хід — і на самій кнопці, яку натиснули (рядок стану — угорі вкладки, його звідси не видно)
      const btnEl = K.btn ? $('out').querySelector(`[data-b="${K.btn}"]`) : null;
      try {
        for (const [i, { p, f }] of reqs.entries()) {
          persist();
          st(`${K.doing} ${i + 1} з ${n}…`);
          if (btnEl) btnEl.textContent = `Створюю ${i + 1} з ${n}…`;
          // дата, яку надсилаємо (покупка карткою — дата покупки), і день банку: дублі шукаються за ±3 дні від обох
          const amount = Number(f.amount), acc = K.acc(p), day = dayOfCrm(f.date) || p.date, lo = day < p.date ? day : p.date, hi = day > p.date ? day : p.date;
          const e = { at: new Date().toISOString(), action: K.action(p), id: null, ...K.entry(p, f), amount, date: day, ...(day !== p.date ? { bankDate: p.date } : {}), project: Number(f.project_id), comment: f.comment, result: '', note: '' };
          journal.push(e);
          if (noRights) { e.result = 'пропущено'; e.note = NOT_SENT; continue; }
          const nearQ = `invoice-payment?date_from=${dash(addDays(lo, -3))}&date_to=${dash(addDays(hi, 3))}&amount_from=${amount}&amount_to=${amount}&invoice_ids[]=${acc}&per_page=100`;
          // у режимі чернеток дублі шукаються і серед чернеток (список чернеток CRM не фільтрує — фільтр той самий, у core/drafts.js)
          // спершу чернетки, потім записи: чернетку, яку провели між двома запитами, буде видно хоч в одному зі списків
          const around = async () => { const dn = draft ? await DR.near(nearQ) : [], live = listOf(await api.get(nearQ)).filter(r => !r.deleted_at), have = new Set(live.map(r => r.id)); return live.concat(dn.filter(r => !have.has(r.id))); };
          let wrote = false;
          try {
            const stop = K.check(await around(), p, amount, known);
            if (stop) { Object.assign(e, stop); continue; }
            // у журнал браузера — ще до запиту: вкладку закрили, поки CRM відповідав, — слід про можливо створений запис лишається
            Object.assign(e, { result: 'перевірте', note: 'запит надіслано, відповіді ще немає — перевірте в кешфлоу перед повтором' });
            persist();
            const res = draft ? await DR.post(formData(f)) : await api.post('invoice-payment', formData(f));
            if (res.status < 200 || res.status >= 300) throw M.crmError(res, 'post');
            // CRM прийняв: далі запис уже є, навіть якщо перевірка не вдасться
            wrote = true;
            Object.assign(e, { result: 'перевірте', note: 'створено, перевіряю…' });
            persist();
            let id = idOf(res);
            if (!id) { const again = (await around()).filter(r => !known.has(r.id) && K.is(r, p, amount)); if (again.length === 1) id = again[0].id; }
            if (!id) { e.result = 'перевірте'; e.note = 'CRM прийняв запит, але не повернув ID, і новий запис не знайдено — перевірте в кешфлоу перед повтором'; continue; }
            e.id = id;
            known.add(id);
            const g = draft ? await DR.get(id) : await api.get('invoice-payment/' + id), rec = g && g.data && g.data.payments ? g.data : g;
            if (draft) e.draft = true;
            const bad = K.verify(rec, p, f, amount);
            if (rec && rec.date && M.kyivDate(rec.date) !== day) bad.push(`дата ${dmy(M.kyivDate(rec.date))}`);
            e.result = bad.length ? 'перевірте' : 'ok';
            e.note = bad.length ? `${draft ? 'чернетку створено' : 'створено'}, але не збігається: ${bad.join(', ')}` : draft ? 'чернетку створено й перевірено' : 'створено й перевірено';
          } catch (err) {
            // запит прийнято, не вдалось лише перечитати запис — це не «помилка»: запис є, вносити вдруге не треба
            if (wrote) { e.result = 'перевірте'; e.note = `створено, але не вдалося перевірити: ${err.message}`; continue; }
            noRights = failed(e, err) === 'rights';
            if (err.kind === 'closed' && CL) CL.learn(f.period); // період нового запису ('01-ММ-РРРР') — закритий місяць
          }
        }
      } finally {
        busy(false);
        if (opts.setBusy) opts.setBusy(false);
      }
      persist();
      // журнал — у папку Помічника без вікна «Зберегти як» (storage.keepFile); без Помічника — завантаженням
      const jname = `${K.file}_${stamp()}.json`, jdata = JSON.stringify(journal, null, 1);
      let saved = { where: 'download' };
      try { if (storage.keepFile) saved = await storage.keepFile(jname, 'application/json', jdata, 'journals'); else await storage.saveFile(jname, 'application/json', jdata); } catch (e) {}
      const cnt = {};
      journal.forEach(e => { cnt[e.result] = (cnt[e.result] || 0) + 1; });
      await calc(); // перечитати CRM: створене зникне зі списку, рахунки перерахуються
      const total = `${K.title}: ${Object.entries(cnt).map(([k, v]) => `${k === 'ok' ? 'зроблено й перевірено' : k} — ${v}`).join(', ')}.`;
      note(`${total} Журнал — ${saved.where === 'helper' ? `у папці Помічника: ${saved.path}` : `файл «${K.file}_….json» у «Завантаженнях»`}.`, journal.every(e => e.result === 'ok') ? 'info' : 'warn');
      journal.filter(e => e.result !== 'ok').forEach(e => note(`${K.short(e)}: ${e.note}`, BAD.includes(e.result) ? 'err' : 'warn'));
      refusalNote(journal, 'post');
      // те саме — над списками розділу, де натискали кнопку (і кнопка — знову з лічильником)
      S.done = { gen: S.gen, text: total, cls: journal.some(e => BAD.includes(e.result)) ? 'err' : journal.every(e => e.result === 'ok') ? 'info' : 'warn', bad: journal.filter(e => e.result !== 'ok').map(e => `${K.short(e)}: ${e.note}`) };
      render();
      const db = $('out').querySelector('[data-b="done"]');
      if (db && db.scrollIntoView) db.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    // ---------- залишок CRM проти суми записів ----------
    async function offsets() {
      if (S.busy || !S.accs) return;
      busy(true);
      try {
        const recs = await pages(`invoice-payment?date_from=01-01-2015&date_to=${dash(addDays(today(), 730))}`, (p, n) => st(`усі записи CRM: сторінка ${p}/${n || '?'}`));
        const m = Rc.cashflowByAccount(recs);
        // залишок CRM — без чернеток (balanceLive): тут він порівнюється з сумою всіх проведених записів
      S.offsets = new Map(S.accs.map(a => [a.id, r2(Number(a.balanceLive !== undefined ? a.balanceLive : a.balance) - (m.get(a.id) || []).reduce((s, x) => s + x.amount, 0))]));
        render();
        st(`порівняно: ${recs.length} записів (якщо щойно вносили записи — спершу «Звірити»)`);
      } catch (e) { note(e.message, 'err'); st('помилка'); }
      finally { busy(false); }
    }

    // ---------- звіт ----------
    $('xlsx').onclick = () => {
      if (!S.accs || !S.items) return;
      const all = rows().sort((x, y2) => GROUPS.indexOf(x.g) - GROUPS.indexOf(y2.g) || x.a.name.localeCompare(y2.a.name, 'uk'));
      const B = r => r.R.bank || {}, D = r => r.R.diff || {};
      const sum = [['Група', 'Рахунок CRM', 'ID', 'Валюта', 'Статус', `Залишок на початок ${dmy(S.from)}: CRM`, 'банк', 'різниця', 'Надходження: CRM', 'банк', 'різниця', 'Списання: CRM', 'банк', 'різниця',
        `Залишок на кінець ${dmy(S.to)}: CRM`, 'банк', 'різниця', 'Операцій CRM', 'Операцій банк', 'Сум не сходиться', 'Немає в CRM', 'Немає в банку (лише в CRM)', 'Джерело банку', 'Примітки', 'Залишок CRM − сума записів', 'Що звіряли']];
      const amt = [['Рахунок CRM', 'Сума', 'Банк, шт', 'CRM, шт', 'Різниця', 'Операції банку', 'Записи CRM', 'Записи CRM з іншою датою']];
      const bo = [['Рахунок CRM', 'Дата', 'Час', 'Сума', 'Контрагент', 'Призначення', 'Референс']];
      const co = [['Рахунок CRM', 'Дата', 'ID запису', 'Тип', 'Сума', 'Коментар']];
      for (const r of all) {
        const R = r.R;
        sum.push([r.g[1], r.a.name, r.a.id, r.ccy, ST[r.status][1], R.crm.open, B(r).open, D(r).open, R.crm.cred, B(r).cred, D(r).cred, R.crm.deb, B(r).deb, D(r).deb,
          R.crm.close, B(r).close, D(r).close, R.crm.n, B(r).n, R.covered ? R.amounts.length : '', R.covered ? lacks(R).miss : '', R.covered ? lacks(R).extra : '', r.b ? srcOf(r.b) : r.manual !== undefined ? 'вручну' : '', r.warn.join('; '), r.offset === undefined ? '' : r.offset, KIND[S.kind]]);
        for (const x of R.amounts) amt.push([r.a.name, x.amount, x.nB, x.nC, x.d, x.bank.map(opB).join('\n'), x.crm.map(opC).join('\n'), x.near.map(o => `${dmy(o.date)} (ID ${o.id})`).join(', ')]);
        if (r.b) r.b.rows.filter(x => x.date >= S.from && x.date <= S.to).forEach(x => bo.push([r.a.name, x.date, x.time, x.amount, x.cpty, x.purpose, x.ref]));
        if (R.bank) (S.items.get(r.a.id) || []).filter(x => x.date >= S.from && x.date <= S.to).forEach(x => co.push([r.a.name, x.date, x.id, x.op, x.amount, x.comment]));
      }
      // перекази між своїми: чого немає в CRM, що записано не переказом, що невідомо куди
      // пояснені різниці: суми не 1:1 і покупки карткою з іншою датою проведення
      const ex = [['Рахунок CRM', 'Що', 'Операції банку', 'Записи CRM', 'Сума']];
      const TK = { later: 'банк провів пізніше (покупка карткою)', after: 'у CRM у періоді, банк провів після нього', pending: 'ще не проведено банком (покупка карткою)' };
      for (const r of all) {
        for (const g of r.R.multi || []) ex.push([r.a.name, GW_SHORT[g.why || ''], g.bank.map(opB).join('\n'), g.crm.map(opC).join('\n'), Math.abs(g.why === 'refund' ? g.bank[0].amount : r2(g.bank.reduce((s, x) => s + x.amount, 0)))]);
        for (const o of r.R.calc || []) ex.push([r.a.name, o.why, '', opC(o.crm), Math.abs(o.crm.amount)]);
        for (const t of r.R.timing || []) ex.push([r.a.name, TK[t.kind] + (t.buy ? `, покупка ${dmy(t.buy)}` : ''), t.bank ? opB(t.bank) : '', opC(t.crm), Math.abs(t.crm.amount)]);
        // ЗП через транзитний рахунок — поштучно не звіряється
        for (const x of r.R.pay ? r.R.pay.bank : []) ex.push([r.a.name, 'ЗП через транзитний рахунок — поштучно не звіряється', opB(x), '', Math.abs(x.amount)]);
        for (const c of r.R.pay ? r.R.pay.crm : []) ex.push([r.a.name, 'запис ЗП — поштучно не звіряється (ЗП через транзитний рахунок)', '', opC(c), Math.abs(c.amount)]);
      }
      const xf = [['Дата', 'З рахунку', 'На рахунок', 'Сума', 'Стан', 'ID у CRM', 'Операція банку / підстава']];
      const XS = { missing: 'немає в CRM', type: 'у CRM записано не переказом', peer: 'у CRM переказ з іншим рахунком' };
      for (const r of all) {
        if (r.R.own) {
          for (const x of r.R.own.xfers) if (x.state !== 'ok') xf.push([x.row.date, x.row.amount < 0 ? r.a.name : nameOf(x.peer), x.row.amount < 0 ? nameOf(x.peer) : r.a.name, Math.abs(x.row.amount), XS[x.state], x.item ? x.item.id : '', `${x.row.cpty || ''} · ${x.row.purpose || ''}`]);
          for (const m of r.R.own.maybe) xf.push([m.row.date, m.row.amount < 0 ? r.a.name : '?', m.row.amount < 0 ? '?' : r.a.name, Math.abs(m.row.amount), 'схоже на переказ — рахунок «куди» невідомий', '', `${m.row.cpty || ''} · ${m.row.purpose || ''}`]);
        }
        (r.topups || []).forEach(x => xf.push([x.date, r.a.name, 'corpCard', Math.abs(x.amount), 'поповнення корп. картки записано витратою', x.id, x.comment]));
        if (r.status === 'merged' && Number(r.a.balance) < -0.005) xf.push([today(), nameOf(r.into), r.a.name, r2(-Number(r.a.balance)), 'корп. картка в CRM у мінусі — бракує поповнення', '', '']);
      }
      // операції банку, яких немає в CRM: що лінтер пропонує створити і чому решту — ні
      const rc = [['Дата', 'Рахунок CRM', 'Сума', 'Тип', 'Стаття', 'Маркетолог', 'Проєкт', 'Коментар у CRM', 'Операція банку', 'Не створюється, бо']];
      for (const p of recProposals(all)) {
        const s = S.rp.get(p.key), iss = artIssue(s.art);
        rc.push([p.buy || p.date, nameOf(p.acc), p.op === 1 ? p.amount : -p.amount, SRC[p.src], s.art ? artLabel(s.art) : '', iss === 'marketer' && s.mk ? mkName(s.mk) : '', projName(s.proj), s.comment,
          `${p.row.cpty || ''} · ${p.row.purpose || ''}`, p.block || (iss === 'salary' ? ISSUE.salary : iss === 'marketer' && !s.mk ? 'потрібен маркетолог' : !s.art ? 'потрібна стаття' : '')]);
      }
      // виводи з балансу ↔ погодження «% менеджера / м-рів / тімліда» — якщо погодження з реєстру прочитано
      const wdX = wdCalc(), wv = [['Дата оплати', 'Отримувач', 'Зміст погодження', 'Погоджено', 'Виведено', 'Стан', 'Виводи з балансу (записи CRM)']];
      if (wdX) {
        for (const r of wdX.res.rows.filter(x => x.a.report !== false)) wv.push([r.a.date, r.a.recipient, r.a.content, r.a.amount, (r.status === 'ok' && r.how !== 'registry') || r.cands.length ? r.sum : '',
          wdText(r, today()).text + (wdX.sum.double.includes(r) ? ' · реєстр уніс на всю суму, і є вивід — витрата двічі?' : ''), (r.status === 'ok' ? r.items : r.cands).map(w => `${wdWho(w)} · ${fmt(w.amount)} · ${dmy(w.date)} · ID ${w.id}`).join('\n')]);
        for (const { w, near } of wdX.sum.extraList) wv.push([w.date, wdWho(w), 'вивід без погодження', '', w.amount, wdNear(near) || 'без погодження', `ID ${w.id}${w.acc != null ? ' · ' + nameOf(w.acc) : ''}`]);
      }
      // операції з виписок поза звіркою (службові й незіставлені рахунки, не проведені банком) — лише довідка
      const oz = [['Рахунок банку', 'Власник рахунку', 'Дата', 'Сума', 'Контрагент · призначення', 'Чому поза звіркою']];
      for (const g of outsideList()) for (const o of g.list) oz.push([`${g.b.bank === 'mono' ? 'Моно' : 'Приват'} ${tail(g.b.iban)}`, g.b.owner || g.b.client || '', o.x.date, o.x.amount, `${o.x.cpty || ''} · ${o.x.purpose || ''}`, o.why]);
      storage.saveFile(`Звірка_з_банком_${S.from}_${S.to}${S.kind !== 'all' ? '_' + KIND[S.kind].replace(/\s+/g, '_') : ''}.xlsx`, XLSX_MIME, X.buildXlsx([
        { name: 'Підсумок', rows: sum, widths: [20, 40, 6, 7, 16, 15, 15, 12, 15, 15, 12, 15, 15, 12, 15, 15, 12, 9, 9, 9, 40, 40, 34, 50, 16, 16], money: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 24] },
        { name: 'Немає в CRM — створити', rows: rc, widths: [11, 40, 13, 14, 44, 24, 14, 60, 80, 50], money: [2] },
        { name: 'Суми, що не сходяться', rows: amt, widths: [40, 13, 9, 9, 9, 70, 70, 30], money: [1] },
        { name: 'Пояснені різниці', rows: ex, widths: [40, 44, 70, 70, 13], money: [4] },
        { name: 'Операції банку', rows: bo, widths: [40, 11, 7, 13, 34, 70, 18], money: [3] },
        { name: 'Записи CRM', rows: co, widths: [40, 11, 9, 14, 13, 70], money: [4] },
        { name: 'Перекази між своїми', rows: xf, widths: [11, 40, 40, 13, 36, 9, 80], money: [3] },
        ...(wdX ? [{ name: 'Виводи з балансу', rows: wv, widths: [11, 30, 60, 13, 13, 60, 70], money: [3, 4] }] : []),
        ...(oz.length > 1 ? [{ name: 'Поза звіркою', rows: oz, widths: [18, 40, 11, 13, 80, 60], money: [3] }] : []),
      ]));
    };

    // syncPeriod — панель кличе, коли вкладку показано знову; act — дії рядків і фільтра (ті самі функції, що в обробниках; для перевірок без сторінки)
    return { element: el, get state() { return S; }, syncPeriod, act: { stToggle, recPickArt, recSpreadArt } };
  }

  return { mount, GROUPS, lacks, classify, recComment, histArt, histMk, histRef, mkInComment, cardComment, refParts, ruleHints, holderOf, mkByName, clampToOpen, monthBounds, defaultMonth, closeReport, bankSummary, mergeLocalCards, merchantOf, findNewCards, hiddenAccs, OFF_ACC, wrongTopups,
    laterBank, notFetched, partialFetchText, xferOtherType, xferCheck, crmDate, dayOfCrm, cardTime, recWhen, FILE_SHOW };
}));

/* ---- ui/approvals-tab.js ---- */
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

/* ---- ui/linter-panel.js ---- */
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

var CF_RULES = {"version":"1.2.21 (19.11.2026, «1.5% від бронювання» — на рахунку 4431)","description":"Єдиний файл правил кешфлоу crm.example.com: статті, проєкти (країни), виключення з P&L. Формат — ТЗ, розділ 4; інструкція — rules/ФОРМАТ_ПРАВИЛ.md.","updated":"2026-11-19","fix_from":"2026-09-01","fix_from_note":"Межа роботи лінтера (уточнення 24.10.2026): записи з датою раніше цієї лінтер показує лише для довідки (статус locked-date) і ніколи не пропонує змінити.","reference":{"_note":"Довідник статей і проєктів (id з CRM, перевірено GET 24.10.2026). Лінтер перед роботою звіряє назви з CRM і зупиняється, якщо щось змінилось. cards — корп. картки, яких не видно з назви рахунку corpCard (номер, рахунок CRM, з якого рахунку списує, хто тримає). card_topup — на яку картку можна поповнювати (лише картку власника рахунку). counterparty_marketers — маркетолог за контрагентом (ФОП Власич → Сливко). bronik_accounts — рахунок броніків: їхній рух у CRM не вноситься, дохід — «1.5% від бронювання».","articles":[{"group":"Дохід","category":"Маркетплейс","category_id":45,"name":"Послуги клієнтам (B2C)","operation_id":21,"type":1},{"group":"Дохід","category":"Маркетплейс","category_id":45,"name":"Корпоративні клієнти (B2B)","operation_id":63,"type":1},{"group":"Дохід","category":"Підписки","category_id":44,"name":"Підписки юристів","operation_id":20,"type":1},{"group":"Дохід","category":"Підписки","category_id":44,"name":"Підписки клієнтів","operation_id":19,"type":1},{"group":"Дохід","category":"Підписки","category_id":44,"name":"Корпоративні підписки","operation_id":71,"type":1},{"group":"Дохід","category":"Оплата сервісів","category_id":67,"name":"Лід-маркетплейс","operation_id":72,"type":1},{"group":"Дохід","category":"Інші доходи","category_id":46,"name":"Інші доходи","operation_id":23,"type":1},{"group":"Дохід","category":"ПДВ","category_id":18,"name":"ПДВ","operation_id":25,"type":2},{"group":"Собівартість","category":"Виплати фахівцям","category_id":19,"name":"Виплати фахівцям","operation_id":29,"type":2},{"group":"Собівартість","category":"Прямі підрядники","category_id":52,"name":"Прямі підрядники","operation_id":39,"type":2},{"group":"Собівартість","category":"Інші витрати","category_id":62,"name":"Інші витрати","operation_id":66,"type":2},{"group":"Продажі та маркетинг","category":"Реклама","category_id":20,"name":"Реінвест","operation_id":30,"type":2},{"group":"Продажі та маркетинг","category":"Реклама","category_id":20,"name":"Дотування","operation_id":40,"type":2},{"group":"Продажі та маркетинг","category":"Реклама","category_id":20,"name":"Тестування","operation_id":41,"type":2},{"group":"Продажі та маркетинг","category":"Комісії відділу продажів","category_id":47,"name":"Комісії відділу продажів","operation_id":31,"type":2},{"group":"Продажі та маркетинг","category":"ЗП відділу продажів","category_id":55,"name":"ЗП відділу продажів","operation_id":47,"type":2},{"group":"Продажі та маркетинг","category":"Комісії відділу маркетингу","category_id":49,"name":"Комісії відділу маркетингу","operation_id":33,"type":2},{"group":"Продажі та маркетинг","category":"ЗП відділу маркетингу","category_id":69,"name":"ЗП відділу маркетингу","operation_id":75,"type":2},{"group":"Продажі та маркетинг","category":"SEO та контент","category_id":70,"name":"SEO та контент","operation_id":76,"type":2},{"group":"Продажі та маркетинг","category":"Інструменти","category_id":23,"name":"Інструменти","operation_id":42,"type":2},{"group":"Продажі та маркетинг","category":"Інші витрати","category_id":48,"name":"Інші витрати","operation_id":32,"type":2},{"group":"Продукт і розробка","category":"Дослідження","category_id":53,"name":"Дослідження","operation_id":45,"type":2},{"group":"Продукт і розробка","category":"Розробка","category_id":50,"name":"Розробка","operation_id":37,"type":2},{"group":"Продукт і розробка","category":"Інфраструктура","category_id":71,"name":"Інфраструктура","operation_id":77,"type":2},{"group":"Продукт і розробка","category":"AI / API / Продуктовий софт","category_id":58,"name":"AI / API / Продуктовий софт","operation_id":53,"type":2},{"group":"Продукт і розробка","category":"Підрядники","category_id":72,"name":"Підрядники","operation_id":78,"type":2},{"group":"Продукт і розробка","category":"Інші витрати","category_id":65,"name":"Інші витрати","operation_id":69,"type":2},{"group":"Адміністративні витрати","category":"Менеджмент ( заробітна плата )","category_id":51,"name":"Менеджмент ( заробітна плата )","operation_id":38,"type":2},{"group":"Адміністративні витрати","category":"Фінанси та бухгалтерія","category_id":56,"name":"Фінанси та бухгалтерія","operation_id":48,"type":2},{"group":"Адміністративні витрати","category":"Юридичні та комплаєнс","category_id":73,"name":"Юридичні та комплаєнс","operation_id":79,"type":2},{"group":"Адміністративні витрати","category":"Офіс","category_id":57,"name":"Офіс","operation_id":52,"type":2},{"group":"Адміністративні витрати","category":"HR та рекрутинг","category_id":54,"name":"HR та рекрутинг","operation_id":46,"type":2},{"group":"Адміністративні витрати","category":"Відрядження","category_id":74,"name":"Відрядження","operation_id":80,"type":2},{"group":"Адміністративні витрати","category":"Страхування","category_id":75,"name":"Страхування","operation_id":81,"type":2},{"group":"Адміністративні витрати","category":"Комісії платіжних систем","category_id":76,"name":"Комісії платіжних систем","operation_id":82,"type":2},{"group":"Адміністративні витрати","category":"Інші витрати","category_id":59,"name":"Інші витрати","operation_id":55,"type":2},{"group":"Амортизація","category":"Амортизація","category_id":77,"name":"Амортизація","operation_id":83,"type":2},{"group":"Фінансові витрати (нетто)","category":"Фінансові витрати (нетто)","category_id":78,"name":"Фінансові витрати (нетто)","operation_id":84,"type":2},{"group":"Податок на прибуток","category":"Податок на прибуток","category_id":26,"name":"Податок на прибуток","operation_id":56,"type":2}],"projects":{"Україна":1,"Польща":2,"Велика Британія":3,"США":4,"ОАЕ":5},"cards":[{"last4":"7365","account_id":90,"account":"корп. картка 7365 ФОП Мазовецька Корнелія Олександрівна","debit_account_id":83,"debit_account":"ФОП Мазовецька Корнелія Олександрівна Приват (…551235)","holders":[{"name":"Татоян Артем"},{"from":"2026-10-23","name":"Сидоричев Андрій"},{"from":"2026-10-28","name":"Симонович Сергій"}],"note":"Картка ФОП Мазовецька: списує з її рахунку в Привату. Рахунок картки — ID 90 (до 30.10.2026 «corpCard №5 …_UAH_2044», уточнення 29.10.2026; з 30.10.2026 у назві 7365). ID 94 — друга картка Мазовецької: з 02.11.2026 «корп. картка 4270 ФОП Мазовецька Корнелія Олександрівна» (раніше «майбутня корп карта …»). ID 103 — третя картка Мазовецької: з 04.11.2026 «корп. картка 0274 ФОП Мазовецька Корнелія Олександрівна» (у реєстрі погоджень — чип «Corp Card ...0421»). Номери карток 94 і 103 лінтер бере з назв. Хто тримає картку — маркетолог її покупок."},{"last4":"4546","account_id":104,"account":"корп. картка 4546 ФОП Мартиненко Святослав Олександрович","debit_account_id":70,"debit_account":"ФОП Мартиненко Святослав Олександрович Приват (…8366)","holders":[{"from":"2026-11-04","name":"Сидоричев Андрій"}],"note":"Друга картка ФОП Мартиненко (перша — 7850, ID 91; рахунок ID 104 заведено 04.11.2026): списує з його рахунку в Привату, як і 7850. Тримач з 04.11.2026 — Сидоричев Андрій (уточнено 04.11.2026): він — маркетолог покупок цією карткою, а погодження «поповнення корп картки» від нього з рахунку Мартиненка йдуть на цю картку."},{"last4":"7850","account_id":91,"account":"корп. картка 7850 ФОП Мартиненко Святослав Олександрович","debit_account_id":70,"debit_account":"ФОП Мартиненко Святослав Олександрович Приват (…8366)","holders":[{"from":"2026-10-30","name":"Симонович Сергій"}],"note":"Картку 7850 тримає в основному Симонович Сергій (уточнено 17.11.2026; з 30.10.2026 — дата його першої покупки цією карткою в CRM): він — маркетолог покупок цією карткою, якщо в коментарі чи погодженні не вказано іншого."},{"last4":"3462","account_id":89,"account":"корп. картка 3462 ФОП Хоменко Всеволод Сергійович","debit_account_id":68,"debit_account":"ФОП Хоменко Всеволод Сергійович Приват","holders":[{"name":"Миколаївський Дмитро"}],"note":"Картку 3462 тримає Миколаївський Дмитро (уточнено 19.11.2026)."},{"last4":"4323","account_id":102,"account":"корп. картка 4323 ФОП Хоменко Всеволод Сергійович","debit_account_id":68,"debit_account":"ФОП Хоменко Всеволод Сергійович Приват","holders":[{"name":"Буца Марія"}],"note":"Картку 4323 тримає Буца Марія (уточнено 19.11.2026)."},{"last4":"2804","account_id":92,"account":"корп. картка 2804 ФОП Житинська Емілія Юріївна","debit_account_id":44,"debit_account":"ФОП Житинська Емілія Юріївна Приват","holders":[{"from":"2026-11-18","name":"Шелега Ігор","also":["Ларіоненко Тимур"]}],"note":"З 18.11.2026 картку 2804 тримають двоє: Шелега Ігор і Ларіоненко Тимур (уточнено 19.11.2026). Поповнення від будь-кого з них іде на цю картку; маркетолога покупки лінтер сам не ставить — хто купував, з виписки не видно."},{"last4":"5802","account_id":101,"account":"корп. картка 5802 ТОВ СЕРВІС МАРКЕТ","debit_account_id":97,"debit_account":"Приват ТОВ СЕРВІС МАРКЕТ 1437","holders":[{"name":"Миколаївський Дмитро"}],"note":"Картка ТОВ Маркет (рахунок ID 101 заведено 02.11.2026): покупки — реклама Facebook — списуються з рахунку Маркет у Привату …1437 (у жовтні 8 покупок 15–19.10). Тримач — Миколаївський Дмитро (уточнено 06.11.2026): він — маркетолог покупок цією карткою, а його погодження «поповнення корп картки» з рахунків Маркет ідуть на неї."}],"card_topup":{"same_owner":true,"note":"Корп. картку поповнюють лише з рахунку її власника (уточнення 30.10.2026): з ФОП Хоменко — на картку Хоменка, з ФОП Мазовецька — на картку Мазовецької, з ТОВ — на картку цього ТОВ. Власник — з назви рахунку CRM («ФОП Прізвище …», «ТОВ НАЗВА …»). Картка без номера («майбутня корп карта …»), неактуальна чи «(видалити)» не поповнюється. Діє в «Погодженнях» (рахунок «куди», зокрема замість підказки аркуша «Корпоративні картки» реєстру) і в «Звірці з банком» (поповнення, записане витратою). Якщо діючих карток у власника кілька (з 04.11.2026 — по дві в кожного ФОП), картку визначає номер картки в тексті, тримач (cards[].holders) чи попередні поповнення від того самого отримувача; «з цього рахунку завжди поповнюють одну картку» тоді не діє. «Звірка з банком» показує поповнення, що пішло не на ту картку (за номером чи тримачем у коментарі або за покупками у виписці), і переспрямовує його кнопкою. false — вимкнути."},"counterparty_marketers":[{"counterparty":"Власич Оксана","marketer_id":195,"marketer":"Євген Сливко","note":"ФОП Власич Оксана Володимирівна — підрядник реклами Сливка: маркетолог завжди Сливко (уточнення 03.11.2026). Діє для статей з рекламним бюджетом (CRM вимагає маркетолога): «Звірка з банком» → «Внести в CRM» і «Погодження» (якщо реєстр маркетолога не дав)."},{"counterparty":"Привільна Марія","marketer_id":208,"marketer":"Привільна Марія","note":"ФОП Привільна Марія Андріївна — реінвест: маркетолог — вона сама (16.11.2026; id з CRM 16.11.2026). У виписці — «ПРИВІЛЬНА МАРІЯ АНДРІЇВНА»."},{"counterparty":"ФОП Привільна","marketer_id":208,"marketer":"Привільна Марія","note":"Так її пишуть у погодженнях: «ФОП Привільна — реінвест за …»."},{"counterparty":"Пивоварьов Радислав","marketer_id":136,"marketer":"Пивовар Радислав","note":"ФОП Пивоварьов (у погодженнях — «ФОП Пивоваренко Р.») — реінвест: маркетолог Пивовар Радислав (16.11.2026; id з CRM 16.11.2026)."},{"counterparty":"ФОП Пивоваренко","marketer_id":136,"marketer":"Пивовар Радислав","note":"Так його пишуть у погодженнях: «ФОП Пивоваренко Р.: реінвест за …»."}],"vendor_people":[{"vendor_regex":"heygen","title":"HeyGen","person":"Татоян Артем","project":"США","note":"Покупки HeyGen корп. карткою — Татояна, проєкт США, хоч би хто тримав картку (уточнення 18.11.2026). У коментарі запису — його ім'я."}],"subscriptions":{"_note":"Підписки юристів (доступ до платформи): надходження з сумою тарифу — не оплата замовлення, а запис зі статтею «Підписки юристів» (16.11.2026). prices — ціна в гривнях за 1, 3 і 12 місяців; платник може округлити на гривню вгору (1 699 → 1 700). purpose_regex — слова призначення, з якими лінтер упевнений; лише за сумою — «перевірте».","article":"44/20","purpose_regex":"програмн\\p{L}*\\s+продукт|доступ\\p{L}*\\s+до\\s+(?:платформи|програмн)|онлайн-сервіс|підписк","plans":[{"name":"Start","prices":{"1":449,"3":1347,"12":4849}},{"name":"PRO","prices":{"1":1699,"3":5097,"12":18349}},{"name":"PREMIUM","prices":{"1":4199,"3":12597,"12":45349}}]},"bronik_accounts":{"note":"Кошти броніків (правила обліку, п. 122–P127, P211): на рахунок броніків надходять їхні кошти, з нього — ЗП броніків через транзитний рахунок і податки за них. У CRM це не вноситься: «Звірка з банком» показує такі операції поза звіркою, а не «немає в CRM». Дохід компанії — розрахунковий запис «1.5% від бронювання» на рахунку share_account_id (руху в банку в нього немає): звірка перевіряє, що він є на кожне надходження (share_pct % від суми, ±3 дні). Перекази між своїми рахунками (4431 → 5608) звіряються як завжди. Додано 08.11.2026 (звірка жовтня).","share_regex":"1[.,]5\\s*%\\s*від\\s*бронюван","accounts":[{"account_id":38,"name":"Приват ТОВ ПРИКЛАД СЕРВІС 4431 (колишній «6 UAH B2B ПРИКЛАД Приват ТОВ»)","share_account_id":38,"share_pct":1.5}]}},"people":{"mkt_zp_people":{"note":"ЗП відділу маркетингу (ТЗ §5)","names":["Віденець","Віденця","Віденцю","Зіна Віденець","Турченко Адам","Турченка Адама","Адам Турченко","Шелег*","Шелезі","Сидоричев*"]},"bronik_2026_02":{"note":"Броніки з 02.2026 (ТЗ §5 / правила обліку). Гусак Микита — теж бронік (уточнення 24.10.2026), його ловить окремий вираз у R-NP-BRONIK-01.","names":["Сушенк*","Обруч*","Бендюг*","Бендюзі","Гординя","Гордині О","Гординю"]}},"rules":[{"id":"R-COMM-01","group":"Статті","title":"Банківська комісія → Комісії платіжних систем (лише нові записи)","priority":100,"source":"ТЗ §5 (лише плата банку за обслуговування); уточнення 24.10.2026: старі записи в «Інших витратах» не чіпати — правило лише для записів, внесених з 24.10.2026","effective_from":"2026-10-24","date_field":"created","match":{"type":"expense","comment_regex":"(?i)^\\s*(\\(\\d+/\\d+\\)\\s*)?(банк\\w*\\.?\\s*коміс|коміс|всі\\s+коміс|opłata\\s+za\\s+prowadzenie)"},"unless":[{"comment_regex":"(?i)подат(ок|к)|\\bпдфо\\b|\\bєсв\\b|\\bвз\\b|\\bвв\\b|\\bєп\\b|військов\\w*\\s+зб[іо]р|єдин\\w*\\s+(податок|внесок)"},{"comment_regex":"(?i)поповненн\\w*\\s+карток\\s+для\\s+виплат|зарплатн\\w*\\s+про[еє]кт|\\bзп\\b|зарплат"},{"comment_regex":"(?i)менеджер|тімлід|тимлід|\\bроп\\b|агент|відділ\\w*\\s+продаж|комісійн"}],"set":{"category":"Комісії платіжних систем"},"note":"Комісії в один запис на місяць НЕ об'єднувати; уже об'єднані — не розбивати (лінтер записи не об'єднує і не розбиває)."},{"id":"R-COMM-02","group":"Статті","title":"Комісія за поповнення карток для виплат (ЗП) → стаття відділу (вручну)","priority":100,"source":"ТЗ §5 (виняток: комісія за ЗП відділу → стаття відділу); уточнення 24.10.2026 (питання 9.4): статтю відділу ставлять вручну","effective_from":"2024-01-01","match":{"type":"expense","comment_regex":"(?i)коміс\\w*\\s+за\\s+поповненн\\w*\\s+карток\\s+для\\s+виплат|коміс\\w*.{0,40}зарплатн\\w*\\s+про[еє]кт"},"set":{"review":"комісія за ЗП відділу → стаття того відділу, чию ЗП виплачували; поставте вручну"}},{"id":"R-KPS-NOTAX-01","group":"Статті","title":"Податки й ЗП — не «Комісії платіжних систем»","priority":40,"source":"ТЗ §5 («Комісії платіжних систем» — лише плата банку за обслуговування); ручна звірка 23.10.2026, аркуш «8 КПС»","effective_from":"2024-01-01","match":{"type":"expense","category_in":["Комісії платіжних систем"],"any":[{"comment_regex":"(?i)подат(ок|к)|\\bпдфо\\b|\\bєсв\\b|\\bвз\\b|\\bвв\\b|\\bєп\\b|військов\\w*\\s+зб[іо]р|єдин\\w*\\s+(податок|внесок)"},{"comment_regex":"(?i)\\bзп\\b|зарплат|заробітн\\w*\\s+плат|\\bаванс"}]},"set":{"category_not":"Комісії платіжних систем"},"note":"Податки з ЗП — у статтю ЗП відділу людини; податки з виплат «як зп» — у статтю самої виплати. Точну статтю задають правила нижче (вищий пріоритет); якщо жодне не спрацювало — review."},{"id":"R-TAX-FOP-01","group":"Статті","title":"Податки ФОП (ЄП, ЄСВ, ВВ) → ЗП відділу продажів","priority":100,"source":"ТЗ §5; ручна звірка, аркуш «8 КПС» (ФОП — за текстом або за рахунком ФОП)","match":{"type":"expense","all":[{"any":[{"comment_regex":"(?i)\\bфоп\\b"},{"account_regex":"(?i)\\bфоп\\b|\\bfop\\b"}]},{"comment_regex":"(?i)подат(ок|к)|\\bпдфо\\b|\\bєсв\\b|\\bвз\\b|\\bвв\\b|\\bєп\\b|військов\\w*\\s+зб[іо]р|єдин\\w*\\s+(податок|внесок)"}]},"unless":[{"comment_regex":"(?i)подат(ок|к)\\w*\\s+(з|із)\\s+(зп|зарплат|%|відсот)"},{"comment_regex":"(?i)\\b(як|как|чз|через)\\s+(його\\s+|її\\s+)?зп\\b"},{"comment_regex":"(?i)реінвест|дотуван|тестуван"}],"set":{"category":"ЗП відділу продажів"}},{"id":"R-TAX-PCT-01","group":"Статті","title":"Податки з % менеджерів і тімлідів → Комісії відділу продажів (47/31)","priority":100,"source":"ТЗ §5 (10 % від суми «разом з податками»; сам % у кешфлоу не вноситься)","match":{"type":"expense","comment_regex":"(?i)подат(ок|к)\\w*\\s+(з|із)\\s+(%|відсот\\w*|процент\\w*)\\s+(менеджер|тімлід|тимлід|роп)|подат(ок|к)\\w*\\s+\\d+([.,]\\d+)?\\s*%\\s+(з|із)\\s[^;]*?(%\\s*|відсот\\w*\\s+|процент\\w*\\s+)(м-р|менеджер|тімлід|тимлід|тім\\s*лід)"},"set":{"category":"Комісії відділу продажів"},"note":"Стаття 47/31 зарплатна — API може відмовити (422); такі рядки йдуть у review."},{"id":"R-TAX-REINV-01","group":"Статті","title":"Податки з виплат на реінвест → та сама стаття (Реінвест) і та сама людина","priority":100,"source":"ТЗ §5 (раніше було «Адміністративні» / «Комісії платіжних систем»); уточнення 24.10.2026: з 01.09.2026, як у ручній звірці","effective_from":"2026-09-01","mode":"review","match":{"type":"expense","all":[{"comment_regex":"(?i)подат(ок|к)"},{"comment_regex":"(?i)реінвест|оборотн\\w*\\s+бюджет"}]},"unless":[{"comment_regex":"(?i)дотуван|тестуван"}],"set":{"category":"Реклама / Реінвест"},"note":"«Та сама людина» = маркетолог виплати (marketer_id) — CRM вимагає його для цієї статті, тому лише вручну."},{"id":"R-TAX-REINV-02","group":"Статті","title":"Податки з виплат на дотування → та сама стаття (Дотування) і та сама людина","priority":100,"source":"ТЗ §5; уточнення 24.10.2026: з 01.09.2026","effective_from":"2026-09-01","mode":"review","match":{"type":"expense","all":[{"comment_regex":"(?i)подат(ок|к)"},{"comment_regex":"(?i)дотуван"}]},"unless":[{"comment_regex":"(?i)реінвест|тестуван"}],"set":{"category":"Реклама / Дотування"}},{"id":"R-TAX-REINV-03","group":"Статті","title":"Податки з виплат на тестування → та сама стаття (Тестування) і та сама людина","priority":100,"source":"ТЗ §5; уточнення 24.10.2026: з 01.09.2026","effective_from":"2026-09-01","mode":"review","match":{"type":"expense","all":[{"comment_regex":"(?i)подат(ок|к)"},{"comment_regex":"(?i)тестуван"}]},"unless":[{"comment_regex":"(?i)реінвест|дотуван"}],"set":{"category":"Реклама / Тестування"}},{"id":"R-TAX-REINV-04","group":"Статті","title":"Податки з виплат на сервіси / інструменти → Інструменти","priority":100,"source":"правила обліку, п. 270 (податки з виплат «як зп» — у статтю виплати, зокрема «Інструменти»); уточнення 24.10.2026: з 01.09.2026","effective_from":"2026-09-01","mode":"review","match":{"type":"expense","all":[{"comment_regex":"(?i)подат(ок|к)"},{"comment_regex":"(?i)сервіс|підписк|інструмент"}]},"unless":[{"comment_regex":"(?i)реінвест|дотуван|тестуван"},{"comment_regex":"(?i)сша\\s+підписк"},{"comment_regex":"(?i)chat\\s*-?\\s*gpt|чат\\s*-?\\s*гпт|open\\s*-?\\s*ai|claude|\\bклод\\w*|anthropic|gemini|perplexity|midjourney|copilot"}],"set":{"category":"Інструменти"},"note":"Стаття — підказка за текстом: якщо саму виплату внесли в іншу статтю, податок іде туди ж. Для «Інструментів» CRM вимагає маркетолога — лише вручну."},{"id":"R-TAX-AI-01","group":"Статті","title":"Податки з виплат на AI-сервіси (ChatGPT, OpenAI, Claude…) → AI / API / Продуктовий софт","priority":100,"source":"Уточнення 24.10.2026 (Г1): як і самі оплати AI-сервісів (більшість уже в 58/53)","effective_from":"2026-09-01","mode":"review","match":{"type":"expense","all":[{"comment_regex":"(?i)подат(ок|к)"},{"comment_regex":"(?i)chat\\s*-?\\s*gpt|чат\\s*-?\\s*гпт|open\\s*-?\\s*ai|claude|\\bклод\\w*|anthropic|gemini|perplexity|midjourney|copilot"}]},"unless":[{"comment_regex":"(?i)реінвест|дотуван|тестуван"}],"set":{"category":"AI / API / Продуктовий софт"}},{"id":"R-MOBIZON-01","group":"Статті","title":"Мобізон → Продажі та маркетинг / Інструменти","priority":100,"source":"ТЗ §5 (маркетолог = той, для кого витрата); правила обліку, п. 183 (якщо невідомий — Тихоненко, id 124)","match":{"type":"expense","comment_regex":"(?i)мобізон|mobizon"},"unless":[{"comment_regex":"(?i)як\\s+для\\s+мобізон|власич|\\bаванс"}],"set":{"category":"Інструменти"},"note":"Для статті 23/42 CRM вимагає маркетолога — зміна лише вручну у формі CRM."},{"id":"R-OPENDATA-01","group":"Статті","title":"opendata → Фінанси та бухгалтерія (з 02.2026)","priority":100,"source":"ТЗ §5 («Фінанси» = «Фінанси та бухгалтерія», 56/48); уточнення 24.10.2026: з 02.2026, як у джерелах","effective_from":"2026-02-01","match":{"type":"expense","comment_regex":"(?i)open\\s*-?\\s*data|опен\\s*-?\\s*дат"},"set":{"category":"Фінанси та бухгалтерія"}},{"id":"R-INFRA-01","group":"Статті","title":"Інтернет Інвест, сервери, Hetzner, Хостинг Україна → Інфраструктура (з 02.2026)","priority":100,"source":"ТЗ §5; уточнення 24.10.2026: з 02.2026, домени — теж «Інфраструктура»","effective_from":"2026-02-01","match":{"type":"expense","comment_regex":"(?i)інтернет\\s*-?\\s*інвест|hetzner|хецнер|хетцнер|хост[иі]нг\\s+україн|ultahost|\\bсервер\\w*"},"unless":[{"comment_regex":"(?i)подат(ок|к)|\\bпдфо\\b|\\bєсв\\b|\\bвз\\b|\\bвв\\b|\\bєп\\b|військов\\w*\\s+зб[іо]р|єдин\\w*\\s+(податок|внесок)"},{"comment_regex":"(?i)адміністратор|сисадмін|налаштуван"},{"comment_regex":"(?i)розхідник|разом\\s*:|поповненн\\w*\\s+(корп\\w*\\s+)?картк"},{"comment_regex":"(?i)chat\\s*-?\\s*gpt|чат\\s*-?\\s*гпт|open\\s*-?\\s*ai|claude|\\bклод\\w*|anthropic|gemini|perplexity|midjourney|copilot"}],"set":{"category":"Інфраструктура"},"note":"Робота сисадміна («налаштування серверів») — не витрата на сервери; такі записи правило не чіпає. Так само переліки кількох сервісів, де сервер — лише один пункт (уточнення 24.10.2026)."},{"id":"R-OFFICE-01","group":"Статті","title":"Прибирання → Офіс (з 02.2026)","priority":100,"source":"ТЗ §5; уточнення 24.10.2026: з 02.2026","effective_from":"2026-02-01","match":{"type":"expense","comment_regex":"(?i)прибиран|клінінг|cleaning"},"set":{"category":"Офіс"}},{"id":"R-SALES-BONUS-01","group":"Статті","title":"Нагороди / KPI / бонуси відділу продажів → ЗП відділу продажів (з 02.2026)","priority":90,"source":"ТЗ §5; уточнення 24.10.2026: з 02.2026 (раніше бонуси з каси йшли в 47/31)","effective_from":"2026-02-01","match":{"type":"expense","all":[{"comment_regex":"(?i)нагород|\\bkpi\\b|\\bкпі\\b|\\bкрі\\b|бонус|наговор|кращ\\w*\\s+діалог"},{"comment_regex":"(?i)менеджер|тімлід|тимлід|відділ\\w*\\s+продаж|\\bроп\\b|кращ\\w*\\s+діалог|наговор|ставк"}]},"unless":[{"comment_regex":"(?i)джун|маркетолог|\\bсмм\\b|буц[аиі]\\b|шпак|привільн|пивовар|сливк|контент|татоян|віденец"},{"comment_regex":"(?i)подат(ок|к)\\w*\\s+(з|із)\\s+(%|відсот)|подат(ок|к)\\w*\\s+\\d+([.,]\\d+)?\\s*%\\s+(з|із)\\s[^;]*?(%\\s*|відсот\\w*\\s+|процент\\w*\\s+)(м-р|менеджер|тімлід|тимлід|тім\\s*лід)"}],"set":{"category":"ЗП відділу продажів"}},{"id":"R-MKT-ZP-01","group":"Статті","title":"ЗП Віденець Зіна, Турченко Адам, Ігор (Шелега), Андрій (Сидоричев) → ЗП відділу маркетингу","priority":100,"source":"ТЗ §5; ручна звірка 23.10.2026, аркуш «12 Ігор і Андрій» (Ігор = Шелега Ігор, SEO; Андрій = Сидоричев Андрій)","match":{"type":"expense","all":[{"any":[{"names":"@mkt_zp_people"},{"comment_regex":"(?i)ігор\\w*\\s*\\(?\\s*(сео|seo)|(сео|seo)\\w*\\s+ігор"}]},{"comment_regex":"(?i)\\bзп\\b|зарплат|заробітн\\w*\\s+плат|\\bаванс|сео\\s+спеціаліст"}]},"unless":[{"comment_regex":"(?i)\\b(як|как|чз|через)\\s+(його\\s+|її\\s+)?зп\\b"},{"comment_regex":"(?i)реклам|посилан|сервіс|реінвест|дотуван|тестуван|інструмент|плагін|heygen|claude|ahrefs|ахревс|колаборатор|collaborator|prnews|бюджет|\\bджун\\w*"}],"set":{"category":"ЗП відділу маркетингу"},"note":"«як зп / чз його зп» — лише спосіб виплати (реклама, сервіси), не ЗП. Уточнення 24.10.2026 (питання 9.3): ЗП Шелеги, зокрема «зарплата дизайнера Ігор Шелега», — ЗП відділу маркетингу; P220 («Шелега → Розробка») більше не діє."},{"id":"R-RES-POLINA-01","group":"Статті","title":"Поліна → Дослідження","priority":100,"source":"ТЗ §5","match":{"type":"expense","comment_regex":"(?i)\\bполін\\w*"},"unless":[{"comment_regex":"(?i)поповн\\w*\\s+(корп\\w*|корпоративн\\w*)\\s+карт"},{"comment_regex":"(?i)поверн\\w*\\s+(коштів\\s+)?клієнт"},{"comment_regex":"(?i)(%|відсот\\w*)\\s+(менеджер|тімлід|тимлід)"}],"set":{"category":"Дослідження"}},{"id":"R-RES-JUN-01","group":"Статті","title":"Усе про джунів → Дослідження","priority":100,"source":"ТЗ §5; ручна звірка 23.10.2026, аркуш «11 Дослідження» (винятки з A2)","match":{"type":"expense","comment_regex":"(?i)\\bджун\\w*"},"unless":[{"comment_regex":"(?i)поповн\\w*\\s+(корп\\w*|корпоративн\\w*)\\s+карт"},{"comment_regex":"(?i)поверн\\w*\\s+(коштів\\s+)?клієнт"},{"comment_regex":"(?i)(%|відсот\\w*)\\s+(менеджер|тімлід|тимлід)"}],"set":{"category":"Дослідження"},"note":"правила обліку, п. 287 (29.09.2026): ЗП / КПІ джунів маркетингу → ЗП відділу маркетингу — суперечить ТЗ, див. питання."},{"id":"R-RES-KZ-01","group":"Статті","title":"«Контент завод» → Дослідження","priority":110,"source":"ТЗ §5; ручна звірка, аркуш «11 Дослідження»","match":{"type":"expense","comment_regex":"(?i)контен\\w*\\s+завод\\w*"},"unless":[{"comment_regex":"(?i)поповн\\w*\\s+(корп\\w*|корпоративн\\w*)\\s+карт"},{"comment_regex":"(?i)поверн\\w*\\s+(коштів\\s+)?клієнт"},{"comment_regex":"(?i)(%|відсот\\w*)\\s+(менеджер|тімлід|тимлід)"}],"set":{"category":"Дослідження"}},{"id":"R-RES-SLYVKO-01","group":"Статті","title":"Сливко → Дослідження (крім реінвесту й дотування)","priority":105,"source":"ТЗ §5; ручна звірка, аркуш «11 Дослідження» (не для «вивід / як виконавець» — юрист-однофамілець, і «як зп Сливко» — лише спосіб виплати); уточнення 24.10.2026 (Б9, Б20, уточнення Б9)","match":{"type":"expense","names":["Сливк*"]},"unless":[{"comment_regex":"(?i)поповн\\w*\\s+(корп\\w*|корпоративн\\w*)\\s+карт"},{"comment_regex":"(?i)поверн\\w*\\s+(коштів\\s+)?клієнт"},{"comment_regex":"(?i)(%|відсот\\w*)\\s+(менеджер|тімлід|тимлід)"},{"comment_regex":"(?i)вивід|виконав"},{"all":[{"comment_regex":"(?i)\\bяк\\s+зп\\s+сливк"},{"not":{"comment_regex":"(?i)(?<!як\\s+зп\\s+)сливк"}}]},{"comment_regex":"(?i)реінвест|оборотн\\w*\\s+бюджет|дотуван"}],"set":{"category":"Дослідження"},"note":"Уточнення 24.10.2026: витрати Сливка → Дослідження, разом із податками з них (Б20) — тому пріоритет вищий за «податок → та сама стаття». Уточнення Б9: реінвест і дотування Сливка лишаються в «Реклама / Реінвест» і «Реклама / Дотування» (правила R-RES-SLYVKO-02, -03)."},{"id":"R-RES-TATOIAN-01","group":"Статті","title":"Татоян → Дослідження (крім реклами й поповнень карток)","priority":105,"source":"Уточнення 02.11.2026: Татояна — як Сливка, у «Дослідження», разом із податками з його ЗП (раніше ЗП Татояна — «ЗП відділу маркетингу», R-MKT-ZP-01; у вересні вона вже була в «Дослідженні», ID 9595)","match":{"type":"expense","names":["Татоян*"]},"unless":[{"comment_regex":"(?i)корп\\w*\\.?\\s*карт|корпоративн\\w*\\s+карт|corp\\s*card"},{"comment_regex":"(?i)поверн\\w*\\s+(коштів\\s+)?клієнт"},{"comment_regex":"(?i)(%|відсот\\w*)\\s+(менеджер|тімлід|тимлід)"},{"all":[{"comment_regex":"(?i)\\b(як|чз|через)\\s+(зп|з/п)\\s+(артем\\w*\\s+)?татоян"},{"not":{"comment_regex":"(?i)(?<!(як|чз|через)\\s+(зп|з/п)\\s+(артем\\w*\\s+)?)татоян"}}]},{"comment_regex":"(?i)реінвест|оборотн\\w*\\s+бюджет|дотуван|тестуван|промоут|таргет|реклам|facebk|facebook|google\\s*ads|tiktok"}],"set":{"category":"Дослідження"},"note":"Як R-RES-SLYVKO-01: пріоритет вищий за «податок → та сама стаття» — податки з ЗП Татояна теж у «Дослідження». Не чіпаються: поповнення корп. карток (це переказ), рекламні бюджети й покупки реклами (FACEBK…), «чз зп Татоян» / «як зп Татоян» (лише спосіб виплати). Проєкт — США (R-PRJ-US-TATOIAN-01)."},{"id":"R-RES-SLYVKO-02","group":"Статті","title":"Реінвест Сливка → Реклама / Реінвест","priority":105,"mode":"review","source":"Уточнення 24.10.2026 (уточнення Б9): реінвест і дотування Сливка лишаються в рекламних статтях, решта — у «Дослідження»","match":{"type":"expense","names":["Сливк*"],"comment_regex":"(?i)реінвест|оборотн\\w*\\s+бюджет"},"unless":[{"comment_regex":"(?i)поповн\\w*\\s+(корп\\w*|корпоративн\\w*)\\s+карт"},{"comment_regex":"(?i)поверн\\w*\\s+(коштів\\s+)?клієнт"},{"comment_regex":"(?i)(%|відсот\\w*)\\s+(менеджер|тімлід|тимлід)"},{"comment_regex":"(?i)вивід|виконав"},{"all":[{"comment_regex":"(?i)\\bяк\\s+зп\\s+сливк"},{"not":{"comment_regex":"(?i)(?<!як\\s+зп\\s+)сливк"}}]},{"comment_regex":"(?i)дотуван|тестуван"}],"set":{"category":"Реклама / Реінвест"},"note":"Стаття з маркетологом: лінтер лише показує записи не в цій статті, змінюють у CRM вручну. Податки з цих виплат ідуть у ту саму статтю (R-TAX-REINV-01)."},{"id":"R-RES-SLYVKO-03","group":"Статті","title":"Дотування Сливка → Реклама / Дотування","priority":105,"mode":"review","source":"Уточнення 24.10.2026 (уточнення Б9): реінвест і дотування Сливка лишаються в рекламних статтях, решта — у «Дослідження»","match":{"type":"expense","names":["Сливк*"],"comment_regex":"(?i)дотуван"},"unless":[{"comment_regex":"(?i)поповн\\w*\\s+(корп\\w*|корпоративн\\w*)\\s+карт"},{"comment_regex":"(?i)поверн\\w*\\s+(коштів\\s+)?клієнт"},{"comment_regex":"(?i)(%|відсот\\w*)\\s+(менеджер|тімлід|тимлід)"},{"comment_regex":"(?i)вивід|виконав"},{"all":[{"comment_regex":"(?i)\\bяк\\s+зп\\s+сливк"},{"not":{"comment_regex":"(?i)(?<!як\\s+зп\\s+)сливк"}}]},{"comment_regex":"(?i)реінвест|оборотн\\w*\\s+бюджет|тестуван"}],"set":{"category":"Реклама / Дотування"},"note":"Стаття з маркетологом: лінтер лише показує записи не в цій статті, змінюють у CRM вручну. Податки з цих виплат ідуть у ту саму статтю (R-TAX-REINV-02)."},{"id":"R-MGMT-BOZHKO-01","group":"Статті","title":"Божко Катерина → Менеджмент","priority":100,"source":"ТЗ §5; правила обліку, п. 36 (усі виплати з реєстрів Маркет)","match":{"type":"expense","comment_regex":"(?i)\\bбожк\\w*\\s+кат\\w*|\\bкат\\w*\\s+божк\\w*"},"set":{"category":"Менеджмент ( заробітна плата )"},"note":"«Божко» без імені — це Божко Валентин (тімлід), правило не спрацьовує. Стаття 51/38 зарплатна — review."},{"id":"R-SALES-ZP-01","group":"Статті","title":"Фалатенко → ЗП відділу продажів","priority":100,"source":"ТЗ §5; правила обліку, п. 37","match":{"type":"expense","all":[{"comment_regex":"(?i)\\bфалатенк\\w*"},{"any":[{"comment_regex":"(?i)\\bзп\\b|зарплат|заробітн\\w*\\s+плат|\\bаванс"},{"comment_regex":"(?i)реєстр|подат(ок|к)|премі|бонус"}]}]},"unless":[{"comment_regex":"(?i)(?<!подат(ок|к)\\w*\\s+\\d+([.,]\\d+)?\\s*)%|відсот|коміс"}],"set":{"category":"ЗП відділу продажів"}},{"id":"R-SALES-ZP-02","group":"Статті","title":"Логвиненко Віктор, Комаров → ЗП відділу продажів (до 04.2026)","priority":100,"source":"ТЗ §5; уточнення 24.10.2026 (Б11): до 04.2026 — ЗП відділу продажів, з 04.2026 — броніки (правила обліку, п. 201)","effective_to":"2026-03-31","match":{"type":"expense","all":[{"comment_regex":"(?i)\\bлогвиненк\\w*\\s+(віктор(а|у|ом|е)?\\b|в\\.)|\\bвіктор(а|у|ом|е)?\\s+логвиненк\\w*|\\bкомаров\\w*"},{"any":[{"comment_regex":"(?i)\\bзп\\b|зарплат|заробітн\\w*\\s+плат|\\bаванс"},{"comment_regex":"(?i)реєстр|подат(ок|к)|премі|бонус"}]}]},"unless":[{"comment_regex":"(?i)(?<!подат(ок|к)\\w*\\s+\\d+([.,]\\d+)?\\s*)%|відсот|коміс"}],"set":{"category":"ЗП відділу продажів"}},{"id":"R-HR-TARGET-01","group":"Статті","title":"«Таргет менеджерів, тімлідів» → HR та рекрутинг","priority":100,"source":"ТЗ §5","match":{"type":"expense","comment_regex":"(?i)таргет\\w*\\s+(на\\s+|для\\s+)?(менеджер|тімлід|тимлід)"},"set":{"category":"HR та рекрутинг"}},{"id":"R-ASSETS-01","group":"Статті","title":"Основні засоби → Продукт і розробка / Інфраструктура","priority":100,"source":"ТЗ §5; ручна звірка, аркуш «2 Основні засоби»; уточнення 24.10.2026 (Б13): стаття «Інфраструктура» (71/77), як у записах, які звірка вважає правильними","match":{"type":"expense","comment_regex":"(?i)основн\\w*\\s+засоб|ноутбук|макбук|macbook|комп['’]?ютерн|комп['’]?ютер(а|и|ів|ом)?\\b|монітор|принтер|лічильник|гарнітур|крісл|мебл[іья](?!\\s*/\\s*акваріум)|маршрутизатор|роутер|точк\\w*\\s+доступу|iphone|ipad|айфон"},"unless":[{"comment_regex":"(?i)ремонт(?!\\s*\\))"},{"comment_regex":"(?i)програмуван|it\\s*-?\\s*послуг"}],"set":{"category":"Інфраструктура"}},{"id":"R-NP-CORPCARD-01","group":"Не P&L","title":"Поповнення корпоративних карток → Переказ між рахунками","priority":100,"source":"ТЗ §5; 26.10.2026: формулювання з таблиці погоджень («на корп.картку», «корп картка — поповнення», описки «поповненя», «Поповення»); 27.10.2026: описка «корп каркти» (запис 26.10 пішов витратою); 30.10.2026: виняток для рахунків карток і з новими назвами «корп. картка …», «… корп карта …»","match":{"type":"expense","comment_regex":"(?i)(?:\\bпоп[оа]в\\w*|\\bна)\\s*\\(?\\s*(?:корп\\w*|корпоративн\\w*)\\.?\\s*ка\\w{0,2}т|(?:корп\\w*|корпоративн\\w*)\\.?\\s*ка\\w{0,2}т\\w*\\s*[-–—:,]?\\s*поп[оа]в|\\bна\\s+(?:корп\\w*|корпоративн\\w*)\\s*\\)|поп[оа]в\\w*\\s+corp\\s*card|\\bна\\s+corp\\s*card"},"unless":[{"account_regex":"(?i)corp\\s*card|корп\\.?\\s*карт"},{"comment_regex":"(?i)^\\s*коміс"}],"set":{"type":"transfer"},"note":"Тип запису API лінтера не змінює: замінити вручну на «Переказ» з рахунку на рахунок картки (corpCard …). Рахунок картки — лише того самого власника, що й рахунок, з якого платять (reference.card_topup, 30.10.2026)."},{"id":"R-NP-PANOV-01","group":"Не P&L","title":"Виплати Ілля Панов → переказ між своїми, не P&L","priority":100,"source":"ТЗ §5","match":{"comment_regex":"(?i)\\bпанов\\w*\\s+ілл\\w*|\\bілл\\w*\\s+панов\\w*"},"set":{"type":"transfer"}},{"id":"R-NP-AA-01","group":"Не P&L","title":"Готівка від НН → не дохід","priority":100,"source":"ТЗ §5 (витрати з цієї готівки знімаються з P&L на ту саму суму)","match":{"type":"income","comment_regex":"(?i)\\b(від|от)\\s+нн\\b|готівк\\w*\\s+(від\\s+)?нн\\b|\\bвнесок\\s+нн\\b"},"set":{"exclude_from_pnl":true},"note":"Правила обліку: «від НН» у касі — Інші доходи до 04.2026, далі внесок власника; див. питання. Відповідні витрати лінтер не визначає."},{"id":"R-NP-BRONIK-01","group":"Не P&L","title":"Броніки (список ТЗ і Гусак Микита) та податки з них → не показувати (з 02.2026)","priority":100,"source":"ТЗ §5; список з 02.2026: Сушенко В., Сушенко М., Обруч Д., Обруч С., Бендюга П., Бендюга С., Гординя О.; уточнення 24.10.2026 (Б18): Гусак Микита — теж бронік (від нього 500 $ за курсом компанії замість 1,5 %)","effective_from":"2026-02-01","match":{"type":"expense","all":[{"any":[{"names":"@bronik_2026_02"},{"comment_regex":"(?i)\\bгусак\\w*\\s+микит\\w*|\\bмикит\\w*\\s+гусак\\w*"}]},{"any":[{"comment_regex":"(?i)\\bзп\\b|зарплат|заробітн\\w*\\s+плат|\\bаванс"},{"comment_regex":"(?i)подат(ок|к)|\\bпдфо\\b|\\bєсв\\b|\\bвз\\b|\\bвв\\b|\\bєп\\b|військов\\w*\\s+зб[іо]р|єдин\\w*\\s+(податок|внесок)"},{"comment_regex":"(?i)брон|реєстр"}]}]},"set":{"exclude_from_pnl":true},"note":"Таких записів у кешфлоу бути не має: прибрати вручну (лінтер не видаляє)."},{"id":"R-NP-BRONIK-02","group":"Не P&L","title":"Логвиненко Віктор, Комаров — броніки з 04.2026 → не показувати","priority":100,"source":"правила обліку, п. 201; уточнення 24.10.2026 (Б11)","effective_from":"2026-04-01","match":{"type":"expense","all":[{"comment_regex":"(?i)\\bлогвиненк\\w*\\s+(віктор(а|у|ом|е)?\\b|в\\.)|\\bвіктор(а|у|ом|е)?\\s+логвиненк\\w*|\\bкомаров\\w*"},{"any":[{"comment_regex":"(?i)\\bзп\\b|зарплат|заробітн\\w*\\s+плат|\\bаванс"},{"comment_regex":"(?i)подат(ок|к)|\\bпдфо\\b|\\bєсв\\b|\\bвз\\b|\\bвв\\b|\\bєп\\b|військов\\w*\\s+зб[іо]р|єдин\\w*\\s+(податок|внесок)"},{"comment_regex":"(?i)брон|реєстр|премі|бонус"}]}]},"unless":[{"comment_regex":"(?i)(?<!подат(ок|к)\\w*\\s+\\d+([.,]\\d+)?\\s*)%|відсот|коміс"}],"set":{"exclude_from_pnl":true},"note":"ЗП і податки броніків не показуються: прибрати вручну (лінтер не видаляє)."},{"id":"R-PRJ-UA-01","group":"Проєкт","title":"Пивовар, Сливко → Україна","priority":100,"source":"ТЗ §5; ручна звірка, аркуш «5 Країни — правила»","match":{"type":"expense","names":["Пивовар","Пивоваря","Пивоварю","Пивоварьов*","Пивоварев*","Сливк*"]},"unless":[{"all":[{"all":[{"comment_regex":"(?i)\\bяк\\s+зп\\s+сливк"},{"not":{"comment_regex":"(?i)(?<!як\\s+зп\\s+)сливк"}}]},{"not":{"names":["Пивовар","Пивоварьов*","Пивоварев*"]}}]},{"all":[{"comment_regex":"(?i)вивід|виконав"},{"not":{"names":["Пивовар","Пивоваря","Пивоварю","Пивоварьов*","Пивоварев*"]}}]}],"set":{"project":"Україна"},"note":"«Вивід / як виконавець» — юрист-однофамілець Сливко Олексій, не маркетолог: такі записи правило не чіпає, як і R-RES-SLYVKO-01 (07.11.2026). Пивоваря це не стосується."},{"id":"R-PRJ-UK-01","group":"Проєкт","title":"Буца → Велика Британія","priority":100,"source":"ТЗ §5 (уточнення 20.10.2026)","match":{"type":"expense","comment_regex":"(?i)(\\bмарі[яї]\\s*|\\bмаш[аіи]\\s+|\\b)буц[аиуі]\\b"},"set":{"project":"Велика Британія"}},{"id":"R-PRJ-US-VYV-01","group":"Проєкт","title":"Віденець (Зіна) → США","priority":100,"source":"ТЗ §5; ручна звірка («маркетинг по країнах», жовт. 2026)","match":{"type":"expense","names":["Віденець","Віденця","Віденцю","Віденцем","Videnets","Зіна","Зіни","Зіні","Зіну","Zina"]},"unless":[{"comment_regex":"(?i)контен\\w*\\s+завод"}],"set":{"project":"США"}},{"id":"R-PRJ-US-SERGIY-01","group":"Проєкт","title":"«Сергій» → США (ім'я неоднозначне — лише з підтвердженням)","priority":100,"source":"ТЗ §5","mode":"review","match":{"type":"expense","all":[{"names":["Сергій","Сергія","Сергію","Сергієм"]},{"comment_regex":"(?i)реклам|дотуван|тестуван|реінвест|маркетолог|таргет|\\bсмм\\b|\\bsmm\\b|\\bcmo\\b|\\bсмо\\b|\\bсео\\b|\\bseo\\b|бюджет|\\bфб\\b|facebook|google|гугл"}]},"unless":[{"comment_regex":"(?i)симонов"}],"set":{"project":"США"}},{"id":"R-PRJ-US-MYTRYCH-01","group":"Проєкт","title":"Митрич → США","priority":100,"source":"ТЗ §5","match":{"type":"expense","names":["Митрич*"]},"set":{"project":"США"}},{"id":"R-PRJ-US-SHELEHA-01","group":"Проєкт","title":"SEO Ігор (Шелега) → США","priority":100,"source":"ТЗ §5; ручна звірка («Шелега (SEO Ігор)»)","match":{"type":"expense","any":[{"names":["Шелег*","Шелезі"]},{"comment_regex":"(?i)ігор\\w*\\s*\\(?\\s*(сео|seo)|(сео|seo)\\w*\\s+ігор"}]},"set":{"project":"США"}},{"id":"R-PRJ-US-SYMON-01","group":"Проєкт","title":"Симонович → США","priority":100,"source":"ТЗ §5 (уточнення 20.10.2026)","match":{"type":"expense","names":["Симонович*","Симонов"]},"set":{"project":"США"}},{"id":"R-PRJ-US-TATOIAN-01","group":"Проєкт","title":"Татоян → США","priority":100,"source":"ТЗ §5 (уточнення 20.10.2026)","match":{"type":"expense","names":["Татоян*"]},"set":{"project":"США"}},{"id":"R-PRJ-US-PASSPORT-01","group":"Проєкт","title":"«США паспорт» → США","priority":100,"source":"ТЗ §5 (уточнення 20.10.2026)","match":{"type":"expense","comment_regex":"(?i)сша\\s+паспорт|паспорт\\w*\\s+(для\\s+)?сша|сша\\s+на\\s+паспорт|паспорт\\w*\\s+на\\s+сша"},"set":{"project":"США"}},{"id":"R-PRJ-PL-01","group":"Проєкт","title":"Привільна → Польща (з 2026, крім її джунів)","priority":100,"source":"ТЗ §5; уточнення 24.10.2026 (питання 9.5): лише з 2026 — записи до 2026 не чіпати","effective_from":"2026-01-01","match":{"type":"expense","comment_regex":"(?i)\\bпривільн\\w*"},"unless":[{"comment_regex":"(?i)\\bджун\\w*"}],"set":{"project":"Польща"}},{"id":"R-PRJ-PL-JUN-01","group":"Проєкт","title":"Джуни Привільної → Україна","priority":100,"source":"ТЗ §5; уточнення 24.10.2026 (питання 9.5а): завжди Україна, як у ручній звірці","match":{"type":"expense","all":[{"comment_regex":"(?i)\\bпривільн\\w*"},{"comment_regex":"(?i)\\bджун\\w*"}]},"set":{"project":"Україна"}},{"id":"R-PRJ-UA-2325-01","group":"Проєкт","title":"Вдовиченко Ларина, Бінотел, Коллсапп → Україна (2023–2025)","priority":100,"source":"ТЗ §5 (уточнення 21.10.2026)","effective_from":"2023-01-01","effective_to":"2025-12-31","match":{"type":"expense","any":[{"names":["Вдовиченк*","Вакулко Ларин*"]},{"comment_regex":"(?i)бінотел|binotel|коллсапп|колсапп|callsapp"}]},"set":{"project":"Україна"}},{"id":"R-PRJ-OTHER-2325-01","group":"Проєкт","title":"Жарков, Сомов, Нікітченко → «інші країни» (2023–2025, країна невідома)","priority":100,"source":"ТЗ §5 (уточнення 21.10.2026); відкрите питання 9.1","effective_from":"2023-01-01","effective_to":"2025-12-31","match":{"type":"expense","any":[{"names":["Жарков*","Сомов","Сомова","Сомову","Сомовим"]},{"comment_regex":"(?i)нікітченк|никитченк"}],"project_in":["Україна",null]},"set":{"review":"«інші країни»: конкретна країна невідома (питання 9.1) — зараз «Україна» або порожньо"}}]};
var CF_BUILD = '2026-11-19T22:39:56Z'; // мітка збірки: закладка бере найновішу, панель упізнає «ту саму» збірку
/* ---- bookmarklet/main.js ---- */
/* Запуск лінтера на сторінці crm.example.com (букмарклет або консоль).
   Токен — localStorage.token (як у реєстрі v1.10), запити — на той самий домен.
   Без window.CF_LINTER_CONFIG = { APPLY: true } режим редагування недоступний. */
(() => {
  'use strict';
  if (!window.CF_DEMO === true) { alert('Лінтер кешфлоу: відкрийте crm.example.com під своїм логіном'); return; }
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

})();
