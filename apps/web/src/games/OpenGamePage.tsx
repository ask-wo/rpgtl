import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { useOpenGame } from "./useOpenGame.tsx";

/** Opens a game from the folder browser or a pasted path. */
export function OpenGamePage() {
  const [path, setPath] = useState("");
  const { choose, dialog, open, busy, opening, error: problem } = useOpenGame();

  const chooseAndOpen = async () => {
    const chosen = await choose(path);
    if (chosen === undefined) return;
    setPath(chosen);
    await open(chosen);
  };
  return (
    <div className="mx-auto w-full max-w-2xl p-6 pt-16">
      <Card>
        <CardHeader>
          <CardTitle>Open a game</CardTitle>
          <CardDescription>
            Choose an RPG Maker MV or MZ game folder, or paste its path.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void open(path);
            }}
          >
            <Button type="button" className="self-start" disabled={busy} onClick={chooseAndOpen}>
              Choose folder…
            </Button>
            <Field data-invalid={problem !== undefined}>
              <FieldLabel htmlFor="game-path">Or paste a path</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="game-path"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="Game folder, Game.exe or index.html"
                  aria-invalid={problem !== undefined}
                  required
                />
                <Button type="submit" variant="outline" disabled={busy || path === ""}>
                  {opening !== undefined && <Spinner />}
                  Open
                </Button>
              </div>
              {problem && <FieldError>{problem}</FieldError>}
            </Field>
          </form>
        </CardContent>
      </Card>
      {dialog}
    </div>
  );
}
