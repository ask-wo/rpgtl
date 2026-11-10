import os
from pathlib import Path

MODEL_ROOT = Path(os.environ["IMAGE_TEXT_MODELS"])
DETECTION = MODEL_ROOT / "ocr_det.onnx"
LAMA = MODEL_ROOT / "lama.onnx"
# The general recognizer reads Chinese, Japanese and English; Korean needs its own, which is installed only when a
# Korean game's images are read.
RECOGNIZERS = {"general": MODEL_ROOT, "korean": MODEL_ROOT / "korean"}
RECOGNIZER_NAMES = {"general": "PP-OCRv6_medium_rec", "korean": "korean_PP-OCRv5_mobile_rec"}


def recognizer_files(recognizer):
    folder = RECOGNIZERS[recognizer]
    return folder / "ocr_rec.onnx", folder / "ocr_characters.json"


def installed(recognizer):
    return all(path.is_file() for path in recognizer_files(recognizer))


def missing_models():
    return [path for path in (DETECTION, *recognizer_files("general"), LAMA) if not path.is_file()]
