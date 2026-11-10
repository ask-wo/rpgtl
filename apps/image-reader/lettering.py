"""What the English needs to be drawn into an image: where each block of text is, its colours, its weight,
the blank space around it and how blocks share size and alignment. The pixel work is done here; the
game does the layout and drawing with its own font."""

import math
import unicodedata

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# A block is bold when its weight is above this: between the weights read from Noto Sans CJK SC Regular and Bold.
BOLD_WEIGHT = 0.1035
EDGE = 24
# Lettering is thin when less than this share of its ink stays after one pixel is peeled off its edges. Its
# strokes then have no core of their own colour, only pixels blended with the background.
THIN = 0.25
# The detector's boxes of level text lean by up to a few degrees, so lines closer to level than this are drawn level.
LEVEL = 5
# A level box narrower than this share of its text written level holds text that slants.
NARROW = 0.65
# How clearly the strokes of a line in a level box must lean, from 0 to 1. Level labels with outlines, bars or art
# beside them reach about 0.3 too, so a lean counts only in a box too narrow for its text written level.
LEANING = 0.2


def direction(line):
    """The angle in degrees, clockwise from rightwards, at which a line's text runs, with the line's thickness
    across it. Taken from the corners in the order `ocr.rotate_crop` straightens the box in, so it runs down a box
    at least 1.5 times as tall as wide."""
    if len(line["polygon"]) != 4:
        return 0.0, line["box"][3] - line["box"][1]
    left, right = np.split(np.array(sorted(line["polygon"], key=lambda point: point[0]), float), 2)
    left, right = left[np.argsort(left[:, 1], kind="stable")], right[np.argsort(right[:, 1], kind="stable")]
    points = [left[0], right[0], right[1], left[1]]
    width = int(max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])))
    height = int(max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])))
    if width and height / width >= 1.5:
        run, thickness = points[3] - points[0], width
    else:
        run, thickness = points[1] - points[0], height
    return math.degrees(math.atan2(run[1], run[0])), thickness


def turned(line):
    return abs(direction(line)[0]) >= LEVEL


def stroke_lean(ink):
    """How far the strokes of letters lean from level and upright, in degrees, and how clearly, from 0 to 1. Chinese
    strokes run mostly level and upright, so the directions of their edges cluster 90 degrees apart. The mask is
    blurred first, since a mask's own edges only run along its pixel grid."""
    smooth = np.asarray(Image.fromarray(ink.astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(1.5)), float)
    gy, gx = np.gradient(smooth)
    weight = np.hypot(gx, gy)
    total = weight.sum()
    if not total:
        return 0.0, 0.0
    phase = 4 * np.arctan2(gy, gx)
    c, s = (weight * np.cos(phase)).sum() / total, (weight * np.sin(phase)).sum() / total
    return math.degrees(math.atan2(s, c) / 4), math.hypot(c, s)


def course(line, original, erased, area):
    """The angle a line's text runs at when it isn't level, with its thickness across that and the points it covers.
    From the box when the detector turned it; from the letters when the box is level but too narrow for its text
    written level, as a short slanted word gives, and its strokes lean. None for level text."""
    if turned(line):
        angle, thickness = direction(line)
        return angle, thickness, np.array(line["polygon"], float)
    text = line["text"][len(kept_prefix(line["text"])):].replace(" ", "")
    x0, y0, x1, y1 = [int(value) for value in area]
    if len(text) < 2 or x1 - x0 >= NARROW * level_width(text, y1 - y0):
        return None
    box = (x0, y0, x1, y1)
    ink = np.abs(np.asarray(composite(original.crop(box))).astype(int)
                 - np.asarray(composite(erased.crop(box))).astype(int)).max(axis=2) > 40
    if ink.sum() < 30:
        return None
    angle, clearness = stroke_lean(ink)
    if abs(angle) < LEVEL or clearness < LEANING:
        return None
    # The text's own rectangle at that angle, whose upright bounding box is the line's box.
    cos, sin = math.cos(math.radians(angle)), abs(math.sin(math.radians(angle)))
    width, height = x1 - x0, y1 - y0
    length = (width * cos - height * sin) / (cos * cos - sin * sin)
    thickness = (height * cos - width * sin) / (cos * cos - sin * sin)
    if length <= 0 or thickness <= 0:
        return None
    middle = np.array([(x0 + x1) / 2, (y0 + y1) / 2])
    cos, sin = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    corners = [middle + [u * cos - v * sin, u * sin + v * cos]
               for u, v in ((-length / 2, -thickness / 2), (length / 2, -thickness / 2),
                            (length / 2, thickness / 2), (-length / 2, thickness / 2))]
    return angle, round(thickness, 1), np.array(corners)


def block_angle(courses):
    """The angle a block's text runs at, from its lines' courses, or None when it is level or its lines run
    different ways."""
    if any(each is None for each in courses):
        return None
    angles = [angle for angle, _, _ in courses]
    if max(angles) - min(angles) > LEVEL:
        return None
    angle = sum(angles) / len(angles)
    return 90.0 if abs(angle - 90) < LEVEL else angle


def own_frame(points, angle):
    """The rectangle that, turned by `angle` around its middle, covers `points`."""
    pivot = points.mean(axis=0)
    cos, sin = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    relative = points - pivot
    along = relative[:, 0] * cos + relative[:, 1] * sin
    across = relative[:, 1] * cos - relative[:, 0] * sin
    u, v = (along.min() + along.max()) / 2, (across.min() + across.max()) / 2
    x, y = pivot[0] + u * cos - v * sin, pivot[1] + u * sin + v * cos
    half_length, half_thickness = (along.max() - along.min()) / 2, (across.max() - across.min()) / 2
    return [round(float(value), 1) for value in (x - half_length, y - half_thickness, x + half_length, y + half_thickness)]


def composite(image, colour=(128, 128, 128)):
    if image.mode == "RGBA":
        return Image.alpha_composite(Image.new("RGBA", image.size, (*colour, 255)), image).convert("RGB")
    return image.convert("RGB")


def contrasts(image, polygons):
    """Largest colour or opacity range, keeping thin and coloured lettering visible."""
    pixels_image = image if image.mode == "RGBA" else image.convert("RGB")
    result = []
    for polygon in polygons:
        x0 = max(0, min(point[0] for point in polygon))
        y0 = max(0, min(point[1] for point in polygon))
        x1 = min(image.width, max(point[0] for point in polygon) + 1)
        y1 = min(image.height, max(point[1] for point in polygon) + 1)
        if x0 >= x1 or y0 >= y1:
            result.append(255)
            continue
        mask = Image.new("L", (x1 - x0, y1 - y0))
        ImageDraw.Draw(mask).polygon([(x - x0, y - y0) for x, y in polygon], fill=255)
        pixels = np.asarray(pixels_image.crop((x0, y0, x1, y1)))[np.asarray(mask) > 0]
        if not len(pixels):
            result.append(255)
            continue
        result.append(int(np.ptp(pixels, axis=0).max()))
    return result


SCRIPTS = ("CJK UNIFIED IDEOGRAPH", "CJK COMPATIBILITY IDEOGRAPH", "HIRAGANA", "KATAKANA", "HANGUL")


def cjk(text):
    """Whether text has Chinese characters, kana or Hangul."""
    return any(script in unicodedata.name(char, "") for char in text for script in SCRIPTS)


def normalise(text):
    return "".join(char for char in text if not char.isspace() and not unicodedata.category(char).startswith("P"))


def kept_prefix(text):
    """A short icon or bullet before the text; it stays in the image and is not translated."""
    prefix = ""
    for char in text:
        if cjk(char):
            break
        prefix += char
    return prefix if prefix.strip() and len(prefix.strip()) <= 2 and not any(char.isdigit() for char in prefix) else ""


def level_width(text, height):
    """About how wide text is written level at a height."""
    return sum(0.9 * height * (1 if unicodedata.east_asian_width(char) in "WFA" else 0.55) for char in text)


def text_area(line, image):
    """The part of a line's box that is erased and drawn into, leaving a kept prefix in place.

    The split is the blank gap between prefix and text nearest to an estimate from character widths;
    without a gap, the earlier estimate is used so no source text is left behind."""
    x0, y0, x1, y1 = line["box"]
    prefix = kept_prefix(line["text"])
    if not prefix:
        return list(line["box"])
    advance = 0.9 * (y1 - y0)
    estimates = (x1 - level_width(line["text"][len(prefix):].strip(), y1 - y0),
                 x0 + level_width(prefix.rstrip(), y1 - y0))
    pixels = np.asarray(composite(image))[y0:y1, x0:x1].astype(int)
    background = np.median(np.concatenate([pixels[0], pixels[-1]]), axis=0)
    ink = (np.abs(pixels - background).max(axis=2) > 40).any(axis=0)
    gaps, run = [], None
    for column, inked in enumerate([*ink, True]):
        if not inked and run is None:
            run = column
        elif inked and run is not None:
            if run > 0 and column < len(ink) and column - run >= max(2, 0.1 * (y1 - y0)):
                gaps.append((run, column))
            run = None
    target = sum(estimates) / 2 - x0
    near = [gap for gap in gaps if abs((gap[0] + gap[1]) / 2 - target) <= advance]
    if near:
        gap = min(near, key=lambda gap: abs((gap[0] + gap[1]) / 2 - target))
        return [x0 + (gap[0] + gap[1]) // 2, y0, x1, y1]
    return [max(x0, round(min(estimates) - 0.25 * advance)), y0, x1, y1]


def related(a, b, same_text):
    """Blocks have a text, an area and the height of their tallest line."""
    if normalise(a["text"]) == normalise(b["text"]):
        return same_text
    heights = sorted((a["lineHeight"], b["lineHeight"]))
    if same_text:
        return heights[1] <= 1.4 * heights[0]
    ax0, ay0, ax1, ay1 = a["area"]
    bx0, by0, bx1, by1 = b["area"]
    if heights[1] > 1.35 * heights[0]:
        return False
    overlap = min(ay1, by1) - max(ay0, by0)
    if overlap > 0.5 * heights[0]:
        return True
    tolerance = 0.3 * heights[1]
    return -overlap <= heights[1] and (abs(ax0 - bx0) <= tolerance or abs(ax0 + ax1 - bx0 - bx1) / 2 <= tolerance)


def groups(blocks, same_text):
    """Blocks of one paragraph or row share a colour; for size, blocks of about the same height and repeated
    blocks such as button states share one."""
    parent = list(range(len(blocks)))

    def root(index):
        while parent[index] != index:
            index = parent[index]
        return index

    for index in range(len(blocks)):
        for other in range(index):
            if related(blocks[index], blocks[other], same_text):
                parent[root(index)] = root(other)
    grouped = {}
    for index in range(len(blocks)):
        grouped.setdefault(root(index), []).append(index)
    return list(grouped.values())


def erode(mask):
    height, width = mask.shape
    padded = np.pad(mask, 1)
    return np.logical_and.reduce([
        padded[y:y + height, x:x + width] for y in range(3) for x in range(3)
    ])


LUMINANCE = np.array([0.2126, 0.7152, 0.0722])


def clusters(pixels, count=4):
    """Groups colours around `count` centres, starting from colours far apart."""
    pixels = pixels.astype(float)
    centres = [pixels[(pixels @ LUMINANCE).argmin()]]
    while len(centres) < min(count, len(pixels)):
        distance = np.min([np.linalg.norm(pixels - centre, axis=1) for centre in centres], axis=0)
        if distance.max() < 24:
            break
        centres.append(pixels[distance.argmax()])
    centres = np.array(centres)
    for _ in range(10):
        labels = np.argmin([np.linalg.norm(pixels - centre, axis=1) for centre in centres], axis=0)
        centres = np.array([pixels[labels == index].mean(axis=0) if (labels == index).any() else centre
                            for index, centre in enumerate(centres)])
    return labels


def blended(colour, lettering, background):
    """Whether a colour lies on the way from the lettering's colour to the background, as the pixels at the
    edge of plain lettering do."""
    way = background - lettering
    along = float((colour - lettering) @ way / max(float(way @ way), 1.0))
    return 0.1 < along < 1.2 and float(np.linalg.norm(colour - lettering - along * way)) < 40


def ink_colours(original, erased, areas):
    """The fill and outline colour of the lettering, its outline None when it has none, and the erased
    background under it; None when the erase changed nothing. The pixels the erase changed are grouped by
    colour, leaving out small groups such as bits of artwork in the area. When the two most different groups
    differ clearly, the lighter is the fill and the darker the outline, as in most game lettering, unless one
    of them is only the other blended into the background; then the other is the fill. In thick lettering
    such a colour may also be a fill inside an outline, so there the fill is the colour inside the strokes.
    Strokes of small lettering are too thin to tell fill and outline apart by shape, and lettering drawn the
    other way round stays readable. Pixels the original leaves see-through don't count, since the eraser may
    paint over them."""
    before_image, after_image = np.asarray(composite(original)), np.asarray(composite(erased))
    opacity = np.asarray(original.convert("RGBA"))[..., 3]
    pixels, inner, backgrounds = [], [], []
    for x0, y0, x1, y1 in areas:
        before = before_image[y0:y1, x0:x1].astype(int)
        after = after_image[y0:y1, x0:x1].astype(int)
        ink = np.any(np.abs(before - after) > 48, axis=2) & (opacity[y0:y1, x0:x1] >= 128)
        if not ink.any():
            continue
        pixels.append(before[ink])
        inner.append(erode(ink)[ink])
        backgrounds.append(after[ink])
    if not pixels:
        return None
    pixels, inner = np.concatenate(pixels), np.concatenate(inner)
    background = np.median(np.concatenate(backgrounds), axis=0)
    labels = clusters(pixels)
    groups = [np.median(pixels[labels == index], axis=0) for index in range(labels.max() + 1)
              if (labels == index).sum() >= 0.1 * len(pixels)]
    pairs = [(a, b) for n, a in enumerate(groups) for b in groups[n + 1:]]
    a, b = max(pairs, key=lambda pair: np.linalg.norm(pair[0] - pair[1]), default=(None, None))
    inside = np.median(pixels[inner] if inner.any() else pixels, axis=0)
    apart = a is not None and np.linalg.norm(a - b) > 100
    outline = None
    if apart and blended(b, a, background):
        fill = a if inner.mean() < THIN else inside
    elif apart and blended(a, b, background):
        fill = b
    elif apart:
        fill, outline = (a, b) if a @ LUMINANCE > b @ LUMINANCE else (b, a)
    else:
        fill = inside
    return fill, outline, background


def colours(original, erased, areas, heights=None):
    """The fill and outline colour of the lettering, and its stroke. A fill that would barely stand out from
    the erased background gets a black or white outline."""
    found = ink_colours(original, erased, areas)
    if found is None:
        return {"fill": None, "outline": None, "stroke": 0}
    fill, outline, background = found
    if outline is None and abs(float((fill - background) @ LUMINANCE)) < 60:
        outline = np.zeros(3) if fill @ LUMINANCE > 128 else np.full(3, 255)
    height = min(heights) if heights else min(y1 - y0 for _, y0, _, y1 in areas)
    return {
        "fill": fill.astype(int).tolist(), "outline": outline.astype(int).tolist() if outline is not None else None,
        "stroke": max(1, round(0.06 * height)) if outline is not None else 0,
    }


def weight(original, erased, areas, fill, outline):
    """How heavy the strokes of the text are: the median width of the fill-coloured ink along each row,
    relative to the height the fill ink spans. Only ink nearer the fill than the outline counts, so an
    outline ring doesn't make outlined text look heavy. The line height the reader reports is too loose to
    divide by: it varies by a third for text of the same size."""
    before_image, after_image = np.asarray(composite(original)), np.asarray(composite(erased))
    widths, heights = [], []
    for x0, y0, x1, y1 in areas:
        before = before_image[y0:y1, x0:x1].astype(int)
        after = after_image[y0:y1, x0:x1].astype(int)
        ink = np.any(np.abs(before - after) > 48, axis=2)
        if outline is not None:
            ink &= (np.linalg.norm(before - fill, axis=2) <= np.linalg.norm(before - outline, axis=2))
        if not ink.any():
            continue
        edges = np.diff(np.pad(ink.astype(np.int8), ((0, 0), (1, 1))), axis=1)
        starts, ends = np.argwhere(edges == 1), np.argwhere(edges == -1)
        widths.append(ends[:, 1] - starts[:, 1])
        rows = np.flatnonzero(ink.any(axis=1))
        heights.append(rows[-1] - rows[0] + 1)
    if not widths:
        return 0.0
    return float(np.median(np.concatenate(widths)) / np.mean(heights))


def room(erased, area, others):
    """Widen a text area into blank space of the erased image, stopping halfway to other text."""
    pixels = np.asarray(erased.convert("RGBA")).astype(int)
    pixels = np.concatenate([pixels[..., :3] * pixels[..., 3:] // 255, pixels[..., 3:]], axis=2)
    height, width = pixels.shape[:2]
    x0, y0, x1, y1 = area
    margin = max(2, (y1 - y0) // 3)
    left, top, right, bottom = 0, 0, width, height
    for ox0, oy0, ox1, oy1 in others:
        beside = oy0 < y1 and oy1 > y0
        above_or_below = ox0 < x1 and ox1 > x0
        if beside and abs(oy0 + oy1 - y0 - y1) < abs(ox0 + ox1 - x0 - x1):
            if ox0 + ox1 > x0 + x1:
                right = min(right, (x1 + ox0) // 2)
            else:
                left = max(left, (ox1 + x0) // 2)
        elif above_or_below:
            if oy0 + oy1 > y0 + y1:
                bottom = min(bottom, (y1 + oy0) // 2)
            else:
                top = max(top, (oy1 + y0) // 2)
    across = np.percentile(np.abs(np.diff(pixels[y0:y1], axis=1)).max(axis=2), 90, axis=0) > EDGE
    down = np.percentile(np.abs(np.diff(pixels[:, x0:x1], axis=0)).max(axis=2), 90, axis=1) > EDGE
    l, r, t, b = x0, x1, y0, y1
    while l > left and not across[l - 1]:
        l -= 1
    while r < min(right, width - 1) and not across[r - 1]:
        r += 1
    while t > top and not down[t - 1]:
        t -= 1
    while b < min(bottom, height - 1) and not down[b - 1]:
        b += 1
    return [max(left, min(x0, l + margin)), max(top, min(y0, t + margin)),
            min(right, max(x1, r - margin)), min(bottom, max(y1, b - margin))]


def alignments(blocks):
    """Left for a column of blocks that start at the same left edge but end at different ones, as ragged
    paragraphs and chat messages do; otherwise centred, as buttons and notices are. The reader's boxes of
    one column start up to about a third of their line height apart, so blocks that close join one column."""
    def tolerance(members):
        return max(4, 0.3 * min(block["lineHeight"] for block in members))

    parent = list(range(len(blocks)))

    def root(index):
        while parent[index] != index:
            index = parent[index]
        return index

    for index, block in enumerate(blocks):
        for other in range(index):
            if abs(blocks[other]["area"][0] - block["area"][0]) <= tolerance([block, blocks[other]]):
                parent[root(index)] = root(other)
    columns = {}
    for index in range(len(blocks)):
        columns.setdefault(root(index), []).append(blocks[index])
    result = []
    for index in range(len(blocks)):
        column = columns[root(index)]
        ends = [block["area"][2] for block in column]
        result.append("left" if max(ends) - min(ends) > tolerance(column) else "centre")
    return result


def hexadecimal(colour):
    return "#" + "".join(f"{channel:02x}" for channel in colour)


def line_areas(lines, indices, image):
    """For each line, the area that is erased and drawn into, and the polygon to erase: the line's own, or
    the rectangle of its text area when a kept prefix was split off."""
    areas = {}
    for index in indices:
        line = lines[index]
        area = list(line["box"]) if turned(line) else text_area(line, image)
        x0, y0, x1, y1 = area
        areas[index] = (area, line["polygon"] if area == line["box"] else [[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
    return areas


def describe(original, erased, lines, blocks, areas):
    """Colours, bold, blank space, size group and alignment of each block, in the order of `blocks`."""
    items = []
    for indices in blocks:
        block_areas = [areas[index][0] for index in indices]
        courses = [course(lines[index], original, erased, areas[index][0]) for index in indices]
        angle = block_angle(courses)
        items.append({
            "text": "\n".join(lines[index]["text"] for index in indices),
            "area": [min(area[0] for area in block_areas), min(area[1] for area in block_areas),
                     max(area[2] for area in block_areas), max(area[3] for area in block_areas)],
            "lineHeight": max(lines[index]["box"][3] - lines[index]["box"][1] for index in indices) if angle is None
            else max(thickness for _, thickness, _ in courses),
            "angle": angle,
            "points": None if angle is None else np.concatenate([points for _, _, points in courses]),
            "areas": block_areas,
            "indices": indices,
        })
    styles = [None] * len(items)
    for group in groups(items, same_text=False):
        members = [items[index] for index in group]
        group_areas = [area for item in members for area in item["areas"]]
        heights = [item["lineHeight"] for item in members]
        style = colours(original, erased, group_areas, heights)
        if style["fill"] is not None:
            style["weight"] = weight(original, erased, group_areas, style["fill"], style["outline"])
        for index in group:
            styles[index] = style
    sizes = {}
    for number, group in enumerate(groups(items, same_text=True)):
        for index in group:
            sizes[index] = number
    aligned = alignments(items)
    result = []
    for index, item in enumerate(items):
        style = styles[index]
        others = [line["box"] for other, line in enumerate(lines) if other not in item["indices"]]
        angle = item["angle"]
        if angle is None:
            drawn = {"area": item["area"], "space": room(erased, item["area"], others)}
        else:
            area = own_frame(item["points"], angle)
            drawn = {"angle": round(angle, 1), "area": area, "space": area}
        result.append({
            "polygons": [areas[line][1] for line in item["indices"]],
            **drawn,
            "lineHeight": item["lineHeight"],
            "fill": hexadecimal(style["fill"]) if style["fill"] is not None else None,
            "outline": hexadecimal(style["outline"]) if style["outline"] is not None else None,
            "stroke": style["stroke"],
            "weight": style.get("weight", 0.0),
            "bold": style.get("weight", 0.0) > BOLD_WEIGHT,
            "align": "centre" if angle is not None else aligned[index],
            "group": sizes[index],
        })
    return result
