import { definePlugin, defineRule, type ESTree, type Scope } from "@oxlint/plugins";

const noAsync = defineRule({
  meta: { type: "problem", docs: { description: "Disallow async functions and await." } },
  create(context) {
    const message =
      "Write an Effect (Effect.gen, Effect.fn, Effect.tryPromise) instead of async code.";
    const checkFunction = (node: ESTree.Function | ESTree.ArrowFunctionExpression) => {
      if (node.async) context.report({ node, message });
    };
    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      AwaitExpression: (node) => context.report({ node, message }),
      ForOfStatement: (node) => {
        if (node.await) context.report({ node, message });
      },
    };
  },
});

const noTry = defineRule({
  meta: { type: "problem", docs: { description: "Disallow try/catch." } },
  create(context) {
    return {
      TryStatement: (node) =>
        context.report({
          node,
          message: "Fail with a tagged error and handle it with Effect.catchTag or Effect.try.",
        }),
    };
  },
});

const noNewDate = defineRule({
  meta: { type: "problem", docs: { description: "Disallow new Date." } },
  create(context) {
    return {
      NewExpression: (node) => {
        if (node.callee.type === "Identifier" && node.callee.name === "Date")
          context.report({
            node,
            message: "Read the time from Clock or DateTime, so tests can use TestClock.",
          });
      },
    };
  },
});

/** `effect`, a folder of it like `effect/http`, or a platform package's root. */
const effectBarrel = /^(effect(\/[a-z-]+)?|@effect\/platform-[a-z]+)$/;
const effectModule = /^(effect|@effect\/platform-[a-z]+)\//;

const effectNamespaceImports = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Import Effect modules as namespaces from their subpaths." },
  },
  create(context) {
    return {
      ImportDeclaration: (node) => {
        const source = node.source.value;
        if (
          effectBarrel.test(source) ||
          (effectModule.test(source) &&
            node.specifiers.some((specifier) => specifier.type !== "ImportNamespaceSpecifier"))
        )
          context.report({
            node,
            message:
              'Import each Effect module from its own path: import * as Effect from "effect/Effect".',
          });
      },
    };
  },
});

const noStaticLayer = defineRule({
  meta: { type: "suggestion", docs: { description: "Disallow a static layer on a service." } },
  create(context) {
    const check = (node: ESTree.PropertyDefinition | ESTree.MethodDefinition) => {
      if (node.static && node.key.type === "Identifier" && node.key.name === "layer")
        context.report({
          node,
          message:
            "Export the layer from the service's module: export const layer = Layer.effect(Service, make).",
        });
    };
    return { PropertyDefinition: check, MethodDefinition: check };
  },
});

const testsNextToModule = defineRule({
  meta: { type: "suggestion", docs: { description: "Keep tests next to the module they test." } },
  create(context) {
    return {
      Program: (node) => {
        if (/(^|\/)test\/.*\.test\.ts$/.test(context.filename))
          context.report({
            node,
            message: "Put the test next to the module it tests, as <Module>.test.ts.",
          });
      },
    };
  },
});

/** Whether `node` reads a `.message`, alone, in a template or joined with `+`. */
const readsMessage = (node: ESTree.Node): boolean => {
  if (node.type === "MemberExpression")
    return node.property.type === "Identifier" && node.property.name === "message";
  if (node.type === "TemplateLiteral") return node.expressions.some(readsMessage);
  if (node.type === "BinaryExpression") return readsMessage(node.left) || readsMessage(node.right);
  return false;
};

const noMessageFromCause = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Disallow building an error's message from another error's message." },
  },
  create(context) {
    const message =
      "Build the message from the error's own fields, and keep the failure as its cause.";
    return {
      // `new SomeError({ message: ... })`
      NewExpression: (node) => {
        for (const argument of node.arguments) {
          if (argument.type !== "ObjectExpression") continue;
          for (const property of argument.properties)
            if (
              property.type === "Property" &&
              property.key.type === "Identifier" &&
              property.key.name === "message" &&
              readsMessage(property.value)
            )
              context.report({ node: property, message });
        }
      },
      // `get message() { return ...; }` on an error class
      MethodDefinition: (node) => {
        if (node.kind !== "get" || node.key.type !== "Identifier" || node.key.name !== "message")
          return;
        for (const statement of node.value.body?.body ?? [])
          if (
            statement.type === "ReturnStatement" &&
            statement.argument &&
            readsMessage(statement.argument)
          )
            context.report({ node: statement, message });
      },
    };
  },
});

type ScopeContext = { readonly sourceCode: { getScope: (node: ESTree.Node) => Scope } };

/** The variable `identifier` names in its scope or an outer one. */
const variableOf = (context: ScopeContext, identifier: ESTree.Node & { readonly name: string }) => {
  for (
    let scope: Scope | null = context.sourceCode.getScope(identifier);
    scope;
    scope = scope.upper
  ) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
  }
  return undefined;
};

/** Whether `identifier` is `import * as X from "<source>"` in its scope. */
const isEffectNamespace = (
  context: ScopeContext,
  identifier: ESTree.IdentifierReference,
  source = "effect/Effect",
) =>
  variableOf(context, identifier)?.defs.some(
    (def) =>
      def.type === "ImportBinding" &&
      def.node.type === "ImportNamespaceSpecifier" &&
      def.parent?.type === "ImportDeclaration" &&
      def.parent.source.value === source,
  ) ?? false;

const isEffectMember = (
  context: ScopeContext,
  node: ESTree.Node,
  name: string,
  source = "effect/Effect",
) =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.object.type === "Identifier" &&
  node.property.type === "Identifier" &&
  node.property.name === name &&
  isEffectNamespace(context, node.object, source);

const recordKeysAreStrings = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require Schema.String as the key schema of Schema.Record." },
  },
  create(context) {
    return {
      CallExpression: (node) => {
        const [key] = node.arguments;
        if (
          isEffectMember(context, node.callee, "Record", "effect/Schema") &&
          key &&
          !isEffectMember(context, key, "String", "effect/Schema")
        )
          context.report({
            node: key,
            message:
              "Schema.Record drops keys its key schema rejects instead of failing on them. Use Schema.String keys and check the whole record (RecordWith in @rpgtl/contracts), or Schema.Struct for fixed keys.",
          });
      },
    };
  },
});

const preferCatchTags = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Require Effect.catchTags over Effect.catchTag." },
  },
  create(context) {
    return {
      MemberExpression: (node) => {
        if (isEffectMember(context, node, "catchTag"))
          context.report({
            node,
            message: "Catch known tags with Effect.catchTags({ Tag: handler }), even for one tag.",
          });
      },
    };
  },
});

const catchAlls = [
  "catch",
  "catchCause",
  "ignore",
  "option",
  "orElse",
  "orElseFail",
  "orElseSucceed",
];

const noCatchAll = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow handlers that catch every failure of an effect." },
  },
  create(context) {
    return {
      MemberExpression: (node) => {
        const name = catchAlls.find((catchAll) => isEffectMember(context, node, catchAll));
        if (name)
          context.report({
            node,
            message: `Effect.${name} also swallows failures nobody expected, such as a permission error. Catch the tags or reasons you expect with Effect.catchTags; where every failure really means the same, disable this rule with the reason.`,
          });
      },
    };
  },
});

const noLiteralCause = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Disallow a literal as an error's cause." },
  },
  create(context) {
    return {
      NewExpression: (node) => {
        for (const argument of node.arguments) {
          if (argument.type !== "ObjectExpression") continue;
          for (const property of argument.properties)
            if (
              property.type === "Property" &&
              property.key.type === "Identifier" &&
              property.key.name === "cause" &&
              (property.value.type === "Literal" ||
                (property.value.type === "TemplateLiteral" && !property.value.expressions.length))
            )
              context.report({
                node: property,
                message:
                  "A cause is the failure underneath. Give a condition such as a missing file its own error class or field.",
              });
        }
      },
    };
  },
});

/** Whether `node` is `Effect.gen(...)`, possibly followed by `.pipe(...)`. */
const isGenCall = (context: ScopeContext, node: ESTree.Node): boolean => {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "pipe"
  )
    return isGenCall(context, callee.object);
  return isEffectMember(context, callee, "gen");
};

const preferEffectFn = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Use Effect.fn for functions that return Effect.gen." },
  },
  create(context) {
    const check = (node: ESTree.ArrowFunctionExpression | ESTree.Function) => {
      if (node.async || node.generator || !node.body) return;
      const parent = node.parent;
      // Handlers passed to catchTags or match, and a Reference's default, are callbacks.
      if (parent.type === "Property") {
        const call = parent.parent.parent;
        if (call?.type === "CallExpression") {
          let callee = call.callee;
          while (callee.type === "CallExpression") callee = callee.callee;
          const name = parent.key.type === "Identifier" ? parent.key.name : undefined;
          if (
            callee.type === "MemberExpression" &&
            callee.property.type === "Identifier" &&
            (["catchTags", "match", "matchEffect", "matchCauseEffect"].includes(
              callee.property.name,
            ) ||
              (name === "defaultValue" && callee.property.name === "Reference"))
          )
            return;
        }
      } else if (
        node.type !== "FunctionDeclaration" &&
        parent.type !== "VariableDeclarator" &&
        parent.type !== "PropertyDefinition" &&
        parent.type !== "MethodDefinition"
      )
        return;
      const body = node.body;
      const returned =
        body.type !== "BlockStatement"
          ? body
          : body.body.length === 1 && body.body[0]?.type === "ReturnStatement"
            ? body.body[0].argument
            : null;
      if (returned && isGenCall(context, returned))
        context.report({
          node,
          message:
            'Write a function returning Effect.gen as Effect.fn("Service.operation")(function* () { ... }).',
        });
    };
    return {
      ArrowFunctionExpression: check,
      FunctionExpression: check,
      FunctionDeclaration: check,
    };
  },
});

/** The id of the service class `node`, which extends `X.Service<...>()(id, ...)` as Context and HttpApiMiddleware write it. */
const serviceId = (node: ESTree.Class) => {
  const outer = node.superClass;
  if (outer?.type !== "CallExpression" || outer.callee.type !== "CallExpression") return undefined;
  const callee = outer.callee.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.property.type !== "Identifier" ||
    callee.property.name !== "Service"
  )
    return undefined;
  return outer.arguments[0];
};

const serviceIdMatchesPath = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require a service's id to name its package, folder and class." },
  },
  create(context) {
    const place = /(?:^|\/)(?:apps|packages)\/([^/]+)\/src\/(?:(.*)\/)?[^/]+\.ts$/.exec(
      context.filename,
    );
    if (!place) return {};
    const [, pkg, folder] = place;
    const check = (node: ESTree.Class) => {
      const id = serviceId(node);
      if (!id || !node.id) return;
      const expected = `@rpgtl/${pkg}/${folder ? `${folder}/` : ""}${node.id.name}`;
      if (id.type !== "Literal" || id.value !== expected)
        context.report({ node: id, message: `Name the service "${expected}".` });
    };
    return { ClassDeclaration: check, ClassExpression: check };
  },
});

/** Whether `identifier` names a class in its scope that extends `X.Service<...>()(...)`. */
const isServiceClass = (context: ScopeContext, identifier: ESTree.IdentifierReference) =>
  variableOf(context, identifier)?.defs.some(
    (def) => def.node.type === "ClassDeclaration" && serviceId(def.node) !== undefined,
  ) ?? false;

/** The function `node` is or names, when it is written inline or bound with `const`. */
const plainFunction = (context: ScopeContext, node: ESTree.Node) => {
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") return node;
  if (node.type !== "Identifier") return undefined;
  for (const def of variableOf(context, node)?.defs ?? []) {
    const init = def.node.type === "VariableDeclarator" ? def.node.init : null;
    if (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression")
      return init;
  }
  return undefined;
};

const serviceMethodsEffectFn = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Require a service's methods to be written with Effect.fn." },
  },
  create(context) {
    return {
      CallExpression: (node) => {
        const callee = node.callee;
        const methods = node.arguments[0];
        if (
          callee.type !== "MemberExpression" ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "of" ||
          callee.object.type !== "Identifier" ||
          methods?.type !== "ObjectExpression" ||
          !isServiceClass(context, callee.object)
        )
          return;
        for (const property of methods.properties)
          if (property.type === "Property" && plainFunction(context, property.value))
            context.report({
              node: property,
              message:
                'Write the service\'s method as Effect.fn("Service.method")(function* () { ... }), so each call gets a span. A method that does no effectful work, such as building a path, is not a service method: export it from the module as a plain function.',
            });
      },
    };
  },
});

export default definePlugin({
  meta: { name: "rpgtl" },
  rules: {
    "no-async": noAsync,
    "no-try": noTry,
    "no-new-date": noNewDate,
    "effect-namespace-imports": effectNamespaceImports,
    "no-static-layer": noStaticLayer,
    "tests-next-to-module": testsNextToModule,
    "no-message-from-cause": noMessageFromCause,
    "prefer-catch-tags": preferCatchTags,
    "no-catch-all": noCatchAll,
    "no-literal-cause": noLiteralCause,
    "record-keys-are-strings": recordKeysAreStrings,
    "prefer-effect-fn": preferEffectFn,
    "service-id-matches-path": serviceIdMatchesPath,
    "service-methods-effect-fn": serviceMethodsEffectFn,
  },
});
