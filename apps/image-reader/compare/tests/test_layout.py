import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from compare import groups, match, text_area, without_icons  # noqa: E402
from drawing import draw_variant, room  # noqa: E402

FONT = Path(subprocess.check_output(["fc-match", "Noto Sans:bold", "--format", "%{file}"], text=True).strip())


def line(text, box):
    return {"text": text, "box": box, "score": 1.0, "area": box, "lineHeight": box[3] - box[1]}


def test_same_text_pairs_even_when_boxes_barely_overlap():
    paddle = [line("·对话", [63, 291, 135, 320]), line("·休息", [62, 541, 136, 575])]
    qwen = [line("·休息", [96, 553, 182, 580]), line("·对话", [96, 295, 182, 323])]
    rows = match(paddle, qwen, "relative-1000")
    assert [(row["paddle"]["text"], row["qwen"]["text"], row["agree"]) for row in rows] == [
        ("·对话", "·对话", True), ("·休息", "·休息", True)]


def test_repeated_text_pairs_with_the_nearest_box():
    paddle = [line("致谢", [5, 0, 66, 31]), line("致谢", [6, 27, 66, 60])]
    qwen = [line("致谢", [0, 25, 17, 45]), line("致谢", [0, 2, 33, 23])]
    rows = match(paddle, qwen, "relative-1000")
    assert [row["qwen"]["box"] for row in rows] == [[0, 2, 33, 23], [0, 25, 17, 45]]


def test_leading_icon_stays_out_of_the_text_area():
    image = Image.new("RGB", (300, 25), "black")
    draw = ImageDraw.Draw(image)
    draw.polygon([(2, 20), (11, 3), (20, 20)], outline="white", width=2)
    for index in range(8):
        draw.rectangle([32 + 24 * index, 2, 32 + 24 * index + 22, 22], fill="white")
    x0 = text_area(line("△ 代表攻击力会上升", [0, 0, 226, 25]), image)[0]
    assert 20 < x0 < 32
    plain = line("代表防御力会下降", [32, 0, 226, 25])
    assert text_area(plain, image) == plain["box"]
    assert text_area(line("2024年", [0, 0, 100, 20]), image) == [0, 0, 100, 20]


def test_paragraphs_rows_and_button_states_group():
    paragraph = [line("第一行", [60, 100, 400, 124]), line("第二行很长", [60, 140, 600, 165]),
                 line("别处", [900, 400, 1000, 424])]
    assert sorted(map(sorted, groups(paragraph, same_text=False))) == [[0, 1], [2]]
    states = [line("开始", [5, 0, 66, 30]), line("开始", [5, 30, 66, 60])]
    assert len(groups(states, same_text=False)) == 2
    assert len(groups(states, same_text=True)) == 1


def test_room_stops_at_edges_neighbours_and_the_image_border():
    image = Image.new("RGB", (400, 100), "white")
    ImageDraw.Draw(image).rectangle([300, 0, 399, 99], fill="black")
    x0, _, x1, _ = room(image, [50, 40, 100, 60], [[200, 40, 250, 60]])
    assert x0 == 0 + 6 and x1 == 150 - 6
    x0, _, x1, _ = room(image, [50, 40, 100, 60], [])
    assert x1 < 300


def test_lines_in_one_group_share_a_size_except_much_longer_ones():
    image = Image.new("RGB", (600, 100), (40, 40, 40))
    style = {"fill": [255, 255, 255], "outline": None, "stroke": 0}
    lines = [{**line("核心", box), "area": box, "style": style, "translation": text}
             for box, text in (([20, 20, 80, 50], "Wood"), ([120, 20, 180, 50], "Iron"),
                               ([220, 20, 280, 50], "Rope"), ([320, 20, 380, 50], "Harbour Lantern Oil"))]
    draw_variant(image, lines, FONT, lines, [[0, 1, 2, 3]])
    sizes = [next(iter(item["drawing"].values()))["size"] for item in lines]
    assert sizes[0] == sizes[1] == sizes[2] > sizes[3]


def test_copied_icons_are_dropped_from_translations():
    assert without_icons("△ Marks a helpful effect") == "Marks a helpful effect"
    assert without_icons("∇: Negative effect") == "Negative effect"
    assert without_icons("Ψ Marks a change") == "Marks a change"
    assert without_icons('"Quoted" title') == '"Quoted" title'


def test_room_stays_out_of_an_overlapping_button_state():
    image = Image.new("RGBA", (130, 60), (0, 0, 0, 0))
    _, top, _, bottom = room(image, [5, 0, 66, 31], [[6, 27, 66, 60]])
    assert top == 0 and bottom == 29
    _, top, _, _ = room(image, [6, 27, 66, 60], [[5, 0, 66, 31]])
    assert top == 29
