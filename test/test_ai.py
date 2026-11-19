"""Тести ШІ-підказок Помічника (app/helper_ai.py) з підробним клієнтом Claude (test/fake_anthropic.py) — без мережі.
Запуск (з кореня проєкту): python -m unittest discover -s test -p "test_*.py"
"""
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
sys.path.insert(0, str(ROOT / 'test'))
import fake_anthropic as fake  # noqa: E402
import helper  # noqa: E402
import helper_ai as ai  # noqa: E402

KEY = 'sk-ant-api03-test-' + 'x' * 40
ORIG_HOST = dict(ai.HOST)


def rec(k, cmt, art='59:55', label='Інші витрати', typ='expense', amount=-1200.5, acc='1 ГРН ПРИКЛАД Приват ТОВ', prj='Україна', same=None):
    return {'k': k, 'date': '2026-10-20', 'type': typ, 'amount': amount, 'ccy': 'UAH', 'acc': acc, 'cmt': cmt, 'art': art, 'art_label': label,
            'prj': prj, 'same': same or []}


def wait_idle(timeout=5):
    end = time.time() + timeout
    while (ai.WORK['running'] or ai.DRAFT_JOB['running'] or ai.QUEUE) and time.time() < end:
        time.sleep(0.02)


class AiBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = {}
        self.can_edit = False
        # auto_shared — явно «ні»: інакше в спільному прогоні тестів діяло б налаштування, яке підставив імпортований helper.py
        ai.setup(data=lambda: Path(self.tmp.name), dpapi=lambda b, protect: b[::-1], log=lambda m: None,
                 load_config=lambda: json.loads(json.dumps(self.cfg)), save_config=self._save, rules_path=lambda: ROOT / 'rules' / 'rules.json',
                 format_path=lambda: ROOT / 'rules' / 'ФОРМАТ_ПРАВИЛ.md', can_edit_rules=lambda: self.can_edit, auto_shared=lambda: False)
        ai.SHARED.update(path=None, at=0.0, pushed=0.0, files={})
        ai.CLIENT_FACTORY[0] = fake.make_client
        ai.ERROR_PAUSE = 0
        ai.QUEUE.clear(); ai.FAILED.clear(); ai.INFLIGHT.clear()
        ai.WORK.update(running=False, error='', auth=False)
        ai.DRAFT_JOB.update(running=False, error='', started=None)
        fake.CALLS.clear()
        fake.FAIL['next'] = None

    def tearDown(self):
        wait_idle()
        ai.CLIENT_FACTORY[0] = None
        ai.HOST.clear(); ai.HOST.update(ORIG_HOST)
        ai.MEM['dir'] = None
        self.tmp.cleanup()

    def _save(self, c):
        self.cfg = json.loads(json.dumps(c))

    def ask(self, recs, retry=False):
        st, out = ai.hints_request({'records': recs, 'retry': retry})
        self.assertEqual(st, 200)
        return out

    def streams(self):
        return [kw for what, kw in fake.CALLS if what == 'stream']


class CleanTest(AiBase):
    def test_hides_accounts_cards_phones_emails(self):
        s = ai.clean_text('Оплата на UA003223130000026001400895929 ФОП Іванов, картка 5168 7573 1234 5678, тел. +38 (067) 123-45-67, '
                          'pay@example.com, ІПН 1234567890; сума 1 500,00 грн за 12.10.2026; кр. 4246 **** **** 7365')
        self.assertIn('UA…5929 ФОП Іванов', s)
        self.assertIn('картка **** 5678', s)
        self.assertIn('[телефон]', s)
        self.assertIn('[e-mail]', s)
        self.assertIn('ІПН [номер]', s)
        self.assertIn('сума 1 500,00 грн за 12.10.2026', s)  # суми й дати лишаються
        self.assertIn('4246 **** **** 7365', s)                # уже замаскована картка — як є
        for secret in ('3223130000026007233566001', '5168 7573', '123-45-67', 'pay@firm', '1234567890'):
            self.assertNotIn(secret, s)

    def test_uppercase_words_are_not_iban(self):
        self.assertEqual(ai.clean_text('FB25 CAMPAIGN NEW YEAR'), 'FB25 CAMPAIGN NEW YEAR')

    def test_record_fields_checked(self):
        self.assertIsNone(ai.clean_record({'k': '5', 'type': 'expense'}))
        self.assertIsNone(ai.clean_record({'k': 5, 'type': 'transfer'}))
        r = ai.clean_record({**rec(7, 'x' * 900), 'art': '59:55; drop', 'same': [['Офіс', 3], ['bad'], 'x']})
        self.assertEqual(len(r['cmt']), ai.TEXT_MAX)
        self.assertEqual(r['art'], '')
        self.assertEqual(r['same'], [['Офіс', 3]])


class SharedTest(AiBase):
    def test_two_helpers_one_history(self):
        """Спільна папка «Кешфлоу ШІ» (06.11.2026): кешфлоу веде колега — його підказки, витрати й записи для перегляду бачить і ваш Помічник."""
        shared = Path(self.tmp.name) / 'G' / 'Мій диск' / 'Кешфлоу ШІ'
        other = shared / 'COLLEAGUE-PC-Kolega'
        other.mkdir(parents=True)
        self.assertEqual(ai.set_config({'shared': str(shared / 'немає')})[0], 400)
        self.assertEqual(ai.set_config({'shared': str(shared)})[0], 200)
        ai.set_key(KEY)
        r = rec(7, 'Оренда офісу за листопад')
        key = ai.rec_key(ai.clean_record(r))
        dump = lambda name, obj: (other / name).write_text(json.dumps(obj, ensure_ascii=False), encoding='utf-8')  # noqa: E731
        dump('hints.json', {key: {'a': '59:55', 'al': 'Інші витрати', 'p': '', 'c': 'висока', 'w': 'від колеги', 'm': ai.HINTS_MODEL, 't': ai.now_iso()}})
        dump('usage.json', {ai.month(): {'usd': 7.5, 'models': {}}})
        dump('seen.json', {'x1': {'k': 999, 'src': 'bank', 'date': '2026-11-04', 'type': 'expense', 'amount': 10, 'ccy': 'UAH', 'acc': 'Приват',
                                  'cmt': 'Нотаріус: довіреність', 'art': '', 'code': '', 'prj': '', 'key': 'x1', 't': ai.now_iso()}})
        out = self.ask([r])
        self.assertEqual(out['results'][7]['w'], 'від колеги')     # відповідь колеги — без нового запиту до Claude
        wait_idle()
        self.assertEqual(self.streams(), [])
        self.assertAlmostEqual(ai.spent(), 7.5)                     # витрати колеги — у спільному ліміті
        self.assertIn(999, [o['k'] for o in ai.observations()])     # тижневий перегляд бачить його записи
        st = ai.status()
        self.assertEqual(st['others_usd'], 7.5)
        self.assertEqual([o['who'] for o in st['shared']['others']], ['COLLEAGUE-PC-Kolega'])
        mine = shared / ai.machine_id()
        self.assertTrue((mine / 'seen.json').is_file())              # своє — у своїй підпапці (свого колега не перезапише)
        self.assertNotIn('sk-ant', ''.join(p.read_text(encoding='utf-8') for p in mine.iterdir()))
        self.assertEqual(ai.set_config({'shared': 'off'})[0], 200)
        self.assertEqual(ai.spent(), 0.0)

    def test_tests_never_find_the_real_drive(self):
        """07.11.2026: тести (без своєї спільної папки) записали вигадані витрати в справжню «Кешфлоу ШІ» на Google Диску.
        Шукає її сам лише справжній Помічник (auto_shared); тут — ні, навіть якщо вона є."""
        real = Path(self.tmp.name) / 'G' / 'My Drive' / 'Кешфлоу ШІ'
        real.mkdir(parents=True)
        orig = ai.find_shared
        ai.find_shared = lambda: real
        try:
            ai.SHARED.update(path=None, at=0.0, pushed=0.0)
            self.assertIsNone(ai.shared_dir())
            ai.set_key(KEY)
            self.ask([rec(7, 'Оренда офісу за листопад')])
            wait_idle()
            self.assertEqual(list(real.iterdir()), [], 'нічого не записано в «справжню» папку')
            ai.setup(auto_shared=lambda: True)  # справжній Помічник
            ai.SHARED.update(path=None, at=0.0, pushed=0.0)
            self.assertEqual(ai.shared_dir(), real)
        finally:
            ai.find_shared = orig
            ai.SHARED.update(path=None, at=0.0, pushed=0.0)

    def test_drive_away_and_fresh_data_folder(self):
        """Google Диск від'єднався — чужі витрати за місяць беруться останні відомі; нова папка даних (перевстановлення) —
        свої витрати за місяць беруться з копії цього комп'ютера в спільній папці: ліміт не «обнуляється»."""
        shared = Path(self.tmp.name) / 'Кешфлоу ШІ'
        (shared / 'COLLEAGUE-PC-Kolega').mkdir(parents=True)
        (shared / ai.machine_id()).mkdir()
        (shared / 'COLLEAGUE-PC-Kolega' / 'usage.json').write_text(json.dumps({ai.month(): {'usd': 7.5}}), encoding='utf-8')
        (shared / ai.machine_id() / 'usage.json').write_text(json.dumps({ai.month(): {'usd': 5.0, 'models': {}}}), encoding='utf-8')
        self.assertEqual(ai.set_config({'shared': str(shared)})[0], 200)
        self.assertAlmostEqual(ai.spent(), 12.5)                     # 5 своїх (з копії — локального usage.json ще немає) + 7.5 колеги
        ai.set_key(KEY)
        self.ask([rec(7, 'Оренда офісу за листопад')])
        wait_idle()
        own = json.loads((Path(self.tmp.name) / 'ai' / 'usage.json').read_text(encoding='utf-8'))[ai.month()]['usd']
        self.assertGreater(own, 5.0)                                  # до 5 доларів з копії додано новий запит, а не почато з нуля
        (shared / 'COLLEAGUE-PC-Kolega' / 'usage.json').unlink()     # Диск «від'єднався»: файлу колеги не видно
        self.assertAlmostEqual(ai.spent(), own + 7.5)


class HintsTest(AiBase):
    def test_bank_operation_without_article(self):
        """«Внести в CRM» (05.11.2026): операція банку без статті — ключ 'b:'+хеш, src bank; у seen.json — для тижневого перегляду."""
        ai.set_key(KEY)
        b = {**rec('b:0123456789abcdef', 'ТОВ "СЕРВІС МАРКЕТ": Оплата за ліцензійне використання програмного продукту (роялті)',
                   art='', label='', typ='income', amount=1298533.06, prj='')}
        self.ask([b, rec('b:не-хеш', 'x'), rec('b:12', 'закороткий')])
        wait_idle()
        out = self.ask([b])
        self.assertIn('b:0123456789abcdef', out['results'])
        sent = json.loads(self.streams()[-1]['messages'][-1]['content'])['records']
        self.assertEqual([(x['src'], x['type']) for x in sent], [('bank', 'income')])
        seen = [o for o in ai.mem()['seen'].values() if o['k'] == 'b:0123456789abcdef']
        self.assertEqual([o['src'] for o in seen], ['bank'])
        self.assertEqual([x['src'] for x in ai.observations()], ['bank'])

    def test_no_key_nothing_sent(self):
        out = self.ask([rec(1, 'Оренда офісу за жовтень')])
        self.assertEqual(out['state'], 'nokey')
        self.assertEqual(out['pending'], 0)
        wait_idle()
        self.assertEqual(self.streams(), [])
        self.assertFalse((Path(self.tmp.name) / 'ai' / 'seen.json').exists())

    def test_hints_once_per_record(self):
        self.assertEqual(ai.set_key(KEY), (200, {'ok': True, 'error': ''}))
        self.assertTrue(self.cfg['ai']['on'])
        self.assertEqual([kw['model'] for what, kw in fake.CALLS if what == 'count_tokens'], [ai.HINTS_MODEL, ai.RULES_MODEL])
        recs = [rec(1, 'Оренда офісу за жовтень, Warszawa'), rec(2, 'Щось незрозуміле'), rec(3, 'Папір для принтера', art='57:52', label='Офіс')]
        out = self.ask(recs)
        self.assertEqual(out['state'], 'ready')
        self.assertEqual(out['pending'], 3)
        wait_idle()
        out = self.ask(recs)
        self.assertEqual(out['pending'], 0)
        self.assertEqual(out['results'][1], {'a': '57:52', 'p': 'Польща', 'c': 'висока', 'w': 'у коментарі — офіс'})
        self.assertEqual(out['results'][2]['a'], '59:55')  # «згоден» — поточна стаття
        self.assertEqual(out['results'][3]['a'], '57:52')
        self.assertEqual(len(self.streams()), 1)  # один запит на всі три
        self.ask(recs)
        wait_idle()
        self.assertEqual(len(self.streams()), 1)  # відомі записи вдруге в Claude не йдуть
        self.assertGreater(out['usage']['usd'], 0)
        # змінили коментар — це вже інший запис для ШІ
        self.ask([rec(2, 'Щось незрозуміле, уточнено')])
        wait_idle()
        self.assertEqual(len(self.streams()), 2)

    def test_request_shape(self):
        ai.set_key(KEY)
        self.ask([rec(1, 'Оплата на UA003223130000026001400895929, тел. 0671234567', same=[['Офіс', 2]])])
        wait_idle()
        kw = self.streams()[0]
        self.assertEqual(kw['model'], 'claude-sonnet-5-5')
        self.assertNotIn('temperature', kw)
        self.assertEqual(kw['messages'][-1]['role'], 'user')
        self.assertEqual(kw['system'][0]['cache_control'], {'type': 'ephemeral'})
        self.assertEqual(kw['output_config']['effort'], 'medium')
        fmt = kw['output_config']['format']
        self.assertEqual(fmt['type'], 'json_schema')
        item = fmt['schema']['properties']['items']['items']
        self.assertFalse(item['additionalProperties'])
        self.assertIn('57:52', item['properties']['article']['enum'])
        self.assertIn('?', item['properties']['article']['enum'])
        self.assertEqual(item['properties']['project']['enum'], ['Україна', 'Польща', 'Велика Британія', 'США', 'ОАЕ', '?'])
        self.assertIn('57:52 — Адміністративні витрати / Офіс — витрата', kw['system'][0]['text'])
        self.assertIn('Татоян → США', kw['system'][0]['text'])  # назви чинних правил — як компанія класифікує
        body = json.loads(kw['messages'][-1]['content'])['records'][0]
        self.assertEqual(body['cmt'], 'Оплата на UA…5929, тел. [телефон]')
        self.assertEqual(body['art'], '59:55 Інші витрати')
        self.assertEqual(body['same'], [['Офіс', 2]])
        self.assertNotIn('k', body)  # ID записів CRM у Claude не йдуть — лише номер у запиті

    def test_batches_of_forty(self):
        ai.set_key(KEY)
        self.ask([rec(i, f'Запис {i}') for i in range(1, 101)])
        wait_idle()
        self.assertEqual([len(json.loads(kw['messages'][-1]['content'])['records']) for kw in self.streams()], [40, 40, 20])

    def test_failure_then_retry(self):
        ai.set_key(KEY)
        fake.FAIL['next'] = fake.ApiError(529, 'Overloaded')
        recs = [rec(1, 'Оренда офісу')]
        self.ask(recs)
        wait_idle()
        out = self.ask(recs)
        self.assertEqual((out['pending'], out['failed']), (0, 1))
        self.assertIn('529', out['error'])
        self.assertEqual(len(self.streams()), 1)  # без «Ще раз» не повторюємо одразу
        out = self.ask(recs, retry=True)
        self.assertEqual(out['pending'], 1)
        wait_idle()
        out = self.ask(recs)
        self.assertEqual((out['failed'], out['results'][1]['a']), (0, '57:52'))

    def test_bad_key(self):
        st, out = ai.set_key('sk-ant-bad-' + 'y' * 30)
        self.assertEqual(st, 200)
        self.assertFalse(out['ok'])
        self.assertIn('ключ', out['error'])
        self.assertEqual(ai.state(), 'badkey')
        self.assertFalse(self.cfg['ai']['check']['ok'])
        self.assertEqual(ai.set_key('not-a-key')[0], 400)

    def test_monthly_limit(self):
        ai.set_key(KEY)
        self.assertEqual(ai.set_config({'limit': 0.0001})[0], 200)
        ai.add_usage(ai.HINTS_MODEL, type('U', (), {'input_tokens': 10000, 'output_tokens': 1000})())
        out = self.ask([rec(1, 'Оренда офісу')])
        self.assertEqual(out['state'], 'limit')
        wait_idle()
        self.assertEqual(self.streams(), [])
        self.assertEqual(ai.set_config({'limit': 5000})[0], 400)

    def test_usage_cost(self):
        usd = ai.add_usage(ai.HINTS_MODEL, type('U', (), {'input_tokens': 2_000_000, 'output_tokens': 1_000_000, 'cache_read_input_tokens': 1_000_000})())
        self.assertAlmostEqual(usd, 4.0 + 10.0 + 0.2)             # Sonnet 5.5: $2 / $10, читання з кешу $0,20
        usd = ai.add_usage(ai.RULES_MODEL, type('U', (), {'input_tokens': 1_000_000, 'output_tokens': 100_000})())
        self.assertAlmostEqual(usd, 4.0 + 2.0)                    # Opus 5.5: $4 / $20
        st = ai.status()
        self.assertAlmostEqual(st['usage']['usd'], 20.2)
        self.assertEqual(st['usage']['models'][ai.HINTS_MODEL]['n'], 1)

    def test_even_spending(self):
        """Ліміт — рівномірно на місяць (05.11.2026): 7-го з $100 — до $33,33; старе збережене «10» — не вибір людини."""
        from datetime import datetime as dt
        self.assertEqual(ai.limit_usd(), 100.0)
        ai.set_cfg(limit=10.0)                                    # збережене до 05.11.2026 значення за замовчуванням
        self.assertEqual(ai.limit_usd(), 100.0)
        self.assertEqual(ai.set_config({'limit': 10})[0], 200)    # а вписане людиною — її вибір
        self.assertEqual(ai.limit_usd(), 10.0)
        ai.set_config({'limit': 100})
        self.assertEqual((ai.pace_cap(dt(2026, 11, 7)), ai.pace_cap(dt(2026, 11, 30)), ai.pace_cap(dt(2026, 2, 1))), (33.33, 100.0, 13.57))
        ai.set_key(KEY)
        self.can_edit = True
        real = ai.pace_cap
        ai.pace_cap = lambda now=None: 5.0
        try:
            ai.add_usage(ai.RULES_MODEL, type('U', (), {'input_tokens': 0, 'output_tokens': 300_000})())  # $6 — більше за частку на сьогодні
            out = self.ask([rec(1, 'Оренда офісу')])
            self.assertEqual(out['state'], 'pace')
            wait_idle()
            self.assertEqual(self.streams(), [])
            self.assertFalse(ai.maybe_draft())
            self.assertEqual(ai.status()['state'], 'pace')
        finally:
            ai.pace_cap = real

    def test_off_and_forget(self):
        ai.set_key(KEY)
        ai.set_config({'on': False})
        self.assertEqual(self.ask([rec(1, 'Оренда')])['state'], 'off')
        ai.forget_key()
        self.assertEqual(ai.state(), 'nokey')
        self.assertFalse((Path(self.tmp.name) / 'anthropic_key.dat').exists())

    def test_key_encrypted_on_disk_and_not_in_status(self):
        ai.set_key(KEY)
        raw = (Path(self.tmp.name) / 'anthropic_key.dat').read_bytes()
        self.assertNotIn(KEY.encode(), raw)
        self.assertNotIn(KEY, json.dumps(ai.status(), ensure_ascii=False))
        ai.MEM['dir'] = None  # «перезапуск»: ключ — з диска
        self.assertEqual(ai.load_key(), KEY)


class DraftTest(AiBase):
    def fill(self, n_hetzner=4):
        ai.set_key(KEY)
        recs = [rec(i, f'Hetzner сервери, рахунок {i}', art='65:69', label='Інші витрати') for i in range(1, n_hetzner + 1)]
        recs += [rec(100 + i, f'Канцтовари {i}') for i in range(8)]
        self.ask(recs)
        wait_idle()

    def test_draft_rules(self):
        self.fill()
        self.can_edit = True
        self.assertEqual(ai.start_draft()[0], 200)
        wait_idle()
        d = ai.drafts()
        self.assertEqual(d['job']['error'], '')
        self.assertEqual(d['n_obs'], 12)
        self.assertEqual(len(d['rules']), 3)
        r = d['rules'][0]
        self.assertEqual(r['rule']['id'], 'R-AI-HETZNER-01')
        self.assertTrue(r['rule']['source'].startswith('ШІ (Claude Opus 5.5)'))
        self.assertEqual(r['replaces'], '')
        self.assertIsNone(d['rules'][1]['rule'])
        self.assertIn('не розібрано', d['rules'][1]['error'])
        # зміна чинного правила: той самий id, у чернетці — і як було
        w = d['rules'][2]
        self.assertEqual((w['replaces'], w['rule']['id'], w['old']['id']), ('R-INFRA-01', 'R-INFRA-01', 'R-INFRA-01'))
        self.assertIn('зміна правила', w['rule']['source'])
        kw = self.streams()[-1]
        self.assertEqual((kw['model'], kw['output_config']['effort']), ('claude-opus-5-5', 'high'))
        self.assertIn('"R-INFRA-01"', kw['system'])            # чинні правила — у запиті
        self.assertIn('## Умови', kw['system'])                # і їхній формат
        sent = json.loads(kw['messages'][-1]['content'])['records']
        het = [x for x in sent if x['cmt'].startswith('Hetzner')]
        # номери в запиті, а не ID записів CRM; першими — записи, де щоденний ШІ запропонував іншу статтю, ніж у CRM
        self.assertEqual([x['n'] for x in het], [1, 2, 3, 4])
        self.assertTrue(all('ai_miss' in x.get('flags', []) and x['src'] == 'crm' for x in het))
        self.assertEqual(r['examples'], [4, 3, 2, 1])
        self.assertTrue(all('k' not in x for x in sent))
        self.assertEqual(het[-1]['ai']['art'], 'Продукт і розробка / Інфраструктура')  # підказка щоденного ШІ поруч із записом
        self.assertEqual(het[-1]['art'], 'Інші витрати')
        self.assertEqual(ai.mark_draft(0, 'added'), (200, {'ok': True}))
        self.assertEqual(ai.drafts()['rules'][0]['status'], 'added')
        self.assertEqual(ai.mark_draft(5, 'added')[0], 404)
        # сторінка бачила іншу чернетку (тижнева склалася заново) чи інше правило під тим самим номером — 409, нічого не позначено
        self.assertEqual(ai.mark_draft(0, 'rejected', '2000-01-01T00:00:00', r['rule']['id'])[0], 409)
        self.assertEqual(ai.mark_draft(0, 'rejected', d['at'], 'R-AI-ІНШЕ-01')[0], 409)
        self.assertEqual(ai.drafts()['rules'][0]['status'], 'added')
        self.assertEqual(ai.mark_draft(0, 'rejected', d['at'], r['rule']['id'])[0], 200)

    def test_failed_auto_draft_waits_a_day(self):
        """Тижнева чернетка не вдалася (обрізано, відмова, мережа) — сама не повторюється кожні 6 год, а лише через добу; кнопкою — можна."""
        self.fill(n_hetzner=4)
        self.can_edit = True
        fake.FAIL['next'] = fake.ApiError(529, 'Overloaded')
        self.assertTrue(ai.maybe_draft())
        wait_idle()
        self.assertTrue(ai.drafts()['job']['error'])
        n = len(self.streams())
        self.assertFalse(ai.maybe_draft())
        self.assertEqual(len(self.streams()), n)
        self.assertEqual(ai.start_draft()[0], 200)
        wait_idle()
        self.assertEqual(len(ai.drafts()['rules']), 3)

    def test_draft_needs_rules_owner(self):
        self.fill()
        self.assertEqual(ai.start_draft()[0], 403)
        self.assertFalse(ai.maybe_draft())

    def test_weekly_schedule(self):
        self.fill(n_hetzner=4)  # 12 нових записів без правил
        self.can_edit = True
        self.assertTrue(ai.maybe_draft())
        wait_idle()
        self.assertFalse(ai.maybe_draft())  # тиждень ще не минув
        st = ai.status()['drafts']
        self.assertEqual((st['n'], st['new_obs']), (3, 0))  # нове правило, нерозібране й зміна чинного (fake_anthropic)
        self.assertIsNotNone(st['next'])

    def test_rule_ids_unique(self):
        taken = {'R-AI-X-01'}
        self.assertEqual(ai.rule_id('r-ai-x-01', taken), 'R-AI-X-01-2')
        self.assertEqual(ai.rule_id('R-HOSTING-01', taken), 'R-AI-HOSTING-01')
        self.assertEqual(ai.rule_id('сміття', taken), 'R-AI-RULE-01')


class MatchTest(AiBase):
    """«Зіставлення ШІ» у «Звірці з банком»: залишок (операції банку без погодження ↔ погодження) — у щоденну модель лише на кнопку."""
    BANK = [{'id': '33|2026-11-05|14:25|-1000000|R1', 'date': '2026-11-05', 'amount': 10000, 'acc': 'Приват ТОВ ПРИКЛАД СЕРВІС 5608',
             'cpty': 'БАЛУХ АНДРІЙ', 'text': 'Переказ на UA003223130000026001400895929 за жовтень', 'kind': 'exp'},
            {'id': '33|2026-11-05|14:26|-22010700|R2', 'date': '2026-11-05', 'amount': 220107, 'acc': 'Приват ТОВ ПРИКЛАД СЕРВІС 5608',
             'cpty': 'Ціл-ві зарах.ТОВ ПРИКЛАД СЕРВІС', 'text': 'Заробітна плата за жовтень 2026', 'kind': 'pay', 'cards': 4}]
    APS = [{'key': '05.11.2026#h1', 'date': '2026-11-05', 'amount': 10000, 'acc': 'Приват ТОВ ПРИКЛАД СЕРВІС 5608', 'recipient': 'Андрій Балух',
            'text': 'ЗП за жовтень', 'entered': False},
           {'key': '05.11.2026#h2', 'date': '2026-11-05', 'amount': 5000, 'acc': 'Приват ТОВ ПРИКЛАД СЕРВІС 5608', 'recipient': 'Хтось Інший', 'text': 'бонус', 'entered': True}]

    def test_no_key_nothing_sent(self):
        st, out = ai.match_request({'bank': self.BANK, 'approvals': self.APS})
        self.assertEqual((st, out['state'], out['matches']), (200, 'nokey', []))
        self.assertEqual(self.streams(), [])

    def test_match_once_ids_hidden(self):
        ai.set_key(KEY)
        st, out = ai.match_request({'bank': self.BANK, 'approvals': self.APS})
        self.assertEqual((st, out['ok'], out['state']), (200, True, 'ready'))
        self.assertEqual(out['matches'], [{'bank': self.BANK[0]['id'], 'approvals': ['05.11.2026#h1'], 'confidence': 'середня', 'why': "Андрій Балух: ім'я в операції банку"}])
        kw = self.streams()[0]
        self.assertEqual(kw['model'], ai.HINTS_MODEL)
        sent = kw['messages'][-1]['content']
        for secret in ('05.11.2026#h1', '33|2026-11-05', '3223130000026007233566001'):
            self.assertNotIn(secret, sent)  # ключі й ідентифікатори — b1/a1, номер рахунку прихований
        props = kw['output_config']['format']['schema']['properties']['matches']['items']['properties']
        self.assertEqual((props['bank']['enum'], props['approvals']['items']['enum']), (['b1', 'b2'], ['a1', 'a2']))
        self.assertEqual(json.loads(sent)['bank'][1]['cards'], 4)
        # той самий набір — збережена відповідь, без нового запиту
        st, again = ai.match_request({'bank': self.BANK, 'approvals': self.APS})
        self.assertEqual((again['matches'], again.get('cached'), len(self.streams())), (out['matches'], True, 1))

    def test_nothing_to_match_and_bad_input(self):
        ai.set_key(KEY)
        self.assertEqual(ai.match_request({'bank': self.BANK, 'approvals': []})[1]['matches'], [])
        self.assertEqual(ai.match_request({'bank': [{'id': '', 'amount': 'x'}], 'approvals': self.APS})[1]['matches'], [])
        self.assertEqual(ai.match_request('не словник')[0], 400)
        self.assertEqual(self.streams(), [])


class HttpTest(AiBase):
    """Маршрути Помічника: панель на сторінці CRM — лише з Origin CRM; ключ — лише з вікна Помічника (ключ сесії)."""
    def setUp(self):
        super().setUp()
        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), helper.Handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]
        helper.STATE['port'] = self.port

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def req(self, method, path, body=None, headers=None):
        h = {'Host': f'127.0.0.1:{self.port}', **({'Content-Type': 'application/json'} if body is not None else {}), **(headers or {})}
        r = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, json.loads(resp.read()), dict(resp.headers)
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read() or b'{}'), dict(e.headers)

    def test_panel_route_only_from_crm(self):
        st, _, _ = self.req('POST', '/api/panel/ai/hints', {'records': []}, {'Origin': 'https://evil.example'})
        self.assertEqual(st, 403)
        st, _, _ = self.req('POST', '/api/panel/ai/match', {'bank': [], 'approvals': []}, {'Origin': 'https://evil.example'})
        self.assertEqual(st, 403)
        st, j, _ = self.req('POST', '/api/panel/ai/match', {'bank': MatchTest.BANK, 'approvals': MatchTest.APS}, {'Origin': helper.CRM_ORIGIN})
        self.assertEqual((st, j['state'], j['matches']), (200, 'nokey', []))
        st, j, h = self.req('POST', '/api/panel/ai/hints', {'records': [rec(1, 'Оренда')]}, {'Origin': helper.CRM_ORIGIN})
        self.assertEqual((st, j['state']), (200, 'nokey'))
        self.assertEqual(h.get('Access-Control-Allow-Origin'), helper.CRM_ORIGIN)

    def test_key_only_with_session_key(self):
        st, _, _ = self.req('POST', '/api/ai/key', {'key': KEY}, {'Origin': helper.CRM_ORIGIN})
        self.assertEqual(st, 403)
        st, j, _ = self.req('POST', '/api/ai/key', {'key': KEY}, {'X-Helper-Key': helper.KEY})
        self.assertEqual((st, j['ok']), (200, True))
        st, j, _ = self.req('GET', '/api/ai/status', headers={'X-Helper-Key': helper.KEY})
        self.assertEqual((st, j['state'], j['key']), (200, 'ready', True))
        self.assertNotIn('sk-ant', json.dumps(j))
        st, j, _ = self.req('POST', '/api/panel/ai/hints', {'records': [rec(1, 'Оренда офісу')]}, {'Origin': helper.CRM_ORIGIN})
        self.assertEqual((st, j['pending']), (200, 1))
        wait_idle()
        st, j, _ = self.req('POST', '/api/panel/ai/hints', {'records': [rec(1, 'Оренда офісу')]}, {'Origin': helper.CRM_ORIGIN})
        self.assertEqual(j['results']['1']['a'], '57:52')

    def test_preflight_allows_crm(self):
        r = urllib.request.Request(f'http://127.0.0.1:{self.port}/api/panel/ai/hints', method='OPTIONS',
                                   headers={'Host': f'127.0.0.1:{self.port}', 'Origin': helper.CRM_ORIGIN, 'Access-Control-Request-Method': 'POST'})
        with urllib.request.urlopen(r, timeout=10) as resp:
            self.assertEqual(resp.status, 204)
            self.assertIn('POST', resp.headers.get('Access-Control-Allow-Methods'))


if __name__ == '__main__':
    unittest.main()
