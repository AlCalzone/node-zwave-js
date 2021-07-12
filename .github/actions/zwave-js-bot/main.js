// @ts-check

const exec = require("@actions/exec");
const github = require("@actions/github");
const core = require("@actions/core");

const githubToken = core.getInput("githubToken");
const npmToken = core.getInput("npmToken");
const task = core.getInput("task");
const octokit = github.getOctokit(githubToken).rest;
const semver = require("semver");

const options = {
	owner: "zwave-js",
	repo: "node-zwave-js",
};

if (task === "publish-pr") {
	publishPr().catch(() => process.exit(1));
}

async function publishPr() {
	const pr = parseInt(core.getInput("pr"));
	const { data: pull } = await octokit.pulls.get({
		...options,
		pull_number: pr,
	});

	let success = false;
	let newVersion;
	try {
		// Build it
		await exec.exec("yarn", ["run", "build"]);

		// Configure git
		await exec.exec("git", ["config", "user.email", "bot@zwave-js.io"]);
		await exec.exec("git", ["config", "user.name", "Z-Wave JS Bot"]);

		// Configure npm
		await exec.exec("npm", [
			"config",
			"set",
			`//registry.npmjs.org/:_authToken=${npmToken}`,
		]);

		// Figure out the next version
		newVersion = `${semver.inc(
			require(`${process.env.GITHUB_WORKSPACE}/lerna.json`).version,
			"prerelease",
		)}-pr-${pr}-${pull.merge_commit_sha.slice(0, 7)}`;

		// Bump versions
		await exec.exec(
			"yarn",
			`lerna version ${newVersion} --exact --allow-branch * --ignore-scripts --no-commit-hooks --yes`.split(
				" ",
			),
		);

		// and release
		await exec.exec("yarn", [
			"lerna",
			"publish",
			"from-package",
			"--yes",
			"--dist-tag",
			"next",
		]);
		success = true;
	} catch (e) {
		console.error(e.message);
	}

	if (success) {
		octokit.issues.createComment({
			...options,
			issue_number: pr,
			body: `🎉 The packages have been published.
You can now install the test version with \`npm install zwave-js@${newVersion}\`.`,
		});
	} else {
		octokit.issues.createComment({
			...options,
			issue_number: pr,
			body: `😥 Unfortunately I could not publish the new packages. Check out the logs to see what went wrong.`,
		});
	}
}
