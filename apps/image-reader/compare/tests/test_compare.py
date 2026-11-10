import json
from pathlib import Path
import shutil
import subprocess
import sys

import httpx
from PIL import Image
import pytest

COMPARE = Path(__file__).resolve().parents[1] / "compare.py"
FIXTURES = COMPARE.parents[1] / "tests/fixtures"
MODEL = "qwen3.6:35b-a3b-q4_K_M"


@pytest.fixture(scope="session", autouse=True)
def service():
    try:
        response = httpx.get("http://127.0.0.1:5001/health", timeout=5)
        response.raise_for_status()
    except httpx.HTTPError:
        pytest.skip("Start the reader: see docs/testing.md (Image reader)")


@pytest.fixture
def game(tmp_path):
    root = tmp_path / "game"
    (root / "data").mkdir(parents=True)
    (root / "img/pictures").mkdir(parents=True)
    (root / "fonts").mkdir()
    key = bytes.fromhex("00112233445566778899aabbccddeeff")
    (root / "data/System.json").write_text(json.dumps({"encryptionKey": key.hex()}), encoding="utf-8-sig")
    for name in ("menu.png", "logo.png"):
        shutil.copyfile(FIXTURES / name, root / "img/pictures" / name)
    data = (FIXTURES / "menu.png").read_bytes()

    def encrypted(data, name):
        header = b"RPGMV" + bytes(11)
        encoded = bytes(value ^ key[index] for index, value in enumerate(data[:16])) + data[16:]
        (root / "img/pictures" / name).write_bytes(header + encoded)

    encrypted(data, "menu-png.rpgmvp")
    jpeg = tmp_path / "menu.jpg"
    Image.open(FIXTURES / "menu.png").save(jpeg, quality=95)
    encrypted(jpeg.read_bytes(), "menu-jpg.rpgmvp")
    font = subprocess.check_output(["fc-match", "Noto Sans:bold", "--format", "%{file}"], text=True).strip()
    shutil.copyfile(font, root / "fonts/font.ttf")
    (root / "fonts/gamefont.css").write_text("@font-face { font-family: GameFont; src: url('font.ttf'); }")
    return root / "img/pictures"


def run(out, images, *options):
    result = subprocess.run([sys.executable, str(COMPARE), "--out", str(out), *options, *map(str, images)],
                            capture_output=True, text=True, timeout=1500)
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads((out / "report.json").read_text())


def test_encrypted_images_read_like_plain_ones(game, tmp_path):
    report = run(tmp_path / "report", [game / name for name in
                 ("menu.png", "menu-png.rpgmvp", "menu-jpg.rpgmvp")], "--readers", "paddle")
    boxes = []
    for image in report["images"]:
        lines = image["paddle"]["reads"]["128,128,128"]["lines"]
        confident = {line["text"]: line for line in lines if line["score"] >= 0.5}
        assert sorted(confident) == ["开始游戏", "退出"]
        boxes.append({text: line["box"] for text, line in confident.items()})
    assert boxes[0] == boxes[1]


def test_text_colour_and_outline_are_found(game, tmp_path):
    out = tmp_path / "report"
    run(out, [game / "menu.png"], "--readers", "paddle")
    report = run(out, [game / "menu.png"], "--readers", "paddle", "--redo", "draw")
    styles = {row["paddle"]["text"]: row["paddle"]["style"] for row in report["images"][0]["rows"]}
    start, exit_line = styles["开始游戏"], styles["退出"]
    assert all(abs(value - 255) <= 40 for value in start["fill"])
    assert start["outline"] is not None
    assert all(abs(value) <= 45 for value in start["outline"])
    assert start["stroke"] >= 1
    assert all(abs(value - expected) <= 40 for value, expected in zip(exit_line["fill"], (80, 52, 36), strict=True))
    assert exit_line["outline"] is None


def test_qwen_calibration(game, tmp_path):
    try:
        response = httpx.get("http://127.0.0.1:11434/api/tags", timeout=5)
        response.raise_for_status()
        if MODEL not in [item["name"] for item in response.json()["models"]]:
            pytest.skip(f"Ollama needs {MODEL}")
    except httpx.HTTPError:
        pytest.skip("Start Ollama for the Qwen calibration check")
    report = run(tmp_path / "report", [game / "menu.png", game / "logo.png"], "--readers", "paddle,qwen")
    calibration = report["calibration"]
    assert calibration["coordinates"] is not None, calibration
    assert all(line["iou"] >= 0.5 for line in calibration["scores"][calibration["coordinates"]])
    assert [image["counts"]["agree"] for image in report["images"]] == [2, 1]
    assert all(image["counts"]["differ"] == image["counts"]["only_paddle"] == image["counts"]["only_qwen"] == 0
               for image in report["images"])
