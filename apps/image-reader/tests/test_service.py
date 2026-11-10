import base64
from io import BytesIO
import json
import os
from pathlib import Path

import httpx
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import pytest

FIXTURES = Path(__file__).parent / 'fixtures'
DRAWN = json.loads((FIXTURES / 'fixtures.json').read_text())
EVIDENCE = Path(__file__).resolve().parents[3] / '.verify' / 'image-text'


@pytest.fixture(scope='session')
def client():
    with httpx.Client(base_url=os.environ.get('RPGTL_IMAGE_TEXT_ENDPOINT', 'http://127.0.0.1:5001'), timeout=300) as session:
        try:
            response = session.get('/health')
        except httpx.TransportError:
            pytest.skip(
                'Start the reader: see docs/testing.md (Image reader)'
            )
        response.raise_for_status()
        yield session


def read(client, data):
    response = client.post('/read', content=data, headers={'Content-Type': 'image/png'})
    response.raise_for_status()
    return response.json()


def erase(client, name, lines):
    response = client.post('/erase', json={
        'image': base64.b64encode((FIXTURES / name).read_bytes()).decode(),
        'areas': [line['polygon'] for line in lines],
    })
    response.raise_for_status()
    assert response.headers['content-type'] == 'image/png'
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / name.replace('.png', '-erased.png')).write_bytes(response.content)
    return response.content, Image.open(BytesIO(response.content))


def farther_than_six(size, lines):
    mask = Image.new('L', size)
    draw = ImageDraw.Draw(mask)
    for line in lines:
        draw.polygon([tuple(point) for point in line['polygon']], fill=255)
    original = np.asarray(mask) > 0
    grown = original.copy()
    padded = np.pad(original, 6)
    height, width = original.shape
    for dy in range(-6, 7):
        for dx in range(-6, 7):
            if dx * dx + dy * dy <= 36:
                grown |= padded[6 + dy:6 + dy + height, 6 + dx:6 + dx + width]
    return ~grown


def test_measures_contrast_for_cached_polygons(client):
    image = Image.new('RGB', (100, 40), (30, 30, 30))
    ImageDraw.Draw(image).rectangle((20, 10, 70, 30), fill=(37, 37, 37))
    data = BytesIO()
    image.save(data, format='PNG')
    response = client.post('/contrast', json={
        'image': base64.b64encode(data.getvalue()).decode(),
        'areas': [[[0, 0], [99, 0], [99, 39], [0, 39]]],
    })
    response.raise_for_status()
    assert response.json() == {'contrasts': [7]}
    response = client.post('/contrast', json={
        'image': base64.b64encode(data.getvalue()).decode(), 'areas': [[[0, 0]]],
    })
    assert response.status_code == 400


def test_reads_both_menu_lines(client):
    result = read(client, (FIXTURES / 'menu.png').read_bytes())
    assert (result['width'], result['height']) == (816, 312)
    lines = [line for line in result['lines'] if line['score'] >= 0.5]
    assert sorted(line['text'] for line in lines) == ['开始游戏', '退出']
    for drawn in DRAWN['menu.png']:
        line = next(line for line in lines if line['text'] == drawn['text'])
        x0, y0, x1, y1 = drawn['box']
        bx0, by0, bx1, by1 = line['box']
        assert all(type(v) is int for v in line['box'])
        assert all(type(v) is int for point in line['polygon'] for v in point)
        assert line['contrast'] >= 12
        slack = (y1 - y0) / 4
        assert x0 - slack <= bx0 < bx1 <= x1 + slack
        assert y0 - slack <= by0 < by1 <= y1 + slack
        covered = max(0, min(x1, bx1) - max(x0, bx0)) * max(0, min(y1, by1) - max(y0, by0))
        assert covered >= 0.8 * (x1 - x0) * (y1 - y0)


def test_reads_korean_with_its_own_recognizer(client):
    if 'korean' not in client.get('/health').json()['ocr']['recognizers']:
        pytest.skip('The reader has no Korean recognizer: convert it with `convert_ocr.py <models> korean`')
    data = (FIXTURES / 'menu-korean.png').read_bytes()
    response = client.post('/read?language=korean', content=data)
    response.raise_for_status()
    lines = [line for line in response.json()['lines'] if line['score'] >= 0.5]
    # It sometimes leaves out the space between words.
    unspaced = lambda texts: sorted(text.replace(' ', '') for text in texts)
    assert unspaced(line['text'] for line in lines) == unspaced(drawn['text'] for drawn in DRAWN['menu-korean.png'])
    general = [line['text'] for line in read(client, data)['lines']]
    assert '불러오기' not in general


def test_erasing_rebuilds_background_and_leaves_rest(client):
    original = Image.open(FIXTURES / 'menu.png')
    lines = read(client, (FIXTURES / 'menu.png').read_bytes())['lines']
    data, erased = erase(client, 'menu.png', lines)
    assert (erased.size, erased.mode) == (original.size, original.mode)
    before, after = np.asarray(original), np.asarray(erased)
    outside = farther_than_six(original.size, lines)
    assert np.array_equal(before[outside], after[outside])
    clean = np.asarray(Image.open(FIXTURES / 'menu-clean.png')).astype(float)
    for drawn in DRAWN['menu.png']:
        x0, y0, x1, y1 = drawn['box']
        selection = np.s_[y0:y1, x0:x1]
        old_error = np.abs(before[selection].astype(float) - clean[selection]).mean()
        new_error = np.abs(after[selection].astype(float) - clean[selection]).mean()
        assert new_error < old_error * 0.25, (drawn['text'], old_error, new_error)
    assert not [line for line in read(client, data)['lines'] if line['score'] >= 0.5]


def test_erasing_transparent_logo(client):
    original = Image.open(FIXTURES / 'logo.png')
    lines = read(client, (FIXTURES / 'logo.png').read_bytes())['lines']
    assert [line['text'] for line in lines] == ['星光物语']
    _, erased = erase(client, 'logo.png', lines)
    assert erased.size == original.size
    assert erased.mode == 'RGBA'
    before, after = np.asarray(original), np.asarray(erased)
    x0, y0, x1, y1 = DRAWN['logo.png'][0]['box']
    assert after[y0:y1, x0:x1, 3].mean() < 16
    outside = farther_than_six(original.size, lines)
    assert np.array_equal(before[outside], after[outside])


def test_erasing_text_on_an_opaque_button_keeps_it_opaque(client):
    button = Image.new('RGBA', (120, 40))
    ImageDraw.Draw(button).rounded_rectangle((0, 0, 119, 39), radius=12, fill=(90, 50, 30, 255))
    ImageDraw.Draw(button).text((30, 12), 'TEXT', fill=(250, 230, 200, 255))
    image = BytesIO()
    button.save(image, format='PNG')
    response = client.post('/erase', json={
        'image': base64.b64encode(image.getvalue()).decode(),
        'areas': [[[24, 8], [96, 8], [96, 32], [24, 32]]],
    })
    response.raise_for_status()
    erased = np.asarray(Image.open(BytesIO(response.content)))
    assert erased[8:32, 24:96, 3].min() == 255


def test_prepare_keeps_a_round_icon_round_where_its_text_reaches_the_corner(client):
    # A round icon as wide as its image, with outlined letters across its lower part that reach past the circle
    # to the image's left and bottom edges.
    size = 51
    ys, xs = np.mgrid[:size, :size]
    distance = np.hypot(xs - 25, ys - 25)
    shade = np.clip(distance / 30, 0, 1)[..., None]
    icon = np.zeros((size, size, 4), np.uint8)
    icon[..., :3] = ((1 - shade) * [200, 150, 60] + shade * [90, 40, 20]).astype(np.uint8)
    icon[..., 3] = (np.clip(25.5 - distance, 0, 1) * 255).astype(np.uint8)
    original = Image.fromarray(icon)
    ImageDraw.Draw(original).text((0, 31), 'ITEM', fill=(170, 235, 150, 255), font_size=19, stroke_width=1,
                                   stroke_fill=(40, 30, 20, 255))
    image = BytesIO()
    original.save(image, format='PNG')
    response = client.post('/prepare', json={
        'image': base64.b64encode(image.getvalue()).decode(),
        'lines': [{'text': 'ITEM', 'box': [0, 30, 46, 51], 'polygon': [[0, 30], [46, 30], [46, 51], [0, 51]]}],
        'blocks': [[0]],
    })
    response.raise_for_status()
    erased = np.asarray(Image.open(BytesIO(base64.b64decode(response.json()['erased']))).convert('RGBA'))
    assert erased[distance > 26.5, 3].max() < 16
    assert erased[distance < 23.5, 3].min() == 255


def test_bad_input_is_refused(client):
    jpeg = BytesIO()
    Image.new('RGB', (16, 16)).save(jpeg, format='GIF')
    response = client.post('/read', content=jpeg.getvalue(), headers={'Content-Type': 'image/png'})
    assert response.status_code == 400
    assert response.json()['error']
    response = client.post('/erase', json={
        'image': base64.b64encode((FIXTURES / 'menu.png').read_bytes()).decode(),
        'areas': [[[0, 0], [10, 10]]],
    })
    assert response.status_code == 400
    assert response.json()['error']
    assert client.get('/health').status_code == 200


def test_background_colour_for_transparent_images(client):
    data = (FIXTURES / 'logo.png').read_bytes()
    response = client.post('/read?background=255,255,255', content=data)
    response.raise_for_status()
    lines = [line for line in response.json()['lines'] if line['score'] >= 0.5]
    assert [line['text'] for line in lines] == ['星光物语']
    response = client.post('/read?background=red', content=data)
    assert response.status_code == 400
    assert response.json()['error']


def test_jpeg_crops_and_flatten(client):
    data = (FIXTURES / 'menu.png').read_bytes()
    jpeg = BytesIO()
    Image.open(BytesIO(data)).convert('RGB').save(jpeg, format='JPEG')
    result = read(client, jpeg.getvalue())
    assert sorted(line['text'] for line in result['lines'] if line['score'] >= 0.5) == ['开始游戏', '退出']
    full = next(line for line in read(client, data)['lines'] if line['text'] == '开始游戏')
    x0, y0, x1, y1 = full['box']
    crop = f"{x0-32},{y0-32},{x1+32},{y1+32}"
    response = client.post(f'/read?crop={crop}&scale=2', content=data)
    response.raise_for_status()
    cropped = response.json()
    assert (cropped['width'], cropped['height']) == (816, 312)
    line = next(line for line in cropped['lines'] if line['text'] == '开始游戏')
    # Paddle's box padding differs a little at 2x; the mapping itself is exact at scale 1.
    assert all(abs(a-b) <= 8 for a, b in zip(line['box'], full['box'], strict=True))
    response = client.post('/flatten', content=(FIXTURES / 'logo.png').read_bytes())
    response.raise_for_status()
    flattened = Image.open(BytesIO(response.content))
    assert flattened.format == 'PNG'
    assert flattened.mode == 'RGB'
    assert flattened.size == Image.open(FIXTURES / 'logo.png').size
    response = client.post('/flatten?crop=10,10,42,26&mark=20,14,30,22', content=(FIXTURES / 'logo.png').read_bytes())
    response.raise_for_status()
    spot = np.asarray(Image.open(BytesIO(response.content)))
    assert spot.shape == (128, 256, 3)
    # The mark's outline, 2 pixels out from (20, 14), enlarged 8 times.
    assert tuple(spot[(14 - 10 - 2) * 8, (25 - 10) * 8]) == (255, 0, 0)


def prepare(client, name, blocks):
    original = (FIXTURES / name).read_bytes()
    lines = sorted((line for line in read(client, original)['lines'] if line['score'] >= 0.5), key=lambda line: line['box'][1])
    response = client.post('/prepare', json={
        'image': base64.b64encode(original).decode(), 'lines': lines, 'blocks': blocks,
    })
    response.raise_for_status()
    result = response.json()
    erased = Image.open(BytesIO(base64.b64decode(result['erased'])))
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    erased.save(EVIDENCE / name.replace('.png', '-prepared.png'))
    return lines, result['blocks'], np.asarray(Image.open(FIXTURES / name)), np.asarray(erased)


def near(colour, expected, tolerance):
    return all(abs(int(colour[i:i + 2], 16) - expected[index]) <= tolerance for index, i in enumerate((1, 3, 5)))


def test_prepare_erases_and_describes_the_lettering(client):
    lines, blocks, before, after = prepare(client, 'menu.png', [[0], [1]])
    assert [line['text'] for line in lines] == ['开始游戏', '退出']
    start, quit_ = blocks
    assert near(start['fill'], (255, 255, 255), 40)
    assert near(start['outline'], (0, 0, 0), 45)
    assert start['stroke'] >= 1 and start['bold'] is True
    assert near(quit_['fill'], (0x50, 0x34, 0x24), 40)
    assert quit_['outline'] is None and quit_['bold'] is True
    for block in blocks:
        x0, y0, x1, y1 = block['area']
        sx0, sy0, sx1, sy1 = block['space']
        assert sx0 <= x0 and sy0 <= y0 and sx1 >= x1 and sy1 >= y1
    halfway = (lines[0]['box'][3] + blocks[1]['area'][1]) // 2
    assert quit_['space'][1] >= halfway and start['space'][3] <= (lines[0]['box'][3] + lines[1]['box'][1]) // 2 + 1
    outside = farther_than_six(before.shape[1::-1], lines)
    assert np.array_equal(before[outside], after[outside])
    assert not np.array_equal(before, after)

    lines, blocks, before, after = prepare(client, 'weights.png', [[0], [1]])
    assert [block['bold'] for block in blocks] == [False, True]
    assert blocks[0]['group'] == 0 and blocks[1]['group'] == 0

    lines, blocks, before, after = prepare(client, 'menu.png', [[1]])
    x0, y0, x1, y1 = lines[0]['box']
    assert len(blocks) == 1 and blocks[0]['area'][1] > y1
    assert np.array_equal(before[y0:y1, x0:x1], after[y0:y1, x0:x1])
    assert not np.array_equal(before, after)



def test_unload_frees_the_models_until_the_next_request(client):
    read(client, (FIXTURES / 'menu.png').read_bytes())
    assert client.get('/health').json()['loaded'] is True
    client.post('/unload').raise_for_status()
    assert client.get('/health').json()['loaded'] is False
    result = read(client, (FIXTURES / 'menu.png').read_bytes())
    assert sorted(line['text'] for line in result['lines'] if line['score'] >= 0.5) == ['开始游戏', '退出']
    assert client.get('/health').json()['loaded'] is True



def test_prepare_keeps_the_band_behind_the_text_and_the_dots_after_it_go(client):
    rng = np.random.default_rng(1)
    artwork = rng.integers(150, 256, (80, 360, 3), dtype=np.uint8)
    artwork[20:60] = (artwork[20:60] * 0.3).astype(np.uint8)
    original = Image.fromarray(artwork)
    draw = ImageDraw.Draw(original)
    draw.text((20, 28), 'TIP: MIND THE TRAPS', fill=(255, 255, 255), font_size=20)
    for x in (280, 290, 300):
        draw.rectangle((x, 44, x + 2, 46), fill=(255, 255, 255))
    image = BytesIO()
    original.save(image, format='PNG')
    box = [18, 26, 276, 50]
    x0, y0, x1, y1 = box
    response = client.post('/prepare', json={
        'image': base64.b64encode(image.getvalue()).decode(),
        'lines': [{'text': 'TIP', 'box': box, 'polygon': [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]}],
        'blocks': [[0]],
    })
    response.raise_for_status()
    erased = np.asarray(Image.open(BytesIO(base64.b64decode(response.json()['erased']))).convert('RGB'))
    before = np.asarray(original)
    # Only the letters are erased: the band between them is left as it was, not repainted from the artwork.
    assert (erased[y0:y1, x0:x1] == before[y0:y1, x0:x1]).all(axis=2).mean() > 0.3
    assert erased[y0:y1, x0:x1].max(axis=2).mean() < 0.3 * 256
    for x in (280, 290, 300):
        assert erased[44:47, x:x + 3].max() < 200
    # The game copies the erased pixels back only inside the block's polygons, so they reach the dots too.
    xs = [x for polygon in response.json()['blocks'][0]['polygons'] for x, _ in polygon]
    assert max(xs) >= 303


def prepare_drawn(client, original, box):
    image = BytesIO()
    original.save(image, format='PNG')
    x0, y0, x1, y1 = box
    response = client.post('/prepare', json={
        'image': base64.b64encode(image.getvalue()).decode(),
        'lines': [{'text': 'TEXT', 'box': box, 'polygon': [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]}],
        'blocks': [[0]],
    })
    response.raise_for_status()
    return response.json(), np.asarray(Image.open(BytesIO(base64.b64decode(response.json()['erased']))).convert('RGB'))


def test_prepare_leaves_no_trace_of_letters_with_a_soft_glow(client):
    # Light letters with a dark outline and a soft dark glow fading into an even panel, as a status screen's
    # labels have.
    panel = (88, 58, 55)
    original = Image.new('RGB', (400, 200), panel)
    glow = Image.new('L', original.size)
    ImageDraw.Draw(glow).text((162, 89), 'LUCK', fill=255, font_size=22, stroke_width=3)
    glow = glow.filter(ImageFilter.GaussianBlur(2))
    original = Image.composite(Image.new('RGB', original.size, (35, 18, 10)), original,
                               glow.point(lambda value: value * 0.7))
    ImageDraw.Draw(original).text((162, 89), 'LUCK', fill=(250, 250, 245), font_size=22, stroke_width=1,
                                   stroke_fill=(110, 65, 30))
    _, erased = prepare_drawn(client, original, [160, 86, 240, 114])
    off = np.abs(erased.astype(int) - panel).max(axis=2)
    assert np.percentile(off, 99) < 16


def test_prepare_keeps_the_art_between_outlined_letters_on_a_small_icon(client):
    # A small icon whose text covers its lower part: shaded art, with light letters outlined in black over it.
    size = 64
    ys, xs = np.mgrid[:size, :size]
    shade = np.clip(np.hypot(xs - 20, ys - 20) / 60, 0, 1)[..., None]
    artwork = ((1 - shade) * [220, 170, 60] + shade * [70, 30, 110]).astype(np.uint8)
    original = Image.fromarray(artwork)
    ImageDraw.Draw(original).text((4, 40), 'GO ON', fill=(230, 240, 255), font_size=16, stroke_width=1,
                                   stroke_fill=(0, 0, 0))
    _, erased = prepare_drawn(client, original, [2, 38, 62, 60])
    before = np.asarray(original)
    letters = np.abs(before.astype(int) - artwork).max(axis=2) > 0
    kept = ~grown(letters, 3)
    kept[:38] = False
    # The art between and around the letters stays as it was, and none of the letters is left.
    assert (erased[kept] == before[kept]).all(axis=1).mean() > 0.9
    assert (np.abs(erased[letters].astype(int) - [230, 240, 255]).max(axis=1) < 40).mean() < 0.05


def test_prepare_keeps_a_mark_the_reader_took_into_the_line(client):
    artwork = np.full((40, 260, 3), (250, 230, 200), np.uint8)
    original = Image.fromarray(artwork)
    draw = ImageDraw.Draw(original)
    draw.ellipse((6, 10, 24, 28), fill=(120, 20, 60))
    draw.text((32, 10), 'MIND THE TRAPS', fill=(60, 30, 10), font_size=20)
    answer, erased = prepare_drawn(client, original, [4, 8, 230, 32])
    before = np.asarray(original)
    assert (erased[12:27, 8:23] == before[12:27, 8:23]).all()
    assert answer['blocks'][0]['area'][0] >= 24
    assert (np.abs(erased[8:32, 40:220].astype(int) - [250, 230, 200]).max(axis=2) < 40).mean() > 0.95


def grown(mask, reach):
    padded = np.pad(mask, reach)
    height, width = mask.shape
    return np.logical_or.reduce([padded[y:y + height, x:x + width]
                                 for y in range(2 * reach + 1) for x in range(2 * reach + 1)])


def test_prepare_fills_a_smooth_plate_with_its_own_colours(client):
    # A plate shaded from top to bottom with a darker frame, and outlined letters across it.
    height, width = 34, 160
    ys = np.arange(height)[:, None, None]
    plate = np.broadcast_to(np.clip([150, 70, 40] - np.abs(ys - 12) * [3, 2, 1], 0, 255), (height, width, 3))
    artwork = plate.astype(np.uint8).copy()
    artwork[:3], artwork[-3:], artwork[:, :3], artwork[:, -3:] = (60, 30, 20), (60, 30, 20), (60, 30, 20), (60, 30, 20)
    original = Image.fromarray(artwork)
    ImageDraw.Draw(original).text((24, 7), 'WAIT HERE', fill=(250, 230, 200), font_size=18, stroke_width=1,
                                   stroke_fill=(30, 10, 5))
    _, erased = prepare_drawn(client, original, [20, 5, 140, 29])
    before = np.asarray(original)
    letters = np.abs(before.astype(int) - artwork).max(axis=2) > 0
    # Each row of the plate gets its own shade back where the letters were.
    assert (np.abs(erased[letters].astype(int) - artwork[letters]).max(axis=1) <= 6).mean() > 0.95


def test_prepare_leaves_no_haze_between_see_through_text_and_a_bar_below_it(client):
    # A HUD's item name drawn on a see-through layer, ending a row above a rounded bar with a light rim.
    original = Image.new('RGBA', (200, 100))
    draw = ImageDraw.Draw(original)
    draw.rounded_rectangle((20, 56, 180, 86), radius=15, fill=(85, 45, 20, 255), outline=(250, 237, 227, 255),
                           width=2)
    left, top, right, bottom = draw.textbbox((0, 0), 'KEY ITEM', font_size=20, stroke_width=1)
    draw.text((55, 55 - bottom), 'KEY ITEM', fill=(251, 211, 121, 255), font_size=20, stroke_width=1,
              stroke_fill=(33, 3, 1, 255))
    answer, _ = prepare_drawn(client, original, [55 + left - 1, 55 - bottom + top - 1, 55 + right + 1, 56])
    erased = np.asarray(Image.open(BytesIO(base64.b64decode(answer['erased']))).convert('RGBA'))
    bar = np.asarray(original)[..., 3] == 255
    bar[:56] = False
    assert erased[:56, :, 3].max() < 16
    # The inpainter guesses the rim's top row a little see-through.
    assert erased[bar, 3].min() >= 192


def test_prepare_keeps_a_band_the_text_box_covers_whole(client):
    # A ribbon lighter at its right end than at its left, on a dark layer, whose text box takes its whole height.
    height, width = 120, 420
    xs = np.arange(width)[None, :, None]
    ribbon = np.clip([40, 90, 170] + xs * [0.2, 0.3, 0.2], 0, 255)
    artwork = np.full((height, width, 3), 45, np.uint8)
    artwork[40:80, 30:390] = np.broadcast_to(ribbon, (height, width, 3))[40:80, 30:390].astype(np.uint8)
    artwork[38:40, 30:390], artwork[80:82, 30:390] = (200, 160, 60), (200, 160, 60)
    original = Image.fromarray(artwork)
    draw = ImageDraw.Draw(original)
    draw.text((70, 42), 'NEW FRIEND', fill=(255, 255, 255), font_size=34, stroke_width=2, stroke_fill=(20, 40, 80))
    left, _, right, _ = draw.textbbox((70, 42), 'NEW FRIEND', font_size=34, stroke_width=2)
    _, erased = prepare_drawn(client, original, [left - 2, 40, right + 2, 80])
    before = np.asarray(original)
    letters = np.abs(before.astype(int) - artwork).max(axis=2) > 0
    # Where the letters were, the ribbon's blue comes back, not the dark layer around the box.
    assert (np.abs(erased[letters].astype(int) - artwork[letters]).max(axis=1) <= 24).mean() > 0.9
