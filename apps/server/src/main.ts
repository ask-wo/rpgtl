import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Layer from "effect/Layer";
import * as Frontend from "./frontend/Frontend.ts";
import { serve } from "./server.ts";

Layer.launch(serve(Frontend.layer, { openPage: false })).pipe(NodeRuntime.runMain);
