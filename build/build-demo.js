/* Збірка для демо-сторінки docs/index.html (GitHub Pages, без сервера і без «Помічника»):
   - docs/demo/cashflow_linter.demo.js — та сама панель, що й у dist/, але без підпису, а перевірка «відкрито саме сайт CRM»
     замінена на «відкрито демо-сторінку» (window.CF_DEMO === true). У робочій збірці (build.js) перевірка домену лишається;
   - docs/demo/reference.js — довідник статей і проєктів з rules/rules.json для вигаданого CRM.
   Запуск: node build\build-demo.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { bundle } = require('./build.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'demo');
const HOST_CHECK = String.raw`/(^|\.)crm\.example\.com$/.test(location.hostname)`;
const DEMO_CHECK = 'window.CF_DEMO === true';

function demoBundle() {
  const code = bundle();
  if (!code.includes(HOST_CHECK)) throw new Error('не знайдено перевірку домену в bookmarklet/main.js');
  return '/* ДЕМО-ЗБІРКА: працює лише на демо-сторінці з вигаданими даними (docs/index.html). */\n' + code.split(HOST_CHECK).join(DEMO_CHECK);
}
function reference() {
  const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules', 'rules.json'), 'utf8')).reference;
  return `/* Довідник статей і проєктів для демо (з rules/rules.json; створено build/build-demo.js). */\nwindow.CF_DEMO_REF = ${JSON.stringify({ articles: r.articles, projects: r.projects })};\n`;
}
function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const code = demoBundle();
  new Function(code.replace(/^\/\*[\s\S]*?\*\//, '')); // перевірка синтаксису
  fs.writeFileSync(path.join(OUT, 'cashflow_linter.demo.js'), code, 'utf8');
  fs.writeFileSync(path.join(OUT, 'reference.js'), reference(), 'utf8');
  console.log(`docs/demo: cashflow_linter.demo.js ${code.length} символів, reference.js`);
}
if (require.main === module) main();
module.exports = { demoBundle, reference, HOST_CHECK, DEMO_CHECK };
