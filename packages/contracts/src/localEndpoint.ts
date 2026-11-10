import * as Schema from "effect/Schema";

/** Why a translation endpoint the page sent can't be used. */
export const EndpointProblem = Schema.Literals(["invalid", "notHttp", "notLocal"]);
export type EndpointProblem = typeof EndpointProblem.Type;

const problems: Record<EndpointProblem, string> = {
  invalid: "Enter the translation endpoint as a URL, such as http://127.0.0.1:11434.",
  notHttp: "Use an HTTP or HTTPS translation endpoint.",
  notLocal: "Translation endpoints must be on this computer (127.0.0.1, localhost, or ::1).",
};

export const endpointProblem = (problem: EndpointProblem) => problems[problem];
