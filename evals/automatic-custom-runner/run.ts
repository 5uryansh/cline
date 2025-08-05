import * as path from 'path';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';
import chalk from 'chalk';

interface AutomaticCustomRunOptions {
    prompt: string;
    repoPath: string;
    fast?: boolean;
    apiKey?: string;
    model?: string;
    provider?: string;
    vertexRegion?: string;
}

export async function automaticCustomRunHandler(options: AutomaticCustomRunOptions): Promise<void> {
    const evalsEnvPath = path.join(options.repoPath, "evals.env");
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..');
        const extensionTestsPath = path.resolve(__dirname, 'in-vscode-test.js');
        const testWorkspace = options.repoPath;

        console.log(chalk.blue(`Extension development path: ${extensionDevelopmentPath}`));
        console.log(chalk.blue(`Extension tests path: ${extensionTestsPath}`));
        console.log(chalk.blue(`Test workspace: ${testWorkspace}`));

        // Create evals.env to activate test mode
        fs.writeFileSync(evalsEnvPath, `# This file activates Cline test mode.\n`);
        console.log(chalk.green(`Created evals.env file at ${evalsEnvPath} to activate test mode.`));

        // Pass options to the test script via environment variables
        process.env.CLINE_EVAL_PROMPT = options.prompt;
        process.env.CLINE_EVAL_API_KEY = options.apiKey;
        process.env.CLINE_EVAL_MODEL = options.model;
        process.env.CLINE_EVAL_PROVIDER = options.provider;
        process.env.CLINE_EVAL_VERTEX_REGION = options.vertexRegion;
        process.env.CLINE_EVAL_FAST_MODE = options.fast ? 'true' : 'false';
        process.env.CLINE_EVAL_REPO_PATH = options.repoPath;

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [testWorkspace, '--disable-extensions'],
        });

    } catch (err) {
        console.error(chalk.red('Failed to run tests:'), err);
        process.exit(1);
    } finally {
        // Cleanup the evals.env file
        if (fs.existsSync(evalsEnvPath)) {
            fs.unlinkSync(evalsEnvPath);
            console.log(chalk.green(`Cleaned up evals.env file.`));
        }
    }
}
