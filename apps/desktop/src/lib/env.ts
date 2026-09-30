/*
 * 実行環境。main.tsx でモックを入れる前に判定して保持する
 * (mockIPC が window.__TAURI_INTERNALS__ を作るため、後から判定すると常に Tauri 内に見える)。
 */
export type WindowKind = "panel" | "settings" | "setup";

export const env = {
  /** 本物の Tauri WebView 内で動いているか */
  inTauri: false,
  /** ブラウザでモック表示中か。true の時はウィンドウ枠・信号機を描いてデザインと同じ見た目にする */
  browserFrame: false,
};

export function isWindowKind(label: string): label is WindowKind {
  return label === "panel" || label === "settings" || label === "setup";
}

/**
 * 開発用モックからの指定 (本番では常に既定値)。
 * holdResults: 確定結果・エラーの表示を時間経過で消さない (静止状態を確認・撮影するため)
 */
export const devOverrides: { holdResults: boolean; setupStep: number | null } = {
  holdResults: false,
  // setup の初期ステップ (モックで各ステップを直接開くため)
  setupStep: null,
};
