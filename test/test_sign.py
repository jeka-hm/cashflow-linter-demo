"""Підпис збірки (build/sign.py): ECDSA P-256 + SHA-256 з k за RFC 6979, ключі, захист від підпису «чужим» ключем.
Запуск (з кореня проєкту): python -m unittest discover -s test -p "test_*.py"
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'build'))
import sign  # noqa: E402

NODE = Path(shutil.which('node') or ROOT / 'tools' / 'node' / 'node.exe')  # Node.js з PATH
# RFC 6979, додаток A.2.5: P-256, SHA-256
RFC_D = 0xC9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721
RFC_U = (0x60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6, 0x7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299)
RFC_SIG = {b'sample': (0xEFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716, 0xF7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8),
           b'test': (0xF1ABB023518351CD71D881567B1EA663ED3EFCF6C5132B354F28D3B0B7D38367, 0x019F4113742A2B14BD25926B49C649155F267E60D3814B4C0CC84250E46F0083)}


class SignTest(unittest.TestCase):
    def test_rfc6979_vectors(self):
        self.assertEqual(sign._mul(RFC_D, sign.G), RFC_U)
        for msg, (r, s) in RFC_SIG.items():
            sig = sign.sign(RFC_D, msg)
            self.assertEqual((int.from_bytes(sig[:32], 'big'), int.from_bytes(sig[32:], 'big')), (r, s), msg)
            self.assertTrue(sign.verify(RFC_U, msg, sig))

    def test_tampering_fails(self):
        sig = sign.sign(RFC_D, b'sample')
        self.assertFalse(sign.verify(RFC_U, b'sample!', sig))
        self.assertFalse(sign.verify(RFC_U, b'sample', sig[:-1] + bytes([sig[-1] ^ 1])))
        self.assertFalse(sign.verify(RFC_U, b'sample', b'\x00' * 64))
        self.assertFalse(sign.verify((RFC_U[0], RFC_U[1] + 1), b'sample', sig))  # точка не на кривій
        self.assertFalse(sign.verify_b64(sign.public_jwk(RFC_D), b'sample', 'не base64!'))

    def test_jwk_roundtrip(self):
        jwk = sign.public_jwk(RFC_D)
        self.assertEqual(sign.jwk_point(jwk), RFC_U)
        self.assertTrue(sign.verify_b64(jwk, b'x', sign.sign_b64(RFC_D, b'x')))

    @unittest.skipUnless(NODE.is_file(), 'немає Node.js (node) у PATH')
    def test_browser_webcrypto_accepts_signature(self):
        """Той самий алгоритм, що й у закладці: WebCrypto (Node) перевіряє підпис, зроблений тут."""
        msg = 'Лінтер ✓\r\n'.encode('utf-8') * 100
        js = ("const [jwk,m,s]=JSON.parse(require('fs').readFileSync(0,'utf8'));const c=require('crypto').webcrypto.subtle;"
              "(async()=>{const k=await c.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);"
              "const v=x=>c.verify({name:'ECDSA',hash:'SHA-256'},k,Buffer.from(s,'base64'),Buffer.from(x,'base64'));"
              "console.log(JSON.stringify([await v(m),await v(m.slice(4))]))})()")
        out = subprocess.run([str(NODE), '-e', js], input=json.dumps([sign.public_jwk(RFC_D), base64.b64encode(msg).decode(), sign.sign_b64(RFC_D, msg)]),
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(json.loads(out.stdout), [True, False], out.stderr)


class KeyFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.key, self.pub = self.tmp / 'key' / 'signing-key.json', self.tmp / 'signing-public.json'
        p = mock.patch.dict(os.environ, {'CFL_SIGNING_KEY': str(self.key)})
        p.start()
        self.addCleanup(p.stop)

    def test_first_run_creates_pair(self):
        with mock.patch('builtins.print'):
            d = sign.load_key(public=self.pub)
        self.assertTrue(self.key.is_file())
        self.assertEqual(sign.load_public(self.pub), sign.public_jwk(d))
        self.assertNotIn('"d"', self.pub.read_text(encoding='utf-8'))
        self.assertEqual(sign.load_key(public=self.pub), d)

    def test_refuses_without_private_key_when_public_exists(self):
        """Комп'ютер колеги: відкритий ключ є, приватного немає — збірка не створює новий ключ мовчки."""
        self.pub.write_text(json.dumps(sign.public_jwk(RFC_D)), encoding='utf-8')
        with self.assertRaises(SystemExit) as e:
            sign.load_key(public=self.pub)
        self.assertIn('немає ключа підпису', str(e.exception))
        self.assertFalse(self.key.exists())

    def test_refuses_mismatched_key(self):
        with mock.patch('builtins.print'):
            sign.load_key(public=self.pub)
        self.pub.write_text(json.dumps(sign.public_jwk(RFC_D)), encoding='utf-8')
        with self.assertRaises(SystemExit) as e:
            sign.load_key(public=self.pub)
        self.assertIn('не відповідає', str(e.exception))

    def test_new_key_replaces_and_keeps_old(self):
        with mock.patch('builtins.print'):
            d1 = sign.load_key(public=self.pub)
            d2 = sign.load_key(new=True, public=self.pub)
        self.assertNotEqual(d1, d2)
        self.assertEqual(sign.load_public(self.pub), sign.public_jwk(d2))
        self.assertEqual(len(list(self.key.parent.glob('signing-key.*.old.json'))), 1)


if __name__ == '__main__':
    unittest.main()
