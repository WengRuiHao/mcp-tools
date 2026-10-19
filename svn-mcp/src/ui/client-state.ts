/** 控制頁前端（瀏覽器端 JS 片段）：頁面的狀態與常數（所有 var 宣告，維持原本的先後順序）。
 * 這些片段會依序接進同一個立即執行函式（見 client.ts），所以彼此共用變數與函式；函式宣告會被提升，搬到哪個檔案都安全。 */
export const CLIENT_STATE = String.raw`  var TOKEN = "__EDIT_TOKEN__";
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

  var HINTS = {
    EDITOR_STILL_OPEN: "請先在 Word／Excel 存檔並關閉這個檔案，再按「上傳」。",
    REMOTE_CHANGED: "可以按「下載最新版另存」取得對方的版本，手動比對、合併後，再把內容貼回你正在編輯的檔案重新上傳。",
    NO_CHANGES: "還沒有修改任何內容。改完並存檔後再按「上傳」。",
    FILE_LOCKED: "檔案目前被別人鎖定編輯中，請等對方上傳或解除鎖定。",
    ALREADY_EDITING: "這個檔案已經有進行中的編輯，請到下方的編輯清單繼續處理。"
  };

  /** 跳出警示視窗（使用者按「知道了」才關）：遠端已經成功、但本地端沒處理好的情況要讓人一定看到。 */
  var alertBox = null;
  // ---- 準備開始編輯（從 dev-pipeline 按鈕或連結進來） ----
  var pendingNote = null;
  var pendingSig = "";
  // ---- 瀏覽 SVN 目錄（唯讀）：主畫面只放一張卡片，清單在往右延伸的面板裡 ----
  var browse = { connection: "", path: "", entries: null, truncated: false, loading: false, error: null, ticket: "", notice: null, picking: true };
  // 專案選擇畫面（近期／星星分頁、搜尋、簡稱）的暫時狀態
  var picker = { tab: "recent", query: "", editing: "", note: null, busy: false };
  var browseSig = "";
  var browseStarted = false;

  /** 清單圖示：資料夾「夾」、Word「W」、Excel「X」（.xls 與 .xlsx 同一種）、PDF、圖片等各有顏色。 */
  var BADGE_BY_EXT = { doc: ["docx", "W"], docx: ["docx", "W"], xls: ["xlsx", "X"], xlsx: ["xlsx", "X"], pdf: ["pdf", "PDF"], md: ["md", "MD"], txt: ["txt", "TXT"], csv: ["csv", "CSV"],
    png: ["img", "PNG"], jpg: ["img", "JPG"], jpeg: ["img", "JPG"], gif: ["img", "GIF"], bmp: ["img", "BMP"] };
  var dragName = null;
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

  // 目的地資料夾選擇器（只列資料夾，唯讀）：在往右延伸的面板裡操作，按「使用這個位置」才會填進路徑欄位
  var pick = { path: "", loadedFor: null, entries: null, loading: false, notice: null };
  var PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';
  /** 目前正在改暱稱的常用目錄（「專案 | 路徑」）；空字串代表沒有。 */
  var favEditing = "";
  // ---- 連線設定：主畫面只放連線摘要，表單在往右延伸的面板裡 ----
  var settingsSig = "";
  // ---- 同步本地端（管理連線）、本機資料夾點選、Checkout 到本地 ----
  var addRepo = "";
  var localInfo = {};
  var localInfoAsked = {};
  // ---- 選本機資料夾：優先叫出 Windows 系統的「選擇資料夾」視窗（跟檔案總管同一個）；叫不出來才退回頁面內的點選視窗 ----
  var lastPickedDir = "";
  var nativePicking = null;
  // ---- 本機資料夾點選（頁面內的備用視窗）----
  var lp = null;
  // ---- Checkout 到本地 ----
  var co = null;
  var coTimer = null;
  var CO_SCOPES = [
    { k: "all", t: "整個目錄（含所有子資料夾）", d: "最完整；檔案多時要等一陣子。" },
    { k: "files", t: "只取這一層的檔案（不含子資料夾）", d: "之後要用到子資料夾再另外取。" },
    { k: "empty", t: "只建立追蹤（先不下載檔案）", d: "馬上完成；之後編輯、上傳到哪個檔案，才取回哪個檔案。" }
  ];
  // ---- 往右延伸的面板：按「▸」按鈕時視窗往右加寬，右邊出現面板；再按一次、按 ✕ 或 Esc 收起，視窗縮回原寬 ----
  var MIN_MAIN_W = 480;
  var EXT_MIN_W = 420;
  var EXT_MAX_W = 760;
  var EXT_W = EXT_MIN_W;
  var ext = { view: null };
  var extSig = "";
  var extAutoOpened = false;
  var windowBaseWidth = null;

  var fitContext = document.createElement("canvas").getContext("2d");`;
