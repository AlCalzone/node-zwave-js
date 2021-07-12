// organize-imports-ignore

// This module is the main entry point. Requiring reflect-metadata here avoids forgetting it
import "reflect-metadata";

// By installing source map support, we get the original source
// locations in error messages
import { install as installSourceMapSupport } from "source-map-support";
installSourceMapSupport();

import * as path from "path";
import { initSentry } from "./lib/telemetry/sentry.js";

/** The version of zwave-js, exported for your convenience */
const packageJsonPath = require.resolve("zwave-js/package.json");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require(packageJsonPath);
const libraryRootDir = path.dirname(packageJsonPath);
const libName: string = packageJson.name;
const libVersion: string = packageJson.version;

// Init sentry, unless we're running a a test or some custom-built userland or PR test versions
if (
	process.env.NODE_ENV !== "test" &&
	!/\-[a-f0-9]{7,}$/.test(libVersion) &&
	!/\-pr\-\d+\-$/.test(libVersion)
) {
	void initSentry(libraryRootDir, libName, libVersion).catch(() => {
		/* ignore */
	});
}

// Export some frequently-used things and types - this also loads all CC files including metadata
export * from "./CommandClass";
export * from "./Controller";
export * from "./Driver";
export * from "./Error";
export * from "./Node";
export * from "./Utils";
export * from "./Values";
export { libVersion };
