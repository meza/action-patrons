import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import core from "@actions/core";
import { Octokit } from "@octokit/action";
import yaml from "js-yaml";


const execAsync = promisify(exec);

const CONFIG = {
    JSON_URL: "https://vsbmeza3.com/supporters.json",
    BRANCH_NAME: "update/patrons",
    START_MARKER: core.getInput("start-marker"),
    END_MARKER: core.getInput("end-marker"),
    FAIL_ON_MISSING_MARKERS: core.getInput("fail-on-missing-markers") === "true",
};

async function fetchSupporterData(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function updateFileContent(filePath, pattern, replacement) {
    const fileContent = await fs.readFile(filePath, "utf8");
    const startIndex = fileContent.indexOf(CONFIG.START_MARKER);
    const endIndex = fileContent.indexOf(CONFIG.END_MARKER);

    if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
        if (CONFIG.FAIL_ON_MISSING_MARKERS) {
            throw new Error(`Markers are missing or misordered in ${filePath}`);
        }
        return null;
    }
    return fileContent.replace(pattern, replacement);
}

async function setupGitBranch(branchName) {
    await execAsync(`git checkout -B ${branchName}`);
    await execAsync(`git reset --hard origin/main`);
}

async function createOrUpdatePR(octokit, branchName, owner, repo) {
    const { data: pullRequests } = await octokit.rest.pulls.list({
        owner,
        repo,
        head: `${owner}:${branchName}`,
    });

    if (pullRequests.length === 0) {
        const { data: pr } = await octokit.rest.pulls.create({
            owner,
            repo,
            head: branchName,
            base: "main",
            title: "Update supporters list",
            body: "This PR updates the supporters list.",
        });

        // Enable auto-merge using GraphQL
        try {
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
        }

        core.info(`Pull request created: ${pr.html_url}`);
    } else {
        core.info("Pull request already exists.");
    }
}

async function main() {
    try {
        const filesToUpdate = yaml.load(core.getInput("files-to-update") || "[]");
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
                const updatedContent = await updateFileContent(filePath, pattern, replacement);
                if (updatedContent) {
                    await fs.writeFile(filePath, updatedContent);
                    core.info(`Updated ${filePath} with supporter names.`);
                    changesMade = true;
                }
            } catch (err) {
                core.error(`Failed to process ${filePath}: ${err.message}`);
            }
        }

        if (changesMade) {
            const gitEmail = core.getInput("git-email") || "actions@github.com";

            await execAsync(`git config user.name "GitHub Actions Bot"`);
            await execAsync(`git config user.email "${gitEmail}"`);
            await execAsync(`git add .`);
            await execAsync(`git commit -m "docs: updated patrons list"`);
            await execAsync(`git push -f origin ${CONFIG.BRANCH_NAME}`);

            const octokit = new Octokit();
            const owner = process.env.GITHUB_REPOSITORY?.split('/')[0];
            const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];

            await createOrUpdatePR(octokit, CONFIG.BRANCH_NAME, owner, repo);
        } else {
            core.info("No changes detected. Skipping pull request creation.");
        }
    } catch (error) {
        core.setFailed(error.message);
        await execAsync(`git checkout ${originalBranch}`);
        await execAsync(`git branch -D ${branchName}`);
    }
}

main();
