/*
 * Rust の状態を購読する hooks。いずれも「購読してから初期値を取得」して取りこぼしを防ぐ。
 */
import { useCallback, useEffect, useState } from "react";
import {
  commands,
  subscribeEvents,
  type AppStatus,
  type Permissions,
  type ProvisioningStatus,
  type Settings,
} from "./ipc";

export function useAppStatus(): AppStatus | null {
  const [status, setStatus] = useState<AppStatus | null>(null);
  useEffect(
    () =>
      subscribeEvents({ "status-changed": setStatus }, () => {
        commands.getStatus().then(setStatus, () => {});
      }),
    [],
  );
  return status;
}

/** 設定の読み書き。変更は即時保存・即時反映 (update_settings が保存後の値を返す) */
export function useSettings(): [Settings | null, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(
    () =>
      subscribeEvents({ "settings-changed": setSettings }, () => {
        commands.getSettings().then(setSettings, () => {});
      }),
    [],
  );
  const update = useCallback((patch: Partial<Settings>) => {
    // 操作への追従を優先して先に反映し、保存後の値で上書きする
    setSettings((s) => (s ? { ...s, ...patch } : s));
    commands.updateSettings(patch).then(setSettings, () => {
      commands.getSettings().then(setSettings, () => {});
    });
  }, []);
  return [settings, update];
}

/** 権限。pollMs を指定すると一定間隔で再取得する (システム設定での変更は通知されないことがあるため) */
export function usePermissions(pollMs?: number): [Permissions | null, (p: Permissions) => void] {
  const [perms, setPerms] = useState<Permissions | null>(null);
  useEffect(
    () =>
      subscribeEvents({ "permissions-changed": setPerms }, () => {
        commands.getPermissions().then(setPerms, () => {});
      }),
    [],
  );
  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => {
      commands.getPermissions().then(setPerms, () => {});
    }, pollMs);
    return () => clearInterval(t);
  }, [pollMs]);
  return [perms, setPerms];
}

export function useProvisioning(): ProvisioningStatus | null {
  const [status, setStatus] = useState<ProvisioningStatus | null>(null);
  useEffect(
    () =>
      subscribeEvents({ "provisioning-progress": setStatus }, () => {
        commands.getProvisioningStatus().then(setStatus, () => {});
      }),
    [],
  );
  return status;
}

export function isPermissionsGranted(p: Permissions | null): boolean {
  return !!p && p.microphone === "granted" && p.accessibility;
}
