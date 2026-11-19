"""Мок API crm.example.com для наскрізного тесту «Помічника кешфлоу» (без справжнього CRM).
python -I test/mock_crm_server.py [--port 8899] [--rows work/sep_rows.json] [--bank <виписка_ВСІ_….json>]
Токен: будь-який, що починається з «mock-token-». Зарплатні статті (31–39, 61, 62) на PUT → 422.
Записи: вересень — зі стислих рядків dry-run (якщо є), жовтень — синтезовано з виписки банку
(з навмисними розбіжностями: кожна 9-та операція пропущена, кожна 7-ма зсунута на день, кожна 15-та має «зайвого» двійника).
Залишок рахунку (balance, як у CRM) = сума його записів + BALANCE_OFFSET: у живому CRM вони теж бувають різні.
Перекази між своїми: покупки корп. карткою (маска «**** 3462» у призначенні) — витрати на corpCard 89 і одне поповнення 68 → 89,
операції з REF «XMISS…» у CRM не вносяться (переказ, якого немає), решта — як звичайні записи. POST /api/invoice-payment
(FormData, як у реєстрі погоджень) створює переказ (operation 3) або витрату / надходження (operation 2 / 1).
Чернетки CRM (як у живому CRM 14.11.2026): GET /api/invoice-payment-drafts?page=&per_page= (≤ 100, інакше 422; інші параметри
ігноруються, новіші — першими), POST (FormData, ті самі поля; 201 + чернетка), GET / DELETE /api/invoice-payment-drafts/ID,
POST …/ID/convert — чернетка стає записом з тим самим ID (ті самі перевірки, що й у POST /api/invoice-payment). ID чернеток і
записів — з однієї послідовності; чернеток немає в списку записів і в GET /api/invoice-payment/ID (404), залишок вони не змінюють.
GET /registry/reset очищає й чернетки."""
import argparse
import email.parser
import email.policy
import json
import re
import sys
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SALARY_OPS = {31, 32, 33, 34, 35, 36, 37, 38, 39, 61, 62}
DB = {}
REF = {}
STATIC = None  # --static: папка тестової сторінки закладки
BALANCE_OFFSET = {33: 1000.0}  # «залишок CRM ≠ сума записів» для перевірки вкладки «Звірка з банком»
BANK = {}  # синтетична виписка (--bank): з неї імітація Помічника «вивантажує» виписки за період
HJOB = {'running': False, 'log': [], 'code': None, 'file': None, 'started': None, 'args': None, 'until': 0}
HFILES = {}  # name → JSON, «вивантажені» імітацією Помічника
SAVED = {}  # name → розмір: резервні копії й журнали, які панель «зберегла в Помічнику»
AI = None  # --ai: справжній app/helper_ai.py з підробним Claude (test/fake_anthropic.py); без --ai — «ключа немає»
AI_NOKEY = {'ok': True, 'state': 'nokey', 'state_ua': 'немає ключа Claude API', 'results': {}, 'pending': 0, 'failed': 0, 'running': False, 'error': '',
            'model': 'Claude Sonnet 5.5', 'usage': {'usd': 0, 'limit': 100}}


def setup_ai():
    """«Підказки ШІ» в імітації Помічника: черга, кеш і очищення тексту — справжні (app/helper_ai.py), Claude — підробний, без мережі."""
    global AI
    import tempfile
    sys.path[:0] = [str(ROOT / 'app'), str(ROOT / 'test')]
    import fake_anthropic
    import helper_ai
    tmp, conf = Path(tempfile.mkdtemp(prefix='cfl_ai_')), {'ai': {'shared': 'off'}}  # справжня «Кешфлоу ШІ» на Google Диску — не для моку

    def save_config(c):
        conf.clear()
        conf.update(json.loads(json.dumps(c)))
    helper_ai.setup(data=lambda: tmp, dpapi=lambda b, protect: b[::-1], log=lambda m: print('ШІ:', m, flush=True), load_config=lambda: json.loads(json.dumps(conf)),
                    save_config=save_config, rules_path=lambda: ROOT / 'rules' / 'rules.json', format_path=lambda: ROOT / 'rules' / 'ФОРМАТ_ПРАВИЛ.md', can_edit_rules=lambda: True)
    helper_ai.CLIENT_FACTORY[0] = fake_anthropic.make_client
    fake_anthropic.DELAY['s'] = 1.5
    helper_ai.save_key('sk-ant-mock-' + 'x' * 30)
    helper_ai.set_cfg(on=True)
    AI = helper_ai
    print(f'ШІ-підказки: підробний Claude, дані — {tmp}', flush=True)


def bank_for_period(d_from, d_to):
    """Виписка за період з повної синтетичної: операції в межах дат, вхідний і вихідний залишки перераховано."""
    accs = []
    for a in BANK.get('accounts', []):
        rows = []
        for t in a.get('transactions', []):
            if a['bank'] == 'mono':
                d = datetime.fromtimestamp(t['time'], timezone(timedelta(hours=3))).date().isoformat()
                amt = t['amount'] / 100
            else:
                dd, mm, yy = t['DAT_OD'].split('.')
                d = f'{yy}-{mm}-{dd}'
                amt = float(str(t['SUM']).replace(',', '.')) * (-1 if t.get('TRANTYPE') == 'D' else 1)
            rows.append((d, amt, t))
        before = sum(x[1] for x in rows if x[0] < d_from)
        inside = [x for x in rows if d_from <= x[0] <= d_to]
        opening = round(a['opening'] + before, 2)
        accs.append({**a, 'opening': opening, 'closing': round(opening + sum(x[1] for x in inside), 2), 'transactions': [x[2] for x in inside]})
    return {**BANK, 'client': 'ВСІ', 'from': d_from, 'to': d_to, 'fetched_at': datetime.now().strftime('%d.%m.%Y %H:%M'), 'accounts': accs}
SIGN = {1: 1, 2: -1, 3: 1, 4: -1, 5: 1, 6: -1}


def kyiv_utc(d):
    """Київська дата → ISO UTC як у CRM (північ за Києвом; літо UTC+3, зима UTC+2)."""
    y = int(d[:4])
    last_sun = lambda m: max(date(y, m, day) for day in range(25, 32) if date(y, m, day).weekday() == 6)
    summer = last_sun(3) <= date.fromisoformat(d) < last_sun(10)
    dt = datetime.fromisoformat(d) - timedelta(hours=3 if summer else 2)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.000000Z')


def rec(rid, d, acc_id, op, cat, opid, amount, comment, prj=1, lead=False, auto=False, mk=None):
    iso = kyiv_utc(d)
    return {'id': rid, 'user_id': 1, 'location_id': None, 'project_id': prj, 'task_payment_id': 777 if lead else None, 'comment': comment,
            'date': iso, 'period': iso, 'created_at': iso.replace('00:00.000000Z', '10:00.000000Z'), 'updated_at': iso, 'deleted_at': None,
            'is_manual': not auto, 'is_edited': False, 'kyiv': d,
            'marketer_balance_history': {'marketer_balance': {'user_id': mk}} if mk else None,
            'payments': [{'id': rid * 10, 'transaction_id': rid, 'invoice_id': acc_id, 'operation': op, 'pnl_category_id': cat, 'pnl_operation_id': opid,
                          'amount': round(abs(amount), 2), 'deleted_at': None, 'comment': None, 'tax': None}]}


def xfer(rid, d, acc_from, acc_to, amount, comment, prj=1):
    r = rec(rid, d, acc_from, 4, None, None, amount, comment, prj)
    r['payments'].append({**r['payments'][0], 'id': rid * 10 + 1, 'invoice_id': acc_to, 'operation': 3})
    return r


CORP = {'3462': 89, '7850': 91, '4546': 104}  # картки списують з рахунку ФОП (3462 — Хоменко, 68; 7850 і 4546 — Мартиненко, 70), у CRM покупки — на їхні corpCard
MK_CARD = 1235  # покупки картки 3462 — реклама маркетолога Миколаївського (як у живому CRM: ім'я в коментарі, у списку записів маркетолога немає)


def card_comment(text, amount):
    """Коментар покупки корп. карткою, як їх пишуть у CRM: «Facebook 02.10 Миколаївський Дмитро (реінвест США): 1011.26 UAH, корп. картка 3462»."""
    m = re.search(r'\*{4}\s+(\d{4})\s+(\d{2})\.(\d{2})\.\d{4}', text)
    return f'Facebook {m.group(2)}.{m.group(3)} Миколаївський Дмитро (реінвест США): {abs(amount):.2f} UAH, корп. картка {m.group(1)}'


def demo_reference():
    """Вигаданий довідник CRM для публічної версії: статті й проєкти — з rules/rules.json, рахунки — придумані (ті самі ID, що в тестовій виписці)."""
    arts = json.loads((ROOT / 'rules' / 'rules.json').read_text(encoding='utf-8'))['reference']['articles']
    by_cat = {}
    for a in arts:
        c = by_cat.setdefault(a['category_id'], {'category_id': a['category_id'], 'category': a['category'], 'type': a['type'], 'operations': []})
        c['operations'].append([a['operation_id'], a['name']])
    accounts = [[33, 'Приват ТОВ ПРИКЛАД СЕРВІС 5608'], [36, 'Приват долар ТОВ ПРИКЛАД СЕРВІС 0036'], [38, 'Приват ТОВ ПРИКЛАД СЕРВІС 4431'],
                [68, 'ФОП Хоменко Всеволод Сергійович Приват'], [69, 'ФОП Хоменко Всеволод Сергійович Моно'], [70, 'ФОП Мартиненко Святослав Олександрович Приват'],
                [89, 'корп. картка 3462 ФОП Хоменко Всеволод Сергійович'], [91, 'корп. картка 7850 ФОП Мартиненко Святослав Олександрович'],
                [104, 'корп. картка 4546 ФОП Мартиненко Святослав Олександрович']]
    return {'accounts': accounts, 'currencies': {'1': 'UAH', '2': 'USD', '3': 'EUR', '4': 'GBP', '5': 'PLN', '6': 'AED'},
            'articles_current': list(by_cat.values()), 'articles_legacy': []}


def load(rows_path, bank_path):
    ref_file = ROOT / 'work' / 'crm_reference.json'  # довідник, знятий з CRM; у публічній версії його немає — будується вигаданий
    ref = json.loads(ref_file.read_text(encoding='utf-8')) if ref_file.is_file() else demo_reference()
    REF['accounts'] = [{'id': a, 'name': n, 'currency_id': 1, 'deleted_at': None} for a, n in ref['accounts']]
    ccy_by_name = {'USD': 2, 'EUR': 3, 'Євр': 3, 'GBP': 4, 'PLN': 5, 'ЗЛТ': 5, 'AED': 6}
    for a in REF['accounts']:
        for k, v in ccy_by_name.items():
            if re.search(rf'(?<![А-ЯA-Zа-яa-z]){k}(?![А-ЯA-Zа-яa-z])', a['name']):
                a['currency_id'] = v
    REF['currencies'] = [{'id': i, 'code': c} for i, c in ref['currencies'].items()]
    cats, ops = {}, {}
    for a in ref['articles_current']:
        cats[a['category_id']] = a['category']
        for op_id, name in a['operations']:
            ops[op_id] = (name, a['type'])
    for a in ref['articles_legacy']:
        cats.setdefault(a['category_id'], a['category'])
    REF['cats'] = [{'id': k, 'name': v} for k, v in cats.items()]
    REF['ops'] = [{'id': k, 'name': v[0], 'operation': v[1]} for k, v in ops.items() if k != 43]
    by_name = {a['name']: a['id'] for a in REF['accounts']}
    rows = json.loads(Path(rows_path).read_text(encoding='utf-8')) if rows_path and Path(rows_path).exists() else []
    for r in rows:
        rid, d, acc, amount, ccy, t, comment, art, prj, status, reasons, src, rules = r
        cat, opid = (int(x) for x in art.split('/')) if art else (59, 55)
        DB[rid] = rec(rid, d, by_name.get(acc, 33), 1 if t == 'i' else 2, cat, opid, amount, comment, prj or None, src == 'L', src == 'A')
    if not rows:  # синтетичний набір без реальних даних
        for i, (c, art) in enumerate([('Банківська комісія: обслуговування рахунку', '59/55'), ('реінвест за 01.09 на ФОП Привільна', '20/30'),
                                     ('ЄП по ФОП Хоменко за 09 2026', '76/82'), ('IT зп за червень Шелега', '50/37'), ('генеральне прибирання', '57/52')]):
            cat, opid = (int(x) for x in art.split('/'))
            DB[1000 + i] = rec(1000 + i, '2026-09-1' + str(i), 33, 2, cat, opid, 1000 + i, c)
    if bank_path and Path(bank_path).exists():
        bank = json.loads(Path(bank_path).read_text(encoding='utf-8'))
        BANK.update(bank)
        mapping = {('ПРИКЛАД', 'privat', 'UAH'): 33, ('ПРИКЛАД', 'privat', 'USD'): 36, ('Маркет', 'privat', 'UAH'): 1, ('Маркет', 'privat', 'USD'): 30, ('Маркет', 'privat', 'EUR'): 2,
                   ('ФОП Хоменко', 'privat', 'UAH'): 68, ('ФОП Хоменко', 'mono', 'UAH'): 69, ('ФОП Мартиненко', 'privat', 'UAH'): 70,
                   ('ФОП Мазовецька', 'privat', 'UAH'): 83, ('ФОП Житинська', 'privat', 'UAH'): 44, ('ФОП Житинська', 'mono', 'UAH'): 43, ('ФОП Сидорук', 'mono', 'UAH'): 79}
        rid, k, days_buy = 900000, 0, {}
        for a in bank.get('accounts', []):
            acc_id = mapping.get((a.get('client'), a.get('bank'), a.get('ccy')))
            if not acc_id or re.match(r'\s*(мас\.?\s*вип|рко|ціл)', a.get('name') or '', re.I):  # службових рахунків (масові виплати, РКО, цільові) у CRM немає
                continue
            if a.get('opening') is not None:
                op = 1 if a['opening'] >= 0 else 2
                DB[rid] = rec(rid, '2026-09-30', acc_id, op, 46 if op == 1 else 59, 23 if op == 1 else 55, a['opening'], 'Вхідний залишок (тест)')
                rid += 1
            for t in a.get('transactions', []):
                if a['bank'] == 'mono':
                    d = datetime.fromtimestamp(t['time'], timezone(timedelta(hours=3))).date().isoformat()
                    amount, text = t['amount'] / 100, t.get('description') or ''
                else:
                    if t.get('PR_PR') and t['PR_PR'] != 'r':
                        continue
                    dd, mm, yy = t['DAT_OD'].split('.')
                    d = f'{yy}-{mm}-{dd}'
                    amount = float(str(t['SUM']).replace(',', '.')) * (-1 if t.get('TRANTYPE') == 'D' else 1)
                    text = t.get('OSND') or ''
                ref = str(t.get('REF') or '')
                card = re.search(r'\*{4}\s+(\d{4})', text)
                if ref.startswith('XMISS'):  # переказу між своїми в CRM немає
                    continue
                if ref.startswith('XLATE') and card and card.group(1) in CORP:  # покупка карткою: у CRM — за датою покупки з призначення, банк провів пізніше
                    m = re.search(r'\*{4}\s+\d{4}\s+(\d{2})\.(\d{2})\.(\d{4})', text)
                    DB[rid] = rec(rid, f'{m.group(3)}-{m.group(2)}-{m.group(1)}', CORP[card.group(1)], 2, 20, 30, amount, card_comment(text, amount), prj=4, mk=MK_CARD)
                    rid += 1
                    continue
                if ref.startswith('XSPLIT'):  # одна операція банку — два записи CRM (переказ на картку власника, з неї — дві виплати)
                    part = round(abs(amount) * 0.6, 2)
                    for a2, who in ((part, 'A'), (round(abs(amount) - part, 2), 'B')):
                        DB[rid] = rec(rid, d, acc_id, 2, 59, 55, a2, f'Виплата виконавцю {who} (тест)')
                        rid += 1
                    continue
                if ref.startswith('XDAY') and card and card.group(1) in CORP:  # покупки картки за день — у CRM одним записом (як «Facebook, 1011.31+514,00+1386.43 = 2 911,74»)
                    m = re.search(r'\*{4}\s+\d{4}\s+(\d{2})\.(\d{2})\.(\d{4})', text)
                    days_buy.setdefault((card.group(1), f'{m.group(3)}-{m.group(2)}-{m.group(1)}'), []).append(amount)
                    continue
                if ref.startswith('XREF'):  # платіж і його повернення: у CRM не вносяться
                    continue
                if ref.startswith('XLIQ'):  # LiqPay: у CRM — оплата ліда (брутто) і окремий запис комісії з тим самим LIQPAY ID
                    lid, fee = re.search(r'LIQPAY ID (\d+)', text).group(1), 5.19
                    DB[rid] = rec(rid, d, acc_id, 1, 45, 21, round(amount + fee, 2), 'Оплата за доступ до програмного продукту Сервіс (Акаунт #9001) (тест)')
                    DB[rid + 1] = rec(rid + 1, d, acc_id, 2, 76, 82, fee, f'Комісія LiqPay 16:21: оплата {amount + fee:.2f}, зараховано {amount:.2f} (тест), LIQPAY ID {lid}')
                    rid += 2
                    continue
                if ref.startswith('XTAX'):  # податки із ЗП за день: банк — ВЗ і ПДФО (+ ЄСВ), у CRM — податки по людях; ЄСВ по людях не вносять
                    if ref == 'XTAX1':
                        for a2, who in ((600, 'Іваненко'), (400, 'Петренко')):
                            DB[rid] = rec(rid, d, acc_id, 2, 59, 55, a2, f'Податки 10 % з {a2 * 10:.2f} (на руки {a2 * 9:.2f}) — {who} (тест)')
                            rid += 1
                    continue
                if ref.startswith('XNEW'):  # покупка карткою, номера якої лінтер не знає: у CRM — на corpCard 89 (як буває з новою чи перевипущеною карткою)
                    DB[rid] = rec(rid, d, 89, 2, 20, 30, amount, text[:200], mk=208)
                    rid += 1
                    continue
                if ref.startswith('XPAY'):  # ЗП через транзитний рахунок: у CRM — записи по людях зі статтею ЗП (47/31), разом не 1:1 з банком
                    for a2, who in ((700, 'Іваненко'), (600, 'Петренко'), (400, 'Сидоренко')):
                        DB[rid] = rec(rid, d, acc_id, 2, 47, 31, a2, f'Підтвердження виведення коштів з балансу менеджера {who} (тест)')
                        rid += 1
                    continue
                if card and card.group(1) in CORP:  # покупка корп. карткою — реклама на corpCard з маркетологом (рекламний бюджет), коментар як у CRM
                    DB[rid] = rec(rid, d, CORP[card.group(1)], 2, 20, 30, amount, card_comment(text, amount), prj=4, mk=MK_CARD)
                    rid += 1
                    continue
                if ref.startswith('X'):  # особливі рядки тесту — без випадкових пропусків і зсувів
                    op = 1 if amount > 0 else 2
                    DB[rid] = rec(rid, d, acc_id, op, 45 if op == 1 else 59, 21 if op == 1 else 55, amount, text[:200])
                    rid += 1
                    continue
                k += 1
                if k % 9 == 0:
                    continue
                if k % 7 == 0:
                    d = (date.fromisoformat(d) + timedelta(days=1)).isoformat()
                op = 1 if amount > 0 else 2
                DB[rid] = rec(rid, d, acc_id, op, 45 if op == 1 else 59, 21 if op == 1 else 55, amount, text[:200])
                rid += 1
                if k % 15 == 0:
                    DB[rid] = rec(rid, d, acc_id, 2, 59, 55, 123.45, 'зайвий запис для тесту звірки')
                    rid += 1
        for (last4, d), amounts in days_buy.items():  # один запис на всі покупки картки за день
            DB[rid] = rec(rid, d, CORP[last4], 2, 20, 30, sum(amounts), 'Facebook, ' + '+'.join(f'{abs(a):.2f}' for a in amounts) + f' = {abs(sum(amounts)):.2f} Миколаївський Дмитро (тест)', prj=4, mk=MK_CARD)
            rid += 1
        if any(a.get('client') == 'ФОП Хоменко' and a.get('bank') == 'privat' for a in bank.get('accounts', [])):
            DB[rid] = xfer(rid, '2026-10-02', 68, 89, 1000, 'поповнення корп картки 3462 (тест)')  # поповнень менше, ніж покупок: corpCard у мінусі
            rid += 1  # поповнення корп. картки, записане витратою (з опискою, як у живому CRM): лінтер пропонує змінити тип на переказ 68 → 89
            DB[rid] = rec(rid, '2026-10-15', 68, 2, 20, 41, 1600, 'Тимур Тест: Поповнення корп каркти, для реклами ФБ (тест)')
            rid += 1
        if any(a.get('client') == 'ФОП Мартиненко' and a.get('bank') == 'privat' for a in bank.get('accounts', [])):
            # дві корп. картки Мартиненка (з 14.10 платить лише 4546): поповнення 14.10 без номера й тримача записано на стару 7850 — «Звірка»
            # пропонує переспрямувати за випискою; 16.10 — з номером 4546 у коментарі, а записано на 7850 — за номером; 01.10 — правильне
            for d, a, c in (('2026-10-01', 5000, 'поповнення корп картки 7850 (тест)'), ('2026-10-14', 4000, 'Тимур Тест: реінвест за 13.10 на корп картку (тест)'),
                            ('2026-10-16', 1500, 'поповнення корп картки 4546 (тест)')):
                DB[rid] = xfer(rid, d, 70, 91, a, c)
                rid += 1
        # виводи з балансу 02.11: сестра й брат з одним прізвищем — погодження «Сидорук Тарас» має взяти лише вивід Тараса
        for who, amount in (('Сидорук Інесса Артемівна', 7938), ('Сидорук Тарас Артемович', 6100)):
            DB[rid] = rec(rid, '2026-11-02', 33, 2, 47, 31, amount, f'Підтвердження виведення коштів з балансу менеджера {who} від 02.11.2026 по проекту Україна на суму {amount}.00 грн', auto=True)
            rid += 1
    print(f'мок CRM: записів {len(DB)}, рахунків {len(REF["accounts"])}', flush=True)


# Імітація веб-застосунку реєстру погоджень (Apps Script 1.8, /registry/exec): «Довідник» — рахунки {id: мітка «назва [id]»};
# стовпець «Куди (переказ)» (AA) таблиці «Реєстр» приймає лише мітки «Довідника» — рахунок, якого там немає, Apps Script пише
# як «назва [id]», і перевірка даних його не пропускає. Дії «accounts» (закладка 1.9) Apps Script 1.8 не знає.
REG = {'accounts': {}, 'calls': [], 'old': []}
REG_INACTIVE = re.compile(r'неактуальн|not actual|не актуальн', re.I)
REG_BAD = 'Дані, введені в клітинку AA5, не відповідають установленим для неї правилам перевірки даних.'
# рядки реєстру для дії bank («Закриття місяця»): внесений, невнесений «так», «перевірити», «ні», до «Починати з дати»
REG_BANK_ROWS = [
    {'key': '06.10.2026#h1', 'date': '2026-10-06', 'recipient': 'Hetzner', 'amount': 1200, 'action': 'так', 'status': 'внесено', 'id': 24400},
    {'key': '29.10.2026#hB', 'date': '2026-10-29', 'recipient': 'Клод', 'amount': 4600, 'action': 'так', 'status': '', 'id': 0},
    {'key': '28.10.2026#hC', 'date': '2026-10-28', 'recipient': 'Бюро перекладів', 'amount': 3000, 'action': 'перевірити', 'status': '', 'id': 0},
    {'key': '27.10.2026#hD', 'date': '2026-10-27', 'recipient': 'Повернення клієнту', 'amount': 500, 'action': 'ні', 'status': '', 'id': 0},
    {'key': '30.09.2026#hE', 'date': '2026-09-30', 'recipient': 'Старе', 'amount': 100, 'action': 'так', 'status': '', 'id': 0},
    # «% менеджера» (виводи з балансу, період 01–04.11): погодження Сидорука Тараса — не вивід Сидорук Інесси (випадок 04.11.2026);
    # свіже погодження Цвяха без виводу — «чекаємо вивід», не червоне «виводу немає»
    {'key': '01.11.2026#w1', 'date': '2026-11-01', 'recipient': 'Сидорук Тарас', 'content': '% менеджера за період з 19-25.10', 'textAmount': 7938, 'amount': 7938,
     'action': 'ні', 'status': '', 'id': 0},
    {'key': '03.11.2026#w2', 'date': '2026-11-03', 'recipient': 'Цвях Богдан', 'content': '% менеджера Цвях за період з 26.10-01.11', 'textAmount': 2170, 'amount': 2170,
     'action': 'ні', 'status': '', 'id': 0},
    # «Зіставлення ШІ» (виписка 01–20.10): пакет ЗП ПРИКЛАД 09.10 на 1 500 (2 картки) = Іваненко 700 + премія 200 (погоджено з іншого рахунку
    # ПРИКЛАД — 4431) і Петренко 600: одна людина — кілька погоджень на одну картку (05.11.2026); оплата ФОП Власич 15.10 — 1:1;
    # переказ Хоменка на свою картку 1 350 (09.10) — погодження «бонус» на 1 300 (лише ШІ: сума інша); переклад — у виписці немає
    {'key': '09.10.2026#z1', 'date': '2026-10-09', 'recipient': 'Іваненко Іван', 'content': 'ЗП за жовтень', 'amount': 700, 'acc': 33, 'action': 'так', 'status': '', 'id': 0},
    {'key': '09.10.2026#z2', 'date': '2026-10-09', 'recipient': 'Петренко Петро', 'content': 'ЗП за жовтень', 'amount': 600, 'acc': 33, 'action': 'так', 'status': '', 'id': 0},
    {'key': '09.10.2026#z3', 'date': '2026-10-09', 'recipient': 'Іваненко Іван', 'content': 'премія за жовтень', 'amount': 200, 'acc': 38, 'action': 'так', 'status': '', 'id': 0},
    {'key': '15.10.2026#z4', 'date': '2026-10-15', 'recipient': 'ФОП Власич Оксана Володимирівна', 'content': 'реклама за жовтень', 'amount': 8791, 'acc': 68,
     'action': 'так', 'status': '', 'id': 0},
    {'key': '09.10.2026#z5', 'date': '2026-10-09', 'recipient': 'Хоменко Всеволод', 'content': 'бонус менеджерам за вересень', 'amount': 1300, 'acc': 68,
     'action': 'так', 'status': '', 'id': 0},
    {'key': '12.10.2026#z6', 'date': '2026-10-12', 'recipient': 'Бюро перекладів', 'content': 'переклад договору', 'amount': 3000, 'acc': 68, 'action': 'так', 'status': '', 'id': 0},
]


def reg_reset():
    """«Довідник», як у живому реєстрі (оновлено 02.10.2026): рахунки до ID 88, старі назви."""
    REG['accounts'] = {a['id']: f"{a['name']} [{a['id']}]" for a in REG['old'] if a['id'] <= 88 and not REG_INACTIVE.search(a['name'])}


CLOSED = set()     # закриті місяці «РРРР-ММ» (оновлення CRM 29.10.2026): записи з таким періодом не створюються й не змінюються
FULL_EDIT = True   # чи є в ролі «Повне редагування операцій Cash Flow»: без нього CRM не дає змінити запис (тут — будь-яке поле)
CLOSED_MSG = 'Місяць закрито. Внесіть операцію в новий відкритий період'
DRAFTS = {}        # чернетки CRM: id → {id, status 'draft', user_id, created_at, updated_at, data {поля форми рядками, як надіслано}, files, history}
SEQ = {'last': 0}  # ID записів і чернеток — одна послідовність; ID видаленої чернетки вдруге не видається
NOT_FOUND = {'message': 'Запис не знайдено'}


def next_id():
    SEQ['last'] = max([SEQ['last'], *DB, *DRAFTS]) + 1
    return SEQ['last']


def drafts_reset():
    DRAFTS.clear()
    SEQ['last'] = 0


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def closed(self):  # як справжній CRM: 422 з помилкою поля period
        return self.send(422, {'message': CLOSED_MSG, 'errors': {'period': [CLOSED_MSG]}})

    def send(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def auth(self):
        return (self.headers.get('Authorization') or '').startswith('Bearer mock-token-')

    def form(self):
        """Поля FormData (multipart) — UTF-8 без charset у заголовку частини (так шле браузер)."""
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        if (self.headers.get('Content-Type') or '').split(';')[0].strip().lower() == 'application/json':
            # чернетка від лінтера (з 16.11.2026) — JSON з числами, як їх зберігає сам CRM; типи лишаються як надіслано
            try:
                j = json.loads(body.decode('utf-8') or '{}')
            except ValueError:
                j = {}
            return j if isinstance(j, dict) else {}
        head = b'Content-Type: ' + self.headers.get('Content-Type', '').encode() + bytes([13, 10, 13, 10])
        msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(head + body)
        return {p.get_param('name', header='content-disposition'): p.get_payload(decode=True).decode('utf-8').strip() for p in msg.iter_parts()} if msg.is_multipart() else {}

    def create(self, f, rid=None):
        """Новий запис з полів форми (POST /api/invoice-payment і перетворення чернетки): (статус, відповідь). rid — ID чернетки."""
        dd, mm, yy = (f.get('date') or '00-00-0000')[:10].split('-')
        per = (f.get('period') or '')[3:10].split('-')  # '01-ММ-РРРР'
        if len(per) == 2 and f'{per[1]}-{per[0]}' in CLOSED:
            return 422, {'message': CLOSED_MSG, 'errors': {'period': [CLOSED_MSG]}}  # як справжній CRM: помилка поля period
        if f.get('operation') == '3' and f.get('invoice_from') and f.get('invoice_to'):
            make = lambda i: xfer(i, f'{yy}-{mm}-{dd}', int(f['invoice_from']), int(f['invoice_to']), float(f['amount']), f.get('comment', ''), int(f.get('project_id') or 1))
        elif f.get('operation') in ('1', '2') and f.get('invoice_id') and f.get('pnl_category_id') and f.get('pnl_operation_id') and f.get('currency_id'):
            # витрата / надходження, як «Внести» в реєстрі: статті з маркетологом без marketer_id CRM не приймає. Зарплатні статті — приймає
            # (реєстр погоджень так вносить ЗП і «% менеджерів»), але потім не дає їх змінити (PUT нижче — 422)
            if (int(f['pnl_category_id']), int(f['pnl_operation_id'])) in {(20, 30), (20, 40), (20, 41), (23, 42)} and not f.get('marketer_id'):
                return 422, {'message': 'marketer_id обов’язковий (мок)'}
            make = lambda i: rec(i, f'{yy}-{mm}-{dd}', int(f['invoice_id']), int(f['operation']), int(f['pnl_category_id']), int(f['pnl_operation_id']), float(f['amount']),
                                 f.get('comment', ''), int(f.get('project_id') or 1), mk=int(f['marketer_id']) if f.get('marketer_id') else None)
        else:
            return 422, {'message': 'мок: очікується переказ (operation=3, invoice_from, invoice_to) або запис (operation 1/2, invoice_id, стаття, currency_id)', 'got': f}
        rid = rid or next_id()
        DB[rid] = make(rid)
        return 200, {'data': self.with_invoice(DB[rid])}

    @staticmethod
    def draft(d, full=False):  # у списку — без history, як у живому CRM
        return json.loads(json.dumps(d if full else {k: v for k, v in d.items() if k != 'history'}))

    @staticmethod
    def account(a):
        bal = sum(SIGN.get(p['operation'], 0) * p['amount'] for r in DB.values() if not r['deleted_at'] for p in r['payments'] if p['invoice_id'] == a['id'] and not p['deleted_at'])
        return {**a, 'balance': round(bal + BALANCE_OFFSET.get(a['id'], 0), 2)}

    def with_invoice(self, r):
        c = json.loads(json.dumps(r))
        c.pop('kyiv', None)
        for p in c['payments']:
            a = next((x for x in REF['accounts'] if x['id'] == p['invoice_id']), None)
            p['invoice'] = a
        return c

    def helper(self, method):
        """Імітація «Помічника кешфлоу» для вкладки «Звірка з банком» (у справжньому — http://127.0.0.1:8765/api/panel/bank/…)."""
        u = urllib.parse.urlsplit(self.path)
        p, q = u.path.removeprefix('/helper'), urllib.parse.parse_qs(u.query)
        if HJOB['running'] and datetime.now().timestamp() >= HJOB['until']:
            d_from, d_to = HJOB['args']
            name = f"виписка_ВСІ_{'.'.join(reversed(d_from.split('-')))}_{'.'.join(reversed(d_to.split('-')))}.json"
            HFILES[name] = bank_for_period(d_from, d_to)
            HJOB.update(running=False, code=0, file=name, log=HJOB['log'] + ['Готово: ' + name])
        if method == 'POST' and p == '/api/panel/files/save':  # резервні копії й журнали панелі — у «папку Помічника» (тут — у пам'ять)
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
            name, kind = str(body.get('name') or ''), body.get('kind') or 'journals'
            if not re.fullmatch(r'кешфлоу_[^\\/:*?"<>|]{1,140}\.(json|xlsx)', name) or kind not in ('backups', 'journals'):
                return self.send(400, {'error': 'неприпустима назва файлу'})
            SAVED[name] = len(body.get('base64') or '')
            return self.send(200, {'ok': True, 'path': f'(тест)\\{kind}\\{name}', 'dir': f'(тест)\\{kind}', 'name': name, 'kind': kind})
        if method == 'POST' and p == '/api/panel/ai/hints':  # «Підказки ШІ» (у справжньому — app/helper_ai.py через helper.py)
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
            return self.send(*AI.hints_request(body)) if AI else self.send(200, AI_NOKEY)
        if method == 'POST' and p == '/api/panel/ai/match':  # «Зіставлення ШІ» у «Звірці з банком»
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
            return self.send(*AI.match_request(body)) if AI else self.send(200, {**AI_NOKEY, 'matches': []})
        if method == 'POST' and p == '/api/panel/bank/fetch':
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
            if HJOB['running']:
                return self.send(409, {'error': 'вивантаження вже триває'})
            if not body.get('from') or not body.get('to') or body['from'] > body['to']:
                return self.send(400, {'error': 'перевірте період'})
            HJOB.update(running=True, code=None, file=None, args=[body['from'], body['to']], until=datetime.now().timestamp() + 2,
                        log=[f"Період {body['from']} – {body['to']} (тест)", '== ПРИКЛАД', '  Приват: …', '== ФОП Хоменко', '  Моно: …'])
            return self.send(200, {'ok': True})
        if p == '/dist/cashflow_linter.js' and STATIC and (STATIC / 'cashflow_linter.js').is_file():
            body = (STATIC / 'cashflow_linter.js').read_bytes()  # підписаний тестовим ключем (make_e2e.js)
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if p == '/api/panel/bank/status':
            return self.send(200, {'ok': True, 'app': 'cashflow-helper', 'bank': {'dir': '(тест)', 'script': True, 'tokens': True, 'clients': ['ПРИКЛАД', 'ФОП Хоменко']}, 'job': HJOB})
        if p == '/api/panel/bank/job':
            return self.send(200, HJOB)
        if p == '/api/panel/bank/files':
            return self.send(200, {'files': [{'name': n, 'size': 1, 'mtime': '2026-10-25T09:00', 'all': True} for n in HFILES]})
        if p == '/api/panel/bank/file':
            name = (q.get('name') or [''])[0]
            return self.send(200, HFILES[name]) if name in HFILES else self.send(404, {'error': 'файл не знайдено'})
        return self.send(404, {'error': 'невідомий запит'})

    def registry(self, method):
        """Імітація Apps Script реєстру: POST edit / results / ref; GET /registry/reset — «Довідник» знову застарілий, /registry/calls — що надсилала панель."""
        if method == 'GET':
            if self.path.startswith('/registry/reset'):
                reg_reset()
                REG['calls'].clear()
                drafts_reset()  # тест починає без чернеток CRM
                return self.send(200, {'ok': True, 'accounts': len(REG['accounts'])})
            if self.path.startswith('/registry/calls'):
                return self.send(200, {'calls': REG['calls'], 'accounts': REG['accounts']})
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if (q.get('action') or [''])[0] == 'bank':  # рядки «Реєстру» за датою оплати (як bankData_ в Apps Script)
                f, t = (q.get('from') or [''])[0], (q.get('to') or [''])[0]
                rows = [r for r in REG_BANK_ROWS + REG.get('extra', []) if f <= r['date'] <= t]
                return self.send(200, {'ok': True, 'version': '1.8 (15.10.2026)', 'rows': rows, 'startDate': '2026-10-01', 'map': [], 'ownCodes': [], 'dupDays': 3})
            return self.send(200, {'ok': False, 'error': 'Невідома дія'})
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        act = body.get('action')
        REG['calls'].append({'action': act, **{k: (len(v) if k == 'accounts' else v) for k, v in body.items() if k not in ('key', 'action')}})
        labels = set(REG['accounts'].values())
        label = lambda tid, name: REG['accounts'].get(tid) or f"{name or 'рахунок'} [{tid}]"
        if act == 'edit':
            f = body.get('fields') or {}
            if f.get('invoice_id') and int(f['invoice_id']) not in REG['accounts']:
                return self.send(200, {'ok': False, 'error': f"рахунку {f['invoice_id']} немає в довіднику реєстру — натисніть «Оновити довідник у реєстрі»"})
            if f.get('transfer_to') and label(int(f['transfer_to']), f.get('transfer_name')) not in labels:
                return self.send(200, {'ok': False, 'error': REG_BAD})
            return self.send(200, {'ok': True, 'changed': list(f)})
        if act == 'results':
            for r in body.get('results') or []:
                if r.get('transfer_to') and label(int(r['transfer_to']), r.get('transfer_name')) not in labels:
                    return self.send(200, {'ok': False, 'error': REG_BAD})
            return self.send(200, {'ok': True, 'updated': len(body.get('results') or []), 'missing': []})
        if act == 'test_bank_rows':  # лише для тестів: додаткові рядки «Реєстру» для дії bank (рядки «Потрібна правка в реєстрі»)
            REG['extra'] = body.get('rows') or []
            return self.send(200, {'ok': True, 'rows': len(REG['extra'])})
        if act == 'ref':
            acc = [a for a in body.get('accounts') or [] if a and a[0] and not REG_INACTIVE.search(str(a[1]))]
            REG['accounts'] = {int(a[0]): f"{str(a[1]).strip()} [{int(a[0])}]" for a in acc}
            return self.send(200, {'ok': True, 'accounts': len(acc), 'pnl': 34, 'marketers': len(body.get('marketers') or [])})
        return self.send(200, {'ok': False, 'error': 'Невідома дія'})

    def do_POST(self):
        if self.path.startswith('/helper/'):
            return self.helper('POST')
        if self.path.startswith('/registry/'):
            return self.registry('POST')
        path = urllib.parse.urlsplit(self.path).path
        if path == '/api/invoice-payment':
            if not self.auth():
                return self.send(401, {'message': 'Unauthenticated.'})
            f = self.form()
            status, out = self.create(f)
            if status == 200:
                print(f"POST invoice-payment → {out['data']['id']} {f}", flush=True)
            return self.send(status, out)
        if path == '/api/invoice-payment-drafts':  # чернетка: поля — рядками, як надіслано; ID — з тієї самої послідовності, що й записи
            if not self.auth():
                return self.send(401, {'message': 'Unauthenticated.'})
            f = self.form()
            rid, now = next_id(), datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000000Z')
            DRAFTS[rid] = {'id': rid, 'status': 'draft', 'user_id': 1, 'created_at': now, 'updated_at': now, 'data': f, 'files': [],
                           'history': [{'id': rid * 10, 'draft_id': rid, 'user_id': 1, 'action': 'created', 'created_at': now}]}
            print(f'POST invoice-payment-drafts → {rid} {f}', flush=True)
            return self.send(201, self.draft(DRAFTS[rid], True))
        m = re.fullmatch(r'/api/invoice-payment-drafts/(\d+)/convert', path)
        if m:  # чернетка → запис: той самий шлях і ті самі перевірки, що й POST /api/invoice-payment; ID лишається
            if not self.auth():
                return self.send(401, {'message': 'Unauthenticated.'})
            self.rfile.read(int(self.headers.get('Content-Length') or 0))
            rid = int(m.group(1))
            if rid not in DRAFTS:
                return self.send(404, NOT_FOUND)
            status, out = self.create({k: v if isinstance(v, str) else str(v) for k, v in DRAFTS[rid]['data'].items() if v is not None}, rid)
            if status == 200:
                del DRAFTS[rid]
                print(f'POST invoice-payment-drafts/{rid}/convert → запис {rid}', flush=True)
            return self.send(status, out)
        return self.send(404, {'message': 'not found'})

    def do_GET(self):
        if self.path.startswith('/helper/'):
            return self.helper('GET')
        if self.path.startswith('/registry/'):
            return self.registry('GET')
        if STATIC and self.path.startswith('/e2e/'):  # тестова сторінка закладки (без авторизації, як звичайна сторінка сайту)
            f = (STATIC / urllib.parse.unquote(urllib.parse.urlsplit(self.path).path[5:])).resolve()
            if f.parent != STATIC.resolve() or not f.is_file():
                return self.send(404, {'message': 'not found'})
            body = f.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8' if f.suffix == '.html' else 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if not self.auth():
            return self.send(401, {'message': 'Unauthenticated.'})
        u = urllib.parse.urlsplit(self.path)
        p, q = u.path.removeprefix('/api/'), urllib.parse.parse_qs(u.query)
        if p == 'currency':
            return self.send(200, REF['currencies'])
        m = re.fullmatch(r'user/(\d+)', p)
        if m:  # профіль: права як у CRM — permissions.invoice (з 29.10.2026 є operation_full_edit)
            inv = {'read': 1, 'edit': 1, 'operation_read': 1, 'operation_edit': 1, **({'operation_full_edit': 1} if FULL_EDIT else {})}
            return self.send(200, {'id': int(m.group(1)), 'name': 'Тестова Бухгалтерка', 'role': {'id': 2, 'name': 'бухгалтер'}, 'permissions': {'invoice': inv},
                                   'jwt_token': 'не-має-потрапити-в-журнал'})
        if p in ('user', 'user/'):  # користувачі (реєстр бере звідси маркетологів): роль, чи працює
            return self.send(200, [{'id': 208, 'name': 'Тестова Маркетологиня', 'role': {'name': 'Маркетолог'}, 'is_working': True},
                                   {'id': 195, 'name': 'Євген Сливко', 'role': {'name': 'керівник відділу маркетингу'}, 'is_working': True},
                                   {'id': 410, 'name': 'СЛИВКО ПАРТНЕРИ | TRAFFZONE', 'role': {'name': 'маркетолог'}, 'is_working': True},
                                   {'id': 1249, 'name': 'Тестовий Таргетолог', 'role': {'name': 'Таргет'}, 'is_working': True},
                                   {'id': MK_CARD, 'name': 'Дмитро Миколаївський', 'role': {'name': 'Маркетолог'}, 'is_working': True},
                                   {'id': 1335, 'name': 'Ларіоненко Тимур', 'role': {'name': 'Маркетолог'}, 'is_working': True},
                                   {'id': 301, 'name': 'Колишній Маркетолог', 'role': {'name': 'Маркетолог'}, 'is_working': False},
                                   {'id': 5, 'name': 'Тестова Бухгалтерка', 'role': {'name': 'Бухгалтер'}, 'is_working': True}])
        if p == 'invoice':
            if 'page' not in q:  # get_all=1 — короткий список без залишків, як у CRM
                return self.send(200, [{k: a[k] for k in ('id', 'name', 'currency_id')} for a in REF['accounts']])
            per, page = int(q.get('per_page', ['20'])[0]), int(q['page'][0])
            accs = [self.account(a) for a in REF['accounts']]
            return self.send(200, {'current_page': page, 'data': accs[(page - 1) * per: page * per], 'last_page': max(1, -(-len(accs) // per)), 'per_page': per, 'total': len(accs)})
        m = re.fullmatch(r'invoice/(\d+)', p)
        if m:
            a = next((x for x in REF['accounts'] if x['id'] == int(m.group(1))), None)
            return self.send(200, self.account(a)) if a else self.send(404, {'message': 'not found'})
        if p == 'pnl/category':
            return self.send(200, REF['cats'])
        if p == 'pnl/operation/':
            return self.send(200, REF['ops'])
        if p == 'pnl/operation-config':
            return self.send(200, {'salary': {'category_id': 21}, 'marketer_add_balance': [{'category_id': 20, 'operations': [40, 41, 30]}, {'category_id': 23, 'operations': [42]}]})
        if p == 'pnl/category/21':
            return self.send(200, {'id': 21, 'operations': [{'id': i} for i in sorted(SALARY_OPS)]})
        if p == 'invoice-payment':
            iso = lambda s: '-'.join(reversed(s.split('-')))
            d1, d2 = iso(q['date_from'][0]), iso(q['date_to'][0])
            inv = {int(x) for x in q.get('invoice_ids[]', [])}
            a1, a2 = float(q.get('amount_from', ['-1e18'])[0]), float(q.get('amount_to', ['1e18'])[0])
            per, page = int(q.get('per_page', ['15'])[0]), int(q.get('page', ['1'])[0])
            rows = [r for r in sorted(DB.values(), key=lambda r: -r['id']) if d1 <= r['kyiv'] <= d2 and (not inv or any(x['invoice_id'] in inv for x in r['payments']))
                    and any(a1 - 0.005 <= x['amount'] <= a2 + 0.005 for x in r['payments'])]
            last = max(1, -(-len(rows) // per))
            # як у живому CRM: у списку маркетолога запису немає (marketer_balance_history — лише в GET invoice-payment/ID)
            data = [{k: v for k, v in self.with_invoice(r).items() if k != 'marketer_balance_history'} for r in rows[(page - 1) * per: page * per]]
            return self.send(200, {'current_page': page, 'data': data, 'last_page': last, 'per_page': per, 'total': len(rows)})
        m = re.fullmatch(r'invoice-payment/(\d+)', p)
        if m and int(m.group(1)) in DB:
            c = self.with_invoice(DB[int(m.group(1))])
            for x in c['payments']:
                x.pop('invoice', None)
            return self.send(200, c)
        if m:  # зокрема ID чернетки: серед записів її немає
            return self.send(404, NOT_FOUND)
        if p == 'invoice-payment-drafts':  # усі чернетки, новіші — першими; фільтрів немає (date_from, amount_from, invoice_ids[] ігноруються)
            num = lambda k, d: int(q[k][0]) if k in q and re.fullmatch(r'\d+', q[k][0]) else d
            per, page = num('per_page', 15), max(1, num('page', 1))
            if not 1 <= per <= 100:
                msg = 'The per page field must not be greater than 100.' if per > 100 else 'The per page field must be at least 1.'
                return self.send(422, {'message': 'Validation error', 'errors': {'per_page': [msg]}})
            rows = [self.draft(DRAFTS[i]) for i in sorted(DRAFTS, reverse=True)]
            return self.send(200, {'current_page': page, 'data': rows[(page - 1) * per: page * per], 'last_page': max(1, -(-len(rows) // per)), 'per_page': per, 'total': len(rows)})
        m = re.fullmatch(r'invoice-payment-drafts/(\d+)', p)
        if m:
            d = DRAFTS.get(int(m.group(1)))
            return self.send(200, self.draft(d, True)) if d else self.send(404, NOT_FOUND)
        return self.send(404, {'message': 'not found'})

    def do_DELETE(self):
        if not self.auth():
            return self.send(401, {'message': 'Unauthenticated.'})
        m = re.fullmatch(r'/api/invoice-payment-drafts/(\d+)', urllib.parse.urlsplit(self.path).path)
        if not m:
            return self.send(404, {'message': 'not found'})
        rid = int(m.group(1))
        if rid not in DRAFTS:
            return self.send(404, NOT_FOUND)
        SEQ['last'] = max(SEQ['last'], rid)
        del DRAFTS[rid]
        print(f'DELETE invoice-payment-drafts/{rid}', flush=True)
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_PUT(self):
        if not self.auth():
            return self.send(401, {'message': 'Unauthenticated.'})
        m = re.fullmatch(r'/api/invoice-payment/(\d+)', urllib.parse.urlsplit(self.path).path)
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        if not m or int(m.group(1)) not in DB:
            return self.send(404, {'message': 'not found'})
        r = DB[int(m.group(1))]
        if not FULL_EDIT:
            return self.send(403, {'message': 'Недостатньо прав для виконання цієї дії'})
        if r['kyiv'][:7] in CLOSED:
            return self.closed()
        if any(x['pnl_operation_id'] in SALARY_OPS for x in r['payments']):
            return self.send(422, {'message': 'Операції по зарплаті не доступні для редагування'})
        if body.get('pnl_operation_id') not in (None, '') and int(body['pnl_operation_id']) in SALARY_OPS:
            return self.send(422, {'message': 'Операції по зарплаті не доступні для редагування'})
        op, p0 = str(body.get('operation') or ''), r['payments'][0]
        if op == '3' and body.get('invoice_from') and body.get('invoice_to'):  # зміна типу на переказ, як у формі редагування CRM
            r['payments'] = [{**p0, 'id': r['id'] * 10, 'invoice_id': int(body['invoice_from']), 'operation': 4, 'pnl_category_id': None, 'pnl_operation_id': None},
                             {**p0, 'id': r['id'] * 10 + 1, 'invoice_id': int(body['invoice_to']), 'operation': 3, 'pnl_category_id': None, 'pnl_operation_id': None}]
            r['marketer_balance_history'] = None
        elif op in ('1', '2') and body.get('invoice_id'):  # назад: витрата / дохід на одному рахунку
            r['payments'] = [{**p0, 'id': r['id'] * 10, 'invoice_id': int(body['invoice_id']), 'operation': int(op),
                              'pnl_category_id': int(body['pnl_category_id']) if body.get('pnl_category_id') else None,
                              'pnl_operation_id': int(body['pnl_operation_id']) if body.get('pnl_operation_id') else None}]
        else:
            for k in ('pnl_category_id', 'pnl_operation_id'):
                if body.get(k) not in (None, ''):
                    r['payments'][0][k] = int(body[k])
        if body.get('project_id') not in (None, ''):
            r['project_id'] = int(body['project_id'])
        r['is_edited'] = True
        print(f'PUT {r["id"]} {body}', flush=True)
        return self.send(200, self.with_invoice(r))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8899)
    ap.add_argument('--rows', default=str(ROOT / 'work' / 'sep_rows.json'))
    ap.add_argument('--static', help='папка з тестовою сторінкою закладки (test/e2e/make_e2e.js)')
    ap.add_argument('--bank', default=str(Path.home() / 'Documents' / 'Звірка Приват' / 'виписка_ВСІ_01.10.2026_22.10.2026.json'))
    ap.add_argument('--closed', default='', help='закриті місяці через кому, напр. 2026-09 (CRM не дає створювати й змінювати записи з таким періодом)')
    ap.add_argument('--no-full-edit', action='store_true', help='роль без права «Повне редагування операцій Cash Flow»')
    ap.add_argument('--accounts', help='рахунки CRM з іншими назвами: JSON [[id, назва, id валюти], …] (напр. назви від 30.10.2026)')
    ap.add_argument('--ai', action='store_true', help='«Підказки ШІ»: справжній app/helper_ai.py з підробним Claude (test/fake_anthropic.py)')
    a = ap.parse_args()
    if a.ai:
        setup_ai()
    CLOSED.update(x.strip() for x in a.closed.split(',') if x.strip())
    FULL_EDIT = not a.no_full_edit
    STATIC = Path(a.static) if a.static else None
    load(a.rows, a.bank)
    REG['old'] = [dict(x) for x in REF['accounts']]
    if a.accounts:
        named = {int(x[0]): (str(x[1]), int(x[2])) for x in json.loads(Path(a.accounts).read_text(encoding='utf-8'))}
        REF['accounts'] = [{'id': i, 'name': n, 'currency_id': c, 'deleted_at': None} for i, (n, c) in sorted(named.items())]
    reg_reset()
    ThreadingHTTPServer(('127.0.0.1', a.port), H).serve_forever()
