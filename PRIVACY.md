# プライバシーポリシー / Privacy Policy

対象：ImageStorage（Windows アプリ）および ImageStorage Connector（Chrome / Edge / Firefox 用ブラウザー拡張機能）
最終更新日：2026年11月13日

## 日本語

### 概要
ImageStorage と ImageStorage Connector は、作者や第三者のサーバーにデータを送信しません。アカウント登録、広告、アクセス解析、トラッキングはありません。扱うデータはすべて、利用者のパソコンの中だけで処理・保存されます。

### 拡張機能が扱うデータ
拡張機能は、利用者が操作したときに次の情報を読み取り、同じパソコンにインストールされた ImageStorage アプリへ「ネイティブメッセージング」（ブラウザーとパソコン内のアプリを直接つなぐ仕組み）で渡します。インターネットには送信しません。

- 右クリックした画像、または選んだ画像の URL
- その画像が表示されていたページの URL（出典として保存するため）
- 保存先として選んだリストの名前
- ページ上の画像にカーソルを合わせたときの画像 URL（すでに保存済みかどうかを表示するため）
- Pinterest のボードを書き出すときの、ボード上のピンの URL と画像 URL

### インターネット通信について
- 画像を保存するとき、画像の取得元サイトへ通常どおり画像を読み込みに行きます。これはブラウザーで画像を開くのと同じ通信で、閲覧中のサイトのログイン状態が使われる場合があります。
- 上記以外に、作者や第三者のサーバーへの通信はありません。

### ブラウザー内に保存するデータ
拡張機能は、保存操作の途中の状態（どの画像をどのリストへ送るか）を一時的にブラウザーの拡張機能用ストレージに保存します。操作が終わると消去されます。

### 扱わないデータ
パスワード、Cookie の内容、閲覧履歴、フォームへの入力内容、個人を特定する情報を収集・取り出すことはありません。データの販売や第三者への提供もしません。

### 保存した画像について
保存した画像とリストは、利用者のパソコンの ImageStorage のデータフォルダーに保存されます。削除するときは、アプリ上で削除するか、アプリをアンインストールしてデータフォルダーを削除してください。

### お問い合わせ
https://github.com/pooh9135/ImageStorage/issues

## English

### Summary
ImageStorage and ImageStorage Connector do not send any data to the author's servers or to any third party. There are no accounts, ads, analytics, or tracking. All data is processed and stored only on the user's own computer.

### Data the extension handles
When the user performs an action, the extension reads the following and passes it to the ImageStorage app installed on the same computer through native messaging (a direct channel between the browser and a local app). It is not sent over the internet.

- The URL of the image the user right-clicked or selected
- The URL of the page the image was on (saved as the source)
- The name of the destination list the user chose
- The URL of an image the cursor is over (to show whether it is already saved)
- When exporting a Pinterest board, the Pin URLs and image URLs on that board

### Network access
- When saving an image, the extension loads the image from the site it came from, just as the browser does when opening the image. The site's existing sign-in may be used for that request.
- No other requests are made to the author's or any third-party server.

### Data stored in the browser
The extension temporarily stores the state of a save in progress (which image goes to which list) in the browser's extension storage. It is cleared when the save finishes.

### Data not handled
The extension does not collect or read passwords, cookie contents, browsing history, form input, or personally identifying information. Data is never sold or shared with third parties.

### Saved images
Saved images and lists are stored in ImageStorage's data folder on the user's computer. To delete them, remove them in the app, or uninstall the app and delete its data folder.

### Contact
https://github.com/pooh9135/ImageStorage/issues
