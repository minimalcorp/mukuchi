"""無音・雑音由来の定型ハルシネーション除外 (tsunagi whisper-server のQwen経路から移植)。"""

import re

# YouTube字幕由来の典型的なハルシネーション。出力全体が(句読点・空白を除いて)これらと
# 完全一致する場合のみ除外する。部分一致にしないのは、ユーザーが実際にこれらの語を
# 含む文を話すケースを壊さないため。
HALLUCINATION_PHRASES = frozenset(
    {
        "ご視聴ありがとうございました",
        "ご視聴ありがとうございます",
        "最後までご視聴いただきありがとうございました",
        "最後までご視聴ありがとうございました",
        "チャンネル登録お願いします",
        "チャンネル登録をお願いします",
        "チャンネル登録よろしくお願いします",
        "次回もお楽しみに",
        "次回予告",
        "おやすみなさい",
    }
)
_NORMALIZE_RE = re.compile(r"[\s、。，．,.！!？?・…「」『』（）()\[\]〜~♪]+")


def is_hallucination_phrase(text: str) -> bool:
    return _NORMALIZE_RE.sub("", text) in HALLUCINATION_PHRASES
