/** A text an XP game draws whole, with its English. */
export interface DrawnText {
  readonly source: string;
  readonly text: string;
}

const quoted = (text: string) => `'${text.replace(/[\\']/g, "\\$&")}'`;

/**
 * A script that draws the English of `texts` where an XP game draws one of their sources whole,
 * such as a label it takes from an event's name. It goes after the text fitting script, so the
 * English is what gets fitted. Games size a label's bitmap from its text before drawing it, so the
 * source measures as wide as its English at the smallest size text fitting draws, when that is
 * wider: a label laid out for a short source then grows only as much as the English needs to stay
 * readable, and crowds its neighbours less than at full size. Strings are compared as bytes: mkxp-z reads this script as binary
 * text while a game's own strings may be UTF-8, and Ruby 1.8, which `Game.exe` runs, has only
 * bytes.
 */
export const xpDrawnTextScript = (texts: ReadonlyArray<DrawnText>) => String.raw`class Bitmap
  def self.rpgtl_bytes(text)
    text.respond_to?(:force_encoding) ? text.dup.force_encoding("ASCII-8BIT") : text
  end

  RPGTL_DRAWN = {} unless defined?(RPGTL_DRAWN)
  [
${texts.map(({ source, text }) => `    [${quoted(source)}, ${quoted(text)}],`).join("\n")}
  ].each { |from, to| RPGTL_DRAWN[Bitmap.rpgtl_bytes(from)] = to }

  def self.rpgtl_drawn(text)
    english = text.is_a?(String) ? RPGTL_DRAWN[rpgtl_bytes(text)] : nil
    return text unless english
    english.respond_to?(:force_encoding) ? english.dup.force_encoding(text.encoding) : english
  end

  alias_method :rpgtl_drawn_draw_text, :draw_text unless method_defined?(:rpgtl_drawn_draw_text)
  alias_method :rpgtl_drawn_text_size, :text_size unless method_defined?(:rpgtl_drawn_text_size)

  def draw_text(*args)
    at = args[0].is_a?(Rect) ? 1 : 4
    args = args.dup
    args[at] = Bitmap.rpgtl_drawn(args[at])
    rpgtl_drawn_draw_text(*args)
  end

  def text_size(text)
    size = rpgtl_drawn_text_size(text)
    english = Bitmap.rpgtl_drawn(text)
    return size if english.equal?(text)
    was = font.size
    font.size = Bitmap.rpgtl_smallest(was)
    size.width = [size.width, rpgtl_drawn_text_size(english).width].max
    font.size = was
    size
  end
end
`;
