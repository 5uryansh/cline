#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { customRunHandler } from "./run";

const program = new Command();

program
    .name("cline-custom-runner")
    .description("A custom runner for Cline to execute a single prompt in a given repository.")
    .version("0.1.0");

program
    .command("run")
    .description("Run a single task evaluation")
    .requiredOption("-p, --prompt <prompt>", "The prompt for the task")
    .requiredOption("-r, --repo-path <repoPath>", "The local path to the repository")
    .option("-k, --api-key <apiKey>", "API key for the provider")
    .option("-m, --model <model>", "The model to use")
    .option("--provider <provider>", "The API provider to use (e.g., 'anthropic', 'openai')")
    .action(async (options) => {
        try {
            await customRunHandler(options);
        } catch (error) {
            console.error(chalk.red(`Error during custom run: ${error instanceof Error ? error.message : String(error)}`));
            process.exit(1);
        }
    });

program.parse(process.argv);

if (process.argv.length === 2) {
    program.help();
}
