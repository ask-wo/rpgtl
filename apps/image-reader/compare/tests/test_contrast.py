import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from lettering import contrasts


AREA = [[0, 0], [99, 0], [99, 39], [0, 39]]


def test_faint_watermark_and_dim_label_are_separated():
    for difference in (7, 12, 21, 200):
        image = Image.new("RGB", (100, 40), (30, 30, 30))
        ImageDraw.Draw(image).rectangle((20, 10, 70, 30), fill=(30 + difference,) * 3)
        assert contrasts(image, [AREA]) == [difference]


def test_thin_coloured_lettering_is_kept_even_at_similar_luminance():
    image = Image.new("RGB", (100, 40), (128, 128, 128))
    ImageDraw.Draw(image).line((20, 10, 20, 30), fill=(220, 100, 128))
    assert contrasts(image, [AREA]) == [92]


def test_pixels_outside_polygon_do_not_change_contrast():
    image = Image.new("RGB", (100, 40), (30, 30, 30))
    ImageDraw.Draw(image).rectangle((90, 0, 99, 39), fill="white")
    assert contrasts(image, [[[0, 0], [50, 0], [0, 39]]]) == [0]


def test_faint_transparent_text_keeps_its_opacity_contrast():
    image = Image.new("RGBA", (100, 40), (255, 255, 255, 0))
    ImageDraw.Draw(image).rectangle((20, 10, 70, 30), fill=(255, 255, 255, 20))
    assert contrasts(image, [AREA]) == [20]


def test_opacity_defined_text_is_kept_even_when_flattened_colour_matches():
    image = Image.new("RGBA", (100, 40), (128, 128, 128, 0))
    ImageDraw.Draw(image).rectangle((20, 10, 70, 30), fill=(128, 128, 128, 255))
    assert contrasts(image, [AREA]) == [255]


def test_uniformly_translucent_lettering_keeps_its_original_colour_contrast():
    image = Image.new("RGBA", (100, 40), (128, 128, 128, 20))
    ImageDraw.Draw(image).line((20, 10, 20, 30), fill=(160, 128, 128, 20))
    assert contrasts(image, [AREA]) == [32]


def test_unmeasurable_polygons_are_kept():
    image = Image.new("RGB", (100, 40), "black")
    assert contrasts(image, [[[200, 200], [220, 200], [220, 220]]]) == [255]
