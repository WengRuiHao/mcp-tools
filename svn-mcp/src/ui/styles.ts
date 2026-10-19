/** 控制頁的樣式（CSS）。 */
export const UI_CSS = String.raw`:root{
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
/* 常用目錄的「釘選」按鈕：沒釘是灰色圖釘，釘選後粉紅底、紅色圖釘 */
button.pin{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:30px;height:30px;padding:0;border-radius:9px;color:var(--muted);box-shadow:none}
button.pin svg{width:16px;height:16px;fill:currentColor}
button.pin:hover:not(:disabled){color:var(--brand);background:var(--brand-soft)}
button.pin.on{color:var(--brand);background:var(--brand-soft);border-color:#f3c3c5}
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
.warnbox{background:var(--danger-bg);color:var(--danger);border-radius:var(--radius-field);padding:8px 12px;margin:8px 0;font-size:13.5px}`;
