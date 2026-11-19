"""privat_fetch.py (06.11.2026): клієнти й банки вивантажуються одночасно, але з паузами, яких вимагають банки.
Імітація Привату й Моно без мережі (підробний requests); паузи скорочено, щоб тест ішов секунди."""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load():
    spec = importlib.util.spec_from_file_location('privat_fetch_t', ROOT / 'install' / 'bank' / 'privat_fetch.py')
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class R:
    def __init__(self, code, obj):
        self.status_code, self._o = code, obj

    def json(self):
        return self._o


class FakeBanks:
    """Приват: settings (перший раз для privat-fc — регламент), два залишки, транзакції двома сторінками. Моно: client-info, виписки."""
    def __init__(self, m):
        self.m, self.lock, self.inflight, self.max_inflight = m, threading.Lock(), 0, 0
        self.calls = []  # (банк, токен, функція, час)
        self.mono_statements = []  # id рахунків Моно, по яких просили виписку
        self.regl = {'privat-fc'}
        self.mono_accs = {'mono-fc': [('fc1', 980)], 'mono-fb': [('fb1', 980)], 'mono-fa': [('fa1', 980), ('fa2', 840)]}
        self.mono_names = {'mono-fc': 'Житинська Емілія Юріївна', 'mono-fb': 'Сидорук Інесса Артемівна', 'mono-fa': 'Хоменко Всеволод Сергійович'}

    def get(self, url, headers=None, params=None, timeout=None):
        now = time.time()
        if url.startswith(self.m.BASE):
            tok, path = headers['token'], url[len(self.m.BASE):]
            with self.lock:
                self.calls.append(('privat', tok, path, now))
                self.inflight += 1
                self.max_inflight = max(self.max_inflight, self.inflight)
            try:
                time.sleep(0.12)  # «мережа»
                acc = f'UA00{tok}'
                if path == 'statements/settings':
                    regl = tok in self.regl
                    self.regl.discard(tok)
                    return R(200, {'settings': {'work_balance': 'Y' if regl else 'N', 'date_final_statement': '05.11.2026 00:00:00'}})
                if path == 'statements/balance':
                    # 10 + дві операції по 1.00 = 12: виписка сходиться (07.11.2026 — інакше скрипт перепитує операції)
                    return R(200, {'balances': [{'acc': acc, 'currency': 'UAH', 'nameACC': tok, 'balanceIn': '10.00', 'balanceOut': '12.00'}], 'exist_next_page': False})
                if path == 'statements/transactions':
                    first = not params.get('followId')
                    t = {'AUT_MY_ACC': acc, 'SUM': '1.00', 'TRANTYPE': 'C', 'REF': f'{tok}-{"a" if first else "b"}'}
                    return R(200, {'transactions': [t], 'exist_next_page': first, 'next_page_id': 'p2'})
                return R(404, {'status': 'ERROR', 'message': path})
            finally:
                with self.lock:
                    self.inflight -= 1
        tok, path = headers['X-Token'], url[len(self.m.MONO):]
        fn = 'client-info' if path.startswith('/personal/client-info') else 'statement'
        with self.lock:
            self.calls.append(('mono', tok, fn, now))
            if fn == 'statement':
                self.mono_statements.append(path.split('/')[3])
        time.sleep(0.05)
        if fn == 'client-info':
            return R(200, {'name': self.mono_names[tok], 'accounts': [{'id': a, 'iban': f'UA{a}', 'currencyCode': c, 'type': 'fop', 'balance': 5000}
                                                                     for a, c in self.mono_accs[tok]]})
        return R(200, [])

    def starts(self, bank, tok, fn=None):
        return [t for b, k, f, t in self.calls if b == bank and k == tok and (fn is None or f == fn)]


TOKENS = {'ПРИКЛАД': 'privat-sv', 'Маркет': 'privat-mt', 'ФОП Житинська': {'privat': 'privat-fc', 'mono': 'mono-fc'},
          'ФОП Сидорук': {'mono': 'mono-fb'}, 'ФОП Хоменко': {'privat': 'privat-fa', 'mono': 'mono-fa'}}


def run(m, d, *args):
    """main() з аргументами командного рядка; → (код, журнал, тривалість, загальний файл)."""
    m.HERE, m.TOKENS = Path(d), Path(d) / 'privat_tokens.json'
    m.TOKENS.write_text(json.dumps(TOKENS, ensure_ascii=False), encoding='utf-8')
    argv, sys.argv = sys.argv, ['privat_fetch.py', '01.11.2026', '05.11.2026', *args]
    out, t0 = io.StringIO(), time.time()
    try:
        with contextlib.redirect_stdout(out):
            code = m.main(False)
    finally:
        sys.argv = argv
    allf = Path(d) / 'виписка_ВСІ_01.11.2026_05.11.2026.json'
    return code, out.getvalue(), time.time() - t0, json.loads(allf.read_text(encoding='utf-8')) if allf.exists() else None


class ParallelFetchTest(unittest.TestCase):
    def test_parallel_with_bank_pauses(self):
        m = load()
        m.MONO_GAP, m.PRIVAT_GAP, m.REGL_WAIT = 0.6, 0.25, 0.05
        fake = FakeBanks(m)
        m.requests = fake
        with tempfile.TemporaryDirectory() as d:
            code, log, took, allf = run(m, d, '--mono-currency')  # і валютні рахунки Моно: у Хоменка їх два — тут видно паузу між виписками
            self.assertEqual(code, 0, log)
            # файли й порядок — як у файлі токенів (Приват клієнта, потім Моно), хоч банки відповідали впереміш
            self.assertEqual([(a['client'], a['bank']) for a in allf['accounts']],
                             [('ПРИКЛАД', 'privat'), ('Маркет', 'privat'), ('ФОП Житинська', 'privat'), ('ФОП Житинська', 'mono'),
                              ('ФОП Сидорук', 'mono'), ('ФОП Хоменко', 'privat'), ('ФОП Хоменко', 'mono'), ('ФОП Хоменко', 'mono')])
            self.assertEqual(sorted(fake.mono_statements), ['fa1', 'fa2', 'fb1', 'fc1'])
            self.assertIn('і валютні рахунки', log)
            self.assertEqual(len([a for a in allf['accounts'] if a['acc'] == 'UA00privat-sv'][0]['transactions']), 2, 'обидві сторінки транзакцій')
            # Приват: токен — не частіше 1 запиту на PRIVAT_GAP; разом — не більше PRIVAT_PARALLEL одночасних
            for tok in ('privat-sv', 'privat-mt', 'privat-fc', 'privat-fa'):
                s = fake.starts('privat', tok)
                self.assertTrue(all(b - a >= m.PRIVAT_GAP - 0.02 for a, b in zip(s, s[1:])), (tok, s))
            self.assertLessEqual(fake.max_inflight, m.PRIVAT_PARALLEL)
            self.assertGreater(fake.max_inflight, 1, 'Приват справді паралельно')
            self.assertEqual(len(fake.starts('privat', 'privat-fc', 'statements/settings')), 2, 'регламент — перепитав settings')
            self.assertIn('регламентні роботи', log)
            # Моно: функція токена — не частіше 1 разу на MONO_GAP; дані клієнта й перша виписка — без хвилини між ними
            for tok in ('mono-fc', 'mono-fb', 'mono-fa'):
                st = fake.starts('mono', tok, 'statement')
                self.assertTrue(all(b - a >= m.MONO_GAP - 0.02 for a, b in zip(st, st[1:])), (tok, st))
                self.assertLess(st[0] - fake.starts('mono', tok, 'client-info')[0], m.MONO_GAP)
            # одночасно: усе — приблизно як найдовший токен (Хоменко: два рахунки Моно), а не сума всіх
            self.assertLess(took, 3.0, log)


class PagedPrivat:
    """Приват одного токена: транзакції сторінками за сценарієм — кожен новий запит без followId бере наступний набір сторінок."""
    def __init__(self, m, balances, fetches):
        self.m, self.balances, self.fetches, self.runs = m, balances, fetches, 0

    def get(self, url, headers=None, params=None, timeout=None):
        path = url[len(self.m.BASE):]
        if path == 'statements/settings':
            return R(200, {'settings': {'work_balance': 'N'}})
        if path == 'statements/balance':
            return R(200, {'balances': self.balances, 'exist_next_page': False})
        if not params.get('followId'):
            self.runs += 1
        pages = self.fetches[min(self.runs, len(self.fetches)) - 1]
        i = int(params.get('followId') or 0)
        return R(200, {'transactions': pages[i], 'exist_next_page': i + 1 < len(pages), 'next_page_id': str(i + 1)})


def tr(acc, id_, kind, s, **kw):
    return dict({'AUT_MY_ACC': acc, 'ID': id_, 'TRANTYPE': kind, 'SUM': s, 'DAT_OD': '28.09.2026', 'TIM_P': '13:14'}, **kw)


class PrivatCompletenessTest(unittest.TestCase):
    """07.11.2026: у вересні Приват на межі сторінок віддав операцію двічі, а іншу пропустив.
    Скрипт пропускає дублі за ID, звіряє вхідний + рух з вихідним і один раз перепитує операції."""
    A, B = 'UA00000000000000000000005608', 'UA00000000000000000000009953'
    BAL = [{'acc': A, 'currency': 'UAH', 'nameACC': 'ПРИКЛАД', 'balanceIn': '1000.00', 'balanceOut': '900.00'},
           {'acc': B, 'currency': 'UAH', 'nameACC': 'Ціл-ві зарах.', 'balanceIn': '0.00', 'balanceOut': '50.00'}]
    t1, t2 = tr(A, 'id1', 'D', '30.00'), tr(A, 'id2', 'D', '42.00')
    t3, t4 = tr(A, 'id3', 'D', '43.00'), tr(A, 'id4', 'C', '15.00')
    junk = tr(A, 'idx', 'D', '999.00', PR_PR='n')  # не проведена — у рух не йде (як normPrivat)
    b1 = tr(B, 'idb', 'C', '50,00')

    def fetch(self, *fetches):
        m = load()
        m.PRIVAT_GAP = 0.01
        fake = PagedPrivat(m, self.BAL, fetches)
        m.requests = fake
        logs = []
        accs = {a['acc']: a for a in m.privat_accounts('tok', m.date(2026, 9, 1), m.date(2026, 9, 30), logs.append)}
        return accs, fake.runs, logs

    def test_consistent_no_refetch(self):
        accs, runs, logs = self.fetch([[self.t1, self.t2, self.b1], [self.t3, self.t4, self.junk]])
        self.assertEqual(runs, 1, 'виписка сходиться — операції не перепитуємо')
        self.assertEqual(logs, [])
        self.assertEqual(len(accs[self.A]['transactions']), 5)
        self.assertFalse([w for a in accs.values() for w in a['warnings'] if not w.startswith('Підсумкова')])

    def test_page_boundary_fixed_by_refetch(self):
        broken = [[self.t1, self.t2, self.b1], [dict(self.t2), self.t4]]  # t2 двічі, t3 загублено
        accs, runs, logs = self.fetch(broken, [[self.t1, self.t2, self.b1], [self.t3, self.t4]])
        self.assertEqual(runs, 2, 'один повторний запит')
        self.assertIn('перепитую операції ще раз', logs[0])
        self.assertEqual([t['ID'] for t in accs[self.A]['transactions']], ['id1', 'id2', 'id3', 'id4'])
        self.assertEqual(accs[self.A]['warnings'], [], 'повторна відповідь повна — без попереджень')
        self.assertEqual(len(accs[self.B]['transactions']), 1)

    def test_still_broken_warns(self):
        broken = [[self.t1, self.t2, self.b1], [dict(self.t2), self.t4]]
        accs, runs, _ = self.fetch(broken, broken, broken)
        self.assertEqual(runs, 2, 'перепитуємо лише один раз')
        self.assertEqual([t['ID'] for t in accs[self.A]['transactions']], ['id1', 'id2', 'id4'], 'дубль пропущено')
        self.assertEqual(accs[self.A]['warnings'], ['Банк віддав операцію двічі — дубль пропущено',
                                                   'Виписка неповна: вхідний + рух ≠ вихідний на 43.00 грн — вивантажте заново'])
        self.assertEqual(accs[self.B]['warnings'], [], 'інший рахунок сходиться')

    def test_dup_without_id(self):
        """Без ID — дубль за REF+REFN+TRANTYPE+SUM+DAT_OD+TIM_P; та сама сума в іншу хвилину — не дубль."""
        m = load()
        a = {self.A: {'acc': self.A, 'warnings': []}}
        x = {'AUT_MY_ACC': self.A, 'REF': 'R1', 'REFN': '1', 'TRANTYPE': 'D', 'SUM': '5.00', 'DAT_OD': '01.09.2026', 'TIM_P': '10:00'}
        g = m.privat_group(a, [x, dict(x), dict(x, TIM_P='10:01')])
        self.assertEqual((len(g[self.A][0]), g[self.A][1]), (2, 1))

    def test_summary_prints_privat_warnings(self):
        m = load()
        m.PRIVAT_GAP = 0.01
        broken = [[self.t1, self.t2, self.b1], [dict(self.t2), self.t4]]
        m.requests = PagedPrivat(m, self.BAL, [broken])
        with tempfile.TemporaryDirectory() as d:
            m.HERE, m.TOKENS = Path(d), Path(d) / 'privat_tokens.json'
            m.TOKENS.write_text(json.dumps({'ПРИКЛАД': 'tok'}), encoding='utf-8')
            argv, sys.argv = sys.argv, ['privat_fetch.py', '01.09.2026', '30.09.2026']
            out = io.StringIO()
            try:
                with contextlib.redirect_stdout(out):
                    m.main(False)
            finally:
                sys.argv = argv
        self.assertIn('    ! Виписка неповна: вхідний + рух ≠ вихідний на 43.00 грн — вивантажте заново', out.getvalue())
        self.assertIn('    ! Банк віддав операцію двічі — дубль пропущено', out.getvalue())


class MonoCurrencyTest(unittest.TestCase):
    """З 06.11.2026: без ключа з Моно — лише гривневі рахунки ФОП (валютні — лише залишок у журналі, без запиту виписки)."""
    def test_only_uah_by_default(self):
        m = load()
        m.MONO_GAP, m.PRIVAT_GAP, m.REGL_WAIT = 0.6, 0.25, 0.05
        fake = FakeBanks(m)
        m.requests = fake
        with tempfile.TemporaryDirectory() as d:
            code, log, took, allf = run(m, d)
            self.assertEqual(code, 0, log)
            mono = [a for a in allf['accounts'] if a['bank'] == 'mono']
            self.assertEqual([(a['client'], a['acc'], a['ccy']) for a in mono],
                             [('ФОП Житинська', 'UAfc1', 'UAH'), ('ФОП Сидорук', 'UAfb1', 'UAH'), ('ФОП Хоменко', 'UAfa1', 'UAH')])
            self.assertEqual(sorted(fake.mono_statements), ['fa1', 'fb1', 'fc1'], 'по валютному рахунку виписку не просили')
            self.assertIn('[ФОП Хоменко] Моно: валютні рахунки не вивантажую (USD 50.00) — лише гривневі', log)
            self.assertIn('Валютні рахунки Моно не вивантажено (лише гривневі; поточний залишок — з даних банку): ФОП Хоменко — USD 50.00', log)
            self.assertIn('Моно: лише гривневі рахунки ФОП', log)
            # кожен токен Моно — дані клієнта й одна виписка, без хвилини очікування
            self.assertNotIn('Моно: чекаю', log)
            self.assertLess(took, 3.0, log)

    def test_ctrl_c_stops_pauses_at_once(self):
        """Ctrl+C (07.11.2026): потоки не чекають хвилинних пауз Моно — пауза переривається, журнал мовчить."""
        m = load()
        m.CANCEL.set()
        t0 = time.time()
        with self.assertRaises(m.Stop):
            m.pause(60)
        self.assertLess(time.time() - t0, 1)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            m.say('після Ctrl+C')
        self.assertEqual(out.getvalue(), '')

    def test_args(self):
        m = load()
        self.assertEqual(m.split_args(['01.11.2026', '05.11.2026']), (['01.11.2026', '05.11.2026'], False))
        self.assertEqual(m.split_args(['--mono-currency', '01.11.2026', '05.11.2026']), (['01.11.2026', '05.11.2026'], True))
        self.assertEqual(m.split_args(['--mono-currency']), ([], True))
        with self.assertRaises(m.Stop):
            m.split_args(['01.11.2026', '05.11.2026', '--usd'])
        self.assertIn('--mono-currency', m.USAGE)


if __name__ == '__main__':
    unittest.main()
