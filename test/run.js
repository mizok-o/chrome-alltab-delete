// 字幕オフスクリプトの検証。
// 実行：node test/run.js
// 模擬プレイヤー test/fixtures/player.html は、iOS Safari の HLS 再生時に YouTube が行う字幕処理を再現している。
// スクリプトなしの対照実験で字幕が出ることを確かめ、検証そのものが字幕を検出できることも保証する。
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'youtube-captions-off.user.js'), 'utf8');
const FIX = path.join(__dirname, 'fixtures');
const ORIGIN = 'https://m.youtube.com';
const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n字幕テキスト\n';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
}

async function openPage(browser, { inject }) {
  const page = await browser.newPage();
  const net = { vtt: 0, external: [] };
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      net.external.push(url.href);
      return route.abort();
    }
    if (url.pathname.endsWith('.vtt')) {
      net.vtt++;
      return route.fulfill({ contentType: 'text/vtt', body: VTT, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    const file = path.join(FIX, path.basename(url.pathname) || 'player.html');
    return route.fulfill({ path: file });
  });
  if (inject === 'start') await page.addInitScript(SCRIPT);
  await page.goto(ORIGIN + '/player.html');
  return { page, net };
}

// 再生しながら字幕の状態を見張る。1度でも字幕が出れば記録する
async function watchPlayback(page, ms) {
  return page.evaluate(async (ms) => {
    const v = window.mock.video;
    await v.play().catch(() => {});
    const seen = { showing: 0, activeCues: 0, domVisible: 0, samples: 0 };
    const end = performance.now() + ms;
    while (performance.now() < end) {
      seen.samples++;
      for (const t of v.textTracks) {
        if (t.mode === 'showing') seen.showing++;
        if (t.activeCues && t.activeCues.length > 0) seen.activeCues++;
      }
      const seg = document.querySelector('.ytp-caption-segment');
      if (seg && seg.getClientRects().length > 0) seen.domVisible++;
      await new Promise((r) => setTimeout(r, 20));
    }
    seen.currentTime = v.currentTime;
    seen.playerTrack = window.mock.playerTrack;
    seen.modes = [...v.textTracks].map((t) => t.mode);
    seen.changeEvents = window.mock.changeEvents;
    return seen;
  }, ms);
}

function noCaption(s) {
  return s.showing === 0 && s.activeCues === 0 && s.domVisible === 0 && s.playerTrack === null && s.modes.every((m) => m === 'disabled');
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // 0. 対照実験：スクリプトなしなら字幕が出る（検証が字幕を検出できることの確認）
  {
    const { page, net } = await openPage(browser, { inject: false });
    await page.evaluate(() => { mock.createVideo(); mock.loadVideo('vid1'); });
    const s = await watchPlayback(page, 1500);
    check('0. 対照：スクリプトなしでは字幕が出る', s.activeCues > 0 && s.domVisible > 0 && s.playerTrack === 'vid1.ja' && net.vtt > 0,
      { activeCues: s.activeCues, domVisible: s.domVisible, playerTrack: s.playerTrack, vtt: net.vtt, t: s.currentTime });
    await page.close();
  }

  // 1〜5. スクリプトあり（document-start で注入）
  {
    const { page, net } = await openPage(browser, { inject: 'start' });
    await page.evaluate(() => { mock.createVideo(); mock.loadVideo('vid1'); });
    let s = await watchPlayback(page, 1500);
    check('1. 動画を開いても字幕が出ない', noCaption(s) && s.currentTime > 1, s);
    check('1b. 字幕ファイル自体を読み込ませない', net.vtt === 0, { vtt: net.vtt });
    check('1c. プレイヤー側も字幕オフ状態になる', s.playerTrack === null, { playerTrack: s.playerTrack });

    // 2. 全画面の代わり：iOS 標準プレイヤーのメニュー等で字幕がオンにされた状況を再現
    await page.evaluate(() => {
      const v = mock.video;
      v.dispatchEvent(new Event('webkitbeginfullscreen'));
      v.textTracks[1].mode = 'showing';
    });
    s = await watchPlayback(page, 800);
    check('2. 全画面・標準プレイヤー側で字幕がオンにされてもオフに戻る', noCaption(s), s);

    // 3. 次の動画へ SPA 遷移（同じ video 要素を再利用）
    const vttBeforeNav = net.vtt; // 検証2で意図的にオンにした分は数えない
    await page.evaluate(() => { history.pushState({}, '', '/watch?v=vid2'); mock.loadVideo('vid2'); });
    s = await watchPlayback(page, 1200);
    check('3. 次の動画（同じ video 要素）でも字幕が出ない', noCaption(s), s);

    // 3b. おすすめへ遷移し、video 要素ごと差し替わる
    await page.evaluate(() => { history.pushState({}, '', '/watch?v=vid3'); mock.replaceVideo(); mock.loadVideo('vid3'); });
    s = await watchPlayback(page, 1200);
    check('3b. video 要素が差し替わっても字幕が出ない', noCaption(s), s);
    check('3c. 遷移を繰り返しても字幕ファイルを読み込ませない', net.vtt - vttBeforeNav === 0, { vttDuringNav: net.vtt - vttBeforeNav });

    // 4. 勝手にオンへ戻らない：プレイヤーが何度オンにしても戻す。無限ループにならない
    const before = await page.evaluate(() => mock.changeEvents);
    await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) {
        mock.video.textTracks[0].mode = 'showing';
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    s = await watchPlayback(page, 1500);
    check('4. 字幕をオンに戻されても、すぐオフに戻る', noCaption(s), s);
    const loops = s.changeEvents - before;
    check('4b. オフのかけ直しが無限ループにならない', loops <= 20, { changeEventsDuring: loops });

    // 5. 補助の CSS：字幕レイヤーが描かれても見えない
    await page.evaluate(() => { mock.playerTrack = 'forced'; mock.renderDomCaption(); });
    const css = await page.evaluate(() => {
      const ids = ['.ytp-caption-window-container', '.caption-window', '.captions-text', '.ytp-caption-segment'];
      return ids.map((sel) => [sel, getComputedStyle(document.querySelector(sel)).display]);
    });
    check('5. DOM の字幕レイヤーは CSS で隠れる', css.every(([, d]) => d === 'none'), css);
    check('6. 外部と通信しない', net.external.length === 0, net.external);
    await page.close();
  }

  // 7. スクリプトの注入が遅れ、字幕がすでにオンの状態からでもオフにできる
  {
    const { page } = await openPage(browser, { inject: false });
    await page.evaluate(() => { mock.createVideo(); mock.loadVideo('vid1'); });
    await page.waitForTimeout(500);
    const pre = await page.evaluate(() => [...mock.video.textTracks].map((t) => t.mode));
    await page.addScriptTag({ content: SCRIPT });
    const s = await watchPlayback(page, 1000);
    check('7. 注入が遅れても、オン状態からオフにできる', pre.includes('showing') && noCaption(s), { pre, after: s.modes, playerTrack: s.playerTrack });
    await page.close();
  }

  // 静的チェック
  const net = /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|GM_xmlhttpRequest|GM\.xmlHttpRequest|EventSource)\b/;
  check('8. スクリプトに通信処理がない', !net.test(SCRIPT));
  check('9. ページ読み込みの早い段階で動く設定', /@run-at\s+document-start/.test(SCRIPT));
  check('10. 対象サイトが m.youtube.com と www.youtube.com', /@match\s+\*:\/\/m\.youtube\.com\/\*/.test(SCRIPT) && /@match\s+\*:\/\/www\.youtube\.com\/\*/.test(SCRIPT));
  check('11. YouTube 固有の部品名は CONFIG の1か所だけ', !/ytp-|caption-window|captions-text/.test(SCRIPT.replace(/const CONFIG = \{[\s\S]*?\n  \};/, '')));
  check('12. 字幕を手動でオンにする仕組みがない', !/toggle|enable|GM_registerMenuCommand|GM\.registerMenuCommand/i.test(SCRIPT));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
