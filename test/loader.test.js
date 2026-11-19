// Закладка-завантажувач (bookmarklet/loader.js): виконує лише підписаний код, з двох джерел бере новіший, інакше просить файл.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { loaderSource, signCode } = require('../build/build.js');

const pair = () => { const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); return [privateKey.export({ format: 'jwk' }), publicKey.export({ format: 'jwk' })]; };
const [priv, pub] = pair(), [otherPriv] = pair();
const code = (build, tag) => `globalThis.__ran.push(${JSON.stringify(tag)});\nvar CF_BUILD = '${build}';\n`;
const signed = (build, tag, key = priv) => signCode(code(build, tag), key);
const tick = () => new Promise(r => setTimeout(r, 5));

// мінімальна IndexedDB: open → transaction → objectStore(get/put/delete), події — асинхронно, як у браузері
function fakeIDB(data) {
  return {
    open() {
      const r = {};
      setTimeout(() => {
        r.result = {
          transaction() {
            const t = {}, s = { get: k => ({ result: data[k] }), put: (v, k) => { data[k] = v; return {}; }, delete: k => { delete data[k]; return {}; } };
            t.objectStore = () => s;
            setTimeout(() => t.oncomplete && t.oncomplete());
            return t;
          },
        };
        if (r.onsuccess) r.onsuccess();
      });
      return r;
    },
  };
}

// запускає закладку в «сторінці» з підробленими браузерними API; повертає, що сталося
async function run({ host = 'crm.example.com', idb = {}, helper, ls = {}, cfg = { APPLY: false } } = {}) {
  const seen = { fetched: [], alerts: [], overlay: 0 };
  globalThis.__ran = [];
  globalThis.window = globalThis;
  delete globalThis.CF_LINTER_CONFIG;
  globalThis.location = { hostname: host };
  globalThis.localStorage = { getItem: k => (k in ls ? ls[k] : null) };
  globalThis.indexedDB = fakeIDB(idb);
  globalThis.alert = m => seen.alerts.push(m);
  globalThis.fetch = async url => { seen.fetched.push(url); if (helper === undefined) throw new TypeError('Failed to fetch'); return { ok: true, text: async () => helper }; };
  const el = () => ({ style: {}, remove() {}, querySelector: () => el() });
  globalThis.document = { getElementById: () => null, createElement: el, body: { appendChild: () => { seen.overlay++; } } };
  const done = (0, eval)(loaderSource(cfg, pub).replace(/^void /, ''));
  await Promise.race([done, (async () => { for (let i = 0; i < 100 && !seen.overlay; i++) await tick(); })()]);
  await tick();
  return { ...seen, ran: globalThis.__ran, cfg: globalThis.CF_LINTER_CONFIG, idb };
}

test('Помічник віддає підписаний лінтер — виконується й зберігається в браузері', async () => {
  const r = await run({ helper: signed('2026-10-26T10:00:00Z', 'helper') });
  assert.deepEqual(r.ran, ['helper']);
  assert.deepEqual(r.cfg, { APPLY: false });
  assert.equal(r.fetched[0], 'http://127.0.0.1:8765/dist/cashflow_linter.js');
  assert.ok(r.idb.signed.includes("'2026-10-26T10:00:00Z'"));
  assert.equal(r.overlay, 0);
});

test('адреса Помічника — з тих самих налаштувань, що й у вкладки «Звірка з банком»', async () => {
  const r = await run({ helper: signed('2026-10-26T10:00:00Z', 'h'), ls: { cfl_helper_url: JSON.stringify('http://127.0.0.1:9000/helper/') } });
  assert.equal(r.fetched[0], 'http://127.0.0.1:9000/helper/dist/cashflow_linter.js');
});

test('з двох джерел виконується новіша збірка', async () => {
  const older = signed('2026-10-20T10:00:00Z', 'old'), newer = signed('2026-10-26T10:00:00Z', 'new');
  let r = await run({ idb: { signed: newer }, helper: older, cfg: { APPLY: true } });
  assert.deepEqual(r.ran, ['new']);
  assert.deepEqual(r.cfg, { APPLY: true });
  assert.equal(r.idb.signed, newer, 'старіша з Помічника не замінює збережену');
  r = await run({ idb: { signed: older }, helper: newer });
  assert.deepEqual(r.ran, ['new']);
  assert.equal(r.idb.signed, newer, 'новіша з Помічника зберігається');
});

test('Помічник не запущений — працює збережена копія; копія закладки попередньої версії видаляється', async () => {
  const r = await run({ idb: { signed: signed('2026-10-26T10:00:00Z', 'cached'), bundle: 'стара копія' } });
  assert.deepEqual(r.ran, ['cached']);
  assert.equal('bundle' in r.idb, false);
});

test('код з чужим підписом або змінений після підпису не виконується', async () => {
  const good = signed('2026-10-20T10:00:00Z', 'good');
  const forged = signed('2026-10-30T10:00:00Z', 'forged', otherPriv);
  const tampered = signed('2026-10-30T10:00:00Z', 'x').replace("push(\"x\")", "push(\"evil\")");
  for (const bad of [forged, tampered, code('2026-10-30T10:00:00Z', 'unsigned')]) {
    const r = await run({ idb: { signed: good }, helper: bad });
    assert.deepEqual(r.ran, ['good']);
    assert.equal(r.idb.signed, good);
  }
});

test('немає жодного дійсного джерела — просить вибрати файл, нічого не виконує', async () => {
  const r = await run({ idb: { signed: signed('2026-10-26T10:00:00Z', 'x', otherPriv) } });
  assert.deepEqual(r.ran, []);
  assert.equal(r.overlay, 1);
});

test('не на сторінці CRM — лише попередження', async () => {
  const r = await run({ host: 'example.com', helper: signed('2026-10-26T10:00:00Z', 'h') });
  assert.deepEqual(r.ran, []);
  assert.equal(r.fetched.length, 0);
  assert.match(r.alerts[0], /crm\.example\.com/);
});

test('закладка не залежить від збірки і вміщається в межу Firefox', () => {
  const a = loaderSource({ APPLY: false }, pub), b = loaderSource({ APPLY: false }, { ...pub, d: 'секрет не потрапляє в закладку' });
  assert.equal(a, b);
  assert.ok(!a.includes('секрет'));
  assert.ok(encodeURIComponent(a).length < 20000);
});
