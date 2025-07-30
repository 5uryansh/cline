import execa from "execa";
import * as path from "path";
import * as fs from "fs";
import fetch from "node-fetch";
import * as os from "os";
import chalk from "chalk";
import WebSocket from "ws";

const SETTINGS_BACKUP_PATH = path.resolve(__dirname, ".autoApprovalSettings.backup.json");
const EXTENSION_PATH = path.resolve(__dirname, "..", "..", "..");

function escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

let vscodeProcess: execa.ExecaChildProcess | null = null;
let electronPid: number | null = null;

async function closeExistingVSCodeDevHost() {
    console.log(chalk.blue("[vscode.ts] Checking for existing VSCode Extension Development Host windows..."));
    try {
        // Use pgrep to find processes with --extensionDevelopmentPath in their command line
        const { stdout } = await execa("pgrep", ["-f", "extensionDevelopmentPath"]);
        const pids = stdout.trim().split("\n").filter(Boolean);

        if (pids.length > 0) {
            console.log(chalk.yellow(`[vscode.ts] Found existing VSCode dev host process(es) with PIDs: ${pids.join(", ")}. Closing...`));
            await execa("kill", ["-9", ...pids]);
            console.log(chalk.green("[vscode.ts] Closed existing VSCode dev host window(s)."));
        } else {
            console.log(chalk.blue("[vscode.ts] No existing VSCode dev host windows found."));
        }
    } catch (error: any) {
        if (error.exitCode === 1) {
            // pgrep exits with 1 if no processes are found, which is not an error in this context.
            console.log(chalk.blue("[vscode.ts] No existing VSCode dev host windows found."));
            return;
        }
        console.warn("[vscode.ts] Could not check for or close existing VSCode dev windows:", error);
    }
}

export async function spawnVSCode(workspacePath: string): Promise<void> {
    // First, ensure any existing dev host is closed to start fresh.
    await closeExistingVSCodeDevHost();
    vscodeProcess = null;
    electronPid = null;

    // If a backup exists, a previous run likely crashed. Restore settings.
    if (fs.existsSync(SETTINGS_BACKUP_PATH)) {
        console.log(chalk.yellow("[vscode.ts] Found existing settings backup from a previous run. Restoring..."));
        await restoreAutoApprovalSettings();
    }

    if (!fs.existsSync(workspacePath)) {
        throw new Error(`Workspace path does not exist: ${workspacePath}`);
    }

    await backupAutoApprovalSettings();

    const evalsEnvPath = path.join(workspacePath, "evals.env");
    fs.writeFileSync(evalsEnvPath, `# This file activates Cline test mode.\n`);

    console.log(chalk.blue(`[vscode.ts] Launching Extension Development Host for extension at: ${EXTENSION_PATH}`));
    console.log(chalk.blue(`[vscode.ts] Opening workspace: ${workspacePath}`));

    const vscodeArgs = [
        "--extensionDevelopmentPath", EXTENSION_PATH,
        "--folder-uri", `file://${workspacePath}`,
        "--wait"
    ];
    console.log(chalk.blue(`[vscode.ts] Executing command: code ${vscodeArgs.join(" ")}`));

    try {
        vscodeProcess = execa("code", vscodeArgs, { stdio: "inherit", detached: false });
        console.log(`[vscode.ts] VSCode process started with PID: ${vscodeProcess.pid}`);

        // Find the Electron child process
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for Electron to spawn
        try {
            const { stdout } = await execa("pgrep", ["-P", `${vscodeProcess.pid}`]);
            const childPids = stdout.trim().split("\n").map(Number);
            for (const pid of childPids) {
                const { stdout: cmd } = await execa("ps", ["-p", `${pid}`, "-o", "command"]);
                if (cmd.includes("Electron") && cmd.includes("--extensionDevelopmentPath")) {
                    electronPid = pid;
                    console.log(`[vscode.ts] Electron child process found with PID: ${electronPid}`);
                    console.log(`[vscode.ts] Electron process command line:\n${cmd}`);
                    break;
                }
            }
        } catch (error) {
            console.warn("[vscode.ts] Could not find Electron child process:", error);
        }

        vscodeProcess.on("exit", (code, signal) => {
            console.log(`[vscode.ts] VSCode process exited with code ${code}, signal ${signal}`);
            vscodeProcess = null;
        });

        await new Promise((resolve) => setTimeout(resolve, 15000));
        console.log("[vscode.ts] Waiting for VS Code to initialize and extension to load...");

        try {
            console.log("[vscode.ts] Attempting to open Cline in a new tab...");
            await execa("code", ["--goto", "cline://open"], { stdio: "inherit" });
            await new Promise((resolve) => setTimeout(resolve, 10000));
        } catch (error) {
            console.warn("[vscode.ts] Could not explicitly open Cline tab, continuing...", error);
        }

        let serverStarted = false;
        console.log("[vscode.ts] Pinging test server...");
        for (let i = 0; i < 30; i++) {
            try {
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
        console.log("");

        if (!serverStarted) {
            throw new Error("Test server did not start. Please ensure Cline is running.");
        }

        if (vscodeProcess && !vscodeProcess.killed) {
            console.log(`[vscode.ts] VSCode process (PID: ${vscodeProcess.pid}) is still running.`);
            try {
                const { stdout } = await execa("ps", ["-p", `${vscodeProcess.pid}`, "-o", "command"]);
                console.log(`[vscode.ts] VSCode process command line:\n${stdout}`);
            } catch (error) {
                console.warn(`[vscode.ts] Could not retrieve command line for PID ${vscodeProcess.pid}:`, error);
            }
        } else {
            console.warn("[vscode.ts] VSCode process is no longer running before test server check.");
        }
    } catch (error) {
        console.error("[vscode.ts] Failed to launch or maintain VSCode process:", error);
        throw error;
    }
}

export async function cleanupVSCode(workspacePath: string): Promise<void> {
    console.log(`Cleaning up resources for workspace: ${workspacePath}`);

    await restoreAutoApprovalSettings();

    try {
        await fetch("http://localhost:9876/shutdown", { method: "POST" });
    } catch (error) {
        console.warn("[vscode.ts] Could not send shutdown request to test server:", error);
    }

    const evalsEnvPath = path.join(workspacePath, "evals.env");
    if (fs.existsSync(evalsEnvPath)) {
        fs.unlinkSync(evalsEnvPath);
    }

    try {
        console.log("[vscode.ts] Closing VSCode Extension Development Host window...");
        
        if (vscodeProcess && vscodeProcess.pid) {
            try {
                console.log("[vscode.ts] VSCODE PID: ", vscodeProcess.pid);
                await execa("kill", ["-9", `${vscodeProcess.pid}`]);
                vscodeProcess = null;
            } catch (error: any) {
                // Ignore error if process is already dead
                console.log("[vscode.ts] Error in VSCODE PID: ", error);
            }
        }
        if (electronPid) {
            try {
                console.log("[vscode.ts] Electron PID: ", electronPid);
                await execa("kill", ["-9", `${electronPid}`]);
                electronPid = null;
            } catch (error: any) {
                // Ignore error if process is already dead
                console.log("[vscode.ts] Error in Electron PID: ", error);
            }
        }
    } catch (error) {
        console.warn("[vscode.ts] Could not close VSCode window, continuing...", error);
    }

    console.log("Cleanup completed.");
}
