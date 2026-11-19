// 字幕オフスクリプトの必須テスト。実行：npm test
// fixtures/player.html は、iPhone Safari で YouTube が行う字幕処理を再現した模擬プレイヤー。
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'youtube-captions-off.user.js'), 'utf8');
const FIX = path.join(__dirname, 'fixtures');
const ORIGIN = 'https://m.youtube.com';
const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n字幕テキスト\n';

let browser;
before(async () => {
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(() => browser.close());

async function open(withScript) {
  const page = await browser.newPage();
  const net = { vtt: 0, external: 0 };
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) { net.external++; return route.abort(); }
    if (url.pathname.endsWith('.vtt')) { net.vtt++; return route.fulfill({ contentType: 'text/vtt', body: VTT }); }
    return route.fulfill({ path: path.join(FIX, path.basename(url.pathname)) });
  });
  if (withScript) await page.addInitScript(SCRIPT);
  await page.goto(ORIGIN + '/player.html');
  return { page, net };
}

// 再生しながら見張り、1度でも字幕が出たら数える
function watch(page, ms = 1000) {
  return page.evaluate(async (ms) => {
    const v = mock.video;
    await v.play().catch(() => {});
    let shown = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      for (const t of v.textTracks) if (t.mode === 'showing' || (t.activeCues && t.activeCues.length)) shown++;
      const seg = document.querySelector('.ytp-caption-segment');
      if (seg && seg.getClientRects().length) shown++;
      await new Promise((r) => setTimeout(r, 20));
    }
    return { shown, playerTrack: mock.playerTrack, played: v.currentTime > 0.3 };
  }, ms);
}

const OFF = { shown: 0, playerTrack: null, played: true };

test('対照：スクリプトなしでは字幕が出る（テストが字幕を検出できる）', async () => {
  const { page } = await open(false);
  await page.evaluate(() => { mock.createVideo(); mock.loadVideo('v1'); });
  const r = await watch(page);
  assert.ok(r.shown > 0 && r.playerTrack === 'v1.ja');
  await page.close();
});

test('要件どおり字幕がオフのまま保たれる', async (t) => {
  const { page, net } = await open(true);

  await t.test('動画を開いても字幕が出ず、プレイヤーも字幕オフになる', async () => {
    await page.evaluate(() => { mock.createVideo(); mock.loadVideo('v1'); });
    assert.deepEqual(await watch(page), OFF);
    assert.equal(net.vtt, 0, '字幕ファイルを読み込ませない');
  });

  await t.test('全画面の標準プレイヤー側で字幕をオンにされてもオフに戻る', async () => {
    await page.evaluate(() => {
      mock.video.dispatchEvent(new Event('webkitbeginfullscreen'));
      mock.video.textTracks[1].mode = 'showing';
    });
    assert.deepEqual(await watch(page), OFF);
  });

  await t.test('次の動画へ移っても字幕が出ない（同じ video 要素）', async () => {
    const vtt = net.vtt;
    await page.evaluate(() => { history.pushState({}, '', '/watch?v=v2'); mock.loadVideo('v2'); });
    assert.deepEqual(await watch(page), OFF);
    assert.equal(net.vtt - vtt, 0);
  });

  await t.test('おすすめへ移っても字幕が出ない（video 要素の差し替え）', async () => {
    await page.evaluate(() => { history.pushState({}, '', '/watch?v=v3'); mock.replaceVideo(); mock.loadVideo('v3'); });
    assert.deepEqual(await watch(page), OFF);
  });

  await t.test('何度オンにされても戻し、無限ループにならない', async () => {
    const before = await page.evaluate(() => mock.changeEvents);
    await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) { mock.video.textTracks[0].mode = 'showing'; await new Promise((r) => setTimeout(r, 50)); }
    });
    assert.deepEqual(await watch(page), OFF);
    assert.ok((await page.evaluate(() => mock.changeEvents)) - before <= 20);
  });

  await t.test('補助：DOM の字幕レイヤーは CSS で隠れる', async () => {
    await page.evaluate(() => { mock.playerTrack = 'forced'; mock.renderDomCaption(); });
    const display = await page.evaluate(() => getComputedStyle(document.querySelector('.ytp-caption-window-container')).display);
    assert.equal(display, 'none');
  });

  await t.test('外部と通信しない', () => assert.equal(net.external, 0));
  await page.close();
});

test('スクリプトの設定と構成', () => {
  assert.match(SCRIPT, /@run-at\s+document-start/, '読み込みの早い段階で動く');
  assert.doesNotMatch(SCRIPT, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|GM_xmlhttpRequest|EventSource)\b/, '通信処理がない');
  const outsideConfig = SCRIPT.replace(/const CONFIG = \{[\s\S]*?\n  \};/, '');
  assert.doesNotMatch(outsideConfig, /ytp-|caption-window|captions-text/, 'YouTube の部品名は CONFIG の1か所だけ');
});
