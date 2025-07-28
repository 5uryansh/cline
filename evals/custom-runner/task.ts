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

        // These ws.on(...) event listeners are part of the standard WebSocket API provided by the 'ws' library.
        // They handle different stages of the WebSocket connection lifecycle.

        // The 'open' event is fired by the 'ws' library when the connection is successfully established.
        ws.on("open", () => {
            console.log(chalk.green("[task.ts] Event 'open': Connected to test server."));
            // After connecting, we send a 'startTask' message to the Cline test server to begin the task.
            ws.send(JSON.stringify({ type: "startTask", payload }));
        });

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        // The 'message' event is fired by the 'ws' library when a message is received from the server.
        // The 'data' parameter contains the raw message content from the Cline test server.
        ws.on("message", (data) => {

            // The message from the Cline test server is a JSON string with a 'type' and 'payload'.
            const message = JSON.parse(data.toString());
            const { type, payload } = message;

            // The switch statement handles the different message types defined by the Cline test server's protocol.
            switch (type) {
                case "taskStarted":
                    taskId = payload.taskId;
                    console.log(chalk.blue(`Task started with ID: ${taskId}`));
                    break;

                case "ask":
                    console.log(chalk.yellow(`\nCline is asking: ${payload.question}`));
                    if (payload.options && payload.options.length > 0) {
                        console.log(chalk.yellow("Options:"));
                        payload.options.forEach((option: string) => console.log(chalk.yellow(`- ${option}`)));
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
                    // console.log(chalk.green("Automatically approved request."));
                    break;

                case "say":
                    const SAY_REASONING_AS_NUM = 5;
                    const SAY_TEXT_AS_NUM = 4;
                    const sayAsNumber = Number(payload.say);

                    if (sayAsNumber === SAY_REASONING_AS_NUM && payload.text) {
                        console.log(chalk.magenta("Cline's Thoughts:"), payload.text);
                    } else if (sayAsNumber === SAY_TEXT_AS_NUM && payload.text) {
                        console.log(chalk.cyan("Cline:"), payload.text);
                    }
                    break;

                case "completion":
                    console.log(chalk.green("\nTask completed."));
                    if (payload.text) {
                        console.log(chalk.green(`Final message: ${payload.text}`));
                    }
                    console.log(chalk.green("Type your next message or press Ctrl+C to exit."));
                    rl.prompt();
                    break;

                case "error":
                    console.error(chalk.red(`Server error: ${payload.message}`));
                    ws.close();
                    reject(new Error(payload.message));
                    break;
            }
        });

        // The 'ping' event is fired when a ping frame is received from the server.
        ws.on("ping", (data) => {
            console.log(chalk.blue(`[task.ts] Event 'ping': Received ping with data: ${data.toString()}`));
        });

        // The 'pong' event is fired when a pong frame is received from the server.
        ws.on("pong", (data) => {
            console.log(chalk.blue(`[task.ts] Event 'pong': Received pong with data: ${data.toString()}`));
        });

        // The 'unexpected-response' event is fired when the server sends a non-101 response to the upgrade request.
        ws.on("unexpected-response", (req, res) => {
            console.error(chalk.red(`[task.ts] Event 'unexpected-response': Unexpected server response. Status code: ${res.statusCode}`));
            reject(new Error(`Unexpected server response: ${res.statusCode}`));
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

        // The 'error' event is fired by the 'ws' library when an error occurs on the connection.
        ws.on("error", (error) => {
            console.error(chalk.red(`[task.ts] Event 'error': WebSocket error: ${error.message}`));
            if (error.message.includes("ECONNREFUSED")) {
                reject(new Error("[task.ts] Could not connect to the test server. Make sure VSCode is running with the Cline extension and the test server is active."));
            } else {
                reject(error);
            }
        });

        // The 'close' event is fired by the 'ws' library when the connection is closed.
        ws.on("close", (code, reason) => {
            const reasonString = reason ? reason.toString() : "No reason given";
            console.log(chalk.gray(`[task.ts] Event 'close': Disconnected from test server. Code: ${code}, Reason: ${reasonString}`));
        });
    });
}
