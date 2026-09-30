import pytest

from mukuchi_asr.filters import is_hallucination_phrase


@pytest.mark.parametrize(
    "text",
    ["ご視聴ありがとうございました", "ご視聴ありがとうございました。", " おやすみなさい！ ", "「次回予告」…"],
)
def test_exact_phrases_are_dropped(text):
    assert is_hallucination_phrase(text)


@pytest.mark.parametrize(
    "text",
    ["", "了解です。", "今日はご視聴ありがとうございました、と言って配信を終えた", "おやすみなさいませ"],
)
def test_other_text_is_kept(text):
    assert not is_hallucination_phrase(text)
