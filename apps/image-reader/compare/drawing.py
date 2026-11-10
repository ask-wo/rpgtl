from io import BytesIO
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

from games import game_root

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lettering import room  # noqa: E402

MEASURE = ImageDraw.Draw(Image.new("RGB", (1, 1)))


def png_bytes(image):
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def system_font(name):
    result = subprocess.run(
        ["fc-match", name, "--format", "%{file}"], capture_output=True, text=True, check=True
    )
    path = Path(result.stdout.strip())
    if not path.is_file():
        raise ValueError(f"Font not found: {name}")
    return path


def game_font(path):
    root = game_root(path)
    system = json.loads((root / "data/System.json").read_text(encoding="utf-8-sig"))
    boot = (root / "index.html").read_text(encoding="utf-8-sig") if (root / "index.html").is_file() else ""
    mv = re.search(r"src\s*=\s*['\"][^'\"]*rpg_core\.js", boot, re.IGNORECASE)
    mz = not mv and ("rmmz_core.js" in boot or (root / "js/rmmz_core.js").is_file())
    if mz:
        advanced = system.get("advanced", {})
        filename = advanced.get("mainFontFilename")
        if not filename:
            families = [name.strip() for name in advanced.get("fallbackFonts", "").split(",") if name.strip()]
            return system_font(",".join(families or ["sans-serif"]))
        font = root / "fonts" / filename
    else:
        css = (root / "fonts/gamefont.css").read_text(encoding="utf-8-sig")
        urls = re.findall(r"url\(\s*['\"]?([^)'\"]+)", css)
        fonts = [root / "fonts" / url.strip() for url in urls]
        font = next((item for item in fonts if item.is_file()), None)
        if font is None:
            raise ValueError("No font file in fonts/gamefont.css")
    if not font.is_file():
        raise ValueError(f"Game font not found: {font}")
    return font


def open_font(path, out):
    try:
        ImageFont.truetype(str(path), 24)
        return path, False
    except OSError:
        if path.suffix.lower() not in (".woff", ".woff2"):
            raise ValueError(f"Pillow cannot open font: {path}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
        converted = out / "fonts" / f"{path.stem}-{digest}.ttf"
        converted.parent.mkdir(parents=True, exist_ok=True)
        font = TTFont(path)
        font.flavor = None
        font.save(converted)
        font.close()
        ImageFont.truetype(str(converted), 24)
        return converted, True


def stroke_width(ratio, size):
    return max(1, round(ratio * size)) if ratio else 0


def measure(lines, path, size, stroke):
    font = ImageFont.truetype(str(path), size)
    boxes = [MEASURE.textbbox((0, 0), line, font=font, stroke_width=stroke) for line in lines]
    gap = max(1, round(size * 0.15)) if len(lines) > 1 else 0
    total = sum(box[3] - box[1] for box in boxes) + gap * (len(lines) - 1)
    return {"size": size, "font": font, "boxes": boxes, "gap": gap, "height": total, "lines": list(lines),
            "width": max(box[2] - box[0] for box in boxes), "stroke": stroke}


def fit(lines, path, width, height, upper, stroke_ratio):
    lower, best = 1, None
    while lower <= upper:
        size = (lower + upper) // 2
        candidate = measure(lines, path, size, stroke_width(stroke_ratio, size))
        if candidate["width"] <= width and candidate["height"] <= height:
            best, lower = candidate, size + 1
        else:
            upper = size - 1
    return best


def natural_size(path, height):
    """The size at which Latin capitals and descenders fill the original line height."""
    return (fit(["Hy"], path, 10 ** 6, height, max(1, 2 * height), 0) or {"size": 1})["size"]


def supported(path, text):
    with TTFont(path, fontNumber=0, lazy=True) as font:
        characters = font.getBestCmap() or {}
    return "".join(char for char in text if char.isspace() or ord(char) in characters).strip()


def plan(text, path, area, space, centred, stroke_ratio):
    """Pick line breaks and the largest size up to the original's for one text area."""
    x0, y0, x1, y1 = area = [max(area[0], space[0]), max(area[1], space[1]),
                             min(area[2], space[2]), min(area[3], space[3])]
    target = natural_size(path, y1 - y0)
    if centred:
        width = (x1 - x0) + 2 * min(x0 - space[0], space[2] - x1)
    else:
        width = space[2] - x0
    height = (y1 - y0) + 2 * min(y0 - space[1], space[3] - y1)
    best = fit([text], path, width, y1 - y0, target, stroke_ratio)
    words = text.split()
    if (best is None or best["size"] < 0.75 * target) and len(words) > 1:
        font = ImageFont.truetype(str(path), target)
        lines = min(((" ".join(words[:index]), " ".join(words[index:])) for index in range(1, len(words))),
                    key=lambda pair: abs(MEASURE.textlength(pair[0], font=font) - MEASURE.textlength(pair[1], font=font)))
        wrapped = fit(lines, path, width, height, target, stroke_ratio)
        if wrapped and (best is None or wrapped["size"] > best["size"]):
            best = wrapped
    return best and {"size": best["size"], "lines": best["lines"], "target": target, "area": area}


def draw_variant(erased, lines, path, all_lines, groups):
    """Draw each line's translation; lines in one size group share the smallest fitting size, except lines
    that would need much less than the others."""
    result = erased.copy()
    draw = ImageDraw.Draw(result)
    plans = {}
    for index, line in enumerate(lines):
        style = line["style"]
        text = supported(path, line.get("translation") or "")
        if not text or style["fill"] is None:
            continue
        others = [other["box"] for other in all_lines if other is not line]
        centred = not any(abs(other["box"][0] - line["box"][0]) <= 4 for other in all_lines if other is not line)
        ratio = style["stroke"] / max(1, line["box"][3] - line["box"][1])
        planned = plan(text, path, line["area"], room(erased, line["area"], others), centred, ratio)
        if planned:
            plans[index] = {**planned, "centred": centred, "ratio": ratio}
    for group in groups:
        members = [index for index in group if index in plans]
        if not members:
            continue
        sizes = sorted(plans[index]["size"] for index in members)
        median = sizes[len(sizes) // 2]
        members = [index for index in members if plans[index]["size"] >= 0.8 * median]
        smallest = min(members, key=lambda index: plans[index]["size"])
        for index in members:
            planned = plans[index]
            if supported(path, lines[index]["translation"]) == supported(path, lines[smallest]["translation"]):
                planned["lines"] = plans[smallest]["lines"]
            planned["size"] = plans[smallest]["size"]
    for index, planned in plans.items():
        line, style = lines[index], lines[index]["style"]
        x0, y0, x1, y1 = planned["area"]
        laid = measure(planned["lines"], path, planned["size"], stroke_width(planned["ratio"], planned["size"]))
        y = y0 + (y1 - y0 - laid["height"]) / 2
        alpha = (255,) if result.mode == "RGBA" else ()
        fill = tuple(style["fill"]) + alpha
        outline = tuple(style["outline"] or style["fill"]) + alpha
        for text, box in zip(laid["lines"], laid["boxes"], strict=True):
            x = x0 + (x1 - x0 - (box[2] - box[0])) / 2 if planned["centred"] else x0
            draw.text((x - box[0], y - box[1]), text, font=laid["font"], fill=fill,
                      stroke_width=laid["stroke"], stroke_fill=outline)
            y += box[3] - box[1] + laid["gap"]
        line.setdefault("drawing", {})[str(path)] = {
            "size": laid["size"], "original_size": planned["target"], "lines": laid["lines"],
            "alignment": "centre" if planned["centred"] else "left",
        }
    return result
