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
import { loadPlatform, PlatformContext } from "./lib/platform";

async function boot() {
  const params = new URLSearchParams(window.location.search);
  env.inTauri = "__TAURI_INTERNALS__" in window;

  // 開発時のみ: Tauri 外 (ブラウザ) か ?mock= 指定時はモックの IPC を入れる。本番ビルドには含まれない
  if (import.meta.env.DEV && (!env.inTauri || params.has("mock"))) {
    env.browserFrame = !env.inTauri;
    const { installMock } = await import("./mock");
    installMock(params);
  }

  // OS は起動中に変わらないため描画の前に 1 回だけ取る (Mac の表示で描いてから切り替わるのを避ける)
  const platform = await loadPlatform();
  document.documentElement.dataset.platform = platform;

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
      <PlatformContext.Provider value={platform}>
        <I18nProvider>
          <TooltipProvider>
            <Screen />
          </TooltipProvider>
        </I18nProvider>
      </PlatformContext.Provider>
    </React.StrictMode>,
  );
}

void boot();
