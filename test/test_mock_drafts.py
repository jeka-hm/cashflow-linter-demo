"""Чернетки CRM у моку (test/mock_crm_server.py): GET / POST /api/invoice-payment-drafts, GET / DELETE …/ID, POST …/ID/convert —
як у живому CRM 14.11.2026. Мок запускається в цьому ж процесі на вільному порту; work/ і мережа не потрібні.
python -m unittest test.test_mock_drafts   (або: python -m unittest discover -s test -p "test_*.py")"""
import contextlib
import io
import json
import sys
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mock_crm_server as mock  # noqa: E402

TOKEN = 'mock-token-test'
REC = {'operation': '2', 'amount': '1.00', 'date': '14-11-2026 12:30', 'period': '01-11-2026', 'comment': 'тест чернетки: кава', 'location_id': '1',
       'project_id': '1', 'currency_id': '1', 'invoice_id': '33', 'pnl_category_id': '59', 'pnl_operation_id': '55', 'show_response_in_currency': '1'}
XFER = {'operation': '3', 'amount': '250.50', 'date': '13-11-2026 09:00', 'period': '01-11-2026', 'comment': 'тест чернетки: переказ', 'location_id': '1',
        'project_id': '1', 'currency_id': '1', 'invoice_from': '33', 'invoice_to': '68'}


class MockDrafts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(('127.0.0.1', 0), mock.H)
        cls.base = f'http://127.0.0.1:{cls.srv.server_address[1]}'
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        self.saved = (dict(mock.DB), dict(mock.REF), set(mock.CLOSED), dict(mock.DRAFTS), dict(mock.SEQ), dict(mock.REG))
        mock.DB.clear()
        mock.REF.clear()
        mock.CLOSED.clear()
        mock.drafts_reset()
        mock.REF['accounts'] = [{'id': 33, 'name': 'ПРИКЛАД Приват UAH', 'currency_id': 1, 'deleted_at': None}, {'id': 68, 'name': 'ФОП Хоменко Приват', 'currency_id': 1, 'deleted_at': None}]
        mock.DB[27229] = mock.rec(27229, '2026-11-10', 33, 1, 45, 21, 500, 'надходження (тест)')
        mock.DB[27230] = mock.rec(27230, '2026-11-11', 33, 2, 59, 55, 100, 'комісія (тест)')
        self.out = io.StringIO()  # мок друкує кожен POST — у звіт тестів це не потрібно
        self.quiet = contextlib.redirect_stdout(self.out)
        self.quiet.__enter__()

    def tearDown(self):
        self.quiet.__exit__(None, None, None)
        for live, was in zip((mock.DB, mock.REF, mock.CLOSED, mock.DRAFTS, mock.SEQ, mock.REG), self.saved):
            live.clear()
            live.update(was)

    def call(self, method, path, form=None, token=TOKEN):
        """→ (статус, розібрана відповідь або None). form — поля FormData (multipart, як шле браузер)."""
        headers, body = {'Accept': 'application/json'}, None
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if form is not None:
            bnd = '----cfTestBoundary7MA4YWxk'
            body = ''.join(f'--{bnd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n' for k, v in form.items()).encode('utf-8') + f'--{bnd}--\r\n'.encode()
            headers['Content-Type'] = 'multipart/form-data; boundary=' + bnd
        elif method == 'POST':
            body = b''
        for attempt in (1, 2):
            req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=10) as r:
                    raw, status = r.read(), r.status
            except urllib.error.HTTPError as e:
                raw, status = e.read(), e.code
                e.close()
            except (ConnectionError, urllib.error.URLError):
                # у повному прогоні з'єднання з тестовим сервером зрідка обривається ще до відповіді (14.11.2026) — один повтор
                if attempt == 2:
                    raise
                continue
            return status, (json.loads(raw) if raw else None)

    def balance(self, acc=33):
        return self.call('GET', f'/api/invoice/{acc}')[1]['balance']

    def live(self):
        return self.call('GET', '/api/invoice-payment?date_from=01-11-2026&date_to=30-11-2026&per_page=100')[1]

    # ---- POST
    def test_post_creates_draft_with_shared_id_sequence(self):
        st, d = self.call('POST', '/api/invoice-payment-drafts', REC)
        self.assertEqual(st, 201)
        self.assertEqual(d['id'], 27231)  # наступний після найбільшого ID запису
        self.assertEqual(d['status'], 'draft')
        self.assertEqual(d['files'], [])
        self.assertIsInstance(d['history'], list)
        self.assertTrue(d['history'])
        self.assertEqual(set(d), {'id', 'status', 'user_id', 'created_at', 'updated_at', 'data', 'files', 'history'})  # сама чернетка, не {data: чернетка}
        self.assertEqual(d['data'], REC)  # поля — рядками, точно як надіслано
        self.assertTrue(all(isinstance(v, str) for v in d['data'].values()))
        self.assertEqual(self.call('POST', '/api/invoice-payment-drafts', XFER)[1]['id'], 27232)
        st, r = self.call('POST', '/api/invoice-payment', {**REC, 'comment': 'справжній запис'})  # запис — після чернеток
        self.assertEqual((st, r['data']['id']), (200, 27233))
        self.assertEqual(self.call('POST', '/api/invoice-payment-drafts', REC)[1]['id'], 27234)

    def test_post_json_keeps_number_types_and_converts(self):
        """Чернетка JSON-ом з числами (як її шле лінтер з 16.11.2026 і зберігає сам CRM): типи лишаються; проведення — як завжди."""
        num = {k: (float(v) if k == 'amount' else int(v)) if str(v).replace('.', '', 1).isdigit() else v for k, v in REC.items()}
        req = urllib.request.Request(self.base + '/api/invoice-payment-drafts', data=json.dumps(num).encode('utf-8'), method='POST',
                                     headers={'Accept': 'application/json', 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as r:
            st, d = r.status, json.loads(r.read())
        self.assertEqual(st, 201)
        self.assertEqual(d['data'], num)
        self.assertIsInstance(d['data']['invoice_id'], int)
        st, rec = self.call('POST', f"/api/invoice-payment-drafts/{d['id']}/convert")
        self.assertEqual((st, rec['data']['id']), (200, d['id']))

    def test_post_keeps_transfer_and_marketer_fields(self):
        d = self.call('POST', '/api/invoice-payment-drafts', XFER)[1]
        self.assertEqual((d['data']['invoice_from'], d['data']['invoice_to'], d['data']['amount']), ('33', '68', '250.50'))
        d = self.call('POST', '/api/invoice-payment-drafts', {**REC, 'marketer_id': '208'})[1]
        self.assertEqual(d['data']['marketer_id'], '208')

    def test_auth_required_everywhere(self):
        did = self.call('POST', '/api/invoice-payment-drafts', REC)[1]['id']
        for method, path, form in (('GET', '/api/invoice-payment-drafts', None), ('POST', '/api/invoice-payment-drafts', REC), ('GET', f'/api/invoice-payment-drafts/{did}', None),
                                   ('DELETE', f'/api/invoice-payment-drafts/{did}', None), ('POST', f'/api/invoice-payment-drafts/{did}/convert', None)):
            for token in (None, 'чужий'.encode().hex()):
                self.assertEqual(self.call(method, path, form, token=token)[0], 401, f'{method} {path}')
        self.assertEqual(list(mock.DRAFTS), [did])  # без входу нічого не створено, не видалено, не перетворено
        self.assertNotIn(did, mock.DB)

    # ---- GET список
    def test_list_empty(self):
        st, page = self.call('GET', '/api/invoice-payment-drafts?page=1&per_page=100')
        self.assertEqual(st, 200)
        self.assertEqual(page, {'current_page': 1, 'data': [], 'last_page': 1, 'per_page': 100, 'total': 0})

    def test_list_pages_newest_first(self):
        ids = [self.call('POST', '/api/invoice-payment-drafts', {**REC, 'comment': f'чернетка {i}'})[1]['id'] for i in range(5)]
        st, p1 = self.call('GET', '/api/invoice-payment-drafts?page=1&per_page=2')
        self.assertEqual((st, p1['current_page'], p1['last_page'], p1['per_page'], p1['total']), (200, 1, 3, 2, 5))
        self.assertEqual([d['id'] for d in p1['data']], ids[::-1][:2])
        p3 = self.call('GET', '/api/invoice-payment-drafts?page=3&per_page=2')[1]
        self.assertEqual([d['id'] for d in p3['data']], [ids[0]])
        self.assertEqual(self.call('GET', '/api/invoice-payment-drafts?page=4&per_page=2')[1]['data'], [])
        d = p1['data'][0]
        self.assertEqual((d['status'], d['files'], d['data']['comment']), ('draft', [], 'чернетка 4'))
        self.assertEqual(self.call('GET', '/api/invoice-payment-drafts')[1]['total'], 5)  # без параметрів — перша сторінка

    def test_list_ignores_filters(self):
        self.call('POST', '/api/invoice-payment-drafts', REC)
        self.call('POST', '/api/invoice-payment-drafts', XFER)
        q = urllib.parse.urlencode({'page': 1, 'per_page': 100, 'date_from': '01-01-2020', 'date_to': '02-01-2020', 'amount_from': '999999', 'amount_to': '999999', 'invoice_ids[]': 1})
        st, page = self.call('GET', '/api/invoice-payment-drafts?' + q)
        self.assertEqual((st, page['total'], len(page['data'])), (200, 2, 2))

    def test_list_per_page_over_100_is_422(self):
        st, err = self.call('GET', '/api/invoice-payment-drafts?page=1&per_page=101')
        self.assertEqual(st, 422)
        self.assertEqual(err['message'], 'Validation error')
        self.assertIn('per_page', err['errors'])
        self.assertEqual(self.call('GET', '/api/invoice-payment-drafts?page=1&per_page=100')[0], 200)

    # ---- GET / DELETE за ID
    def test_get_by_id_and_404(self):
        did = self.call('POST', '/api/invoice-payment-drafts', REC)[1]['id']
        st, d = self.call('GET', f'/api/invoice-payment-drafts/{did}')
        self.assertEqual((st, d['id'], d['status'], d['data']), (200, did, 'draft', REC))
        self.assertIn('history', d)
        self.assertEqual(self.call('GET', '/api/invoice-payment-drafts/999999'), (404, {'message': 'Запис не знайдено'}))
        self.assertEqual(self.call('GET', '/api/invoice-payment-drafts/27230'), (404, {'message': 'Запис не знайдено'}))  # ID запису — не чернетка

    def test_delete(self):
        did = self.call('POST', '/api/invoice-payment-drafts', REC)[1]['id']
        self.assertEqual(self.call('DELETE', f'/api/invoice-payment-drafts/{did}'), (204, None))
        self.assertEqual(self.call('GET', f'/api/invoice-payment-drafts/{did}')[0], 404)
        self.assertEqual(self.call('GET', '/api/invoice-payment-drafts')[1]['total'], 0)
        self.assertEqual(self.call('DELETE', f'/api/invoice-payment-drafts/{did}'), (404, {'message': 'Запис не знайдено'}))
        self.assertEqual(self.call('DELETE', '/api/invoice-payment/27230')[0], 404)  # записів мок не видаляє
        self.assertIn(27230, mock.DB)
        self.assertGreater(self.call('POST', '/api/invoice-payment-drafts', REC)[1]['id'], did)  # ID видаленої вдруге не видається

    # ---- чернетки — не записи
    def test_drafts_are_invisible_to_live_api_and_balance(self):
        before, total = self.balance(), self.live()['total']
        did = self.call('POST', '/api/invoice-payment-drafts', REC)[1]['id']
        tid = self.call('POST', '/api/invoice-payment-drafts', XFER)[1]['id']
        self.assertEqual(self.balance(), before)
        self.assertEqual(self.balance(68), 0)
        page = self.live()
        self.assertEqual(page['total'], total)
        self.assertFalse({did, tid} & {r['id'] for r in page['data']})
        for i in (did, tid):
            self.assertEqual(self.call('GET', f'/api/invoice-payment/{i}'), (404, {'message': 'Запис не знайдено'}))
        accs = self.call('GET', '/api/invoice?page=1&per_page=100')[1]['data']  # список рахунків із залишками — теж без чернеток
        self.assertEqual({a['id']: a['balance'] for a in accs}, {33: before, 68: 0})

    # ---- convert
    def test_convert_record_keeps_id_and_changes_balance(self):
        before = self.balance()
        did = self.call('POST', '/api/invoice-payment-drafts', {**REC, 'amount': '40.25'})[1]['id']
        st, out = self.call('POST', f'/api/invoice-payment-drafts/{did}/convert')
        self.assertEqual(st, 200)
        r = out['data']
        self.assertEqual((r['id'], r['comment'], len(r['payments'])), (did, REC['comment'], 1))
        p = r['payments'][0]
        self.assertEqual((p['invoice_id'], p['operation'], p['pnl_category_id'], p['pnl_operation_id'], p['amount']), (33, 2, 59, 55, 40.25))
        self.assertEqual(self.call('GET', f'/api/invoice-payment-drafts/{did}')[0], 404)  # чернетки більше немає
        self.assertEqual(self.call('GET', '/api/invoice-payment-drafts')[1]['total'], 0)
        st, got = self.call('GET', f'/api/invoice-payment/{did}')
        self.assertEqual((st, got['id']), (200, did))
        self.assertIn(did, {x['id'] for x in self.live()['data']})
        self.assertEqual(self.balance(), round(before - 40.25, 2))
        self.assertEqual(self.call('POST', f'/api/invoice-payment-drafts/{did}/convert'), (404, {'message': 'Запис не знайдено'}))  # удруге — ні

    def test_convert_matches_direct_post(self):
        """Перетворена чернетка = запис, створений тими самими полями напряму (крім ID)."""
        did = self.call('POST', '/api/invoice-payment-drafts', {**REC, 'pnl_category_id': '20', 'pnl_operation_id': '30', 'marketer_id': '208'})[1]['id']
        conv = self.call('POST', f'/api/invoice-payment-drafts/{did}/convert')[1]['data']
        direct = self.call('POST', '/api/invoice-payment', {**REC, 'pnl_category_id': '20', 'pnl_operation_id': '30', 'marketer_id': '208'})[1]['data']
        strip = lambda r: json.dumps(r, ensure_ascii=False, sort_keys=True).replace(str(r['id']), 'ID')  # payments[].id = ID запису × 10
        self.assertEqual(strip(conv), strip(direct))
        self.assertEqual(conv['marketer_balance_history'], {'marketer_balance': {'user_id': 208}})

    def test_convert_transfer(self):
        tid = self.call('POST', '/api/invoice-payment-drafts', XFER)[1]['id']
        b33, b68 = self.balance(33), self.balance(68)
        st, out = self.call('POST', f'/api/invoice-payment-drafts/{tid}/convert')
        self.assertEqual(st, 200)
        self.assertEqual(out['data']['id'], tid)
        self.assertEqual(sorted((p['invoice_id'], p['operation']) for p in out['data']['payments']), [(33, 4), (68, 3)])
        self.assertEqual((self.balance(33), self.balance(68)), (round(b33 - 250.5, 2), round(b68 + 250.5, 2)))

    def test_convert_closed_month_is_422_and_keeps_draft(self):
        did = self.call('POST', '/api/invoice-payment-drafts', {**REC, 'date': '20-10-2026 10:00', 'period': '01-10-2026'})[1]['id']  # чернетку закритого місяця CRM приймає
        mock.CLOSED.add('2026-10')
        before = self.balance()
        st, err = self.call('POST', f'/api/invoice-payment-drafts/{did}/convert')
        self.assertEqual((st, err['message']), (422, mock.CLOSED_MSG))
        self.assertIn('period', err['errors'])
        self.assertEqual(self.call('POST', '/api/invoice-payment', {**REC, 'period': '01-10-2026'})[0], 422)  # та сама перевірка, що й у записів
        self.assertEqual(self.call('GET', f'/api/invoice-payment-drafts/{did}')[0], 200)
        self.assertNotIn(did, mock.DB)
        self.assertEqual(self.balance(), before)

    def test_convert_validations_same_as_live_post(self):
        no_mk = self.call('POST', '/api/invoice-payment-drafts', {**REC, 'pnl_category_id': '20', 'pnl_operation_id': '30'})[1]['id']  # стаття з маркетологом без marketer_id
        st, err = self.call('POST', f'/api/invoice-payment-drafts/{no_mk}/convert')
        self.assertEqual(st, 422)
        self.assertIn('marketer_id', err['message'])
        bad = self.call('POST', '/api/invoice-payment-drafts', {k: v for k, v in REC.items() if k != 'invoice_id'})[1]['id']  # неповна чернетка
        self.assertEqual(self.call('POST', f'/api/invoice-payment-drafts/{bad}/convert')[0], 422)
        self.assertEqual(sorted(mock.DRAFTS), [no_mk, bad])
        self.assertFalse({no_mk, bad} & set(mock.DB))

    # ---- решта моку працює, як раніше
    def test_live_post_unchanged(self):
        st, out = self.call('POST', '/api/invoice-payment', REC)
        self.assertEqual((st, out['data']['id'], out['data']['payments'][0]['invoice']['id']), (200, 27231, 33))
        st, out = self.call('POST', '/api/invoice-payment', XFER)
        self.assertEqual((st, out['data']['id'], len(out['data']['payments'])), (200, 27232, 2))
        self.assertEqual(self.call('POST', '/api/invoice-payment', {'operation': '2'})[0], 422)
        self.assertEqual(self.call('POST', '/api/invoice-payment', REC, token=None)[0], 401)
        self.assertEqual(self.call('GET', '/api/invoice-payment-drafts')[1]['total'], 0)  # записи — не чернетки

    def test_registry_reset_clears_drafts(self):
        did = self.call('POST', '/api/invoice-payment-drafts', REC)[1]['id']
        mock.REG['old'] = [dict(a) for a in mock.REF['accounts']]
        st, out = self.call('GET', '/registry/reset', token=None)
        self.assertEqual((st, out['ok']), (200, True))
        self.assertEqual(self.call('GET', '/api/invoice-payment-drafts')[1]['total'], 0)
        self.assertEqual(self.call('POST', '/api/invoice-payment-drafts', REC)[1]['id'], did)  # послідовність — знову від найбільшого ID запису


if __name__ == '__main__':
    unittest.main()
