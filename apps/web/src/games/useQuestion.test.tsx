import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vite-plus/test";
import { useQuestion } from "./useQuestion.ts";

test("a question asked again, or left by its component, ends without an answer", async () => {
  let latest: ReturnType<typeof useQuestion<string, string>> | undefined;
  function Asker() {
    latest = useQuestion<string, string>();
    return <p>{latest.asked}</p>;
  }
  const question = () => {
    if (!latest) throw new Error("The asker didn't render.");
    return latest;
  };
  const asked = (text: string) => {
    let answer: Promise<string | undefined> = Promise.resolve(undefined);
    act(() => {
      answer = question().ask(text);
    });
    return answer;
  };
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Asker />));

  const first = asked("Which folder?");
  const second = asked("Which other folder?");
  expect(await first).toBeUndefined();
  act(() => question().close("/games/Valley"));
  expect(await second).toBe("/games/Valley");

  const third = asked("Which folder?");
  act(() => root.unmount());
  expect(await third).toBeUndefined();
});
