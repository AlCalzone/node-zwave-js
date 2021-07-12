import * as path from "path";
import * as prettier from "prettier";

// Make the linter happy
export function formatWithPrettier(
	filename: string,
	sourceText: string,
): string {
	let rootPath = __dirname.replace(/\\/g, "/");
	rootPath = rootPath.substr(0, rootPath.lastIndexOf("/packages/"));

	const prettierOptions = {
		...require(path.join(rootPath, ".prettierrc")),
		// To infer the correct parser
		filepath: filename,
	};
	return prettier.format(sourceText, prettierOptions);
}
