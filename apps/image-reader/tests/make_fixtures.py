import json
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageDraw, ImageFont

DIRECTORY = Path(__file__).parent / 'fixtures'


def main():
    DIRECTORY.mkdir(exist_ok=True)
    font_path = subprocess.check_output(
        ['fc-match', 'Noto Sans CJK SC:bold', 'file', '--format', '%{file}'], text=True
    ).strip()
    yy, xx = np.indices((312, 816))
    stripes = ((xx + yy) // 40) % 2
    background = np.stack([
        145 + yy * 40 / 312 + stripes * 14,
        165 + yy * 35 / 312 + stripes * 12,
        180 + yy * 30 / 312 + stripes * 10,
    ], axis=2).astype(np.uint8)
    menu = Image.fromarray(background)
    menu.save(DIRECTORY / 'menu-clean.png')
    records = {'menu.png': []}
    draw = ImageDraw.Draw(menu)
    for text, size, position, fill, stroke in (
        ('开始游戏', 48, (90, 30), 'white', 3),
        ('退出', 40, (90, 165), '#503424', 0),
    ):
        font = ImageFont.truetype(font_path, size)
        box = draw.textbbox(position, text, font=font, stroke_width=stroke)
        draw.text(position, text, font=font, fill=fill, stroke_width=stroke, stroke_fill='black')
        records['menu.png'].append({'text': text, 'box': list(box)})
    menu.save(DIRECTORY / 'menu.png')
    logo = Image.new('RGBA', (640, 200), (0, 0, 0, 0))
    draw = ImageDraw.Draw(logo)
    font = ImageFont.truetype(font_path, 64)
    text, position = '星光物语', (170, 35)
    box = draw.textbbox(position, text, font=font, stroke_width=4)
    draw.text(position, text, font=font, fill='#ffdc32', stroke_width=4, stroke_fill='#704020')
    logo.save(DIRECTORY / 'logo.png')
    records['logo.png'] = [{'text': text, 'box': list(box)}]
    weights = Image.new('RGB', (480, 220), (150, 168, 182))
    draw = ImageDraw.Draw(weights)
    records['weights.png'] = []
    for style, position in (('regular', (60, 30)), ('bold', (60, 120))):
        weight_path = subprocess.check_output(
            ['fc-match', f'Noto Sans CJK SC:{style}', 'file', '--format', '%{file}'], text=True
        ).strip()
        font = ImageFont.truetype(weight_path, 40)
        text = '设置选项'
        box = draw.textbbox(position, text, font=font)
        draw.text(position, text, font=font, fill='#503424')
        records['weights.png'].append({'text': text, 'box': list(box), 'style': style})
    weights.save(DIRECTORY / 'weights.png')
    korean = Image.fromarray(background)
    draw = ImageDraw.Draw(korean)
    records['menu-korean.png'] = []
    for text, position in (('모험 시작하기', (90, 40)), ('불러오기', (90, 170))):
        font = ImageFont.truetype(font_path, 44)
        box = draw.textbbox(position, text, font=font, stroke_width=3)
        draw.text(position, text, font=font, fill='white', stroke_width=3, stroke_fill='black')
        records['menu-korean.png'].append({'text': text, 'box': list(box)})
    korean.save(DIRECTORY / 'menu-korean.png')
    (DIRECTORY / 'fixtures.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
