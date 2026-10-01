/*
 * パネルの状態。status-changed と utterance-* を購読して発話ごとの表示を管理する。
 * 値・挙動は docs/plans/implementation-plan.md「2. 音声入力の体験」に従う。
 */
import { useEffect, useReducer, useRef } from "react";
import { commands, latestStatusOnly, subscribeWithInitial, type AppStatus, type Utterance, type UtteranceResult } from "@/lib/ipc";
import { resetAudioLevel } from "@/lib/audio-level";
import { devOverrides } from "@/lib/env";
import { diffPreview, type DiffSegment } from "./preview-diff";

/**
 * 入力できた発話の最終結果を表示する時間。入力先はフォーカスで分かるため、内容の確認に足りる短さにする
 * (docs/plans/implementation-plan.md「確定結果の表示」)
 */
export const INSERTED_DISPLAY_MS = 750;
/** 音声コマンドの結果を表示する時間。tsunagi に準拠して 2 秒 */
export const RESULT_DISPLAY_MS = 2000;
/** 入力しなかった・できなかった発話の表示時間 (理由を読めるように)。エラー表示 (06) と同じ 3 秒 */
export const FAILED_DISPLAY_MS = 3000;
/** エラー発生時にパネルへ短く表示する時間 (06: 3 秒後にオフの表示へ戻す) */
export const ERROR_DISPLAY_MS = 3000;

export type ShownResult = Exclude<UtteranceResult, { kind: "empty" } | { kind: "discarded" }>;

export type PanelItem = {
  id: number;
  text: string;
  /** 前回の表示からの差分で区切った text。挿入・書き換えの区間を一瞬色付けする */
  segments: DiffSegment[];
  /** text が変わるたびに増やす。色付けのアニメーションを付け直すため、描画のキーに使う */
  revision: number;
  stage: "speaking" | "finalizing" | "done";
  result: ShownResult | null;
};

type State = {
  status: AppStatus | null;
  items: PanelItem[];
  // 収縮アニメーション中も直前の内容を表示し続けるため、最後に表示していた発話を残す
  lastShown: PanelItem[];
  errorVisible: boolean;
};

type Action =
  | { type: "status"; status: AppStatus }
  | { type: "started"; id: number }
  | { type: "partial"; u: Utterance }
  | { type: "result"; r: UtteranceResult }
  | { type: "expire"; id: number }
  | { type: "hideError" };

/** it の表示を next に置き換える。同じ文字なら差分を付け直さない (色付けの途中で消さない) */
function withText(it: PanelItem, next: string): Pick<PanelItem, "text" | "segments" | "revision"> {
  if (it.text === next) return it;
  return { text: next, segments: diffPreview(it.text, next), revision: it.revision + 1 };
}

function newItem(id: number, text: string, stage: PanelItem["stage"], result: ShownResult | null): PanelItem {
  return { id, text, segments: diffPreview("", text), revision: 0, stage, result };
}

function withItems(state: State, items: PanelItem[]): State {
  return { ...state, items, lastShown: items.length > 0 ? items : state.lastShown };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "status": {
      const { status } = action;
      const enteringError = status.phase === "error" && state.status?.phase !== "error";
      // 発話中 (speaking) でなくなったら、話していた発話は確定処理に入っている。
      // 以降に遅れて届いた途中表示は反映しない (表示の巻き戻り防止)
      const items =
        status.phase === "speaking"
          ? state.items
          : state.items.map((it) => (it.stage === "speaking" ? { ...it, stage: "finalizing" as const } : it));
      return {
        ...withItems(state, items),
        status,
        errorVisible: status.phase === "error" ? state.errorVisible || enteringError : false,
      };
    }
    case "started": {
      // 次の発話が始まった時点で、前の発話は確定処理中
      const prev = state.items.map((it) => (it.stage === "speaking" ? { ...it, stage: "finalizing" as const } : it));
      if (prev.some((it) => it.id === action.id)) return withItems(state, prev);
      return withItems(state, [...prev, newItem(action.id, "", "speaking", null)]);
    }
    case "partial": {
      const { u } = action;
      const exists = state.items.some((it) => it.id === u.id);
      if (!exists) {
        // started を取りこぼした場合 (ウィンドウ再読み込み直後など) も表示する
        return withItems(state, [
          ...state.items,
          newItem(u.id, u.text, "speaking", null),
        ]);
      }
      return withItems(
        state,
        // 差分は前回の途中表示と比べる (stableLength は末尾以外の変化を表せないので使わない)
        state.items.map((it) => (it.id === u.id && it.stage === "speaking" ? { ...it, ...withText(it, u.text) } : it)),
      );
    }
    case "result": {
      const { r } = action;
      // 結果が空・誤検出は表示を消して何も入力しない
      if (r.kind === "empty" || r.kind === "discarded") {
        return withItems(
          state,
          state.items.filter((it) => it.id !== r.id),
        );
      }
      // 途中表示から最終結果に置き換わる時も差分を出し、確定で何が変わったかを見せる
      const prev = state.items.find((it) => it.id === r.id);
      const done: PanelItem = prev
        ? { ...prev, ...withText(prev, r.text), stage: "done", result: r }
        : newItem(r.id, r.text, "done", r);
      const items = prev ? state.items.map((it) => (it.id === r.id ? done : it)) : [...state.items, done];
      return withItems(
        state,
        items.sort((a, b) => a.id - b.id),
      );
    }
    case "expire":
      return withItems(
        state,
        state.items.filter((it) => it.id !== action.id),
      );
    case "hideError":
      return { ...state, errorVisible: false };
  }
}

export function usePanelModel() {
  const [state, dispatch] = useReducer(reducer, { status: null, items: [], lastShown: [], errorVisible: false });
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timerSet = timers.current;
    // 表示時間の経過で消す。描画タイミングの調整ではなく、表示期間そのものの仕様
    const later = (ms: number, action: Action) => {
      if (devOverrides.holdResults) return;
      const t = setTimeout(() => {
        timerSet.delete(t);
        dispatch(action);
      }, ms);
      timerSet.add(t);
    };
    let lastPhase: AppStatus["phase"] | null = null;
    const onStatus = latestStatusOnly((status: AppStatus) => {
      dispatch({ type: "status", status });
      if (status.phase === "error" && lastPhase !== "error") later(ERROR_DISPLAY_MS, { type: "hideError" });
      if (status.phase === "off" || status.phase === "loading" || status.phase === "error") resetAudioLevel();
      lastPhase = status.phase;
    });

    // 購読してから初期値を取る (取りこぼし防止)。初期値より新しい status-changed が先に届いた場合は初期値を捨てる
    const unsubscribe = subscribeWithInitial("status-changed", commands.getStatus, onStatus, {
      "utterance-started": ({ id }) => dispatch({ type: "started", id }),
      "utterance-partial": (u) => dispatch({ type: "partial", u }),
      "utterance-result": (r) => {
        dispatch({ type: "result", r });
        if (r.kind !== "empty" && r.kind !== "discarded") {
          const ms =
            r.kind === "inserted"
              ? INSERTED_DISPLAY_MS
              : r.kind === "command"
                ? RESULT_DISPLAY_MS
                : FAILED_DISPLAY_MS;
          later(ms, { type: "expire", id: r.id });
        }
      },
    });
    return () => {
      unsubscribe();
      timerSet.forEach(clearTimeout);
      timerSet.clear();
    };
  }, []);

  return state;
}
