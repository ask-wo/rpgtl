import argparse
import base64
from difflib import SequenceMatcher
from io import BytesIO
import json
from pathlib import Path
import sys
import subprocess
import time

import httpx
from fontTools.ttLib import TTLibError
from PIL import Image, ImageDraw, UnidentifiedImageError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from drawing import draw_variant, game_font, open_font, png_bytes, system_font  # noqa: E402
from lettering import cjk, colours, composite, groups, kept_prefix, line_areas, normalise, text_area  # noqa: E402
from erase import compare_erases, listed_images  # noqa: E402
from games import game_root, load_image  # noqa: E402
from report import write_report  # noqa: E402

MODEL = "qwen3.6:35b-a3b-q4_K_M"
FIXTURES = Path(__file__).resolve().parents[1] / "tests/fixtures"
START = "see docs/testing.md (Image reader)"
LINE_SCHEMA = {
    "type": "object", "required": ["lines"], "additionalProperties": False,
    "properties": {"lines": {"type": "array", "items": {
        "type": "object", "required": ["text", "bbox_2d"], "additionalProperties": False,
        "properties": {"text": {"type": "string"}, "bbox_2d": {
            "type": "array", "items": {"type": "integer"}, "minItems": 4, "maxItems": 4,
        }},
    }}},
}
READ_PROMPT = (
    "Read every piece of text in this image exactly, including Chinese and Latin text. "
    "Return one entry per visual line, in reading order, with text and bbox_2d [left, top, right, bottom]. "
    "Give bounding boxes in coordinates from 0 to 1000 relative to the full image. "
    "Do not translate, explain, or omit repeated button states."
)


class ServiceError(RuntimeError):
    pass


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def iou(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    area_a = max(0, a[2] - a[0]) * max(0, a[3] - a[1])
    area_b = max(0, b[2] - b[0]) * max(0, b[3] - b[1])
    return intersection / (area_a + area_b - intersection) if area_a + area_b > intersection else 0.0


def box_pixels(box, size, coordinates):
    if coordinates == "relative-1000":
        return [round(value * size[index % 2] / 1000) for index, value in enumerate(box)]
    return list(box)


def without_icons(text):
    """Drop icons and bullets the translator copied; the image keeps its own."""
    if text is None:
        return None
    start = 0
    while start < len(text) and not ((text[start].isascii() and text[start].isalnum()) or text[start] in "\"'(“‘"):
        start += 1
    return text[start:]


def erased_lines(lines):
    return [line for line in lines if line["score"] >= 0.5 and cjk(line["text"])]


def match(paddle, qwen, coordinates):
    """Pair lines with the same or nearly the same text first, nearest box first, then by box overlap."""
    def distance(p, q):
        if not coordinates:
            return 0
        return abs(p["box"][0] + p["box"][2] - q["box"][0] - q["box"][2]) + abs(p["box"][1] + p["box"][3] - q["box"][1] - q["box"][3])

    candidates = []
    for pi, p in enumerate(paddle):
        for qi, q in enumerate(qwen):
            similarity = SequenceMatcher(None, normalise(p["text"]), normalise(q["text"])).ratio()
            overlap = iou(p["box"], q["box"]) if coordinates else None
            candidates.append((similarity, overlap, distance(p, q), pi, qi))
    by_text = sorted((item for item in candidates if item[0] >= 0.8), key=lambda item: (-item[0], item[2]))
    by_box = sorted((item for item in candidates if item[1] is not None and item[1] >= 0.3), key=lambda item: -item[1])
    rows = []
    remaining_p = set(range(len(paddle)))
    remaining_q = set(range(len(qwen)))
    for _, overlap, _, pi, qi in [*by_text, *by_box]:
        if pi not in remaining_p or qi not in remaining_q:
            continue
        remaining_p.remove(pi)
        remaining_q.remove(qi)
        rows.append({"paddle": paddle[pi], "qwen": qwen[qi], "iou": overlap,
                     "agree": normalise(paddle[pi]["text"]) == normalise(qwen[qi]["text"])})
    rows.extend({"paddle": paddle[index], "qwen": None, "iou": None, "agree": None} for index in sorted(remaining_p))
    rows.extend({"paddle": None, "qwen": qwen[index], "iou": None, "agree": None} for index in sorted(remaining_q))
    return sorted(rows, key=lambda row: (row["paddle"] or row["qwen"]).get("box", [0, 0])[1])


def call(client, route, start_message, **kwargs):
    started = time.monotonic()
    try:
        response = client.post(route, **kwargs)
        response.raise_for_status()
    except (httpx.TransportError, httpx.HTTPStatusError) as error:
        raise ServiceError(f"{route} failed: {error}. {start_message}") from error
    return response, time.monotonic() - started


def paddle_phase(client, image):
    backgrounds = ["128,128,128", "0,0,0", "255,255,255"] if image.mode == "RGBA" else ["128,128,128"]
    reads = {}
    data = png_bytes(image)
    for background in backgrounds:
        response, seconds = call(client, "/read", f"Start the reader: {START}; or use --readers qwen",
                                 params={"background": background}, content=data,
                                 headers={"Content-Type": "image/png"})
        reads[background] = {**response.json(), "seconds": seconds}
    erased = erased_lines(reads[backgrounds[0]]["lines"])
    areas = [polygon for _, polygon in line_areas(erased, range(len(erased)), image).values()]
    response, seconds = call(client, "/erase", f"Start the reader: {START}", json={
        "image": base64.b64encode(data).decode(), "areas": areas,
    })
    return {"reads": reads, "erase_seconds": seconds, "erased": base64.b64encode(response.content).decode()}


def validate_lines(answer):
    if not isinstance(answer, dict) or not isinstance(answer.get("lines"), list):
        return False
    for line in answer["lines"]:
        if not isinstance(line, dict) or not isinstance(line.get("text"), str):
            return False
        box = line.get("bbox_2d")
        if not isinstance(box, list) or len(box) != 4 or any(type(v) is not int for v in box):
            return False
        if box[0] >= box[2] or box[1] >= box[3]:
            return False
    return True


def chat(client, prompt, schema, valid, image=None):
    message = {"role": "user", "content": prompt}
    if image is not None:
        message["images"] = [base64.b64encode(png_bytes(composite(image))).decode()]
    requests = []
    for attempt in range(2):
        response, seconds = call(client, "/api/chat", "Start Ollama with the Qwen model; or use --readers paddle", json={
            "model": MODEL, "stream": False, "think": False, "format": schema,
            "options": {"temperature": 0, "num_ctx": 8192}, "messages": [message],
        })
        raw = response.json()
        content = raw.get("message", {}).get("content", "")
        requests.append({"content": content, "seconds": seconds, "prompt_tokens": raw.get("prompt_eval_count", 0),
                         "output_tokens": raw.get("eval_count", 0)})
        try:
            answer = json.loads(content)
            if valid(answer):
                return {"answer": answer, "requests": requests}
        except (json.JSONDecodeError, TypeError):
            pass
    return {"answer": None, "requests": requests, "error": "Qwen answer invalid"}


def calibrate(client):
    drawn = json.loads((FIXTURES / "fixtures.json").read_text())
    fixtures = {}
    for name in ("menu.png", "logo.png"):
        image = Image.open(FIXTURES / name)
        fixtures[name] = {"size": list(image.size), **chat(client, READ_PROMPT, LINE_SCHEMA, validate_lines, image)}
    scores = {}
    for coordinates in ("absolute-pixels", "relative-1000"):
        entries = []
        for name, result in fixtures.items():
            available = list((result["answer"] or {}).get("lines", []))
            for line in drawn[name]:
                found = next((item for item in available if normalise(item["text"]) == normalise(line["text"])), None)
                overlap = 0.0
                if found:
                    available.remove(found)
                    overlap = iou(line["box"], box_pixels(found["bbox_2d"], result["size"], coordinates))
                entries.append({"fixture": name, "text": line["text"], "iou": overlap})
        scores[coordinates] = entries
    chosen = next((name for name, entries in scores.items() if all(item["iou"] >= 0.5 for item in entries)), None)
    return {"coordinates": chosen, "scores": scores, "fixtures": fixtures,
            "note": "Boxes calibrated against generated fixtures" if chosen else
            "Qwen boxes are unusable: matching by text alone in reading order; Qwen-only lines have no crop."}


def game_path(path):
    try:
        return str(path.relative_to(game_root(path)))
    except ValueError:
        return path.name


def qwen_phase(client, image, paddle, path):
    result = chat(client, READ_PROMPT, LINE_SCHEMA, validate_lines, image)
    all_lines = paddle.get("reads", {}).get("128,128,128", {}).get("lines", [])
    erased = erased_lines(all_lines)
    if erased:
        schema = {"type": "object", "required": ["translations"], "additionalProperties": False,
                  "properties": {"translations": {"type": "array", "items": {"type": "string"},
                                                    "minItems": len(erased), "maxItems": len(erased)}}}
        prompt = (
            f"This text is drawn in the RPG Maker game image {game_path(path)}. "
            "Translate the numbered Chinese lines into English that replaces the Chinese in the same space. "
            "When a line is a menu or button label, use the short label English games usually use for that "
            "command, such as New Game, Continue, Load, Options or Credits, not a literal translation. "
            "Icons and bullets before a line stay in the image and are left out of the numbered lines. "
            "Return exactly one translation per numbered line in the same order. "
            "Other text on the screen is context only.\nContext: " + json.dumps(
                [line["text"] for line in all_lines], ensure_ascii=False
            ) + "\nNumbered lines:\n" + "\n".join(
                f"{i + 1}. {line['text'][len(kept_prefix(line['text'])):].strip()}" for i, line in enumerate(erased)
            )
        )
        def valid(answer):
            return (isinstance(answer, dict) and isinstance(answer.get("translations"), list)
                    and len(answer["translations"]) == len(erased)
                    and all(isinstance(text, str) for text in answer["translations"]))
        result["translation"] = chat(client, prompt, schema, valid)
    return result


def draw_phase(record, image, out, calibration):
    paddle = record.get("paddle", {})
    qwen = record.get("qwen", {})
    lines = paddle.get("reads", {}).get("128,128,128", {}).get("lines", [])
    erasable = erased_lines(lines)
    translations = (qwen.get("translation", {}).get("answer") or {}).get("translations", [])
    assets = out / "images"
    assets.mkdir(exist_ok=True)
    prefix = record["sha256"]
    image.save(assets / f"{prefix}-original.png")
    record["assets"] = {"original": f"images/{prefix}-original.png"}
    erased = Image.open(BytesIO(base64.b64decode(paddle["erased"]))) if paddle else None
    if erased:
        erased.save(assets / f"{prefix}-erased.png")
        record["assets"]["erased"] = f"images/{prefix}-erased.png"
        for index, line in enumerate(erasable):
            line["area"] = text_area(line, image)
            line["lineHeight"] = line["box"][3] - line["box"][1]
            line["translation"] = translations[index] if index < len(translations) else None
            first = next(other for other in erasable if normalise(other["text"]) == normalise(line["text"]))
            line["translation"] = without_icons(first.get("translation", line["translation"]))
            icon = kept_prefix(line["text"]).strip()
            if icon and line["translation"] and line["translation"].startswith(icon + " "):
                line["translation"] = line["translation"][len(icon):].strip()
        for group in groups(erasable, same_text=False):
            style = colours(image, erased, [erasable[index]["area"] for index in group])
            for index in group:
                erasable[index]["style"] = style
    record["fonts"] = {}
    if erased:
        for variant, find in (("game", lambda: game_font(Path(record["path"]))),
                              ("noto", lambda: system_font("Noto Sans:bold"))):
            try:
                source = find()
                font, converted = open_font(source, out)
                drawn = draw_variant(erased, erasable, font, lines, groups(erasable, same_text=True))
                name = f"images/{prefix}-{variant}.png"
                drawn.save(out / name)
                record["assets"][variant] = name
                record["fonts"][variant] = {"source": str(source), "used": str(font), "converted": converted}
            except (OSError, ValueError, KeyError, TTLibError, subprocess.SubprocessError) as error:
                record["fonts"][variant] = {"error": str(error)}
    record["low_score"] = [line for line in lines if line["score"] < 0.5]
    coordinates = calibration.get("coordinates")
    q_lines = []
    for raw in (qwen.get("answer") or {}).get("lines", []):
        line = dict(raw)
        if coordinates:
            line["box"] = box_pixels(raw["bbox_2d"], image.size, coordinates)
        q_lines.append(line)
    rows = match([line for line in lines if line["score"] >= 0.5], q_lines, coordinates)
    for index, row in enumerate(rows):
        box = (row["paddle"] or row["qwen"]).get("box")
        if box:
            bounded = [max(0, box[0]), max(0, box[1]), min(image.width, box[2]), min(image.height, box[3])]
            if bounded[0] < bounded[2] and bounded[1] < bounded[3]:
                name = f"images/{prefix}-crop-{index}.png"
                image.crop(bounded).save(out / name)
                row["crop"] = name
    boxes = image.copy()
    draw = ImageDraw.Draw(boxes)
    for line in lines:
        draw.polygon([tuple(point) for point in line["polygon"]], outline="#00a9ff", width=2)
    for line in q_lines:
        if "box" in line:
            draw.rectangle(line["box"], outline="#ff40bb", width=2)
    name = f"images/{prefix}-boxes.png"
    boxes.save(out / name)
    record["assets"]["boxes"] = name
    record["rows"] = rows
    overlaps = [row["iou"] for row in rows if row["iou"] is not None]
    record["counts"] = {
        "agree": sum(row["agree"] is True for row in rows), "differ": sum(row["agree"] is False for row in rows),
        "only_paddle": sum(row["qwen"] is None for row in rows),
        "only_qwen": sum(row["paddle"] is None for row in rows),
        "mean_iou": sum(overlaps) / len(overlaps) if overlaps else None,
    }
    record["backgrounds"] = {}
    for background, read in paddle.get("reads", {}).items():
        confident = [line for line in read["lines"] if line["score"] >= 0.5]
        record["backgrounds"][background] = {"count": len(confident), "mean_score":
            sum(line["score"] for line in confident) / len(confident) if confident else None}
    record["timings"] = {
        "paddle_read": sum(read["seconds"] for read in paddle.get("reads", {}).values()),
        "erase": paddle.get("erase_seconds", 0),
        "qwen_read": sum(request["seconds"] for request in qwen.get("requests", [])),
        "translation": sum(request["seconds"] for request in qwen.get("translation", {}).get("requests", [])),
    }
    record["prompt_tokens"] = [request["prompt_tokens"] for request in qwen.get("requests", [])]


def main():
    parser = argparse.ArgumentParser(description="Compare local image readers and trial English lettering")
    parser.add_argument("images", nargs="*")
    parser.add_argument("--list", type=Path,
                        help="a file of image paths, one per line; with --erase, of `<game id> <image name>` lines "
                             "naming the only images to erase again")
    parser.add_argument("--out", type=Path, default=Path(".verify/image-text/compare"))
    parser.add_argument("--readers", default="paddle,qwen")
    parser.add_argument("--redo", choices=["paddle", "qwen", "draw"])
    parser.add_argument("--erase", type=Path, nargs="+", metavar="GAME_STATE",
                        help="prepare the saved images of one or more games' state folders (RPGTL_DIR/games/<id>) "
                             "again and compare each erase with the saved one")
    parser.add_argument("--only", action="append", default=[], metavar="PREFIX",
                        help="with --erase, only images whose name starts with this, such as img/menus/")
    parser.add_argument("--skip", action="append", default=[], metavar="TEXT",
                        help="with --erase, leave out images whose name contains this, such as a game's dialog boxes")
    parser.add_argument("--baseline", metavar="URL",
                        help="with --erase, compare with what a second reader at this address erases, such as one "
                             "started by reader_at.sh, instead of with the saved erase")
    parser.add_argument("--pixels", action="store_true",
                        help="with --erase and --baseline, compare the two erases pixel by pixel and show every image "
                             "where they differ, cut to the difference in the sheets")
    parser.add_argument("--min-change", type=float,
                        help="with --erase, show only images where more than this share of pixels is erased by only "
                             "one of the two erases (default 0.05), or with --pixels differs (default 0)")
    args = parser.parse_args()
    if args.pixels and not args.baseline:
        parser.error("--pixels needs --baseline: the saved erase may come from another device or version")
    if args.erase:
        minimum = args.min_change if args.min_change is not None else 0 if args.pixels else 0.05
        compare_erases([game.resolve() for game in args.erase], args.out, args.only, args.skip, minimum,
                       args.baseline, listed_images(args.list) if args.list else None, args.pixels)
        return
    readers = set(args.readers.split(","))
    if not readers or not readers <= {"paddle", "qwen"}:
        parser.error("--readers must be paddle, qwen, or paddle,qwen")
    paths = list(args.images)
    if args.list:
        paths.extend(line.strip() for line in args.list.read_text().splitlines() if line.strip())
    if not paths:
        parser.error("Supply image files or --list")
    args.out.mkdir(parents=True, exist_ok=True)
    cache = args.out / "cache"
    cache.mkdir(exist_ok=True)
    records, loaded = [], []
    for path_string in paths:
        path = Path(path_string).resolve()
        record = {"path": str(path)}
        records.append(record)
        try:
            image, digest, original_format = load_image(path)
            record.update(sha256=digest, size=list(image.size), mode=image.mode, format=original_format)
            loaded.append((record, image))
        except (OSError, ValueError, UnidentifiedImageError) as error:
            record["error"] = str(error)
    calibration = {"coordinates": None, "note": "Qwen reader not selected"}
    qwen_used = False
    with httpx.Client(base_url="http://127.0.0.1:5001", timeout=300, follow_redirects=False) as paddle_client, \
         httpx.Client(base_url="http://127.0.0.1:11434", timeout=300, follow_redirects=False) as qwen_client:
        try:
            for phase in ("paddle", "qwen"):
                if phase not in readers:
                    continue
                if phase == "qwen" and loaded:
                    calibration_path = cache / "calibration.json"
                    if calibration_path.exists() and args.redo != "qwen":
                        calibration = json.loads(calibration_path.read_text())
                    elif args.redo != "draw":
                        print("Qwen: calibrating on generated fixtures", flush=True)
                        qwen_used = True
                        calibration = calibrate(qwen_client)
                        save_json(calibration_path, calibration)
                    else:
                        raise ValueError("No calibration cache; run without --redo draw first")
                for index, (record, image) in enumerate(loaded):
                    filename = cache / f"{record['sha256']}-{phase}.json"
                    cached = json.loads(filename.read_text()) if filename.exists() else None
                    needs_translation = phase == "qwen" and "paddle" in record and bool(
                        erased_lines(record["paddle"]["reads"]["128,128,128"]["lines"]))
                    reusable = cached is not None and (not needs_translation or "translation" in cached)
                    if reusable and args.redo != phase:
                        record[phase] = cached
                    elif args.redo != "draw":
                        print(f"{phase} {index + 1}/{len(loaded)}: {Path(record['path']).name}", flush=True)
                        if phase == "paddle":
                            record[phase] = paddle_phase(paddle_client, image)
                            dependent = cache / f"{record['sha256']}-qwen.json"
                            if args.redo == "paddle" and dependent.exists():
                                dependent.unlink()
                        else:
                            qwen_used = True
                            record[phase] = qwen_phase(qwen_client, image, record.get("paddle", {}), Path(record["path"]))
                        save_json(filename, record[phase])
                    else:
                        raise ValueError(f"Missing {phase} cache for {record['path']}; run without --redo draw first")
            for record, image in loaded:
                draw_phase(record, image, args.out, calibration)
                save_json(cache / f"{record['sha256']}-draw.json", record)
            report = {"model": MODEL, "readers": sorted(readers), "calibration": calibration, "images": records}
            save_json(args.out / "report.json", report)
            write_report(args.out, report)
            print(args.out / "index.html", flush=True)
        finally:
            if qwen_used:
                call(qwen_client, "/api/generate", f"Unload {MODEL} with ollama stop {MODEL}",
                     json={"model": MODEL, "keep_alive": 0})


if __name__ == "__main__":
    try:
        main()
    except (ServiceError, ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
