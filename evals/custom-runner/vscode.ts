import execa from "execa";
import * as path from "path";
import * as fs from "fs";
import fetch from "node-fetch";
import * as os from "os";
import chalk from "chalk";
import WebSocket from "ws";

const SETTINGS_BACKUP_PATH = path.resolve(__dirname, ".autoApprovalSettings.backup.json");

function getUserSettingsPath() {
    const homeDir = os.homedir();
    switch (process.platform) {
        case "darwin":
            return path.join(homeDir, "Library", "Application Support", "Code", "User", "settings.json");
        case "win32":
            return path.join(homeDir, "AppData", "Roaming", "Code", "User", "settings.json");
        case "linux":
            return path.join(homeDir, ".config", "Code", "User", "settings.json");
        default:
            throw new Error("Unsupported platform");
    }
}

async function backupAutoApprovalSettings() {
    try {
        const settingsPath = getUserSettingsPath();
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
            const autoApprovalSettings = settings["cline.autoApprovalSettings"];
            if (autoApprovalSettings) {
                fs.writeFileSync(SETTINGS_BACKUP_PATH, JSON.stringify(autoApprovalSettings, null, 2));
                console.log("Backed up auto-approval settings.");
            }
        }
    } catch (error) {
        console.warn("Could not back up auto-approval settings:", error);
    }
}

async function restoreAutoApprovalSettings() {
    try {
        if (fs.existsSync(SETTINGS_BACKUP_PATH)) {
            const backup = JSON.parse(fs.readFileSync(SETTINGS_BACKUP_PATH, "utf-8"));
            const settingsPath = getUserSettingsPath();
            let settings: any = {};
            if (fs.existsSync(settingsPath)) {
                settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
            }
            settings["cline.autoApprovalSettings"] = backup;
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
            fs.unlinkSync(SETTINGS_BACKUP_PATH);
            console.log("Restored auto-approval settings.");
        }
    } catch (error) {
        console.warn("Could not restore auto-approval settings:", error);
    }
}

/**
 * Ensures VSCode is running with the correct workspace and Cline is ready.
 * @param workspacePath The workspace path to open
 */
export async function spawnVSCode(workspacePath: string): Promise<void> {
    if (!fs.existsSync(workspacePath)) {
        throw new Error(`Workspace path does not exist: ${workspacePath}`);
    }

    await backupAutoApprovalSettings();

    const evalsEnvPath = path.join(workspacePath, "evals.env");
    fs.writeFileSync(evalsEnvPath, `# This file activates Cline test mode.\n`);

    const extensionPath = path.resolve(__dirname, "..", "..", "..");
    console.log(chalk.blue(`[vscode.ts] Launching Extension Development Host for extension at: ${extensionPath}`));
    console.log(chalk.blue(`[vscode.ts] Opening workspace: ${workspacePath}`));

    await execa("code", ["--extensionDevelopmentPath", extensionPath, workspacePath], { stdio: "inherit" });

    console.log("[vscode.ts] Waiting for VS Code to initialize and extension to load...");
    console.log("[vscode.ts] Waiting for VS Code to initialize and extension to load...");
    await new Promise((resolve) => setTimeout(resolve, 15000)); // Increased wait time for extension host

    try {
        console.log("[vscode.ts] Attempting to open Cline in a new tab...");
        await execa("code", ["--command", "cline.openInNewTab"], { stdio: "inherit" });
        await new Promise((resolve) => setTimeout(resolve, 10000));
    } catch (error) {
        console.warn("[vscode.ts] Could not explicitly open Cline tab, continuing...", error);
    }

    let serverStarted = false;
    console.log("[vscode.ts] Pinging test server...");
    for (let i = 0; i < 30; i++) {
        try {
            // Use WebSocket connection attempt to check for server readiness
            const ws = new WebSocket("ws://localhost:9876");
            await new Promise((resolve, reject) => {
                ws.on("open", () => {
                    console.log(chalk.green("[vscode.ts] Test server is running!"));
                    serverStarted = true;
                    ws.close();
                    resolve(null);
                });
                ws.on("error", reject);
            });
            if (serverStarted) break;
        } catch (error) {
            process.stdout.write(".");
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
    console.log(""); // Newline after pinging

    if (!serverStarted) {
        throw new Error("Test server did not start. Please ensure Cline is running.");
    }
}

/**
 * Clean up resources after the test run.
 * @param workspacePath The workspace path to clean up resources for
 */
export async function cleanupVSCode(workspacePath: string): Promise<void> {
    console.log(`Cleaning up resources for workspace: ${workspacePath}`);

    await restoreAutoApprovalSettings();

    try {
        await fetch("http://localhost:9876/shutdown", { method: "POST" });
    } catch (error) {
        // Ignore
    }

    const evalsEnvPath = path.join(workspacePath, "evals.env");
    if (fs.existsSync(evalsEnvPath)) {
        fs.unlinkSync(evalsEnvPath);
    }

    console.log("Cleanup completed.");
}
