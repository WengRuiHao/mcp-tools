/** 控制頁的前端程式：把各功能片段依序接進同一個立即執行函式。 */
import { CLIENT_STATE } from "./client-state.js";
import { CLIENT_CORE } from "./client-core.js";
import { CLIENT_EDIT } from "./client-edit.js";
import { CLIENT_BROWSE } from "./client-browse.js";
import { CLIENT_PROJECTS } from "./client-projects.js";
import { CLIENT_FAVORITES } from "./client-favorites.js";
import { CLIENT_UPLOAD } from "./client-upload.js";
import { CLIENT_SETTINGS } from "./client-settings.js";
import { CLIENT_LOCAL } from "./client-local.js";
import { CLIENT_CHECKOUT } from "./client-checkout.js";
import { CLIENT_PANEL } from "./client-panel.js";
import { CLIENT_BOOT } from "./client-boot.js";

export const CLIENT_JS = [
  "(function () {",
  CLIENT_STATE,
  CLIENT_CORE,
  CLIENT_EDIT,
  CLIENT_BROWSE,
  CLIENT_PROJECTS,
  CLIENT_FAVORITES,
  CLIENT_UPLOAD,
  CLIENT_SETTINGS,
  CLIENT_LOCAL,
  CLIENT_CHECKOUT,
  CLIENT_PANEL,
  CLIENT_BOOT,
  "})();",
].join("\n");
