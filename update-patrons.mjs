import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import core from "@actions/core";
import { Octokit } from "@octokit/action";
import yaml from "js-yaml";

// Enhanced exec with output capture
const execAsync = async (command) => {
    core.debug(`Executing: ${command}`);
    try {
        const { stdout, stderr } = await promisify(exec)(command);
        core.debug(`Command stdout: ${stdout.trim()}`);
        if (stderr) core.debug(`Command stderr: ${stderr.trim()}`);
        return { stdout, stderr };
    } catch (error) {
        core.error(`Command failed: ${command}`);
        core.error(`Error message: ${error.message}`);
        if (error.stdout) core.error(`Error stdout: ${error.stdout}`);
        if (error.stderr) core.error(`Error stderr: ${error.stderr}`);
        throw error;
    }
};

const CONFIG = {
    JSON_URL: "https://vsbmeza3.com/supporters.json",
    BRANCH_NAME: "update/patrons",
    START_MARKER: core.getInput("start-marker"),
    END_MARKER: core.getInput("end-marker"),
    FAIL_ON_MISSING_MARKERS: core.getInput("fail-on-missing-markers") === "true",
};

async function fetchSupporterData(url) {
    core.debug(`Fetching supporter data from: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    core.debug(`Received supporter data: ${JSON.stringify(data).substring(0, 200)}...`);
    return data;
}

async function updateFileContent(filePath, pattern, replacement) {
    core.debug(`Reading file: ${filePath}`);
    const fileContent = await fs.readFile(filePath, "utf8");
    const startIndex = fileContent.indexOf(CONFIG.START_MARKER);
    const endIndex = fileContent.indexOf(CONFIG.END_MARKER);

    core.debug(`Markers - start: ${startIndex}, end: ${endIndex}`);

    if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
        if (CONFIG.FAIL_ON_MISSING_MARKERS) {
            throw new Error(`Markers are missing or misordered in ${filePath}`);
        }
        core.warning(`Markers not found in ${filePath}, skipping`);
        return null;
    }
    return fileContent.replace(pattern, replacement);
}

async function setupGitBranch(branchName) {
    core.info(`Setting up git branch: ${branchName}`);
    try {
        await execAsync(`git checkout -B ${branchName}`);
        core.info(`Successfully checked out branch: ${branchName}`);
    } catch (error) {
        core.setFailed(`Failed to setup git branch: ${error.message}`);
        throw error;
    }
}

async function createOrUpdatePR(octokit, branchName, owner, repo) {
    core.info(`Creating/updating PR for branch ${branchName} in ${owner}/${repo}`);

    const { data: pullRequests } = await octokit.rest.pulls.list({
        owner,
        repo,
        head: `${owner}:${branchName}`,
    });

    core.debug(`Found ${pullRequests.length} existing PRs`);

    if (pullRequests.length === 0) {
        core.info(`Creating new PR for branch ${branchName}`);
        const { data: pr } = await octokit.rest.pulls.create({
            owner,
            repo,
            head: branchName,
            base: "main",
            title: "Update supporters list",
            body: "This PR updates the supporters list.",
        });

        try {
            core.debug(`Enabling auto-merge for PR ID: ${pr.node_id}`);
            await octokit.graphql(`
                mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
                    enablePullRequestAutoMerge(input: {
                        pullRequestId: $pullRequestId,
                        mergeMethod: $mergeMethod
                    }) {
                        clientMutationId
                    }
                }
            `, {
                pullRequestId: pr.node_id,
                mergeMethod: "MERGE"
            });
            core.info(`Auto-merge enabled for PR: ${pr.html_url}`);
        } catch (error) {
            core.warning(`Failed to enable auto-merge: ${error.message}`);
            core.debug(`Auto-merge error details: ${JSON.stringify(error)}`);
        }

        core.info(`Pull request created: ${pr.html_url}`);
    } else {
        core.info(`Pull request already exists: ${pullRequests[0].html_url}`);
    }
}

async function main() {
    try {
        core.info("Starting patron update process");
        core.debug(`Environment: ${JSON.stringify(process.env.GITHUB_REPOSITORY)}`);

        const filesToUpdate = yaml.load(core.getInput("files-to-update") || "[]");
        core.debug(`Files to update: ${JSON.stringify(filesToUpdate)}`);

        if (!Array.isArray(filesToUpdate) || filesToUpdate.length === 0) {
            throw new Error("No files specified in 'files-to-update'.");
        }

        const data = await fetchSupporterData(CONFIG.JSON_URL);

        if (!Array.isArray(data?.tiers)) {
            throw new Error("Supporter tiers are missing or malformed.");
        }

        if (data.tiers.length === 0) {
            core.warning("No supporters found in the supporter data.");
            return;
        }

        if(data.tiers.some(tier => !Array.isArray(tier.members))) {
            throw new Error("Supporter data is missing or malformed.");
        }

        const lastTier = data.tiers[data.tiers.length - 1];
        const names = lastTier.members.map((m) => m.name).join(" · ");
        const replacement = `${CONFIG.START_MARKER}\n\n${names}\n\n${CONFIG.END_MARKER}`;
        const pattern = new RegExp(`${CONFIG.START_MARKER}\\s*[\\s\\S]*?\\s*${CONFIG.END_MARKER}`);

        await setupGitBranch(CONFIG.BRANCH_NAME);

        let changesMade = false;
        for (const filePath of filesToUpdate) {
            try {
                core.info(`Processing file: ${filePath}`);
                const updatedContent = await updateFileContent(filePath, pattern, replacement);
                if (updatedContent) {
                    await fs.writeFile(filePath, updatedContent);
                    core.info(`Updated ${filePath} with supporter names.`);
                    changesMade = true;
                }
            } catch (err) {
                core.error(`Failed to process ${filePath}: ${err.message}`);
                core.debug(`Error stack: ${err.stack}`);
            }
        }

        if (changesMade) {
            const gitEmail = core.getInput("git-email") || "actions@github.com";
            core.info(`Setting up git configuration with email: ${gitEmail}`);

            await execAsync(`git config user.name "GitHub Actions Bot"`);
            await execAsync(`git config user.email "${gitEmail}"`);

            // Get git status before adding files
            const { stdout: statusBefore } = await execAsync(`git status`);
            core.debug(`Git status before add: ${statusBefore}`);

            await execAsync(`git add .`);

            const { stdout: porcelainStatus } = await execAsync(`git status --porcelain`);
            core.debug(`Git porcelain status: ${porcelainStatus}`);

            if (!porcelainStatus.trim()) {
                core.info("No changes to commit, skipping commit and push operations");
                return; // Or continue to next part of your workflow
            } else {
                core.info(`Changes detected: ${porcelainStatus.split('\n').length} files modified`);

                try {
                    core.info("Attempting to commit changes");
                    await execAsync(`git commit -m "docs: updated patrons list"`);
                    core.info("Commit successful");
                } catch (error) {
                    core.error("Git commit failed");
                    // Check if there were no changes to commit
                    const {stdout: diffCheck} = await execAsync(`git diff --staged --name-only`).catch(e => ({stdout: ""}));
                    if (!diffCheck.trim()) {
                        core.warning("No changes to commit - this might be why the commit failed");
                    }
                    throw error;
                }


                core.info(`Pushing to remote branch: ${CONFIG.BRANCH_NAME}`);
                await execAsync(`git push -f origin ${CONFIG.BRANCH_NAME}`);
                core.info("Push successful");

                const octokit = new Octokit();
                const owner = process.env.GITHUB_REPOSITORY?.split('/')[0];
                const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
                core.debug(`Repository: ${owner}/${repo}`);

                await createOrUpdatePR(octokit, CONFIG.BRANCH_NAME, owner, repo);
            }
        } else {
            core.info("No changes detected. Skipping pull request creation.");
        }

        core.info("Process completed successfully");
    } catch (error) {
        core.error(`Failed with error: ${error.message}`);
        core.debug(`Error stack: ${error.stack}`);
        core.setFailed(error.message);
    }
}

main();
