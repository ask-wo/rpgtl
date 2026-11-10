import base64
import binascii
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from contextlib import asynccontextmanager
from io import BytesIO
import json
import multiprocessing
import os
from threading import Lock

import cv2
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
import numpy as np
from PIL import Image, ImageDraw, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from lettering import composite, contrasts, describe, ink_colours, line_areas, turned
from models import RECOGNIZER_NAMES, installed, missing_models
import worker


class Models:
    """Runs the models in a worker process that starts on first use and ends on unload."""

    def __init__(self, device, threads):
        self.device, self.threads = device, threads
        self.pool = None
        self.lock = Lock()

    def call(self, function, *args):
        with self.lock:
            if self.pool is None:
                self.pool = ProcessPoolExecutor(
                    1, multiprocessing.get_context("spawn"), worker.load, (self.device, self.threads)
                )
            try:
                return self.pool.submit(function, *args).result()
            except BrokenProcessPool:
                self.pool = None
                raise

    def unload(self):
        with self.lock:
            if self.pool is not None:
                self.pool.shutdown()
                self.pool = None

    @property
    def loaded(self):
        return self.pool is not None


@asynccontextmanager
async def lifespan(app):
    missing = missing_models()
    if missing:
        raise RuntimeError(
            f"Missing image text models: {', '.join(map(str, missing))}. "
            "Set up the image reader again in Settings."
        )
    threads = int(os.environ.get("IMAGE_TEXT_THREADS", "4"))
    if threads < 1:
        raise RuntimeError("IMAGE_TEXT_THREADS must be a positive integer")
    device = os.environ.get("IMAGE_TEXT_DEVICE", "cpu")
    if device not in ("cpu", "gpu", "directml"):
        raise RuntimeError("IMAGE_TEXT_DEVICE must be cpu, gpu or directml")
    app.state.models = Models(device, threads)
    yield
    app.state.models.unload()


app = FastAPI(lifespan=lifespan)


class BadInput(ValueError):
    pass


@app.exception_handler(BadInput)
async def bad_input(request, error):
    return JSONResponse({"error": str(error)}, status_code=400)


def png(data):
    try:
        image = Image.open(BytesIO(data))
        if image.format not in ("PNG", "JPEG"):
            raise BadInput("Expected a PNG or JPEG image")
        image.load()
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise BadInput("Expected a valid PNG or JPEG image") from error
    if image.mode not in ("RGB", "RGBA"):
        transparent = "A" in image.getbands() or "transparency" in image.info
        image = image.convert("RGBA" if transparent else "RGB")
    return image


@app.get("/health")
def health():
    return {
        "ocr": {
            "detection": "PP-OCRv6_medium_det",
            "recognizers": {name: model for name, model in RECOGNIZER_NAMES.items() if installed(name)},
        },
        "inpaint": "big-lama",
        "device": app.state.models.device, "loaded": app.state.models.loaded,
    }


@app.post("/unload")
async def unload():
    """Ends the models' process, freeing their memory until the next request needs them."""
    await run_in_threadpool(app.state.models.unload)
    return {"loaded": False}


def recognizer(language):
    """The recognizer for the game's language: `korean`, or else the general one."""
    if language not in (None, "chinese", "japanese", "korean"):
        raise BadInput("language must be chinese, japanese or korean")
    name = "korean" if language == "korean" else "general"
    if not installed(name):
        raise BadInput("The Korean text model isn't installed. Add it in RPGTL's Settings.")
    return name


def read_image(image, colour=(128, 128, 128), language=None):
    rgb = np.asarray(composite(image, colour))
    lines = app.state.models.call(worker.read, cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), recognizer(language))
    return {"width": image.width, "height": image.height, "lines": lines}


def background(request):
    value = request.query_params.get("background", "128,128,128")
    try:
        colour = tuple(int(part) for part in value.split(","))
    except ValueError as error:
        raise BadInput("background must contain three integers from 0 to 255") from error
    if len(colour) != 3 or any(channel < 0 or channel > 255 for channel in colour):
        raise BadInput("background must contain three integers from 0 to 255")
    return colour


def integers(request, name, count):
    value = request.query_params.get(name)
    if value is None:
        return None
    try:
        numbers = [int(part) for part in value.split(",")]
    except ValueError as error:
        raise BadInput(f"{name} must contain {count} integers") from error
    if len(numbers) != count:
        raise BadInput(f"{name} must contain {count} integers")
    return numbers


def clamped(crop, width, height):
    x0, y0, x1, y1 = [max(0, min(value, width if index % 2 == 0 else height)) for index, value in enumerate(crop)]
    if x0 >= x1 or y0 >= y1:
        raise BadInput("crop must be non-empty")
    return x0, y0, x1, y1


@app.post("/flatten")
async def flatten_route(request: Request):
    """The image on a background colour. With `crop`, only that part, with `mark` outlined in red and enlarged to
    256 pixels when smaller, so a vision model can be asked about one spot."""
    image = composite(png(await request.body()), background(request))
    crop, mark = integers(request, "crop", 4), integers(request, "mark", 4)
    if crop:
        x0, y0, x1, y1 = clamped(crop, image.width, image.height)
        image = image.crop((x0, y0, x1, y1))
        if mark:
            ImageDraw.Draw(image).rectangle(
                (mark[0] - x0 - 2, mark[1] - y0 - 2, mark[2] - x0 + 2, mark[3] - y0 + 2), outline=(255, 0, 0),
            )
        scale = 256 / max(image.size)
        if scale > 1:
            image = image.resize((round(image.width * scale), round(image.height * scale)), Image.NEAREST)
    output = BytesIO()
    image.save(output, format="PNG")
    return Response(output.getvalue(), media_type="image/png")


@app.post("/read")
async def read(request: Request):
    colour = background(request)
    image = png(await request.body())
    width, height = image.size
    try:
        scale = int(request.query_params.get("scale", "1"))
        crop = [int(value) for value in request.query_params.get("crop", f"0,0,{width},{height}").split(",")]
    except ValueError as error:
        raise BadInput("crop and scale must be integers") from error
    if scale < 1 or scale > 4 or len(crop) != 4:
        raise BadInput("scale must be 1–4 and crop must contain four integers")
    x0, y0, x1, y1 = clamped(crop, width, height)
    cropped = composite(image.crop((x0, y0, x1, y1)), colour)
    if scale != 1:
        cropped = Image.fromarray(cv2.resize(np.asarray(cropped), None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC))
    result = await run_in_threadpool(read_image, cropped, colour, request.query_params.get("language"))
    for line in result["lines"]:
        line["polygon"] = [[round(x / scale + x0), round(y / scale + y0)] for x, y in line["polygon"]]
        line["box"] = [round(value / scale + (x0 if index % 2 == 0 else y0)) for index, value in enumerate(line["box"])]
    for line, contrast in zip(result["lines"], contrasts(image, [line["polygon"] for line in result["lines"]])):
        line["contrast"] = contrast
    result.update(width=width, height=height)
    return result


async def image_body(request):
    """The JSON body and the bytes of its base64 `image`."""
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise BadInput("Expected a JSON object") from error
    if not isinstance(body, dict) or not isinstance(body.get("image"), str):
        raise BadInput("image must contain a base64 PNG")
    try:
        data = base64.b64decode(body["image"], validate=True)
    except (binascii.Error, ValueError) as error:
        raise BadInput("image must contain a base64 PNG") from error
    return body, data


@app.post("/contrast")
async def contrast(request: Request):
    body, data = await image_body(request)
    image = png(data)
    areas = body.get("areas")
    area_mask(areas, 0, image.size)
    return {"contrasts": await run_in_threadpool(contrasts, image, areas)}


def area_mask(areas, grow, size):
    if not isinstance(areas, list) or type(grow) is not int or grow < 0:
        raise BadInput("areas must be a list of polygons; grow must be a non-negative integer")
    mask = Image.new("L", size)
    draw = ImageDraw.Draw(mask)
    for area in areas:
        if not isinstance(area, list) or len(area) < 3:
            raise BadInput("Each area must contain at least three points")
        points = []
        for point in area:
            if not isinstance(point, list) or len(point) != 2 or any(type(v) is not int for v in point):
                raise BadInput("Each area point must contain two integer coordinates")
            points.append(tuple(point))
        if abs(sum(
            points[i][0] * points[(i + 1) % len(points)][1]
            - points[(i + 1) % len(points)][0] * points[i][1]
            for i in range(len(points))
        )) == 0:
            raise BadInput("Each area must have a non-zero area")
        draw.polygon(points, fill=255)
    mask = np.asarray(mask)
    if grow:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow + 1, 2 * grow + 1))
        mask = cv2.dilate(mask, kernel)
    return mask


def mask_regions(mask):
    """Boxes around the masked areas with room for the inpainter to see what surrounds them, merged where they
    overlap, so a few lines in a large map image don't make it inpaint the whole image."""
    height, width = mask.shape
    count, _, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8))
    boxes = []
    for label in range(1, count):
        x, y, w, h = stats[label, :4]
        margin = max(64, w, h)
        boxes.append([max(0, x - margin), max(0, y - margin), min(width, x + w + margin), min(height, y + h + margin)])
    merged = True
    while merged:
        merged = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                    boxes[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                    del boxes[j]
                    merged = True
                    break
            if merged:
                break
    return boxes


# The inpainter works on a grid 8 times coarser than the image, so on a region shorter than this it copies whole
# blocks of nearby art into the gap; enlarged first, it fills small images cleanly.
INPAINT_SIDE = 192


def inpaint_region(rgb, mask):
    height, width = mask.shape
    scale = INPAINT_SIDE / min(height, width)
    if scale <= 1:
        return app.state.models.call(worker.inpaint, rgb, mask)
    size = (round(width * scale), round(height * scale))
    enlarged = app.state.models.call(
        worker.inpaint, cv2.resize(rgb, size, interpolation=cv2.INTER_CUBIC),
        cv2.resize(mask, size, interpolation=cv2.INTER_NEAREST))
    return cv2.resize(enlarged, (width, height), interpolation=cv2.INTER_AREA)


def inpaint(rgb, mask):
    result = rgb.copy()
    for x0, y0, x1, y1 in mask_regions(mask):
        result[y0:y1, x0:x1] = inpaint_region(rgb[y0:y1, x0:x1], mask[y0:y1, x0:x1])
    return result


def odd(value):
    return max(3, int(value) | 1)


def side_colours(crop, inside):
    """The pixels of each row that match the colour just left or right of the line's box on it, such as a plate's
    band, which the guess under the text can paint another colour. Only rows whose box has room on both sides
    count, since beside text that reaches an icon's edge is art whose dark parts match the letters' outlines; a side
    with a stud or other mark in it is left out, and two even sides must agree."""
    background = np.zeros(inside.shape, bool)
    for y in range(inside.shape[0]):
        xs = np.flatnonzero(inside[y])
        if not len(xs) or xs[0] < 4 or xs[-1] + 5 > inside.shape[1]:
            continue
        sides = (crop[y, xs[0] - 4:xs[0]], crop[y, xs[-1] + 1:xs[-1] + 5])
        colours = [np.median(side, axis=0) for side in sides]
        colours = [colour for side, colour in zip(sides, colours) if np.abs(side - colour).max() <= 16]
        if not colours or (len(colours) == 2 and np.abs(colours[0] - colours[1]).max() > 24):
            continue
        for colour in colours:
            background[y] |= np.abs(crop[y] - colour).max(axis=1) <= 24
    return background


def on_panel(rgb, box):
    """Whether the box lies inside an even area that goes on above and below it, such as a status screen's panel,
    rather than on a band or a button that ends just past the text."""
    x0, y0, x1, y1 = box
    if y0 < 5 or y1 + 5 > rgb.shape[0]:
        return False
    strips = [rgb[y0 - 5:y0 - 1, x0:x1].reshape(-1, 3), rgb[y1 + 1:y1 + 5, x0:x1].reshape(-1, 3)]
    colours = [np.median(strip, axis=0) for strip in strips]
    return (all(np.percentile(np.abs(strip - colour).max(axis=1), 90) <= 16 for strip, colour in zip(strips, colours))
            and np.abs(colours[0] - colours[1]).max() <= 12)


def enclosing(ink, inside):
    """The ink with what its outlines enclose inside the box, such as a fill as light as the background around it."""
    outside = np.pad(ink, 1).astype(np.uint8)
    cv2.floodFill(outside, None, (0, 0), 2)
    return (ink | ((outside[1:-1, 1:-1] == 0) & inside)).astype(np.uint8)


def side_strips(inside):
    """The columns just left and right of the box."""
    width = inside.shape[1]
    columns = np.flatnonzero(inside.any(axis=0))
    start, end = columns[0], columns[-1] + 1
    return slice(max(0, start - 8), max(0, start - 2)), slice(min(width, end + 2), min(width, end + 8))


def unlike_sides(crop, opacity, inside):
    """The pixels of each row of the box that match none of the colours beside the box on that row and the two
    rows above and below it, which on a band or a button the box covers whole are the band's own, shading
    included."""
    unlike = np.zeros(inside.shape, bool)
    for y in np.flatnonzero(inside.any(axis=1)):
        rows = slice(max(0, y - 2), y + 3)
        palette = np.concatenate([crop[rows, side][opacity[rows, side] >= 128] for side in side_strips(inside)])
        xs = np.flatnonzero(inside[y])
        unlike[y, xs] = (np.abs(crop[y, xs][:, None] - palette[None]).max(axis=2).min(axis=1) > 40
                         if len(palette) else True)
    return unlike


def letters_beside(image, guess, box, crop, opacity, inside):
    """Whether the letters' fill or outline is common beside the rows of the box given, as on a bubble whose rim
    the box reaches or a hint band whose landscape holds the outline's dark, so that matching the sides would keep
    the letters."""
    sides = side_strips(inside)
    found = ink_colours(image, Image.fromarray(guess.astype(np.uint8)), [box])
    beside = np.concatenate([crop[:, side][opacity[:, side] >= 128] for side in sides])
    # Beside text that reaches an icon's edge there is only art.
    if found is None or not len(beside) or any(side.stop - side.start < 6 for side in sides):
        return True
    return any((np.abs(beside - colour).max(axis=1) <= 40).mean() > 0.1 for colour in found[:2] if colour is not None)


def lettering_mask(image, polygons, grow):
    """The pixels of each polygon's lettering, grown, and small marks just past its end such as the last dots of
    an ellipsis. The lettering is what differs clearly from the polygon inpainted whole, which guesses the
    background under the text, together with what its outline encloses. Erasing only these keeps a band, a button
    or the art of an icon behind the text, which the inpainter would otherwise paint over with the artwork around
    it. Where that is most of the box, the box may cover a band or a button whole and the guess took the colours
    around it instead; the lettering is then what differs from the colours beside the box on its rows.

    Also the pixels the inpainter repaints to erase them. On a panel those are two more around the lettering,
    since the inpainter continues whatever faint edge it sees beside its mask, such as the last of a glow around
    letters, into shapes like the letters. On a band or a button, which ends just past the text, it needs to see
    every pixel of the band it can.

    Also, for each polygon that has such marks, a rectangle around them, which the game must copy back too."""
    rgb = np.asarray(composite(image)).astype(np.int16)
    height, width = rgb.shape[:2]
    whole = area_mask(polygons, grow, (width, height))
    guess = inpaint(rgb.astype(np.uint8), whole).astype(np.int16)
    # On see-through parts, lettering is also what is more opaque than the background guessed under it.
    opacity = np.asarray(image.convert("RGBA"))[:, :, 3]
    opaque = opacity.min() == 255
    if not opaque:
        guessed_opacity = inpaint(np.repeat(opacity[:, :, None], 3, axis=2), whole)[:, :, 0]
    result = np.zeros((height, width), np.uint8)
    repaint = np.zeros((height, width), np.uint8)
    tails = {}
    beside = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    for number, polygon in enumerate(polygons):
        area = area_mask([polygon], grow, (width, height))
        ys, xs = np.nonzero(area)
        if not len(xs):
            continue
        line = max(1, ys.max() - ys.min() - 2 * grow)
        x0, y0 = max(0, xs.min() - 2 * line), max(0, ys.min() - line)
        x1, y1 = min(width, xs.max() + 1 + 2 * line), min(height, ys.max() + 1 + line)
        crop = rgb[y0:y1, x0:x1]
        inside = area[y0:y1, x0:x1] > 0
        box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
        top, bottom = ys.min() + grow - y0, ys.max() + 1 - grow - y0
        ink = np.abs(crop - guess[y0:y1, x0:x1]).max(axis=2) > 32
        ink &= ~side_colours(crop, inside)
        if not opaque:
            ink |= opacity[y0:y1, x0:x1].astype(np.int16) - guessed_opacity[y0:y1, x0:x1] > 48
        # Gaps between a character's strokes go with it, so no bit of outline is left for the inpainter to grow.
        gap = max(3, line // 6) | 1
        ink = cv2.morphologyEx(ink.astype(np.uint8), cv2.MORPH_CLOSE,
                               cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (gap, gap))) > 0
        ink &= inside
        lettering = enclosing(ink, inside)
        share = lettering[inside].mean()
        if share >= 0.7:
            sided = enclosing(cv2.morphologyEx(
                unlike_sides(crop, opacity[y0:y1, x0:x1], inside).astype(np.uint8), cv2.MORPH_CLOSE,
                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (gap, gap))) > 0, inside)
            rest = inside & (sided == 0)
            # Big letters on art the guess got right, such as a name over sky, also take most of their box; there the
            # rest of the box matches the guess.
            wrong = (np.abs(crop - guess[y0:y1, x0:x1]).max(axis=2) > 32)[rest].mean() if rest.any() else 0
            if (0.15 <= sided[inside].mean() < share and wrong >= 0.5
                    and not letters_beside(image, guess, box, crop[top:bottom], opacity[y0:y1, x0:x1][top:bottom],
                                           inside[top:bottom])):
                lettering = sided
        # Marks the reader left out at the end of the line: on its rows, no larger than a dot, one after another.
        background = np.stack(
            [cv2.medianBlur(np.ascontiguousarray(crop[:, :, channel]).astype(np.uint8), odd(line)) for channel in range(3)],
            axis=2,
        ).astype(np.int16)
        difference = np.abs(crop - background).max(axis=2)
        marks = (difference > max(16, 0.25 * difference[inside].max())) & ~inside
        reach = xs.max() + 1 - grow - x0
        count, labels, stats, _ = cv2.connectedComponentsWithStats(marks.astype(np.uint8))
        for label in sorted(range(1, count), key=lambda label: stats[label, 0]):
            left, upper, w, h = stats[label, :4]
            if (
                left >= reach - grow and left - reach <= line / 2 and max(w, h) <= line / 3
                and upper >= top - grow and upper + h <= bottom + grow
            ):
                lettering[labels == label] = 1
                reach = left + w
                mx0, my0, mx1, my1 = int(x0 + left), int(y0 + upper), int(x0 + left + w), int(y0 + upper + h)
                tx0, ty0, _, ty1 = tails.get(number, (mx0, my0, mx1, my1))
                tails[number] = (min(tx0, mx0), min(ty0, my0), mx1, max(ty1, my1))
        margin = max(1, min(grow, round(line / 10)))
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * margin + 1, 2 * margin + 1))
        erased = cv2.dilate(lettering * 255, kernel)
        result[y0:y1, x0:x1] |= erased
        repaint[y0:y1, x0:x1] |= cv2.dilate(erased, beside) if on_panel(rgb, box) else erased
    marks = {number: [[tx0, ty0], [tx1, ty0], [tx1, ty1], [tx0, ty1]]
             for number, (tx0, ty0, tx1, ty1) in tails.items()}
    return result, repaint, marks


def circle_opacity(opacity, selected):
    """The opacity of an image whose outline is a circle, such as a round icon, continued under the selected pixels;
    None when the outline beside them isn't one. Where text reaches past a round icon's edge to the image's border,
    the inpainter has nothing beyond the border to go on and fills the icon's corner in opaque."""
    height, width = opacity.shape
    shape = opacity >= 128
    near = cv2.dilate(selected.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    contours, _ = cv2.findContours(shape.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return None
    points = np.concatenate(contours)[:, 0]
    xs, ys = points[:, 0], points[:, 1]
    points = points[~near[ys, xs] & (xs > 0) & (ys > 0) & (xs < width - 1) & (ys < height - 1)].astype(np.float64)
    if len(points) < 20:
        return None

    def fit(points):
        x, y = points[:, 0], points[:, 1]
        (d, e, f), *_ = np.linalg.lstsq(np.stack([x, y, np.ones_like(x)], 1), -(x * x + y * y), rcond=None)
        cx, cy = -d / 2, -e / 2
        # The outline's points are the shape's outermost pixels, whose centres lie half a pixel inside its edge.
        return cx, cy, np.sqrt(max(cx * cx + cy * cy - f, 0)) + 0.5

    cx, cy, radius = fit(points)
    # Art that pokes out of the rim pulls the first fit; the second leaves it out.
    off = np.abs(np.hypot(points[:, 0] - cx, points[:, 1] - cy) + 0.5 - radius)
    if (off <= 1.5).sum() >= 20:
        cx, cy, radius = fit(points[off <= 1.5])
    # A straight edge fits a huge circle about as well.
    if not (0 <= cx < width and 0 <= cy < height and radius <= max(width, height) / 2 + 2):
        return None
    ys, xs = np.mgrid[:height, :width].astype(np.float64)
    fitted = np.clip(radius - np.hypot(xs - cx, ys - cy) + 0.5, 0, 1)
    # A round icon with a toothed rim is off by under 2% of its area; plates, bubbles and portraits by 4.5% or more.
    mismatched = (((fitted >= 0.5) != shape) & ~near).sum()
    if mismatched > 0.025 * shape.sum() or mismatched > len(points):
        return None
    return fitted


def first_met(stop, values):
    """For each pixel, the value at the nearest stop at or left of it on its row, 255 where there is none."""
    height, width = stop.shape
    last = np.maximum.accumulate(np.where(stop, np.arange(width), -1), axis=1)
    return np.where(last >= 0, values[np.arange(height)[:, None], np.maximum(last, 0)], 255)


def enclosed_by_transparency(opacity, selected):
    """The selected pixels from which the first pixel going left, right, up and down, outside the selection or a
    fully transparent one inside it, is fully transparent each time, such as the rows between see-through text and a
    bar below it."""
    stop = ~selected | (opacity == 0)
    left = first_met(stop, opacity)
    right = first_met(stop[:, ::-1], opacity[:, ::-1])[:, ::-1]
    up = first_met(stop.T, opacity.T).T
    down = first_met(stop.T[:, ::-1], opacity.T[:, ::-1])[:, ::-1].T
    return selected & (np.maximum.reduce([left, right, up, down]) == 0)


def erase_image(image, mask, repaint=None):
    original = np.array(image)
    result = original.copy()
    selected = mask > 0
    if selected.any():
        result[selected, :3] = inpaint(original[:, :, :3], mask if repaint is None else repaint)[selected]
        if image.mode == "RGBA":
            circle = circle_opacity(original[:, :, 3], selected)
            if circle is None:
                alpha = inpaint(np.repeat(original[:, :, 3:4], 3, axis=2), mask)[:, :, 0]
                # Lettering is at least as opaque as the background it is drawn on. Beside a bar, the inpainter
                # continues the bar under see-through text as a haze.
                alpha = np.minimum(alpha, original[:, :, 3])
                alpha[enclosed_by_transparency(original[:, :, 3], selected)] = 0
            else:
                alpha = np.round(circle * 255)
            # Text on opaque artwork leaves it opaque; only text on see-through parts gets its see-through
            # background back, no more opaque than the pixels around it, since with little left around the
            # letters the inpainter guesses a haze.
            count, regions = cv2.connectedComponents(selected.astype(np.uint8))
            for region in range(1, count):
                inside = regions == region
                if (original[inside, 3] < 250).mean() > 0.01:
                    around = (cv2.dilate(inside.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & ~selected
                    most = np.percentile(original[around, 3], 90) if around.any() else 0
                    result[inside, 3] = np.minimum(alpha[inside], most)
    output = BytesIO()
    Image.fromarray(result).save(output, format="PNG")
    return output.getvalue()


@app.post("/erase")
async def erase(request: Request):
    body, data = await image_body(request)
    image = png(data)
    areas = body.get("areas")
    mask = area_mask(areas, body.get("grow", 4), image.size)
    if not areas:
        return Response(data, media_type="image/png")
    result = await run_in_threadpool(erase_image, image, mask)
    return Response(result, media_type="image/png")


def prepared_lines(value):
    if not isinstance(value, list):
        raise BadInput("lines must be a list")
    for line in value:
        if (
            not isinstance(line, dict) or not isinstance(line.get("text"), str)
            or not isinstance(line.get("box"), list) or len(line["box"]) != 4
            or any(type(v) is not int for v in line["box"])
            or not isinstance(line.get("polygon"), list)
        ):
            raise BadInput("Each line needs text, a polygon and a box of four integers")
    return value


def prepared_blocks(value, count):
    if not isinstance(value, list):
        raise BadInput("blocks must be a list of lists of line indices")
    seen = set()
    for block in value:
        if not isinstance(block, list) or not block:
            raise BadInput("Each block must list at least one line index")
        for index in block:
            if type(index) is not int or not 0 <= index < count or index in seen:
                raise BadInput("Each line index must be valid and used by one block only")
            seen.add(index)
    return value


def trimmed(image, lines, indices, language):
    """The lines with their boxes starting where the recognizer sees the first character, so art the reader took
    into a line's box, such as a face before the text, is neither erased nor drawn over. The end stays, since what
    follows the text there is more often part of it, such as the dots of an ellipsis."""
    rgb = np.asarray(composite(image))
    crops = [rgb[y0:y1, x0:x1][:, :, ::-1] for x0, y0, x1, y1 in (lines[index]["box"] for index in indices)]
    result = list(lines)
    for index, span in zip(indices, app.state.models.call(worker.spans, crops, recognizer(language))):
        x0, y0, x1, y1 = lines[index]["box"]
        if span is None or x1 - x0 < y1 - y0 or turned(lines[index]):
            continue
        first, _, pitch = span
        left = max(x0, int(x0 + first - 0.6 * (pitch if pitch else y1 - y0)))
        if x1 - left < y1 - y0 or left == x0:
            continue
        result[index] = {
            **lines[index], "box": [left, y0, x1, y1],
            "polygon": [[max(x, left), y] for x, y in lines[index]["polygon"]],
        }
    return result


def prepare_image(image, lines, blocks, grow, language=None):
    indices = [index for block in blocks for index in block]
    lines = list(lines)
    for index in indices:
        x0, y0, x1, y1 = lines[index]["box"]
        box = [max(0, x0), max(0, y0), min(image.width, x1), min(image.height, y1)]
        if box[0] >= box[2] or box[1] >= box[3]:
            raise BadInput("A block's line lies outside the image")
        lines[index] = {**lines[index], "box": box}
    lines = trimmed(image, lines, indices, language)
    areas = line_areas(lines, indices, image)
    polygons = [areas[index][1] for index in indices]
    mask, repaint, marks = lettering_mask(image, polygons, grow)
    data = erase_image(image, mask, repaint)
    erased = Image.open(BytesIO(data))
    erased.load()
    described = describe(image, erased, lines, blocks, areas)
    tails = {index: marks[number] for number, index in enumerate(indices) if number in marks}
    for block, members in zip(described, blocks):
        block["polygons"] += [tails[index] for index in members if index in tails]
    return data, described


@app.post("/prepare")
async def prepare(request: Request):
    body, data = await image_body(request)
    image = png(data)
    lines = prepared_lines(body.get("lines"))
    blocks = prepared_blocks(body.get("blocks"), len(lines))
    grow = body.get("grow", 4)
    area_mask([], grow, image.size)
    if not blocks:
        return {"erased": base64.b64encode(data).decode(), "blocks": []}
    erased, described = await run_in_threadpool(prepare_image, image, lines, blocks, grow, body.get("language"))
    return {"erased": base64.b64encode(erased).decode(), "blocks": described}
