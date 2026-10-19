import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const C = createRequire(import.meta.url)('../src/core/transcript-core.js');

test('parses a pasted YouTube transcript into timed segments', () => {
  const items = C.parseTranscriptText('0:00\nwelcome to the show\n0:05\ntoday we talk payments\n1:02:03\nthanks');
  assert.deepEqual(
    items.map((i) => [i.start, i.text]),
    [
      [0, 'welcome to the show'],
      [5, 'today we talk payments'],
      [3723, 'thanks']
    ]
  );
});

test('cleaning removes fillers, stutters and sound tags', () => {
  const items = C.parseTranscriptText('0:00\nso um the the thing is [Music] we started\n0:05\nlooking at uh payments');
  const [unit] = C.buildUnits(items, { removeFillers: true, removeTags: true });
  assert.equal(unit.text, 'So the thing is we started looking at payments');
});

test('timestamps round-trip', () => {
  assert.equal(C.secToTs(3723), '1:02:03');
  assert.equal(C.tsToSec('1:02:03'), 3723);
  assert.equal(C.tsToSec('0:05'), 5);
});

test('company names are highlighted as whole words only', () => {
  const matcher = C.companyMatcher([{ name: 'Stripe' }, { name: 'Visa' }]);
  const parts = C.splitHighlights('We use Stripe and Visa, not Visage.', matcher);
  assert.deepEqual(
    parts.filter((p) => p.company != null).map((p) => p.text),
    ['Stripe', 'Visa']
  );
});

test('guessLanguage identifies languages offline from the text itself', () => {
  const twice = (s) => `${s} ${s}`;
  const samples = {
    en: 'So the thing that really surprised me when we started looking at payments is that most of the cost is not in the network itself, it is in all the stuff around it.',
    es: 'Entonces lo que más me sorprendió cuando empezamos a mirar los pagos es que la mayor parte del costo no está en la red, sino en todo lo que hay alrededor.',
    fr: "Alors ce qui m'a le plus surpris quand on a commencé à regarder les paiements, c'est que la plupart des coûts ne sont pas dans le réseau lui-même.",
    de: 'Was mich am meisten überrascht hat, als wir uns die Zahlungen angesehen haben, ist, dass die meisten Kosten nicht im Netzwerk selbst liegen, sondern in allem drumherum.',
    pt: 'Então o que mais me surpreendeu quando começamos a olhar para os pagamentos é que a maior parte do custo não está na rede, mas em tudo o que está em volta.',
    ru: 'Больше всего меня удивило, когда мы начали смотреть на платежи, что большая часть затрат находится не в самой сети, а во всём, что вокруг неё.',
    uk: 'Найбільше мене здивувало, коли ми почали дивитися на платежі, що більша частина витрат не в самій мережі, а в усьому, що навколо неї.',
    ja: '支払いについて調べ始めたとき、一番驚いたのは、コストのほとんどがネットワーク自体ではなく、その周りのすべてにあるということでした。',
    zh: '我们开始研究支付的时候，最让我惊讶的是，大部分成本不在网络本身，而在它周围的所有东西上。',
    'zh-Hant': '我們開始研究支付的時候，最讓我驚訝的是，大部分成本不在網絡本身，而在它周圍的所有東西上。',
    ko: '우리가 결제를 살펴보기 시작했을 때 가장 놀라웠던 점은 비용의 대부분이 네트워크 자체가 아니라 그 주변의 모든 것에 있다는 것이었습니다.'
  };
  for (const [lang, text] of Object.entries(samples)) assert.equal(C.guessLanguage(twice(text)), lang, lang);
  assert.equal(C.guessLanguage('too short'), '');
});

test('pickLanguage maps browser locales to supported languages', () => {
  assert.equal(C.pickLanguage('es-MX'), 'es');
  assert.equal(C.pickLanguage('zh-TW'), 'zh-Hant');
  assert.equal(C.pickLanguage('nb'), 'no');
  assert.equal(C.pickLanguage('sw'), '');
});

test('sameLanguage treats regional variants as the same, but not Chinese scripts', () => {
  assert.equal(C.sameLanguage('pt', 'pt-BR'), true);
  assert.equal(C.sameLanguage('zh', 'zh-Hant'), false);
});

test('analysis language is added to the prompt only when not English', () => {
  const units = [{ text: 'hello there' }];
  assert.ok(!C.buildCombinedRequest({ title: 't' }, units, '', 'en').system.includes('Write every text field'));
  assert.ok(C.buildCombinedRequest({ title: 't' }, units, '', 'es').system.includes('in Spanish'));
  assert.ok(C.buildChatPrompt({ title: 't' }, 'hello', '', false, 'fr').includes('Write your answer in French'));
});

test('translation requests are chunked, skip blank paragraphs and keep numbering', () => {
  const texts = ['one two three', '', 'four five'];
  const reqs = C.buildTranslateRequests(texts, 'en', 'es', 4);
  assert.deepEqual(
    reqs.map((r) => r.idx),
    [[0], [2]]
  );
  assert.match(reqs[1].req.user, /^\[3\] four five$/);
  assert.equal(reqs[0].req.tool.name, 'report_translation');
});
