"""Finding a game's folders and reading its images, without the reader service, so scripts run with the
reader's own Python can use it too."""
from io import BytesIO
import hashlib
import json
from pathlib import Path

from PIL import Image


def game_root(path):
    for parent in path.parents:
        if parent.name == "img":
            return parent.parent
    raise ValueError("Image is not under a game's img folder")


def web_root(game):
    """The game's folder of data and images, from the `games.json` of the state folder it lives in."""
    games = json.loads((game.parent.parent / "games.json").read_text())
    for listed in games:
        if listed["id"] == game.name:
            return Path(listed["webRoot"])
    raise ValueError(f"{game.parent.parent / 'games.json'} doesn't list the game {game.name}")


def load_image(path):
    data = path.read_bytes()
    if path.suffix.lower() in (".rpgmvp", ".png_"):
        if len(data) < 32 or not data.startswith(b"RPGMV"):
            raise ValueError("Invalid RPG Maker encrypted image header")
        system = json.loads((game_root(path) / "data/System.json").read_text(encoding="utf-8-sig"))
        try:
            key = bytes.fromhex(system["encryptionKey"])
        except (KeyError, ValueError, TypeError) as error:
            raise ValueError("Missing or invalid encryptionKey in data/System.json") from error
        if len(key) != 16:
            raise ValueError("encryptionKey must contain 16 bytes")
        data = bytes(value ^ key[index] for index, value in enumerate(data[16:32])) + data[32:]
    if not (data.startswith(b"\x89PNG\r\n\x1a\n") or data.startswith(b"\xff\xd8\xff")):
        raise ValueError("Decrypted image is neither PNG nor JPEG")
    image = Image.open(BytesIO(data))
    image.load()
    original_format = image.format
    alpha = "A" in image.getbands() or "transparency" in image.info
    image = image.convert("RGBA" if alpha else "RGB")
    return image, hashlib.sha256(data).hexdigest(), original_format


def game_image(game, name):
    """An image of a game's state folder (RPGTL_DIR/games/<id>) by its name in `images.json`, with its record."""
    record = json.loads((game / "images.json").read_text())["images"][name]
    image, _, _ = load_image(web_root(game) / record["file"])
    return image, record
