import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import fetch from "node-fetch";
import core from "@actions/core";
import { Octokit } from "@octokit/action";

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
    try {
        await execAsync(`git rev-parse --verify ${branchName}`);
        await execAsync(`git checkout ${branchName}`);
        await execAsync(`git pull origin ${branchName}`);
    } catch {
        await execAsync(`git checkout -b ${branchName}`);
    }
}

async function createOrUpdatePR(octokit, branchName) {
    const { owner, repo } = octokit.context.repo || { owner: "default-owner", repo: "default-repo" };
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
        console.log(`Pull request created: ${pr.html_url}`);
    } else {
        console.log("Pull request already exists.");
    }
}

async function main() {
    try {
        const filesToUpdate = JSON.parse(core.getInput("files-to-update") || "[]");
        if (!Array.isArray(filesToUpdate) || filesToUpdate.length === 0) {
            throw new Error("No files specified in 'files-to-update'.");
        }

        const data = await fetchSupporterData(CONFIG.JSON_URL);

        if (!Array.isArray(data?.tiers) || data.tiers.some(tier => !Array.isArray(tier.members))) {
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
                    console.log(`Updated ${filePath} with supporter names.`);
                    changesMade = true;
                }
            } catch (err) {
                console.error(`Failed to process ${filePath}: ${err.message}`);
            }
        }

        if (changesMade) {
            const gitEmail = core.getInput("git-email") || "actions@github.com";

            await execAsync(`git config user.name "GitHub Actions Bot"`);
            await execAsync(`git config user.email "${gitEmail}"`);
            await execAsync(`git add .`);
            await execAsync(`git commit -m "docs: updated patrons list"`);
            await execAsync(`git push origin ${CONFIG.BRANCH_NAME}`);

            const octokit = new Octokit();
            await createOrUpdatePR(octokit, CONFIG.BRANCH_NAME);
        } else {
            console.log("No changes detected. Skipping pull request creation.");
        }
    } catch (error) {
        core.setFailed(error.message);
    }
}

main();
