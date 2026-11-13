/**
 * A script that fits English into the space an XP game gives its text, measured with whatever
 * font the game draws in. Text drawn into a box gets a smaller font when it is wider than the
 * box or the bitmap's edge, down to 3/5 of its size, below which the engine squeezes it. Games
 * often give a label a box wider than the gap before what they draw next on its row, so left-aligned
 * text is drawn only when something else touches its place, the bitmap is read or the frame is
 * shown, and then fits the gap before whatever starts to its right. A draw a few pixels from it,
 * as for an outline, is the same label. Only a draw across its middle row draws it first: a gauge
 * along the bottom of a row then goes under the text instead of over it. Copying a bitmap whole carries its waiting text along, as
 * games draw a label with its icon into a bitmap of its own and copy that next to the others. A
 * message whose line is too wide, or which has more than four rows, has its lines up to its
 * choices or number input broken again between words before the game draws it, a line that ends
 * in a space, as applying breaks a long line, joining the next one first; rows after the fourth
 * show as the next page, when the player goes on. Lines may be as wide as the screen, since some
 * message windows widen to fit their text. The first time the window doesn't, the message is
 * broken to the window's width and drawn again, and later ones are broken to that width from the
 * start: a game that logs messages as it draws them logs that one message twice. A message whose
 * choices or number input would fall below the fourth row stays as it is. It is written for
 * Ruby 1.8, which `Game.exe` runs, and later.
 */
export const textFittingScript = String.raw`class Bitmap
  RpgtlText = Struct.new(:x, :y, :w, :h, :top, :height, :text, :align, :wide, :room, :near, :font) unless defined?(RpgtlText)
  RPGTL_FONT = %w(name size bold italic color shadow outline out_color) unless defined?(RPGTL_FONT)
  RPGTL_READS = %w(get_pixel hue_change blur radial_blur to_file raw_data raw_data= _dump dup clone) unless defined?(RPGTL_READS)

  alias_method :rpgtl_draw_text, :draw_text unless method_defined?(:rpgtl_draw_text)
  alias_method :rpgtl_blt, :blt unless method_defined?(:rpgtl_blt)
  alias_method :rpgtl_stretch_blt, :stretch_blt unless method_defined?(:rpgtl_stretch_blt)
  alias_method :rpgtl_fill_rect, :fill_rect unless method_defined?(:rpgtl_fill_rect)
  alias_method :rpgtl_set_pixel, :set_pixel unless method_defined?(:rpgtl_set_pixel)
  alias_method :rpgtl_clear, :clear unless method_defined?(:rpgtl_clear)
  alias_method :rpgtl_dispose, :dispose unless method_defined?(:rpgtl_dispose)
  [:gradient_fill_rect, :clear_rect].each do |name|
    raw = "rpgtl_#{name}"
    next if !method_defined?(name) || method_defined?(raw)
    alias_method raw, name
    define_method(name) do |*args|
      rpgtl_touch(*rpgtl_area(args))
      send(raw, *args)
    end
  end
  RPGTL_READS.each do |name|
    raw = "rpgtl_#{name}"
    next if !method_defined?(name) || method_defined?(raw)
    alias_method raw, name
    define_method(name) do |*args|
      rpgtl_settle
      send(raw, *args)
    end
  end

  def self.rpgtl_settle_all
    waiting = $rpgtl_waiting
    return if waiting.nil? || waiting.empty?
    $rpgtl_waiting = []
    waiting.each { |bitmap| bitmap.rpgtl_settle unless bitmap.disposed? }
  end

  def draw_text(*args)
    if args[0].is_a?(Rect)
      x, y, w, h = args[0].x, args[0].y, args[0].width, args[0].height
      text, align = args[1], args[2]
    else
      x, y, w, h, text, align = *args
    end
    text = text.to_s
    align ||= 0
    size = text_size(text)
    top = y + (h - size.height) / 2
    item = RpgtlText.new(x, y, w, h, top, size.height, text, align, size.width, [w, width - x].min, font.size / 2, rpgtl_font)
    if align != 0 || item.room <= 0
      rpgtl_touch(x, y, w, h)
      return rpgtl_put(item)
    end
    rpgtl_wait(item)
  end

  def blt(x, y, src, rect, *rest)
    carried = []
    unless src.equal?(self)
      carried = src.rpgtl_carry(rect, x, y) if rest.empty? || rest[0] >= 255
      src.rpgtl_settle if carried.nil?
    end
    rpgtl_touch(x, y, rect.width, rect.height)
    rpgtl_blt(x, y, src, rect, *rest)
    (carried || []).each do |item|
      item.room = [item.room, width - item.x].min
      if item.room > 0
        rpgtl_wait(item)
      else
        rpgtl_put(item)
      end
    end
  end

  def rpgtl_wait(item)
    rpgtl_bound(item.x, item.top, item.height)
    (@rpgtl_waiting || []).each do |other|
      next unless rpgtl_rows?(other.top, other.height, item.top, item.height)
      next unless other.x > item.x + item.near && other.x < item.x + item.room
      item.room = other.x - item.x
    end
    if @rpgtl_waiting.nil? || @rpgtl_waiting.empty?
      @rpgtl_waiting = []
      ($rpgtl_waiting ||= []) << self
    end
    @rpgtl_waiting << item
    self
  end

  def rpgtl_carry(rect, x, y)
    waiting = @rpgtl_waiting
    return [] if waiting.nil? || waiting.empty?
    carried = []
    waiting.each do |item|
      right = item.x + [item.wide, item.room].min
      next unless item.top < rect.y + rect.height && rect.y < item.top + item.height
      next unless item.x < rect.x + rect.width && rect.x < right
      return nil if item.x < rect.x || item.y < rect.y || item.y + item.h > rect.y + rect.height
      copy = item.dup
      copy.x = x + item.x - rect.x
      copy.y = y + item.y - rect.y
      copy.top = y + item.top - rect.y
      copy.room = [item.room, rect.x + rect.width - item.x].min
      carried << copy
    end
    carried
  end

  def stretch_blt(dest, src, *rest)
    src.rpgtl_settle unless src.equal?(self)
    rpgtl_touch(dest.x, dest.y, dest.width, dest.height)
    rpgtl_stretch_blt(dest, src, *rest)
  end

  def fill_rect(*args)
    rpgtl_touch(*rpgtl_area(args))
    rpgtl_fill_rect(*args)
  end

  def set_pixel(x, y, color)
    rpgtl_touch(x, y, 1, 1)
    rpgtl_set_pixel(x, y, color)
  end

  def clear(*args)
    @rpgtl_waiting = nil
    rpgtl_clear(*args)
  end

  def dispose(*args)
    @rpgtl_waiting = nil
    rpgtl_dispose(*args)
  end

  def rpgtl_settle
    waiting = @rpgtl_waiting
    return if waiting.nil? || waiting.empty?
    @rpgtl_waiting = nil
    waiting.each { |item| rpgtl_put(item) }
  end

  def rpgtl_area(args)
    return [args[0].x, args[0].y, args[0].width, args[0].height] if args[0].is_a?(Rect)
    args[0, 4]
  end

  def rpgtl_rows?(top, height, other_top, other_height)
    top < other_top + other_height && other_top < top + height
  end

  def rpgtl_bound(x, top, height)
    return if @rpgtl_waiting.nil?
    @rpgtl_waiting.each do |item|
      next unless rpgtl_rows?(item.top, item.height, top, height)
      item.room = x - item.x if x > item.x + item.near && x < item.x + item.room
    end
  end

  def rpgtl_touch(x, y, w, h)
    waiting = @rpgtl_waiting
    return if waiting.nil? || waiting.empty?
    rpgtl_bound(x, y, h)
    last = nil
    waiting.each_with_index do |item, index|
      right = item.x + [item.wide, item.room].min
      middle = item.top + item.height / 2
      last = index if y <= middle && middle < y + h && x < right && item.x < x + w
    end
    return if last.nil?
    settled = waiting[0, last + 1]
    @rpgtl_waiting = waiting[last + 1..-1]
    settled.each { |item| rpgtl_put(item) }
  end

  def rpgtl_font
    RPGTL_FONT.select { |part| font.respond_to?(part) }.map do |part|
      value = font.send(part)
      value = Color.new(value.red, value.green, value.blue, value.alpha) if value.is_a?(Color)
      value = value.dup if value.is_a?(String)
      [part, value]
    end
  end

  def rpgtl_put(item)
    was = rpgtl_font
    item.font.each { |part, value| font.send("#{part}=", value) }
    begin
      room = item.room
      if room <= 0 || item.wide <= room
        rpgtl_draw_text(item.x, item.y, item.w, item.h, item.text, item.align)
      else
        size = font.size
        smallest = (size * 3 + 4) / 5
        fitted = [size * room / item.wide, smallest].max
        font.size = fitted
        while fitted > smallest && text_size(item.text).width > room
          fitted -= 1
          font.size = fitted
        end
        rpgtl_draw_text(item.x, item.y, room, item.h, item.text, item.align)
      end
    ensure
      was.each { |part, value| font.send("#{part}=", value) }
    end
    self
  end
end

module Graphics
  class << self
    [:update, :transition, :freeze, :snap_to_bitmap].each do |name|
      raw = "rpgtl_#{name}"
      next if !method_defined?(name) || method_defined?(raw)
      alias_method raw, name
      define_method(name) do |*args|
        Bitmap.rpgtl_settle_all
        send(raw, *args)
      end
    end
  end
end

if defined?(Window_Message)
  class Window_Message
    alias_method :rpgtl_refresh, :refresh unless method_defined?(:rpgtl_refresh)
    alias_method :rpgtl_terminate_message, :terminate_message unless method_defined?(:rpgtl_terminate_message)

    def refresh
      temp = $game_temp
      source = temp && temp.message_text
      return rpgtl_refresh unless source && contents
      source = source.dup
      starts = [temp.choice_start, temp.num_input_start]
      rpgtl_show(rpgtl_wrap_message(source, $rpgtl_message_room || rpgtl_screen_room, *starts))
      rpgtl_refresh
      room = [contents.width, width - 32].min - 4
      return if temp.message_text.nil? || rpgtl_fits(temp.message_text.split("\n", -1), room)
      $rpgtl_message_room = room
      wrap = rpgtl_wrap_message(source, room, *starts)
      return unless wrap
      temp.choice_start, temp.num_input_start = starts
      @rpgtl_rest = nil
      rpgtl_show(wrap)
      rpgtl_refresh
    end

    def terminate_message
      rest = @rpgtl_rest
      return rpgtl_terminate_message unless rest
      @rpgtl_rest = nil
      self.pause = false
      @contents_showing = false
      $game_temp.message_text = rest
    end

    def rpgtl_screen_room
      (Graphics.respond_to?(:width) ? Graphics.width : 640) - 36
    end

    def rpgtl_text_end(lines, choice_start, number_start)
      temp = $game_temp
      ends = [lines.size]
      ends << choice_start if temp.respond_to?(:choice_max) && temp.choice_max > 0
      ends << number_start if temp.respond_to?(:num_input_variable_id) && temp.num_input_variable_id > 0
      ends.min
    end

    def rpgtl_fits(lines, room)
      last = rpgtl_text_end(lines, $game_temp.choice_start, $game_temp.num_input_start)
      lines[0, last].all? { |line| rpgtl_width(line) <= room }
    end

    def rpgtl_show(wrap)
      return unless wrap
      text, added, rest = wrap
      temp = $game_temp
      temp.message_text = text
      temp.choice_start += added if temp.respond_to?(:choice_max) && temp.choice_max > 0
      temp.num_input_start += added if temp.respond_to?(:num_input_variable_id) && temp.num_input_variable_id > 0
      @rpgtl_rest = rest
    end

    def rpgtl_wrap_message(source, room, choice_start, number_start)
      temp = $game_temp
      lines = source.split("\n", -1)
      choices = temp.respond_to?(:choice_max) && temp.choice_max > 0
      number = temp.respond_to?(:num_input_variable_id) && temp.num_input_variable_id > 0
      last = rpgtl_text_end(lines, choice_start, number_start)
      shown = lines.size
      shown -= 1 while shown > 0 && lines[shown - 1] == ""
      return nil if shown <= 4 && lines[0, last].all? { |line| rpgtl_width(line) <= room }
      paragraphs = []
      lines[0, last].each do |line|
        if !paragraphs.empty? && paragraphs[-1][-1, 1] == " " && line != ""
          paragraphs[-1] = paragraphs[-1] + line
        else
          paragraphs << line
        end
      end
      wrapped = []
      paragraphs.each { |paragraph| wrapped.concat(rpgtl_rows(paragraph, room)) }
      wrapped.concat(lines[last..-1])
      added = wrapped.size - lines.size
      return nil if choices && choice_start + added + temp.choice_max > 4
      return nil if number && number_start + added >= 4
      shown = wrapped.size
      shown -= 1 while shown > 0 && wrapped[shown - 1] == ""
      rest = nil
      if shown > 4
        rest = wrapped[4, shown - 4].join("\n") + "\n"
        wrapped = wrapped[0, 4] + [""]
      end
      [wrapped.join("\n"), added, rest]
    end

    def rpgtl_rows(line, room)
      return [line] if rpgtl_width(line) <= room
      rows = []
      row = ""
      line.split(" ").each do |word|
        longer = row.empty? ? word : row + " " + word
        if !row.empty? && rpgtl_width(longer) > room
          rows << row
          row = word
        else
          row = longer
        end
      end
      rows << row
    end

    def rpgtl_width(line)
      shown = line.gsub(/\\[Nn]\[(\d+)\]/) do
        actor = $game_actors && $game_actors[$1.to_i]
        actor ? actor.name : ""
      end
      shown = shown.gsub(/\\[Vv]\[(\d+)\]/) { $game_variables ? $game_variables[$1.to_i].to_s : "" }
      shown = shown.gsub(/\\[A-Za-z]+(\[[^\]]*\])?|\\[{}$.|!><^\\]/, "")
      contents.text_size(shown).width
    end
  end
end
`;
