/**
 * An iterable that gives `messages` one by one, as the SDK's query does, then throws `thenThrow`
 * if given, as the SDK does when the CLI exits with an error.
 */
export const messagesOf = (
  messages: ReadonlyArray<unknown>,
  thenThrow?: Error,
): AsyncIterable<unknown> => ({
  [Symbol.asyncIterator]: () => {
    let next = 0;
    return {
      next: () =>
        next < messages.length
          ? Promise.resolve({ done: false, value: messages[next++] })
          : thenThrow
            ? Promise.reject(thenThrow)
            : Promise.resolve({ done: true, value: undefined }),
    };
  },
});
