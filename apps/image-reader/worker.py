"""The reader's models, loaded in a process of their own so ending it frees their RAM and VRAM."""
import json

import numpy as np
import onnxruntime as ort

from models import DETECTION, LAMA, recognizer_files
from ocr import Ocr

options = providers = run_options = detector = lama = None
readers = {}


def load(device, threads):
    global options, providers, run_options, detector, lama
    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.intra_op_num_threads = threads
    run_options = ort.RunOptions()
    if device == "gpu":
        ort.preload_dlls()
        # ONNX Runtime's defaults keep every buffer it once allocated and let cuDNN take large workspaces, which
        # runs an 8 GB card out of memory on the second large image.
        providers = [("CUDAExecutionProvider", {
            "cudnn_conv_algo_search": "HEURISTIC",
            "cudnn_conv_use_max_workspace": "0",
            "arena_extend_strategy": "kSameAsRequested",
        })]
        run_options.add_run_config_entry("memory.enable_memory_arena_shrinkage", "gpu:0")
    elif device == "directml":
        # DirectML can't run with memory patterns or in parallel.
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        providers = ["DmlExecutionProvider"]
    else:
        providers = ["CPUExecutionProvider"]

    detector = session(DETECTION)
    lama = session(LAMA)


def session(path):
    return ort.InferenceSession(str(path), options, providers=providers)


def ocr(recognizer):
    if recognizer not in readers:
        model, characters = recognizer_files(recognizer)
        readers[recognizer] = Ocr(
            detector, session(model), json.loads(characters.read_text(encoding="utf-8")), run_options
        )
    return readers[recognizer]


def read(bgr, recognizer):
    return [{
        "text": line["text"], "score": line["score"],
        "polygon": np.rint(line["polygon"]).astype(int).tolist(),
        "box": [int(value) for value in line["box"]],
    } for line in ocr(recognizer).predict(bgr)]


def inpaint(rgb, mask):
    height, width = mask.shape
    padding = ((0, (-height) % 8), (0, (-width) % 8))
    padded_rgb = np.pad(rgb, (*padding, (0, 0)), mode="symmetric")
    padded_mask = np.pad(mask, padding, mode="symmetric")
    image = np.ascontiguousarray(padded_rgb.transpose(2, 0, 1))[None].astype(np.float32) / 255
    mask_input = np.ascontiguousarray(padded_mask)[None, None].astype(np.float32) / 255
    output = lama.run(None, {"image": image, "mask": mask_input}, run_options)[0][0].transpose(1, 2, 0)
    return np.clip(output[:height, :width] * 255, 0, 255).astype(np.uint8)


def spans(crops, recognizer):
    return ocr(recognizer).spans(crops)
