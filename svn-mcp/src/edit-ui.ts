/**
 * svn-edit 的控制頁（單一 HTML）。由 edit-server 在 GET / 與 GET /edit 回傳，並把一次性 token
 * 嵌進頁面；頁面之後所有操作都用同源 fetch 呼叫 /api/*，一律帶 X-Edit-Token。
 *
 * 注意：下面的樣板字串裡不能出現反引號與 `${`，前端程式碼一律用字串串接。
 * 所有動態內容（檔名、路徑、訊息）都用 textContent 填入，不用 innerHTML，避免 XSS。
 */
import { createHash } from "node:crypto";
import { FAVICON_ICO_BASE64, LOGO_PNG_BASE64 } from "./edit-icon-data.js";

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
:root{
  --brand:#e2484c;--brand-hover:#cf3b40;--brand-dark:#b8262b;--brand-soft:#fdecec;
  --pink:#f7a8ac;--pink-soft:#fdf2f1;--pink-line:#f9dedd;
  --page:#fdfaf7;--surface:#fff;--ink:#332e2c;--ink-soft:#6f6360;--muted:#9a8f8b;--line:#f0e8e4;--line-strong:#e4d8d3;--field:#fbf8f6;
  --pending-bg:#fef4e3;--pending-ink:#b0761b;--processing-bg:#eaf4fc;--processing-ink:#1f6fa8;--completed-bg:#eaf7ee;--completed-ink:#3a8a5d;
  --danger:#d64045;--danger-bg:#fdecec;
  --radius-card:18px;--radius-field:12px;
  --shadow-card:0 1px 2px rgb(51 46 44 / .04),0 8px 24px rgb(51 46 44 / .05);
  --font-sans:"Noto Sans TC","Microsoft JhengHei","PingFang TC",system-ui,-apple-system,"Segoe UI",sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--page);color:var(--ink);font-family:var(--font-sans);font-size:14.5px;line-height:1.5}
button,input,select,textarea{font-family:inherit}

/* 頁首 */
.top{display:flex;align-items:center;gap:10px;margin:2px 2px 8px}
.top__logo{width:34px;height:34px;border-radius:10px;flex:0 0 auto}
.top__title{font-size:20px;font-weight:700}
.top__ver{margin-left:auto;font-size:12px;color:var(--muted)}
.sub{color:var(--ink-soft);font-size:13.5px;margin:0 2px 14px}

/* 卡片 */
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-card);box-shadow:var(--shadow-card);padding:15px 18px 16px;margin:0 0 12px}
.card h2{font-size:17px;font-weight:700;margin:0 0 6px;word-break:break-all}
.card h2::before{content:"";display:inline-block;width:5px;height:17px;border-radius:3px;background:var(--brand);margin-right:9px;vertical-align:-3px}
.path{color:var(--muted);font-size:12.5px;word-break:break-all;margin:0 0 10px}
.hint{margin:6px 0 0;color:var(--ink-soft);font-size:13.5px}
.empty{color:var(--muted);text-align:center;padding:22px 0;font-size:13.5px}

/* 狀態標籤 */
.badges{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.badge{font-size:12px;font-weight:600;border-radius:999px;padding:2px 10px;background:var(--processing-bg);color:var(--processing-ink)}
.badge.ok{background:var(--completed-bg);color:var(--completed-ink)}
.badge.warn{background:var(--pending-bg);color:var(--pending-ink)}

/* 表單 */
label{display:block;font-size:13px;font-weight:600;color:var(--ink-soft);margin:10px 0 5px}
textarea,input,select{width:100%;color:var(--ink);background:var(--field);border:1px solid var(--line);border-radius:var(--radius-field);padding:8px 12px;font-size:14.5px;transition:border-color .15s,background .15s,box-shadow .15s}
textarea::placeholder,input::placeholder{color:#bdb2ad}
textarea:focus,input:focus,select:focus{outline:none;border-color:var(--pink);background:#fff;box-shadow:0 0 0 3px var(--brand-soft)}
textarea{min-height:84px;resize:vertical;line-height:1.55}
input[type=file]{padding:6px 10px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}

/* 按鈕 */
button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;border:1px solid var(--line-strong);border-radius:var(--radius-field);background:#fff;color:var(--ink-soft);font-size:14px;font-weight:600;cursor:pointer;transition:background .15s,box-shadow .15s,transform .08s,color .15s}
button:hover:not(:disabled){background:var(--pink-soft);color:var(--ink)}
button:active:not(:disabled){transform:translateY(1px)}
button.primary{background:var(--brand);border-color:var(--brand);color:#fff;box-shadow:0 2px 8px rgb(226 72 76 / .25)}
button.primary:hover:not(:disabled){background:var(--brand-hover);color:#fff}
button.danger{color:var(--danger);border-color:#f3c4c5}
button.danger:hover:not(:disabled){background:var(--danger-bg);color:var(--danger)}
button:disabled{opacity:.5;cursor:default}

/* 提示 */
.msg{margin:12px 0 0;padding:10px 12px;border-radius:var(--radius-field);font-size:13.5px;background:var(--danger-bg);color:var(--danger);white-space:pre-wrap}
.msg.info{background:var(--completed-bg);color:var(--completed-ink)}
.banner{background:var(--pending-bg);color:var(--pending-ink);border-radius:var(--radius-field);padding:10px 14px;margin:12px 0 0;font-size:13.5px}
.banner .path{color:var(--pending-ink);opacity:.85}
.banner.info{background:var(--completed-bg);color:var(--completed-ink);cursor:pointer}
.upgrade{margin:12px 0 4px;padding:10px 12px;border:1px dashed var(--line-strong);border-radius:12px}
.upgrade>label{display:flex;align-items:center;gap:8px;margin:0;font-weight:600;color:var(--ink);cursor:pointer}
.upgrade input[type=checkbox]{width:auto;margin:0}
.upgrade label.upgrade__name{margin-top:8px}
.upgrade .hint{margin:6px 0 0}
.modal{position:fixed;top:0;right:0;bottom:0;left:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;background:rgb(51 46 44 / .35)}
.modal__box{max-width:460px;width:100%;background:var(--surface);border-radius:18px;padding:20px 22px;box-shadow:0 18px 48px rgb(51 46 44 / .3);border-top:5px solid var(--pending-ink)}
.modal__box h3{margin:0 0 10px;font-size:16px;color:var(--pending-ink)}
.modal__box p{margin:0 0 14px;line-height:1.6;overflow-wrap:anywhere;white-space:pre-wrap}
.entryrow{display:flex;gap:6px;align-items:stretch;margin:0 0 4px}
.entryrow>.entry{margin:0;flex:1 1 auto;min-width:0;width:auto}
.entryrow>.pick{flex:0 0 auto;width:18px;height:18px;margin:0;padding:0;align-self:center;accent-color:var(--brand)}
.selbar{display:flex;align-items:center;gap:10px;margin:0 0 8px;font-size:13.5px;color:var(--ink-soft)}
.selbar label{display:flex;align-items:center;gap:6px;margin:0;font-weight:500;cursor:pointer}
.selbar input{width:auto;margin:0;padding:0;accent-color:var(--brand)}
.selbar .grow{flex:1}
.switchrow{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0;font-weight:600;color:var(--ink);cursor:pointer}
.switch{position:relative;flex:0 0 auto;width:46px;height:26px}
.switch input{position:absolute;top:0;left:0;width:100%;height:100%;margin:0;padding:0;border:0;background:transparent;opacity:0;cursor:pointer;z-index:1}
.switch__track{position:absolute;top:0;right:0;bottom:0;left:0;border-radius:13px;background:#c8c8c8;transition:background .2s}
.switch__track::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgb(0 0 0 / .3);transition:transform .2s}
.switch input:checked+.switch__track{background:#2196f3}
.switch input:checked+.switch__track::after{transform:translateX(20px)}
.switch input:focus-visible+.switch__track{outline:2px solid #2196f3;outline-offset:2px}
.switch input:disabled{cursor:default}
.delbox{margin:0 0 12px;padding:12px 14px;border:1px solid var(--danger);border-radius:12px;background:var(--danger-bg)}
.delbox p{margin:0 0 8px;overflow-wrap:anywhere}

/* 目錄瀏覽、連線清單 */
summary{cursor:pointer;font-weight:700;font-size:15.5px}
summary::marker{color:var(--brand)}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px 4px;margin:10px 0;font-size:14px}
.crumbs button{border:0;background:none;padding:2px 6px;color:var(--brand);font-weight:600;border-radius:6px;font-size:14px}
.crumbs button:hover{background:var(--brand-soft);text-decoration:underline}
.crumbs .sep{color:var(--muted);font-size:13px}
.crumbs .cur{padding:2px 6px;font-weight:700;color:var(--ink)}
/* 檔案／資料夾清單：彩色圖示＋檔名＋「版本・作者・時間」 */
.entry.fi{justify-content:flex-start;gap:12px;padding:10px 14px;border-radius:12px;font-weight:500}
.entry.fi:hover:not(:disabled){background:var(--brand-soft)}
.entry.fi:disabled{opacity:.6}
.fi__main{flex:1 1 auto;min-width:0;text-align:left}
.fi__name{font-weight:700;overflow-wrap:anywhere;line-height:1.35}
.fi__meta{font-size:12px;font-weight:400;color:var(--muted);margin-top:1px}
.fb{flex:0 0 auto;width:36px;height:36px;border-radius:9px;color:#fff;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
.fb--dir{background:#e9b44c;font-size:15px}
.fb--docx{background:#2b579a;font-size:17px}
.fb--xlsx{background:#217346;font-size:17px}
.fb--pdf{background:#c8453b;font-size:11.5px}
.fb--img{background:#8c8079;font-size:10.5px}
.fb--md{background:#5a4fcf;font-size:11.5px}
.fb--txt{background:#6f8190;font-size:11.5px}
.fb--csv{background:#2e9c87;font-size:11px}
.fb--other{background:#9a8f8b;font-size:10.5px}
.fb--sm{width:28px;height:28px;border-radius:7px;font-size:12px}
.stat{margin:10px 2px 0;font-size:12.5px;color:var(--muted)}
.trackbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 10px;font-size:13px;color:var(--ink-soft)}
.trackbar span{min-width:0;overflow-wrap:anywhere}
.trackbar button{padding:3px 12px;font-size:12.5px;border-radius:9px;flex:0 0 auto}
/* 開始編輯確認卡：遠端完整位置＋複製 */
.loc{border:1px solid var(--line-strong);background:var(--field);border-radius:12px;padding:10px 12px;margin:10px 0 12px}
.loc__label{font-size:12px;color:var(--muted);margin-bottom:4px}
.loc__row{display:flex;gap:8px;align-items:flex-start}
.loc__url{flex:1;min-width:0;font-family:Consolas,"Cascadia Mono",monospace;font-size:12.5px;line-height:1.55;word-break:break-all;user-select:all}
.loc button{padding:3px 12px;font-size:12.5px;border-radius:9px;flex:0 0 auto}
button.copied{background:var(--completed-bg);border-color:#b9e0c7;color:var(--completed-ink)}
/* 管理連線：本地目錄清單、本機資料夾點選、Checkout */
.pill{display:inline-flex;align-items:center;font-size:12px;border-radius:999px;padding:1px 9px;font-weight:600;margin-left:6px}
.pill--ok{background:var(--completed-bg);color:var(--completed-ink)}
.pill--warn{background:var(--pending-bg);color:var(--pending-ink)}
.pill--none{background:#f1ecea;color:var(--ink-soft)}
.conn--local{align-items:flex-start}
.conn__main{min-width:0;flex:1}
.conn__main .nm{font-weight:700}
.conn__main .pth{font-family:Consolas,"Cascadia Mono",monospace;font-size:12.5px;color:var(--ink-soft);word-break:break-all}
.warnline{font-size:12.5px;color:var(--pending-ink);margin-top:3px}
.addrow{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:12px;align-items:center}
.shade{display:none;position:fixed;top:0;right:0;bottom:0;left:0;z-index:40;background:rgb(51 46 44 / .35);align-items:flex-end;justify-content:center}
.shade.on{display:flex}
.shade--top{z-index:50}
.sheet2{width:100%;max-width:560px;max-height:92vh;overflow:auto;background:var(--surface);border-radius:18px 18px 0 0;padding:16px 16px 14px;display:flex;flex-direction:column;box-shadow:0 -10px 30px rgb(51 46 44 / .2)}
.sheet2__title{margin:0 0 4px;font-size:16px}
.sheet2 .hint{margin:0 0 10px}
.fslist{overflow:auto;border:1px solid var(--line-strong);border-radius:12px;flex:1;min-height:150px;max-height:46vh}
.fsrow{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line);cursor:pointer}
.fsrow:last-child{border-bottom:0}
.fsrow:hover{background:var(--brand-soft)}
.fsrow .n{flex:1;min-width:0;overflow-wrap:anywhere}
.sheet2__foot{display:flex;align-items:center;gap:8px;margin-top:10px}
.sheet2__foot .cur{flex:1;min-width:0;font-size:12px;color:var(--ink-soft);word-break:break-all}
.lbl{font-size:12.5px;color:var(--muted);margin:12px 0 4px}
.pathrow{display:flex;gap:8px;align-items:center}
.pathrow .v{flex:1;min-width:0;font-family:Consolas,"Cascadia Mono",monospace;font-size:12.5px;word-break:break-all;border:1px solid var(--line-strong);background:var(--field);border-radius:10px;padding:7px 10px}
.pathrow .v.empty{color:var(--muted);font-family:var(--font-sans)}
.opt{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:1px solid var(--line-strong);border-radius:10px;margin:0 0 6px;cursor:pointer}
.opt.on{border-color:var(--brand);background:var(--brand-soft)}
.opt input{margin-top:3px;width:auto;accent-color:var(--brand)}
.opt b{display:block;font-size:13.5px}
.opt small{color:var(--ink-soft);font-size:12.5px}
.st{margin-top:8px;font-size:12.5px;border-radius:8px;padding:6px 10px}
.st.ok{background:var(--completed-bg);color:var(--completed-ink)}
.st.err{background:var(--danger-bg);color:var(--danger)}
.st.info{background:var(--processing-bg);color:var(--processing-ink)}
.bar{height:10px;border-radius:5px;background:#f1ecea;overflow:hidden;margin:12px 0 6px;position:relative}
.bar>i{position:absolute;top:0;bottom:0;width:35%;background:var(--brand);animation:bar-slide 1.1s ease-in-out infinite}
@keyframes bar-slide{0%{left:-35%}100%{left:100%}}
.chk{display:flex;gap:8px;align-items:flex-start;margin-top:12px;font-size:13px;cursor:pointer}
.chk input{width:auto;margin:3px 0 0;accent-color:var(--brand)}
.entry{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;text-align:left;margin:0 0 4px;padding:8px 12px;border-radius:10px;font-weight:500;color:var(--ink);white-space:normal}
.entry__name{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.entry__meta{flex:0 0 auto;font-size:12px;font-weight:400;color:var(--muted);text-align:right;white-space:nowrap;line-height:1.35}
.entry__meta span{display:block}
.conn{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:13.5px;word-break:break-all}
details>.hint{margin-bottom:8px}
button{white-space:nowrap}
.tabs{display:flex;border:1px solid var(--line-strong);border-radius:12px;overflow:hidden;margin:10px 0}
.tabs button{flex:1;border:0;border-radius:0;background:var(--surface);padding:8px 0}
.tabs button.on{background:var(--brand);color:#fff}
.searchrow{display:flex;gap:8px}
.searchrow input{flex:1;min-width:0}
.searchrow button.reload{padding:6px 12px;font-size:18px}
.projlist{border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-top:10px;background:var(--surface)}
.proj{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line);cursor:pointer}
.proj:last-child{border-bottom:0}
.proj:hover{background:var(--pink-soft)}
.proj__name{flex:1;min-width:0;overflow-wrap:anywhere;font-weight:500}
.proj .grip{color:var(--muted);cursor:grab;user-select:none;letter-spacing:-2px}
.proj.dragging{opacity:.4}
.proj.drop-before{box-shadow:inset 0 2px 0 var(--brand)}
.proj.drop-after{box-shadow:inset 0 -2px 0 var(--brand)}
button.star{border:0;background:none;padding:0 2px;font-size:20px;line-height:1;color:var(--muted);box-shadow:none}
button.star:hover:not(:disabled){background:none;color:#f0a500}
button.star.on{color:#f0a500}
button.nick{flex:0 0 auto;min-width:64px;border-radius:999px;border:1px solid var(--pink-line);background:var(--brand-soft);color:var(--brand-dark);padding:2px 12px;font-size:13px}
button.nick.alias{color:var(--muted);font-weight:500}
button.nick.empty{color:#d9b9b8;font-weight:500}
input.nickinput{flex:0 0 auto;width:110px;padding:3px 10px;font-size:13px;border-radius:999px}
.combo{position:relative}
button.combo__field{display:flex;width:100%;justify-content:flex-start;gap:8px;text-align:left;background:var(--field);color:var(--ink);font-weight:500;padding:8px 12px;white-space:normal}
.combo__name{flex:1;min-width:0;overflow-wrap:anywhere;text-align:left}
.combo__pill{flex:0 0 auto;border-radius:999px;border:1px solid var(--pink-line);background:var(--brand-soft);color:var(--brand-dark);padding:1px 10px;font-size:12.5px;font-weight:600}
.combo__caret{flex:0 0 auto;color:var(--muted)}
.combo__panel{position:absolute;left:0;right:0;top:100%;margin-top:4px;z-index:30;background:#fff;border:1px solid var(--line-strong);border-radius:12px;box-shadow:0 12px 28px rgb(51 46 44 / .16);padding:8px}
.combo__list{max-height:280px;overflow-y:auto;margin-top:8px}
button.combo__item{display:flex;width:100%;justify-content:flex-start;gap:8px;text-align:left;border:0;border-radius:8px;background:none;padding:6px 8px;font-weight:500;color:var(--ink);white-space:normal}
button.combo__item.on{background:var(--brand-soft)}
.combo__star{flex:0 0 16px;color:#f0a500}
.entry--row{cursor:pointer;border:1px solid var(--line-strong);background:#fff;color:var(--ink);font-weight:500;border-radius:10px;align-items:center}
.entry--row:hover{background:var(--pink-soft)}
.favbox{border:1px solid var(--pink-line);background:var(--pink-soft);border-radius:12px;padding:8px 12px;margin:10px 0}
.favbox__title{font-size:13px;font-weight:700;color:var(--brand-dark);margin-bottom:4px}
.favrow{display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid var(--pink-line)}
.favrow:first-of-type{border-top:0}
button.favpath{flex:1;min-width:0;justify-content:flex-start;text-align:left;border:0;background:none;padding:0;white-space:normal;overflow-wrap:anywhere;font-weight:500;color:var(--ink)}
button.small{padding:3px 12px;font-size:13px}
button.favpath{flex-direction:column;align-items:flex-start;gap:1px}
.favnick{font-weight:700}
.favsub{font-size:12px;font-weight:400;color:var(--muted);overflow-wrap:anywhere;text-align:left}
.favlabel{flex:1;min-width:0}
input.favnickinput{width:100%;padding:4px 10px;font-size:14px}
.projbar{display:flex;align-items:center;gap:10px;margin:8px 0}
.projbar__name{flex:1;min-width:0;overflow-wrap:anywhere}
.conn button{flex:0 0 auto}
.conn .btns{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;flex:0 0 auto}
button.danger{color:var(--danger);border-color:var(--danger)}
input+details,select+details{margin-top:12px}
/* 排版 A：三個功能區塊永遠在主畫面；按「▸」按鈕時視窗往右加寬，右邊出現面板 */
.layout{display:flex;align-items:flex-start;min-height:100vh}
main{flex:1 1 560px;min-width:0;padding:14px 16px 28px}
/* 視窗放大（全螢幕）時，主畫面內容維持舒適的閱讀寬度並置中，多出來的空間留給右邊面板 */
main>*{max-width:760px;margin-left:auto!important;margin-right:auto!important}
.ext{display:none;flex:0 0 auto;width:clamp(var(--ext-w,420px),38vw,960px);position:sticky;top:0;height:100vh;overflow-y:auto;background:var(--surface);border-left:1px solid var(--line-strong);padding:16px 18px 24px}
.layout.ext-inline .ext{display:block;animation:ext-in .24s ease-out}
.layout.ext-overlay .ext{display:block;position:fixed;top:0;right:0;bottom:0;height:auto;width:min(var(--ext-w,420px),94vw);z-index:25;box-shadow:-14px 0 34px rgb(51 46 44 / .18);animation:ext-in .24s ease-out}
@keyframes ext-in{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}
.ext h2{font-size:17px;font-weight:700;margin:0 0 6px;padding-right:40px}
.ext h2::before{content:"";display:inline-block;width:5px;height:17px;border-radius:3px;background:var(--brand);margin-right:9px;vertical-align:-3px}
.ext__close{position:absolute;top:12px;right:14px;padding:2px 9px;font-size:13px;border-radius:10px}
.scrim{display:none;position:fixed;top:0;right:0;bottom:0;left:0;background:rgb(51 46 44 / .14);z-index:20}
.scrim.is-on{display:block}
.opener{justify-content:space-between;gap:10px}
.opener .arrow{transition:transform .2s;font-size:16px;line-height:1}
.opener.is-open{background:var(--brand);border-color:var(--brand);color:#fff}
.opener.is-open:hover:not(:disabled){background:var(--brand-hover);color:#fff}
.opener.is-open .arrow{transform:rotate(180deg)}
.opener.wide{width:100%}
.inline{display:flex;gap:8px;align-items:stretch}
.inline input{flex:1;min-width:0}
.foot{position:sticky;bottom:0;background:var(--surface);padding-top:10px;margin-top:10px;border-top:1px solid var(--line)}
.ow{padding:6px 0;border-top:1px solid rgb(176 118 27 / .25)}
.ow__name{font-weight:600;word-break:break-all}
.ow--newer .ow__name{color:var(--danger)}
.warnbox{background:var(--danger-bg);color:var(--danger);border-radius:var(--radius-field);padding:8px 12px;margin:8px 0;font-size:13.5px}
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
(function () {
  var TOKEN = "__EDIT_TOKEN__";
  var state = { connections: [], servers: [], repoPrefs: { starred: [], recent: {}, nicknames: {}, folders: {}, folderNicknames: {}, localPaths: {}, syncLocal: false }, sessions: [], svnAvailable: true, configured: false };
  var stateLoaded = false;
  var messages = {};
  var cardNotes = {};
  var busy = {};
  var confirmDiscard = {};
  /** 每張編輯卡片的「升級版本」狀態：{ on, plan, loading, newName }。 */
  var upgrades = {};
  /** 上傳成功後顯示在最上面的提示（點一下或 30 秒後消失）。 */
  var commitNotice = "";
  var cards = {};
  var pendingRequest = readQuery();
  var browseRequest = readBrowseQuery();
  var serverForm = { id: "", name: "", url: "", username: "", password: "" };
  var serverBusy = false;
  var deleteConfirmId = null;
  var localForm = { repo: "", path: "" };
  var localNote = null;
  var localBusy = false;
  var settingsNote = null;

  function readQuery() {
    var q = new URLSearchParams(location.search);
    var path = (q.get("path") || "").trim();
    if (!path) return null;
    return { connection: (q.get("connection") || "").trim(), path: path, ticket: (q.get("ticket") || "").trim() };
  }

  function readBrowseQuery() {
    var q = new URLSearchParams(location.search);
    if (!q.has("browse")) return null;
    return { connection: (q.get("connection") || "").trim(), path: (q.get("browse") || "").trim().replace(/^[/]+|[/]+$/g, ""), ticket: (q.get("ticket") || "").trim() };
  }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") el.className = attrs[k];
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
    });
    function add(c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    for (var i = 2; i < arguments.length; i++) add(arguments[i]);
    return el;
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { "X-Edit-Token": TOKEN, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.error || ("請求失敗（HTTP " + r.status + "）")); e.code = data.code; throw e; }
        return data;
      });
    });
  }

  var HINTS = {
    EDITOR_STILL_OPEN: "請先在 Word／Excel 存檔並關閉這個檔案，再按「上傳」。",
    REMOTE_CHANGED: "可以按「下載最新版另存」取得對方的版本，手動比對、合併後，再把內容貼回你正在編輯的檔案重新上傳。",
    NO_CHANGES: "還沒有修改任何內容。改完並存檔後再按「上傳」。",
    FILE_LOCKED: "檔案目前被別人鎖定編輯中，請等對方上傳或解除鎖定。",
    ALREADY_EDITING: "這個檔案已經有進行中的編輯，請到下方的編輯清單繼續處理。"
  };

  function refresh() {
    return api("GET", "/api/state").then(function (s) {
      state = s; stateLoaded = true;
      try { render(); } catch (e) { console.error(e); showBanner("頁面顯示發生錯誤：" + e.message, true); }
    }, function (e) { showBanner("無法連線到 svn-edit：" + e.message, true); });
  }

  function showBanner(text, isError) {
    var box = document.getElementById("banner");
    box.textContent = "";
    if (text) box.appendChild(h("div", { class: isError ? "banner" : "banner info", onclick: isError ? null : function () { commitNotice = ""; box.textContent = ""; } }, text));
  }

  function render() {
    var banner = [];
    if (state.connectionsError) banner.push(state.connectionsError);
    if (!state.svnAvailable) banner.push("找不到 svn 命令列工具。請安裝 TortoiseSVN，並在安裝時勾選「command line client tools」，裝好後重新整理這個頁面。");
    showBanner(banner.length ? banner.join("\n") : commitNotice, banner.length > 0);
    renderPending();
    renderSessions();
    renderBrowser();
    renderImporter();
    renderSettings();
    renderExt();
    // 第一次使用、還沒設定任何連線：直接把「連線」面板打開
    if (stateLoaded && !state.configured && !extAutoOpened) { extAutoOpened = true; if (ext.view === null) openExt("conn"); }
  }

  /** 跳出警示視窗（使用者按「知道了」才關）：遠端已經成功、但本地端沒處理好的情況要讓人一定看到。 */
  var alertBox = null;
  function showAlert(title, message) {
    function close() {
      if (alertBox && alertBox.parentNode) alertBox.parentNode.removeChild(alertBox);
      alertBox = null;
      document.removeEventListener("keydown", onKey, true);
    }
    function onKey(ev) { if (ev.key === "Escape" || ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); close(); } }
    if (alertBox) close();
    var ok = h("button", { type: "button", class: "primary", onclick: close }, "知道了");
    alertBox = h("div", { class: "modal", role: "alertdialog", "aria-modal": "true" },
      h("div", { class: "modal__box" }, h("h3", null, title), h("p", null, message), h("div", { class: "row" }, ok)));
    document.body.appendChild(alertBox);
    document.addEventListener("keydown", onKey, true);
    ok.focus();
  }
  function syncAlertTitle(sync, what) { return what + (sync.status === "failed" ? "，但同步本地端失敗" : "，但本地端沒有同步"); }

  // ---- 準備開始編輯（從 dev-pipeline 按鈕或連結進來） ----
  var pendingNote = null;
  var pendingSig = "";
  function renderPending() {
    var box = document.getElementById("pending");
    var sig = JSON.stringify([pendingRequest, pendingNote, state.connections]);
    if (sig === pendingSig) return;
    pendingSig = sig;
    box.textContent = "";
    if (!pendingRequest) return;
    var req = pendingRequest;
    var select = null;
    if (!req.connection && state.connections.length !== 1) {
      select = h("select", { id: "pendingConn" }, state.connections.map(function (c) { return h("option", { value: c.id }, connLabel(c)); }));
    }
    var reqConn = req.connection ? findConnection(req.connection) : null;
    var connName = reqConn ? reqConn.name : (req.connection || (state.connections.length === 1 ? state.connections[0].name : ""));
    var startBtn = h("button", { class: "primary", onclick: function () {
      var conn = req.connection || (select ? select.value : (state.connections[0] && state.connections[0].id));
      if (!conn) { pendingNote = "請先在下方「連線設定」新增 SVN 連線。"; renderPending(); return; }
      startBtn.disabled = true; startBtn.textContent = "取出檔案中…";
      api("POST", "/api/open", { connection: conn, path: req.path, ticket: req.ticket }).then(function () {
        pendingRequest = null; pendingNote = null; history.replaceState(null, "", location.pathname); return refresh();
      }).catch(function (e) {
        startBtn.disabled = false; startBtn.textContent = "開始編輯";
        pendingNote = e.message + (HINTS[e.code] ? "\n" + HINTS[e.code] : ""); renderPending();
      });
    } }, "開始編輯");
    function pendingConn() { return findConnection(req.connection || (select ? select.value : (state.connections[0] && state.connections[0].id))); }
    function fullUrlOf() { var c = pendingConn(); return c ? String(c.url).replace(/[/]+$/, "") + "/" + String(req.path).replace(/^[/]+/, "") : ""; }
    var urlText = h("div", { class: "loc__url" }, fullUrlOf());
    if (select) select.addEventListener("change", function () { urlText.textContent = fullUrlOf(); });
    var copyBtn = h("button", { type: "button", class: "primary", onclick: function () {
      copyText(fullUrlOf(), function () {
        copyBtn.textContent = "已複製 ✓"; copyBtn.classList.add("copied");
        setTimeout(function () { copyBtn.textContent = "複製位置"; copyBtn.classList.remove("copied"); }, 1800);
      });
    } }, "複製位置");
    var locBox = h("div", { class: "loc" }, h("div", { class: "loc__label" }, "遠端位置（完整 URL）"), h("div", { class: "loc__row" }, urlText, copyBtn));
    box.appendChild(h("div", { class: "card" },
      h("h2", null, "要開始編輯這個檔案嗎？"),
      h("p", { class: "path" }, req.path),
      h("div", { class: "badges" }, connName ? h("span", { class: "badge" }, "連線：" + connName) : null, req.ticket ? h("span", { class: "badge" }, "票號：" + req.ticket) : null),
      select ? h("div", null, h("label", null, "選擇連線"), select) : null,
      locBox,
      h("p", { class: "hint" }, "會把檔案取到暫存資料夾並用預設程式開啟；Word、Excel 檔會先在 SVN 上鎖定，避免別人同時修改。"),
      pendingNote ? h("div", { class: "msg" }, pendingNote) : null,
      h("div", { class: "row" }, startBtn, h("button", { onclick: function () { pendingRequest = null; pendingNote = null; history.replaceState(null, "", location.pathname); render(); } }, "取消"))
    ));
  }

  // ---- 編輯清單 ----
  function upgradeSig(id) {
    var u = upgrades[id];
    return u ? JSON.stringify([u.on, u.loading, u.newName, u.plan ? [u.plan.applicable, u.plan.reason, u.plan.newName, u.plan.archiveDirExists] : null]) : "";
  }

  function sessionSig(s) {
    return [s.session.id, s.modified, s.editorStillOpen, busy[s.session.id] || "", cardNotes[s.session.id] ? cardNotes[s.session.id].text : "", !!confirmDiscard[s.session.id], upgradeSig(s.session.id)].join("|");
  }

  function renderSessions() {
    var box = document.getElementById("sessions");
    var live = {};
    state.sessions.forEach(function (s) { live[s.session.id] = true; });
    Object.keys(cards).forEach(function (id) { if (!live[id]) { if (cards[id].el.parentNode) cards[id].el.parentNode.removeChild(cards[id].el); delete cards[id]; } });
    if (state.sessions.length === 0) return;
    state.sessions.forEach(function (s, index) {
      var id = s.session.id;
      var sig = sessionSig(s);
      if (!cards[id] || cards[id].sig !== sig) {
        var hadFocus = cards[id] && document.activeElement === cards[id].textarea;
        var built = buildCard(s);
        if (cards[id] && cards[id].el.parentNode) cards[id].el.parentNode.replaceChild(built.el, cards[id].el);
        cards[id] = { el: built.el, textarea: built.textarea, sig: sig };
        if (hadFocus) built.textarea.focus();
      }
      if (!cards[id].el.parentNode) box.appendChild(cards[id].el);
    });
  }

  function buildCard(s) {
    var session = s.session;
    var id = session.id;
    if (messages[id] === undefined) messages[id] = session.ticket ? "[" + session.ticket + "] " : "";
    var note = cardNotes[id];
    var disabled = !!busy[id];
    var textarea = h("textarea", { placeholder: "說明這次改了什麼（必填）", oninput: function () { messages[id] = textarea.value; } });
    textarea.value = messages[id];
    function run(label, fn) {
      busy[id] = label; cardNotes[id] = null; render();
      fn().then(function (result) { busy[id] = ""; if (result && result.note) cardNotes[id] = { text: result.note, info: true }; return refresh(); })
        .catch(function (e) { busy[id] = ""; cardNotes[id] = { text: e.message + (HINTS[e.code] ? "\n" + HINTS[e.code] : ""), info: false }; return refresh(); });
    }
    var up = upgrades[id] || (upgrades[id] = { on: false, plan: null, loading: false, newName: "" });
    function loadPlan(newName) {
      up.loading = true; render();
      api("GET", "/api/upgrade-plan?id=" + encodeURIComponent(id) + (newName ? "&newName=" + encodeURIComponent(newName) : "")).then(function (plan) {
        up.plan = plan; up.newName = plan.newName || newName || ""; up.loading = false; render();
      }).catch(function (e) {
        up.loading = false; up.plan = { applicable: false, reason: e.message, newName: newName || null }; render();
      });
    }
    var toggle = h("input", { type: "checkbox", checked: up.on ? "checked" : null, disabled: disabled ? "disabled" : null });
    toggle.addEventListener("change", function () { up.on = toggle.checked; if (up.on) loadPlan(up.newName); else render(); });
    var upgradeBox = h("div", { class: "upgrade" },
      h("label", null, toggle, h("span", null, "升級版本（舊版放進 old 資料夾，新版的版本號 +1）")));
    if (up.on) {
      var plan = up.plan;
      if (up.loading || !plan) {
        upgradeBox.appendChild(h("p", { class: "hint" }, "正在確認遠端目錄…"));
      } else {
        var oldPlace = plan.archiveDirName + "/" + plan.archiveFileName;
        upgradeBox.appendChild(h("p", { class: "hint" }, "舊版「" + plan.currentName + "」會複製到「" + oldPlace + "」" +
          (plan.archiveFileName !== plan.currentName ? "（原檔名沒有版次，放進 old 時自動補上 _v0.1）" : "") +
          (plan.archiveDirExists ? "。" : "。這個目錄下還沒有 old 資料夾，會自動建立。")));
        if (plan.newName !== null) {
          var nameInput = h("input", { type: "text", value: up.newName, disabled: disabled ? "disabled" : null });
          nameInput.addEventListener("change", function () { up.newName = nameInput.value.trim(); loadPlan(up.newName); });
          upgradeBox.appendChild(h("label", { class: "upgrade__name" }, "新版檔名（可以自己修改）"));
          upgradeBox.appendChild(nameInput);
          upgradeBox.appendChild(h("p", { class: "hint" }, plan.implicitVersion ? "原檔名沒有版次，新版自動加上 _v0.2。" : "版本號已自動 +1（" + plan.currentVersion + " → " + plan.newVersion + "）。"));
        }
        if (plan.reason) upgradeBox.appendChild(h("div", { class: "msg" }, plan.reason));
        upgradeBox.appendChild(h("p", { class: "hint" }, "上傳時舊版與新版會在同一個 commit 一起完成，舊版的歷史紀錄都保留。"));
      }
    }
    var upgradeBlocked = up.on && (up.loading || !up.plan || !up.plan.applicable);
    var commitLabel = busy[id] === "上傳中…" ? "上傳中…" : (up.on && up.plan && up.plan.newVersion ? "上傳並升級到 " + up.plan.newVersion : "上傳");
    var commit = h("button", { class: "primary", disabled: (disabled || upgradeBlocked) ? "disabled" : null, onclick: function () {
      run("上傳中…", function () {
        var body = { id: id, message: messages[id] };
        if (up.on) body.upgrade = up.newName ? { newName: up.newName } : true;
        return api("POST", "/api/commit", body).then(function (r) {
          delete messages[id]; delete cardNotes[id]; delete upgrades[id];
          var sync = r.localSync;
          if (r.upgrade || sync) {
            commitNotice = (r.upgrade
              ? "已升級並上傳（r" + r.committedRevision + "）：新版「" + r.upgrade.newName + "」；舊版放進「" + r.upgrade.archivedTo + "」。"
              : "已上傳（r" + r.committedRevision + "）：" + r.path + "。") + (sync && sync.status === "updated" ? " " + sync.message : "");
            setTimeout(function () { commitNotice = ""; render(); }, 30000);
          }
          if (sync && sync.status !== "updated") showAlert(syncAlertTitle(sync, "已上傳到 SVN"), sync.message);
          return { note: null, done: r };
        });
      });
    } }, commitLabel);
    var discard = h("button", { class: "danger", disabled: disabled ? "disabled" : null, onclick: function () {
      if (!confirmDiscard[id]) { confirmDiscard[id] = true; render(); return; }
      delete confirmDiscard[id];
      run("放棄中…", function () { return api("POST", "/api/discard", { id: id }).then(function () { delete messages[id]; return null; }); });
    } }, confirmDiscard[id] ? "確定放棄？你的修改會被丟掉" : "放棄");
    var el = h("div", { class: "card" },
      h("h2", null, session.fileName),
      h("p", { class: "path" }, session.connectionName + " / " + session.path),
      h("div", { class: "badges" },
        session.locked ? h("span", { class: "badge ok" }, "已在 SVN 鎖定") : null,
        h("span", { class: "badge" }, "基準版本 r" + session.baseRevision),
        s.modified ? h("span", { class: "badge ok" }, "已修改") : h("span", { class: "badge" }, "尚未修改"),
        s.editorStillOpen ? h("span", { class: "badge warn" }, "檔案還開著（請先關閉再上傳）") : null),
      h("label", null, "上傳說明（commit 訊息）"), textarea,
      upgradeBox,
      note ? h("div", { class: note.info ? "msg info" : "msg" }, note.text) : null,
      h("div", { class: "row" },
        commit,
        h("button", { disabled: disabled ? "disabled" : null, onclick: function () { run("開啟中…", function () { return api("POST", "/api/reopen", { id: id }).then(function () { return { note: "已用預設程式重新開啟檔案。" }; }); }); } }, "重新開啟檔案"),
        h("button", { disabled: disabled ? "disabled" : null, onclick: function () { run("下載中…", function () { return api("POST", "/api/export-latest", { id: id }).then(function (r) { return { note: "已把遠端最新版（r" + r.revision + "）另存到：" + r.path }; }); }); } }, "下載最新版另存"),
        discard));
    return { el: el, textarea: textarea };
  }

  // ---- 瀏覽 SVN 目錄（唯讀）：主畫面只放一張卡片，清單在往右延伸的面板裡 ----
  var browse = { connection: "", path: "", entries: null, truncated: false, loading: false, error: null, ticket: "", notice: null, picking: true };
  // 專案選擇畫面（近期／星星分頁、搜尋、簡稱）的暫時狀態
  var picker = { tab: "recent", query: "", editing: "", note: null, busy: false };
  var browseSig = "";
  var browseStarted = false;

  function findConnection(ref) {
    for (var i = 0; i < state.connections.length; i++) {
      if (state.connections[i].id === ref || state.connections[i].name === ref) return state.connections[i];
    }
    return null;
  }

  function loadBrowse(path) {
    browse.path = path; browse.loading = true; browse.error = null; browse.notice = null; browse.entries = null; browse.del = null; browse.sel = {}; renderExt();
    api("GET", "/api/browse?connection=" + encodeURIComponent(browse.connection) + "&path=" + encodeURIComponent(path)).then(function (r) {
      browse.loading = false; browse.entries = r.entries; browse.truncated = r.truncated; renderExt();
    }).catch(function (e) {
      browse.loading = false; browse.error = e.message; renderExt();
    });
  }

  // 會往右延伸的按鈕：展開中呈紅色，箭頭轉向
  function openerButton(view, label, extraClass, disabled) {
    return h("button", { type: "button", class: "opener" + (extraClass ? " " + extraClass : "") + (ext.view === view ? " is-open" : ""), disabled: disabled ? "disabled" : null, onclick: function () { openExt(view); } },
      h("span", null, label), h("span", { class: "arrow" }, "▸"));
  }
  function noConnectionHint() {
    return h("p", { class: "hint" }, "還沒有任何帳號，請先到下方的「連線設定」填寫伺服器網址與帳密。");
  }

  function renderBrowser() {
    var box = document.getElementById("browser");
    if (browseRequest && !browseStarted && state.connections.length > 0) {
      browseStarted = true;
      var wanted = findConnection(browseRequest.connection) || state.connections[0];
      browse.connection = wanted.id; browse.ticket = browseRequest.ticket; browse.path = browseRequest.path; browse.picking = false;
      recordOpened(wanted.name);
      openExt("browse");
    }
    var sig = JSON.stringify([state.connections.length, ext.view === "browse", browse.ticket]);
    if (sig === browseSig) return;
    browseSig = sig;
    box.textContent = "";
    box.appendChild(h("div", { class: "card" },
      h("h2", null, "瀏覽 SVN 目錄"),
      h("p", { class: "hint" }, "從 SVN 上選一個檔案來編輯（只會讀取，不會改動任何東西）。" + (browse.ticket ? "票號：" + browse.ticket : "")),
      state.connections.length === 0 ? noConnectionHint() : h("div", { class: "row" }, openerButton("browse", "瀏覽 SVN 目錄", "wide"))));
  }

  /** 帳號的顯示文字：名稱是使用者自己填的就只顯示名稱；留空（系統自動用主機名稱）才補上帳號，不然分不出是誰。 */
  function accountLabel(sv) {
    var host = String(sv.url || "").replace(/^[a-z]+:[/][/]/i, "").split("/")[0];
    var named = sv.name && sv.name !== host && sv.name !== sv.url;
    return (named ? sv.name : sv.name + "（" + sv.username + "）") + "・" + sv.repoCount + " 個 repo";
  }
  /** repo 連線的顯示名稱：repo 名稱後面帶舊版取的別名（例如 PROJ-One（專案甲））。 */
  function connLabel(c) { return c.aliases && c.aliases.length ? c.name + "（" + c.aliases.join("、") + "）" : c.name; }
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  /** SVN 回傳的 ISO 時間 → 本機時間 yyyy-MM-dd HH:mm；讀不出來回傳空字串。 */
  function fmtDate(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function fmtDuration(ms) {
    var sec = Math.round(ms / 1000);
    if (sec < 1) return "不到 1 秒";
    if (sec < 60) return sec + " 秒";
    return Math.floor(sec / 60) + " 分 " + (sec % 60) + " 秒";
  }
  /** 複製文字到剪貼簿（Edge 沒給權限時退回舊做法），完成後呼叫 done。 */
  function copyText(text, done) {
    function fallback() {
      var ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e) { /* 複製失敗就算了 */ }
      document.body.removeChild(ta); done();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  function safeDecode(text) { try { return decodeURIComponent(text); } catch (e) { return text; } }
  /** 路徑列：「根目錄 → 3-SD → 9-SOURCE」，每一段都能點回那一層，目前這一層是粗體黑字、不能點。 */
  function crumbNodes(segments, go) {
    var levels = [{ label: "根目錄", target: "" }].concat(segments.map(function (seg, i) { return { label: seg, target: segments.slice(0, i + 1).join("/") }; }));
    var nodes = [];
    levels.forEach(function (lv, i) {
      if (i > 0) nodes.push(h("span", { class: "sep" }, "→"));
      if (i === levels.length - 1) nodes.push(h("span", { class: "cur" }, lv.label));
      else nodes.push(h("button", { type: "button", title: "回到這一層", onclick: function () { go(lv.target); } }, lv.label));
    });
    return nodes;
  }
  /** 清單圖示：資料夾「夾」、Word「W」、Excel「X」（.xls 與 .xlsx 同一種）、PDF、圖片等各有顏色。 */
  var BADGE_BY_EXT = { doc: ["docx", "W"], docx: ["docx", "W"], xls: ["xlsx", "X"], xlsx: ["xlsx", "X"], pdf: ["pdf", "PDF"], md: ["md", "MD"], txt: ["txt", "TXT"], csv: ["csv", "CSV"],
    png: ["img", "PNG"], jpg: ["img", "JPG"], jpeg: ["img", "JPG"], gif: ["img", "GIF"], bmp: ["img", "BMP"] };
  function badgeOf(entry) {
    if (entry.kind === "dir") return { cls: "dir", text: "夾" };
    var m = /[.]([a-z0-9]+)$/i.exec(entry.name || "");
    var ext = m ? m[1].toLowerCase() : "";
    var hit = BADGE_BY_EXT[ext];
    return hit ? { cls: hit[0], text: hit[1] } : { cls: "other", text: (ext || "檔").slice(0, 4).toUpperCase() };
  }
  function fileBadge(entry, small) { var b = badgeOf(entry); return h("div", { class: "fb fb--" + b.cls + (small ? " fb--sm" : "") }, b.text); }
  /** 檔名下面那一行小字：「r2238 ・ 作者 ・ 2026-07-31 15:24」；不能編輯的檔案補上原因。 */
  function entryMetaText(entry) {
    if (entry.kind === "dir") return "";
    var parts = [];
    if (entry.revision) parts.push("r" + entry.revision);
    if (entry.author) parts.push(entry.author);
    var when = fmtDate(entry.date);
    if (when) parts.push(when);
    if (!entry.editable && !entry.viewable) parts.push(entry.tempFile ? "Office 暫存檔，不是文件" : "不支援編輯");
    return parts.join(" • ");
  }
  function fiMain(entry) {
    var meta = entryMetaText(entry);
    return h("div", { class: "fi__main" }, h("div", { class: "fi__name" }, entry.name + (entry.kind === "dir" ? " /" : "")), meta ? h("div", { class: "fi__meta" }, meta) : null);
  }
  /** 唯讀檢視：請伺服器匯出最新版並用預設程式開啟；結果顯示在面板上方的提示列。 */
  function viewFile(full) {
    browse.notice = { text: "正在取出並開啟…", error: false }; renderExt();
    api("POST", "/api/view", { connection: browse.connection, path: full }).then(function (r) {
      browse.notice = { text: "已用預設程式開啟最新版（r" + r.revision + "，唯讀）：" + full, error: false }; renderExt();
    }).catch(function (e) {
      browse.notice = { text: e.message || "開啟失敗", error: true }; renderExt();
    });
  }
  // ---- 專案選擇：近期／星星分頁、搜尋、星星、簡稱（專案很多時用來快速找）----
  function prefsNow() { return state.repoPrefs || { starred: [], recent: {}, nicknames: {}, folders: {}, folderNicknames: {}, localPaths: {}, syncLocal: false }; }
  function isStarred(name) { return prefsNow().starred.indexOf(name) >= 0; }
  function nicknameOf(c) { return prefsNow().nicknames[c.name] || ""; }
  /** 簡稱欄顯示什麼：自己取的簡稱優先，沒有就顯示舊版別名當提示。 */
  function pillOf(c) { var nick = nicknameOf(c); return nick ? { text: nick, kind: "nick" } : (c.aliases && c.aliases.length ? { text: c.aliases[0], kind: "alias" } : { text: "簡稱", kind: "empty" }); }
  function byName(a, b) { return a.name.localeCompare(b.name, "zh-Hant"); }
  function recentList() {
    var recent = prefsNow().recent;
    return state.connections.slice().sort(function (a, b) {
      var ta = recent[a.name] || "", tb = recent[b.name] || "";
      if (ta !== tb) return ta < tb ? 1 : -1;
      return byName(a, b);
    });
  }
  function starList() {
    var out = [];
    prefsNow().starred.forEach(function (name) { var c = state.connections.filter(function (x) { return x.name === name; })[0]; if (c) out.push(c); });
    return out;
  }
  /** 搜尋：空白分隔的每個詞都要出現在「名稱、別名、簡稱」其中之一（不分大小寫）。 */
  function matchesQuery(c, query) {
    var hay = (c.name + " " + (c.aliases || []).join(" ") + " " + nicknameOf(c)).toLowerCase();
    return query.toLowerCase().split(" ").filter(function (t) { return t; }).every(function (t) { return hay.indexOf(t) >= 0; });
  }
  function recordOpened(name) {
    api("POST", "/api/repo-prefs/open", { name: name }).then(function (r) { state.repoPrefs = r.prefs; }).catch(function () {});
  }
  function backToPicker() { browse.picking = true; browse.entries = null; browse.error = null; browse.notice = null; renderExt(); }
  function openProject(c) {
    browse.connection = c.id; browse.picking = false; browse.path = "";
    recordOpened(c.name);
    loadBrowse("");
  }
  function savePrefs(call) {
    return call.then(function (r) { state.repoPrefs = r.prefs; renderPickerList(); importRerender(); }).catch(function (e) {
      picker.note = { text: e.message || "儲存失敗", error: true }; refresh().then(function () { extSig = ""; renderExt(); });
    });
  }
  function toggleStar(c) {
    var on = !isStarred(c.name);
    var p = prefsNow();
    state.repoPrefs = { starred: on ? p.starred.concat([c.name]) : p.starred.filter(function (n) { return n !== c.name; }), recent: p.recent, nicknames: p.nicknames, folders: p.folders || {}, folderNicknames: p.folderNicknames || {}, localPaths: p.localPaths || {}, syncLocal: !!p.syncLocal };
    renderPickerList();
    savePrefs(api("POST", "/api/repo-prefs/star", { name: c.name, starred: on }));
  }
  function starButton(c) {
    var on = isStarred(c.name);
    var btn = h("button", { type: "button", class: "star" + (on ? " on" : ""), title: on ? "取消星星" : "加入星星（放到「星星 SVN」）", onclick: function (ev) {
      ev.stopPropagation(); toggleStar(c); var now = isStarred(c.name); btn.textContent = now ? "★" : "☆"; btn.className = "star" + (now ? " on" : "");
    } }, on ? "★" : "☆");
    return btn;
  }
  function moveStar(dragged, target, after) {
    var order = starList().map(function (c) { return c.name; }).filter(function (n) { return n !== dragged; });
    var at = order.indexOf(target) + (after ? 1 : 0);
    order.splice(at < 0 ? order.length : at, 0, dragged);
    var p = prefsNow();
    state.repoPrefs = { starred: order, recent: p.recent, nicknames: p.nicknames, folders: p.folders || {}, folderNicknames: p.folderNicknames || {}, localPaths: p.localPaths || {}, syncLocal: !!p.syncLocal };
    renderPickerList();
    savePrefs(api("POST", "/api/repo-prefs/reorder", { order: order }));
  }
  var dragName = null;
  function projectRow(c, canDrag) {
    var pill = pillOf(c);
    var right;
    if (picker.editing === c.name) {
      var input = h("input", { class: "nickinput", type: "text", maxlength: "30", placeholder: "簡稱", value: nicknameOf(c), onclick: function (ev) { ev.stopPropagation(); } });
      var finished = false;
      var finish = function (save) {
        if (finished) return; finished = true; picker.editing = "";
        if (save && input.value.trim() !== nicknameOf(c)) savePrefs(api("POST", "/api/repo-prefs/nickname", { name: c.name, nickname: input.value }));
        else renderPickerList();
      };
      input.addEventListener("keydown", function (ev) { ev.stopPropagation(); if (ev.key === "Enter") finish(true); else if (ev.key === "Escape") finish(false); });
      input.addEventListener("blur", function () { finish(true); });
      right = input;
      setTimeout(function () { input.focus(); input.select(); }, 0);
    } else {
      right = h("button", { type: "button", class: "nick " + pill.kind, title: pill.kind === "alias" ? "舊版取的名稱；點一下設定你自己的簡稱" : "點一下設定簡稱（只存在你的電腦，搜尋時也會比對）", onclick: function (ev) { ev.stopPropagation(); picker.editing = c.name; renderPickerList(); } }, pill.text);
    }
    var row = h("div", { class: "proj" + (canDrag ? " draggable" : ""), role: "button", tabindex: "0", "data-name": c.name, draggable: canDrag ? "true" : null, onclick: function () { openProject(c); } },
      canDrag ? h("span", { class: "grip", title: "拖曳調整順序" }, "⋮⋮") : null,
      starButton(c),
      h("span", { class: "proj__name" }, c.name),
      right);
    row.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && ev.target === row) openProject(c); });
    if (canDrag) {
      var clearMarks = function () { row.classList.remove("drop-before", "drop-after"); };
      var isAfter = function (ev) { var r = row.getBoundingClientRect(); return ev.clientY > r.top + r.height / 2; };
      row.addEventListener("dragstart", function (ev) { dragName = c.name; row.classList.add("dragging"); try { ev.dataTransfer.setData("text/plain", c.name); ev.dataTransfer.effectAllowed = "move"; } catch (e) {} });
      row.addEventListener("dragend", function () { dragName = null; row.classList.remove("dragging"); });
      row.addEventListener("dragover", function (ev) {
        if (!dragName || dragName === c.name) return;
        ev.preventDefault(); clearMarks(); row.classList.add(isAfter(ev) ? "drop-after" : "drop-before");
      });
      row.addEventListener("dragleave", clearMarks);
      row.addEventListener("drop", function (ev) {
        ev.preventDefault(); clearMarks();
        if (!dragName || dragName === c.name) return;
        var moved = dragName; dragName = null; moveStar(moved, c.name, isAfter(ev));
      });
    }
    return row;
  }
  /** 只重畫清單與底下的說明（打字搜尋時不能重畫搜尋框，不然會失去焦點）。 */
  function renderPickerList() {
    var box = document.getElementById("pickerList");
    if (!box) return;
    var foot = document.getElementById("pickerFoot");
    var query = picker.query.trim();
    var isStar = picker.tab === "star";
    var all = isStar ? starList() : recentList();
    var shown = query ? all.filter(function (c) { return matchesQuery(c, query); }) : all;
    var canDrag = isStar && !query;
    box.textContent = "";
    if (shown.length === 0) {
      box.appendChild(h("div", { class: "empty" }, query ? "找不到符合「" + query + "」的專案。" : (isStar ? "還沒有星星專案。到「近期 SVN」點 ☆，常用的專案就會放在這裡。" : "還沒有任何專案。")));
    }
    shown.forEach(function (c) { box.appendChild(projectRow(c, canDrag)); });
    if (foot) {
      foot.textContent = isStar
        ? "共 " + all.length + " 個星星專案" + (query ? "・符合 " + shown.length + " 個" : "・拖曳 ⋮⋮ 調整順序")
        : "共 " + state.connections.length + " 個專案" + (query ? "・符合 " + shown.length + " 個" : "・點 ☆ 加入常用，點簡稱可以取自己的暱稱");
    }
  }
  function renderProjectPicker(box) {
    var search = h("input", { type: "text", placeholder: "搜尋專案（共 " + state.connections.length + " 個）", autocomplete: "off", value: picker.query, oninput: function () { picker.query = search.value; renderPickerList(); } });
    var reload = h("button", { type: "button", class: "reload", title: "重新載入專案清單（伺服器上新增專案時用）", disabled: picker.busy ? "disabled" : null, onclick: function () {
      picker.busy = true; picker.note = { text: "正在重新載入專案清單…", error: false }; extSig = ""; renderExt();
      api("POST", "/api/servers/refresh-all", {}).then(function (r) {
        picker.busy = false;
        picker.note = r.failed.length ? { text: "有 " + r.failed.length + " 個帳號沒讀成功：" + r.failed.map(function (f) { return f.name + "（" + f.error + "）"; }).join("；"), error: true } : { text: "已重新載入，共 " + r.repoCount + " 個專案。", error: false };
        return refresh();
      }).then(function () { extSig = ""; renderExt(); }).catch(function (e) { picker.busy = false; picker.note = { text: e.message, error: true }; extSig = ""; renderExt(); });
    } }, "↻");
    function tab(key, label) {
      return h("button", { type: "button", class: picker.tab === key ? "on" : "", onclick: function () { if (picker.tab === key) return; picker.tab = key; extSig = ""; renderExt(); } }, label);
    }
    box.appendChild(h("div", null,
      h("h2", null, "選擇專案，瀏覽目錄"),
      h("p", { class: "hint" }, "近期 SVN：最近點開的在最上面　｜　星星 SVN：★ 在最上面，可拖曳排序"),
      h("div", { class: "tabs" }, tab("recent", "近期 SVN"), tab("star", "星星 SVN")),
      h("div", { class: "searchrow" }, search, reload),
      picker.note ? h("div", { class: picker.note.error ? "msg" : "hint" }, picker.note.text) : null,
      h("div", { class: "projlist", id: "pickerList" }),
      h("p", { class: "hint", id: "pickerFoot" })));
    renderPickerList();
  }

  function pickBox(full) {
    var box = h("input", { type: "checkbox", class: "pick", title: "勾選（檔案或資料夾，可多選一起刪除）", checked: (browse.sel && browse.sel[full]) ? "checked" : null });
    box.addEventListener("change", function () {
      browse.sel = browse.sel || {};
      if (box.checked) browse.sel[full] = true; else delete browse.sel[full];
      extSig = ""; renderExt();
    });
    return box;
  }
  function deleteBox(current) {
    var d = browse.del;
    var prefs = prefsNow();
    var localDir = prefs.localPaths && prefs.localPaths[current.name];
    var syncHint = prefs.syncLocal
      ? (localDir ? "同步本地端已開啟：本地目錄 " + localDir + " 也會一起更新。" : "同步本地端已開啟，但這個專案還沒設定本地目錄，本地端不會更新。")
      : "";
    var dirs = d.dirs || [];
    var shown = d.paths.slice(0, 8).map(function (p) { return h("div", { class: "path", style: "margin:0" }, (dirs.indexOf(p) >= 0 ? "📁 " : "📄 ") + p); });
    var area = h("textarea", { placeholder: "說明為什麼刪除（必填，會寫進 SVN 的 commit 訊息）", disabled: d.busy ? "disabled" : null, oninput: function () { d.message = area.value; } });
    area.value = d.message;
    function fail(text) { d.busy = false; d.error = text; extSig = ""; renderExt(); }
    var confirmBtn = h("button", { type: "button", class: "danger", disabled: d.busy ? "disabled" : null, onclick: function () {
      if (!d.message.trim()) { fail("請填寫刪除說明"); return; }
      d.busy = true; d.error = null; extSig = ""; renderExt();
      api("POST", "/api/delete", { connection: browse.connection, paths: d.paths, message: d.message }).then(function (r) {
        var sync = r.localSync;
        var count = r.paths.length;
        loadBrowse(browse.path);
        browse.notice = { text: "已刪除 " + count + " 個項目（r" + r.deletedRevision + "）" + (sync && sync.status === "updated" ? "。" + sync.message : ""), error: false };
        extSig = ""; renderExt();
        if (sync && sync.status !== "updated") showAlert(syncAlertTitle(sync, "已刪除 SVN 上的項目"), sync.message);
      }).catch(function (e) { fail(e.message + (HINTS[e.code] ? String.fromCharCode(10) + HINTS[e.code] : "")); });
    } }, d.busy ? "刪除中…" : "確定刪除 " + d.paths.length + " 個項目");
    return h("div", { class: "delbox" },
      h("p", null, h("strong", null, "要刪除 SVN 上的這 " + d.paths.length + " 個項目嗎？")),
      h("div", { style: "margin:0 0 8px" }, shown, d.paths.length > shown.length ? h("div", { class: "path", style: "margin:0" }, "…另外還有 " + (d.paths.length - shown.length) + " 個") : null),
      dirs.length ? h("div", { class: "warnbox" }, "其中 " + dirs.length + " 個是資料夾，會連同底下所有檔案一起刪除。") : null,
      h("p", { class: "hint", style: "margin:0 0 8px" }, "會產生一個新版本，之後仍可從 SVN 歷史還原。" + syncHint),
      area,
      d.error ? h("div", { class: "msg" }, d.error) : null,
      h("div", { class: "row" }, confirmBtn, h("button", { type: "button", disabled: d.busy ? "disabled" : null, onclick: function () { browse.del = null; extSig = ""; renderExt(); } }, "取消")));
  }

  function renderBrowseView(box) {
    if (state.connections.length === 0) { box.appendChild(h("div", null, h("h2", null, "瀏覽 SVN 目錄"), noConnectionHint())); return; }
    if (browse.picking || !findConnection(browse.connection)) { renderProjectPicker(box); return; }
    var current = findConnection(browse.connection);
    var projbar = h("div", { class: "projbar" },
      h("button", { type: "button", onclick: backToPicker }, "← 專案清單"),
      h("strong", { class: "projbar__name" }, connLabel(current)),
      starButton(current));
    var segments = browse.path ? browse.path.split("/") : [];
    var crumbs = crumbNodes(segments, loadBrowse);
    function entryNode(entry) {
      var full = browse.path ? browse.path + "/" + entry.name : entry.name;
      if (entry.viewable) {
        return h("button", { type: "button", class: "entry fi", title: "用電腦預設的程式開啟最新版（唯讀，不能編輯、也不會改動 SVN）", onclick: function () { viewFile(full); } },
          fileBadge(entry), fiMain(entry));
      }
      if (entry.kind === "dir") {
        var dirRow = h("div", { class: "entry entry--row fi", role: "button", tabindex: "0", onclick: function () { loadBrowse(full); } },
          folderStarButton(current.name, full), fileBadge(entry), fiMain(entry));
        dirRow.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && ev.target === dirRow) loadBrowse(full); });
        return dirRow;
      }
      return h("button", { type: "button", class: "entry fi", disabled: entry.editable ? null : "disabled", title: entry.editable ? "" : (entry.tempFile ? "這是 Word／Excel 開著文件時自動產生的暫存檔，不是文件本身（可能是被誤提交進 SVN 的）" : "不支援編輯這種檔案類型"),
        onclick: function () {
          pendingRequest = { connection: browse.connection, path: full, ticket: browse.ticket };
          closeExt(); render(); window.scrollTo(0, 0);
        } }, fileBadge(entry), fiMain(entry));
    }
    var rows = (browse.entries || []).map(function (entry) {
      var node = entryNode(entry);
      return h("div", { class: "entryrow" }, pickBox(browse.path ? browse.path + "/" + entry.name : entry.name), node);
    });
    var fileEntries = browse.entries || []; // 檔案與資料夾都能勾選刪除
    function fullOf(e) { return browse.path ? browse.path + "/" + e.name : e.name; }
    var sel = browse.sel || (browse.sel = {});
    var picked = fileEntries.filter(function (e) { return sel[fullOf(e)]; });
    var allBox = h("input", { type: "checkbox", checked: (fileEntries.length && picked.length === fileEntries.length) ? "checked" : null });
    allBox.addEventListener("change", function () {
      fileEntries.forEach(function (e) { if (allBox.checked) sel[fullOf(e)] = true; else delete sel[fullOf(e)]; });
      extSig = ""; renderExt();
    });
    var selBar = fileEntries.length ? h("div", { class: "selbar" },
      h("label", null, allBox, "全選"),
      h("span", { class: "grow" }, picked.length ? "已選 " + picked.length + " 個項目" : ""),
      picked.length ? h("button", { type: "button", class: "danger", onclick: function () {
        browse.del = { paths: picked.map(fullOf), dirs: picked.filter(function (e) { return e.kind === "dir"; }).map(fullOf), message: "", busy: false, error: null }; browse.notice = null; extSig = ""; renderExt();
      } }, "刪除所選") : null) : null;
    var dirCount = fileEntries.filter(function (e) { return e.kind === "dir"; }).length;
    var stats = fileEntries.length ? h("div", { class: "stat" }, dirCount + " 個資料夾、" + (fileEntries.length - dirCount) + " 個檔案") : null;
    var trackbar = h("div", { class: "trackbar" },
      h("span", null, "目前這一層：", h("b", null, browse.path || "（整個專案）")),
      h("button", { type: "button", class: "primary", title: "把這個目錄取到你的電腦，建立 SVN 追蹤", onclick: function () { openCheckout(current); } }, "⬇ Checkout 到本地"));
    box.appendChild(h("div", null,
      h("h2", null, "瀏覽 SVN 目錄"),
      h("p", { class: "hint" }, "點資料夾進入；點檔案會回到主畫面，出現「開始編輯」的確認卡。PDF（👁）只能開啟檢視，不能編輯。"),
      browse.notice ? h("div", { class: browse.notice.error ? "msg" : "hint" }, browse.notice.text) : null,
      browse.del ? deleteBox(current) : null,
      projbar,
      renderFavBox(current.name, loadBrowse, null),
      h("div", { class: "crumbs" }, crumbs),
      trackbar,
      browse.path ? h("div", { class: "hint", style: "margin:0 0 8px;display:flex;align-items:center;gap:8px" },
        folderStarButton(current.name, browse.path),
        h("span", { style: "flex:1;min-width:0;overflow-wrap:anywhere" }, "目前位置：" + browse.path + (favFolders(current.name).indexOf(browse.path) >= 0 ? "　（已是常用目錄）" : "　（點 ☆ 加入常用目錄）"))) : null,
      browse.loading ? h("div", { class: "empty" }, "讀取中…") : null,
      browse.error ? h("div", { class: "msg" }, browse.error) : null,
      !browse.loading && !browse.error && browse.entries && browse.entries.length === 0 ? h("div", { class: "empty" }, "這個目錄是空的。") : null,
      selBar,
      rows,
      stats,
      browse.truncated ? h("p", { class: "hint" }, "項目太多，只顯示前 1000 個。") : null));
  }

  // ---- 新增檔案到 SVN（多個檔案、整個資料夾）----
  var MAX_FILE_BYTES = 52428800;
  var MAX_BATCH_FILES = 300000;
  var MAX_BATCH_BYTES = 4294967296;
  var STAGE_PARALLEL = 4;
  var EXCLUDED_DIRS = [".svn", ".git", ".hg"];
  var EXCLUDED_FILES = ["thumbs.db", "desktop.ini", ".ds_store"];
  var importForm = {
    connection: "", path: browseRequest ? browseRequest.path : "", message: "",
    files: [], skipped: { temp: 0, empty: 0, big: 0 },
    phase: "idle", progress: 0, batch: null, plan: null, note: null
  };
  var importerSig = "";

  function fmtSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function cleanDir(p) { return (p || "").trim().replace(/^[/]+|[/]+$/g, ""); }
  function isExcludedPath(rel) {
    var parts = rel.split("/");
    for (var i = 0; i < parts.length - 1; i++) {
      if (EXCLUDED_DIRS.indexOf(parts[i].toLowerCase()) >= 0) return true;
    }
    var name = parts[parts.length - 1];
    return name.indexOf("~$") === 0 || name.indexOf(".~lock.") === 0 || EXCLUDED_FILES.indexOf(name.toLowerCase()) >= 0;
  }
  function importRerender() { importerSig = ""; renderImporter(); }
  function importNote(text, info) { importForm.note = { text: text, info: !!info }; importRerender(); }

  // 把選到的檔案併進清單（同一路徑以後選的為準），並略過暫存檔、系統檔、空檔案、過大的檔案
  function addFiles(items) {
    var byRel = {};
    importForm.files.forEach(function (f) { byRel[f.rel] = f; });
    var skipped = { temp: importForm.skipped.temp, empty: importForm.skipped.empty, big: importForm.skipped.big };
    items.forEach(function (it) {
      var rel = it.rel.replace(/^[/]+/, "");
      if (!rel) return;
      if (isExcludedPath(rel)) { skipped.temp++; return; }
      if (it.file.size === 0) { skipped.empty++; return; }
      if (it.file.size > MAX_FILE_BYTES) { skipped.big++; return; }
      byRel[rel] = { file: it.file, rel: rel };
    });
    var all = Object.keys(byRel).sort().map(function (k) { return byRel[k]; });
    var total = all.reduce(function (sum, f) { return sum + f.file.size; }, 0);
    if (all.length > MAX_BATCH_FILES || total > MAX_BATCH_BYTES) {
      importNote("一次最多上傳 " + MAX_BATCH_FILES + " 個檔案、總共 " + (MAX_BATCH_BYTES / 1048576) + " MB，這次選的超過了，請分批上傳。", false);
      return;
    }
    importForm.files = all; importForm.skipped = skipped; importForm.plan = null; importForm.note = null;
    importRerender();
  }
  function itemsFromInput(input, useRelative) {
    var out = [];
    for (var i = 0; i < input.files.length; i++) {
      var f = input.files[i];
      out.push({ file: f, rel: useRelative && f.webkitRelativePath ? f.webkitRelativePath : f.name });
    }
    return out;
  }

  // 拖曳進來的資料夾要自己走訪（readEntries 一次最多回 100 筆，要讀到空為止）
  function readAllEntries(reader) {
    return new Promise(function (resolve, reject) {
      var all = [];
      (function next() {
        reader.readEntries(function (batch) {
          if (!batch.length) { resolve(all); return; }
          all = all.concat(Array.prototype.slice.call(batch));
          next();
        }, reject);
      })();
    });
  }
  function walkEntry(entry) {
    if (entry.isFile) {
      return new Promise(function (resolve, reject) {
        entry.file(function (file) { resolve([{ file: file, rel: entry.fullPath }]); }, reject);
      });
    }
    if (entry.isDirectory && EXCLUDED_DIRS.indexOf(entry.name.toLowerCase()) < 0) {
      return readAllEntries(entry.createReader()).then(function (children) {
        return Promise.all(children.map(walkEntry)).then(function (lists) { return [].concat.apply([], lists); });
      });
    }
    return Promise.resolve([]);
  }
  function handleDrop(ev) {
    ev.preventDefault();
    if (importForm.phase !== "idle") return;
    var items = ev.dataTransfer && ev.dataTransfer.items;
    if (!items) return;
    var entries = [];
    for (var i = 0; i < items.length; i++) {
      var entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
      if (entry) entries.push(entry);
    }
    Promise.all(entries.map(walkEntry)).then(function (lists) { addFiles([].concat.apply([], lists)); })
      .catch(function (e) { importNote("讀取拖曳的內容失敗：" + e.message, false); });
  }
  // 沒拖到框框裡時，不要讓瀏覽器把檔案直接打開
  window.addEventListener("dragover", function (ev) { ev.preventDefault(); });
  window.addEventListener("drop", function (ev) { ev.preventDefault(); });

  // 目的地資料夾選擇器（只列資料夾，唯讀）：在往右延伸的面板裡操作，按「使用這個位置」才會填進路徑欄位
  var pick = { path: "", loadedFor: null, entries: null, loading: false, notice: null };
  function loadPick(p) {
    pick.path = p; pick.loadedFor = p; pick.loading = true; pick.entries = null; pick.notice = null;
    renderExt();
    api("GET", "/api/browse?connection=" + encodeURIComponent(importForm.connection) + "&path=" + encodeURIComponent(p)).then(function (r) {
      if (pick.loadedFor !== p) return;
      pick.loading = false;
      pick.entries = r.entries.filter(function (e) { return e.kind === "dir"; });
      renderExt();
    }, function (e) {
      if (pick.loadedFor !== p) return;
      pick.loading = false; pick.entries = [];
      pick.notice = e.code === "NOT_FOUND" ? "讀不到這個資料夾，可能還不存在（上傳時會自動建立）：" + e.message : e.message;
      renderExt();
    });
  }
  function openPick() { pick.path = cleanDir(importForm.path); openExt("pick"); }

  // ---- 常用目錄（針對每個專案各自的星星目錄）：常傳／常看同幾個深層資料夾時，不用每次一層一層點 ----
  // 「從 SVN 選擇資料夾」與「瀏覽 SVN 目錄」共用同一份資料與同一個元件，所以星星、暱稱兩邊同步。
  function uploadRepo() { var c = findConnection(importForm.connection); return c ? c.name : ""; }
  function favFolders(repo) { return (prefsNow().folders || {})[repo] || []; }
  function folderNicknameOf(repo, folderPath) { return ((prefsNow().folderNicknames || {})[repo] || {})[folderPath] || ""; }
  function folderFailed(e) {
    var text = e.message || "儲存失敗";
    pick.notice = text; browse.notice = { text: text, error: true };
    refresh().then(function () { extSig = ""; renderExt(); });
  }
  function copyMap(source) { var out = {}; Object.keys(source || {}).forEach(function (k) { out[k] = source[k]; }); return out; }
  /** 本地先套用（畫面立刻更新）再送出；失敗就重新讀回正確的狀態。 */
  function saveFolderNickname(repo, folderPath, text) {
    var p = prefsNow();
    var all = copyMap(p.folderNicknames);
    var mine = copyMap(all[repo]);
    if (text.trim()) mine[folderPath] = text.trim(); else delete mine[folderPath];
    if (Object.keys(mine).length) all[repo] = mine; else delete all[repo];
    state.repoPrefs = { starred: p.starred, recent: p.recent, nicknames: p.nicknames, folders: p.folders || {}, folderNicknames: all, localPaths: p.localPaths || {}, syncLocal: !!p.syncLocal };
    extSig = ""; renderExt();
    api("POST", "/api/repo-prefs/folder-nickname", { repo: repo, path: folderPath, nickname: text }).then(function (r) { state.repoPrefs = r.prefs; }).catch(folderFailed);
  }
  function toggleFolderStar(repo, folderPath) {
    if (!repo || !folderPath) return;
    var on = favFolders(repo).indexOf(folderPath) < 0;
    var p = prefsNow();
    var folders = copyMap(p.folders);
    var list = (folders[repo] || []).filter(function (x) { return x !== folderPath; });
    if (on) list.push(folderPath);
    if (list.length) folders[repo] = list; else delete folders[repo];
    var nickAll = copyMap(p.folderNicknames);
    if (!on && nickAll[repo]) {
      var rest = copyMap(nickAll[repo]);
      delete rest[folderPath];
      if (Object.keys(rest).length) nickAll[repo] = rest; else delete nickAll[repo];
    }
    state.repoPrefs = { starred: p.starred, recent: p.recent, nicknames: p.nicknames, folders: folders, folderNicknames: nickAll, localPaths: p.localPaths || {}, syncLocal: !!p.syncLocal };
    extSig = ""; renderExt();
    api("POST", "/api/repo-prefs/folder", { repo: repo, path: folderPath, starred: on }).then(function (r) { state.repoPrefs = r.prefs; }).catch(folderFailed);
  }
  function folderStarButton(repo, folderPath) {
    var on = favFolders(repo).indexOf(folderPath) >= 0;
    return h("button", { type: "button", class: "star" + (on ? " on" : ""), title: on ? "從常用目錄移除" : "加入常用目錄（這個專案）", onclick: function (ev) { ev.stopPropagation(); toggleFolderStar(repo, folderPath); } }, on ? "★" : "☆");
  }
  /** 目前正在改暱稱的常用目錄（「專案 | 路徑」）；空字串代表沒有。 */
  var favEditing = "";
  /** 這個專案的常用目錄區塊（沒有常用目錄就回傳 null）。goFn：點路徑要做什麼；useFn：有給就多一顆「使用」按鈕。 */
  function renderFavBox(repo, goFn, useFn) {
    var list = favFolders(repo);
    if (list.length === 0) return null;
    var rows = list.map(function (folder) {
      var nick = folderNicknameOf(repo, folder);
      var key = repo + " | " + folder;
      var label;
      if (favEditing === key) {
        var input = h("input", { class: "favnickinput", type: "text", maxlength: "30", placeholder: "暱稱（例如：後端規格）", value: nick });
        var done = false;
        var finish = function (save) {
          if (done) return; done = true; favEditing = "";
          if (save && input.value.trim() !== nick) saveFolderNickname(repo, folder, input.value);
          else { extSig = ""; renderExt(); }
        };
        input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") finish(true); else if (ev.key === "Escape") finish(false); });
        input.addEventListener("blur", function () { finish(true); });
        label = h("div", { class: "favlabel" }, input, h("div", { class: "favsub" }, folder));
        setTimeout(function () { input.focus(); input.select(); }, 0);
      } else {
        label = h("button", { type: "button", class: "favpath", title: "進入這個資料夾：" + folder, onclick: function () { goFn(folder); } },
          nick ? h("span", { class: "favnick" }, nick) : folder, nick ? h("span", { class: "favsub" }, folder) : null);
      }
      return h("div", { class: "favrow" },
        folderStarButton(repo, folder),
        label,
        h("button", { type: "button", class: "small", title: "替這個目錄取一個好認的暱稱（只存在你的電腦）", onclick: function () { favEditing = key; extSig = ""; renderExt(); } }, nick ? "改暱稱" : "取暱稱"),
        useFn ? h("button", { type: "button", class: "primary small", title: "直接用這個資料夾當上傳位置", onclick: function () { useFn(folder); } }, "使用") : null);
    });
    return h("div", { class: "favbox" }, h("div", { class: "favbox__title" }, "★ 常用目錄（只屬於這個專案）"), rows);
  }

  /** 上傳卡換專案：「放到 SVN 的哪裡」清空（舊專案的路徑在新專案多半不存在）、舊的覆蓋預覽作廢，
   *  「從 SVN 選擇」面板開著就立刻改列新專案的根目錄。 */
  function changeUploadProject(c) {
    var f = importForm;
    if (f.connection === c.id) return;
    f.connection = c.id; f.path = ""; f.plan = null;
    pick.path = ""; pick.loadedFor = null; pick.entries = null; pick.notice = null;
    recordOpened(c.name);
    if (ext.view === "pick") loadPick("");
    importRerender();
  }

  /** 可搜尋的專案選單（專案很多時取代下拉選單）：星星專案在最上面，其次是最近開過的；右側顯示簡稱。 */
  function projectCombo(currentId, disabled, onSelect) {
    var current = findConnection(currentId) || state.connections[0];
    var wrap = h("div", { class: "combo" });
    var isOpen = false;
    var panel = null;
    var closeOnOutside = function (ev) { if (!wrap.contains(ev.target)) close(); };
    var closeOnEscape = function (ev) { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
    function ordered(query) {
      var stars = starList();
      var rest = recentList().filter(function (c) { return !isStarred(c.name); });
      return stars.concat(rest).filter(function (c) { return !query || matchesQuery(c, query); });
    }
    function fieldButton() {
      var pill = pillOf(current);
      return h("button", { type: "button", class: "combo__field", disabled: disabled ? "disabled" : null, onclick: function () { if (isOpen) close(); else open(); } },
        h("span", { class: "combo__name" }, (isStarred(current.name) ? "★ " : "") + current.name),
        pill.kind === "empty" ? null : h("span", { class: "combo__pill" }, pill.text),
        h("span", { class: "combo__caret" }, "▾"));
    }
    function fillList(list, query) {
      list.textContent = "";
      var items = ordered(query);
      if (items.length === 0) list.appendChild(h("div", { class: "empty" }, "找不到符合「" + query + "」的專案。"));
      items.forEach(function (c) {
        var pill = pillOf(c);
        list.appendChild(h("button", { type: "button", class: "combo__item" + (c.id === current.id ? " on" : ""), onclick: function () { close(); onSelect(c); } },
          h("span", { class: "combo__star" }, isStarred(c.name) ? "★" : ""),
          h("span", { class: "combo__name" }, c.name),
          pill.kind === "empty" ? null : h("span", { class: "combo__pill" }, pill.text)));
      });
    }
    function open() {
      isOpen = true;
      var search = h("input", { type: "text", placeholder: "搜尋專案（共 " + state.connections.length + " 個）", autocomplete: "off" });
      var list = h("div", { class: "combo__list" });
      search.addEventListener("input", function () { fillList(list, search.value.trim()); });
      panel = h("div", { class: "combo__panel" }, search, list);
      wrap.appendChild(panel);
      fillList(list, "");
      document.addEventListener("click", closeOnOutside, true);
      document.addEventListener("keydown", closeOnEscape, true);
      setTimeout(function () { search.focus(); }, 0);
    }
    function close() {
      isOpen = false;
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      panel = null;
      document.removeEventListener("click", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    }
    wrap.appendChild(fieldButton());
    return wrap;
  }

  // 上傳：逐檔送到暫存區 → 比對遠端 → （有會覆蓋的檔案就先請使用者確認）→ 送出
  function stageAll(batch) {
    var files = importForm.files.slice();
    var next = 0;
    function worker() {
      if (next >= files.length) return Promise.resolve();
      var item = files[next++];
      var q = new URLSearchParams({ batch: batch, path: item.rel, mtime: String(item.file.lastModified || 0) });
      return fetch("/api/import/stage?" + q.toString(), { method: "POST", headers: { "X-Edit-Token": TOKEN, "Content-Type": "application/octet-stream" }, body: item.file })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            if (!r.ok) throw new Error((d.error || "傳送失敗") + "（" + item.rel + "）");
          });
        })
        .then(function () { importForm.progress++; updateProgressText(); return worker(); });
    }
    var workers = [];
    for (var i = 0; i < STAGE_PARALLEL; i++) workers.push(worker());
    return Promise.all(workers);
  }
  function updateProgressText() {
    var el = document.getElementById("importProgress");
    if (el) el.textContent = "正在傳送檔案… " + importForm.progress + " / " + importForm.files.length;
  }
  function importFailed(e) {
    var batch = importForm.batch;
    importForm.batch = null; importForm.plan = null; importForm.phase = "idle";
    if (batch) api("POST", "/api/import/cancel", { batch: batch }).catch(function () {});
    importNote(e.message || "上傳失敗", false);
  }
  function startUpload() {
    var f = importForm;
    if (f.files.length === 0) { importNote("請先選擇要上傳的檔案或資料夾。", false); return; }
    if (!f.message.trim()) { importNote("請填寫上傳說明（commit 訊息）。", false); return; }
    f.path = cleanDir(f.path);
    f.phase = "staging"; f.progress = 0; f.note = null; f.plan = null; f.startedAt = Date.now(); f.stagingMs = 0;
    importRerender();
    api("POST", "/api/import/start", {}).then(function (s) {
      f.batch = s.batch;
      return stageAll(s.batch);
    }).then(function () {
      return api("POST", "/api/import/plan", { batch: f.batch, connection: f.connection, targetDir: f.path });
    }).then(function (plan) {
      f.stagingMs = Date.now() - f.startedAt;
      if (plan.overwrite.length === 0) return commitUpload();
      f.plan = plan; f.phase = "planned"; importRerender();
    }).catch(importFailed);
  }
  function commitUpload() {
    var f = importForm;
    f.phase = "committing"; importRerender();
    var commitStartedAt = Date.now();
    return api("POST", "/api/import/commit", { batch: f.batch, connection: f.connection, targetDir: f.path, message: f.message, ticket: browse.ticket || undefined }).then(function (r) {
      var parts = ["新增 " + r.added + " 個"];
      if (r.modified) parts.push("更新 " + r.modified + " 個");
      if (r.unchanged) parts.push("內容相同略過 " + r.unchanged + " 個");
      // 耗時 = 傳檔案 + 送出 commit；不含使用者在覆蓋確認畫面停留的時間
      var tookMs = (f.stagingMs || 0) + (Date.now() - commitStartedAt);
      f.files = []; f.skipped = { temp: 0, empty: 0, big: 0 }; f.message = ""; f.batch = null; f.plan = null; f.phase = "idle";
      f.note = { text: "已上傳到 SVN" + (r.committedRevision ? "（r" + r.committedRevision + "）" : "") + "：" + parts.join("、") + "。位置：" + (r.targetDir || "（連線根目錄）") + "。耗時：" + fmtDuration(tookMs), info: true };
      pick.loadedFor = null;
      importRerender();
    }).catch(importFailed);
  }
  function cancelUpload() {
    var batch = importForm.batch;
    importForm.batch = null; importForm.plan = null; importForm.phase = "idle";
    if (batch) api("POST", "/api/import/cancel", { batch: batch }).catch(function () {});
    importRerender();
  }

  function renderImporter() {
    var box = document.getElementById("importer");
    var f = importForm;
    var sig = JSON.stringify([state.connections, state.repoPrefs, f.phase, f.note, f.files.length, f.skipped, f.plan, f.connection, ext.view === "pick"]);
    if (sig === importerSig) return;
    importerSig = sig;
    box.textContent = "";
    if (state.connections.length === 0) { box.appendChild(noConnectionCard()); return; }
    // 第一次、或原本選的專案不見了：預設選最近開過的專案（沒有就第一個）
    if (!state.connections.some(function (c) { return c.id === f.connection; })) f.connection = recentList()[0].id;
    var idle = f.phase === "idle";

    var connSelect = projectCombo(f.connection, !idle, changeUploadProject);

    // 選檔案／資料夾
    var fileInput = h("input", { type: "file", multiple: "multiple", style: "display:none", onchange: function () { addFiles(itemsFromInput(fileInput, false)); } });
    var dirInput = h("input", { type: "file", webkitdirectory: "", directory: "", multiple: "multiple", style: "display:none", onchange: function () { addFiles(itemsFromInput(dirInput, true)); } });
    var total = f.files.reduce(function (sum, x) { return sum + x.file.size; }, 0);
    var preview = f.files.slice(0, 6).map(function (x) { return h("div", { class: "path", style: "margin:0" }, x.rel); });
    var skippedParts = [];
    if (f.skipped.temp) skippedParts.push("暫存檔／系統檔／.git／.svn " + f.skipped.temp + " 個");
    if (f.skipped.empty) skippedParts.push("空檔案 " + f.skipped.empty + " 個");
    if (f.skipped.big) skippedParts.push("超過 " + (MAX_FILE_BYTES / 1048576) + " MB 的檔案 " + f.skipped.big + " 個");
    var picker = h("div", null,
      h("div", { class: "row", style: "margin-top:4px" },
        h("button", { type: "button", disabled: idle ? null : "disabled", onclick: function () { fileInput.click(); } }, "選擇檔案（可多選）"),
        h("button", { type: "button", disabled: idle ? null : "disabled", onclick: function () { dirInput.click(); } }, "選擇整個資料夾"),
        f.files.length ? h("button", { type: "button", disabled: idle ? null : "disabled", onclick: function () { f.files = []; f.skipped = { temp: 0, empty: 0, big: 0 }; f.plan = null; importRerender(); } }, "清除") : null,
        fileInput, dirInput),
      h("p", { class: "hint" }, "也可以直接把檔案或資料夾拖曳到這個區塊。資料夾會連同裡面的子資料夾一起上傳，並保留資料夾名稱。"),
      f.files.length
        ? h("div", null,
            h("p", { class: "hint" }, "已選擇 " + f.files.length + " 個檔案，共 " + fmtSize(total) + "："),
            preview, f.files.length > 6 ? h("div", { class: "path", style: "margin:0" }, "…另外還有 " + (f.files.length - 6) + " 個") : null)
        : null,
      skippedParts.length ? h("p", { class: "hint" }, "已自動略過：" + skippedParts.join("、")) : null);

    // 放到 SVN 的哪裡：可以直接輸入，或按「從 SVN 選擇」在右邊的面板點選資料夾
    var pathInput = h("input", { type: "text", placeholder: "留空代表連線根目錄；不存在會自動建立", disabled: idle ? null : "disabled",
      oninput: function () { f.path = pathInput.value; }, onchange: function () { f.path = cleanDir(pathInput.value); } });
    pathInput.value = f.path;
    var pickBtn = openerButton("pick", "從 SVN 選擇", "", !idle);

    var messageInput = h("textarea", { placeholder: "說明這次上傳了什麼（必填）", disabled: idle ? null : "disabled", oninput: function () { f.message = messageInput.value; } });
    messageInput.value = f.message;

    var overwriteBox = null;
    if (f.phase === "planned" && f.plan) {
      // 有「遠端比本機新」的檔案排在最前面，並整體警告
      var details = (f.plan.overwriteDetails || f.plan.overwrite.map(function (p) { return { path: p }; })).slice();
      details.sort(function (a, b) { return (b.remoteNewer ? 1 : 0) - (a.remoteNewer ? 1 : 0); });
      var newerCount = details.filter(function (d) { return d.remoteNewer; }).length;
      var rows = details.slice(0, 10).map(function (d) {
        var remote = (d.remoteRevision ? "r" + d.remoteRevision : "") + (d.remoteAuthor ? " " + d.remoteAuthor : "") + (d.remoteDate ? " " + fmtDate(d.remoteDate) : "");
        var line = remote ? "遠端最後修改：" + remote : "";
        if (d.localModified) line += (line ? "｜" : "") + "你的檔案：" + fmtDate(d.localModified);
        return h("div", { class: "ow" + (d.remoteNewer ? " ow--newer" : "") },
          h("div", { class: "ow__name" }, (d.remoteNewer ? "⚠ " : "") + d.path),
          line ? h("div", { class: "path", style: "margin:0" }, line) : null);
      });
      overwriteBox = h("div", { class: "banner" },
        h("div", null, "遠端已經有 " + f.plan.overwrite.length + " 個同名檔案，繼續的話會更新成你這次選的內容（會產生新版本，可從 SVN 歷史還原）；另外新增 " + f.plan.add.length + " 個。"),
        newerCount > 0
          ? h("div", { class: "warnbox" }, "⚠ 其中 " + newerCount + " 個檔案，遠端的版本比你本機的檔案新。可能是別人在你修改這份檔案期間已經更新過，直接覆蓋會蓋掉對方的修改。建議先按「瀏覽 SVN 目錄」確認遠端內容，再決定要不要覆蓋。")
          : null,
        rows, details.length > 10 ? h("div", { class: "path", style: "margin:0" }, "…另外還有 " + (details.length - 10) + " 個") : null,
        h("div", { class: "row" },
          h("button", { type: "button", class: "primary", onclick: function () { commitUpload(); } }, newerCount > 0 ? "我確認，仍要覆蓋" : "確認，更新並上傳"),
          h("button", { type: "button", onclick: cancelUpload }, "取消")));
    }

    var busyText = f.phase === "staging" ? "正在傳送檔案… " + f.progress + " / " + f.files.length : (f.phase === "committing" ? "正在送出到 SVN，檔案多的話需要一點時間…" : null);
    var send = h("button", { type: "button", class: "primary", disabled: idle ? null : "disabled", onclick: startUpload },
      f.files.length > 1 ? "上傳這 " + f.files.length + " 個檔案到 SVN" : "上傳到 SVN");

    var card = h("div", { class: "card" },
      h("h2", null, "新增檔案到 SVN"),
      h("p", { class: "hint" }, "可一次上傳多個檔案或整個資料夾，只會產生一個 commit。遠端已有同名檔案時，會先請你確認再更新成新版本。Word、Excel 新檔會自動設定為「編輯前需先鎖定」。"),
      state.connections.length > 1 ? h("div", null, h("label", null, "連線"), connSelect) : null,
      h("label", null, "本機檔案或資料夾"), picker,
      h("label", null, "放到 SVN 的哪裡"), h("div", { class: "inline" }, pathInput, pickBtn),
      h("label", null, "上傳說明（commit 訊息）"), messageInput,
      busyText ? h("div", { class: "hint", id: "importProgress" }, busyText) : null,
      overwriteBox,
      f.note ? h("div", { class: f.note.info ? "msg info" : "msg" }, f.note.text) : null,
      f.phase === "planned" ? null : h("div", { class: "row" }, send));
    card.addEventListener("dragover", function (ev) { ev.preventDefault(); });
    card.addEventListener("drop", handleDrop);
    box.appendChild(card);
  }

  // ---- 連線設定：主畫面只放連線摘要，表單在往右延伸的面板裡 ----
  var settingsSig = "";
  function renderSettings() {
    var box = document.getElementById("settings");
    var sig = JSON.stringify([state.servers, ext.view === "conn"]);
    if (sig === settingsSig) return;
    settingsSig = sig;
    box.textContent = "";
    var list = state.servers.map(function (sv) {
      return h("div", { class: "conn" }, h("span", null, accountLabel(sv), h("br", null), h("span", { class: "path" }, sv.url)));
    });
    box.appendChild(h("div", { class: "card" },
      h("h2", null, "連線設定" + (state.servers.length ? "（" + state.servers.length + " 個帳號）" : "（尚未設定）")),
      list.length ? h("div", null, list) : h("p", { class: "hint" }, "還沒有任何帳號，請按「管理連線」填寫伺服器網址與帳密。"),
      h("div", { class: "row" }, openerButton("conn", "管理連線", "wide"))));
  }

  // 帳號：只填上層網址＋帳密，就能用這個帳號看得到的所有 repo。新增、更新、測試都會實際連線一次。
  function serverSection() {
    var inputs = {};
    function sfield(key, label, type, placeholder) {
      inputs[key] = h("input", { type: type, placeholder: placeholder || "", autocomplete: "off", oninput: function () { serverForm[key] = inputs[key].value; } });
      inputs[key].value = serverForm[key];
      return h("div", null, h("label", null, label), inputs[key]);
    }
    function authNote(r) { return r.auth === "windows" ? "驗證方式：Windows 登入（這個伺服器用你目前登入電腦的帳號驗證，填的密碼沒有被用到）。" : "驗證方式：你填的帳號密碼。"; }
    function resetForm() { serverForm = { id: "", name: "", url: "", username: "", password: "" }; }
    function note(text, info) { serverBusy = false; settingsNote = { text: text, info: info }; extSig = ""; renderExt(); }
    function fail(e) { note("連線失敗：" + e.message, false); }
    function busy(text) { serverBusy = true; settingsNote = { text: text, info: true }; extSig = ""; renderExt(); }
    var disabled = serverBusy ? "disabled" : null;
    var testBtn = h("button", { type: "button", disabled: disabled, onclick: function () {
      busy("正在測試連線…");
      api("POST", "/api/servers/test", serverForm).then(function (r) {
        note("連線成功：找得到 " + r.test.repoCount + " 個 repo。" + authNote(r.test) + "（只是測試，還沒有儲存）", true);
      }).catch(fail);
    } }, "測試連線");
    var save = h("button", { type: "button", class: "primary", disabled: disabled, onclick: function () {
      var editing = !!serverForm.id;
      busy("正在測試連線並儲存…");
      api("POST", "/api/servers", serverForm).then(function (r) {
        resetForm();
        settingsNote = { text: "連線成功，已" + (editing ? "更新" : "新增") + "「" + r.server.name + "」：找得到 " + r.server.repoCount + " 個 repo。" + authNote(r.server), info: true };
        serverBusy = false; return refresh();
      }).catch(fail);
    } }, serverForm.id ? "測試並更新" : "測試並儲存");
    var list = state.servers.map(function (sv) {
      var aliasNames = Object.keys(sv.aliases || {});
      var buttons;
      if (deleteConfirmId === sv.id) {
        buttons = [
          h("button", { type: "button", class: "danger", disabled: disabled, onclick: function () {
            busy("正在刪除…");
            api("POST", "/api/servers/delete", { id: sv.id }).then(function () {
              deleteConfirmId = null; if (serverForm.id === sv.id) resetForm();
              settingsNote = { text: "已刪除「" + sv.name + "」（SVN 上的資料完全沒有動）。", info: true }; serverBusy = false; return refresh();
            }).catch(fail);
          } }, "確定刪除"),
          h("button", { type: "button", onclick: function () { deleteConfirmId = null; extSig = ""; renderExt(); } }, "取消")];
      } else {
        buttons = [
          h("button", { type: "button", disabled: disabled, onclick: function () {
            busy("正在重新載入 repo 清單…");
            api("POST", "/api/servers/refresh", { id: sv.id }).then(function (r) {
              settingsNote = { text: "已重新載入，共 " + r.server.repoCount + " 個 repo。" + authNote(r.server), info: true }; serverBusy = false; return refresh();
            }).catch(fail);
          } }, "重新載入"),
          h("button", { type: "button", onclick: function () { serverForm = { id: sv.id, name: sv.name, url: sv.url, username: sv.username, password: "" }; settingsNote = null; deleteConfirmId = null; extSig = ""; renderExt(); } }, "編輯"),
          h("button", { type: "button", class: "danger", onclick: function () { deleteConfirmId = sv.id; settingsNote = null; extSig = ""; renderExt(); } }, "刪除")];
      }
      return h("div", { class: "conn" },
        h("span", null, accountLabel(sv), h("br", null), h("span", { class: "path" }, sv.url),
          aliasNames.length ? h("span", { class: "path" }, h("br", null), "別名：" + aliasNames.join("、")) : null),
        h("span", { class: "btns" }, buttons));
    });
    return h("div", null,
      h("h2", { style: "margin-top:14px;font-size:15px" }, "SVN 伺服器（填帳密就能用所有 repo）"),
      list.length ? h("div", null, list) : h("div", { class: "empty" }, "還沒有任何帳號，請在下方新增。"),
      h("form", { autocomplete: "off", onsubmit: function (ev) { ev.preventDefault(); } },
        h("h2", { style: "margin-top:18px;font-size:15px" }, serverForm.id ? "編輯帳號" : "新增帳號"),
        sfield("name", "名稱（留空＝用網址）", "text", "例如：公司 SVN"),
        sfield("url", "伺服器網址", "text", "https://svn.example.com/svn"),
        sfield("username", "帳號（請使用你自己的 SVN 帳號；留空＝目前的 Windows 帳號）", "text"),
        sfield("password", serverForm.id ? "密碼（留空代表不變更）" : "密碼（Windows 登入驗證可留空）", "password"),
        settingsNote ? h("div", { class: settingsNote.info ? "msg info" : "msg" }, settingsNote.text) : null,
        h("div", { class: "row" }, testBtn, save, serverForm.id ? h("button", { type: "button", onclick: function () { resetForm(); settingsNote = null; extSig = ""; renderExt(); } }, "取消編輯") : null)));
  }

  // ---- 同步本地端（管理連線）、本機資料夾點選、Checkout 到本地 ----
  var addRepo = "";
  var localInfo = {};
  var localInfoAsked = {};
  function localPathsOf(repo) { var v = (prefsNow().localPaths || {})[repo]; return Array.isArray(v) ? v : (v ? [v] : []); }
  function forgetLocalInfo(dir) { delete localInfo[dir]; delete localInfoAsked[dir]; }
  /** 向伺服器問「這些本地目錄有沒有 SVN 追蹤、對應哪個遠端位置」（問過的不再問，目錄有變動才重問）。 */
  function askLocalInfo() {
    var need = [];
    Object.keys(prefsNow().localPaths || {}).forEach(function (repo) {
      localPathsOf(repo).forEach(function (dir) { if (!localInfo[dir] && !localInfoAsked[dir]) { localInfoAsked[dir] = true; need.push(dir); } });
    });
    if (!need.length) return;
    api("POST", "/api/local/inspect", { paths: need }).then(function (r) {
      r.results.forEach(function (x) { localInfo[x.path] = x; });
      extSig = ""; renderExt();
    }).catch(function () { need.forEach(function (d) { delete localInfoAsked[d]; }); });
  }
  /** 本地工作目錄對應的遠端位置（相對於專案根目錄）。 */
  function remoteOfLocal(repo, info) {
    if (!info || !info.url) return "";
    var u = safeDecode(info.url).replace(/[/]+$/, "");
    var marker = "/" + repo.toLowerCase();
    var i = u.toLowerCase().lastIndexOf(marker + "/");
    if (i >= 0) return u.slice(i + marker.length + 1);
    if (u.toLowerCase().slice(-marker.length) === marker) return "（整個專案）";
    return u;
  }

  function syncSection() {
    var prefs = prefsNow();
    function save(call, okText, after) {
      localBusy = true; extSig = ""; renderExt();
      return call.then(function (r) {
        state.repoPrefs = r.prefs; localBusy = false; localNote = okText ? { text: okText, info: true } : null;
        if (after) after();
        extSig = ""; renderExt();
      }).catch(function (e) { localBusy = false; localNote = { text: "儲存失敗：" + e.message, info: false }; extSig = ""; renderExt(); });
    }
    var toggle = h("input", { type: "checkbox", checked: prefs.syncLocal ? "checked" : null, disabled: localBusy ? "disabled" : null });
    toggle.addEventListener("change", function () { save(api("POST", "/api/repo-prefs/sync-local", { enabled: toggle.checked }), null); });
    var head = h("div", null,
      h("h2", { style: "margin-top:22px;font-size:15px" }, "同步本地端"),
      h("label", { class: "switchrow" }, h("span", null, "上傳、刪除後自動 svn update"), h("span", { class: "switch" }, toggle, h("span", { class: "switch__track" }))));
    if (!prefs.syncLocal) return head;
    askLocalInfo();

    var rows = [];
    Object.keys(prefs.localPaths || {}).sort().forEach(function (repo) {
      localPathsOf(repo).forEach(function (dir) {
        var info = localInfo[dir];
        var status = !info ? { cls: "none", text: "檢查中…" } : !info.exists ? { cls: "warn", text: "⚠ 目錄不存在" } : info.isWc ? { cls: "ok", text: "✓ 有 SVN 追蹤" } : { cls: "warn", text: "⚠ 沒有 SVN 追蹤" };
        var remote = remoteOfLocal(repo, info);
        rows.push(h("div", { class: "conn conn--local" },
          h("div", { class: "conn__main" },
            h("div", { class: "nm" }, repo, h("span", { class: "pill pill--" + status.cls }, status.text)),
            remote ? h("div", { class: "pth" }, "遠端：" + remote) : null,
            h("div", { class: "pth" }, "本地：" + dir),
            info && info.exists && !info.isWc ? h("div", { class: "warnline" }, "同步時不會更新，請重新選擇 Checkout 出來的資料夾。") : null),
          h("span", { class: "btns" },
            h("button", { type: "button", disabled: localBusy ? "disabled" : null, onclick: function () {
              openLocalPicker("重新選擇「" + repo + "」的本地資料夾", function (picked) {
                save(api("POST", "/api/repo-prefs/local-path/add", { repo: repo, path: picked }).then(function () {
                  return api("POST", "/api/repo-prefs/local-path/remove", { repo: repo, path: dir });
                }), "已儲存。", function () { forgetLocalInfo(dir); forgetLocalInfo(picked); });
              });
            } }, "重新選擇…"),
            h("button", { type: "button", class: "danger", disabled: localBusy ? "disabled" : null, onclick: function () {
              save(api("POST", "/api/repo-prefs/local-path/remove", { repo: repo, path: dir }), "已清除。", function () { forgetLocalInfo(dir); });
            } }, "清除"))));
      });
    });

    var select = h("select", { onchange: function () { addRepo = select.value; } },
      [h("option", { value: "" }, "（選擇專案，指向電腦上已有的資料夾）")].concat(state.connections.map(function (c) { return h("option", { value: c.name }, connLabel(c)); })));
    select.value = addRepo;
    var pick = h("button", { type: "button", class: "primary", disabled: localBusy ? "disabled" : null, onclick: function () {
      if (!select.value) { localNote = { text: "請先選擇專案。", info: false }; extSig = ""; renderExt(); return; }
      var repo = select.value;
      openLocalPicker("選擇「" + repo + "」的本地資料夾", function (picked) {
        save(api("POST", "/api/repo-prefs/local-path/add", { repo: repo, path: picked }), "已儲存。", function () { addRepo = ""; forgetLocalInfo(picked); });
      });
    } }, "選擇資料夾…");
    return h("div", null, head,
      rows.length ? h("div", null, rows) : null,
      h("div", { class: "addrow" }, select, pick),
      localNote ? h("div", { class: localNote.info ? "msg info" : "msg" }, localNote.text) : null,
      h("p", { class: "hint", style: "margin-top:8px" }, "還沒有本地資料夾？到「瀏覽 SVN 目錄」按「⬇ Checkout 到本地」就能建立。"));
  }

  // ---- 本機資料夾點選（不用複製貼上路徑）----
  var lp = null;
  function openLocalPicker(title, onPick) {
    closeLocalPicker();
    lp = { title: title, onPick: onPick, listing: null, loading: true, error: null };
    var overlay = h("div", { class: "shade shade--top on" }, h("div", { class: "sheet2" }));
    lp.el = overlay;
    // 用區域變數：按「選擇這個資料夾」時視窗已先關閉、lp 已清空，事件才往上傳到這裡
    overlay.addEventListener("click", function (ev) { if (ev.target === overlay) closeLocalPicker(); });
    document.body.appendChild(overlay);
    loadLocal("");
  }
  function closeLocalPicker() { if (lp && lp.el && lp.el.parentNode) lp.el.parentNode.removeChild(lp.el); lp = null; }
  function loadLocal(p) {
    var cur = lp;
    if (!cur) return;
    cur.loading = true; cur.error = null; renderLocalPicker();
    api("GET", "/api/local/list?path=" + encodeURIComponent(p)).then(function (r) {
      if (lp !== cur) return;
      cur.listing = r; cur.loading = false; renderLocalPicker();
    }).catch(function (e) {
      if (lp !== cur) return;
      cur.loading = false; cur.error = e.message; renderLocalPicker();
    });
  }
  function renderLocalPicker() {
    if (!lp) return;
    var cur = lp;
    var sheet = cur.el.firstChild;
    sheet.textContent = "";
    var L = cur.listing;
    sheet.appendChild(h("h3", { class: "sheet2__title" }, cur.title));
    sheet.appendChild(h("p", { class: "hint" }, "點資料夾進入，找到後按「選擇這個資料夾」。有 ", h("span", { class: "pill pill--ok", style: "margin:0" }, "SVN"), " 標記的，就是有 SVN 追蹤的資料夾。"));
    var segs = L && L.path ? L.path.split("/").filter(Boolean) : [];
    var crumbs = h("div", { class: "crumbs" });
    crumbs.appendChild(segs.length ? h("button", { type: "button", onclick: function () { loadLocal(""); } }, "本機") : h("span", { class: "cur" }, "本機"));
    segs.forEach(function (seg, i) {
      var target = segs.slice(0, i + 1).join("/") + (i === 0 ? "/" : "");
      crumbs.appendChild(h("span", { class: "sep" }, "→"));
      crumbs.appendChild(i === segs.length - 1 ? h("span", { class: "cur" }, seg) : h("button", { type: "button", onclick: function () { loadLocal(target); } }, seg));
    });
    sheet.appendChild(crumbs);
    var list = h("div", { class: "fslist" });
    if (cur.loading) list.appendChild(h("div", { class: "empty" }, "讀取中…"));
    else if (cur.error) list.appendChild(h("div", { class: "msg" }, cur.error));
    else if (L) {
      if (!L.entries.length) list.appendChild(h("div", { class: "empty" }, "（這個資料夾底下沒有子資料夾）"));
      L.entries.forEach(function (e) {
        list.appendChild(h("div", { class: "fsrow", onclick: function () { loadLocal(e.path); } },
          fileBadge({ kind: "dir", name: e.name }, true), h("span", { class: "n" }, e.name), e.isWc ? h("span", { class: "pill pill--ok" }, "SVN") : null));
      });
      if (L.truncated) list.appendChild(h("div", { class: "hint", style: "padding:8px 12px" }, "項目太多，只顯示前面一部分。"));
    }
    sheet.appendChild(list);
    var canPick = !!(L && L.path) && !cur.loading;
    sheet.appendChild(h("div", { class: "sheet2__foot" },
      h("div", { class: "cur" }, L && L.path ? "目前：" + L.path + (L.inWc ? "（在 SVN 工作目錄內）" : "") : "請先選擇磁碟"),
      h("button", { type: "button", onclick: closeLocalPicker }, "取消"),
      h("button", { type: "button", class: "primary", disabled: canPick ? null : "disabled", onclick: function () { var cb = cur.onPick; var p = L.path; closeLocalPicker(); cb(p); } }, "選擇這個資料夾")));
  }

  // ---- Checkout 到本地 ----
  var co = null;
  var coTimer = null;
  var CO_SCOPES = [
    { k: "all", t: "整個目錄（含所有子資料夾）", d: "最完整；檔案多時要等一陣子。" },
    { k: "files", t: "只取這一層的檔案（不含子資料夾）", d: "之後要用到子資料夾再另外取。" },
    { k: "empty", t: "只建立追蹤（先不下載檔案）", d: "馬上完成；之後編輯、上傳到哪個檔案，才取回哪個檔案。" }
  ];
  function openCheckout(current) {
    closeCheckout();
    var leaf = browse.path ? browse.path.split("/").pop() : current.name;
    co = { conn: current, remotePath: browse.path || "", name: leaf, parent: "", scope: "all", setSync: true, phase: "form", error: null, result: null, status: { k: "none", m: "" } };
    var overlay = h("div", { class: "shade on" }, h("div", { class: "sheet2" }));
    var state0 = co;
    co.el = overlay;
    overlay.addEventListener("click", function (ev) { if (ev.target === overlay && state0.phase !== "run" && co === state0) closeCheckout(); });
    document.body.appendChild(overlay);
    renderCheckout();
  }
  function closeCheckout() { clearTimeout(coTimer); if (co && co.el && co.el.parentNode) co.el.parentNode.removeChild(co.el); co = null; }
  function coTarget() { return co && co.parent ? co.parent + "/" + co.name.trim() : ""; }
  /** 預先檢查放的位置（只是讓使用者早點知道；真正的保護在伺服器端）。 */
  function checkCoTarget() {
    var cur = co;
    if (!cur) return;
    if (!cur.parent || !cur.name.trim()) { cur.status = { k: "none", m: "" }; updateCoStatus(); return; }
    api("POST", "/api/local/inspect", { paths: [coTarget(), cur.parent] }).then(function (r) {
      if (co !== cur) return;
      var t = r.results[0], p = r.results[1];
      if (t.exists && t.isWc) cur.status = { k: "info", m: "這個位置已經是 SVN 工作目錄，不需要 Checkout。可以到「管理連線」直接指定它。", blocked: true };
      else if (t.exists && t.nonEmpty) cur.status = { k: "err", m: "這個資料夾已經有內容，為了不弄亂你原有的檔案，不能 Checkout 到這裡。請換一個新的資料夾名稱。", blocked: true };
      else if (!t.exists && p.inWc) cur.status = { k: "err", m: "選的位置已經在另一個 SVN 工作目錄裡面，不能在裡面再 Checkout 一層。請換一個位置。", blocked: true };
      else cur.status = { k: "ok", m: t.exists ? "✓ 可以 Checkout（這是空的資料夾）" : "✓ 可以 Checkout（會自動建立這個資料夾）" };
      updateCoStatus();
    }).catch(function () { /* 預先檢查失敗不擋，交給伺服器判斷 */ });
  }
  function updateCoStatus() {
    if (!co || !co.statusEl) return;
    co.statusEl.className = "st " + (co.status.k === "none" ? "" : co.status.k);
    co.statusEl.textContent = co.status.m;
    co.statusEl.style.display = co.status.m ? "" : "none";
    co.previewEl.textContent = co.parent ? "會建立：" + coTarget() : "";
    var ready = !!co.parent && !!co.name.trim() && !co.status.blocked;
    co.startBtn.disabled = !ready;
  }
  function renderCheckout() {
    if (!co) return;
    var cur = co;
    var sheet = cur.el.firstChild;
    sheet.textContent = "";
    sheet.appendChild(h("h3", { class: "sheet2__title" }, "Checkout 到本地"));

    if (cur.phase === "run") {
      sheet.appendChild(h("p", { class: "hint" }, "正在 Checkout，請不要關閉視窗…（整個目錄很大時需要一陣子）"));
      sheet.appendChild(h("div", { class: "bar" }, h("i", null)));
      return;
    }
    if (cur.phase === "done") {
      var r = cur.result;
      sheet.appendChild(h("div", { class: "st ok" }, "✓ 完成：" + (r.revision ? "r" + r.revision + "，" : "") + r.itemCount + " 個項目，放在 " + r.target));
      if (r.synced) {
        sheet.appendChild(h("div", { class: "st info" }, "已設為「" + cur.conn.name + "」的同步目錄。" + (prefsNow().syncLocal ? "之後上傳、刪除會自動更新這裡。" : "目前「同步本地端」是關閉的，到「管理連線」打開後，上傳、刪除才會自動更新這裡。")));
      }
      sheet.appendChild(h("div", { class: "row", style: "margin-top:12px" }, h("button", { type: "button", class: "primary", onclick: closeCheckout }, "完成")));
      return;
    }

    sheet.appendChild(h("div", { class: "lbl" }, "遠端目錄"));
    sheet.appendChild(h("div", { class: "loc__url", style: "border:1px solid var(--line-strong);background:var(--field);border-radius:10px;padding:7px 10px" },
      String(cur.conn.url).replace(/[/]+$/, "") + (cur.remotePath ? "/" + cur.remotePath : "")));

    sheet.appendChild(h("div", { class: "lbl" }, "放到本地哪個資料夾底下"));
    sheet.appendChild(h("div", { class: "pathrow" },
      h("div", { class: "v" + (cur.parent ? "" : " empty") }, cur.parent || "（尚未選擇）"),
      h("button", { type: "button", class: "primary", onclick: function () {
        openLocalPicker("Checkout 要放在哪個資料夾底下？", function (picked) { cur.parent = picked; renderCheckout(); checkCoTarget(); });
      } }, "選擇資料夾…")));

    sheet.appendChild(h("div", { class: "lbl" }, "新資料夾名稱（預設跟遠端目錄同名，可以改）"));
    var nameIn = h("input", { type: "text", autocomplete: "off" });
    nameIn.value = cur.name;
    nameIn.addEventListener("input", function () { cur.name = nameIn.value; cur.status = { k: "none", m: "" }; updateCoStatus(); clearTimeout(coTimer); coTimer = setTimeout(checkCoTarget, 250); });
    cur.previewEl = h("div", { class: "hint", style: "margin:6px 0 0" });
    cur.statusEl = h("div", { class: "st" });
    sheet.appendChild(nameIn); sheet.appendChild(cur.previewEl); sheet.appendChild(cur.statusEl);

    sheet.appendChild(h("div", { class: "lbl" }, "Checkout 範圍"));
    CO_SCOPES.forEach(function (o) {
      var radio = h("input", { type: "radio", name: "coScope", checked: cur.scope === o.k ? "checked" : null });
      radio.addEventListener("change", function () { cur.scope = o.k; renderCheckout(); checkCoTarget(); });
      sheet.appendChild(h("label", { class: "opt" + (cur.scope === o.k ? " on" : "") }, radio, h("div", null, h("b", null, o.t), h("small", null, o.d))));
    });

    var chk = h("input", { type: "checkbox", checked: cur.setSync ? "checked" : null });
    chk.addEventListener("change", function () { cur.setSync = chk.checked; });
    sheet.appendChild(h("label", { class: "chk" }, chk, h("span", null, "完成後設為「" + cur.conn.name + "」的同步目錄（上傳、刪除後自動更新這裡）")));
    if (cur.error) sheet.appendChild(h("div", { class: "st err" }, cur.error));

    cur.startBtn = h("button", { type: "button", class: "primary", onclick: function () {
      cur.phase = "run"; cur.error = null; renderCheckout();
      api("POST", "/api/checkout", { connection: cur.conn.id, remotePath: cur.remotePath, parent: cur.parent, name: cur.name.trim(), scope: cur.scope, setSync: cur.setSync }).then(function (res) {
        if (co !== cur) return;
        forgetLocalInfo(res.target);
        cur.phase = "done"; cur.result = res; renderCheckout();
        refresh();
      }).catch(function (e) {
        if (co !== cur) return;
        cur.phase = "form"; cur.error = e.message + (HINTS[e.code] ? String.fromCharCode(10) + HINTS[e.code] : "");
        renderCheckout(); checkCoTarget();
      });
    } }, "開始 Checkout");
    sheet.appendChild(h("div", { class: "sheet2__foot", style: "margin-top:14px" }, h("div", { class: "cur" }), h("button", { type: "button", onclick: closeCheckout }, "取消"), cur.startBtn));
    updateCoStatus();
  }
  // Esc 先關掉最上面的視窗（本機資料夾點選 → Checkout），不要連右邊面板一起收掉
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (lp) closeLocalPicker();
    else if (co && co.phase !== "run") closeCheckout();
    else return;
    ev.preventDefault(); ev.stopPropagation();
  }, true);

  function renderConnView(box) {
    box.appendChild(h("div", null,
      h("h2", null, "連線設定" + (state.servers.length ? "（" + state.servers.length + " 個帳號）" : "（尚未設定）")),
      h("p", { class: "hint" }, "這裡的設定跟 svn-mcp 的唯讀工具共用同一份檔案，只存在這台電腦；只記帳號，底下的 repo 由伺服器自動帶出。密碼不會再顯示出來；編輯時密碼留空代表不變更。"),
      serverSection(),
      syncSection()));
  }

  function renderPickView(box) {
    var segments = pick.path ? pick.path.split("/") : [];
    var crumbs = crumbNodes(segments, loadPick);
    var rows = (pick.entries || []).map(function (e) {
      var full = pick.path ? pick.path + "/" + e.name : e.name;
      var row = h("div", { class: "entry entry--row", role: "button", tabindex: "0", onclick: function () { loadPick(full); } },
        folderStarButton(uploadRepo(), full), h("span", { class: "entry__name" }, "📁 " + e.name), h("span", { class: "path" }, "進入"));
      row.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && ev.target === row) loadPick(full); });
      return row;
    });
    var favBox = renderFavBox(uploadRepo(), loadPick, function (folder) { importForm.path = folder; closeExt(); importRerender(); });
    box.appendChild(h("div", null,
      h("h2", null, "從 SVN 選擇資料夾"),
      h("p", { class: "hint" }, "目前專案：" + (findConnection(importForm.connection) ? connLabel(findConnection(importForm.connection)) : "（未選擇）") + "。點資料夾進入；選好之後按下方「使用這個位置」。"),
      favBox,
      h("div", { class: "crumbs" }, crumbs),
      pick.loading ? h("div", { class: "empty" }, "讀取中…") : null,
      pick.notice ? h("div", { class: "hint" }, pick.notice) : null,
      !pick.loading && pick.entries && pick.entries.length === 0 && !pick.notice ? h("div", { class: "hint" }, "這個資料夾底下沒有子資料夾。") : null,
      rows,
      h("div", { class: "foot" },
        h("div", { class: "hint", style: "margin:0 0 8px;display:flex;align-items:center;gap:8px" },
          pick.path ? folderStarButton(uploadRepo(), pick.path) : null,
          h("span", { style: "flex:1;min-width:0;overflow-wrap:anywhere" }, "目前位置：" + (pick.path || "（連線根目錄）") + (pick.path ? (favFolders(uploadRepo()).indexOf(pick.path) >= 0 ? "　（已是常用目錄）" : "　（點 ☆ 加入常用目錄）") : ""))),
        h("div", { class: "row", style: "margin-top:0" },
          h("button", { type: "button", class: "primary", onclick: function () { importForm.path = pick.path; closeExt(); importRerender(); } }, "使用這個位置"),
          h("button", { type: "button", onclick: closeExt }, "取消")))));
  }

  // ---- 往右延伸的面板：按「▸」按鈕時視窗往右加寬，右邊出現面板；再按一次、按 ✕ 或 Esc 收起，視窗縮回原寬 ----
  var MIN_MAIN_W = 480;
  var EXT_MIN_W = 420;
  var EXT_MAX_W = 760;
  var EXT_W = EXT_MIN_W;
  var ext = { view: null };
  var extSig = "";
  var extAutoOpened = false;
  var windowBaseWidth = null;

  function noConnectionCard() {
    return h("div", { class: "card" }, noConnectionHint());
  }
  function widenWindow() {
    if (window.innerWidth >= MIN_MAIN_W + EXT_W || windowBaseWidth !== null) return;
    windowBaseWidth = window.outerWidth;
    try { window.resizeTo(windowBaseWidth + EXT_W, window.outerHeight); } catch (e) { windowBaseWidth = null; return; }
    keepWindowOnScreen();
  }
  function keepWindowOnScreen() {
    setTimeout(function () {
      var screenRight = (screen.availLeft || 0) + screen.availWidth;
      var over = window.screenX + window.outerWidth - screenRight;
      if (over > 0) { try { window.moveBy(-over, 0); } catch (e) {} }
    }, 150);
  }
  /** 右邊面板的寬度（只會變寬，關閉面板時才還原）；視窗跟著往右延伸。 */
  function setExtWidth(w) {
    if (w <= EXT_W) return;
    EXT_W = w;
    document.getElementById("layout").style.setProperty("--ext-w", w + "px");
    if (windowBaseWidth !== null) {
      try { window.resizeTo(windowBaseWidth + EXT_W, window.outerHeight); } catch (e) {}
      keepWindowOnScreen();
    } else {
      widenWindow();
    }
    setTimeout(applyExtMode, 160);
  }
  var fitContext = document.createElement("canvas").getContext("2d");
  /** 瀏覽清單裡最長的一列需要多寬：檔名一行放得下就加寬面板（上限內），再長才換行。 */
  function fitExtWidth() {
    if (ext.view !== "browse" || browse.picking || !browse.entries || !fitContext) return;
    var family = getComputedStyle(document.body).fontFamily;
    var need = 0;
    browse.entries.forEach(function (entry) {
      fitContext.font = "700 14.5px " + family;
      var nameW = fitContext.measureText(entry.name + (entry.kind === "dir" ? " /" : "")).width;
      fitContext.font = "12px " + family;
      var metaW = fitContext.measureText(entryMetaText(entry)).width;
      need = Math.max(need, nameW, metaW);
    });
    // 加上勾選框、圖示、星星鈕、每列內距、面板內距、捲軸與邊框
    var maxW = Math.max(EXT_MIN_W, Math.min(EXT_MAX_W, (screen.availWidth || 1280) - MIN_MAIN_W));
    setExtWidth(Math.min(maxW, Math.ceil(need + 200)));
  }
  function restoreWindow() {
    if (windowBaseWidth === null) return;
    var base = windowBaseWidth;
    windowBaseWidth = null;
    try { window.resizeTo(base, window.outerHeight); } catch (e) {}
  }
  // 視窗夠寬就並排顯示；放不下（例如視窗無法加寬）就改成蓋在主畫面右側
  function applyExtMode() {
    var layout = document.getElementById("layout");
    var open = ext.view !== null;
    var inline = window.innerWidth >= MIN_MAIN_W + EXT_W;
    layout.classList.toggle("ext-inline", open && inline);
    layout.classList.toggle("ext-overlay", open && !inline);
    document.getElementById("scrim").classList.toggle("is-on", open && !inline);
  }
  function renderExt() {
    var box = document.getElementById("extBody");
    var sig = JSON.stringify([ext.view, state.connections, state.servers, serverBusy, serverForm.id, browse.connection, browse.path, browse.entries, browse.loading, browse.error, browse.truncated, browse.ticket, browse.notice, browse.picking, picker.tab, pick.path, pick.entries, pick.loading, pick.notice, settingsNote, deleteConfirmId, browse.del ? [browse.del.paths, browse.del.busy, browse.del.error] : null, browse.sel, state.repoPrefs.syncLocal, state.repoPrefs.localPaths, localNote, localBusy, Object.keys(localInfo).length]);
    if (sig === extSig) return;
    extSig = sig;
    box.textContent = "";
    if (ext.view === "browse") renderBrowseView(box);
    else if (ext.view === "pick") renderPickView(box);
    else if (ext.view === "conn") renderConnView(box);
    fitExtWidth();
  }
  function refreshMainCards() {
    browseSig = ""; settingsSig = ""; importerSig = "";
    renderBrowser(); renderImporter(); renderSettings();
  }
  function prepareExt(view) {
    if (view === "browse" && state.connections.length > 0) {
      if (!browse.picking && !findConnection(browse.connection)) browse.picking = true;
      if (!browse.picking && !browse.entries && !browse.loading && !browse.error) loadBrowse(browse.path);
    } else if (view === "pick") {
      loadPick(pick.path);
    }
  }
  function openExt(view) {
    if (ext.view === view) { closeExt(); return; }
    var wasOpen = ext.view !== null;
    ext.view = view;
    document.getElementById("layout").classList.add("ext-open");
    if (!wasOpen) widenWindow();
    setTimeout(applyExtMode, wasOpen ? 0 : 160);
    prepareExt(view);
    extSig = ""; renderExt();
    refreshMainCards();
  }
  function closeExt() {
    favEditing = "";
    ext.view = null;
    var layout = document.getElementById("layout");
    layout.classList.remove("ext-open", "ext-inline", "ext-overlay");
    document.getElementById("scrim").classList.remove("is-on");
    restoreWindow();
    EXT_W = EXT_MIN_W;
    layout.style.removeProperty("--ext-w");
    refreshMainCards();
  }
  document.getElementById("extClose").addEventListener("click", closeExt);
  document.getElementById("scrim").addEventListener("click", closeExt);
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && ext.view !== null) closeExt(); });
  window.addEventListener("resize", applyExtMode);
  render();
  refresh();
  setInterval(refresh, 3000);
  // 視窗關閉（或重新整理）時通知伺服器；keepalive 讓請求在頁面卸載後仍會送出。伺服器會自己判斷是不是只是重新整理。
  window.addEventListener("pagehide", function () {
    try { fetch("/api/window-closing", { method: "POST", keepalive: true, headers: { "X-Edit-Token": TOKEN, "Content-Type": "application/json" }, body: "{}" }); } catch (e) { /* 關閉中，失敗就靠閒置逾時 */ }
  });
})();
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
