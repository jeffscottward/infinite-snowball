import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build, parseAst } from "vite";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REQUIRE = createRequire(import.meta.url);
const VITE_REQUIRE = createRequire(REQUIRE.resolve("vite/package.json"));
const { parseSync: parseSourceAst } = await import(
  pathToFileURL(VITE_REQUIRE.resolve("rolldown/utils")).href
);
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const DEFAULT_ENTRY = resolve(REPO_ROOT, "packages/protocol/src/browser.ts");
const APPROVED_PROTOCOL_SOURCE_ROOT = `${resolve(REPO_ROOT, "packages/protocol/src").split(sep).join("/")}/`;
const ALLOWED_ZOD_ROOT = `${dirname(REQUIRE.resolve("zod/package.json")).split(sep).join("/")}/`;
const REVIEWED_DYNAMIC_COMPUTED_ACCESS_COUNTS = new Map([
  [
    `${APPROVED_PROTOCOL_SOURCE_ROOT}errors.ts`,
    new Map([
      ["descriptors[index]", 1],
      ["issues[index]", 1],
      ["output[entryKey]", 1],
      ["output[key]", 1],
      ["output[output.length-1]", 1],
    ]),
  ],
  [
    `${APPROVED_PROTOCOL_SOURCE_ROOT}schema/json-schema.ts`,
    new Map([
      ["SCHEMA_REGISTRY[name]", 1],
      ["output[name]", 1],
    ]),
  ],
  [
    `${APPROVED_PROTOCOL_SOURCE_ROOT}schema/manifests.ts`,
    new Map([["value[segment]", 1]]),
  ],
  [
    `${APPROVED_PROTOCOL_SOURCE_ROOT}schema/preflight.ts`,
    new Map([
      ["frame.target[index]", 2],
      ["frame.target[key]", 2],
    ]),
  ],
  [
    `${APPROVED_PROTOCOL_SOURCE_ROOT}schema/records.ts`,
    new Map([
      ["children[index]", 1],
      ["expected.sectionChecksums[section]", 2],
      ["parsed.value.sectionChecksums[section]", 2],
      ["value[key]", 1],
    ]),
  ],
  [
    `${APPROVED_PROTOCOL_SOURCE_ROOT}validation/dependency-catalog.ts`,
    new Map([
      ["locked[index]", 1],
      ["output[key]", 1],
    ]),
  ],
]);
const REVIEWED_SOURCE_SHA256 = new Map([
  [`${APPROVED_PROTOCOL_SOURCE_ROOT}errors.ts`, "dec125c02ff06775dc9038a180d308c714e588273b128cf7f4b328b75cb74cc8"],
  [`${APPROVED_PROTOCOL_SOURCE_ROOT}schema/json-schema.ts`, "4fa8de544eb6bc6ba65794f208c3e80951092e8926233cc04392c213c6f57411"],
  [`${APPROVED_PROTOCOL_SOURCE_ROOT}schema/manifests.ts`, "e86f7d4d72123976585681630f0abfe93f8f42132846fed25ae5cec4cfd4ab95"],
  [`${APPROVED_PROTOCOL_SOURCE_ROOT}schema/preflight.ts`, "88e4d9c87abaefe8329d4f8b7d9316a5ce8918265ca88f8a2a3e03a4f5242af3"],
  [`${APPROVED_PROTOCOL_SOURCE_ROOT}schema/records.ts`, "1ceda6fd47494fc744f997f41f0c8fb72e3780a1a05e68b5f569eb29f2474742"],
  [`${APPROVED_PROTOCOL_SOURCE_ROOT}validation/dependency-catalog.ts`, "1d45f1ad446594654a33f9a9e6f4bca72ba571e9f9f90183bde15b56e1be8458"],
]);
const REVIEWED_DYNAMIC_DESCRIPTOR_ACCESS_COUNTS = new Map([
  [
    `${APPROVED_PROTOCOL_SOURCE_ROOT}errors.ts`,
    new Map([
      ["Object.getOwnPropertyDescriptor(value,String(index))", 1],
      ["Object.getOwnPropertyDescriptor(value,entryKey)", 1],
    ]),
  ],
  [
    `${APPROVED_PROTOCOL_SOURCE_ROOT}schema/preflight.ts`,
    new Map([
      ["Object.getOwnPropertyDescriptor(frame.source,key)", 2],
      ["Object.getOwnPropertyDescriptor(value,key)", 1],
    ]),
  ],
  [
    `${APPROVED_PROTOCOL_SOURCE_ROOT}schema/records.ts`,
    new Map([
      ["Object.getOwnPropertyDescriptor(current.value,String(index))", 1],
      ["Object.getOwnPropertyDescriptor(current.value,key)", 1],
    ]),
  ],
  [
    `${APPROVED_PROTOCOL_SOURCE_ROOT}validation/dependency-catalog.ts`,
    new Map([
      ["Object.getOwnPropertyDescriptor(value,String(index))", 1],
      ["Object.getOwnPropertyDescriptor(value,key)", 1],
    ]),
  ],
]);
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const PACKAGE_TOOLING = /^(?:@npmcli\/|libnpm|npm$|npm-package-arg$|pacote$|tar$|unzipper$|yauzl$)/;
const REMOTE_MODULE_SPECIFIER = /^(?:\/\/|(?:https?|wss?|ftp|data|blob|file):)/i;
const CAPABILITY_CONTRACTS = new Map([
  ["eval", ["B_EVAL", "Remove eval; browser protocol code may only interpret closed declarative data."]],
  ["Function", ["B_FUNCTION_CONSTRUCTOR", "Remove the Function constructor; executable community content is forbidden."]],
  ["fetch", ["B_NETWORK_FOLLOWING", "Remove direct network APIs; browser protocol code may consume only caller-supplied curated data."]],
  ["sendBeacon", ["B_NETWORK_FOLLOWING", "Remove direct network APIs; browser protocol code may consume only caller-supplied curated data."]],
  ["XMLHttpRequest", ["B_NETWORK_FOLLOWING", "Remove direct network APIs; browser protocol code may consume only caller-supplied curated data."]],
  ["WebSocket", ["B_NETWORK_FOLLOWING", "Remove direct network APIs; browser protocol code may consume only caller-supplied curated data."]],
  ["EventSource", ["B_NETWORK_FOLLOWING", "Remove direct network APIs; browser protocol code may consume only caller-supplied curated data."]],
  ["location", ["B_NETWORK_FOLLOWING", "Remove direct network APIs; browser protocol code may consume only caller-supplied curated data."]],
  ["open", ["B_NETWORK_FOLLOWING", "Remove direct network APIs; browser protocol code may consume only caller-supplied curated data."]],
  ["Image", ["B_NETWORK_FOLLOWING", "Remove direct network APIs; browser protocol code may consume only caller-supplied curated data."]],
  ["CompressionStream", ["B_ARCHIVE_PRIMITIVE", "Move compression and archive processing to bounded CLI/CI inspection."]],
  ["DecompressionStream", ["B_ARCHIVE_PRIMITIVE", "Move compression and archive processing to bounded CLI/CI inspection."]],
  ["Worker", ["B_CODE_EXECUTION", "Remove worker and script-loading execution primitives from the browser protocol graph."]],
  ["SharedWorker", ["B_CODE_EXECUTION", "Remove worker and script-loading execution primitives from the browser protocol graph."]],
  ["importScripts", ["B_CODE_EXECUTION", "Remove worker and script-loading execution primitives from the browser protocol graph."]],
  ["WebAssembly", ["B_CODE_EXECUTION", "Remove WebAssembly compilation or instantiation; browser protocol code validates declarative data only."]],
  ["Buffer", ["B_NODE_BUILTIN", "Remove the reachable Node global Buffer from the browser protocol graph."]],
  ["process", ["B_NODE_BUILTIN", "Remove the reachable Node global process from the browser protocol graph."]],
  ["require", ["B_NODE_BUILTIN", "Remove the reachable Node global require from the browser protocol graph."]],
  ["module", ["B_NODE_BUILTIN", "Remove the reachable Node global module from the browser protocol graph."]],
  ["__dirname", ["B_NODE_BUILTIN", "Remove the reachable Node global __dirname from the browser protocol graph."]],
  ["__filename", ["B_NODE_BUILTIN", "Remove the reachable Node global __filename from the browser protocol graph."]],
]);
const ALLOWED_UNBOUND_GLOBALS = new Set([
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Error",
  "EvalError",
  "Float32Array",
  "Float64Array",
  "Infinity",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "JSON",
  "Map",
  "NaN",
  "Number",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "SyntaxError",
  "TextDecoder",
  "TextEncoder",
  "TypeError",
  "URIError",
  "URL",
  "URLSearchParams",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "WeakMap",
  "WeakSet",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "structuredClone",
  "undefined",
]);
const ALLOWED_DIRECT_PURE_GLOBAL_METHODS = new Map([
  ["Date", new Set(["parse"])],
  ["Math", new Set(["floor", "max", "min"])],
]);
const ALLOWED_DIRECT_OBJECT_PROPERTIES = new Set([
  "assign",
  "create",
  "defineProperties",
  "defineProperty",
  "entries",
  "freeze",
  "fromEntries",
  "getOwnPropertyDescriptor",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "getPrototypeOf",
  "hasOwn",
  "is",
  "isExtensible",
  "isFrozen",
  "isSealed",
  "keys",
  "preventExtensions",
  "seal",
  "setPrototypeOf",
  "values",
]);

function displayModuleId(moduleId) {
  const normalized = moduleId.split(sep).join("/");
  const repoPrefix = `${REPO_ROOT.split(sep).join("/")}/`;
  return normalized.startsWith(repoPrefix) ? `/${normalized.slice(repoPrefix.length)}` : normalized;
}

function nodeName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}

function createBindingResolver(ast) {
  const declarationBindings = new WeakMap();
  const nodeScopes = new WeakMap();
  const createScope = (parent, kind) => ({ bindings: new Map(), kind, parent });
  const rootScope = createScope(undefined, "function");

  const declareIdentifier = (identifier, scope, existingBinding) => {
    if (identifier?.type !== "Identifier") return undefined;
    let binding = existingBinding ?? scope.bindings.get(identifier.name);
    if (binding === undefined) {
      binding = { name: identifier.name };
      scope.bindings.set(identifier.name, binding);
    } else if (!scope.bindings.has(identifier.name)) {
      scope.bindings.set(identifier.name, binding);
    }
    declarationBindings.set(identifier, binding);
    return binding;
  };
  const declarePattern = (pattern, scope) => {
    if (pattern?.type === "Identifier") {
      declareIdentifier(pattern, scope);
      return;
    }
    if (pattern?.type === "RestElement") {
      declarePattern(pattern.argument, scope);
      return;
    }
    if (pattern?.type === "AssignmentPattern") {
      declarePattern(pattern.left, scope);
      return;
    }
    if (pattern?.type === "ArrayPattern") {
      for (const element of pattern.elements) declarePattern(element, scope);
      return;
    }
    if (pattern?.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        declarePattern(property.type === "Property" ? property.value : property.argument, scope);
      }
    }
  };
  const nearestFunctionScope = (scope) => {
    let current = scope;
    while (current.kind !== "function") current = current.parent;
    return current;
  };
  const walk = (node, scope) => {
    if (node === null || typeof node !== "object" || typeof node.type !== "string") return;

    let activeScope = scope;
    if (node.type === "Program") {
      activeScope = rootScope;
    } else if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      const outerBinding =
        node.type === "FunctionDeclaration" ? declareIdentifier(node.id, scope) : undefined;
      const parameterScope = createScope(scope, "parameters");
      nodeScopes.set(node, parameterScope);
      if (node.id !== null && node.id !== undefined) {
        declareIdentifier(node.id, parameterScope, outerBinding);
      }
      for (const parameter of node.params) declarePattern(parameter, parameterScope);
      for (const parameter of node.params) walk(parameter, parameterScope);
      const bodyScope = createScope(parameterScope, "function");
      walk(node.body, bodyScope);
      return;
    } else if (node.type === "StaticBlock") {
      activeScope = createScope(scope, "function");
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      const outerBinding =
        node.type === "ClassDeclaration" ? declareIdentifier(node.id, scope) : undefined;
      activeScope = createScope(scope, "block");
      if (node.id !== null && node.id !== undefined) {
        declareIdentifier(node.id, activeScope, outerBinding);
      }
    } else if (
      node.type === "BlockStatement" ||
      node.type === "CatchClause" ||
      node.type === "ForStatement" ||
      node.type === "ForInStatement" ||
      node.type === "ForOfStatement" ||
      node.type === "SwitchStatement"
    ) {
      activeScope = createScope(scope, "block");
      if (node.type === "CatchClause") declarePattern(node.param, activeScope);
    }

    nodeScopes.set(node, activeScope);
    if (node.type === "VariableDeclaration") {
      const declarationScope =
        node.kind === "var" ? nearestFunctionScope(activeScope) : activeScope;
      for (const declarator of node.declarations) declarePattern(declarator.id, declarationScope);
    } else if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) declareIdentifier(specifier.local, activeScope);
    }

    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) walk(item, activeScope);
      } else {
        walk(child, activeScope);
      }
    }
  };
  walk(ast, rootScope);

  return (identifier) => {
    if (identifier?.type !== "Identifier") return undefined;
    const declaredBinding = declarationBindings.get(identifier);
    if (declaredBinding !== undefined) return declaredBinding;
    let scope = nodeScopes.get(identifier);
    while (scope !== undefined) {
      const binding = scope.bindings.get(identifier.name);
      if (binding !== undefined) return binding;
      scope = scope.parent;
    }
    return undefined;
  };
}

function resolvedPackageName(moduleId) {
  const marker = "/node_modules/";
  const markerIndex = moduleId.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const segments = moduleId.slice(markerIndex + marker.length).split("/");
  if (segments[0]?.startsWith("@")) return segments.length > 1 ? `${segments[0]}/${segments[1]}` : segments[0];
  return segments[0];
}

const ALLOWED_GLOBAL_DATA_PROPERTIES = new Set(["__zod_globalConfig", "__zod_globalRegistry"]);
const ALLOWED_REFLECT_PROPERTIES = new Set(["ownKeys"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);
const DOCUMENT_OBJECTS = new Set(["document"]);
const STRING_EVAL_SINKS = new Set(["setTimeout", "setInterval"]);

function countIdentifierWrites(ast, bindingOf) {
  const counts = new Map();
  const countIdentifier = (identifier) => {
    if (identifier?.type !== "Identifier") return;
    const binding = bindingOf(identifier);
    if (binding !== undefined) counts.set(binding, (counts.get(binding) ?? 0) + 1);
  };
  const countPattern = (pattern) => {
    if (pattern?.type === "Identifier") {
      countIdentifier(pattern);
      return;
    }
    if (pattern?.type === "RestElement") {
      countPattern(pattern.argument);
      return;
    }
    if (pattern?.type === "AssignmentPattern") {
      countPattern(pattern.left);
      countPattern(pattern.left);
      return;
    }
    if (pattern?.type === "ArrayPattern") {
      for (const element of pattern.elements) countPattern(element);
      return;
    }
    if (pattern?.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        countPattern(property.type === "Property" ? property.value : property.argument);
      }
    }
  };
  const seen = new WeakSet();
  const visit = (node) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (node.type === "VariableDeclarator") {
      countPattern(node.id);
    } else if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      for (const parameter of node.params) {
        countPattern(parameter);
        countPattern(parameter);
      }
    } else if (node.type === "CatchClause") {
      countPattern(node.param);
    } else if (node.type === "AssignmentExpression") {
      countPattern(node.left);
    } else if (node.type === "UpdateExpression") {
      countPattern(node.argument);
    } else if (
      (node.type === "ForInStatement" || node.type === "ForOfStatement") &&
      node.left?.type !== "VariableDeclaration"
    ) {
      countPattern(node.left);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else {
        visit(child);
      }
    }
  };
  visit(ast);
  return counts;
}

function createStaticState(ast) {
  const bindingOf = createBindingResolver(ast);
  return {
    bindingOf,
    capabilityAliases: new Map(),
    documentAliases: new Set(),
    documentCallableAliases: new Set(),
    globalAliases: new Set(),
    reflectAliases: new Set(),
    reflectGetAliases: new Set(),
    timerAliases: new Map(),
    stringAliases: new Map(),
    stringWriteCounts: countIdentifierWrites(ast, bindingOf),
  };
}

function literalString(node, state) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw;
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = literalString(node.left, state);
    const right = literalString(node.right, state);
    if (left !== undefined && right !== undefined) return left + right;
  }
  if (node?.type === "Identifier") {
    const binding = state.bindingOf(node);
    return state.stringWriteCounts.get(binding) === 1
      ? state.stringAliases.get(binding)
      : undefined;
  }
  return undefined;
}

function propertyName(node, state) {
  if (node?.type !== "MemberExpression") return undefined;
  if (!node.computed) return nodeName(node.property);
  const stringProperty = literalString(node.property, state);
  if (stringProperty !== undefined) return stringProperty;
  return node.property?.type === "Literal" &&
    (typeof node.property.value === "number" || typeof node.property.value === "bigint")
    ? String(node.property.value)
    : undefined;
}

function expressionSignature(node) {
  if (node?.type === "Identifier") return node.name;
  if (
    node?.type === "Literal" &&
    (typeof node.value === "string" ||
      typeof node.value === "number" ||
      typeof node.value === "bigint")
  ) {
    return String(node.value);
  }
  if (node?.type === "MemberExpression") {
    const object = expressionSignature(node.object);
    const property = node.computed
      ? expressionSignature(node.property)
      : nodeName(node.property);
    if (object === undefined || property === undefined) return undefined;
    return node.computed ? `${object}[${property}]` : `${object}.${property}`;
  }
  if (node?.type === "BinaryExpression") {
    const left = expressionSignature(node.left);
    const right = expressionSignature(node.right);
    return left === undefined || right === undefined
      ? undefined
      : `${left}${node.operator}${right}`;
  }
  if (node?.type === "CallExpression") {
    const callee = expressionSignature(node.callee);
    const argumentsList = node.arguments.map(expressionSignature);
    if (callee === undefined || argumentsList.some((argument) => argument === undefined)) {
      return undefined;
    }
    return `${callee}(${argumentsList.join(",")})`;
  }
  if (node?.type === "ChainExpression") return expressionSignature(node.expression);
  return undefined;
}

function globalObjectLabel(node, state) {
  if (node?.type === "Identifier") {
    const binding = state.bindingOf(node);
    if (binding === undefined && GLOBAL_OBJECTS.has(node.name)) return node.name;
    if (binding !== undefined && state.globalAliases.has(binding)) return "globalThis";
  }
  if (node?.type === "MemberExpression" && isGlobalObject(node.object, state)) {
    const property = propertyName(node, state);
    if (property !== undefined && GLOBAL_OBJECTS.has(property)) {
      return `${globalObjectLabel(node.object, state)}.${property}`;
    }
  }
  return "globalThis";
}

function isGlobalObject(node, state) {
  if (node?.type === "Identifier") {
    const binding = state.bindingOf(node);
    return (
      (binding === undefined && GLOBAL_OBJECTS.has(node.name)) ||
      (binding !== undefined && state.globalAliases.has(binding))
    );
  }
  if (node?.type === "MemberExpression") {
    const property = propertyName(node, state);
    return property !== undefined && GLOBAL_OBJECTS.has(property) && isGlobalObject(node.object, state);
  }
  if (isReflectGetCall(node, state) && isGlobalObject(node.arguments[0], state)) {
    const property = literalString(node.arguments[1], state);
    return property !== undefined && GLOBAL_OBJECTS.has(property);
  }
  return false;
}

function isDocumentObject(node, state) {
  if (node?.type === "Identifier") {
    const binding = state.bindingOf(node);
    return (
      (binding === undefined && DOCUMENT_OBJECTS.has(node.name)) ||
      (binding !== undefined && state.documentAliases.has(binding))
    );
  }
  if (node?.type === "MemberExpression") {
    return isGlobalObject(node.object, state) && propertyName(node, state) === "document";
  }
  return (
    isReflectGetCall(node, state) &&
    isGlobalObject(node.arguments[0], state) &&
    literalString(node.arguments[1], state) === "document"
  );
}

function isFunctionArgument(node) {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression" ||
    node?.type === "FunctionDeclaration"
  );
}

function isReflectObject(node, state) {
  if (node?.type === "Identifier") {
    const binding = state.bindingOf(node);
    return (
      (binding === undefined && node.name === "Reflect") ||
      (binding !== undefined && state.reflectAliases.has(binding))
    );
  }
  return (
    node?.type === "MemberExpression" &&
    isGlobalObject(node.object, state) &&
    propertyName(node, state) === "Reflect"
  );
}

function isReflectGetCallable(node, state) {
  if (node?.type === "Identifier") {
    const binding = state.bindingOf(node);
    return binding !== undefined && state.reflectGetAliases.has(binding);
  }
  if (
    node?.type === "MemberExpression" &&
    propertyName(node, state) === "get" &&
    isReflectObject(node.object, state)
  ) {
    return true;
  }
  if (node?.type === "CallExpression") {
    const callee = node.callee;
    if (callee?.type === "MemberExpression" && propertyName(callee, state) === "bind") {
      return isReflectGetCallable(callee.object, state);
    }
  }
  return false;
}

function isReflectGetCall(node, state) {
  return node?.type === "CallExpression" && isReflectGetCallable(node.callee, state);
}

function reflectiveGlobalCapability(node, state) {
  if (!isReflectGetCall(node, state) || !isGlobalObject(node.arguments[0], state)) return undefined;
  const capability = literalString(node.arguments[1], state);
  if (capability !== undefined && CAPABILITY_CONTRACTS.has(capability)) {
    return { evidence: `Reflect.get(${globalObjectLabel(node.arguments[0], state)}, "${capability}")`, name: capability };
  }
  if (capability === undefined) {
    return { evidence: `Reflect.get(${globalObjectLabel(node.arguments[0], state)}, computed)`, name: "Worker" };
  }
  return undefined;
}

function globalMemberCapability(node, state) {
  if (node?.type !== "MemberExpression") return undefined;
  const capability = propertyName(node, state);
  if (capability === undefined || !CAPABILITY_CONTRACTS.has(capability)) return undefined;
  if (isGlobalObject(node.object, state)) {
    const globalName = globalObjectLabel(node.object, state);
    return {
      evidence: node.computed ? `globalThis["${capability}"]` : `${globalName}.${capability}`,
      name: capability,
    };
  }
  if (
    capability === "sendBeacon" &&
    node.object?.type === "Identifier" &&
    node.object.name === "navigator" &&
    state.bindingOf(node.object) === undefined
  ) {
    return { evidence: "navigator.sendBeacon", name: capability };
  }
  return undefined;
}

function capabilityExpression(node, state) {
  if (node?.type === "Identifier") {
    const binding = state.bindingOf(node);
    if (binding === undefined && CAPABILITY_CONTRACTS.has(node.name)) {
      return { evidence: node.name, name: node.name };
    }
    return binding === undefined ? undefined : state.capabilityAliases.get(binding);
  }
  if (node?.type === "MemberExpression") {
    const directCapability = globalMemberCapability(node, state);
    if (directCapability !== undefined) return directCapability;
    const property = propertyName(node, state);
    if (property === "constructor") {
      return { callableOnly: true, evidence: ".constructor", name: "Function" };
    }
    if (property === "call" || property === "apply" || property === "bind") {
      return capabilityExpression(node.object, state);
    }
    return undefined;
  }
  if (node?.type === "CallExpression") {
    if (
      isReflectGetCall(node, state) &&
      literalString(node.arguments[1], state) === "constructor"
    ) {
      return {
        callableOnly: true,
        evidence: "Reflect.get(target, \"constructor\")",
        name: "Function",
      };
    }
    const reflectiveCapability = reflectiveGlobalCapability(node, state);
    if (reflectiveCapability !== undefined) return reflectiveCapability;
    const callee = node.callee;
    if (callee?.type === "MemberExpression" && propertyName(callee, state) === "bind") {
      return capabilityExpression(callee.object, state);
    }
  }
  return undefined;
}

function timerCallable(node, state) {
  if (node?.type === "Identifier") {
    const binding = state.bindingOf(node);
    if (binding === undefined && STRING_EVAL_SINKS.has(node.name)) {
      return { evidence: `globalThis.${node.name}`, name: node.name };
    }
    return binding === undefined ? undefined : state.timerAliases.get(binding);
  }
  if (node?.type === "MemberExpression" && isGlobalObject(node.object, state)) {
    const name = propertyName(node, state);
    if (name !== undefined && STRING_EVAL_SINKS.has(name)) {
      return { evidence: `${globalObjectLabel(node.object, state)}.${name}`, name };
    }
  }
  if (isReflectGetCall(node, state) && isGlobalObject(node.arguments[0], state)) {
    const name = literalString(node.arguments[1], state);
    if (name !== undefined && STRING_EVAL_SINKS.has(name)) {
      return {
        evidence: `Reflect.get(${globalObjectLabel(node.arguments[0], state)}, "${name}")`,
        name,
      };
    }
  }
  if (node?.type === "CallExpression") {
    const callee = node.callee;
    if (callee?.type === "MemberExpression" && propertyName(callee, state) === "bind") {
      return timerCallable(callee.object, state);
    }
  }
  return undefined;
}

function timerInvocation(callee, state) {
  const callable = timerCallable(callee, state);
  if (callable !== undefined) return { ...callable, argumentIndex: 0 };
  if (callee?.type !== "MemberExpression") return undefined;
  const method = propertyName(callee, state);
  if (method !== "call" && method !== "apply") return undefined;
  const forwarded = timerCallable(callee.object, state);
  return forwarded === undefined ? undefined : { ...forwarded, argumentIndex: 1 };
}

function documentCreateElementCallable(node, state) {
  if (node?.type === "Identifier") {
    const binding = state.bindingOf(node);
    if (binding !== undefined && state.documentCallableAliases.has(binding)) return true;
  }
  if (
    node?.type === "MemberExpression" &&
    isDocumentObject(node.object, state) &&
    propertyName(node, state) === "createElement"
  ) {
    return true;
  }
  if (
    isReflectGetCall(node, state) &&
    isDocumentObject(node.arguments[0], state) &&
    literalString(node.arguments[1], state) === "createElement"
  ) {
    return true;
  }
  if (node?.type === "CallExpression") {
    const callee = node.callee;
    if (callee?.type === "MemberExpression" && propertyName(callee, state) === "bind") {
      return documentCreateElementCallable(callee.object, state);
    }
  }
  return false;
}

function documentCreationArgumentIndex(callee, state) {
  if (documentCreateElementCallable(callee, state)) return 0;
  if (callee?.type !== "MemberExpression") return undefined;
  const method = propertyName(callee, state);
  if (method !== "call" && method !== "apply") return undefined;
  return documentCreateElementCallable(callee.object, state) ? 1 : undefined;
}

function computedGlobalAccessEvidence(node, state) {
  if (node?.type === "MemberExpression" && node.computed && isGlobalObject(node.object, state)) {
    return propertyName(node, state) === undefined ? `${globalObjectLabel(node.object, state)}[computed]` : undefined;
  }
  if (node?.type === "CallExpression") {
    const capability = reflectiveGlobalCapability(node, state);
    return capability?.evidence.endsWith(", computed)") ? capability.evidence : undefined;
  }
  return undefined;
}

function provenanceSize(state) {
  return (
    state.capabilityAliases.size +
    state.documentAliases.size +
    state.documentCallableAliases.size +
    state.globalAliases.size +
    state.reflectAliases.size +
    state.reflectGetAliases.size +
    state.timerAliases.size +
    state.stringAliases.size
  );
}

function propagateIdentifierProvenance(
  target,
  source,
  state,
  reportCapability,
  reportComputedGlobalAccess,
) {
  if (target?.type !== "Identifier" || source === null || source === undefined) return;
  const binding = state.bindingOf(target);
  if (binding === undefined) return;

  const stringValue = literalString(source, state);
  if (stringValue !== undefined && !state.stringAliases.has(binding)) {
    state.stringAliases.set(binding, stringValue);
  }
  if (isGlobalObject(source, state)) state.globalAliases.add(binding);
  if (isDocumentObject(source, state)) state.documentAliases.add(binding);
  if (isReflectObject(source, state)) state.reflectAliases.add(binding);
  if (isReflectGetCallable(source, state)) state.reflectGetAliases.add(binding);
  if (documentCreateElementCallable(source, state)) state.documentCallableAliases.add(binding);

  const timer = timerCallable(source, state);
  if (timer !== undefined && !state.timerAliases.has(binding)) state.timerAliases.set(binding, timer);
  const capability = capabilityExpression(source, state);
  if (capability !== undefined) {
    if (!state.capabilityAliases.has(binding)) state.capabilityAliases.set(binding, capability);
    if (capability.callableOnly !== true) reportCapability?.(capability.name, capability);
  }
  const computedEvidence = computedGlobalAccessEvidence(source, state);
  if (computedEvidence !== undefined) reportComputedGlobalAccess?.(computedEvidence);
}

function destructuredSourceKind(node, state) {
  if (isGlobalObject(node, state)) return "global";
  if (isDocumentObject(node, state)) return "document";
  if (isReflectObject(node, state)) return "reflect";
  return undefined;
}

function nestedDestructuredSourceKind(sourceKind, property) {
  if (sourceKind !== "global") return undefined;
  if (GLOBAL_OBJECTS.has(property)) return "global";
  if (property === "document") return "document";
  if (property === "Reflect") return "reflect";
  return undefined;
}

function walkObjectPatternFromSource(pattern, sourceKind, state, reportCapability) {
  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    const capability = property.computed ? literalString(property.key, state) : nodeName(property.key);
    if (capability === undefined) continue;
    const value =
      property.value?.type === "AssignmentPattern" ? property.value.left : property.value;
    if (value?.type === "ObjectPattern") {
      const nestedSourceKind = nestedDestructuredSourceKind(sourceKind, capability);
      if (nestedSourceKind !== undefined) {
        walkObjectPatternFromSource(value, nestedSourceKind, state, reportCapability);
      }
      continue;
    }
    if (value?.type !== "Identifier") continue;
    const binding = state.bindingOf(value);
    if (binding === undefined) continue;

    if (sourceKind === "document") {
      if (capability === "createElement") state.documentCallableAliases.add(binding);
      continue;
    }
    if (sourceKind === "reflect") {
      if (capability === "get") state.reflectGetAliases.add(binding);
      continue;
    }
    if (GLOBAL_OBJECTS.has(capability)) {
      state.globalAliases.add(binding);
      continue;
    }
    if (capability === "document") {
      state.documentAliases.add(binding);
      continue;
    }
    if (capability === "Reflect") {
      state.reflectAliases.add(binding);
      continue;
    }
    if (STRING_EVAL_SINKS.has(capability)) {
      if (!state.timerAliases.has(binding)) {
        state.timerAliases.set(binding, {
          evidence: `globalThis.${capability}`,
          name: capability,
        });
      }
      continue;
    }
    if (!CAPABILITY_CONTRACTS.has(capability)) continue;
    const provenance = { evidence: `globalThis.${capability}`, name: capability };
    if (!state.capabilityAliases.has(binding)) state.capabilityAliases.set(binding, provenance);
    reportCapability?.(capability, provenance);
  }
}

function walkObjectPattern(pattern, init, state, reportCapability) {
  if (pattern?.type !== "ObjectPattern") return;
  const sourceKind = destructuredSourceKind(init, state);
  if (sourceKind !== undefined) {
    walkObjectPatternFromSource(pattern, sourceKind, state, reportCapability);
  }
}

function discoverAliases(ast, state) {
  let previousSize;
  do {
    previousSize = provenanceSize(state);
    const seen = new WeakSet();
    const visit = (node) => {
      if (node === null || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (node.type === "VariableDeclarator") {
        if (node.id?.type === "Identifier") {
          propagateIdentifierProvenance(node.id, node.init, state);
        } else {
          walkObjectPattern(node.id, node.init, state);
        }
      } else if (node.type === "AssignmentExpression" && node.operator === "=") {
        if (node.left?.type === "Identifier") {
          propagateIdentifierProvenance(node.left, node.right, state);
        } else {
          walkObjectPattern(node.left, node.right, state);
        }
      } else if (node.type === "AssignmentPattern") {
        propagateIdentifierProvenance(node.left, node.right, state);
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) {
          for (const item of child) visit(item);
        } else {
          visit(child);
        }
      }
    };
    visit(ast);
  } while (provenanceSize(state) > previousSize);
}

function isIdentifierReference(node, parent, grandparent) {
  if (parent === undefined) return true;
  if (
    (parent.type === "VariableDeclarator" && parent.id === node) ||
    ((parent.type === "FunctionDeclaration" ||
      parent.type === "FunctionExpression" ||
      parent.type === "ArrowFunctionExpression") &&
      (parent.id === node || parent.params.includes(node))) ||
    ((parent.type === "ClassDeclaration" || parent.type === "ClassExpression") &&
      parent.id === node) ||
    (parent.type === "CatchClause" && parent.param === node) ||
    parent.type === "ArrayPattern" ||
    parent.type === "RestElement" ||
    (parent.type === "AssignmentPattern" && parent.left === node)
  ) {
    return false;
  }
  if (
    parent.type === "Property" &&
    grandparent?.type === "ObjectPattern"
  ) {
    return false;
  }
  if (
    parent.type === "Property" &&
    parent.key === node &&
    !parent.computed &&
    !(parent.shorthand === true && parent.value === node)
  ) {
    return false;
  }
  if (
    (parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") &&
    parent.key === node &&
    !parent.computed
  ) {
    return false;
  }
  if (
    parent.type === "MemberExpression" &&
    parent.property === node &&
    !parent.computed
  ) {
    return false;
  }
  if (
    parent.type === "ImportSpecifier" ||
    parent.type === "ImportDefaultSpecifier" ||
    parent.type === "ImportNamespaceSpecifier" ||
    parent.type === "ExportSpecifier" ||
    parent.type === "LabeledStatement" ||
    parent.type === "BreakStatement" ||
    parent.type === "ContinueStatement" ||
    parent.type === "MetaProperty"
  ) {
    return false;
  }
  return true;
}

function isAllowedGlobalDataReference(node, parent, grandparent, state) {
  if (node?.type !== "Identifier" || node.name !== "globalThis") return false;
  const member =
    parent?.type === "MemberExpression" && parent.object === node
      ? parent
      : parent?.type === "AssignmentExpression" &&
          parent.right === node &&
          grandparent?.type === "MemberExpression" &&
          grandparent.object === parent
        ? grandparent
        : undefined;
  const property = propertyName(member, state);
  return property !== undefined && ALLOWED_GLOBAL_DATA_PROPERTIES.has(property);
}

function isAllowedReflectReference(node, parent, grandparent, state) {
  return (
    node?.type === "Identifier" &&
    node.name === "Reflect" &&
    parent?.type === "MemberExpression" &&
    parent.object === node &&
    !parent.computed &&
    ALLOWED_REFLECT_PROPERTIES.has(propertyName(parent, state)) &&
    grandparent?.type === "CallExpression" &&
    grandparent.callee === parent
  );
}

function isAllowedPureGlobalReference(node, parent, grandparent, greatGrandparent, state) {
  if (ALLOWED_UNBOUND_GLOBALS.has(node.name)) return true;
  if (
    node.name === "Object" &&
    parent?.type === "MemberExpression" &&
    parent.object === node &&
    !parent.computed
  ) {
    const property = propertyName(parent, state);
    if (property === "prototype") return true;
    return (
      property !== undefined &&
      ALLOWED_DIRECT_OBJECT_PROPERTIES.has(property) &&
      grandparent?.type === "CallExpression" &&
      grandparent.callee === parent
    );
  }
  if (
    node.name === "Date" &&
    parent?.type === "NewExpression" &&
    parent.callee === node &&
    parent.arguments.length === 1 &&
    parent.arguments[0]?.type === "Literal" &&
    parent.arguments[0].value === 0
  ) {
    return true;
  }
  const allowedMethods = ALLOWED_DIRECT_PURE_GLOBAL_METHODS.get(node.name);
  if (
    allowedMethods !== undefined &&
    parent?.type === "MemberExpression" &&
    parent.object === node &&
    !parent.computed &&
    allowedMethods.has(propertyName(parent, state)) &&
    grandparent?.type === "CallExpression" &&
    grandparent.callee === parent
  ) {
    return true;
  }
  return (
    node.name === "crypto" &&
    parent?.type === "MemberExpression" &&
    parent.object === node &&
    !parent.computed &&
    propertyName(parent, state) === "subtle" &&
    grandparent?.type === "MemberExpression" &&
    grandparent.object === parent &&
    !grandparent.computed &&
    propertyName(grandparent, state) === "digest" &&
    greatGrandparent?.type === "CallExpression" &&
    greatGrandparent.callee === grandparent
  );
}

function isAllowedUnboundGlobalReference(
  node,
  parent,
  grandparent,
  greatGrandparent,
  state,
  allowBundledDependencyGlobals,
) {
  if (isAllowedPureGlobalReference(node, parent, grandparent, greatGrandparent, state)) {
    return true;
  }
  if (allowBundledDependencyGlobals && node.name === "Object") return true;
  if (
    allowBundledDependencyGlobals &&
    isAllowedGlobalDataReference(node, parent, grandparent, state)
  ) {
    return true;
  }
  return isAllowedReflectReference(node, parent, grandparent, state);
}

function objectDescriptorAccess(node, state) {
  const callee = node?.type === "CallExpression" ? node.callee : undefined;
  if (
    callee?.type !== "MemberExpression" ||
    propertyName(callee, state) !== "getOwnPropertyDescriptor" ||
    callee.object?.type !== "Identifier" ||
    callee.object.name !== "Object" ||
    state.bindingOf(callee.object) !== undefined
  ) {
    return undefined;
  }
  return { property: literalString(node.arguments[1], state) };
}
function inspectImportMetaUrlAst(ast, moduleId, addViolation) {
  const seen = new WeakSet();
  const visit = (node) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (
      node.type === "MetaProperty" &&
      nodeName(node.meta) === "import" &&
      nodeName(node.property) === "meta"
    ) {
      addViolation(
        "B_COMMUNITY_CODE",
        moduleId,
        "Remove import.meta access; browser protocol code may not resolve, load, or follow ambient modules or assets.",
        "import.meta",
      );
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else {
        visit(child);
      }
    }
  };
  visit(ast);
}

function inspectAst(
  ast,
  moduleId,
  addViolation,
  {
    allowBundledDependencyGlobals = false,
    allowBundledDependencyConstructorReads = false,
    allowDynamicComputed = false,
    allowDynamicDescriptorAccess = false,
    reviewedDynamicComputedAccesses,
    reviewedDynamicDescriptorAccesses,
  } = {},
) {
  const state = createStaticState(ast);
  discoverAliases(ast, state);
  const remainingReviewedComputedAccesses = new Map(reviewedDynamicComputedAccesses ?? []);
  const consumeReviewedComputedAccess = (node) => {
    const signature = expressionSignature(node);
    if (signature === undefined) return false;
    const remaining = remainingReviewedComputedAccesses.get(signature) ?? 0;
    if (remaining <= 0) return false;
    remainingReviewedComputedAccesses.set(signature, remaining - 1);
    return true;
  };
  const remainingReviewedDescriptorAccesses = new Map(
    reviewedDynamicDescriptorAccesses ?? [],
  );
  const consumeReviewedDescriptorAccess = (node) => {
    const signature = expressionSignature(node);
    if (signature === undefined) return false;
    const remaining = remainingReviewedDescriptorAccesses.get(signature) ?? 0;
    if (remaining <= 0) return false;
    remainingReviewedDescriptorAccesses.set(signature, remaining - 1);
    return true;
  };
  const seen = new WeakSet();
  const reportCapability = (name, nodeOrEvidence) => {
    const contract = CAPABILITY_CONTRACTS.get(name);
    if (contract === undefined) return;
    const evidence = typeof nodeOrEvidence?.evidence === "string"
      ? nodeOrEvidence.evidence
      : capabilityExpression(nodeOrEvidence, state)?.evidence ?? name;
    addViolation(contract[0], moduleId, contract[1], evidence);
  };
  const reportComputedGlobalAccess = (evidence) => {
    addViolation(
      "B_CODE_EXECUTION",
      moduleId,
      "Remove computed global capability access; browser protocol code may use only explicit data and validators.",
      evidence,
    );
  };
  const visit = (node, parent, grandparent, greatGrandparent) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);

    if (node.type === "ImportExpression") {
      addViolation(
        "B_DYNAMIC_IMPORT",
        moduleId,
        "Replace dynamic community imports with static protocol schema and immutable data references.",
        "import(...)",
      );
    }

    if (node.type === "VariableDeclarator") {
      if (node.id?.type === "Identifier") {
        propagateIdentifierProvenance(
          node.id,
          node.init,
          state,
          reportCapability,
          reportComputedGlobalAccess,
        );
      } else {
        walkObjectPattern(node.id, node.init, state, reportCapability);
      }
    } else if (node.type === "AssignmentExpression" && node.operator === "=") {
      if (node.left?.type === "Identifier") {
        propagateIdentifierProvenance(
          node.left,
          node.right,
          state,
          reportCapability,
          reportComputedGlobalAccess,
        );
      } else {
        walkObjectPattern(node.left, node.right, state, reportCapability);
      }
    } else if (node.type === "AssignmentPattern") {
      propagateIdentifierProvenance(
        node.left,
        node.right,
        state,
        reportCapability,
        reportComputedGlobalAccess,
      );
    }

    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const capability = capabilityExpression(node.callee, state);
      if (capability !== undefined) reportCapability(capability.name, capability);
      const computedEvidence = computedGlobalAccessEvidence(node.callee, state);
      if (computedEvidence !== undefined) reportComputedGlobalAccess(computedEvidence);
      const descriptorAccess = objectDescriptorAccess(node, state);
      if (
        descriptorAccess?.property === "constructor" ||
        (descriptorAccess !== undefined &&
          descriptorAccess.property === undefined &&
          !allowDynamicDescriptorAccess &&
          !consumeReviewedDescriptorAccess(node))
      ) {
        addViolation(
          "B_FUNCTION_CONSTRUCTOR",
          moduleId,
          "Remove constructor descriptor extraction; executable community content is forbidden.",
          descriptorAccess.property === "constructor"
            ? "Object.getOwnPropertyDescriptor(target, \"constructor\")"
            : "Object.getOwnPropertyDescriptor(target, computed)",
        );
      }
    }

    if (node.type === "CallExpression") {
      const timer = timerInvocation(node.callee, state);
      if (timer !== undefined && !isFunctionArgument(node.arguments[timer.argumentIndex])) {
        addViolation(
          "B_EVAL",
          moduleId,
          "Remove string-evaluating timer calls; browser protocol code may only execute closed validators.",
          `${timer.evidence}(string)`,
        );
      }

      const documentArgumentIndex = documentCreationArgumentIndex(node.callee, state);
      if (
        documentArgumentIndex !== undefined &&
        literalString(node.arguments[documentArgumentIndex], state)?.toLowerCase() === "script"
      ) {
        addViolation(
          "B_CODE_EXECUTION",
          moduleId,
          "Remove DOM script creation; browser protocol code must not load or inject executable content.",
          "document.createElement(\"script\")",
        );
      }
    }

    if (node.type === "Property" && parent?.type === "ObjectPattern") {
      const destructuredProperty = node.computed
        ? literalString(node.key, state)
        : nodeName(node.key);
      if (destructuredProperty === undefined) {
        addViolation(
          "B_CODE_EXECUTION",
          moduleId,
          "Remove unresolved computed destructuring; browser protocol code may use only statically reviewed properties.",
          "[computed](...)",
        );
      } else if (destructuredProperty === "constructor") {
        addViolation(
          "B_FUNCTION_CONSTRUCTOR",
          moduleId,
          "Remove constructor destructuring; executable community content is forbidden.",
          ".constructor",
        );
      }
    }

    if (node.type === "Identifier" && isIdentifierReference(node, parent, grandparent)) {
      const capability = capabilityExpression(node, state);
      if (capability !== undefined && capability.callableOnly !== true) {
        reportCapability(capability.name, capability);
      }
      if (
        state.bindingOf(node) === undefined &&
        !CAPABILITY_CONTRACTS.has(node.name) &&
        !isAllowedUnboundGlobalReference(
          node,
          parent,
          grandparent,
          greatGrandparent,
          state,
          allowBundledDependencyGlobals,
        )
      ) {
        addViolation(
          "B_CODE_EXECUTION",
          moduleId,
          "Remove unapproved global references; protocol code may use only explicitly allowlisted pure globals.",
          node.name,
        );
      }
    }
    if (node.type === "MemberExpression") {
      if (
        !allowDynamicComputed &&
        node.computed &&
        propertyName(node, state) === undefined &&
        !consumeReviewedComputedAccess(node)
      ) {
        addViolation(
          "B_CODE_EXECUTION",
          moduleId,
          "Remove unresolved computed member access; browser protocol code may use only statically reviewed properties.",
          "[computed](...)",
        );
      }
      const capability = globalMemberCapability(node, state);
      if (capability !== undefined) reportCapability(capability.name, capability);
      const constructorCapability = capabilityExpression(node, state);
      if (
        !allowBundledDependencyConstructorReads &&
        constructorCapability?.name === "Function"
      ) {
        reportCapability(constructorCapability.name, constructorCapability);
      }
      if (isReflectGetCallable(node, state)) {
        addViolation(
          "B_CODE_EXECUTION",
          moduleId,
          "Remove Reflect.get access; protocol code must not derive executable capabilities.",
          "Reflect.get",
        );
      }
    }

    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item, node, parent, grandparent);
      } else {
        visit(child, node, parent, grandparent);
      }
    }
  };
  visit(ast, undefined, undefined, undefined);
  for (const [signature, remaining] of remainingReviewedComputedAccesses) {
    if (remaining === 0) continue;
    addViolation(
      "B_CODE_EXECUTION",
      moduleId,
      "Remove stale computed-member exceptions or restore the exact reviewed data access.",
      `[reviewed-computed:${signature}]`,
    );
  }
  for (const [signature, remaining] of remainingReviewedDescriptorAccesses) {
    if (remaining === 0) continue;
    addViolation(
      "B_CODE_EXECUTION",
      moduleId,
      "Remove stale descriptor exceptions or restore the exact reviewed data access.",
      `[reviewed-descriptor:${signature}]`,
    );
  }
}

export async function inspectBrowserGraph(entry = DEFAULT_ENTRY) {
  const absoluteEntry = resolve(entry);
  const modules = new Set();
  const normalizedEntry = absoluteEntry.split(sep).join("/");
  const violations = new Map();
  const reviewedSourceHashes = new Map();
  const addViolation = (ruleId, moduleId, remediation, evidence) => {
    const displayed = displayModuleId(moduleId);
    const violation =
      evidence === undefined
        ? { ruleId, moduleId: displayed, remediation }
        : { ruleId, moduleId: displayed, evidence, remediation };
    violations.set(`${ruleId}\u0000${displayed}\u0000${evidence ?? ""}`, violation);
  };

  let outputBytes = 0;
  try {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        sourcemap: false,
        lib: { entry: absoluteEntry, formats: ["es"], fileName: "protocol-browser" },
        rollupOptions: {
          treeshake: true,
          onwarn(warning, warn) {
            if (warning.code !== "EMPTY_BUNDLE") warn(warning);
          },
        },
      },
      plugins: [
        {
          name: "infinite-snowball-browser-boundary-resolve",
          enforce: "pre",
          resolveId(source, importer) {
            if (BUILTINS.has(source)) {
              addViolation("B_NODE_BUILTIN", importer ?? absoluteEntry, `Remove the reachable Node built-in import: ${source}.`);
              return { id: source, external: true };
            }
            if (REMOTE_MODULE_SPECIFIER.test(source)) {
              addViolation(
                "B_NETWORK_FOLLOWING",
                importer ?? absoluteEntry,
                "Remove remote and URL-like module specifiers; browser protocol code may not follow external code.",
                "remote module specifier",
              );
              return { id: source, external: true };
            }
            const normalizedImporter = importer?.split(/[?#]/, 1)[0].split(sep).join("/");
            const localSource = source.startsWith(".") || source.startsWith("/");
            const cleanLocalSource = source.split(/[?#]/, 1)[0];
            const localExtension = cleanLocalSource.slice(cleanLocalSource.lastIndexOf("/") + 1).includes(".");
            const importerRequiresSourceReview =
              normalizedImporter !== undefined &&
              !normalizedImporter.startsWith(ALLOWED_ZOD_ROOT) &&
              normalizedImporter !== "rolldown/runtime.js" &&
              normalizedImporter !== "\u0000rolldown/runtime.js";
            if (
              importerRequiresSourceReview &&
              localSource &&
              (source.includes("?") ||
                source.includes("#") ||
                (localExtension && !/\.[cm]?[jt]sx?$/i.test(cleanLocalSource)))
            ) {
              addViolation(
                "B_COMMUNITY_CODE",
                importer,
                "Remove non-code and query-loaded modules; browser protocol modules may import reviewed JavaScript or TypeScript only.",
                "non-code module specifier",
              );
              return { id: source, external: true };
            }
            if (PACKAGE_TOOLING.test(source)) {
              addViolation(
                "B_PACKAGE_TOOLING",
                importer ?? absoluteEntry,
                `Move npm/archive resolution (${source}) to bounded CLI/CI inspection.`,
              );
              return { id: source, external: true };
            }
            const barePackage =
              !source.startsWith(".") &&
              !source.startsWith("/") &&
              !source.startsWith("\u0000") &&
              !/^[A-Za-z]:/.test(source);
            if (barePackage && source !== "zod" && !source.startsWith("zod/")) {
              addViolation(
                "B_DEPENDENCY_FORBIDDEN",
                importer ?? absoluteEntry,
                `Remove non-allowlisted browser dependency: ${source}.`,
              );
              return { id: source, external: true };
            }
            return null;
          },
        },
        {
          name: "infinite-snowball-browser-boundary-source-ast",
          enforce: "pre",
          transform(code, id) {
            const normalized = id.split(/[?#]/, 1)[0].split(sep).join("/");
            if (REVIEWED_SOURCE_SHA256.has(normalized)) {
              reviewedSourceHashes.set(
                normalized,
                createHash("sha256").update(code).digest("hex"),
              );
            }
            const isRuntimeModule =
              normalized === "rolldown/runtime.js" ||
              normalized === "\u0000rolldown/runtime.js";
            const moduleName = normalized.slice(normalized.lastIndexOf("/") + 1);
            const hasFileExtension = moduleName.includes(".");
            if (
              isRuntimeModule ||
              normalized.startsWith("\u0000") ||
              normalized.startsWith(ALLOWED_ZOD_ROOT) ||
              (hasFileExtension && !/\.[cm]?[jt]sx?$/i.test(normalized))
            ) {
              return null;
            }
            const language = normalized.endsWith("x")
              ? normalized.endsWith(".tsx")
                ? "tsx"
                : "jsx"
              : normalized.endsWith("ts")
                ? "ts"
                : "js";
            const parsed = parseSourceAst(normalized, code, {
              lang: language,
              sourceType: "module",
            });
            if (parsed.errors.length > 0) throw parsed.errors[0];
            inspectImportMetaUrlAst(parsed.program, id, addViolation);
            return null;
          },
        },
        {
          name: "infinite-snowball-browser-boundary-ast",
          enforce: "post",
          transform(code, id) {
            modules.add(id);
            const normalized = id.split(/[?#]/, 1)[0].split(sep).join("/");
            if (normalized.includes("/packages/protocol/scripts/") || normalized.includes("/packages/protocol/src/offline/")) {
              addViolation(
                "B_FORBIDDEN_LAYER",
                id,
                "Keep Node tooling and the offline design model outside the browser export graph.",
              );
            }
            const resolvedPackage = resolvedPackageName(normalized);
            if (
              resolvedPackage !== undefined &&
              (resolvedPackage !== "zod" || !normalized.startsWith(ALLOWED_ZOD_ROOT))
            ) {
              addViolation(
                "B_DEPENDENCY_FORBIDDEN",
                id,
                `Remove non-allowlisted resolved browser dependency: ${resolvedPackage}.`,
              );
            } else if (
              resolvedPackage === undefined &&
              isAbsolute(normalized) &&
              normalized !== normalizedEntry &&
              !normalized.startsWith(APPROVED_PROTOCOL_SOURCE_ROOT)
            ) {
              addViolation(
                "B_COMMUNITY_CODE",
                id,
                "Remove executable community modules; consume curated immutable data files only.",
              );
            }
            const isRuntimeModule =
              normalized === "rolldown/runtime.js" ||
              normalized === "\u0000rolldown/runtime.js";
            const isAllowedDependencyModule = normalized.startsWith(ALLOWED_ZOD_ROOT);
            if (!isRuntimeModule && !isAllowedDependencyModule) {
              const expectedSourceHash = REVIEWED_SOURCE_SHA256.get(normalized);
              const reviewedSourceMatches =
                expectedSourceHash === undefined ||
                reviewedSourceHashes.get(normalized) === expectedSourceHash;
              if (!reviewedSourceMatches) {
                addViolation(
                  "B_CODE_EXECUTION",
                  id,
                  "Re-review the complete source module before updating its immutable reviewed hash.",
                  "[reviewed-source-hash-mismatch]",
                );
              }
              inspectAst(parseAst(code), id, addViolation, {
                reviewedDynamicComputedAccesses: reviewedSourceMatches
                  ? REVIEWED_DYNAMIC_COMPUTED_ACCESS_COUNTS.get(normalized)
                  : undefined,
                reviewedDynamicDescriptorAccesses: reviewedSourceMatches
                  ? REVIEWED_DYNAMIC_DESCRIPTOR_ACCESS_COUNTS.get(normalized)
                  : undefined,
              });
            }
            return null;
          },
        },
      ],
    });

    const buildResults = Array.isArray(result) ? result : [result];
    for (const buildResult of buildResults) {
      for (const item of buildResult.output ?? []) {
        if (item.type === "chunk") {
          outputBytes += Buffer.byteLength(item.code);
          for (const specifier of [...(item.imports ?? []), ...(item.dynamicImports ?? [])]) {
            if (!REMOTE_MODULE_SPECIFIER.test(specifier)) continue;
            addViolation(
              "B_NETWORK_FOLLOWING",
              absoluteEntry,
              "Remove remote bundle imports; browser protocol code may not follow external code.",
              "remote emitted import",
            );
          }
          inspectAst(parseAst(item.code), absoluteEntry, addViolation, {
            allowBundledDependencyGlobals: true,
            allowBundledDependencyConstructorReads: true,
            allowDynamicComputed: true,
            allowDynamicDescriptorAccess: true,
          });
        } else {
          addViolation(
            "B_COMMUNITY_CODE",
            absoluteEntry,
            "Remove emitted assets; browser protocol bundles must contain reviewed executable chunks only.",
            "emitted asset",
          );
          outputBytes += item.source instanceof Uint8Array ? item.source.byteLength : Buffer.byteLength(String(item.source));
        }
      }
    }
  } catch (error) {
    addViolation(
      "B_GRAPH_BUILD",
      absoluteEntry,
      error instanceof Error ? `Repair the browser graph so Vite can resolve it: ${error.message.slice(0, 240)}` : "Repair the browser graph.",
    );
  }

  const orderedModules = [...modules].map(displayModuleId).sort();
  const orderedViolations = [...violations.values()].sort((left, right) =>
    [left.ruleId, left.moduleId, left.evidence ?? ""].join("\u0000").localeCompare([right.ruleId, right.moduleId, right.evidence ?? ""].join("\u0000")),
  );
  return { ok: orderedViolations.length === 0, modules: orderedModules, violations: orderedViolations, outputBytes };
}

export async function assertBrowserBoundary(entry = DEFAULT_ENTRY) {
  const result = await inspectBrowserGraph(entry);
  if (!result.ok) {
    throw new Error(result.violations.map((violation) => `${violation.ruleId} ${violation.moduleId}`).join("\n"));
  }
  return result;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await assertBrowserBoundary(process.argv[2] ?? DEFAULT_ENTRY);
    process.stdout.write(
      `${JSON.stringify({ ok: true, modules: result.modules.length, outputBytes: result.outputBytes })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
