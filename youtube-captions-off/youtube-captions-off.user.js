// ==UserScript==
// @name         YouTube Captions Off
// @description  YouTube の字幕を常にオフにし、動画広告を止める。全画面・次の動画への遷移でも効く。
// @version      2.0.0
// @match        *://m.youtube.com/*
// @match        *://www.youtube.com/*
// @run-at       document-start
// @inject-into  auto
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // YouTube の仕様が変わったら、ここだけ直す
  // ============================================================
  const CONFIG = {
    // 方式A（補助）：字幕の描画を CSS で隠す対象
    captionSelectors: [
      '.ytp-caption-window-container', // プレイヤーの字幕レイヤー
      '.caption-window',               // 字幕ウィンドウ
      '.ytp-caption-segment',          // 字幕の文字
      '.captions-text',
    ],
    // 方式B（主）：この種類の字幕トラックを無効化する。metadata などのトラックには触れない
    trackKinds: ['subtitles', 'captions'],
    // 字幕オフをかけ直すきっかけにする video 要素のイベント
    videoEvents: [
      'loadstart',
      'loadedmetadata',
      'loadeddata',
      'play',
      'playing',
      'webkitbeginfullscreen', // iOS の全画面開始
      'webkitpresentationmodechanged',
    ],
    // 動画広告を止める
    ads: {
      // その1（主）：YouTube が受け取る動画情報から取り除く広告データ。これがないと広告が予定されない
      pruneKeys: ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'],
      // ページの読み込み時に埋め込まれる動画情報の変数名
      initialVars: ['ytInitialPlayerResponse'],
      playerSelector: '.html5-video-player', // プレイヤー本体
      adShowingClass: 'ad-showing',          // 広告の再生中にプレイヤーに付く印
      skipButtonSelectors: [                 // 「スキップ」ボタン
        '.ytp-skip-ad-button',
        '.ytp-ad-skip-button',
        '.ytp-ad-skip-button-modern',
      ],
      hideSelectors: [                       // 動画に重なるバナー広告と、ページ内の広告枠
        '.ytp-ad-overlay-container',
        'ad-slot-renderer',
        'ytm-promoted-sparkles-web-renderer',
        'ytm-promoted-video-renderer',
        'ytm-companion-ad-renderer',
        'ytm-rich-item-renderer:has(> ad-slot-renderer)',
      ],
      // その2：広告の長さがこの秒数以下なら最後まで飛ぶ。本編と一体で配信される長い動画では飛ばず、早送りだけにする
      maxSeekSeconds: 180,
      playbackRate: 16,
      // 広告かどうかを確かめ直すきっかけにする video 要素のイベント
      events: ['loadstart', 'loadedmetadata', 'durationchange', 'playing', 'timeupdate', 'ratechange', 'volumechange'],
    },
  };
  // ============================================================

  // --- 方式A：CSS で字幕を隠す ---
  const css =
    CONFIG.captionSelectors.join(',\n') +
    ' { display: none !important; visibility: hidden !important; }\n' +
    'video::cue { color: transparent !important; background: transparent !important; text-shadow: none !important; }\n' +
    CONFIG.ads.hideSelectors.join(',\n') +
    ' { display: none !important; }';

  function injectStyle() {
    const root = document.head || document.documentElement;
    if (!root) return false;
    const style = document.createElement('style');
    style.id = 'yt-captions-off-style';
    style.textContent = css;
    root.appendChild(style);
    return true;
  }

  if (!injectStyle()) {
    new MutationObserver((_, obs) => {
      if (injectStyle()) obs.disconnect();
    }).observe(document, { childList: true });
  }

  // --- 方式B：video 要素の字幕トラックを無効化する ---
  function isTarget(track) {
    return CONFIG.trackKinds.includes(track.kind);
  }

  function disableTracks(video) {
    const tracks = video.textTracks;
    if (!tracks) return;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (isTarget(t) && t.mode !== 'disabled') t.mode = 'disabled';
    }
  }

  const watched = new WeakSet();

  function watchVideo(video) {
    disableTracks(video);
    if (watched.has(video)) return;
    watched.add(video);
    const tracks = video.textTracks;
    if (tracks) {
      // トラックが追加された・誰かがオンに戻したときにオフをかけ直す
      tracks.addEventListener('addtrack', () => disableTracks(video));
      tracks.addEventListener('change', () => disableTracks(video));
    }
  }

  // プレイヤーは textTracks の change を見て字幕の状態を合わせる。
  // こちらでオフにした後に change を通知し、プレイヤー側も字幕オフの状態にする
  const pendingNotify = new WeakSet();
  function notifyPlayer(video) {
    if (pendingNotify.has(video)) return;
    pendingNotify.add(video);
    setTimeout(() => {
      pendingNotify.delete(video);
      disableTracks(video);
      if (video.textTracks) video.textTracks.dispatchEvent(new Event('change'));
    }, 0);
  }

  // default 付きの字幕はブラウザが自動でオンにし、字幕ファイルの読み込みも始まる。追加・付け直しの時点で外す
  function stripDefault(track) {
    if (!isTarget({ kind: track.getAttribute('kind') || 'subtitles' })) return;
    if (track.hasAttribute('default')) track.removeAttribute('default');
    if (track.track && track.track.mode !== 'disabled') track.track.mode = 'disabled';
    const video = track.parentElement;
    if (video && video.tagName === 'VIDEO') notifyPlayer(video);
  }

  function scan(root) {
    if (root.tagName === 'VIDEO') watchVideo(root);
    if (root.tagName === 'TRACK') stripDefault(root);
    if (root.querySelectorAll) {
      root.querySelectorAll('video').forEach(watchVideo);
      root.querySelectorAll('track').forEach(stripDefault);
    }
  }

  // SPA 遷移で video が差し替わっても拾えるよう、DOM の追加と default の付け直しを監視する
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (m.target.tagName === 'TRACK') stripDefault(m.target);
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['default'] });

  // video のイベントはバブリングしないため、capture で document 側から拾う
  for (const type of CONFIG.videoEvents) {
    document.addEventListener(
      type,
      (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
          watchVideo(e.target);
          // プレイヤーが後から字幕オンを再適用しても、オフに揃え直す
          notifyPlayer(e.target);
        }
      },
      true
    );
  }

  // --- 広告その1（主）：動画情報から広告データを取り除き、広告を予定させない ---
  // ページ側で動いたときだけ効く。Userscripts がページ側に入れなかった場合は、その2だけで止める
  function isServerStitched(res) {
    // 広告と本編が一体で配信される動画。広告データを消すと広告が本編扱いになり、その2でも検知できなくなるので残す
    return !!(res && res.daiConfig && res.daiConfig.enableServerStitchedDai);
  }

  function pruneAds(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      for (const item of obj) pruneAds(item);
      return obj;
    }
    if (!isServerStitched(obj)) {
      for (const key of CONFIG.ads.pruneKeys) if (key in obj) delete obj[key];
    }
    if (obj.playerResponse && typeof obj.playerResponse === 'object') pruneAds(obj.playerResponse);
    return obj;
  }

  function safePrune(obj) {
    try {
      return pruneAds(obj);
    } catch (e) {
      return obj;
    }
  }

  try {
    const originalParse = JSON.parse;
    JSON.parse = function (...args) {
      return safePrune(originalParse.apply(this, args));
    };
  } catch (e) {}

  try {
    const originalJson = Response.prototype.json;
    Response.prototype.json = function (...args) {
      return originalJson.apply(this, args).then(safePrune);
    };
  } catch (e) {}

  for (const name of CONFIG.ads.initialVars) {
    try {
      let value = safePrune(window[name]);
      Object.defineProperty(window, name, {
        configurable: true,
        get: () => value,
        set: (v) => {
          value = safePrune(v);
        },
      });
    } catch (e) {}
  }

  // --- 広告その2：それでも広告が流れたら、音を消して飛ばす ---
  // 本編の再生速度を覚えておき、広告後に戻す。広告の動画に切り替わると速度は1倍に戻されるため、本編中に覚える
  const contentRate = new WeakMap();
  const adSession = new WeakMap(); // 広告に入る前の音の状態

  function setRate(video, rate) {
    try {
      if (video.playbackRate !== rate) video.playbackRate = rate;
    } catch (e) {}
  }

  function handleAd(video) {
    const ads = CONFIG.ads;
    const player = video.closest(ads.playerSelector);
    const inAd = !!player && player.classList.contains(ads.adShowingClass);
    const session = adSession.get(video);

    if (!inAd) {
      if (session) {
        adSession.delete(video);
        // こちらが上げた速度のままなら戻す。YouTube が自分で設定し直していれば触らない
        if (video.playbackRate === ads.playbackRate) setRate(video, contentRate.get(video) || 1);
        if (!session.muted && video.muted) {
          const wasPlaying = !video.paused;
          video.muted = false;
          // 音を戻したときに止まる端末があるため、再生中だったなら再生し直す
          if (wasPlaying && video.paused) video.play().catch(() => {});
        }
      } else if (video.playbackRate !== ads.playbackRate) {
        contentRate.set(video, video.playbackRate);
      }
      return;
    }

    if (!session) adSession.set(video, { muted: video.muted });
    if (!video.muted) video.muted = true;

    for (const sel of ads.skipButtonSelectors) {
      const btn = player.querySelector(sel);
      if (btn) btn.click();
    }

    setRate(video, ads.playbackRate);
    const d = video.duration;
    if (Number.isFinite(d) && d > 0 && d <= ads.maxSeekSeconds) {
      // 飛ばせる範囲まで読み込めているときだけ最後へ飛ぶ。飛ばせないのに飛ぼうとすると再生が止まり続ける
      const s = video.seekable;
      const canSeek = s.length > 0 && s.end(s.length - 1) >= d - 0.1;
      if (canSeek && !video.seeking && video.currentTime < d - 0.1) video.currentTime = d - 0.1;
    }
  }

  // 広告の始まりと終わりをすぐ拾うため、プレイヤーの class の変化を見張る
  const watchedPlayers = new WeakSet();
  function watchPlayer(video) {
    const player = video.closest(CONFIG.ads.playerSelector);
    if (!player || watchedPlayers.has(player)) return;
    watchedPlayers.add(player);
    new MutationObserver(() => {
      const v = player.querySelector('video');
      if (v) handleAd(v);
    }).observe(player, { attributes: true, attributeFilter: ['class'] });
  }

  for (const type of CONFIG.ads.events) {
    document.addEventListener(
      type,
      (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
          watchPlayer(e.target);
          handleAd(e.target);
        }
      },
      true
    );
  }

  // どちら側で動いているかの目印。page なら広告その1も効いている。Web インスペクタで html 要素を見れば分かる
  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.setAttribute('data-yt-captions-off', typeof window.ytcfg !== 'undefined' ? 'page' : 'content');
  });

  scan(document);
})();
