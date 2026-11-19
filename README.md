# YouTube Captions Off

iPhone の Safari で m.youtube.com を見るとき、字幕を常にオフにするユーザースクリプト。

- 動画を開いたとき、全画面にしたとき、次の動画に移ったときも字幕オフを維持する
- 手動でオンにする仕組みはない
- 外部と通信しない

## しくみ

- 主：video 要素の字幕トラックを `disabled` にする。オンに戻されたり新しいトラックが追加されたりしたら、すぐにオフをかけ直す
- 補助：字幕の描画部分を CSS で隠す
- SPA 遷移で video が差し替わっても、DOM 監視と video のイベントで拾い直す
- YouTube の部品名が変わったら、スクリプト冒頭の `CONFIG` だけ直せばよい

## 設定手順

### 1. Userscripts にスクリプトを登録する

1. App Store で [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) をインストールする
2. Userscripts アプリを開き、スクリプトを保存するフォルダを指定する。iCloud Drive などでよい
3. iPhone の「設定 > アプリ > Safari > 機能拡張 > Userscripts」をオンにする。「その他の Web サイト」を「許可」にするか、youtube.com を許可する
4. `youtube-captions-off.user.js` を手順2のフォルダに入れる
   - Safari でこのファイルの Raw 表示を開き、アドレスバーの「ぁあ」から Userscripts を開いてインストールしてもよい
5. Safari で m.youtube.com を開き、Userscripts のアイコンからスクリプトが有効になっていることを確認する

### 2. AdGuard を有効にする（広告ブロック、任意）

1. App Store で AdGuard 無料版をインストールする
2. 「設定 > アプリ > Safari > 機能拡張」で AdGuard のコンテンツブロッカーをすべてオンにする
3. AdGuard アプリを開き、フィルタを更新する

### 3. iOS の字幕設定をオフにする（全画面時の補助）

「設定 > アクセシビリティ > 字幕とキャプション」で「クローズドキャプション＋SDH」をオフにする。

## 動作確認

実機の iPhone Safari で確認すること。デスクトップでの確認は代わりにならない。

- [ ] 動画を開いて字幕が出ない
- [ ] 全画面にしても字幕が出ない
- [ ] 次の動画・おすすめに移っても字幕が出ない
- [ ] 字幕が勝手にオンへ戻らない

効かなくなったら、Safari の Web インスペクタで字幕部分の class 名を確認し、`CONFIG.captionSelectors` を更新する。
