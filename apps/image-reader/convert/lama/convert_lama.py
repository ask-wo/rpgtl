"""Downloads big-lama and converts it to ONNX: `python convert_lama.py <output folder>`."""
import hashlib
from pathlib import Path
import sys
import tempfile
import time
import urllib.error
import urllib.request

import torch

from lama import Lama

LAMA_URL = "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"
LAMA_MD5 = "e3aa4aaa15225a33ec84f9f4bc47e500"


def part(name):
    """Tells RPGTL, which runs this, the part of converting the models that starts now."""
    print(f"@rpgtl part {name}", flush=True)


def reporter():
    """Tells RPGTL how much of the download arrived, at most once a second."""
    last = 0.0

    def report(blocks, block_size, total):
        nonlocal last
        now = time.monotonic()
        done = min(blocks * block_size, total)
        if total > 0 and (now - last >= 1 or done == total):
            last = now
            print(f"@rpgtl bytes {done} {total}", flush=True)

    return report


def download(folder):
    path = folder / "big-lama.pt"
    part("lamaDownload")
    for wait in (10, 30, 60, None):
        try:
            urllib.request.urlretrieve(LAMA_URL, path, reporter())
            break
        except (urllib.error.URLError, TimeoutError) as error:
            if wait is None:
                sys.exit(f"Couldn't download the LaMa model from GitHub ({error}). Try again later.")
            print(f"Downloading the LaMa model failed ({error}); trying again in {wait} s.", flush=True)
            time.sleep(wait)
    with path.open("rb") as file:
        digest = hashlib.file_digest(file, "md5").hexdigest()
    if digest != LAMA_MD5:
        raise RuntimeError(f"LaMa checksum mismatch: expected {LAMA_MD5}, got {digest}")
    return path


def sample(height, width):
    image = torch.rand(1, 3, height, width, generator=torch.Generator().manual_seed(0))
    mask = torch.zeros(1, 1, height, width)
    mask[:, :, height // 3: height // 2, width // 4: 3 * width // 4] = 1
    return image, mask


def convert(source, target):
    part("lamaCheck")
    original = torch.jit.load(str(source), map_location="cpu").eval()
    model = Lama().eval()
    model.load_state_dict(original.state_dict(), strict=True)
    with torch.inference_mode():
        for size in ((256, 256), (624, 816)):
            difference = (original(*sample(*size)) - model(*sample(*size))).abs().max().item()
            if difference > 1e-4:
                raise RuntimeError(f"The rebuilt LaMa differs from big-lama.pt by {difference} at {size}")
    part("lamaExport")
    height, width = torch.export.Dim("height", min=8, max=4096), torch.export.Dim("width", min=8, max=4096)
    program = torch.onnx.export(
        model, sample(256, 256), dynamo=True, opset_version=20, input_names=["image", "mask"],
        output_names=["output"], dynamic_shapes={"image": {2: height, 3: width}, "mask": {2: height, 3: width}},
    )
    program.optimize()
    program.save(str(target))


def main(output):
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as folder:
        convert(download(Path(folder)), output / "lama.onnx")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
