import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/ibm-plex-sans-jp/400.css";
import "@fontsource/ibm-plex-sans-jp/500.css";
import "@fontsource/ibm-plex-sans-jp/600.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/index.css";
import { env, isWindowKind, type WindowKind } from "./lib/env";
import { TooltipProvider } from "./components/ui/tooltip";
import { I18nProvider } from "./i18n/provider";

async function boot() {
  const params = new URLSearchParams(window.location.search);
  env.inTauri = "__TAURI_INTERNALS__" in window;

  // 開発時のみ: Tauri 外 (ブラウザ) か ?mock= 指定時はモックの IPC を入れる。本番ビルドには含まれない
  if (import.meta.env.DEV && (!env.inTauri || params.has("mock"))) {
    env.browserFrame = !env.inTauri;
    const { installMock } = await import("./mock");
    installMock(params);
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const label = getCurrentWindow().label;
  // label が panel / settings / setup 以外 (旧 main 等) の場合は設定画面を出す
  const kind: WindowKind = isWindowKind(label) ? label : "settings";
  document.documentElement.dataset.window = kind;

  const Screen =
    kind === "panel"
      ? (await import("./windows/panel/PanelWindow")).PanelWindow
      : kind === "setup"
        ? (await import("./windows/setup/SetupWindow")).SetupWindow
        : (await import("./windows/settings/SettingsWindow")).SettingsWindow;

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <I18nProvider>
        <TooltipProvider>
          <Screen />
        </TooltipProvider>
      </I18nProvider>
    </React.StrictMode>,
  );
}

void boot();
