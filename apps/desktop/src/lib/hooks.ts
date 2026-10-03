/*
 * Rust の状態を購読する hooks。いずれも「購読してから初期値を取得」して取りこぼしを防ぐ (subscribeWithInitial)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  commands,
  latestStatusOnly,
  subscribeWithInitial,
  type AppStatus,
  type ModelInfo,
  type PanelAnchor,
  type Permissions,
  type ProvisioningStatus,
  type Settings,
  type ShortcutStatus,
  type UpdateStatus,
} from "./ipc";

export function useAppStatus(): AppStatus | null {
  const [status, setStatus] = useState<AppStatus | null>(null);
  useEffect(() => subscribeWithInitial("status-changed", commands.getStatus, latestStatusOnly(setStatus)), []);
  return status;
}

/** Rust の位置が決まる前の値 (get_panel_anchor と同じ) */
const DEFAULT_PANEL_ANCHOR: PanelAnchor = { horizontal: "center", vertical: "bottom" };

/**
 * panel のアンカー。作成直後の panel-anchor は購読前に送られるため、購読してから get_panel_anchor で取る
 */
export function usePanelAnchor(): PanelAnchor {
  const [anchor, setAnchor] = useState<PanelAnchor>(DEFAULT_PANEL_ANCHOR);
  useEffect(() => subscribeWithInitial("panel-anchor", commands.getPanelAnchor, setAnchor), []);
  return anchor;
}

/** 設定キーごとの保存エラー (Rust の表示用メッセージ)。該当する操作の近くに表示する */
export type SettingsErrors = Partial<Record<keyof Settings, string>>;

type PendingPatch = { id: number; patch: Partial<Settings> };

/**
 * 設定の読み書き。変更は即時保存・即時反映 (update_settings が保存後の値を返す)。
 *
 * 表示する値 = Rust の値 (応答・settings-changed) に、応答待ちの変更を順に重ねたもの。
 * 応答待ちの間に古い settings-changed が届いても操作した値が巻き戻らず、
 * 失敗した変更は重ねるのをやめるだけで Rust の値に戻る。
 */
export function useSettings(): [Settings | null, (patch: Partial<Settings>) => void, SettingsErrors] {
  const [server, setServer] = useState<Settings | null>(null);
  const [pending, setPending] = useState<PendingPatch[]>([]);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const nextId = useRef(0);
  // 応答は送った順に届くとは限らないため、反映済みの最新の要求より古い応答は捨てる
  const appliedId = useRef(0);

  useEffect(() => subscribeWithInitial("settings-changed", commands.getSettings, setServer), []);

  const update = useCallback((patch: Partial<Settings>) => {
    nextId.current += 1;
    const id = nextId.current;
    const keys = Object.keys(patch) as (keyof Settings)[];
    const done = () => setPending((p) => p.filter((x) => x.id !== id));
    setPending((p) => [...p, { id, patch }]);
    commands.updateSettings(patch).then(
      (saved) => {
        if (id > appliedId.current) {
          appliedId.current = id;
          setServer(saved);
        }
        done();
        setErrors((e) => omitKeys(e, keys));
      },
      (e: unknown) => {
        done();
        const message = errorMessage(e);
        setErrors((prev) => ({ ...prev, ...Object.fromEntries(keys.map((k) => [k, message])) }));
      },
    );
  }, []);

  const settings = useMemo(
    () => (server ? pending.reduce<Settings>((s, x) => ({ ...s, ...x.patch }), server) : null),
    [server, pending],
  );
  return [settings, update, errors];
}

function omitKeys<T extends object>(obj: T, keys: (keyof T)[]): T {
  if (!keys.some((k) => k in obj)) return obj;
  const next = { ...obj };
  keys.forEach((k) => delete next[k]);
  return next;
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

/** ショートカットの登録状態。起動時に登録できなかった時の警告表示に使う */
export function useShortcutStatus(): ShortcutStatus | null {
  const [status, setStatus] = useState<ShortcutStatus | null>(null);
  useEffect(() => subscribeWithInitial("shortcut-status-changed", commands.getShortcutStatus, setStatus), []);
  return status;
}

export function useProvisioning(): ProvisioningStatus | null {
  const [status, setStatus] = useState<ProvisioningStatus | null>(null);
  useEffect(() => subscribeWithInitial("provisioning-progress", commands.getProvisioningStatus, setStatus), []);
  return status;
}

/**
 * アップデートの状態。null は取得前。取得の失敗は error に入れる (状態が無くてもこの画面の他の項目は使えるため)。
 * applyResponse は check_for_update の応答を反映する。呼んでから状態を受け取っていれば (event・再取得)
 * 応答は古い可能性があるので捨てる (取得中は約4Hz で進捗が届き、応答の bytesDone で巻き戻さないため)
 */
export function useUpdateStatus(): {
  status: UpdateStatus | null;
  error: string | null;
  applyResponse: (p: Promise<UpdateStatus>) => Promise<void>;
} {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const received = useRef(0);
  useEffect(
    () =>
      subscribeWithInitial(
        "update-status-changed",
        () =>
          commands.getUpdateStatus().catch((e: unknown) => {
            setError(errorMessage(e));
            throw e;
          }),
        (s) => {
          received.current += 1;
          setStatus(s);
          setError(null);
        },
      ),
    [],
  );
  const applyResponse = useCallback(async (p: Promise<UpdateStatus>) => {
    const at = received.current;
    const s = await p;
    if (received.current === at) setStatus(s);
  }, []);
  return { status, error, applyResponse };
}

/** モデルの一覧。null は取得前。取得の失敗は error に入れる (一覧が無くても他の設定は使えるため) */
export function useModels(): { models: ModelInfo[] | null; error: string | null } {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () =>
      subscribeWithInitial(
        "models-changed",
        () =>
          commands.listModels().catch((e: unknown) => {
            setError(errorMessage(e));
            throw e;
          }),
        (m) => {
          setModels(m);
          setError(null);
        },
      ),
    [],
  );
  return { models, error };
}

/** エラーの表示用メッセージ (Rust の表示用メッセージ) */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isPermissionsGranted(p: Permissions | null): boolean {
  return !!p && p.microphone === "granted" && p.accessibility;
}

/**
 * スライダーの値を操作中はローカルに持ち、止まって delayMs 経つか離した時 (flush) に commit する。
 * ドラッグ中に 1 目盛りごとに設定を保存・VAD を作り直さないため。
 * 操作していない間は value (他ウィンドウからの変更を含む) をそのまま表示する。
 */
export function useDebouncedCommit(value: number, commit: (v: number) => void, delayMs = 150) {
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<number | null>(null);
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const v = latest.current;
    if (v == null) return;
    latest.current = null;
    // commit で表示値 (value) が v になるので、ローカルの値は捨てる
    commitRef.current(v);
    setDraft(null);
  }, []);

  const change = useCallback(
    (v: number) => {
      latest.current = v;
      setDraft(v);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delayMs);
    },
    [flush, delayMs],
  );

  // カテゴリの切り替え等で消える時も、操作した値は保存する
  useEffect(() => flush, [flush]);

  return { value: draft ?? value, change, flush };
}
