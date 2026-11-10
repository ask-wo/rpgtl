import { useEffect, useRef, useState } from "react";

/**
 * A question a dialog asks. `ask` shows `asked` and gives the answer `close` gets, or undefined
 * when it is asked again or its component unmounts before an answer.
 */
export function useQuestion<Question, Answer>() {
  const [asked, setAsked] = useState<Question>();
  const answer = useRef<(answer: Answer | undefined) => void>(undefined);
  const close = (given: Answer | undefined) => {
    answer.current?.(given);
    answer.current = undefined;
    setAsked(undefined);
  };
  useEffect(() => () => answer.current?.(undefined), []);
  const ask = (question: Question) =>
    new Promise<Answer | undefined>((resolve) => {
      answer.current?.(undefined);
      answer.current = resolve;
      setAsked(question);
    });
  return { asked, ask, close };
}
