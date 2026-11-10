from html import escape
import json
from pathlib import Path
import shutil
import subprocess

from drawing import system_font


def number(value):
    return "—" if value is None else f"{value:.2f}"


def picture(path, label, small=False):
    return (f'<figure><figcaption>{escape(label)}</figcaption>'
            f'<a href="{escape(path)}"><img class="checker" src="{escape(path)}" alt="{escape(label)}"></a>'
            + (f'<img class="checker twice" src="{escape(path)}" alt="{escape(label)} at 2×">' if small else "")
            + "</figure>")


def write_report(out, report):
    try:
        font = system_font("Noto Sans CJK SC")
        copied = "cjk" + font.suffix
        shutil.copyfile(font, out / copied)
        font_style = f"@font-face{{font-family:PlainCJK;src:url('{copied}')}}"
    except (OSError, ValueError, subprocess.SubprocessError):
        font_style = ""
    parts = ["""<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Image text comparison</title><style>
body{font-family:system-ui,sans-serif;margin:24px;color:#20242c;background:#f5f6f8}
h1,h2,h3{line-height:1.2}section{background:white;padding:24px;margin:24px 0;border-radius:12px}
table{border-collapse:collapse;width:100%;background:white;margin:16px 0}th,td{border:1px solid #d9dce2;padding:10px;text-align:left;vertical-align:top}
.scroll{overflow-x:auto}.cjk{font-family:PlainCJK,'Noto Sans CJK SC',sans-serif;font-size:32px;display:inline-block;min-width:160px}
figure{margin:0;min-width:0}figcaption{font-weight:600;margin:8px 0}img{max-width:100%;height:auto}
.checker{background-color:#eee;background-image:conic-gradient(#bbb 25%,transparent 0 50%,#bbb 0 75%,transparent 0);background-size:20px 20px}
.pictures{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.crop{height:48px;max-width:none;width:auto}
.crop-view{width:320px;max-width:32vw;overflow-x:auto}
.twice{display:block;max-width:none;margin-top:12px;zoom:2}figure:has(.twice){overflow:auto}
.warning{background:#fff2d7;padding:12px;border-left:4px solid #b76c00}.muted{color:#626b7a}
.path{overflow-wrap:anywhere;font-size:13px}pre{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:850px){.pictures{grid-template-columns:1fr}body{margin:12px}section{padding:16px}}
""", font_style, "</style><h1>Image text comparison</h1>",
        "<p>Compare the crop’s shapes with each reader’s text. Blue outlines: Paddle; pink boxes: Qwen. "
        "Check for old text left after erasing, and compare English lettering in the game font and Noto Sans Bold. "
        "Images with small buttons also appear at 2×. Long crops scroll horizontally. Click any image to view its full size.</p>",
        '<div class="scroll"><table><tr><th>Image</th><th>Agree</th><th>Differ</th><th>Only Paddle</th>'
        '<th>Only Qwen</th><th>Mean IoU</th><th>Paddle read (s)</th><th>Qwen read (s)</th>'
        '<th>Erase (s)</th><th>Translation (s)</th><th>Qwen prompt tokens</th></tr>']
    for index, record in enumerate(report["images"]):
        name = escape(record["path"].split("/")[-1])
        parts.append(f'<tr><td><a href="#image-{index}">{name}</a></td>')
        if "error" in record:
            parts.append(f'<td colspan="10">{escape(record["error"])}</td></tr>')
            continue
        counts = record["counts"]
        for key in ("agree", "differ", "only_paddle", "only_qwen"):
            parts.append(f"<td>{counts[key]}</td>")
        parts.append(f"<td>{number(counts['mean_iou'])}</td>")
        for key in ("paddle_read", "qwen_read", "erase", "translation"):
            parts.append(f"<td>{number(record['timings'][key])}</td>")
        parts.append(f"<td>{escape(', '.join(map(str, record['prompt_tokens']))) or '—'}</td></tr>")
    calibration = report["calibration"]
    parts.extend(["</table></div><h2>Box calibration</h2>",
                  f'<p class="warning">{escape(calibration["note"])}</p>',
                  f'<p>Coordinates: {escape(calibration.get("coordinates") or "none")}</p>'])
    if calibration.get("scores"):
        parts.append("<table><tr><th>Coordinates</th><th>Fixture line</th><th>IoU with drawn box</th></tr>")
        for coordinates, scores in calibration["scores"].items():
            for score in scores:
                parts.append(f'<tr><td>{escape(coordinates)}</td><td>{escape(score["fixture"])}: '
                             f'{escape(score["text"])}</td><td>{number(score["iou"])}</td></tr>')
        parts.append("</table>")
    for index, record in enumerate(report["images"]):
        parts.append(f'<section id="image-{index}"><h2>{escape(record["path"].split("/")[-1])}</h2>'
                     f'<p class="path">{escape(record["path"])}</p>')
        if "error" in record:
            parts.append(f'<p class="warning">{escape(record["error"])}</p></section>')
            continue
        parts.append(f'<p>{record["size"][0]} × {record["size"][1]}, {record["mode"]}; decoded {record["format"]}</p>')
        for phase in (record.get("qwen", {}), record.get("qwen", {}).get("translation", {})):
            if phase.get("error"):
                parts.append(f'<p class="warning">{escape(phase["error"])}</p>')
        assets = record["assets"]
        small = record["size"][0] <= 300 and record["size"][1] <= 200
        parts.extend(['<div class="pictures">', picture(assets["original"], "Original", small),
                      picture(assets["boxes"], "Reader boxes", small), '</div>',
                      '<div class="scroll"><table><tr><th>Crop</th><th>Paddle text / score</th><th>Qwen text</th>'
                      '<th>Agree</th><th>IoU</th><th>English</th></tr>'])
        for row in record["rows"]:
            p, q = row["paddle"], row["qwen"]
            crop = f'<div class="crop-view"><img class="crop checker" src="{escape(row["crop"])}" alt="Original text crop"></div>' if row.get("crop") else 'No calibrated box'
            p_text = (f'<span class="cjk">{escape(p["text"])}</span><br>{p["score"]:.3f}' if p else '—')
            q_text = f'<span class="cjk">{escape(q["text"])}</span>' if q else '—'
            agree = '—' if row["agree"] is None else 'yes' if row["agree"] else 'no'
            translation = escape((p or {}).get("translation") or "—")
            parts.append(f'<tr><td>{crop}</td><td>{p_text}</td><td>{q_text}</td><td>{agree}</td>'
                         f'<td>{number(row["iou"])}</td><td>{translation}</td></tr>')
        parts.append('</table></div>')
        if record["low_score"]:
            parts.append('<h3>Paddle lines below 0.5 (excluded from counts)</h3><ul>')
            for line in record["low_score"]:
                parts.append(f'<li><span class="cjk">{escape(line["text"])}</span> {line["score"]:.3f}</li>')
            parts.append('</ul>')
        if record["mode"] == "RGBA":
            parts.append('<h3>Transparent-image backgrounds</h3><table><tr><th>RGB background</th><th>Lines ≥ 0.5</th><th>Mean score</th></tr>')
            for background, results in record["backgrounds"].items():
                parts.append(f'<tr><td>{background}</td><td>{results["count"]}</td><td>{number(results["mean_score"])}</td></tr>')
            parts.append('</table>')
        parts.append('<div class="pictures">')
        for variant, label in (("erased", "Erased"), ("game", "English: game font"), ("noto", "English: Noto Sans Bold")):
            if variant == "game" and "source" in record["fonts"].get(variant, {}):
                label += f' ({Path(record["fonts"][variant]["source"]).name})'
            if variant in assets:
                parts.append(picture(assets[variant], label, small))
            elif variant in record["fonts"]:
                parts.append(f'<p class="warning">{label}: {escape(record["fonts"][variant]["error"])}</p>')
        parts.append('</div><details><summary>Lettering colours and fonts</summary><pre>')
        parts.append(escape(json.dumps({"fonts": record["fonts"], "lines": [
            {"text": row["paddle"]["text"], "style": row["paddle"]["style"]}
            for row in record["rows"] if row["paddle"] and "style" in row["paddle"]
        ]}, ensure_ascii=False, indent=2)))
        parts.append('</pre></details></section>')
    parts.append('<p><a href="report.json">Full report JSON</a></p></html>')
    (out / "index.html").write_text("".join(parts))
