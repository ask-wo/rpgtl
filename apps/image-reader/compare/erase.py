"""Prepares a game's saved images again with the running reader and shows where the erase changed, against the
saved erase or against a second reader."""
import base64
from html import escape
from contextlib import nullcontext
from io import BytesIO
import json

import httpx
import numpy as np
from PIL import Image

from games import load_image, web_root
from report import picture


def erased_pixels(original, erased):
    """The pixels the erase changed clearly."""
    before = np.asarray(original.convert("RGBA")).astype(int)
    return np.abs(before - np.asarray(erased.convert("RGBA")).astype(int)).max(axis=2) > 24


def changed_share(original, saved, new):
    """The share of pixels one erase changed and the other didn't. The inpainter's texture differs between runs
    even for the same mask, so the erased pixels are compared, not their colours."""
    return float((erased_pixels(original, saved) ^ erased_pixels(original, new)).mean())


def visible_difference(first, second):
    """How far each pixel's RGBA differs between two images, 0 where both are fully transparent, since the colour
    under a transparent pixel doesn't show."""
    first = np.asarray(first.convert("RGBA")).astype(int)
    second = np.asarray(second.convert("RGBA")).astype(int)
    difference = np.abs(first - second).max(axis=2)
    difference[(first[..., 3] == 0) & (second[..., 3] == 0)] = 0
    return difference


def around(selected, margin=12):
    ys, xs = np.nonzero(selected)
    height, width = selected.shape
    return [max(0, int(xs.min()) - margin), max(0, int(ys.min()) - margin),
            min(width, int(xs.max()) + margin + 1), min(height, int(ys.max()) + margin + 1)]


def tinted(original, selected):
    """The original on a checkerboard with the selected pixels tinted red."""
    before = np.asarray(on_checker(original)).astype(float)
    result = before.copy()
    result[selected] = 0.3 * before[selected] + 0.7 * np.array([255.0, 0, 0])
    return Image.fromarray(result.astype(np.uint8))


def erased_area(original, erased):
    """The original with the pixels the erase changed tinted red."""
    return tinted(original, erased_pixels(original, erased))


def on_checker(image, square=8):
    rgba = image.convert("RGBA")
    ys, xs = np.indices((rgba.height, rgba.width))
    shade = np.where((ys // square + xs // square) % 2, 170, 230).astype(np.uint8)
    board = Image.fromarray(np.dstack([shade, shade, shade, np.full_like(shade, 255)]))
    return Image.alpha_composite(board, rgba).convert("RGB")


def swatches(blocks):
    parts = []
    for block in blocks:
        colours = [block.get("fill"), block.get("outline")]
        parts.append("".join(
            f'<span class="swatch" style="background:{escape(colour)}" title="{escape(colour)}"></span>'
            if colour else '<span class="swatch none" title="none"></span>' for colour in colours))
    return " ".join(parts)


def prepare(client, image, record):
    data = BytesIO()
    image.save(data, format="PNG")
    try:
        response = client.post("/prepare", json={
            "image": base64.b64encode(data.getvalue()).decode(), "grow": 4,
            "lines": [{key: line[key] for key in ("text", "polygon", "box")} for line in record["lines"]],
            "blocks": [block["lines"] for block in record["blocks"]],
        })
    except httpx.TransportError as error:
        raise ValueError(f"No image reader answers at {client.base_url}; see docs/testing.md "
                         "(Image reader) to start it") from error
    response.raise_for_status()
    answer = response.json()
    erased = Image.open(BytesIO(base64.b64decode(answer["erased"])))
    erased.load()
    return erased, answer["blocks"]


def listed_images(path):
    """The images of a list file's `<game id> <image name>` lines, by game id. Lines starting with # are comments."""
    listed = {}
    for line in path.read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            game, name = line.split(" ", 1)
            listed.setdefault(game, set()).add(name.strip())
    return listed


def selected_images(game, only, skip, listed):
    images = json.loads((game / "images.json").read_text())["images"]
    selected = [(name, record) for name, record in images.items()
                if record.get("erased") and record.get("blocks")
                and (not only or any(name.startswith(prefix) for prefix in only))
                and not any(part in name for part in skip)
                and (listed is None or name in listed.get(game.name, ()))]
    if listed is not None:
        for name in sorted(listed.get(game.name, set()) - {name for name, _ in selected}):
            print(f"{game.name} has no prepared image {name}", flush=True)
    return selected


def compare_erases(games, out, only, skip, minimum, baseline=None, listed=None, pixels=False):
    if listed is not None:
        for game in sorted(set(listed) - {game.name for game in games}):
            print(f"the list names the game {game}, which isn't compared", flush=True)
    work = [(game, web_root(game), name, record)
            for game in games for name, record in selected_images(game, only, skip, listed)]
    assets = out / "images"
    assets.mkdir(parents=True, exist_ok=True)
    rows = []
    with (httpx.Client(base_url="http://127.0.0.1:5001", timeout=300, follow_redirects=False) as client,
          httpx.Client(base_url=baseline, timeout=300, follow_redirects=False) if baseline else nullcontext() as before):
        for index, (game, root, name, record) in enumerate(work):
            print(f"erase {index + 1}/{len(work)}: {game.name[:6]} {name}", flush=True)
            image, _, _ = load_image(root / record["file"])
            new, new_blocks = prepare(client, image, record)
            if baseline:
                saved, saved_blocks = prepare(before, image, record)
            else:
                saved, saved_blocks = Image.open(game / "images" / record["erased"]), record["blocks"]
                saved.load()
            row = {"game": game.name, "name": name, "size": image.size,
                   "saved_blocks": saved_blocks, "new_blocks": new_blocks}
            rows.append(row)
            if pixels:
                difference = visible_difference(saved, new) > 0
                row["change"] = float(difference.mean())
            else:
                row["change"] = changed_share(image, saved, new)
            if row["change"] <= minimum:
                continue
            prefix = f"{game.name[:6]}-" + name.replace("/", "_")
            if pixels:
                row["crop"] = around(difference)
                pictures = {"original": image, "saved": saved, "new": new, "difference": tinted(image, difference)}
            else:
                pictures = {"original": image, "saved": saved, "saved_area": erased_area(image, saved),
                            "new_area": erased_area(image, new), "new": new}
            row["assets"] = {}
            for key, picture_image in pictures.items():
                path = f"images/{prefix}-{key}.png"
                picture_image.save(out / path)
                row["assets"][key] = path
    rows.sort(key=lambda row: -row["change"])
    write_erase_report(out, games, rows, minimum, "Baseline" if baseline else "Saved", pixels)
    if pixels:
        write_sheets(out, rows, ("original", "saved", "new", "difference"))
    else:
        write_sheets(out, rows, ("original", "saved", "new"), count=12)
    (out / "report.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n")
    print(f"{sum('assets' in row for row in rows)} of {len(rows)} images changed: {out / 'index.html'}", flush=True)


def write_sheets(out, rows, keys, count=None, per_sheet=12):
    """The shown images in pictures of 12 rows each (sheet.png, sheet-2.png, …), a row of the given pictures each,
    cut to the row's crop where it has one and small ones enlarged, for a quick look without the report."""
    for old in out.glob("sheet*.png"):
        old.unlink()
    shown = [row for row in rows if "assets" in row][:count]
    for start in range(0, len(shown), per_sheet):
        strips = [sheet_row(out, row, keys) for row in shown[start:start + per_sheet]]
        sheet = Image.new("RGB", (max(strip.width for strip in strips), sum(strip.height + 6 for strip in strips)),
                          (40, 40, 40))
        top = 0
        for strip in strips:
            sheet.paste(strip, (0, top))
            top += strip.height + 6
        sheet.save(out / ("sheet.png" if start == 0 else f"sheet-{start // per_sheet + 1}.png"))


def sheet_row(out, row, keys):
    parts = [Image.open(out / row["assets"][key]) for key in keys]
    box = row.get("crop", (0, 0, *parts[0].size))
    parts = [on_checker(part.crop(box)) for part in parts]
    width, height = parts[0].size
    scale = max(1, min(4, 300 // max(width, height)))
    size = (width * scale, height * scale)
    strip = Image.new("RGB", (len(parts) * (size[0] + 6) - 6, size[1]), (255, 0, 255))
    for index, part in enumerate(parts):
        strip.paste(part.resize(size, Image.NEAREST), (index * (size[0] + 6), 0))
    return strip


def write_erase_report(out, games, rows, minimum, other, pixels):
    shown = [row for row in rows if "assets" in row]
    if pixels:
        measure = (f"that differ in more than {minimum:.1%} of their pixels" if minimum
                   else "that differ in any visible pixel")
        red = "Red marks the pixels where the two erases differ."
        pictures = (("original", "Original"), ("saved", f"{other} erase"), ("new", "New erase"),
                    ("difference", "Where they differ"))
    else:
        measure = f"whose erased area changed by more than {minimum:.1%} of their pixels"
        red = "Red marks the pixels each erase changed."
        pictures = (("original", "Original"), ("saved_area", f"{other} erase’s area"), ("saved", f"{other} erase"),
                    ("new_area", "New erase’s area"), ("new", "New erase"))
    parts = ["""<!doctype html><html lang="en"><meta charset="utf-8"><title>Erase comparison</title><style>
body{font-family:system-ui,sans-serif;margin:24px;color:#20242c;background:#f5f6f8}
section{background:white;padding:16px 24px;margin:16px 0;border-radius:12px}
figure{margin:0}figcaption{font-weight:600;margin:6px 0}img{max-width:100%;height:auto;image-rendering:pixelated}
.checker{background-color:#eee;background-image:conic-gradient(#bbb 25%,transparent 0 50%,#bbb 0 75%,transparent 0);background-size:20px 20px}
.pictures{display:grid;gap:12px}
.twice{display:block;max-width:none;margin-top:8px;zoom:3}figure:has(.twice){overflow:auto}
.swatch{display:inline-block;width:18px;height:18px;border:1px solid #888;vertical-align:middle}
.none{background:repeating-linear-gradient(45deg,#fff 0 3px,#ccc 3px 6px)}.muted{color:#626b7a}
</style><h1>Erase comparison</h1>""",
             f'<p>{escape(", ".join(str(game) for game in games))}: {len(rows)} prepared images erased again; '
             f'{len(shown)} {measure} are shown, most changed first. {red} Swatches: each block’s fill, then '
             'outline.</p>']
    for row in shown:
        assets = row["assets"]
        small = row["size"][0] <= 300 and row["size"][1] <= 200
        parts.append(f'<section><h2>{escape(row["name"])}</h2><p class="muted">{row["game"]}, {row["size"][0]} × {row["size"][1]}, '
                     f'{row["change"]:.2%} of pixels differ</p><p>{other} colours {swatches(row["saved_blocks"])} '
                     f'· new colours {swatches(row["new_blocks"])}</p><div class="pictures" '
                     f'style="grid-template-columns:repeat({len(pictures)},minmax(0,1fr))">')
        for key, label in pictures:
            parts.append(picture(assets[key], label, small))
        parts.append("</div></section>")
    unchanged = [f'{row["game"][:6]} {row["name"]}' for row in rows if "assets" not in row]
    if unchanged:
        parts.append(f'<details><summary>{len(unchanged)} unchanged</summary><ul>'
                     + "".join(f"<li>{escape(name)}</li>" for name in unchanged) + "</ul></details>")
    parts.append("</html>")
    (out / "index.html").write_text("".join(parts))
