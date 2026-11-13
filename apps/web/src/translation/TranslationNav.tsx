import { useAtomValue } from "@effect/atom-react";
import type { Engine } from "@rpgtl/contracts";
import { engineFeatures } from "@rpgtl/domain";
import { Link } from "@tanstack/react-router";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { BookAIcon, FileTextIcon, ImageIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "~/components/ui/sidebar";
import { catalog } from "./atoms.ts";
import { catalogCounts, number } from "./counts.ts";

/** The open game's translation pages, under its row in the sidebar while its translation is on. */
export function TranslationNav({
  gameId,
  engine,
}: {
  readonly gameId: string;
  readonly engine: Engine;
}) {
  const saved = AsyncResult.getOrElse(useAtomValue(catalog(gameId)), () => undefined);
  if (saved === undefined || !saved.translate) return null;
  const { text, names, images } = catalogCounts(saved);
  return (
    <SidebarMenuSub aria-label="Translation" className="mr-0 pr-0">
      <li className="px-2 pt-2 pb-1 text-xs font-medium text-sidebar-foreground/70">Translation</li>
      <Page gameId={gameId} to="glossary" icon={BookAIcon} label="Glossary">
        {names.translated < names.all ? (
          <Progress done={names.translated} all={names.all} what="names" />
        ) : (
          <Count title="Glossary terms">{number(saved.glossary.length)}</Count>
        )}
      </Page>
      <Page gameId={gameId} to="text" icon={FileTextIcon} label="Text">
        <Progress done={text.translated} all={text.all} what="text entries" />
      </Page>
      {engineFeatures[engine].imageText && (
        <Page gameId={gameId} to="images" icon={ImageIcon} label="Images">
          {images.all > 0 && (
            <Progress
              done={images.translated}
              all={images.translated + images.untranslated}
              what="entries in images, apart from kept artwork"
            />
          )}
        </Page>
      )}
    </SidebarMenuSub>
  );
}

function Page({
  gameId,
  to,
  icon: Icon,
  label,
  children,
}: {
  readonly gameId: string;
  readonly to: "glossary" | "text" | "images";
  readonly icon: LucideIcon;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        render={
          <Link
            to={`/games/$gameId/${to}`}
            params={{ gameId }}
            activeProps={{ "data-active": "" }}
          />
        }
      >
        <Icon />
        <span className="truncate">{label}</span>
        {children}
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

/** How many of the entries have English, as "3/10"; only the total once all do. */
function Progress({
  done,
  all,
  what,
}: {
  readonly done: number;
  readonly all: number;
  readonly what: string;
}) {
  return (
    <Count title={`${number(done)} of ${number(all)} ${what} have English`}>
      {done === all ? number(all) : `${number(done)}/${number(all)}`}
    </Count>
  );
}

// A tag's padding and border, invisible, so the numbers end where the engine tags' letters do.
function Count({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <span
      title={title}
      className="ml-auto border border-transparent px-2 text-xs font-medium tabular-nums"
    >
      {children}
    </span>
  );
}
