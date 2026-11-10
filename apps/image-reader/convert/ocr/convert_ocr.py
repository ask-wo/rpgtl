"""Downloads PP-OCR models and converts them to ONNX: `python convert_ocr.py <output folder> <models...>`.

`general` writes the detector and the recognizer for Chinese, Japanese and English into the folder, and `korean`
writes the Korean recognizer into its `korean` folder."""
import json
import os
from pathlib import Path
import subprocess
import sys

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

import yaml
from paddlex.inference.utils.official_models import official_models

DETECTION = "PP-OCRv6_medium_det"
RECOGNITION = "PP-OCRv6_medium_rec"
KOREAN_RECOGNITION = "korean_PP-OCRv5_mobile_rec"
PADDLE2ONNX = Path(sys.executable).parent / "paddle2onnx"


def part(name):
    """Tells RPGTL, which runs this, the part of converting the models that starts now."""
    print(f"@rpgtl part {name}", flush=True)


def convert(name, target):
    source = Path(official_models[name])
    subprocess.run([
        str(PADDLE2ONNX), "--model_dir", str(source), "--model_filename", "inference.json",
        "--params_filename", "inference.pdiparams", "--save_file", str(target), "--opset_version", "17",
        # Its default optimizer tries to pip-install packages while converting, and changes nothing here.
        "--optimize_tool", "None",
    ], check=True)
    return source


def convert_recognizer(name, folder):
    folder.mkdir(parents=True, exist_ok=True)
    source = convert(name, folder / "ocr_rec.onnx")
    config = yaml.safe_load((source / "inference.yml").read_text(encoding="utf-8"))
    characters = config["PostProcess"]["character_dict"]
    (folder / "ocr_characters.json").write_text(json.dumps(characters, ensure_ascii=False), encoding="utf-8")


def main(output, models):
    output.mkdir(parents=True, exist_ok=True)
    if "general" in models:
        part("textDetection")
        convert(DETECTION, output / "ocr_det.onnx")
        part("textRecognition")
        convert_recognizer(RECOGNITION, output)
    if "korean" in models:
        part("koreanRecognition")
        convert_recognizer(KOREAN_RECOGNITION, output / "korean")


if __name__ == "__main__":
    output, *models = sys.argv[1:]
    unknown = set(models) - {"general", "korean"}
    if not models or unknown:
        sys.exit(f"Name the models to convert: general, korean (got {' '.join(models) or 'none'})")
    main(Path(output), models)
