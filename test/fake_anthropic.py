"""Підробний клієнт Claude API для тестів ШІ-підказок (без мережі й без пакета anthropic): та сама форма, що й
messages.stream(...).get_final_message() і messages.count_tokens(...) у справжньому SDK.
Підказки: стаття — за ключовими словами коментаря (Hetzner → Інфраструктура, оренда → Офіс…), проєкт — за країною в коментарі;
інакше «згоден» (поточна стаття). Чернетка правил — одне правило для Hetzner. Ключ, у якому є «bad», — помилка 401."""
import json
import re
import time
from types import SimpleNamespace

CALLS = []                 # (що викликано, аргументи) — тести перевіряють, що й скільки пішло в Claude
FAIL = {'next': None}      # виняток для наступного stream()
DELAY = {'s': 0}           # с «роздумів» на запит (мок CRM: видно стан «ШІ думає…»)
KEYWORDS = [(r'(?i)hetzner|сервер|хостинг|домен', 'Інфраструктура', 'висока'), (r'(?i)оренд|офіс|прибиран', 'Офіс', 'висока'),
            (r'(?i)юрист|нотаріус|адвокат', 'Юридичні та комплаєнс', 'середня'), (r'(?i)квиток|готель|відрядж', 'Відрядження', 'середня')]
PROJECTS = [(r'(?i)польщ|warszaw|polsk', 'Польща'), (r'(?i)\bсша\b|\busa\b', 'США'), (r'(?i)британ|london|\buk\b', 'Велика Британія')]


class ApiError(Exception):
    def __init__(self, status_code, message):
        super().__init__(message)
        self.status_code, self.message = status_code, message


class _Stream:
    def __init__(self, msg):
        self.msg = msg

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.msg


def _msg(text, usage=(1000, 200, 0, 0), stop='end_turn'):
    u = SimpleNamespace(input_tokens=usage[0], output_tokens=usage[1], cache_creation_input_tokens=usage[2], cache_read_input_tokens=usage[3])
    return SimpleNamespace(stop_reason=stop, content=[SimpleNamespace(type='thinking', thinking=''), SimpleNamespace(type='text', text=text)], usage=u)


class _Messages:
    def __init__(self, key):
        self.key = key

    def count_tokens(self, **kw):
        CALLS.append(('count_tokens', kw))
        if 'bad' in (self.key or ''):
            raise ApiError(401, 'invalid x-api-key')
        return SimpleNamespace(input_tokens=7)

    def stream(self, **kw):
        CALLS.append(('stream', kw))
        if 'bad' in (self.key or ''):
            raise ApiError(401, 'invalid x-api-key')
        if FAIL['next']:
            e, FAIL['next'] = FAIL['next'], None
            raise e
        time.sleep(DELAY['s'])
        props = kw['output_config']['format']['schema']['properties']
        return _Stream(_msg(self._hints(kw) if 'items' in props else self._match(kw) if 'matches' in props else self._draft(kw)))

    @staticmethod
    def _match(kw):
        """«Зіставлення ШІ»: погодження, отримувач якого (перше слово, від 4 літер) є в отримувачі чи призначенні операції."""
        data = json.loads(kw['messages'][-1]['content'])
        out, used = [], set()
        for b in data['bank']:
            hay = f"{b.get('cpty', '')} {b.get('text', '')}".lower()
            for a in data['approvals']:
                w = (re.findall(r'[^\W\d_]{4,}', a.get('recipient', '').lower()) or [''])[0]
                if a['key'] not in used and w and w in hay:
                    used.add(a['key'])
                    out.append({'bank': b['id'], 'approvals': [a['key']], 'confidence': 'середня', 'why': f"{a['recipient']}: ім'я в операції банку"})
                    break
        return json.dumps({'matches': out}, ensure_ascii=False)

    @staticmethod
    def _hints(kw):
        system = kw['system'][0]['text'] if isinstance(kw['system'], list) else kw['system']
        codes = {}
        for line in system.splitlines():
            m = re.match(r'^(\d+:\d+) — (.+) — (дохід|витрата|будь-який)$', line)
            if m:
                codes[m.group(2)] = m.group(1)
        items = []
        for r in json.loads(kw['messages'][-1]['content'])['records']:
            art, conf, why = '?', 'низька', 'з коментаря статтю не визначити'
            for pat, word, c in KEYWORDS:
                if re.search(pat, r['cmt']):
                    art = next((code for lab, code in codes.items() if lab.endswith('/ ' + word)), '?')
                    conf, why = c, f'у коментарі — {word.lower()}'
                    break
            else:
                cur = re.match(r'^(\d+:\d+) ', r['art'] + ' ')
                if cur and cur.group(1) in codes.values():
                    art, conf, why = cur.group(1), 'середня', 'поточна стаття правдоподібна'
            prj = next((p for pat, p in PROJECTS if re.search(pat, r['cmt'])), '?')
            items.append({'n': r['n'], 'article': art, 'project': prj, 'confidence': conf, 'why': why})
        return json.dumps({'items': items}, ensure_ascii=False)

    @staticmethod
    def _draft(kw):
        recs = json.loads(kw['messages'][-1]['content'])['records']
        ex = [r['n'] for r in recs if re.search(r'(?i)hetzner', r['cmt'])]
        if not ex:
            return json.dumps({'summary': 'Повторюваних випадків без правил не знайдено.', 'rules': []}, ensure_ascii=False)
        rule = {'id': 'R-AI-HETZNER-01', 'group': 'Статті', 'title': 'Hetzner → Інфраструктура', 'priority': 100, 'effective_from': '2026-09-01',
                'match': {'type': 'expense', 'comment_regex': '(?i)hetzner'}, 'set': {'category': 'Інфраструктура'}, 'mode': 'review'}
        # зміна чинного правила (з 05.11.2026): той самий id і replaces — як просить інструкція
        wider = {'id': 'R-INFRA-01', 'group': 'Статті', 'title': 'Інфраструктура ширше', 'priority': 100,
                 'match': {'type': 'expense', 'comment_regex': '(?i)hetzner|digitalocean'}, 'set': {'category': 'Інфраструктура'}, 'mode': 'review'}
        return json.dumps({'summary': f'Hetzner повторюється в {len(ex)} записах без правила.', 'rules': [
            {'title': rule['title'], 'rule_json': json.dumps(rule, ensure_ascii=False), 'replaces': '', 'why': 'усі записи Hetzner — оплата серверів', 'examples': ex[:5], 'covers': len(ex)},
            {'title': 'Зламане правило', 'rule_json': '{не json', 'replaces': '', 'why': 'для перевірки розбору', 'examples': [], 'covers': 0},
            {'title': wider['title'], 'rule_json': json.dumps(wider, ensure_ascii=False), 'replaces': 'R-INFRA-01', 'why': 'та сама стаття, ширша умова', 'examples': ex[:1], 'covers': 1}]},
            ensure_ascii=False)


class FakeClient:
    def __init__(self, key):
        self.messages = _Messages(key)


def make_client(key):
    return FakeClient(key)
