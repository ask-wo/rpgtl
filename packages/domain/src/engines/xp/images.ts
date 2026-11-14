import { dump } from "@hyrious/marshal";

/**
 * The folder below an XP game's folder that holds what RPGTL adds for its images: the tiles of
 * each image with English in it, and the table of where they go.
 */
export const xpImageFolder = "Graphics/RPGTL";

/** The table of lettered images, which the image script reads with `load_data`. */
export const xpImageTableFile = `${xpImageFolder}/Images.rxdata`;

/** An image of an XP game with English drawn in, as the tiles that differ from the game's image. */
export interface XpLetteredImage {
  /** The image's path without extension, such as `Graphics/Pictures/Sign`. */
  readonly image: string;
  /** The tiles' PNG file below the game's folder, without extension. */
  readonly tiles: string;
  /**
   * Five numbers per tile: where it goes in the image (x, y), how far down the tiles' file it
   * starts, and its width and height.
   */
  readonly places: ReadonlyArray<number>;
}

// The script lowers only ASCII letters, as Ruby 1.8's `downcase` does and Ruby 3's, in mkxp-z,
// doesn't, so the table's names must be lowered the same way.
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * `Images.rxdata`: a Hash from each image's lower-case path to its tiles' file and places.
 * Strings are bytes, as RGSS1's Ruby 1.8 reads them.
 */
export function xpImageTable(images: ReadonlyArray<XpLetteredImage>) {
  const table = new Map<Uint8Array, unknown>();
  for (const { image, tiles, places } of images)
    table.set(bytes(asciiLower(image)), [bytes(tiles), [...places]]);
  return dump(table);
}

/**
 * A script that draws the English into the images of an XP game: when a bitmap is made from a file
 * that `Images.rxdata` lists, it clears the places of that image's tiles and copies the tiles in.
 * `RPG::Cache` keeps the bitmaps it makes, so each image is lettered once until the game drops it.
 * It goes before the text fitting script, so its `blt` and `fill_rect` come before that
 * script wraps them. A
 * missing table or tiles file leaves the images as they are. It is written for Ruby 1.8, which
 * `Game.exe` runs, and later.
 */
export const xpImageScript = String.raw`class Bitmap
  unless private_method_defined?(:rpgtl_image_initialize)
    alias_method :rpgtl_image_initialize, :initialize
    alias_method :rpgtl_image_blt, :blt
    alias_method :rpgtl_image_fill_rect, :fill_rect
  end

  def self.rpgtl_lettered
    if $rpgtl_lettered.nil?
      $rpgtl_lettered = begin
        load_data("${xpImageTableFile}")
      rescue StandardError
        {}
      end
    end
    $rpgtl_lettered
  end

  def initialize(*args)
    rpgtl_image_initialize(*args)
    rpgtl_letter(args[0]) if args.size == 1 && args[0].is_a?(String)
  end

  def rpgtl_letter(file)
    key = file.tr("\\", "/").sub(/\A\.\//, "").sub(/\.(png|jpe?g)\z/i, "").tr("A-Z", "a-z")
    found = Bitmap.rpgtl_lettered[key]
    return if found.nil?
    tiles = Bitmap.new(found[0])
    clear = Color.new(0, 0, 0, 0)
    places = found[1]
    at = 0
    while at + 5 <= places.size
      x, y, top, width, height = places[at, 5]
      rpgtl_image_fill_rect(x, y, width, height, clear)
      rpgtl_image_blt(x, y, tiles, Rect.new(0, top, width, height))
      at += 5
    end
    tiles.dispose
  rescue StandardError
    nil
  end
end
`;
