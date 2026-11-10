import { expect } from "vite-plus/test";

expect.extend({
  toStartWith(received: unknown, prefix: string) {
    const pass = typeof received === "string" && received.startsWith(prefix);
    return {
      pass,
      message: () =>
        `expected ${this.utils.printReceived(received)} to start with ${this.utils.printExpected(prefix)}`,
    };
  },
  toEndWith(received: unknown, suffix: string) {
    const pass = typeof received === "string" && received.endsWith(suffix);
    return {
      pass,
      message: () =>
        `expected ${this.utils.printReceived(received)} to end with ${this.utils.printExpected(suffix)}`,
    };
  },
});

declare module "vite-plus/test" {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toStartWith(prefix: string): R;
    toEndWith(suffix: string): R;
  }
}
