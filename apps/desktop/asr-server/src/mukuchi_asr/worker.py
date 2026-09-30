"""MLX推論専用の単一スレッド。

MLX (>=0.31) の配列・ストリームは生成したスレッドに束縛されるため、モデル読み込み・ウォームアップ・
全推論を同じ1本のスレッドで行う必要がある (別スレッドで推論すると
`RuntimeError: There is no Stream(gpu, 0) in current thread`)。
ワーカーが1本なので推論は自然に直列化される。
"""

import asyncio
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import numpy as np

# (audio, language, context) -> text
Transcriber = Callable[[np.ndarray, str, str], str]


class InferenceWorker:
    def __init__(self, loader: Callable[[], Transcriber]):
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx-asr")
        self._loader = loader
        self._transcriber: Transcriber | None = None

    def load(self) -> None:
        """ワーカースレッド上で loader を実行し、完了まで待つ (モデル読み込み+ウォームアップ)。"""
        self._transcriber = self._executor.submit(self._loader).result()

    async def transcribe(self, audio: np.ndarray, language: str, context: str) -> str:
        if self._transcriber is None:
            raise RuntimeError("model is not loaded")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._transcriber, audio, language, context)
