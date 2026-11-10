import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lettering import alignments, colours, describe, kept_prefix, line_areas  # noqa: E402

FONT = ImageFont.load_default(size=14)


def test_small_outlined_lettering_keeps_its_fill_and_outline():
    background = Image.new('RGB', (60, 24), (128, 128, 128))
    original = background.copy()
    ImageDraw.Draw(original).text(
        (4, 4), 'Items', fill=(120, 200, 110), font=FONT, stroke_width=1, stroke_fill=(20, 15, 10),
    )
    style = colours(original, background, [(0, 0, 60, 24)])
    assert style['outline'] is not None
    assert sum(style['outline']) < 150
    assert style['fill'][1] > 150


def test_plain_dark_lettering_gets_no_outline_from_its_blended_edge():
    background = Image.new('RGB', (60, 24), (240, 225, 200))
    original = background.copy()
    ImageDraw.Draw(original).text((4, 4), 'Items', fill=(26, 4, 0), font=FONT)
    style = colours(original, background, [(0, 0, 60, 24)])
    assert style['outline'] is None
    assert sum(style['fill']) < 150


def test_thin_dark_lettering_keeps_its_colour_not_its_blended_edge():
    # Drawn at twice the size and scaled down, so its strokes are as soft as a phone screen's text.
    font = ImageFont.load_default(size=36)
    for bubble in [(255, 255, 255), (175, 224, 118)]:
        background = Image.new('RGB', (200, 30), bubble)
        large = Image.new('RGB', (400, 60), bubble)
        ImageDraw.Draw(large).text((8, 8), 'Is that you? Over by the well?', fill=(0, 0, 0), font=font)
        original = large.resize((200, 30), Image.Resampling.BOX)
        style = colours(original, background, [(0, 0, 200, 30)])
        assert style['outline'] is None
        assert max(style['fill']) < 40, bubble


def test_thick_lettering_keeps_a_fill_between_its_outline_and_the_background():
    background = Image.new('RGB', (120, 40), (255, 235, 235))
    original = background.copy()
    ImageDraw.Draw(original).text(
        (4, 4), 'Alarm', fill=(162, 106, 96), font=ImageFont.load_default(size=28), stroke_width=2,
        stroke_fill=(100, 20, 0),
    )
    style = colours(original, background, [(0, 0, 120, 40)])
    assert style['fill'][0] > 120 and style['fill'][1] > 50


def test_see_through_pixels_the_eraser_painted_over_are_not_lettering():
    original = Image.new('RGBA', (60, 24))
    ImageDraw.Draw(original).text(
        (4, 4), 'Items', fill=(250, 220, 160, 255), font=FONT, stroke_width=1, stroke_fill=(30, 3, 2, 255),
    )
    erased = Image.new('RGBA', (60, 24), (60, 140, 200, 255))
    style = colours(original, erased, [(0, 0, 60, 24)])
    assert style['fill'][0] > 200 and style['fill'][2] > 120
    assert style['outline'] is not None and sum(style['outline']) < 150


def test_lettering_like_its_background_gets_a_contrasting_outline():
    background = Image.new('RGB', (60, 24), (200, 200, 200))
    original = background.copy()
    ImageDraw.Draw(original).text((4, 4), 'Items', fill=(255, 255, 255), font=FONT)
    style = colours(original, background, [(0, 0, 60, 24)])
    assert style['outline'] == [0, 0, 0]


def described(lines):
    original = Image.new('RGB', (200, 200), (128, 128, 128))
    draw = ImageDraw.Draw(original)
    for line in lines:
        draw.polygon([tuple(point) for point in line['polygon']], fill=(250, 250, 250))
    erased = Image.new('RGB', original.size, (128, 128, 128))
    blocks = [[index] for index in range(len(lines))]
    return describe(original, erased, lines, blocks, line_areas(lines, range(len(lines)), original))


def line(text, polygon):
    xs, ys = [x for x, _ in polygon], [y for _, y in polygon]
    return {'text': text, 'polygon': polygon, 'box': [min(xs), min(ys), max(xs), max(ys)]}


def test_tilted_and_vertical_lines_are_described_in_their_own_frame():
    # 80 by 20 tilted 30 degrees up to the right about (60, 50); a column 20 wide and 120 tall; a level line.
    tilted = line('倾斜文字', [[20, 61], [90, 21], [100, 39], [30, 79]])
    column = line('竖排文字', [[150, 20], [170, 20], [170, 140], [150, 140]])
    level = line('水平文字', [[20, 160], [100, 161], [100, 181], [20, 180]])
    tilted_block, column_block, level_block = described([tilted, column, level])
    assert abs(tilted_block['angle'] + 30) < 1
    assert all(abs(value - expected) <= 1.5 for value, expected in zip(tilted_block['area'], [20, 40, 100, 60]))
    assert abs(tilted_block['lineHeight'] - 20) <= 1
    assert column_block['angle'] == 90
    assert column_block['area'] == [100, 70, 220, 90] and column_block['lineHeight'] == 20
    for block in (tilted_block, column_block):
        assert block['space'] == block['area'] and block['align'] == 'centre'
    assert 'angle' not in level_block and level_block['lineHeight'] == 21


def glyphs(count):
    """Characters like 田 side by side, white on black, each 40 px square with 5 px strokes."""
    mask = Image.new('L', (44 * count, 44))
    draw = ImageDraw.Draw(mask)
    for index in range(count):
        x = 2 + 44 * index
        draw.rectangle((x, 2, x + 40, 42), outline=255, width=5)
        draw.rectangle((x + 18, 2, x + 22, 42), fill=255)
        draw.rectangle((x, 20, x + 40, 24), fill=255)
    return mask


def drawn_line(mask, text):
    original = Image.new('RGB', (200, 200), (60, 60, 70))
    original.paste((250, 250, 250), (20, 20), mask)
    x0, y0, x1, y1 = mask.getbbox()
    box = [x0 + 16, y0 + 16, x1 + 24, y1 + 24]
    line = {'text': text, 'box': box,
            'polygon': [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]}
    erased = Image.new('RGB', original.size, (60, 60, 70))
    return describe(original, erased, [line], [[0]], line_areas([line], [0], original))[0]


def test_a_slanted_word_in_a_level_box_is_turned_by_how_its_strokes_lean():
    # Turned 35 degrees counter-clockwise, two characters fill a box about as tall as wide.
    block = drawn_line(glyphs(2).rotate(35, expand=True, resample=Image.BICUBIC), '田田')
    assert abs(block['angle'] + 35) <= 3
    x0, y0, x1, y1 = block['area']
    assert x1 - x0 > 80 and 40 <= y1 - y0 <= 60 and abs(block['lineHeight'] - (y1 - y0)) < 0.2


def test_level_words_stay_level_in_level_boxes_wide_or_narrow():
    assert 'angle' not in drawn_line(glyphs(2), '田田')
    # Three characters' text in a box for two: too narrow to be level, but the strokes don't lean.
    assert 'angle' not in drawn_line(glyphs(2), '田田田')


def test_a_column_whose_lines_end_apart_is_left_aligned_though_the_reader_moves_its_starts():
    def block(x0, x1, y):
        return {'area': [x0, y, x1, y + 20], 'lineHeight': 20}
    column = [block(92, 330, 0), block(90, 322, 100), block(87, 322, 200), block(86, 324, 300)]
    assert alignments(column) == ['left'] * 4
    buttons = [block(50, 150, 0), block(55, 145, 40)]
    assert alignments(buttons) == ['centre'] * 2


def test_an_icon_before_kana_or_hangul_stays_but_a_short_word_in_them_is_text():
    assert kept_prefix('★スタート') == '★'
    assert kept_prefix('はい') == ''
    assert kept_prefix('ﾊｲ') == ''
    assert kept_prefix('예') == ''
