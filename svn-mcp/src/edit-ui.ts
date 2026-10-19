/**
 * svn-edit 的控制頁（單一 HTML）。由 edit-server 在 GET / 與 GET /edit 回傳，並把一次性 token
 * 嵌進頁面；頁面之後所有操作都用同源 fetch 呼叫 /api/*，一律帶 X-Edit-Token。
 *
 * 注意：下面的樣板字串裡不能出現反引號與 `${`，前端程式碼一律用字串串接。
 * 所有動態內容（檔名、路徑、訊息）都用 textContent 填入，不用 innerHTML，避免 XSS。
 */
import { createHash } from "node:crypto";
import { FAVICON_ICO_BASE64, LOGO_PNG_BASE64 } from "./edit-icon-data.js";
import { CLIENT_JS } from "./ui/client.js";
import { UI_CSS } from "./ui/styles.js";

/** 圖示內容的雜湊：換圖後網址跟著變，Edge 才不會沿用快取在專屬設定資料夾裡的舊圖示（視窗標題列／工作列的圖會用到）。 */
export const ICON_VERSION = createHash("sha256").update(FAVICON_ICO_BASE64).digest("hex").slice(0, 10);

/** 顯示在頁首的版本號；有功能性改版時手動調整。 */
export const APP_VERSION = "1.0.0";

const PAGE = String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SVN 遠端編輯</title>
<link rel="icon" type="image/png" sizes="256x256" href="/favicon.png?v=__ICON_VER__">
<style>
${UI_CSS}
</style>
</head>
<body>
<div class="layout" id="layout">
<main>
  <div class="top"><img class="top__logo" src="__LOGO_SRC__" alt=""><div class="top__title">SVN 遠端編輯</div><div class="top__ver">v__APP_VERSION__</div></div>
  <p class="sub">把 SVN 上的檔案取到暫存區、用 Word／Excel 等軟體修改，改完再上傳回去。</p>
  <div id="banner"></div>
  <div id="pending"></div>
  <div id="sessions"></div>
  <div id="browser"></div>
  <div id="importer"></div>
  <div id="settings"></div>
</main>
<aside class="ext" id="ext" aria-live="polite"><button type="button" class="ext__close" id="extClose" aria-label="收起">✕</button><div id="extBody"></div></aside>
</div>
<div class="scrim" id="scrim"></div>
<script>
${CLIENT_JS}
</script>
</body>
</html>`;

/** 把這個 process 的一次性 token 嵌進頁面後回傳。 */
export function renderPage(token: string): string {
  return PAGE.replace("__EDIT_TOKEN__", token)
    .replace("__ICON_VER__", ICON_VERSION)
    .replace("__LOGO_SRC__", `data:image/png;base64,${LOGO_PNG_BASE64}`)
    .replace("__APP_VERSION__", APP_VERSION);
}
