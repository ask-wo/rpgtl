import {
  canExpand,
  currentNote,
  decodeCommands,
  gameValue,
  namesFromGame,
  scriptNote,
} from "./commands.ts";
import type { GameNames, Line } from "./commands.ts";
import { setSelfSwitch } from "./model.ts";
import type { EventPage, EventPageView, MapGame, Marker } from "./model.ts";
import type { Sprites } from "./sprites.ts";
import { nameWithOriginal, priorityWords, triggerWords } from "./words.ts";

export interface EventDetail {
  readonly marker: Marker;
  readonly mapId: number;
  /** Whether the map is one the player isn't on, whose pages only the standard conditions pick. */
  readonly otherMap: boolean;
  readonly pages: EventPageView[];
  readonly lists: EventPage["list"][];
  readonly position: () => { readonly x: number; readonly y: number };
}

const lineCount = (lines: Line[]): number =>
  lines.reduce((count, line) => count + 1 + lineCount(line.children), 0);

/**
 * The panel that shows the selected event's pages, conditions and commands. It is drawn again
 * only when what it shows changes; values that change while the game runs update in place.
 */
export function makeDetailPanel(
  detail: HTMLElement,
  game: MapGame,
  sprites: Sprites,
  teleportTo: (x: number, y: number) => void,
) {
  const gameNames = game as unknown as GameNames;
  const decoded = new WeakMap<EventPage["list"], { id: number; lines: Line[] }>();
  let nextListId = 0;
  let liveUpdates: (() => void)[] = [];
  let shownPages: EventPageView[] = [];
  let shownKey = "";
  let showRaw = false;
  const blockState = new Map<string, boolean>();

  function liveText(element: HTMLElement, read: () => string) {
    const update = () => {
      const value = read();
      if (element.textContent !== value) element.textContent = value;
    };
    liveUpdates.push(update);
    update();
  }
  function resolveValues(text: string) {
    return text.replace(/\uE000(script:)?(switch|variable):(\d+)\uE001/g, (_, script, kind, id) =>
      script
        ? scriptNote(gameNames, kind, Number(id))
        : currentNote(kind, gameValue(gameNames, kind, Number(id))),
    );
  }
  function commands(list: EventPage["list"]) {
    let cached = decoded.get(list);
    if (!cached) {
      const names = namesFromGame(gameNames);
      names.current = (kind, id) => `\uE000${kind}:${id}\uE001`;
      names.scriptValue = (kind, id) => `\uE000script:${kind}:${id}\uE001`;
      const lines = decodeCommands(
        list.map((command) => ({
          code: command.code,
          indent: command.indent ?? 0,
          parameters: command.parameters ?? [],
        })),
        names,
      );
      cached = { id: ++nextListId, lines };
      decoded.set(list, cached);
    }
    return cached;
  }
  function rememberToggle(block: HTMLDetailsElement) {
    blockState.set(block.dataset.blockKey!, block.open);
  }
  function commandLine(line: Line) {
    const row = document.createElement("span");
    row.className = "command-line";
    const label = document.createElement("strong");
    label.textContent = line.label;
    row.append(label);
    if (line.code === 355 && line.detail) {
      const block = document.createElement("span");
      block.className = "script-code";
      const code = document.createElement("code");
      liveText(code, () => resolveValues(line.detail));
      block.append(code);
      row.append(block);
    } else if (line.detail) {
      const detailText = document.createElement("span");
      detailText.className = "command-detail";
      liveText(detailText, () => `: ${resolveValues(line.detail)}`);
      row.append(detailText);
    }
    if (showRaw) {
      for (const raw of line.raw) {
        const rawCode = document.createElement("small");
        rawCode.className = "raw-code";
        rawCode.textContent = `${raw.code}: ${JSON.stringify(raw.parameters) ?? ""}`;
        row.append(rawCode);
      }
    }
    return row;
  }
  function commandLines(
    parent: HTMLElement,
    lines: Line[],
    pageIndex: number,
    path: string,
    ancestors: number[],
  ) {
    lines.forEach((line, index) => {
      const linePath = path ? `${path}.${index}` : String(index);
      const lineRow = commandLine(line);
      if (line.children.length) {
        const block = document.createElement("details");
        block.className = "command-block";
        block.dataset.blockKey = `page:${pageIndex}:line:${linePath}`;
        const summary = document.createElement("summary");
        summary.append(lineRow);
        block.append(summary);
        const children = document.createElement("div");
        children.className = "command-children";
        commandLines(children, line.children, pageIndex, linePath, ancestors);
        block.append(children);
        block.addEventListener("toggle", () => rememberToggle(block));
        block.open = blockState.get(block.dataset.blockKey) ?? true;
        parent.append(block);
      } else {
        const lineContainer = document.createElement("div");
        lineContainer.append(lineRow);
        if (line.commonEvent !== undefined) {
          const commonEventId = line.commonEvent;
          if (canExpand(commonEventId, ancestors)) {
            const expansion = document.createElement("details");
            expansion.className = "common-event";
            expansion.dataset.blockKey = `page:${pageIndex}:line:${linePath}:common`;
            const summary = document.createElement("summary");
            summary.textContent = "Show common event";
            expansion.append(summary);
            const content = document.createElement("div");
            content.className = "common-event-content";
            let loaded = false;
            const load = () => {
              if (loaded) return;
              loaded = true;
              const commonEvent = gameNames.$dataCommonEvents?.[commonEventId];
              const commonLines = commonEvent?.list ? commands(commonEvent.list).lines : [];
              if (!commonLines.length) content.textContent = "No commands";
              else
                commandLines(
                  content,
                  commonLines,
                  pageIndex,
                  `${linePath}/common:${commonEventId}`,
                  [...ancestors, commonEventId],
                );
            };
            expansion.addEventListener("toggle", () => {
              rememberToggle(expansion);
              if (expansion.open) load();
            });
            expansion.open = blockState.get(expansion.dataset.blockKey) ?? false;
            if (expansion.open) load();
            expansion.append(content);
            lineContainer.append(expansion);
          } else {
            const note = document.createElement("span");
            note.className = "command-detail";
            note.textContent = " (already expanded above)";
            lineContainer.append(note);
          }
        }
        parent.append(lineContainer);
      }
    });
  }
  function renderCommands(article: HTMLElement, page: EventPageView, lines: Line[]) {
    if (!lines.length) {
      const empty = document.createElement("div");
      empty.className = "page-meta";
      empty.textContent = "No commands";
      article.append(empty);
      return;
    }
    const heading = `Commands (${lineCount(lines)})`;
    if (!page.applies) {
      const toggle = document.createElement("details");
      toggle.className = "commands-toggle";
      toggle.dataset.blockKey = `page:${page.index}:commands`;
      const summary = document.createElement("summary");
      summary.textContent = heading;
      toggle.append(summary);
      const content = document.createElement("div");
      content.className = "command-list";
      commandLines(content, lines, page.index, "", []);
      toggle.append(content);
      toggle.addEventListener("toggle", () => rememberToggle(toggle));
      toggle.open = blockState.get(toggle.dataset.blockKey) ?? false;
      article.append(toggle);
    } else {
      const title = document.createElement("div");
      title.className = "page-meta";
      title.textContent = heading;
      article.append(title);
      const content = document.createElement("div");
      content.className = "command-list";
      commandLines(content, lines, page.index, "", []);
      article.append(content);
    }
  }
  function render(event: EventDetail, commandPages: Line[][]) {
    const { marker } = event;
    const scrollTop = detail.scrollTop;
    for (const block of detail.querySelectorAll<HTMLDetailsElement>("details[data-block-key]"))
      blockState.set(block.dataset.blockKey!, block.open);
    detail.replaceChildren();
    liveUpdates = [];
    const header = document.createElement("div");
    header.className = "event-header";
    const title = document.createElement("strong");
    title.textContent = `Event ${marker.id}: ${nameWithOriginal(marker)}`;
    const position = document.createElement("small");
    liveText(position, () => {
      const { x, y } = event.position();
      return `Position: (${x}, ${y})`;
    });
    const rawToggle = document.createElement("label");
    const rawInput = document.createElement("input");
    rawInput.type = "checkbox";
    rawInput.checked = showRaw;
    rawInput.onchange = () => {
      showRaw = rawInput.checked;
      render({ ...event, pages: shownPages }, commandPages);
    };
    rawToggle.append(rawInput, "Show raw codes");
    header.append(title, position, rawToggle);
    const selfSwitches = document.createElement("div");
    selfSwitches.className = "self-switches";
    for (const letter of ["A", "B", "C", "D"]) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!game.$gameSelfSwitches?.value([event.mapId, marker.id, letter]);
      input.disabled = !game.$gameMap || !game.$gameSelfSwitches?.setValue;
      input.onchange = () => {
        setSelfSwitch(game, event.mapId, marker.id, letter, input.checked);
      };
      liveUpdates.push(() => {
        input.checked = !!game.$gameSelfSwitches?.value([event.mapId, marker.id, letter]);
      });
      label.append(input, `Self switch ${letter}`);
      selfSwitches.append(label);
    }
    const eventActions = document.createElement("div");
    eventActions.className = "event-actions";
    eventActions.append(selfSwitches);
    const teleportEventButton = document.createElement("button");
    teleportEventButton.id = "teleport-event";
    teleportEventButton.textContent = "Teleport next to it";
    teleportEventButton.disabled = !game.$gameMap || !game.$gamePlayer;
    teleportEventButton.onclick = () => teleportTo(marker.x, marker.y);
    eventActions.append(teleportEventButton);
    header.append(eventActions);
    const selfSwitchNote = document.createElement("div");
    selfSwitchNote.className = "self-switch-note";
    selfSwitchNote.textContent = "Save in the game to keep changes.";
    header.append(selfSwitchNote);
    detail.append(header);
    if (event.otherMap) {
      const note = document.createElement("div");
      note.className = "page-meta";
      note.textContent =
        "Pages on this map are checked with the standard conditions; plugins may pick a different page.";
      detail.append(note);
    }
    for (const page of event.pages) {
      const article = document.createElement("article");
      article.className = `page${page.applies ? " applies" : ""}`;
      const pageTitle = document.createElement("div");
      pageTitle.className = "page-title";
      const pageName = document.createElement("span");
      pageName.textContent = `Page ${page.index + 1} · ${page.trigger ? triggerWords[page.trigger] : "Unknown trigger"}`;
      pageTitle.append(pageName);
      if (page.applies) {
        const applies = document.createElement("span");
        applies.className = "applies";
        applies.textContent = "Applies now";
        pageTitle.append(applies);
      }
      article.append(pageTitle);
      const meta = document.createElement("div");
      meta.className = "page-meta";
      meta.textContent = `Priority: ${priorityWords[page.priority]} · Sprite: ${page.sprite}`;
      const sprite = page.image && sprites.load(page.image);
      if (sprite) {
        const picture = document.createElement("canvas");
        picture.className = "sprite-picture";
        picture.setAttribute("role", "img");
        picture.setAttribute("aria-label", `Sprite: ${page.sprite}`);
        picture.width = sprite.rect.width;
        picture.height = sprite.rect.height;
        const pen = picture.getContext("2d")!;
        pen.imageSmoothingEnabled = false;
        pen.drawImage(
          sprite.source,
          sprite.rect.x,
          sprite.rect.y,
          sprite.rect.width,
          sprite.rect.height,
          0,
          0,
          picture.width,
          picture.height,
        );
        meta.append(picture);
      }
      article.append(meta);
      const conditions = document.createElement("div");
      conditions.className = "conditions";
      if (!page.conditions.length) {
        conditions.textContent = "No conditions";
      } else {
        for (const [conditionIndex, condition] of page.conditions.entries()) {
          const row = document.createElement("div");
          row.className = `condition ${condition.holds ? "held" : "missing"}`;
          const mark = document.createElement("span");
          mark.setAttribute("aria-hidden", "true");
          mark.textContent = condition.holds ? "✓" : "✕";
          const words = document.createElement("span");
          liveText(words, () => shownPages[page.index]?.conditions[conditionIndex]?.text ?? "");
          row.append(mark, words);
          conditions.append(row);
        }
      }
      article.append(conditions);
      renderCommands(article, page, commandPages[page.index]!);
      detail.append(article);
    }
    detail.scrollTop = scrollTop;
  }

  /** Shows the event, or nothing; called on each frame. */
  function show(event: EventDetail | undefined) {
    if (!event) {
      if (shownKey) {
        shownKey = "";
        detail.replaceChildren();
      }
      return;
    }
    shownPages = event.pages;
    const commandPages = event.lists.map(commands);
    const key = JSON.stringify([
      event.mapId,
      event.marker.id,
      event.marker.name,
      event.pages.map((page) => [
        page.index,
        page.trigger,
        page.priority,
        page.sprite,
        page.image,
        page.applies,
        page.conditions.map((condition) => condition.holds),
      ]),
      commandPages.map((page) => page.id),
    ]);
    if (key !== shownKey) {
      shownKey = key;
      render(
        event,
        commandPages.map((page) => page.lines),
      );
    }
    for (const update of liveUpdates) update();
  }

  function forgetBlocks() {
    shownKey = "";
    blockState.clear();
  }

  function reset() {
    forgetBlocks();
    shownPages = [];
    liveUpdates = [];
    detail.replaceChildren();
    detail.scrollTop = 0;
  }

  function sheetLoaded(characterName: string) {
    if (shownPages.some((page) => page.image?.characterName === characterName)) shownKey = "";
  }

  return { show, forgetBlocks, reset, sheetLoaded };
}
