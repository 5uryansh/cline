import WebSocket from "ws";
import chalk from "chalk";
import * as readline from "readline";

interface TaskPayload {
    task: string;
    apiKey?: string;
    model?: string;
    provider?: string;
}

/**
 * Runs a task by communicating with the Cline test server over a WebSocket.
 * @param payload The task payload
 * @returns A promise that resolves with the final result of the task execution.
 */
export function runTaskWithWebSocket(payload: TaskPayload): Promise<any> {
    const SERVER_URL = "ws://localhost:9876";

    return new Promise((resolve, reject) => {
        console.log(chalk.blue("[task.ts] Attempting to connect to WebSocket server..."));
        const ws = new WebSocket(SERVER_URL);
        let taskId: string | null = null;

        ws.on("open", () => {
            console.log(chalk.green("[task.ts] Connected to test server."));
            ws.send(JSON.stringify({ type: "startTask", payload }));
        });

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        ws.on("message", (data) => {
            const message = JSON.parse(data.toString());
            const { type, payload } = message;

            switch (type) {
                case "taskStarted":
                    taskId = payload.taskId;
                    console.log(chalk.blue(`Task started with ID: ${taskId}`));
                    break;

                case "ask":
                    console.log(chalk.yellow(`\nCline is asking for: ${payload.ask}`));
                    if (payload.text) {
                        console.log(chalk.yellow(`Message: ${payload.text}`));
                    }
                    // Auto-approve for now
                    const response = {
                        type: "askResponse",
                        payload: {
                            responseType: "yesButtonClicked",
                            text: "Continue",
                        },
                    };
                    ws.send(JSON.stringify(response));
                    console.log(chalk.green("Automatically approved request."));
                    break;

                case "say":
                    if (payload.say === "reasoning" && payload.text) {
                        console.log(chalk.magenta("Cline's Thoughts:"), payload.text);
                    } else if (payload.say === "text" && payload.text) {
                        console.log(chalk.cyan("Cline:"), payload.text);
                    }
                    break;
                
                case "completion":
                    console.log(chalk.green("\nTask completed. Type your next message or press Ctrl+C to exit."));
                    rl.prompt();
                    break;

                case "error":
                    console.error(chalk.red(`Server error: ${payload.message}`));
                    ws.close();
                    reject(new Error(payload.message));
                    break;
            }
        });

        rl.on("line", (line) => {
            if (line.trim() && taskId) {
                // Send a follow-up message to continue the conversation
                ws.send(JSON.stringify({ type: "followUp", payload: { task: line.trim(), taskId } }));
            }
            rl.prompt();
        });

        rl.on("close", () => {
            ws.close();
            resolve(null);
        });

        ws.on("error", (error) => {
            console.error(chalk.red(`[task.ts] WebSocket error: ${error.message}`));
            if (error.message.includes("ECONNREFUSED")) {
                reject(new Error("[task.ts] Could not connect to the test server. Make sure VSCode is running with the Cline extension and the test server is active."));
            } else {
                reject(error);
            }
        });

        ws.on("close", () => {
            console.log(chalk.gray("[task.ts] Disconnected from test server."));
        });
    });
}
