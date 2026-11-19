"""Тести сервера «Помічника кешфлоу» (app/helper.py) з моком CRM.
Запуск (з кореня проєкту): python -m unittest discover -s test -p "test_*.py"
"""
import base64
import json
import re
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
import helper  # noqa: E402

GOOD = 'tok-valid-0123456789abcdefghij'
MOCK = {'calls': [], 'fail429': 0}


class MockCRM(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        if status == 429:
            self.send_header('Retry-After', '0')
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        return self.headers.get('Authorization') == 'Bearer ' + GOOD

    def do_GET(self):
        MOCK['calls'].append(('GET', self.path))
        if not self._auth():
            return self._send(401, {'message': 'Unauthenticated.'})
        if MOCK['fail429'] > 0:
            MOCK['fail429'] -= 1
            return self._send(429, {'message': 'Too Many Attempts.'})
        if self.path.startswith('/api/redirect'):  # переадресація: токен не має піти за нею
            self.send_response(302)
            self.send_header('Location', '/api/sink')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        if self.path.startswith('/api/sink'):
            return self._send(200, {'sink': True})
        if self.path.startswith('/api/currency'):
            return self._send(200, [{'id': 1, 'code': 'UAH'}])
        if self.path.startswith('/api/invoice-payment'):
            return self._send(200, {'data': [{'id': 1}], 'last_page': 1, 'total': 1})
        if self.path.startswith('/api/user/'):  # профіль користувача CRM: разом із правами — токени й контакти
            return self._send(200, {'id': int(self.path.rsplit('/', 1)[1]), 'email': 'buh@example.com', 'jwt_token': 'secret-jwt', 'api_token_front': 'secret-front',
                                    'role': {'id': 2, 'name': 'бухгалтер', 'permissions': {'x': 1}},
                                    'permissions': {'invoice': {'operation_edit': 1, 'operation_full_edit': 1}, 'tasks': {'read': 1}}})
        return self._send(404, {'message': 'nf'})

    def do_PUT(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(n) or b'{}')
        MOCK['calls'].append(('PUT', self.path, body))
        if not self._auth():
            return self._send(401, {'message': 'Unauthenticated.'})
        return self._send(200, {'id': 1, 'updated': body})


def start(server_cls, handler):
    srv = server_cls(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class HelperTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        helper.DATA = Path(cls.tmp.name)
        helper.MIN_INTERVAL = 0
        cls.crm = start(ThreadingHTTPServer, MockCRM)
        helper.STATE['crm_base'] = f'http://127.0.0.1:{cls.crm.server_address[1]}'
        cls.srv = start(ThreadingHTTPServer, helper.Handler)
        cls.port = cls.srv.server_address[1]
        helper.STATE['port'] = cls.port

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.crm.shutdown()
        cls.tmp.cleanup()

    def req(self, method, path, body=None, headers=None, key=True, host=None):
        h = {'Host': host or f'127.0.0.1:{self.port}'}
        if key:
            h['X-Helper-Key'] = helper.KEY
        if body is not None:
            h['Content-Type'] = 'application/json'
        h.update(headers or {})
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def connect(self):
        return self.req('POST', '/api/connect', {'token': GOOD, 'user_id': '1243'}, {'Origin': helper.CRM_ORIGIN}, key=False)

    def test_index_has_session_key(self):
        st, body, _ = self.req('GET', '/', key=False)
        self.assertEqual(st, 200)
        self.assertIn(helper.KEY.encode(), body)

    def test_api_requires_key_and_host(self):
        self.assertEqual(self.req('GET', '/api/status', key=False)[0], 403)
        self.assertEqual(self.req('GET', '/api/status')[0], 200)
        self.assertEqual(self.req('GET', '/api/status', host='evil.example')[0], 403)          # DNS rebinding
        self.assertEqual(self.req('GET', '/api/status', headers={'Origin': 'https://evil.example'})[0], 403)

    def test_connect_only_from_crm_origin(self):
        st, _, _ = self.req('POST', '/api/connect', {'token': GOOD}, {'Origin': 'https://evil.example'}, key=False)
        self.assertEqual(st, 403)
        st, body, hdr = self.connect()
        self.assertEqual(st, 200, body)
        self.assertTrue(json.loads(body)['ok'])
        self.assertEqual(hdr.get('Access-Control-Allow-Origin'), helper.CRM_ORIGIN)
        self.assertEqual(helper.STATE['token'], GOOD)
        bad = self.req('POST', '/api/connect', {'token': 'tok-bad-0123456789abcdefghij'}, {'Origin': helper.CRM_ORIGIN}, key=False)
        self.assertEqual(bad[0], 400)

    def test_preflight_private_network(self):
        st, _, hdr = self.req('OPTIONS', '/api/connect', headers={'Origin': helper.CRM_ORIGIN, 'Access-Control-Request-Private-Network': 'true'}, key=False)
        self.assertEqual(st, 204)
        self.assertEqual(hdr.get('Access-Control-Allow-Private-Network'), 'true')

    def test_token_saved_encrypted(self):
        self.connect()
        f = helper.token_file()
        if sys.platform == 'win32':
            self.assertTrue(f.exists())
            self.assertNotIn(GOOD.encode(), f.read_bytes())
            self.assertEqual(helper.load_token(), GOOD)

    def test_proxy_get_allowlist_and_429(self):
        self.connect()
        st, body, _ = self.req('GET', '/api/crm/invoice-payment?date_from=01-09-2026&date_to=30-09-2026&per_page=500&page=1')
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(body)['total'], 1)
        self.assertEqual(self.req('GET', '/api/crm/user/')[0], 403)
        self.assertEqual(self.req('GET', '/api/crm/task/1')[0], 403)
        MOCK['fail429'] = 2
        st, _, _ = self.req('GET', '/api/crm/currency')
        self.assertEqual(st, 200)

    def test_proxy_own_rights_only(self):
        """Права на кешфлоу (оновлення CRM 29.10.2026): лише свій профіль і з нього лише роль і permissions.invoice."""
        self.connect()  # користувач 1243
        st, body, _ = self.req('GET', '/api/crm/user/1243')
        self.assertEqual(st, 200, body)
        self.assertEqual(json.loads(body), {'id': 1243, 'role': {'name': 'бухгалтер'}, 'permissions': {'invoice': {'operation_edit': 1, 'operation_full_edit': 1}}})
        self.assertNotIn(b'secret', body)
        self.assertEqual(self.req('GET', '/api/crm/user/7')[0], 403)          # чужий профіль
        self.assertEqual(self.req('GET', '/api/crm/user/1243/x')[0], 403)
        self.assertEqual(helper.user_rights_only({'data': {'id': 1, 'permissions': 'x'}}), {'id': 1, 'role': None, 'permissions': {'invoice': {}}})
        self.assertEqual(helper.user_rights_only(['x']), {})

    def test_put_guards(self):
        self.connect()
        self.assertEqual(self.req('PUT', '/api/crm/invoice-payment/1', {'pnl_category_id': '76'})[0], 403)  # без режиму редагування
        h = {'X-Helper-Edit': '1'}
        st, body, _ = self.req('PUT', '/api/crm/invoice-payment/1', {'amount': '1', 'pnl_category_id': '76'}, h)
        self.assertEqual(st, 400)
        self.assertIn('amount', json.loads(body)['error'])
        self.assertEqual(self.req('PUT', '/api/crm/invoice/1', {'pnl_category_id': '76'}, h)[0], 403)
        self.assertEqual(self.req('PUT', '/api/crm/invoice-payment/1', {}, h)[0], 400)
        st, body, _ = self.req('PUT', '/api/crm/invoice-payment/1', {'pnl_category_id': '76', 'pnl_operation_id': '82'}, h)
        self.assertEqual(st, 200)
        self.assertEqual(MOCK['calls'][-1], ('PUT', '/api/invoice-payment/1', {'pnl_category_id': '76', 'pnl_operation_id': '82'}))

    def test_files_save_and_sanitize(self):
        st, body, _ = self.req('POST', '/api/files/save', {'name': '..\\..\\evil.json', 'base64': base64.b64encode(b'{}').decode()})
        self.assertEqual(st, 200)
        saved = Path(json.loads(body)['path'])
        self.assertTrue(saved.resolve().is_relative_to(helper.DATA.resolve()))
        st, body, _ = self.req('POST', '/api/files/save', {'name': 'кешфлоу_резервна_копія_1.json', 'base64': base64.b64encode(b'[1]').decode()})
        self.assertEqual(json.loads(body)['kind'], 'backups')
        st, body, _ = self.req('GET', '/api/files/list')
        self.assertTrue(any(f['kind'] == 'backups' for f in json.loads(body)['files']))

    def test_bank_file_name_validation(self):
        self.assertEqual(self.req('GET', '/api/bank/file?name=..%5Cprivat_tokens.json')[0], 400)
        self.assertEqual(self.req('GET', '/api/bank/file?name=privat_tokens.json')[0], 400)

    def test_static_no_traversal(self):
        self.assertEqual(self.req('GET', '/core/..%5C..%5Capp%5Chelper.py', key=False)[0], 404)
        self.assertEqual(self.req('GET', '/core/rules-engine.js', key=False)[0], 200)

    # ---------- за незалежним рев'ю ----------
    def test_page_cannot_be_framed(self):
        _, _, hdr = self.req('GET', '/', key=False)
        self.assertEqual(hdr.get('X-Frame-Options'), 'DENY')
        self.assertIn("frame-ancestors 'none'", hdr.get('Content-Security-Policy', ''))

    def test_files_save_only_data_extensions(self):
        st, _, _ = self.req('POST', '/api/files/save', {'name': 'privat_fetch.py', 'base64': base64.b64encode(b'print(1)').decode()})
        self.assertEqual(st, 400)
        self.assertFalse(any(helper.DATA.rglob('privat_fetch*')))

    def test_config_validation(self):
        self.assertEqual(self.req('POST', '/api/config', {'bank_dir': str(helper.DATA / 'reports')})[0], 400)
        self.assertEqual(self.req('POST', '/api/config', {'account_map': ['x']})[0], 400)
        self.assertEqual(self.req('POST', '/api/config', {'account_map': {'UA00': 33}})[0], 200)
        self.assertEqual(self.req('POST', '/api/config', {'mono_currency': 'так'})[0], 400)
        self.assertFalse(json.loads(self.req('GET', '/api/status')[1])['bank']['mono_currency'], 'за замовчуванням — лише гривневі')

    def fetch(self):
        """Вивантаження через Помічник до кінця; → журнал задачі."""
        st, body, _ = self.req('POST', '/api/bank/fetch', {'from': '2026-10-01', 'to': '2026-10-20'})
        self.assertEqual(st, 200, body)
        for _ in range(200):
            job = json.loads(self.req('GET', '/api/bank/job')[1])
            if not job['running']:
                return job
            time.sleep(0.05)
        self.fail('вивантаження не завершилось')

    def test_mono_currency_flag(self):
        """Галочка «валютні рахунки Моно» → ключ --mono-currency для privat_fetch.py; старому скрипту ключ не передається."""
        with tempfile.TemporaryDirectory() as d:
            script, out = Path(d, 'privat_fetch.py'), Path(d, 'виписка_ВСІ_01.10.2026_20.10.2026.json')
            self.assertEqual(self.req('POST', '/api/config', {'bank_dir': d})[0], 200)
            try:
                for knows, on, want in ((True, False, []), (True, True, ['--mono-currency']), (False, True, [])):
                    script.write_text(FAKE_FETCH + ('# ключ --mono-currency\n' if knows else ''), encoding='utf-8')
                    self.assertEqual(self.req('POST', '/api/config', {'mono_currency': on})[0], 200)
                    bank = json.loads(self.req('GET', '/api/status')[1])['bank']
                    self.assertEqual((bank['mono_currency'], bank['mono_flag']), (on, knows))
                    job = self.fetch()
                    self.assertEqual(job['code'], 0, job.get('log'))
                    self.assertEqual(json.loads(out.read_text(encoding='utf-8'))['argv'], ['01.10.2026', '20.10.2026', *want], (knows, on))
                st, body, _ = self.panel('GET', '/api/panel/bank/status')
                self.assertTrue(json.loads(body)['bank']['mono_currency'], 'панель бачить галочку')
            finally:
                self.req('POST', '/api/config', {'bank_dir': '', 'mono_currency': False})

    def test_put_body_validation(self):
        self.connect()
        h = {'X-Helper-Edit': '1'}
        self.assertEqual(self.req('PUT', '/api/crm/invoice-payment/1', ['pnl_category_id'], h)[0], 400)
        self.assertEqual(self.req('PUT', '/api/crm/invoice-payment/1', {'project_id': 'x1'}, h)[0], 400)
        self.assertEqual(self.req('PUT', '/api/crm/invoice-payment/1', {'pnl_category_id': '76'}, h)[0], 400)
        self.assertEqual(self.req('PUT', '/api/crm/invoice-payment/1', {'project_id': 4}, h)[0], 200)

    def test_token_not_sent_after_redirect(self):
        MOCK['calls'].clear()
        st, _, _ = helper.crm_request('GET', 'redirect', token=GOOD)
        self.assertEqual(st, 302)
        self.assertFalse(any(c[1].startswith('/api/sink') for c in MOCK['calls']))


    # ---------- панель лінтера на сторінці CRM: виписки через Помічник ----------
    def panel(self, method, path, body=None, origin=None):
        return self.req(method, path, body, {'Origin': origin or helper.CRM_ORIGIN}, key=False)

    def test_panel_files_save_backups_and_journals_only(self):
        # резервна копія й журнали панелі — у папку даних Помічника, без вікна «Зберегти як» у браузері
        b = base64.b64encode('[{"id": 1}]'.encode()).decode()
        st, body, hdr = self.panel('POST', '/api/panel/files/save', {'name': 'кешфлоу_записи_журнал_2026-10-27.json', 'kind': 'journals', 'base64': b})
        self.assertEqual(st, 200)
        self.assertEqual(hdr.get('Access-Control-Allow-Origin'), helper.CRM_ORIGIN)
        saved = Path(json.loads(body)['path'])
        self.assertEqual(saved.parent, helper.DATA / 'journals')
        self.assertEqual(saved.read_bytes(), b'[{"id": 1}]')
        st, body, _ = self.panel('POST', '/api/panel/files/save', {'name': 'кешфлоу_резервна_копія_1.json', 'kind': 'backups', 'base64': b})
        self.assertEqual(json.loads(body)['kind'], 'backups')
        # чужий сайт, без Origin, інший тип, інша назва чи розширення, пошкоджений base64 — ні
        self.assertEqual(self.panel('POST', '/api/panel/files/save', {'name': 'кешфлоу_журнал_1.json', 'base64': b}, origin='https://evil.example')[0], 403)
        self.assertEqual(self.req('POST', '/api/panel/files/save', {'name': 'кешфлоу_журнал_1.json', 'base64': b}, key=False)[0], 403)
        self.assertEqual(self.panel('POST', '/api/panel/files/save', {'name': 'кешфлоу_звіт.json', 'kind': 'reports', 'base64': b})[0], 400)
        for name in ('privat_tokens.json', 'кешфлоу_журнал.py', '..\\кешфлоу_журнал.json', 'кешфлоу_../x.json'):
            self.assertEqual(self.panel('POST', '/api/panel/files/save', {'name': name, 'kind': 'journals', 'base64': b})[0], 400, name)
        self.assertEqual(self.panel('POST', '/api/panel/files/save', {'name': 'кешфлоу_журнал_2.json', 'kind': 'journals', 'base64': '***'})[0], 400)
        st, _, hdr = self.req('OPTIONS', '/api/panel/files/save', headers={'Origin': helper.CRM_ORIGIN, 'Access-Control-Request-Private-Network': 'true'}, key=False)
        self.assertEqual(st, 204)

    def test_panel_bank_only_from_crm_origin(self):
        st, body, hdr = self.panel('GET', '/api/panel/bank/status')
        self.assertEqual(st, 200, body)
        self.assertEqual(hdr.get('Access-Control-Allow-Origin'), helper.CRM_ORIGIN)
        self.assertIn('bank', json.loads(body))
        self.assertEqual(self.panel('GET', '/api/panel/bank/status', origin='https://evil.example')[0], 403)
        self.assertEqual(self.req('GET', '/api/panel/bank/status', key=False)[0], 403)  # без Origin — не з браузера на сторінці CRM
        st, _, hdr = self.req('OPTIONS', '/api/panel/bank/fetch', headers={'Origin': helper.CRM_ORIGIN, 'Access-Control-Request-Private-Network': 'true'}, key=False)
        self.assertEqual(st, 204)
        self.assertIn('GET', hdr.get('Access-Control-Allow-Methods'))
        self.assertEqual(hdr.get('Access-Control-Allow-Private-Network'), 'true')
        self.assertEqual(self.req('OPTIONS', '/api/panel/bank/fetch', headers={'Origin': 'https://evil.example'}, key=False)[0], 403)
        # інші запити Помічника з CRM-сторінки й далі закриті
        self.assertEqual(self.panel('GET', '/api/status')[0], 403)

    def test_dist_linter_for_crm_page(self):
        """Підписаний лінтер для закладки: прочитати відповідь дозволено лише сторінці CRM."""
        if not (helper.ROOT / 'dist' / 'cashflow_linter.js').is_file():
            self.skipTest('немає dist/cashflow_linter.js — спершу зберіть: python build\\build.py')
        st, body, hdr = self.req('GET', '/dist/cashflow_linter.js', headers={'Origin': helper.CRM_ORIGIN}, key=False)
        self.assertEqual(st, 200)
        self.assertIn(b'\n//# CFL-SIG ', body)
        self.assertEqual(hdr.get('Access-Control-Allow-Origin'), helper.CRM_ORIGIN)
        self.assertIsNone(self.req('GET', '/dist/cashflow_linter.js', headers={'Origin': 'https://evil.example'}, key=False)[2].get('Access-Control-Allow-Origin'))
        st, _, hdr = self.req('OPTIONS', '/dist/cashflow_linter.js', headers={'Origin': helper.CRM_ORIGIN, 'Access-Control-Request-Private-Network': 'true'}, key=False)
        self.assertEqual(st, 204)
        self.assertEqual(hdr.get('Access-Control-Allow-Private-Network'), 'true')
        self.assertEqual(self.req('OPTIONS', '/dist/cashflow_linter.js', headers={'Origin': 'https://evil.example'}, key=False)[0], 403)
        # мітка збірки в dist — щоб панель підказала про новішу версію
        st, body, _ = self.panel('GET', '/api/panel/bank/status')
        self.assertRegex(json.loads(body)['linter'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')

    def test_quit_only_with_key_and_not_during_fetch(self):
        self.assertEqual(self.req('POST', '/api/quit', {}, key=False)[0], 403)
        # сторінка в браузері (навіть власна сторінка Помічника) зупинити не може
        self.assertEqual(self.req('POST', '/api/quit', {}, {'X-Quit-Key': helper.QUIT_KEY, 'Origin': f'http://127.0.0.1:{self.port}'}, key=False)[0], 403)
        helper.JOB['running'] = True
        try:
            self.assertEqual(self.req('POST', '/api/quit', {}, {'X-Quit-Key': helper.QUIT_KEY}, key=False)[0], 409)
        finally:
            helper.JOB['running'] = False

    def test_quit_waits_for_ai_in_flight(self):
        """07.11.2026: поки Claude відповідає (підказки, чернетка правил, «Зіставлення ШІ»), Помічник не зупиняється — інакше оплачений
        запит загубиться й піде вдруге."""
        ai, quit_ = helper.ai, lambda: self.req('POST', '/api/quit', {}, {'X-Quit-Key': helper.QUIT_KEY}, key=False)
        busy = [(lambda: ai.WORK.update(running=True), lambda: ai.WORK.update(running=False)),
                (lambda: ai.INFLIGHT.add('k1'), lambda: ai.INFLIGHT.discard('k1')),
                (lambda: ai.DRAFT_JOB.update(running=True), lambda: ai.DRAFT_JOB.update(running=False)),
                (lambda: helper.AI_MATCH.__setitem__(0, 1), lambda: helper.AI_MATCH.__setitem__(0, 0))]
        for on, off in busy:
            on()
            try:
                st, body, _ = quit_()
                self.assertEqual(st, 409, body)
                self.assertIn('ШІ', json.loads(body)['error'])
            finally:
                off()
        self.assertFalse(helper.ai_busy())

    def test_match_request_counted_while_running(self):
        seen = []
        def match(msg):
            seen.append(helper.ai_busy())
            return 200, {'ok': True, 'matches': []}
        with mock.patch.object(helper.ai, 'match_request', match):
            st, _, _ = self.panel('POST', '/api/panel/ai/match', {'bank': [], 'approvals': []})
        self.assertEqual((st, seen), (200, [True]))
        self.assertEqual(helper.AI_MATCH[0], 0)

    def test_panel_bank_fetch_flow(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, 'privat_fetch.py').write_text(FAKE_FETCH, encoding='utf-8')
            self.assertEqual(self.req('POST', '/api/config', {'bank_dir': d})[0], 200)
            try:
                self.assertEqual(self.panel('POST', '/api/panel/bank/fetch', {'from': '2026-10-20', 'to': '2026-10-01'})[0], 400)
                st, body, hdr = self.panel('POST', '/api/panel/bank/fetch', {'from': '2026-10-01', 'to': '2026-10-20'})
                self.assertEqual(st, 200, body)
                self.assertEqual(hdr.get('Access-Control-Allow-Origin'), helper.CRM_ORIGIN)
                job = {}
                for _ in range(200):
                    job = json.loads(self.panel('GET', '/api/panel/bank/job')[1])
                    if not job['running']:
                        break
                    time.sleep(0.05)
                self.assertEqual(job['code'], 0, job.get('log'))
                self.assertEqual(job['file'], 'виписка_ВСІ_01.10.2026_20.10.2026.json')
                st, body, _ = self.panel('GET', '/api/panel/bank/file?name=' + urllib.parse.quote(job['file']))
                self.assertEqual(st, 200)
                self.assertEqual(json.loads(body)['from'], '2026-10-01')
                self.assertEqual(self.panel('GET', '/api/panel/bank/file?name=privat_tokens.json')[0], 400)
                self.assertEqual(self.panel('GET', '/api/panel/bank/file?name=..%5Cprivat_tokens.json')[0], 400)
                files = json.loads(self.panel('GET', '/api/panel/bank/files')[1])['files']
                self.assertEqual(files[0]['name'], job['file'])
            finally:
                self.req('POST', '/api/config', {'bank_dir': ''})

    def rules_sandbox(self, can_edit=True, build_ok=True):
        """rules.json у тимчасовій копії «проєкту»; збірка лінтера підмінена — справжні rules.json і dist/ не чіпаються."""
        tmp = Path(tempfile.mkdtemp())
        (tmp / 'rules').mkdir()
        doc = json.loads((ROOT / 'rules' / 'rules.json').read_text(encoding='utf-8'))
        (tmp / 'rules' / 'rules.json').write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        built = []
        def rebuild():
            if not build_ok:
                raise SystemExit('немає ключа підпису')
            built.append(json.loads((tmp / 'rules' / 'rules.json').read_text(encoding='utf-8'))['version'])
        patches = [mock.patch.object(helper, 'ROOT', tmp), mock.patch.object(helper, 'rebuild_linter', rebuild), mock.patch.object(helper, 'can_edit_rules', lambda: can_edit)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return tmp, doc, built

    def test_rules_save_new_version_archive_and_rebuild(self):
        tmp, doc, built = self.rules_sandbox()
        self.assertEqual(self.req('GET', '/api/rules/meta', key=False)[0], 403)
        meta = json.loads(self.req('GET', '/api/rules/meta')[1])
        self.assertEqual((meta['canEdit'], meta['versions']), (True, []))
        rule = next(r for r in doc['rules'] if r['id'] == 'R-COMM-01')
        rule['disabled'] = True
        doc['reference']['cards'][0]['holders'].append({'from': '2026-11-02', 'name': 'Тестовий Власник'})  # форма корп. карток
        st, body, _ = self.req('POST', '/api/rules/save', {'doc': doc, 'note': 'вимкнено R-COMM-01'})
        self.assertEqual(st, 200, body)
        res = json.loads(body)
        old_v = re.match(r'(\d+)\.(\d+)\.(\d+)', doc['version']).groups()
        self.assertTrue(res['version'].startswith(f'{old_v[0]}.{old_v[1]}.{int(old_v[2]) + 1} ('), res['version'])
        self.assertIn('вимкнено R-COMM-01', res['version'])
        saved = json.loads((tmp / 'rules' / 'rules.json').read_text(encoding='utf-8'))
        self.assertEqual(next(r for r in saved['rules'] if r['id'] == 'R-COMM-01').get('disabled'), True)
        self.assertEqual(saved['reference']['cards'][0]['holders'][-1], {'from': '2026-11-02', 'name': 'Тестовий Власник'})
        self.assertEqual(built, [res['version']], 'лінтер перезібрано з новою версією')
        archived = tmp / 'rules' / 'архів' / res['archived']
        self.assertEqual(json.loads(archived.read_text(encoding='utf-8'))['version'], doc['version'])
        # той самий вигляд файлу, що й у генератора правил: відступ 2, кирилиця як є
        self.assertEqual((tmp / 'rules' / 'rules.json').read_text(encoding='utf-8'), json.dumps(saved, ensure_ascii=False, indent=2) + '\n')
        # відновлення попередньої версії — ще одна нова версія з тим самим вмістом правил
        st, body, _ = self.req('POST', '/api/rules/restore', {'name': res['archived']})
        self.assertEqual(st, 200, body)
        restored = json.loads((tmp / 'rules' / 'rules.json').read_text(encoding='utf-8'))
        self.assertIsNone(next(r for r in restored['rules'] if r['id'] == 'R-COMM-01').get('disabled'))
        self.assertIn('відновлено версію', restored['version'])
        self.assertEqual(len(json.loads(self.req('GET', '/api/rules/meta')[1])['versions']), 2)
        self.assertEqual(self.req('POST', '/api/rules/restore', {'name': '../rules.json'})[0], 400)

    def test_rules_save_refused_without_signing_key_or_bad_doc(self):
        tmp, doc, built = self.rules_sandbox(can_edit=False)
        st, body, _ = self.req('POST', '/api/rules/save', {'doc': doc, 'note': 'x'})
        self.assertEqual(st, 403)
        self.assertIn('ключа підпису', json.loads(body)['error'])
        self.assertEqual(built, [])
        with mock.patch.object(helper, 'can_edit_rules', lambda: True):
            self.assertEqual(self.req('POST', '/api/rules/save', {'doc': {'rules': 'не список'}})[0], 400)
            # корп. картки: 4 останні цифри й ID рахунку; без повторів і без «запам'ятаних у браузері»
            for cards in ([{'last4': '12345', 'account_id': 90}], [{'last4': '7365', 'account_id': '90'}], [{'last4': '7365', 'account_id': 0}],
                          [{'last4': '7365', 'account_id': 90}, {'last4': '7365', 'account_id': 91}], [{'last4': '7365', 'account_id': 90, 'local': True}], 'не список'):
                bad = dict(doc, reference=dict(doc['reference'], cards=cards))
                st, body, _ = self.req('POST', '/api/rules/save', {'doc': bad})
                self.assertEqual(st, 400, cards)
                self.assertIn('reference.cards', json.loads(body)['error'])
            self.assertEqual(built, [])
            self.assertEqual(self.req('POST', '/api/rules/save', {'doc': doc}, key=False)[0], 403)

    def test_rules_build_failure_restores_file(self):
        tmp, doc, built = self.rules_sandbox(build_ok=False)
        before = (tmp / 'rules' / 'rules.json').read_bytes()
        doc['rules'][0]['title'] += ' (змінено)'
        st, body, _ = self.req('POST', '/api/rules/save', {'doc': doc, 'note': 'x'})
        self.assertEqual(st, 500)
        self.assertIn('повернуто', json.loads(body)['error'])
        self.assertEqual((tmp / 'rules' / 'rules.json').read_bytes(), before)


class RebuildAndStartTest(unittest.TestCase):
    """07.11.2026: збірка після збереження правил — окремим процесом зі свіжим build.py; --no-browser не вимикає Enter у консолі."""
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='cfl-rebuild-'))
        (self.tmp / 'build').mkdir()
        self.addCleanup(lambda: __import__('shutil').rmtree(self.tmp, ignore_errors=True))

    def test_rebuild_runs_current_build_py(self):
        script = self.tmp / 'build' / 'build.py'
        script.write_text("import os\nopen('built.txt', 'w', encoding='utf-8').write(os.getcwd())\n", encoding='utf-8')
        with mock.patch.object(helper, 'ROOT', self.tmp):
            helper.rebuild_linter()
            self.assertEqual(Path(self.tmp, 'built.txt').read_text(encoding='utf-8'), str(self.tmp))
            # build.py змінився, поки Помічник працює, — береться новий, а не той, що був при першій збірці
            script.write_text("import sys\nprint('немає ключа підпису — PARTS нові', file=sys.stderr)\nsys.exit(1)\n", encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'немає ключа підпису — PARTS нові'):
                helper.rebuild_linter()

    def test_enter_hook_with_no_browser(self):
        hooked = []
        class Srv(ThreadingHTTPServer):
            def serve_forever(self, *a, **k):
                pass
        tty = mock.Mock()
        tty.isatty.return_value = True
        saved = (helper.DATA, dict(helper.STATE), list(helper.REAL_HELPER), helper.SERVER[0])
        try:
            with mock.patch.object(helper, 'ThreadingHTTPServer', Srv), mock.patch.object(helper, 'already_running', lambda p: False), \
                    mock.patch.object(helper.ai, 'start_scheduler', lambda: None), mock.patch.object(helper, 'open_on_enter', hooked.append), \
                    mock.patch.object(helper.sys, 'stdin', tty), mock.patch('builtins.print'):
                self.assertEqual(helper.main(['--no-browser', '--port', '0', '--data', str(self.tmp / 'data')]), 0)
        finally:
            helper.DATA, helper.REAL_HELPER[:], helper.SERVER[0] = saved[0], saved[2], saved[3]
            helper.STATE.clear()
            helper.STATE.update(saved[1])
        self.assertEqual(len(hooked), 1, 'Enter у консолі відкриває вікно й після перезапуску з «Оновити.bat»')


# фіктивний privat_fetch.py: пише «виписка_ВСІ_<з>_<по>.json» у свою папку, як справжній
FAKE_FETCH = """import json, sys
f, t = sys.argv[1], sys.argv[2]
iso = lambda s: '-'.join(reversed(s.split('.')))
open(f'виписка_ВСІ_{f}_{t}.json', 'w', encoding='utf-8').write(json.dumps({'source': 'bank_api', 'client': 'ВСІ', 'from': iso(f), 'to': iso(t), 'accounts': [], 'argv': sys.argv[1:]}))
print('готово')
"""

if __name__ == '__main__':
    unittest.main()
