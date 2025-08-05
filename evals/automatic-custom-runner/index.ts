#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { automaticCustomRunHandler } from "./run";

const program = new Command();

program
    .name("cline-automatic-custom-runner")
    .description("A custom runner for Cline that uses @vscode/test-electron to execute a single prompt.")
    .version("0.1.0");

program
    .command("run")
    .description("Run a single task evaluation")
    .requiredOption("-p, --prompt <prompt>", "The prompt for the task")
    .requiredOption("-r, --repo-path <repoPath>", "The local path to the repository")
    .option("--fast", "Enable fast mode to commit and push changes automatically after the task is complete.", false)
    .option("-k, --api-key <apiKey>", "API key for the provider (for Vertex, this is your GCP Project ID)")
    .option("--vertex-region <region>", "The GCP region for Vertex AI")
    .option("-m, --model <model>", "The model to use")
    .option("--provider <provider>", "The API provider to use (e.g., 'anthropic', 'openai')")
    .action(async (options) => {
        try {
            await automaticCustomRunHandler(options);
        } catch (error) {
            console.error(chalk.red(`Error during automatic custom run: ${error instanceof Error ? error.message : String(error)}`));
            process.exit(1);
        }
    });

program.parse(process.argv);

if (process.argv.length === 2) {
    program.help();
}
