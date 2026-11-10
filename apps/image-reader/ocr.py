"""PP-OCR text detection and recognition on ONNX Runtime.

Ported from PaddleX 3.7's OCR pipeline (Copyright PaddlePaddle Authors, Apache License 2.0) with the settings
PaddleOCR used here: no orientation models, quad boxes. The constants are the pipeline's values, which override
those in the models' inference.yml. Reads match PaddleX's for the same model outputs only with OpenCV 4.10."""
import math

import cv2
import numpy as np
import pyclipper

LIMIT_SIDE = 64
MAX_SIDE = 4000
THRESH = 0.3
BOX_THRESH = 0.6
UNCLIP_RATIO = 1.5
MAX_CANDIDATES = 3000
MIN_SIZE = 3
REC_HEIGHT = 48
REC_MIN_WIDTH = 320
REC_MAX_WIDTH = 3200
REC_BATCH = 6
# ImageNet values in RGB order, applied to BGR channels as PaddleX does.
DET_ALPHA = np.array([1 / 255 / s for s in (0.229, 0.224, 0.225)], np.float32)
DET_BETA = np.array([-m / s for m, s in zip((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))], np.float32)


class Ocr:
    def __init__(self, detector, recognizer, characters, run_options=None):
        self.detector = detector
        self.recognizer = recognizer
        self.characters = ["blank", *characters, " "]
        self.run_options = run_options

    def predict(self, bgr):
        polygons = sort_boxes(self.detect(bgr))
        crops, kept = [], []
        for polygon in polygons:
            crop = rotate_crop(bgr, polygon)
            if crop.size > 0:
                crops.append(crop)
                kept.append(polygon)
        order = sorted(range(len(crops)), key=lambda i: crops[i].shape[1] / float(crops[i].shape[0]))
        texts = [None] * len(crops)
        for start in range(0, len(order), REC_BATCH):
            batch = order[start:start + REC_BATCH]
            for i, result in zip(batch, self.recognize([crops[i] for i in batch])):
                texts[i] = result
        return [
            {"text": text, "score": score, "polygon": polygon,
             "box": [polygon[:, 0].min(), polygon[:, 1].min(), polygon[:, 0].max(), polygon[:, 1].max()]}
            for (text, score), polygon in zip(texts, kept)
        ]

    def detect(self, bgr):
        height, width = bgr.shape[:2]
        image = bgr
        if height + width < 64:
            image = np.zeros((max(32, height), max(32, width), 3), np.uint8)
            image[:height, :width] = bgr
        image = resize_for_detection(image)
        x = (image.astype(np.float32) * DET_ALPHA + DET_BETA).transpose(2, 0, 1)[None]
        name = self.detector.get_inputs()[0].name
        pred = self.detector.run(None, {name: np.ascontiguousarray(x)}, self.run_options)[0][0, 0]
        return boxes_from_bitmap(pred, pred > THRESH, width, height)

    def recognize(self, crops):
        images = [resize_for_recognition(c) for c in crops]
        widest = max(i.shape[2] for i in images)
        x = np.stack([np.pad(i, ((0, 0), (0, 0), (0, widest - i.shape[2]))) for i in images])
        name = self.recognizer.get_inputs()[0].name
        preds = self.recognizer.run(None, {name: x}, self.run_options)[0]
        indices, probabilities = preds.argmax(axis=-1), preds.max(axis=-1)
        results = []
        for index, probability in zip(indices, probabilities):
            keep = np.ones(len(index), bool)
            keep[1:] = index[1:] != index[:-1]
            keep &= index != 0
            text = "".join(self.characters[i] for i in index[keep])
            results.append((text, float(np.mean(probability[keep])) if keep.any() else 0.0))
        return results


    def spans(self, crops):
        """Where each crop's text starts and ends: the x of the first and last character's middle and the
        distance between characters' middles, from where the recognizer saw them. None for a crop it reads no
        text in."""
        results = []
        for crop in crops:
            image = resize_for_recognition(crop)
            name = self.recognizer.get_inputs()[0].name
            index = self.recognizer.run(None, {name: image[None]}, self.run_options)[0][0].argmax(axis=-1)
            starts = [t for t in range(len(index)) if index[t] != 0 and (t == 0 or index[t] != index[t - 1])]
            if not starts:
                results.append(None)
                continue
            # Each step covers an equal part of the resized width, of which the crop fills the first part.
            used = min(image.shape[2], int(math.ceil(REC_HEIGHT * crop.shape[1] / float(crop.shape[0]))))
            scale = image.shape[2] / len(index) * crop.shape[1] / used
            middles = [(t + 0.5) * scale for t in starts]
            pitch = (middles[-1] - middles[0]) / (len(middles) - 1) if len(middles) > 1 else None
            results.append((middles[0], middles[-1], pitch))
        return results


def resize_for_detection(image):
    height, width = image.shape[:2]
    ratio = LIMIT_SIDE / min(height, width) if min(height, width) < LIMIT_SIDE else 1.0
    resized_height, resized_width = int(height * ratio), int(width * ratio)
    if max(resized_height, resized_width) > MAX_SIDE:
        ratio = MAX_SIDE / max(resized_height, resized_width)
        resized_height, resized_width = int(resized_height * ratio), int(resized_width * ratio)
    resized_height = max(int(round(resized_height / 32) * 32), 32)
    resized_width = max(int(round(resized_width / 32) * 32), 32)
    if (resized_height, resized_width) == (height, width):
        return image
    return cv2.resize(image, (resized_width, resized_height))


def resize_for_recognition(crop):
    height, width = crop.shape[:2]
    target = int(REC_HEIGHT * max(REC_MIN_WIDTH / REC_HEIGHT, width / height))
    if target > REC_MAX_WIDTH:
        resized, resized_width, target = cv2.resize(crop, (REC_MAX_WIDTH, REC_HEIGHT)), REC_MAX_WIDTH, REC_MAX_WIDTH
    else:
        resized_width = min(target, int(math.ceil(REC_HEIGHT * width / float(height))))
        resized = cv2.resize(crop, (resized_width, REC_HEIGHT))
    normalised = (resized.astype(np.float32).transpose(2, 0, 1) / 255 - 0.5) / 0.5
    padded = np.zeros((3, REC_HEIGHT, target), np.float32)
    padded[:, :, :resized_width] = normalised
    return padded


def boxes_from_bitmap(pred, bitmap, dest_width, dest_height):
    height, width = bitmap.shape
    contours, _ = cv2.findContours((bitmap * 255).astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours[:MAX_CANDIDATES]:
        points, short_side = mini_box(contour)
        if short_side < MIN_SIZE:
            continue
        points = np.array(points)
        if box_score(pred, points.reshape(-1, 2)) < BOX_THRESH:
            continue
        box, short_side = mini_box(unclip(points).reshape(-1, 1, 2))
        if short_side < MIN_SIZE + 2:
            continue
        box = np.array(box)
        box[:, 0] = np.clip(np.round(box[:, 0] * dest_width / width), 0, dest_width)
        box[:, 1] = np.clip(np.round(box[:, 1] * dest_height / height), 0, dest_height)
        boxes.append(box.astype(np.int16))
    return boxes


def unclip(box):
    distance = cv2.contourArea(box) * UNCLIP_RATIO / cv2.arcLength(box, True)
    offset = pyclipper.PyclipperOffset()
    offset.AddPath(box, pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
    return np.array(offset.Execute(distance))


def mini_box(contour):
    rect = cv2.minAreaRect(contour)
    points = sorted(list(cv2.boxPoints(rect)), key=lambda p: p[0])
    first, fourth = (0, 1) if points[1][1] > points[0][1] else (1, 0)
    second, third = (2, 3) if points[3][1] > points[2][1] else (3, 2)
    return [points[first], points[second], points[third], points[fourth]], min(rect[1])


def box_score(bitmap, box):
    height, width = bitmap.shape[:2]
    box = box.copy()
    xmin = max(0, min(math.floor(box[:, 0].min()), width - 1))
    xmax = max(0, min(math.ceil(box[:, 0].max()), width - 1))
    ymin = max(0, min(math.floor(box[:, 1].min()), height - 1))
    ymax = max(0, min(math.ceil(box[:, 1].max()), height - 1))
    mask = np.zeros((ymax - ymin + 1, xmax - xmin + 1), np.uint8)
    box[:, 0] -= xmin
    box[:, 1] -= ymin
    cv2.fillPoly(mask, box.reshape(1, -1, 2).astype(np.int32), 1)
    return cv2.mean(bitmap[ymin:ymax + 1, xmin:xmax + 1], mask)[0]


def sort_boxes(boxes):
    boxes = sorted(boxes, key=lambda b: (b[0][1], b[0][0]))
    for i in range(len(boxes) - 1):
        for j in range(i, -1, -1):
            if abs(boxes[j + 1][0][1] - boxes[j][0][1]) < 10 and boxes[j + 1][0][0] < boxes[j][0][0]:
                boxes[j], boxes[j + 1] = boxes[j + 1], boxes[j]
            else:
                break
    return boxes


def rotate_crop(image, polygon):
    box, _ = mini_box(np.array(polygon).astype(np.int32))
    points = np.array(box, np.float32)
    crop_width = int(max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])))
    crop_height = int(max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])))
    target = np.float32([[0, 0], [crop_width, 0], [crop_width, crop_height], [0, crop_height]])
    crop = cv2.warpPerspective(image, cv2.getPerspectiveTransform(points, target), (crop_width, crop_height),
                               borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
    if crop.shape[0] / crop.shape[1] >= 1.5:
        crop = np.rot90(crop)
    return crop
