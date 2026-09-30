/*
 * 設定 (デザイン 05、760×560、サイドバー 200px)。
 * 初期カテゴリは URL の ?category= で指定する (ウィンドウを作る時に Rust が付ける)。
 * 開いている間は open_settings(category) で Rust から settings-navigate が届き、カテゴリを切り替える。
 */
import { useEffect, useState } from "react";
import { TrafficLights, WindowFrame } from "@/components/app/window-frame";
import { isPermissionsGranted, useAppStatus, usePermissions, useSettings } from "@/lib/hooks";
import { subscribeEvents } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { GeneralSection } from "./sections/GeneralSection";
import { VoiceSection } from "./sections/VoiceSection";
import { CommandsSection } from "./sections/CommandsSection";
import { RecognitionSection } from "./sections/RecognitionSection";
import { PermissionsSection } from "./sections/PermissionsSection";
import { StorageSection } from "./sections/StorageSection";
import { AboutSection } from "./sections/AboutSection";
import { CATEGORIES, toCategory, type CategoryId } from "./categories";

function initialCategory(): CategoryId {
  return toCategory(new URLSearchParams(window.location.search).get("category")) ?? "general";
}

export function SettingsWindow() {
  const [category, setCategory] = useState<CategoryId>(initialCategory);
  useEffect(
    () =>
      subscribeEvents({
        "settings-navigate": ({ category: next }) => {
          const c = toCategory(next);
          if (c) setCategory(c);
        },
      }),
    [],
  );
  const [settings, updateSettings, settingsErrors] = useSettings();
  // システム設定での変更は通知されないことがあるため、開いている間は 1 秒ごとに再取得する
  const [permissions, setPermissions] = usePermissions(1000);
  const status = useAppStatus();
  const current = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];
  const permWarning = permissions != null && !isPermissionsGranted(permissions);

  return (
    <WindowFrame width={760} height={560}>
      <nav className="flex w-[200px] flex-none flex-col border-r border-line-default bg-surface-app">
        <div data-tauri-drag-region className="flex h-11 flex-none items-center gap-2 px-3.5">
          <TrafficLights />
        </div>
        <ul className="m-0 flex list-none flex-col gap-0.5 px-2 py-1">
          {CATEGORIES.map((c) => {
            const selected = c.id === category;
            const Icon = c.icon;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  onClick={() => setCategory(c.id)}
                  className={cn(
                    "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border-0 px-2.5 text-left text-sm transition-[background-color] duration-[120ms] ease-standard",
                    selected
                      ? "bg-surface-selected font-medium text-fg-selected"
                      : "bg-transparent font-normal text-fg-body hover:bg-surface-active",
                  )}
                >
                  <Icon size={16} className="flex-none" aria-hidden />
                  <span className="flex-1">{c.label}</span>
                  {c.id === "permissions" && permWarning ? (
                    <span
                      data-testid="permissions-warning"
                      aria-label="未許可の権限があります"
                      className="size-1.5 flex-none rounded-full bg-amber-500"
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">
        <h1
          data-tauri-drag-region
          className="m-0 flex h-11 flex-none items-center border-b border-line-subtle px-7 text-md font-semibold text-fg-strong"
        >
          {current.label}
        </h1>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-7 py-5">
          {settings ? (
            <>
              {category === "general" && <GeneralSection settings={settings} update={updateSettings} errors={settingsErrors} />}
              {category === "voice" && <VoiceSection settings={settings} update={updateSettings} errors={settingsErrors} status={status} />}
              {category === "commands" && <CommandsSection settings={settings} update={updateSettings} errors={settingsErrors} />}
              {category === "recognition" && (
                <RecognitionSection settings={settings} update={updateSettings} errors={settingsErrors} status={status} />
              )}
              {category === "permissions" && (
                <PermissionsSection permissions={permissions} onChange={setPermissions} />
              )}
              {category === "storage" && <StorageSection />}
              {category === "about" && <AboutSection />}
            </>
          ) : null}
        </div>
      </main>
    </WindowFrame>
  );
}
