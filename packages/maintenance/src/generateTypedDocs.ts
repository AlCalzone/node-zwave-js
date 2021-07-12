/*!
 * This method returns the original source code for an interface or type so it can be put into documentation
 */

// wotan-disable no-useless-assertion
// until fimbullinter/wotan#719 is fixed

import { CommandClasses, getCCName } from "@zwave-js/core";
import { enumFilesRecursive, num2hex } from "@zwave-js/shared";
import { red } from "ansi-colors";
import * as fs from "fs-extra";
import * as path from "path";
import Piscina from "piscina";
import {
	CommentRange,
	ExportedDeclarations,
	InterfaceDeclaration,
	InterfaceDeclarationStructure,
	JSDocTagStructure,
	MethodDeclaration,
	Node,
	OptionalKind,
	Project,
	PropertySignatureStructure,
	SourceFile,
	SyntaxKind,
	TypeLiteralNode,
} from "ts-morph";
import { isMainThread } from "worker_threads";
import { formatWithPrettier } from "./prettier";
import {
	getCommandClassFromClassDeclaration,
	projectRoot,
	tsConfigFilePath,
} from "./tsAPITools";

export function findSourceNode(
	program: Project,
	exportingFile: string,
	identifier: string,
): ExportedDeclarations | undefined {
	// Scan all source files
	const file = program.getSourceFile(exportingFile);
	return file?.getExportedDeclarations().get(identifier)?.[0];
}

export function stripComments(
	node: ExportedDeclarations,
	options: ImportRange["options"],
): ExportedDeclarations {
	if (Node.isTextInsertableNode(node)) {
		// Remove some comments if desired
		const ranges: { pos: number; end: number }[] = [];
		const removePredicate = (c: CommentRange) =>
			(!options.comments &&
				c.getKind() === SyntaxKind.SingleLineCommentTrivia) ||
			(!options.jsdoc &&
				c.getKind() === SyntaxKind.MultiLineCommentTrivia);

		const getCommentRangesForNode = (
			node: Node,
		): { pos: number; end: number }[] => {
			const comments = node.getLeadingCommentRanges();
			const ret = comments.map((c, i) => ({
				pos: c.getPos(),
				end:
					i < comments.length - 1
						? comments[i + 1].getPos()
						: Math.max(node.getStart(), c.getEnd()),
				remove: removePredicate(c),
			}));
			// Only use comment ranges that should be removed
			return ret.filter((r) => r.remove);
		};

		if (Node.isEnumDeclaration(node)) {
			for (const member of node.getMembers()) {
				ranges.push(...getCommentRangesForNode(member));
			}
		} else if (Node.isInterfaceDeclaration(node)) {
			const walkInterfaceDeclaration = (node: InterfaceDeclaration) => {
				for (const member of node.getMembers()) {
					ranges.push(...getCommentRangesForNode(member));
					if (Node.isInterfaceDeclaration(member)) {
						walkInterfaceDeclaration(member);
					}
				}
			};
			walkInterfaceDeclaration(node);
		}

		// Sort in reverse order, so the removals don't influence each other
		ranges.sort((a, b) => b.pos - a.pos);
		for (const { pos, end } of ranges) {
			node.removeText(pos, end);
		}
	}
	return node;
}

function shouldStripPropertySignature(
	p: OptionalKind<PropertySignatureStructure>,
): boolean {
	return !!p.docs?.some(
		(d) =>
			typeof d !== "string" &&
			d.tags?.some((t) => /(deprecated|internal)/.test(t.tagName)),
	);
}

// As long as ts-morph has no means to print a structure, we'll have to use this
// to print the declarations of a class
function printInterfaceDeclarationStructure(
	struct: InterfaceDeclarationStructure,
): string {
	return `
interface ${struct.name}${
		struct.typeParameters?.length
			? `<${struct.typeParameters.map((t) => t.toString()).join(", ")}>`
			: ""
	} {
	${struct.properties
		?.filter((p) => !shouldStripPropertySignature(p))
		.map((p) => {
			return `${p.isReadonly ? "readonly " : ""}${p.name}${
				p.hasQuestionToken ? "?:" : ":"
			} ${p.type as string};`;
		})
		.join("\n")}
}`;
}

export function getTransformedSource(
	node: ExportedDeclarations,
	options: ImportRange["options"],
): string {
	// Remove @internal and @deprecated members
	if (Node.isInterfaceDeclaration(node)) {
		const commentsToRemove: { remove(): void }[] = [];
		const walkDeclaration = (
			node: InterfaceDeclaration | TypeLiteralNode,
		) => {
			for (const member of node.getMembers()) {
				if (
					member
						.getJsDocs()
						.some((doc) =>
							/@(deprecated|internal)/.test(doc.getInnerText()),
						)
				) {
					commentsToRemove.push(member);
				}
				if (Node.isInterfaceDeclaration(member)) {
					walkDeclaration(member);
				} else if (Node.isPropertySignature(member)) {
					const typeNode = member.getTypeNode();
					if (Node.isTypeLiteralNode(typeNode)) {
						walkDeclaration(typeNode);
					}
				}
			}
		};
		walkDeclaration(node);
		for (let i = commentsToRemove.length - 1; i >= 0; i--) {
			commentsToRemove[i].remove();
		}
	}

	// Remove exports keyword
	if (Node.isModifierableNode(node)) {
		node = node.toggleModifier("export", false);
	}

	let ret: string;
	if (Node.isClassDeclaration(node)) {
		// Class declarations contain the entire source, we are only interested in the properties
		ret = printInterfaceDeclarationStructure(node.extractInterface());
	} else {
		// Comments must be removed last (if that is desired)
		node = stripComments(node, options);
		// Using getText instead of print avoids reformatting the node
		ret = node.getText();
	}

	// Format with Prettier so we get the original formatting back
	ret = formatWithPrettier("index.ts", ret).trim();
	return ret;
}

interface ImportRange {
	index: number;
	end: number;
	module: string;
	symbol: string;
	import: string;
	options: {
		comments?: boolean;
		jsdoc?: boolean;
	};
}

const importRegex =
	/(?<import><!-- #import (?<symbol>.*?) from "(?<module>.*?)"(?: with (?<options>[\w\-, ]*?))? -->)(?:[\s\r\n]*(^`{3,4})ts[\r\n]*(?<source>(.|\n)*?)\5)?/gm;

export function findImportRanges(docFile: string): ImportRange[] {
	const matches = [...docFile.matchAll(importRegex)];
	return matches.map((match) => ({
		index: match.index!,
		end: match.index! + match[0].length,
		module: match.groups!.module,
		symbol: match.groups!.symbol,
		import: match.groups!.import,
		options: {
			comments: !!match.groups!.options?.includes("comments"),
			jsdoc: !match.groups!.options?.includes("no-jsdoc"),
		},
	}));
}

const docsDir = path.join(projectRoot, "docs");
const ccDocsDir = path.join(docsDir, "api/CCs");

export async function processDocFile(
	program: Project,
	docFile: string,
): Promise<boolean> {
	console.log(`processing ${docFile}...`);
	let fileContent = await fs.readFile(docFile, "utf8");
	const ranges = findImportRanges(fileContent);
	let hasErrors = false;
	// Replace from back to start so we can reuse the indizes
	for (let i = ranges.length - 1; i >= 0; i--) {
		const range = ranges[i];
		console.log(`  processing import ${range.symbol} from ${range.module}`);
		const sourceNode = findSourceNode(
			program,
			`packages/${range.module.replace(/^@zwave-js\//, "")}/src/index.ts`,
			range.symbol,
		);
		if (!sourceNode) {
			console.error(
				red(
					`Cannot find symbol ${range.symbol} in module ${range.module}!`,
				),
			);
			hasErrors = true;
		} else {
			const source = getTransformedSource(sourceNode, range.options);
			fileContent = `${fileContent.slice(0, range.index)}${range.import}

\`\`\`ts
${source}
\`\`\`${fileContent.slice(range.end)}`;
		}
	}
	console.log(`formatting ${docFile}...`);
	fileContent = fileContent.replace(/\r\n/g, "\n");
	fileContent = formatWithPrettier(docFile, fileContent);
	if (!hasErrors) {
		await fs.writeFile(docFile, fileContent, "utf8");
	}
	return hasErrors;
}

/** Processes all imports, returns true if there was an error */
async function processImports(piscina: Piscina): Promise<boolean> {
	const files = await enumFilesRecursive(
		path.join(projectRoot, "docs"),
		(f) =>
			!f.includes("/CCs/") && !f.includes("\\CCs\\") && f.endsWith(".md"),
	);

	const tasks = files.map((f) => piscina.run(f, { name: "processImport" }));

	const hasErrors = (await Promise.all(tasks)).some((result) => result);
	return hasErrors;
}

function fixPrinterErrors(text: string): string {
	return (
		text
			// The text includes one too many tabs at the start of each line
			.replace(/^\t(\t*)/gm, "$1")
			// TS 4.2+ has some weird printing bug for aliases: https://github.com/microsoft/TypeScript/issues/43031
			.replace(/(\w+) \| \("unknown" & { __brand: \1; }\)/g, "Maybe<$1>")
	);
}

function printMethodDeclaration(method: MethodDeclaration): string {
	method = method.toggleModifier("public", false);
	const start = method.getStart();
	const end = method.getBody()!.getStart();
	let ret = method
		.getText()
		.substr(0, end - start)
		.trim();
	if (!method.getReturnTypeNode()) {
		ret += ": " + method.getSignature().getReturnType().getText(method);
	}
	ret += ";";
	return fixPrinterErrors(ret);
}

function printOverload(method: MethodDeclaration): string {
	method = method.toggleModifier("public", false);
	return fixPrinterErrors(method.getText());
}

async function processCCDocFile(
	file: SourceFile,
): Promise<{ generatedIndex: string; generatedSidebar: any } | undefined> {
	const APIClass = file
		.getClasses()
		.find((c) => c.getName()?.endsWith("CCAPI"));
	if (!APIClass) return;

	const ccId = getCommandClassFromClassDeclaration(
		file.compilerNode,
		APIClass.compilerNode,
	);
	if (ccId == undefined) return;
	const ccName = getCCName(ccId);
	console.log(`generating documentation for ${ccName} CC...`);

	const filename = APIClass.getName()!.replace("CCAPI", "") + ".md";
	let text = `# ${ccName} CC

?> CommandClass ID: \`${num2hex((CommandClasses as any)[ccName])}\`
`;
	const generatedIndex = `\n- [${ccName} CC](api/CCs/${filename}) · \`${num2hex(
		(CommandClasses as any)[ccName],
	)}\``;
	const generatedSidebar = `\n\t\t- [${ccName} CC](api/CCs/${filename})`;

	// Enumerate all useful public methods
	const ignoredMethods: string[] = [
		"supportsCommand",
		"isSetValueOptimistic",
	];
	const methods = APIClass.getInstanceMethods()
		.filter((m) => m.hasModifier(SyntaxKind.PublicKeyword))
		.filter((m) => !ignoredMethods.includes(m.getName()));

	if (methods.length) {
		text += `## ${ccName} CC methods\n\n`;
	}

	for (const method of methods) {
		const signatures = method.getOverloads();

		text += `### \`${method.getName()}\`
\`\`\`ts
${
	signatures.length > 0
		? signatures.map(printOverload).join("\n\n")
		: printMethodDeclaration(method)
}
\`\`\`

`;
		const doc = method.getStructure().docs?.[0];
		if (typeof doc === "string") {
			text += doc + "\n\n";
		} else if (doc != undefined) {
			if (typeof doc.description === "string") {
				let description = doc.description.trim();
				if (!description.endsWith(".")) {
					description += ".";
				}
				text += description + "\n\n";
			}
			if (doc.tags) {
				const paramTags = doc.tags
					.filter(
						(
							t,
						): t is OptionalKind<JSDocTagStructure> & {
							text: string;
						} =>
							t.tagName === "param" && typeof t.text === "string",
					)
					.map((t) => {
						const firstSpace = t.text.indexOf(" ");
						if (firstSpace === -1) return undefined;
						return [
							t.text.slice(0, firstSpace),
							t.text.slice(firstSpace + 1),
						] as const;
					})
					.filter((t): t is [string, string] => !!t);

				if (paramTags.length > 0) {
					text += "**Parameters:**  \n\n";
					text += paramTags
						.map(
							([param, description]) =>
								`* \`${param}\`: ${description.trim()}`,
						)
						.join("\n");
					text += "\n\n";
				}
			}
		}
	}

	text = text.replace(/\r\n/g, "\n");
	text = formatWithPrettier(filename, text);

	await fs.writeFile(path.join(ccDocsDir, filename), text, "utf8");

	return { generatedIndex, generatedSidebar };
}

/** Generates CC documentation, returns true if there was an error */
async function generateCCDocs(
	program: Project,
	piscina: Piscina,
): Promise<boolean> {
	// Delete old cruft

	// Load the index file before it gets deleted
	const indexFilename = path.join(ccDocsDir, "index.md");
	let indexFileContent = await fs.readFile(indexFilename, "utf8");
	const indexAutoGenToken = "<!-- AUTO-GENERATE: CC List -->";
	const indexAutoGenStart = indexFileContent.indexOf(indexAutoGenToken);
	if (indexAutoGenStart === -1) {
		console.error(
			red(`Marker for auto-generation in CCs/index.md missing!`),
		);
		return false;
	}

	await fs.remove(ccDocsDir);
	await fs.ensureDir(ccDocsDir);

	// Find CC APIs
	const ccFiles = program.getSourceFiles("packages/zwave-js/**/*CC.ts");
	let generatedIndex = "";
	let generatedSidebar = "";

	// Process them in parallel
	const tasks = ccFiles.map((f) =>
		piscina.run(f.getFilePath(), { name: "processCC" }),
	);
	const results = await Promise.all(tasks);
	for (const result of results) {
		if (result) {
			generatedIndex += result.generatedIndex;
			generatedSidebar += result.generatedSidebar;
		}
	}

	// Write the generated index file and sidebar
	indexFileContent =
		indexFileContent.slice(
			0,
			indexAutoGenStart + indexAutoGenToken.length,
		) + generatedIndex;
	indexFileContent = formatWithPrettier("index.md", indexFileContent);
	await fs.writeFile(indexFilename, indexFileContent, "utf8");

	const sidebarInputFilename = path.join(docsDir, "_sidebar.md");
	let sidebarFileContent = await fs.readFile(sidebarInputFilename, "utf8");
	const sidebarAutoGenToken = "<!-- AUTO-GENERATE: CC Links -->";
	const sidebarAutoGenStart = sidebarFileContent.indexOf(sidebarAutoGenToken);
	if (sidebarAutoGenStart === -1) {
		console.error(
			red(`Marker for CC auto-generation in _sidebar.md missing!`),
		);
		return false;
	}
	sidebarFileContent =
		sidebarFileContent.slice(0, sidebarAutoGenStart) +
		generatedSidebar +
		sidebarFileContent.slice(
			sidebarAutoGenStart + sidebarAutoGenToken.length,
		);
	sidebarFileContent = formatWithPrettier("_sidebar.md", sidebarFileContent);
	await fs.writeFile(
		path.join(ccDocsDir, "_sidebar.md"),
		sidebarFileContent,
		"utf8",
	);

	return false;
}

async function main(): Promise<void> {
	const program = new Project({ tsConfigFilePath });
	const piscina = new Piscina({
		filename: path.join(__dirname, "generateTypedDocsWorker.js"),
		maxThreads: 4,
	});

	let hasErrors = false;
	// Replace all imports
	hasErrors ||= await processImports(piscina);
	// Regenerate all CC documentation files
	if (!hasErrors) hasErrors ||= await generateCCDocs(program, piscina);

	if (hasErrors) {
		process.exit(1);
	}
}

if (isMainThread) {
	if (require.main === module) {
		void main();
	}
} else {
	// Worker thread, export the available methods
	let _program: Project | undefined;
	function getProgram(): Project {
		if (!_program) {
			_program = new Project({ tsConfigFilePath });
		}
		return _program;
	}

	function processImport(filename: string): Promise<boolean> {
		return processDocFile(getProgram(), filename);
	}

	function processCC(
		filename: string,
	): Promise<{ generatedIndex: string; generatedSidebar: any } | undefined> {
		const sourceFile = getProgram().getSourceFileOrThrow(filename);
		return processCCDocFile(sourceFile);
	}

	module.exports = {
		processImport,
		processCC,
	};
}
