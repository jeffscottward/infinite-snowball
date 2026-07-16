import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Expression, Node, SourceFile } from "typescript/unstable/ast";
import * as ts from "typescript/unstable/ast";
import type { Diagnostic, Project } from "typescript/unstable/sync";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

const execFileAsync = promisify(execFile);
const AUDITED_PNPM_RUNNER = join(
	ROOT,
	"tools",
	"quality",
	"run-audited-pnpm.mjs",
);
const RUNTIME_PACKAGE_NAMES = [
	"engine",
	"input",
	"gameplay",
	"runtime-r3f",
] as const;

type RuntimePackageName = (typeof RUNTIME_PACKAGE_NAMES)[number];
type Capability =
	| "device-adapter"
	| "koota-core"
	| "node"
	| "normalized-input"
	| "physics"
	| "raw-device"
	| "react"
	| "render"
	| "workspace-runtime";

interface PackageBoundary {
	readonly allowedAmbientGlobals: readonly string[];
	readonly allowedCapabilities: readonly Capability[];
	readonly allowedStaticExports: readonly string[];
	readonly allowedStaticImports: readonly string[];
}

const PACKAGE_BOUNDARIES: Readonly<
	Record<RuntimePackageName, PackageBoundary>
> = {
	engine: {
		allowedAmbientGlobals: ["queueMicrotask"],
		allowedCapabilities: ["koota-core"],
		allowedStaticExports: [],
		allowedStaticImports: ["koota"],
	},
	input: {
		allowedAmbientGlobals: [],
		allowedCapabilities: [],
		allowedStaticExports: [],
		allowedStaticImports: [],
	},
	gameplay: {
		allowedAmbientGlobals: [],
		allowedCapabilities: ["normalized-input"],
		allowedStaticExports: [],
		allowedStaticImports: ["@infinite-snowball/input"],
	},
	"runtime-r3f": {
		allowedAmbientGlobals: [],
		allowedCapabilities: [
			"device-adapter",
			"normalized-input",
			"physics",
			"react",
			"render",
			"workspace-runtime",
		],
		allowedStaticExports: [],
		allowedStaticImports: [
			"@infinite-snowball/engine",
			"@infinite-snowball/gameplay",
			"@infinite-snowball/input",
			"@react-three/fiber",
			"@react-three/rapier",
			"ecctrl",
			"react",
			"three",
		],
	},
};

const RAW_DEVICE_IDENTIFIERS: Readonly<Record<string, true>> = {
	DeviceMotionEvent: true,
	DeviceOrientationEvent: true,
	Gamepad: true,
	GamepadButton: true,
	GamepadEvent: true,
	HTMLElement: true,
	KeyboardEvent: true,
	PointerEvent: true,
	TouchEvent: true,
	document: true,
	navigator: true,
	requestAnimationFrame: true,
	window: true,
};
const NODE_GLOBAL_IDENTIFIERS: Readonly<Record<string, true>> = {
	Buffer: true,
	__dirname: true,
	__filename: true,
	exports: true,
	global: true,
	module: true,
	process: true,
};
const DANGEROUS_REFERENCE_IDENTIFIERS: Readonly<Record<string, true>> = {
	Function: true,
	eval: true,
	require: true,
};
const PURE_RUNTIME_PACKAGES: Readonly<
	Partial<Record<RuntimePackageName, true>>
> = {
	engine: true,
	input: true,
	gameplay: true,
};
const FORBIDDEN_AMBIENT_CAPABILITY_BY_IDENTIFIER: Readonly<
	Record<
		string,
		"ambient-global" | "dynamic-code" | "network" | "wasm" | "worker"
	>
> = {
	AudioWorklet: "worker",
	EventSource: "network",
	RTCPeerConnection: "network",
	ServiceWorker: "worker",
	SharedWorker: "worker",
	WebAssembly: "wasm",
	WebSocket: "network",
	WebTransport: "network",
	Worker: "worker",
	XMLHttpRequest: "network",
	fetch: "network",
	globalThis: "ambient-global",
	importScripts: "worker",
	postMessage: "worker",
	self: "ambient-global",
	setInterval: "dynamic-code",
	setTimeout: "dynamic-code",
};
const ALLOWED_PURE_AMBIENT_GLOBALS: Readonly<Record<string, true>> = {
	AggregateError: true,
	Array: true,
	ArrayBuffer: true,
	ArrayLike: true,
	Awaited: true,
	BigInt: true,
	BigInt64Array: true,
	BigUint64Array: true,
	Boolean: true,
	ConstructorParameters: true,
	DataView: true,
	Error: true,
	EvalError: true,
	Exclude: true,
	Extract: true,
	Float32Array: true,
	Float64Array: true,
	InstanceType: true,
	Int8Array: true,
	Int16Array: true,
	Int32Array: true,
	Intl: true,
	Iterable: true,
	IterableIterator: true,
	Iterator: true,
	JSON: true,
	Lowercase: true,
	Map: true,
	Math: true,
	NaN: true,
	NonNullable: true,
	Number: true,
	Object: true,
	Omit: true,
	OmitThisParameter: true,
	Parameters: true,
	Partial: true,
	Pick: true,
	Promise: true,
	PromiseLike: true,
	PropertyKey: true,
	RangeError: true,
	Readonly: true,
	ReadonlyArray: true,
	ReadonlyMap: true,
	ReadonlySet: true,
	Record: true,
	ReferenceError: true,
	Reflect: true,
	RegExp: true,
	Required: true,
	ReturnType: true,
	Set: true,
	String: true,
	Symbol: true,
	SyntaxError: true,
	ThisParameterType: true,
	TypeError: true,
	URIError: true,
	Uint8Array: true,
	Uint8ClampedArray: true,
	Uint16Array: true,
	Uint32Array: true,
	Uncapitalize: true,
	Uppercase: true,
	WeakMap: true,
	WeakSet: true,
	decodeURI: true,
	decodeURIComponent: true,
	encodeURI: true,
	encodeURIComponent: true,
	escape: true,
	isFinite: true,
	isNaN: true,
	parseFloat: true,
	parseInt: true,
	undefined: true,
	unescape: true,
};
const NODE_MODULE_ROOTS = new Set(
	builtinModules.map((moduleName) => {
		const withoutProtocol = moduleName.startsWith("node:")
			? moduleName.slice("node:".length)
			: moduleName;
		return withoutProtocol.split("/")[0] ?? withoutProtocol;
	}),
);

async function sourceFiles(
	packageName: RuntimePackageName,
): Promise<readonly string[]> {
	const sourceRoot = join(ROOT, "packages", packageName, "src");
	const entries = await readdir(sourceRoot, {
		recursive: true,
		withFileTypes: true,
	});
	return entries
		.filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name))
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
}

function externalPackageRoot(specifier: string): string {
	const segments = specifier.split("/");
	if (specifier.startsWith("@")) {
		return segments.slice(0, 2).join("/");
	}
	return segments[0] ?? specifier;
}

function isNodeModuleSpecifier(specifier: string): boolean {
	const withoutProtocol = specifier.startsWith("node:")
		? specifier.slice("node:".length)
		: specifier;
	const root = withoutProtocol.split("/")[0];
	return root !== undefined && NODE_MODULE_ROOTS.has(root);
}

function moduleCapability(specifier: string): Capability | null {
	if (isNodeModuleSpecifier(specifier)) return "node";
	const root = externalPackageRoot(specifier);
	if (root === "koota") return specifier === "koota" ? "koota-core" : "react";
	if (root === "@infinite-snowball/input") return "normalized-input";
	if (
		root === "@infinite-snowball/engine" ||
		root === "@infinite-snowball/gameplay"
	)
		return "workspace-runtime";
	if (root === "@react-three/rapier") return "physics";
	if (
		root.startsWith("@react-three/") ||
		root === "react" ||
		root === "react-dom"
	)
		return "react";
	if (root === "three") return "render";
	if (root === "ecctrl") return "device-adapter";
	return null;
}

function auditStaticModuleSpecifier(
	packageName: RuntimePackageName,
	fileName: string,
	kind: "import" | "export",
	specifier: string,
): readonly string[] {
	const boundary = PACKAGE_BOUNDARIES[packageName];
	const prefix = `${fileName}: static ${kind} "${specifier}"`;
	if (specifier.startsWith(".")) {
		const pathSegments = specifier.split("/").slice(1);
		if (
			!specifier.startsWith("./") ||
			!specifier.endsWith(".js") ||
			pathSegments.some((segment) => segment === "" || segment === "..")
		) {
			return [
				`${prefix} must be a package-local ./ path ending in .js without traversal`,
			];
		}
		return [];
	}

	const diagnostics: string[] = [];
	const capability = moduleCapability(specifier);
	if (
		capability !== null &&
		!boundary.allowedCapabilities.includes(capability)
	) {
		diagnostics.push(
			`${prefix} requires forbidden ${capability === "node" ? "Node" : capability} capability`,
		);
	}

	const allowlist =
		kind === "import"
			? boundary.allowedStaticImports
			: boundary.allowedStaticExports;
	if (!allowlist.includes(specifier)) {
		const packageRoot = externalPackageRoot(specifier);
		const reason = allowlist.includes(packageRoot)
			? `deep package path is forbidden; use "${packageRoot}"`
			: `not in ${packageName}'s static ${kind} allowlist (${allowlist.join(", ") || "none"})`;
		diagnostics.push(`${prefix} is ${reason}`);
	}
	return diagnostics;
}

function unwrapExpression(expression: Expression): Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertion(current) ||
		ts.isNonNullExpression(current) ||
		ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function constantString(expression: Expression): string | null {
	const unwrapped = unwrapExpression(expression);
	if (ts.isStringLiteralLikeNode(unwrapped)) return unwrapped.text;
	if (
		ts.isBinaryExpression(unwrapped) &&
		unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken
	) {
		const left = constantString(unwrapped.left);
		if (left === null) return null;
		const right = constantString(unwrapped.right);
		return right === null ? null : left + right;
	}
	return null;
}

function accessedMemberName(expression: Expression): string | null {
	const unwrapped = unwrapExpression(expression);
	if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
	if (
		ts.isElementAccessExpression(unwrapped) &&
		unwrapped.argumentExpression !== undefined
	) {
		return constantString(unwrapped.argumentExpression);
	}
	return null;
}

function isConstructorChainInvocation(expression: Expression): boolean {
	const unwrapped = unwrapExpression(expression);
	if (
		(!ts.isPropertyAccessExpression(unwrapped) &&
			!ts.isElementAccessExpression(unwrapped)) ||
		accessedMemberName(unwrapped) !== "constructor"
	) {
		return false;
	}
	return accessedMemberName(unwrapped.expression) === "constructor";
}

function invokedName(expression: Expression): string | null {
	const unwrapped = unwrapExpression(expression);
	if (ts.isIdentifier(unwrapped)) return unwrapped.text;
	if (
		ts.isPropertyAccessExpression(unwrapped) ||
		ts.isElementAccessExpression(unwrapped)
	) {
		return accessedMemberName(unwrapped);
	}
	return null;
}

function sourceLocation(sourceFile: SourceFile, node: Node): string {
	const location = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile),
	);
	return `${sourceFile.fileName}:${location.line + 1}:${location.character + 1}`;
}

function auditSourceFile(
	packageName: RuntimePackageName,
	sourceFile: SourceFile,
	parseDiagnostics: readonly Diagnostic[],
	project: Project,
): readonly string[] {
	const diagnostics: string[] = [];
	const positiveAmbientCandidates: Node[] = [];
	const ambientCapabilityCandidates: Node[] = [];
	const addDiagnostic = (node: Node, message: string) => {
		diagnostics.push(`${sourceLocation(sourceFile, node)} ${message}`);
	};

	for (const diagnostic of parseDiagnostics) {
		const location = sourceFile.getLineAndCharacterOfPosition(
			Math.max(0, diagnostic.pos),
		);
		diagnostics.push(
			`${sourceFile.fileName}:${location.line + 1}:${location.character + 1} TypeScript parse error TS${diagnostic.code}: ${diagnostic.text}`,
		);
	}

	const visit = (node: Node): void => {
		if (ts.isImportDeclaration(node)) {
			if (ts.isStringLiteral(node.moduleSpecifier)) {
				for (const diagnostic of auditStaticModuleSpecifier(
					packageName,
					sourceLocation(sourceFile, node),
					"import",
					node.moduleSpecifier.text,
				)) {
					diagnostics.push(diagnostic);
				}
			} else {
				addDiagnostic(node, "static import specifier must be a string literal");
			}
		}

		if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
			if (ts.isStringLiteral(node.moduleSpecifier)) {
				for (const diagnostic of auditStaticModuleSpecifier(
					packageName,
					sourceLocation(sourceFile, node),
					"export",
					node.moduleSpecifier.text,
				)) {
					diagnostics.push(diagnostic);
				}
			} else {
				addDiagnostic(node, "static export specifier must be a string literal");
			}
		}

		if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		) {
			addDiagnostic(node, "CommonJS require import is forbidden");
		}
		if (ts.isExportAssignment(node) && node.isExportEquals) {
			addDiagnostic(node, "CommonJS export assignment is forbidden");
		}

		if (ts.isCallExpression(node)) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				addDiagnostic(node, "dynamic import is forbidden");
			} else {
				const name = invokedName(node.expression);
				if (name === "require")
					addDiagnostic(node, "CommonJS require call is forbidden");
				if (name === "eval") addDiagnostic(node, "eval call is forbidden");
				if (name === "Function")
					addDiagnostic(node, "dynamic Function call is forbidden");
			}
			if (isConstructorChainInvocation(node.expression)) {
				addDiagnostic(
					node,
					"dynamic constructor chain invocation is forbidden",
				);
			}
		}
		if (
			ts.isNewExpression(node) &&
			invokedName(node.expression) === "Function"
		) {
			addDiagnostic(node, "dynamic Function constructor is forbidden");
		}
		if (
			ts.isNewExpression(node) &&
			isConstructorChainInvocation(node.expression)
		) {
			addDiagnostic(node, "dynamic constructor chain invocation is forbidden");
		}
		if (ts.isTaggedTemplateExpression(node)) {
			const name = invokedName(node.tag);
			if (name === "eval" || name === "Function") {
				addDiagnostic(node, `${name} tagged-template invocation is forbidden`);
			}
			if (isConstructorChainInvocation(node.tag)) {
				addDiagnostic(
					node,
					"dynamic constructor chain invocation is forbidden",
				);
			}
		}

		if (ts.isIdentifier(node)) {
			const ambientCapability =
				FORBIDDEN_AMBIENT_CAPABILITY_BY_IDENTIFIER[node.text];
			if (ambientCapability === "ambient-global") {
				addDiagnostic(
					node,
					`ambient-global ambient capability "${node.text}" is forbidden`,
				);
			} else if (ambientCapability !== undefined) {
				ambientCapabilityCandidates.push(node);
			}
			if (
				PURE_RUNTIME_PACKAGES[packageName] === true &&
				!Object.hasOwn(ALLOWED_PURE_AMBIENT_GLOBALS, node.text) &&
				!PACKAGE_BOUNDARIES[packageName].allowedAmbientGlobals.includes(
					node.text,
				) &&
				ambientCapability === undefined &&
				!Object.hasOwn(DANGEROUS_REFERENCE_IDENTIFIERS, node.text) &&
				!Object.hasOwn(RAW_DEVICE_IDENTIFIERS, node.text) &&
				!Object.hasOwn(NODE_GLOBAL_IDENTIFIERS, node.text)
			) {
				positiveAmbientCandidates.push(node);
			}
		}
		if (
			ts.isIdentifier(node) &&
			Object.hasOwn(DANGEROUS_REFERENCE_IDENTIFIERS, node.text)
		) {
			addDiagnostic(node, `${node.text} reference is forbidden`);
		}
		if (
			ts.isIdentifier(node) &&
			Object.hasOwn(RAW_DEVICE_IDENTIFIERS, node.text) &&
			!PACKAGE_BOUNDARIES[packageName].allowedCapabilities.includes(
				"raw-device",
			)
		) {
			addDiagnostic(node, `raw-device capability "${node.text}" is forbidden`);
		}
		if (
			ts.isIdentifier(node) &&
			Object.hasOwn(NODE_GLOBAL_IDENTIFIERS, node.text) &&
			!PACKAGE_BOUNDARIES[packageName].allowedCapabilities.includes("node")
		) {
			addDiagnostic(node, `Node global capability "${node.text}" is forbidden`);
		}
		if (
			(ts.isJsxElement(node) ||
				ts.isJsxSelfClosingElement(node) ||
				ts.isJsxFragment(node)) &&
			!PACKAGE_BOUNDARIES[packageName].allowedCapabilities.includes("react")
		) {
			addDiagnostic(node, "React JSX capability is forbidden");
		}

		node.forEachChild(visit);
	};
	visit(sourceFile);
	const candidates = [
		...ambientCapabilityCandidates,
		...(PURE_RUNTIME_PACKAGES[packageName] === true
			? positiveAmbientCandidates
			: []),
	];
	const symbols = project.checker.getSymbolAtLocation(candidates);
	const defaultLibraryByPath = new Map<string, boolean>();
	for (const [index, symbol] of symbols.entries()) {
		const identifier = candidates[index];
		if (
			identifier === undefined ||
			!ts.isIdentifier(identifier) ||
			symbol === undefined ||
			symbol.declarations.length === 0
		) {
			continue;
		}
		const declaredOnlyByDefaultLibraries = symbol.declarations.every(
			(declaration) => {
				const cached = defaultLibraryByPath.get(declaration.path);
				if (cached !== undefined) return cached;
				const declarationSource = project.program.getSourceFile(
					declaration.path,
				);
				const isDefaultLibrary =
					declarationSource !== undefined &&
					project.program.isSourceFileDefaultLibrary(declarationSource);
				defaultLibraryByPath.set(declaration.path, isDefaultLibrary);
				return isDefaultLibrary;
			},
		);
		if (!declaredOnlyByDefaultLibraries || symbol.getParent() !== undefined) {
			continue;
		}
		const ambientCapability =
			FORBIDDEN_AMBIENT_CAPABILITY_BY_IDENTIFIER[identifier.text];
		if (ambientCapability !== undefined) {
			addDiagnostic(
				identifier,
				`${ambientCapability} ambient capability "${identifier.text}" is forbidden`,
			);
		} else {
			addDiagnostic(
				identifier,
				`ambient-global "${symbol.name}" is not in ${packageName}'s positive pure-JS allowlist`,
			);
		}
	}
	return diagnostics;
}

function withCompilerProjects<T>(
	configPaths: readonly string[],
	callback: (projects: ReadonlyMap<string, Project>) => T,
): T {
	const api = new API({ cwd: ROOT });
	try {
		const snapshot = api.updateSnapshot({ openProjects: [...configPaths] });
		try {
			const projects = new Map<string, Project>();
			for (const configPath of configPaths) {
				const project = snapshot.getProject(configPath);
				if (project === undefined) {
					throw new Error(
						`TypeScript compiler API did not open project ${configPath}`,
					);
				}
				projects.set(configPath, project);
			}
			return callback(projects);
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
}

function auditProjectSource(
	packageName: RuntimePackageName,
	project: Project,
	file: string,
): readonly string[] {
	const sourceFile = project.program.getSourceFile(file);
	if (sourceFile === undefined) {
		return [
			`${file}: TypeScript compiler API project omitted a production source file`,
		];
	}
	return auditSourceFile(
		packageName,
		sourceFile,
		project.program.getSyntacticDiagnostics(file),
		project,
	);
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return input !== null && typeof input === "object" && !Array.isArray(input);
}

function expectedRuntimeManifest(packageName: RuntimePackageName) {
	return {
		name: `@infinite-snowball/${packageName}`,
		private: true,
		main: "./dist/index.js",
		types: "./dist/index.d.ts",
		files: ["dist"],
		exports: {
			".": {
				types: "./dist/index.d.ts",
				import: "./dist/index.js",
			},
		},
	} as const;
}

function auditRuntimePackageManifest(
	packageName: RuntimePackageName,
	input: unknown,
): readonly string[] {
	if (!isRecord(input))
		return [`${packageName}/package.json must be an object`];
	const expected = expectedRuntimeManifest(packageName);
	const diagnostics: string[] = [];
	for (const field of ["name", "private", "main", "types"] as const) {
		if (input[field] !== expected[field]) {
			diagnostics.push(
				`${packageName}/package.json#${field} must equal ${JSON.stringify(expected[field])}`,
			);
		}
	}
	if (
		!Array.isArray(input.files) ||
		input.files.length !== 1 ||
		input.files[0] !== "dist"
	) {
		diagnostics.push(
			`${packageName}/package.json#files must equal ["dist"] exactly`,
		);
	}
	if (!isRecord(input.exports)) {
		diagnostics.push(`${packageName}/package.json#exports must be an object`);
		return diagnostics;
	}
	if (Object.keys(input.exports).length !== 1 || !("." in input.exports)) {
		diagnostics.push(
			`${packageName}/package.json#exports must contain only the "." package root`,
		);
	}
	const rootExport = input.exports["."];
	if (!isRecord(rootExport)) {
		diagnostics.push(
			`${packageName}/package.json#exports["."] must be a condition map`,
		);
		return diagnostics;
	}
	if (
		Object.keys(rootExport).length !== 2 ||
		!("types" in rootExport) ||
		!("import" in rootExport)
	) {
		diagnostics.push(
			`${packageName}/package.json#exports["."] must contain only types and import`,
		);
	}
	if (rootExport.types !== "./dist/index.d.ts") {
		diagnostics.push(
			`${packageName}/package.json#exports["."].types must equal "./dist/index.d.ts"`,
		);
	}
	if (rootExport.import !== "./dist/index.js") {
		diagnostics.push(
			`${packageName}/package.json#exports["."].import must equal "./dist/index.js"`,
		);
	}
	return diagnostics;
}

function publicRuntimeManifestShape(input: unknown): unknown {
	if (!isRecord(input)) return input;
	return {
		name: input.name,
		private: input.private,
		main: input.main,
		types: input.types,
		files: input.files,
		exports: input.exports,
	};
}

async function runAuditedRuntimeBuild() {
	const rootManifest = JSON.parse(
		await readFile(join(ROOT, "package.json"), "utf8"),
	) as {
		packageManager?: unknown;
	};
	if (
		typeof rootManifest.packageManager !== "string" ||
		!rootManifest.packageManager.startsWith("pnpm@")
	) {
		throw new Error(
			"root packageManager must identify the audited pnpm version",
		);
	}
	const pnpmVersion = rootManifest.packageManager.slice("pnpm@".length);
	const corepackHome =
		process.env.COREPACK_HOME ?? join(homedir(), ".cache", "node", "corepack");
	const cachedPnpmEntry = join(
		corepackHome,
		"v1",
		"pnpm",
		pnpmVersion,
		"bin",
		"pnpm.cjs",
	);
	const npmExecPath = existsSync(cachedPnpmEntry)
		? cachedPnpmEntry
		: (process.env.npm_execpath ??
			(process.env.PNPM_HOME === undefined
				? undefined
				: join(process.env.PNPM_HOME, "pnpm")));
	if (npmExecPath === undefined) {
		throw new Error(
			`runtime package-root smoke cannot locate audited pnpm ${pnpmVersion}`,
		);
	}
	try {
		return await execFileAsync(
			process.execPath,
			[AUDITED_PNPM_RUNNER, "run", "runtime:build"],
			{
				cwd: ROOT,
				env: { ...process.env, CI: "1", npm_execpath: npmExecPath },
				maxBuffer: 4 * 1024 * 1024,
			},
		);
	} catch (error) {
		const failure = error as {
			message?: string;
			stderr?: string;
			stdout?: string;
		};
		throw new Error(
			[
				"audited runtime build failed before package-root import smoke",
				failure.stdout?.trim(),
				failure.stderr?.trim(),
				failure.message,
			]
				.filter(Boolean)
				.join("\n"),
			{ cause: error },
		);
	}
}

describe("Phase 04 AST boundary adversarial regressions", () => {
	it("rejects forbidden syntax and ambient capabilities without blocking pure JS", async () => {
		// These snippets are parsed and audited only; none are executed. They
		// exercise dynamic-import/code-generation syntax and spacing bypasses.
		const cases = [
			{
				name: "comment-separated deep Koota import",
				source: 'import { trait } from /* boundary bypass */ "koota/react";',
				expectedDiagnostic: "static import",
			},
			{
				name: "comment-separated React re-export",
				source: 'export * from /* boundary bypass */ "react/jsx-runtime";',
				expectedDiagnostic: "static export",
			},
			{
				name: "comment-separated Node import",
				source: 'import { readFile } from /* boundary bypass */ "node:fs";',
				expectedDiagnostic: "Node",
			},
			{
				name: "comment-separated dynamic import",
				source: 'void import /* boundary bypass */ ("react");',
				expectedDiagnostic: "dynamic import",
			},
			{
				name: "comment-separated CommonJS require",
				source: 'void require /* boundary bypass */ ("node:fs");',
				expectedDiagnostic: "CommonJS require",
			},
			{
				name: "comment-separated eval",
				source: 'void eval /* boundary bypass */ ("1 + 1");',
				expectedDiagnostic: "eval",
			},
			{
				name: "comment-separated Function call",
				source: 'void Function /* boundary bypass */ ("return 1");',
				expectedDiagnostic: "Function",
			},
			{
				name: "comment-separated Function constructor",
				source: 'void new Function /* boundary bypass */ ("return 1");',
				expectedDiagnostic: "Function",
			},
			{
				name: "constant-folded constructor constructor call chain",
				source: `({} as ${["a", "ny"].join("")})["con" + "structor"]["con" + "structor"]("return 1")()`,
				expectedDiagnostic: "constructor chain",
			},
			{
				name: "direct WebAssembly instantiation",
				source: "void WebAssembly.instantiate(new Uint8Array());",
				expectedDiagnostic: "wasm",
			},
			{
				name: "dedicated worker construction",
				source: 'void new Worker("worker.js");',
				expectedDiagnostic: "worker",
			},
			{
				name: "network fetch",
				source: 'void fetch("https://example.invalid");',
				expectedDiagnostic: "network",
			},
			{
				name: "XMLHttpRequest construction",
				source: "void new XMLHttpRequest();",
				expectedDiagnostic: "network",
			},
			{
				name: "WebSocket construction",
				source: 'void new WebSocket("wss://example.invalid");',
				expectedDiagnostic: "network",
			},
			{
				name: "shared worker construction",
				source: 'void new SharedWorker("worker.js");',
				expectedDiagnostic: "worker",
			},
			{
				name: "string timer code generation",
				source: 'void setTimeout("postMessage(1)", 0);',
				expectedDiagnostic: "dynamic-code",
			},
			{
				name: "computed global eval alias",
				source: 'const execute = globalThis["ev" + "al"]; void execute("1");',
				expectedDiagnostic: "ambient-global",
			},
			{
				name: "computed global Function alias",
				source:
					'const compile = globalThis["Fun" + "ction"]; void compile("return 1");',
				expectedDiagnostic: "ambient-global",
			},
			{
				name: "unspecified ambient cryptography",
				source: "void crypto.getRandomValues(new Uint8Array(4));",
				expectedDiagnostic: "ambient-global",
			},
			{
				name: "comment-separated raw device access",
				source: "void navigator /* boundary bypass */ .getGamepads();",
				expectedDiagnostic: "raw-device",
			},
		] as const;
		const tempRoot = await mkdtemp(
			join(tmpdir(), "infinite-snowball-boundary-"),
		);
		const allowedFile = join(tempRoot, "allowed-pure.ts");
		const configPath = join(tempRoot, "tsconfig.json");
		try {
			await writeFile(
				configPath,
				JSON.stringify({
					compilerOptions: {
						module: "ESNext",
						noEmit: true,
						lib: ["ES2022", "DOM"],
						target: "ES2022",
						types: [],
					},
					include: ["*.ts"],
				}),
			);
			await Promise.all([
				...cases.map((testCase, index) =>
					writeFile(join(tempRoot, `adversarial-${index}.ts`), testCase.source),
				),
				writeFile(
					allowedFile,
					[
						"export {};",
						"type Scores = Readonly<Record<string, number>>;",
						"const values: ReadonlyArray<number> = [1, 2, 3];",
						"const total = values.reduce((sum, value) => sum + value, 0);",
						"const scores: Scores = Object.freeze({ total: Math.sqrt(Number(total)) });",
						"void Promise.resolve(JSON.stringify(scores));",
						"const fetch = (value: number): number => value;",
						"class Worker { readonly value = 1; }",
						"void fetch(new Worker().value);",
						'const localData = { constructor: { constructor: "metadata" } };',
						'void localData["con" + "structor"]["con" + "structor"];',
						"const localFactory = { constructor: (): number => 1 };",
						'void localFactory["con" + "structor"]();',
					].join("\n"),
				),
			]);
			withCompilerProjects([configPath], (projects) => {
				const project = projects.get(configPath);
				if (project === undefined)
					throw new Error(`missing adversarial compiler project ${configPath}`);
				for (const [index, testCase] of cases.entries()) {
					const diagnostics = auditProjectSource(
						"engine",
						project,
						join(tempRoot, `adversarial-${index}.ts`),
					);
					expect(
						diagnostics.join("\n"),
						`${testCase.name} must be rejected by AST traversal`,
					).toContain(testCase.expectedDiagnostic);
				}
				expect(
					auditProjectSource("engine", project, allowedFile),
					"pure JavaScript, math, and standard utility types must remain usable",
				).toEqual([]);
			});
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});

describe("Phase 04 package boundaries", () => {
	it("parses every production TS/TSX source and enforces exact package allowlists", async () => {
		const packageSources = await Promise.all(
			RUNTIME_PACKAGE_NAMES.map(async (packageName) => ({
				packageName,
				files: await sourceFiles(packageName),
				configPath: join(ROOT, "packages", packageName, "tsconfig.json"),
			})),
		);
		withCompilerProjects(
			packageSources.map(({ configPath }) => configPath),
			(projects) => {
				for (const { packageName, files, configPath } of packageSources) {
					expect(
						files.length,
						`${packageName} must contain at least one production TS/TSX source`,
					).toBeGreaterThan(0);
					const project = projects.get(configPath);
					if (project === undefined)
						throw new Error(`missing compiler project ${configPath}`);
					const diagnostics = files.flatMap((file) =>
						auditProjectSource(packageName, project, file),
					);
					expect(
						diagnostics,
						`${packageName} production boundary violations:\n${diagnostics.join("\n")}`,
					).toEqual([]);
				}
			},
		);
	});

	it("deep-asserts private dist-root-only manifests for every runtime package", async () => {
		for (const packageName of RUNTIME_PACKAGE_NAMES) {
			const manifest: unknown = JSON.parse(
				await readFile(
					join(ROOT, "packages", packageName, "package.json"),
					"utf8",
				),
			);
			const diagnostics = auditRuntimePackageManifest(packageName, manifest);
			expect(
				diagnostics,
				`${packageName} manifest contract violations:\n${diagnostics.join("\n")}`,
			).toEqual([]);
			expect(publicRuntimeManifestShape(manifest)).toEqual(
				expectedRuntimeManifest(packageName),
			);
		}
	});

	it.each([
		[
			"private false",
			{ ...expectedRuntimeManifest("engine"), private: false },
			"#private",
		],
		[
			"source export targets",
			{
				...expectedRuntimeManifest("engine"),
				exports: {
					".": {
						types: "./src/index.ts",
						import: "./src/index.ts",
					},
				},
			},
			'exports["."].types',
		],
		[
			"an extra package subpath",
			{
				...expectedRuntimeManifest("engine"),
				exports: {
					...expectedRuntimeManifest("engine").exports,
					"./internal": "./dist/internal.js",
				},
			},
			'only the "." package root',
		],
		[
			"an extra root export condition",
			{
				...expectedRuntimeManifest("engine"),
				exports: {
					".": {
						...expectedRuntimeManifest("engine").exports["."],
						default: "./dist/index.js",
					},
				},
			},
			"only types and import",
		],
	])("rejects runtime manifest fixture with %s", (_name, manifest, reason) => {
		expect(
			auditRuntimePackageManifest("engine", manifest).join("\n"),
		).toContain(reason);
	});

	it("builds clean runtime dist and imports all four package roots through exports", async () => {
		await runAuditedRuntimeBuild();
		const packageRoots = RUNTIME_PACKAGE_NAMES.map(
			(packageName) => `@infinite-snowball/${packageName}`,
		);
		// Dynamic import is intentional: one subprocess must exercise each bare
		// package root through Node's runtime export-map resolution.
		const smokeSource = `
const packageRoots = ${JSON.stringify(packageRoots)};
const imported = await Promise.all(packageRoots.map(async (packageRoot) => {
	const exportedNames = Object.keys(await import(packageRoot));
	if (exportedNames.length === 0) {
		throw new Error(packageRoot + " resolved through exports but exposed no bindings");
	}
	return packageRoot;
}));
process.stdout.write(JSON.stringify(imported));
`;
		let stdout: string;
		try {
			({ stdout } = await execFileAsync(
				process.execPath,
				["--input-type=module", "--eval", smokeSource],
				{
					cwd: join(ROOT, "packages", "runtime-r3f"),
					maxBuffer: 4 * 1024 * 1024,
				},
			));
		} catch (error) {
			const failure = error as {
				message?: string;
				stderr?: string;
				stdout?: string;
			};
			throw new Error(
				[
					"Node package-root import smoke failed after audited runtime build",
					`attempted roots: ${packageRoots.join(", ")}`,
					failure.stdout?.trim(),
					failure.stderr?.trim(),
					failure.message,
				]
					.filter(Boolean)
					.join("\n"),
				{ cause: error },
			);
		}
		expect(
			JSON.parse(stdout) as unknown,
			"Node subprocess must import every public package root",
		).toEqual(packageRoots);
	}, 60_000);

	it("records exact installed APIs, ownership, lifecycle, unsupported paths, and CSP/MIME handoffs", async () => {
		const handoff = await readFile(
			join(ROOT, "docs", "architecture", "runtime-api-handoff.md"),
			"utf8",
		);
		for (const installedPackage of [
			"koota@0.6.6",
			"@react-three/fiber@9.6.1",
			"@react-three/rapier@2.2.0",
			"three@0.185.1",
			"ecctrl@2.0.0",
			"react@19.2.7",
		]) {
			expect(handoff).toContain(installedPackage);
		}
		for (const contract of [
			"Public imports",
			"Ownership",
			"Lifecycle",
			"Unsupported paths",
			"is the sole owner of `@react-three/rapier`",
			"No supported consumer may deep-link",
			"script-src 'self' 'wasm-unsafe-eval'",
			"@dimforge/rapier3d-compat@0.19.2",
			"base64-inlined WASM bytes",
			"no Rapier WASM response or `application/wasm` MIME assertion",
			"zero emitted `.wasm` files",
			"zero runtime `.wasm` requests",
			"model/gltf-binary",
			"community WASM remains forbidden",
			"P05",
			"P08",
		]) {
			expect(handoff).toContain(contract);
		}
		expect(handoff).not.toContain("must be served as `application/wasm`");
	});
});
