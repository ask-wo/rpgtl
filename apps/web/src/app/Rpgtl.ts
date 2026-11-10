import { Api } from "@rpgtl/contracts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as AtomHttpApi from "effect/reactivity/AtomHttpApi";

/** The server puts this start's token into the page; every API request sends it back. */
const token = document.querySelector<HTMLMetaElement>('meta[name="rpgtl-token"]')?.content ?? "";

/** RPGTL's API as atoms: `Rpgtl.query` for reads, `Rpgtl.mutation` for changes. */
export class Rpgtl extends AtomHttpApi.Service<Rpgtl>()("@rpgtl/web/app/Rpgtl", {
  api: Api,
  httpClient: FetchHttpClient.layer,
  transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader("x-rpgtl-token", token)),
  baseUrl: location.origin,
}) {}
