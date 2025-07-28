import WebSocket from "ws";
import chalk from "chalk";

/**
 * This is an example of an interactive runner that connects to the Cline test server
 * and programmatically handles interactive events like tool approvals and follow-up questions.
 */
async function runInteractiveEvaluation() {
    const SERVER_URL = "ws://localhost:9876";
    const ws = new WebSocket(SERVER_URL);

    ws.on("open", () => {
        console.log(chalk.green("Connected to the interactive test server."));

        // Define the task you want to run
        const taskPayload = {
            task: "Read the file 'evals/custom-runner/run.ts' and tell me what it does.",
            // Add your API key, model, and provider here if needed
            // apiKey: "YOUR_API_KEY",
            // model: "claude-3-opus-20240229",
            // provider: "anthropic",
        };

        // Send the initial task to the server
        ws.send(JSON.stringify({ type: "startTask", payload: taskPayload }));
    });

    ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        const { type, payload } = message;

        switch (type) {
            case "taskStarted":
                console.log(chalk.blue(`Task started with ID: ${payload.taskId}`));
                break;

            case "ask":
                console.log(chalk.yellow(`Received ask from Cline: ${payload.askType}`));
                handleAsk(ws, payload.askType, payload.askText);
                break;

            case "completion_result":
                console.log(chalk.green("Task completed successfully!"));
                console.log(chalk.cyan("Final Result:"), payload);
                ws.close();
                process.exit(0);
                break;

            case "error":
                console.error(chalk.red(`Server error: ${payload.message}`));
                ws.close();
                process.exit(1);
                break;
        }
    });

    ws.on("error", (error) => {
        console.error(chalk.red(`WebSocket error: ${error.message}`));
        process.exit(1);
    });

    ws.on("close", () => {
        console.log(chalk.gray("Disconnected from the test server."));
    });
}

/**
 * Handles different types of "ask" events from Cline.
 * This is where you can implement your custom logic for responding to prompts.
 * @param ws The WebSocket connection
 * @param askType The type of question being asked
 * @param askText The text of the question
 */
function handleAsk(ws: WebSocket, askType: string, askText: string) {
    let responsePayload;

    switch (askType) {
        case "tool":
        case "command":
        case "browser_action_launch":
            // Automatically approve any tool usage, command execution, or browser launch
            console.log(chalk.green(`Approving ${askType}: ${askText}`));
            responsePayload = {
                responseType: "yesButtonClicked",
                text: "Approve",
            };
            break;

        case "followup":
            // Provide a default response to any follow-up questions
            console.log(chalk.blue(`Answering followup: "${askText}"`));
            responsePayload = {
                responseType: "messageResponse",
                text: "Please proceed based on your best judgment.",
            };
            break;

        default:
            // For any other type of ask, default to a simple approval
            console.log(chalk.gray(`Default approval for ask type: ${askType}`));
            responsePayload = {
                responseType: "yesButtonClicked",
                text: "Continue",
            };
            break;
    }

    // Send the response back to the server
    ws.send(JSON.stringify({ type: "askResponse", payload: responsePayload }));
}

// Run the interactive evaluation
runInteractiveEvaluation();
