// ==UserScript==
// @name         YouTube Captions Off
// @description  YouTube の字幕を常にオフにする。全画面・次の動画への遷移でもオフを維持する。
// @version      1.0.0
// @match        *://m.youtube.com/*
// @match        *://www.youtube.com/*
// @run-at       document-start
// @inject-into  content
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
    // 方式B（主）：この種類の字幕トラックを無効化する。空配列なら全トラックが対象
    trackKinds: [],
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
  };
  // ============================================================

  // --- 方式A：CSS で字幕を隠す ---
  const css =
    CONFIG.captionSelectors.join(',\n') +
    ' { display: none !important; visibility: hidden !important; }\n' +
    'video::cue { color: transparent !important; background: transparent !important; text-shadow: none !important; }';

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
    return CONFIG.trackKinds.length === 0 || CONFIG.trackKinds.includes(track.kind);
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

  // default 付きの字幕はブラウザが自動でオンにし、字幕ファイルの読み込みも始まる。追加された時点で外す
  function stripDefault(track) {
    if (track.hasAttribute('default')) track.removeAttribute('default');
    if (track.track && isTarget(track.track) && track.track.mode !== 'disabled') track.track.mode = 'disabled';
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

  // SPA 遷移で video が差し替わっても拾えるよう、DOM の追加を監視する
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
    }
  }).observe(document, { childList: true, subtree: true });

  // video のイベントはバブリングしないため、capture で document 側から拾う
  for (const type of CONFIG.videoEvents) {
    document.addEventListener(
      type,
      (e) => {
        if (e.target && e.target.tagName === 'VIDEO') watchVideo(e.target);
      },
      true
    );
  }

  scan(document);
})();
