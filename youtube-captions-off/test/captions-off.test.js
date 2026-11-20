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
    if (url.pathname === '/youtubei/v1/player') {
      // 次の動画へ移るときに YouTube が取りに行く動画情報
      const body = { videoDetails: { videoId: 'v2' }, adPlacements: [{}], adSlots: [{}], playerAds: [{}] };
      if (url.searchParams.has('ssai')) body.daiConfig = { enableDai: true, enableServerStitchedDai: true };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (url.pathname.endsWith('.vtt')) { net.vtt++; return route.fulfill({ contentType: 'text/vtt', body: VTT }); }
    const file = path.join(FIX, path.basename(url.pathname));
    const range = route.request().headers()['range'];
    if (range && file.endsWith('.webm') && !url.searchParams.has('noseek')) {
      // 途中からの読み込みに応える。動画を飛ばせるようにするため
      const buf = fs.readFileSync(file);
      const [, a, b] = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(a), end = b ? Number(b) : buf.length - 1;
      return route.fulfill({ status: 206, body: buf.subarray(start, end + 1), headers: {
        'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${buf.length}`,
      } });
    }
    return route.fulfill({ path: file });
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

  await t.test('動画を開いても字幕が一瞬も出ず、プレイヤーも字幕オフになる', async () => {
    await page.evaluate(() => { mock.createVideo(); mock.loadVideo('v1'); });
    assert.deepEqual(await watch(page), OFF);
    assert.equal(net.vtt, 0, '字幕ファイルを読み込ませない');
    assert.equal(await page.evaluate(() => mock.sawShowing), 0, '一時的にも showing にならない');
  });

  await t.test('字幕以外のトラックには触れない', async () => {
    const modes = await page.evaluate(() => [...mock.video.textTracks].filter((t) => t.kind === 'metadata').map((t) => t.mode));
    assert.ok(modes.length > 0 && modes.every((m) => m === 'hidden'));
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
    const saw = await page.evaluate(() => mock.sawShowing);
    await page.evaluate(() => { history.pushState({}, '', '/watch?v=v2'); mock.loadVideo('v2'); });
    assert.deepEqual(await watch(page), OFF);
    assert.equal(net.vtt - vtt, 0);
    assert.equal(await page.evaluate(() => mock.sawShowing), saw);
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

test('プレイヤーが監視を遅れて始め、後から字幕オンを再適用してもオフに揃う', async () => {
  const { page, net } = await open(true);
  await page.evaluate(() => { mock.lateListener = true; mock.createVideo(); mock.loadVideo('v1'); });
  assert.deepEqual(await watch(page), OFF);
  assert.equal(net.vtt, 0);
  await page.close();
});

// 広告を流し、ms 以内に終わったかを返す
function runAd(page, opts, ms = 1500) {
  return page.evaluate(async ({ opts, ms }) => {
    mock.video.playbackRate = 1.5; // 利用者が選んだ再生速度。本編を少し再生してから広告に入る
    await mock.video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    mock.playAd(opts);
    const end = performance.now() + ms;
    while (!mock.adEnded && performance.now() < end) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    const overlay = document.querySelector('.ytp-ad-overlay-container');
    return {
      adEnded: mock.adEnded,
      skipClicks: mock.skipClicks,
      rate: mock.video.playbackRate,
      muted: mock.video.muted,
      currentTime: mock.video.currentTime,
      overlayHidden: !overlay || getComputedStyle(overlay).display === 'none',
    };
  }, { opts, ms });
}

test('広告データを取り除き、広告を予定させない', async (t) => {
  const read = (page) => page.evaluate(async () => {
    const keys = (o) => ['adPlacements', 'adSlots', 'playerAds'].filter((k) => o && k in o);
    const fetched = await (await fetch('/youtubei/v1/player')).json();
    const parsed = JSON.parse(await (await fetch('/youtubei/v1/player')).text());
    const wrapped = JSON.parse(JSON.stringify([{ playerResponse: { adPlacements: [{}], videoDetails: {} } }]));
    const ssai = await (await fetch('/youtubei/v1/player?ssai=1')).json();
    return {
      initial: keys(window.ytInitialPlayerResponse),
      fetched: keys(fetched),
      parsed: keys(parsed),
      wrapped: keys(wrapped[0].playerResponse),
      ssai: keys(ssai),
      videoKept: !!(fetched.videoDetails && window.ytInitialPlayerResponse.videoDetails),
    };
  });

  await t.test('対照：スクリプトなしでは広告データがある', async () => {
    const { page } = await open(false);
    const r = await read(page);
    assert.equal(r.initial.length, 3);
    assert.equal(r.fetched.length, 3);
    await page.close();
  });

  await t.test('読み込み時・次の動画・入れ子の動画情報から広告データが消え、動画の情報は残る', async () => {
    const { page } = await open(true);
    const r = await read(page);
    assert.deepEqual([r.initial, r.fetched, r.parsed, r.wrapped], [[], [], [], []]);
    assert.equal(r.videoKept, true);
    assert.equal(r.ssai.length, 3, '本編と一体で配信される動画では消さない');
    await page.close();
  });
});

test('動画広告', async (t) => {
  await t.test('対照：スクリプトなしでは広告が最後まで流れる', async () => {
    const { page } = await open(false);
    await page.evaluate(() => { mock.createVideo(); mock.loadVideo('v1'); });
    const r = await runAd(page, {});
    assert.equal(r.adEnded, false);
    assert.equal(r.overlayHidden, false);
    await page.close();
  });

  const { page } = await open(true);
  await page.evaluate(() => { mock.createVideo(); mock.loadVideo('v1'); });

  await t.test('広告を最後まで飛ばし、再生速度と音を元に戻す', async () => {
    const r = await runAd(page, {});
    assert.equal(r.adEnded, true, '広告が終わる');
    assert.equal(r.rate, 1.5, '利用者の再生速度に戻る');
    assert.equal(r.muted, false, '音が戻る');
  });

  await t.test('広告の再生中は音を消す', async () => {
    const muted = await page.evaluate(async () => {
      mock.playAd({ longStream: true });
      await new Promise((r) => setTimeout(r, 100));
      const m = mock.video.muted;
      mock.endAd();
      await new Promise((r) => setTimeout(r, 50));
      return [m, mock.video.muted];
    });
    assert.deepEqual(muted, [true, false]);
  });

  await t.test('飛ばせない広告は早送りで終わらせ、再生が止まり続けない', async () => {
    const r = await runAd(page, { noSeek: true });
    assert.equal(r.adEnded, true);
    assert.equal(r.rate, 1.5);
  });

  await t.test('スキップボタンがあれば押す', async () => {
    const r = await runAd(page, { skipButton: true });
    assert.equal(r.adEnded, true);
    assert.ok(r.skipClicks > 0);
  });

  await t.test('バナー広告は CSS で隠れる', async () => {
    const r = await page.evaluate(() => {
      mock.playAd();
      const o = document.querySelector('.ytp-ad-overlay-container');
      const hidden = getComputedStyle(o).display === 'none';
      mock.endAd();
      return hidden;
    });
    assert.equal(r, true);
  });

  await t.test('本編と一体の長い動画は飛ばさず、広告の間だけ早送りする', async () => {
    const r = await page.evaluate(async () => {
      const v = mock.video;
      v.playbackRate = 1.5;
      await new Promise((r) => setTimeout(r, 300));
      const before = v.currentTime;
      mock.playAd({ longStream: true });
      await new Promise((r) => setTimeout(r, 100));
      const during = { rate: v.playbackRate, jumped: v.currentTime - before > 3 };
      mock.endAd();
      await new Promise((r) => setTimeout(r, 50));
      return { during, after: { rate: v.playbackRate, muted: v.muted } };
    });
    assert.deepEqual(r, { during: { rate: 16, jumped: false }, after: { rate: 1.5, muted: false } });
  });

  await t.test('広告でない本編は飛ばさず、速度も音も変えない', async () => {
    const r = await page.evaluate(async () => {
      const v = mock.video;
      v.currentTime = 0;
      v.playbackRate = 1;
      await v.play().catch(() => {});
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 1000));
      return { advanced: v.currentTime, wall: (performance.now() - t0) / 1000, rate: v.playbackRate, muted: v.muted };
    });
    assert.equal(r.rate, 1);
    assert.equal(r.muted, false);
    assert.ok(r.advanced < r.wall + 0.5, '再生位置が実時間より先に進まない');
  });

  await t.test('広告のあとも字幕はオフのまま', async () => {
    assert.deepEqual(await watch(page, 500), OFF);
  });
  await page.close();
});

test('スクリプトの設定と構成', () => {
  assert.match(SCRIPT, /@run-at\s+document-start/, '読み込みの早い段階で動く');
  assert.doesNotMatch(SCRIPT, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|GM_xmlhttpRequest|EventSource)\b/, '通信処理がない');
  assert.doesNotMatch(SCRIPT, /@(updateURL|downloadURL)/, '書き換え可能な場所から自動更新しない');
  const outsideConfig = SCRIPT.replace(/const CONFIG = \{[\s\S]*?\n  \};/, '');
  assert.doesNotMatch(outsideConfig, /ytp-|caption-window|captions-text|ad-showing|html5-video-player|adPlacements|ytInitialPlayerResponse/, 'YouTube の部品名は CONFIG の1か所だけ');
});
