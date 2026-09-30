/*
 * パネルの状態。status-changed と utterance-* を購読して発話ごとの表示を管理する。
 * 値・挙動は docs/plans/implementation-plan.md「2. 音声入力の体験」に従う。
 */
import { useEffect, useReducer, useRef } from "react";
import { commands, subscribeEvents, type AppStatus, type Utterance, type UtteranceResult } from "@/lib/ipc";
import { resetAudioLevel } from "@/lib/audio-level";
import { devOverrides } from "@/lib/env";

/** 確定結果 (入力した内容) を表示する時間。tsunagi に準拠して 2 秒 */
export const RESULT_DISPLAY_MS = 2000;
/** 入力に失敗した発話の表示時間。エラー表示 (06) と同じ 3 秒 */
export const FAILED_DISPLAY_MS = 3000;
/** エラー発生時にパネルへ短く表示する時間 (06: 3 秒後にオフの表示へ戻す) */
export const ERROR_DISPLAY_MS = 3000;

export type ShownResult = Exclude<UtteranceResult, { kind: "empty" } | { kind: "discarded" }>;

export type PanelItem = {
  id: number;
  text: string;
  stableLength: number;
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
      return withItems(state, [...prev, { id: action.id, text: "", stableLength: 0, stage: "speaking", result: null }]);
    }
    case "partial": {
      const { u } = action;
      const exists = state.items.some((it) => it.id === u.id);
      if (!exists) {
        // started を取りこぼした場合 (ウィンドウ再読み込み直後など) も表示する
        return withItems(state, [
          ...state.items,
          { id: u.id, text: u.text, stableLength: u.stableLength, stage: "speaking", result: null },
        ]);
      }
      return withItems(
        state,
        state.items.map((it) =>
          it.id === u.id && it.stage === "speaking" ? { ...it, text: u.text, stableLength: u.stableLength } : it,
        ),
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
      const done: PanelItem = { id: r.id, text: r.text, stableLength: r.text.length, stage: "done", result: r };
      const exists = state.items.some((it) => it.id === r.id);
      const items = exists ? state.items.map((it) => (it.id === r.id ? done : it)) : [...state.items, done];
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
    const onStatus = (status: AppStatus) => {
      dispatch({ type: "status", status });
      if (status.phase === "error" && lastPhase !== "error") later(ERROR_DISPLAY_MS, { type: "hideError" });
      if (status.phase === "off" || status.phase === "loading" || status.phase === "error") resetAudioLevel();
      lastPhase = status.phase;
    };

    const unsubscribe = subscribeEvents(
      {
        "status-changed": onStatus,
        "utterance-started": ({ id }) => dispatch({ type: "started", id }),
        "utterance-partial": (u) => dispatch({ type: "partial", u }),
        "utterance-result": (r) => {
          dispatch({ type: "result", r });
          if (r.kind !== "empty" && r.kind !== "discarded") {
            later(r.kind === "failed" ? FAILED_DISPLAY_MS : RESULT_DISPLAY_MS, { type: "expire", id: r.id });
          }
        },
      },
      // 購読してから初期値を取る (取りこぼし防止)
      () => {
        commands.getStatus().then(onStatus, () => {});
      },
    );
    return () => {
      unsubscribe();
      timerSet.forEach(clearTimeout);
      timerSet.clear();
    };
  }, []);

  return state;
}
