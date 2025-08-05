import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { runTaskWithWebSocket } from './task'; 
import { exec } from 'child_process';

export async function run(): Promise<void> {
    try {
        console.log('Starting in-VSCode test runner...');

        // 1. Activate the extension
        const extension = vscode.extensions.getExtension('saoudrizwan.claude-dev');
        if (!extension) {
            throw new Error('Cline extension not found');
        }
        await extension.activate();
        console.log('Cline extension activated.');

        // 2. Get options from environment variables
        const prompt = process.env.CLINE_EVAL_PROMPT;
        if (!prompt) {
            throw new Error('CLINE_EVAL_PROMPT environment variable not set');
        }
        const repoPath = process.env.CLINE_EVAL_REPO_PATH;
        if (!repoPath) {
            throw new Error('CLINE_EVAL_REPO_PATH environment variable not set');
        }

        const options = {
            task: prompt,
            apiKey: process.env.CLINE_EVAL_API_KEY,
            model: process.env.CLINE_EVAL_MODEL,
            provider: process.env.CLINE_EVAL_PROVIDER,
            vertexRegion: process.env.CLINE_EVAL_VERTEX_REGION,
            fast: process.env.CLINE_EVAL_FAST_MODE === 'true',
            repoPath: repoPath,
        };

        console.log('Running task with options:', options);

        // 3. Run the task
        await runTaskWithWebSocket(options);

        // 4. Handle fast mode
        if (options.fast) {
            console.log('Fast mode enabled. Committing and pushing changes...');
            const gitignorePath = path.join(options.repoPath, '.gitignore');
            const ignoreEntry = 'evals.env';
            if (fs.existsSync(gitignorePath)) {
                const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
                if (!gitignoreContent.includes(ignoreEntry)) {
                    fs.appendFileSync(gitignorePath, `\n${ignoreEntry}`);
                }
            } else {
                fs.writeFileSync(gitignorePath, ignoreEntry);
            }
            const commitMessage = 'EUL-18454:cline one click pr';
            await new Promise((resolve, reject) => {
                exec('git add .', { cwd: options.repoPath }, (err) => {
                    if (err) return reject(err);
                    resolve(null);
                });
            });
            
            const commitResult = await new Promise<{ stdout: string, stderr: string }>((resolve) => {
                exec(`git commit -m "${commitMessage}"`, { cwd: options.repoPath }, (err, stdout, stderr) => {
                    resolve({ stdout, stderr });
                });
            });

            if (commitResult.stdout.includes('nothing to commit') || commitResult.stderr.includes('nothing to commit')) {
                console.log('No changes to commit. Skipping push.');
            } else {
                const { stdout: branchName } = await new Promise<{ stdout: string }>((resolve, reject) => {
                    exec('git rev-parse --abbrev-ref HEAD', { cwd: options.repoPath }, (err, stdout) => {
                        if (err) return reject(err);
                        resolve({ stdout });
                    });
                });
                await new Promise((resolve, reject) => {
                    exec(`git push --set-upstream origin ${branchName.trim()}`, { cwd: options.repoPath }, (err) => {
                        if (err) return reject(err);
                        resolve(null);
                    });
                });
                console.log('Changes committed and pushed successfully.');
            }
        }

        console.log('In-VSCode test runner finished successfully.');

    } catch (error) {
        console.error('Error in in-VSCode test runner:', error);
        process.exit(1);
    }
}
