const exec = require("@actions/exec");
const github = require("@actions/github");
const core = require("@actions/core");

const githubToken = core.getInput("githubToken");
const task = core.getInput("task");
const octokit = github.getOctokit(githubToken);
const semver = require("semver");

const options = {
	owner: "zwave-js",
	repo: "node-zwave-js",
};

if (task === "publish-pr") {
	publishPr();
}

async function publishPr() {
	const pr = core.getInput("pr");

	const { data: pull } = await octokit.pulls.get({
		...options,
		pull_number: pr,
	});
	console.dir(pull, { depth: Infinity });
	if (!pull.mergeable || !pull.merge_commit_sha) {
		octokit.issues.createComment({
			...options,
			issue_number: pr,
			body: `😥 Seems like this PR cannot be merged. Please fix the merge conflicts and try again.`,
		});
		return;
	}

	// Checkout merge commit
	await exec.exec("git", ["checkout", `${pull.merge_commit_sha}`]);
	// Build it
	await exec.exec("yarn", ["run", "build"]);

	// Figure out the next version
	const newVersion = `${semver.inc(
		require("./package.json").version,
		"prerelease",
	)}-pr-${pr}-${pull.merge_commit_sha.slice(0, 7)}`;

	// Bump versions
	await exec(
		"npx",
		`lerna version ${newVersion} --exact --allow-branch * --ignore-scripts --no-commit-hooks --yes`.split(
			" ",
		),
	);
	// and release
	let success = false;
	try {
		await exec(
			"npx",
			`lerna publish from-git --dist-tag next --yes`.split(" "),
		);
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
