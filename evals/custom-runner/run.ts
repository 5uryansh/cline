import chalk from "chalk";
import { spawnVSCode, cleanupVSCode } from "./vscode";
import { runTaskWithWebSocket } from "./task";

interface CustomRunOptions {
    prompt: string;
    repoPath: string;
    fast?: boolean;
    apiKey?: string;
    model?: string;
    provider?: string;
}

export async function customRunHandler(options: CustomRunOptions): Promise<void> {
    console.log(chalk.blue(`Running custom evaluation with model: ${options.model}`));
    console.log(chalk.blue(`Repository: ${options.repoPath}`));

    try {
        // 1. Spawn VSCode
        console.log(chalk.blue("Spawning VSCode..."));
        await spawnVSCode(options.repoPath);
        console.log(chalk.green("VSCode spawned."));

        // 2. Run task using WebSocket
        console.log(chalk.blue("Connecting to task server..."));
        await runTaskWithWebSocket({
            task: options.prompt,
            apiKey: options.apiKey,
            model: options.model,
            provider: options.provider,
            fast: options.fast,
            repoPath: options.repoPath,
        });

        console.log(chalk.green("\n✅ Custom run finished successfully!"));

    } catch (error) {
        console.error(chalk.red(`Custom run failed: ${error instanceof Error ? error.message : String(error)}`));
        console.error(chalk.red(error instanceof Error ? error.stack : ''));
        process.exit(1);
    } finally {
        // 3. Cleanup
        console.log(chalk.blue("Cleaning up VSCode..."));
        try {
            await cleanupVSCode(options.repoPath);
            console.log(chalk.green("Cleanup completed."));
        } catch (cleanupError) {
            console.error(chalk.red(`Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`));
        }
    }
}
