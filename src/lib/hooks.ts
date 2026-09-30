/*
 * Rust の状態を購読する hooks。いずれも「購読してから初期値を取得」して取りこぼしを防ぐ (subscribeWithInitial)。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  commands,
  isNotImplemented,
  subscribeWithInitial,
  unimplementedStore,
  type AppStatus,
  type Permissions,
  type ProvisioningStatus,
  type Settings,
} from "./ipc";

export function useAppStatus(): AppStatus | null {
  const [status, setStatus] = useState<AppStatus | null>(null);
  useEffect(() => subscribeWithInitial("status-changed", commands.getStatus, setStatus), []);
  return status;
}

/** 設定の読み書き。変更は即時保存・即時反映 (update_settings が保存後の値を返す) */
export function useSettings(): [Settings | null, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => subscribeWithInitial("settings-changed", commands.getSettings, setSettings), []);
  const update = useCallback((patch: Partial<Settings>) => {
    // 操作への追従を優先して先に反映し、保存後の値で上書きする
    setSettings((s) => (s ? { ...s, ...patch } : s));
    commands.updateSettings(patch).then(setSettings, (e: unknown) => {
      // 保存に失敗したら Rust 側の値に戻す
      console.warn(e);
      commands.getSettings().then(setSettings, () => {});
    });
  }, []);
  return [settings, update];
}

/** 権限。pollMs を指定すると一定間隔で再取得する (システム設定での変更は通知されないことがあるため) */
export function usePermissions(pollMs?: number): [Permissions | null, (p: Permissions) => void] {
  const [perms, setPerms] = useState<Permissions | null>(null);
  useEffect(() => subscribeWithInitial("permissions-changed", commands.getPermissions, setPerms), []);
  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => {
      // 非表示のウィンドウでは取りに行かない (再表示時は subscribeWithInitial が取り直す)
      if (document.visibilityState === "hidden") return;
      commands.getPermissions().then(setPerms, () => {});
    }, pollMs);
    return () => clearInterval(t);
  }, [pollMs]);
  return [perms, setPerms];
}

export function useProvisioning(): ProvisioningStatus | null {
  const [status, setStatus] = useState<ProvisioningStatus | null>(null);
  useEffect(() => subscribeWithInitial("provisioning-progress", commands.getProvisioningStatus, setStatus), []);
  return status;
}

/**
 * 指定した command のいずれかが未実装 (`not_implemented:` で reject) と分かっているか。
 * 呼んで初めて分かるため、最初は false で、reject された時点で true になる。
 */
export function useUnimplemented(...commandNames: string[]): boolean {
  useSyncExternalStore(unimplementedStore.subscribe, unimplementedStore.version);
  return commandNames.some((c) => unimplementedStore.has(c));
}

/** 未実装以外のエラーのメッセージ (Rust の表示用メッセージ)。未実装は null */
export function errorMessage(e: unknown): string | null {
  if (isNotImplemented(e)) return null;
  return e instanceof Error ? e.message : String(e);
}

export function isPermissionsGranted(p: Permissions | null): boolean {
  return !!p && p.microphone === "granted" && p.accessibility;
}
