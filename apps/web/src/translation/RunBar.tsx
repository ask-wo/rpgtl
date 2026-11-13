import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  type Catalog,
  type GameActivity,
  type ImageReaderSetupStatus,
  type ImageRunStatus,
  type RunStatus,
  type SourceLanguage,
  runEnded,
  type WaitingFor,
} from "@rpgtl/contracts";
import { gameLanguage } from "@rpgtl/domain";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { type ReactNode, useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Progress } from "~/components/ui/progress";
import { Spinner } from "~/components/ui/spinner";
import { failureMessage } from "../app/failure.ts";
import { activity, runPending } from "../games/activity.ts";
import { useGame } from "../games/GameContext.ts";
import { imageReaderStatus, imageResults, setUpImageReader } from "../images/atoms.ts";
import { useStartRun } from "../games/startRun.ts";
import { useReadImages } from "../images/readImages.ts";
import { readsLanguage, setupFailure } from "../images/readerSetup.ts";
import { SetupProgress } from "../images/SetupProgress.tsx";
import { catalog, stopReadingImages, stopTranslating, translate } from "./atoms.ts";
import { textEntries } from "../text/search.ts";
import { catalogCounts, counted, gigabytes, megabytes, number } from "./counts.ts";
import { useTimeLeft } from "./timeLeft.ts";

const percent = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

/**
 * Under the game's header while its translation is on or a run goes: the run as it goes, on
 * every page of the game, or else what is translated and the run that fits the page; then how the
 * last runs ended.
 */
export function RunBar(props: RunBarProps) {
  // The router keeps the layout above the bar when another game opens, so without the key a
  // setup's "read once it is set up", or an error, would carry over to the next game.
  return <GameRunBar key={useGame().id} {...props} />;
}

interface RunBarProps {
  /** The run the page's work needs, which the bar offers while none goes. */
  readonly fits: RunStatus["kind"] | "read-images";
  /** Opens the Text page on the entries the last run couldn't translate. */
  readonly onShowFailed: () => void;
}

function GameRunBar({ fits, onShowFailed }: RunBarProps) {
  const game = useGame();
  const result = useAtomValue(activity(game.id));
  const now = AsyncResult.getOrElse(result, () => undefined);
  const saved = AsyncResult.getOrElse(useAtomValue(catalog(game.id)), () => undefined);
  const reader = AsyncResult.getOrElse(useAtomValue(imageReaderStatus), () => undefined);
  const reading = useReadImages();
  // The setup the user agreed to so that reading starts, followed until it ends. The status
  // stream can skip statuses, so only a status of that same setup may start reading. It lives
  // here, not on the Images page's row, so reading still starts after the user moved to another
  // of the game's pages.
  const [following, setFollowing] = useState<number>();

  useEffect(() => {
    if (following === undefined || reader === undefined || saved === undefined) return;
    if (reader.attempt < following || reader.phase._tag === "SettingUp") return;
    setFollowing(undefined);
    if (reader.attempt === following) readAfterSetup(reader, gameLanguage(saved), reading);
  }, [following, reader, saved]);

  if (saved === undefined || (!saved.translate && !runPending(now))) return null;
  const setup =
    reader?.phase._tag === "SettingUp" ? (
      <SetupProgress
        status={{ ...reader, phase: reader.phase }}
        {...(following !== undefined && { after: "reading starts" })}
      />
    ) : undefined;
  return (
    <section aria-label="Runs" className="flex flex-col gap-2 border-b bg-muted/40 px-6 py-3">
      {now?.translation && !runEnded(now.translation.phase) ? (
        <TranslationRunning run={now.translation} />
      ) : now?.images && !runEnded(now.images.phase) ? (
        <ImagesRunning run={now.images} />
      ) : fits === "read-images" ? (
        <IdleImages
          saved={saved}
          known={now !== undefined}
          reading={reading}
          setup={setup}
          onSetUpToRead={setFollowing}
        />
      ) : (
        <Idle kind={fits} saved={saved} known={now !== undefined} setup={setup} />
      )}
      {fits !== "read-images" && reading.error && (
        <p className="text-sm text-destructive">{reading.error}</p>
      )}
      {now && <LastRuns now={now} saved={saved} onShowFailed={onShowFailed} />}
      {AsyncResult.isFailure(result) && (
        <p className="text-sm text-destructive">{failureMessage(result.cause)}</p>
      )}
    </section>
  );
}

const starts = {
  translate: {
    label: "Translate",
    does: "Translates everything without English, the glossary first",
  },
  "build-glossary": {
    label: "Build glossary",
    does: "Translates only the names, so you can correct them before translating the rest",
  },
} as const;

/** `known` is false until the game's activity arrived, which may still show a run going. */
function Idle({
  kind,
  saved,
  known,
  setup,
}: {
  readonly kind: RunStatus["kind"];
  readonly saved: Catalog;
  readonly known: boolean;
  /** How far setting up the image reader got, shown instead of the counts while it runs. */
  readonly setup: ReactNode;
}) {
  const game = useGame();
  const start = useAtomSet(translate, { mode: "promiseExit" });
  const { run, starting, error } = useStartRun(() => start({ payload: { id: game.id, kind } }));
  const { text, images, glossary } = catalogCounts(saved);
  const untranslated = text.all - text.translated + images.untranslated;

  return (
    <>
      <div className="flex items-center gap-4">
        <Button
          disabled={!known || starting || (kind === "translate" && untranslated === 0)}
          title={starts[kind].does}
          onClick={run}
        >
          {starting && <Spinner />}
          {starts[kind].label}
        </Button>
        {setup ?? (
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <p className="text-sm">
              {number(text.translated)} of {number(text.all)} text entries translated
              <span className="text-muted-foreground">
                {" · "}
                {number(text.all - text.translated)} missing
                {kind === "translate" &&
                  images.all > 0 &&
                  ` · ${number(images.translated)} of ${counted(images.all, "entry", "entries")} in images translated`}
                {kind === "build-glossary" &&
                  ` · ${counted(glossary, "glossary term", "glossary terms")}`}
              </span>
            </p>
            <Progress
              value={percent(text.translated, text.all) ?? 100}
              aria-label="Text translated"
            />
          </div>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </>
  );
}

/** Read new images, with what reading the images found so far. */
function IdleImages({
  saved,
  known,
  reading,
  setup,
  onSetUpToRead,
}: {
  readonly saved: Catalog;
  readonly known: boolean;
  readonly reading: ReturnType<typeof useReadImages>;
  /** How far setting up the image reader got, shown instead of the counts while it runs. */
  readonly setup: ReactNode;
  /** The setup the user agreed to so that reading starts once it ends, by its `attempt`. */
  readonly onSetUpToRead: (attempt: number) => void;
}) {
  const game = useGame();
  const read = AsyncResult.getOrElse(useAtomValue(imageResults(game.id)), () => undefined);
  const reader = AsyncResult.getOrElse(useAtomValue(imageReaderStatus), () => undefined);
  const setUp = useAtomSet(setUpImageReader, { mode: "promiseExit" });
  const [asking, setAsking] = useState(false);
  const { images } = catalogCounts(saved);
  const korean = gameLanguage(saved) === "korean";
  const usable = reader !== undefined && readsLanguage(reader, gameLanguage(saved));
  const { run, starting, error, setError } = reading;
  // The server keeps the last setup's error, so it still shows after the page was left meanwhile.
  const failure = reader && setupFailure(reader);
  const setupError = failure && `Setting up the image reader failed: ${failure}`;

  const setUpThenRead = async () => {
    setError(undefined);
    const exit = await setUp({ payload: { korean } });
    if (Exit.isFailure(exit)) setError(failureMessage(exit.cause));
    else if (exit.value.phase._tag === "SettingUp") onSetUpToRead(exit.value.attempt);
    else readAfterSetup(exit.value, gameLanguage(saved), reading);
  };

  return (
    <>
      <div className="flex items-center gap-4">
        <Button
          disabled={!known || reader === undefined || reader.phase._tag !== "Idle" || starting}
          title="Reads the text in images not read yet"
          onClick={() => (usable ? run() : setAsking(true))}
        >
          {starting && <Spinner />}
          Read new images
        </Button>
        <Button
          variant="outline"
          disabled={!known || !usable || starting || !read || Object.keys(read.images).length === 0}
          title="Reads every image again from scratch. Each text keeps its English, which is flagged for a look where the text reads differently now."
          onClick={() => run("all")}
        >
          Read all again
        </Button>
        {setup ?? (
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <p className="text-sm">
              {read === undefined
                ? "…"
                : counted(Object.keys(read.images).length, "image", "images")}{" "}
              read
              <span className="text-muted-foreground">
                {" · "}
                {number(images.files)} with text · {number(images.translated)} of{" "}
                {counted(images.all, "entry", "entries")} in images translated
              </span>
            </p>
            <Progress
              value={percent(images.translated, images.all) ?? 100}
              aria-label="Image text translated"
            />
          </div>
        )}
      </div>
      {(error ?? setupError) && <p className="text-sm text-destructive">{error ?? setupError}</p>}
      {reader && (
        <AlertDialog open={asking} onOpenChange={setAsking}>
          <AlertDialogContent>
            <AlertDialogHeader>
              {reader.ready ? (
                <>
                  <AlertDialogTitle>Add the Korean text model?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This game is in Korean, which the image reader reads with a model of its own: a
                    one-time download of about {megabytes(reader.korean.download)} MB to{" "}
                    {reader.folder}. Reading starts once it is added.
                  </AlertDialogDescription>
                </>
              ) : (
                <>
                  <AlertDialogTitle>Set up the image reader?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Reading images needs the image reader
                    {korean && ", with its model for Korean, as this game is in Korean"}: a one-time
                    download of about{" "}
                    {gigabytes(reader.download + (korean ? reader.korean.download : 0))} GB to{" "}
                    {reader.folder}. Reading starts once it is set up.
                  </AlertDialogDescription>
                  {reader.note && <AlertDialogDescription>{reader.note}</AlertDialogDescription>}
                </>
              )}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Not now</AlertDialogCancel>
              <AlertDialogAction onClick={setUpThenRead}>
                {reader.ready ? "Add and read" : "Set up and read"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

function TranslationRunning({ run }: { readonly run: RunStatus }) {
  if (run.phase._tag === "Waiting") return <Waiting what="translation" runs={run.phase.for} />;
  return <TranslationGoing run={run} />;
}

function TranslationGoing({ run }: { readonly run: RunStatus }) {
  const pass =
    run.pass === "names"
      ? {
          ...run.names,
          label: run.kind === "build-glossary" ? "Building the glossary" : "Translating names",
          counted: (count: number) => counted(count, "name", "names"),
        }
      : {
          total: run.total - run.names.total,
          done: run.done - run.names.done,
          failed: run.failed.length - run.names.failed,
          label: "Translating text",
          counted: (count: number) => counted(count, "entry", "entries"),
        };
  const finished = pass.done + pass.failed;
  const step = run.phase._tag === "Running" ? run.phase.step : endingStep;
  const left = useTimeLeft(finished, pass.total, step !== undefined);
  return (
    <div className="flex items-center gap-4">
      <StopButton what="translation" ending={run.phase._tag === "Ending"} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="flex items-center gap-1.5 text-sm">
          {step !== undefined && <Spinner />}
          <span>
            <span className="font-medium">{step ?? pass.label}</span>
            {` · ${number(pass.done)} of ${pass.counted(pass.total)} translated`}
            {pass.failed > 0 && `, ${number(pass.failed)} failed`}
            {left && <span className="text-muted-foreground"> · {left}</span>}
          </span>
        </p>
        <Progress value={percent(finished, pass.total)} aria-label="Run progress" />
      </div>
    </div>
  );
}

function ImagesRunning({ run }: { readonly run: ImageRunStatus }) {
  if (run.phase._tag === "Waiting") return <Waiting what="images" runs={run.phase.for} />;
  return <ImagesGoing run={run} />;
}

function ImagesGoing({ run }: { readonly run: ImageRunStatus }) {
  const { phase } = run;
  const fallback = phase._tag === "Running" ? phase.fallback : undefined;
  const loading = phase._tag === "Running" ? phase.loading : undefined;
  const left = useTimeLeft(
    fallback ? fallback.done : run.done,
    fallback ? fallback.total : run.total,
    phase._tag === "Ending" || (fallback ? fallback.waiting !== undefined : run.total === 0),
  );
  return (
    <div className="flex items-center gap-4">
      <StopButton what="images" ending={phase._tag === "Ending"} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-sm">
          {phase._tag === "Ending" ? (
            <span className="flex items-center gap-1.5 font-medium">
              <Spinner />
              {endingStep}
            </span>
          ) : loading ? (
            <span className="font-medium">
              {loading === "backupReader"
                ? "Loading the backup reader's model"
                : "Loading the image reader"}
              {fallback?.waiting && (
                <span className="font-normal text-muted-foreground"> · {fallback.waiting}</span>
              )}
            </span>
          ) : fallback ? (
            <>
              <span className="font-medium">Reading partly read images again</span>
              {` · ${number(fallback.done)} of ${number(fallback.total)} with the backup reader`}
              {fallback.waiting && (
                <span className="text-muted-foreground"> · {fallback.waiting}</span>
              )}
            </>
          ) : (
            <span className="font-medium">
              {run.total > 0
                ? `Reading images · ${number(run.done)} of ${number(run.total)}`
                : "Checking which images are new or changed"}
            </span>
          )}
          {left && <span className="text-muted-foreground"> · {left}</span>}
        </p>
        <Progress
          value={fallback ? percent(fallback.done, fallback.total) : percent(run.done, run.total)}
          aria-label="Run progress"
        />
      </div>
    </div>
  );
}

/** What the run bar says while a run frees its models and game, after its work. */
const endingStep = "Ending the run";

const list = new Intl.ListFormat("en", { type: "conjunction" });

/** A run that waits for its turn behind `runs`; Stop takes it out of the queue. */
function Waiting({
  what,
  runs,
}: {
  readonly what: "translation" | "images";
  readonly runs: ReadonlyArray<WaitingFor>;
}) {
  const game = useGame();
  const named = runs.map(({ kind, game: other }) => {
    const run = kind === "translation" ? "translation" : "image reading";
    return other.id === game.id ? `this game's ${run}` : `${run} in ${other.title}`;
  });
  return (
    <div className="flex items-center gap-4">
      <StopButton what={what} ending={false} />
      <p className="text-sm">
        <span className="font-medium">
          {what === "translation" ? "Translation waits" : "Image reading waits"}
        </span>
        <span className="text-muted-foreground">
          {` · It starts once ${list.format(named)} ${runs.length > 1 ? "have" : "has"} finished.`}
        </span>
      </p>
    </div>
  );
}

/** Stop, which keeps what the run saved; the run's status says once it has ended. */
function StopButton({
  what,
  ending,
}: {
  readonly what: "translation" | "images";
  /** The run's work is over, so there is nothing left to stop. */
  readonly ending: boolean;
}) {
  const game = useGame();
  const stopTranslation = useAtomSet(stopTranslating, { mode: "promiseExit" });
  const stopImages = useAtomSet(stopReadingImages, { mode: "promiseExit" });
  const stop = (): Promise<Exit.Exit<unknown, { readonly message: string }>> =>
    what === "translation"
      ? stopTranslation({ payload: { id: game.id } })
      : stopImages({ payload: { id: game.id } });
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        disabled={stopping || ending}
        onClick={async () => {
          setError(undefined);
          setStopping(true);
          const exit = await stop();
          setStopping(false);
          if (Exit.isFailure(exit)) setError(failureMessage(exit.cause));
        }}
      >
        {stopping && <Spinner />}
        Stop
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** How the game's last translation run and image reading ended, once they have. */
function LastRuns({
  now,
  saved,
  onShowFailed,
}: {
  readonly now: GameActivity;
  readonly saved: Catalog;
  readonly onShowFailed: () => void;
}) {
  const { translation, images } = now;
  return (
    <>
      {translation && runEnded(translation.phase) && (
        <TranslationEnded run={translation} saved={saved} onShowFailed={onShowFailed} />
      )}
      {images && runEnded(images.phase) && <ImagesEnded run={images} />}
    </>
  );
}

function TranslationEnded({
  run,
  saved,
  onShowFailed,
}: {
  readonly run: RunStatus;
  readonly saved: Catalog;
  readonly onShowFailed: () => void;
}) {
  const failed = new Set(run.failed);
  const failedText = textEntries(saved).filter((entry) => failed.has(entry.id)).length;
  const glossaryOnly = run.kind === "build-glossary";
  const translated = glossaryOnly
    ? counted(run.done, "name", "names")
    : counted(run.done, "entry", "entries");
  const again = starts[run.kind].label;
  const { phase } = run;
  const summary =
    phase._tag === "Failed"
      ? `${phase.error} The ${translated} translated before that are saved.`
      : phase._tag === "Stopped"
        ? `${glossaryOnly ? "Building the glossary" : "Translation"} stopped. ${translated} translated and saved; ${again} goes on with the rest.`
        : glossaryOnly
          ? `Glossary built: ${translated} translated and saved. Correct the glossary, then Translate the rest.`
          : `Translation done: ${translated} translated and saved.`;
  return (
    <Outcome
      failed={phase._tag === "Failed"}
      summary={summary}
      problems={
        run.failed.length > 0
          ? `${counted(run.failed.length, "entry", "entries")} couldn't be translated; ${again} tries them again.`
          : undefined
      }
      warnings={run.warnings}
    >
      {failedText > 0 && (
        <Button variant="link" size="sm" className="h-auto self-start p-0" onClick={onShowFailed}>
          Show the {counted(failedText, "failed text entry", "failed text entries")}
        </Button>
      )}
    </Outcome>
  );
}

function ImagesEnded({ run }: { readonly run: ImageRunStatus }) {
  const read = `${number(run.done)} of ${counted(run.total, "image", "images")}`;
  const { phase } = run;
  const summary =
    phase._tag === "Failed"
      ? `${phase.error} ${read} were read before that.`
      : phase._tag === "Stopped"
        ? `Image reading stopped after ${read}.`
        : `Image reading done: ${read} read; the images hold ${counted(run.entries, "text entry", "text entries")}.`;
  return (
    <Outcome
      failed={phase._tag === "Failed"}
      summary={summary}
      problems={
        run.failed.length > 0
          ? `${counted(run.failed.length, "image", "images")} couldn't be read: ${run.failed.join(", ")}`
          : undefined
      }
      warnings={run.warnings}
    />
  );
}

function Outcome({
  failed,
  summary,
  problems,
  warnings,
  children,
}: {
  readonly failed: boolean;
  readonly summary: string;
  readonly problems: string | undefined;
  readonly warnings: ReadonlyArray<string>;
  /** A way to what went wrong. */
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className={failed ? "text-destructive" : undefined}>{summary}</p>
      {problems && <p className="text-destructive">{problems}</p>}
      {children}
      {warnings.length > 0 && (
        <ul className="list-inside list-disc text-muted-foreground">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const readAfterSetup = (
  reader: ImageReaderSetupStatus,
  language: SourceLanguage,
  reading: ReturnType<typeof useReadImages>,
) => {
  if (readsLanguage(reader, language)) void reading.run();
  else
    reading.setError(
      `Setting up the image reader failed: ${setupFailure(reader) ?? "RPGTL's log says why."}`,
    );
};
