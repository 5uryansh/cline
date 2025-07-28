import * as http from "http"
import * as vscode from "vscode"
import { WebSocket, WebSocketServer } from "ws"
import * as path from "path"
import { execa } from "execa"
import { Logger } from "@services/logging/Logger"
import { WebviewProvider } from "@core/webview"
import { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import chalk from "chalk"
import { TaskServiceClient } from "webview-ui/src/services/grpc-client"
import { validateWorkspacePath, initializeGitRepository, getFileChanges, calculateToolSuccessRate } from "./GitHelper"
import {
	updateGlobalState,
	getAllExtensionState,
	updateApiConfiguration,
	storeSecret,
	updateWorkspaceState,
} from "@core/storage/state"
import { ClineAsk, ExtensionMessage } from "@shared/ExtensionMessage"
import { ApiProvider } from "@shared/api"
import { SecretKey } from "@core/storage/state-keys"
import { HistoryItem } from "@shared/HistoryItem"
import { getSavedClineMessages, getSavedApiConversationHistory } from "@core/storage/disk"
import { AskResponseRequest } from "@/shared/proto/task"
import { getCwd } from "@/utils/path"

/**
 * Creates a tracker to monitor tool calls and failures during task execution
 * @param webviewProvider The webview provider instance
 * @returns Object tracking tool calls and failures
 */
function createToolCallTracker(webviewProvider: WebviewProvider): {
	toolCalls: Record<string, number>
	toolFailures: Record<string, number>
} {
	const tracker = {
		toolCalls: {} as Record<string, number>,
		toolFailures: {} as Record<string, number>,
	}

	// Intercept messages to track tool usage
	const originalPostMessageToWebview = webviewProvider.controller.postMessageToWebview
	webviewProvider.controller.postMessageToWebview = async (message: ExtensionMessage) => {
		// NOTE: Tool tracking via partialMessage has been migrated to gRPC streaming
		// This interceptor is kept for potential future use with other message types

		// Track tool calls - commented out as partialMessage is now handled via gRPC
		// if (message.type === "partialMessage" && message.partialMessage?.say === "tool") {
		// 	const toolName = (message.partialMessage.text as any)?.tool
		// 	if (toolName) {
		// 		tracker.toolCalls[toolName] = (tracker.toolCalls[toolName] || 0) + 1
		// 	}
		// }

		// Track tool failures - commented out as partialMessage is now handled via gRPC
		// if (message.type === "partialMessage" && message.partialMessage?.say === "error") {
		// 	const errorText = message.partialMessage.text
		// 	if (errorText && errorText.includes("Error executing tool")) {
		// 		const match = errorText.match(/Error executing tool: (\w+)/)
		// 		if (match && match[1]) {
		// 			const toolName = match[1]
		// 			tracker.toolFailures[toolName] = (tracker.toolFailures[toolName] || 0) + 1
		// 		}
		// 	}
		// }

		return originalPostMessageToWebview.call(webviewProvider.controller, message)
	}

	return tracker
}

// Task completion tracking
let taskCompletionResolver: (() => void) | null = null

// Function to create a new task completion promise
function createTaskCompletionTracker(): Promise<void> {
	// Create a new promise that will resolve when the task is completed
	return new Promise<void>((resolve) => {
		taskCompletionResolver = resolve
	})
}

// Function to mark the current task as completed
function completeTask(): void {
	if (taskCompletionResolver) {
		taskCompletionResolver()
		taskCompletionResolver = null
		Logger.log("Task marked as completed")
	}
}

let server: http.Server | undefined
let wss: WebSocketServer | undefined
let clientSocket: WebSocket | undefined
let messageCatcherDisposable: vscode.Disposable | undefined
const activeTasks = new Map<string, any>()

/**
 * Updates the auto approval settings to enable all actions
 * @param context The VSCode extension context
 * @param provider The webview provider instance
 */
async function updateAutoApprovalSettings(context: vscode.ExtensionContext, provider?: WebviewProvider) {
	try {
		const { autoApprovalSettings } = await getAllExtensionState(context)

		// Enable all actions
		const updatedSettings: AutoApprovalSettings = {
			...autoApprovalSettings,
			enabled: true,
			actions: {
				readFiles: true,
				readFilesExternally: true,
				editFiles: true,
				editFilesExternally: true,
				executeSafeCommands: true,
				executeAllCommands: true,
				useBrowser: true,
				useMcp: true,
			},
			maxRequests: 10000, // Increase max requests for tests
		}

		await updateGlobalState(context, "autoApprovalSettings", updatedSettings)
		Logger.log("Auto approval settings updated for test mode")

		// Update the webview with the new state
		if (provider?.controller) {
			await provider.controller.postStateToWebview()
		}
	} catch (error) {
		Logger.log(`Error updating auto approval settings: ${error}`)
	}
}

/**
 * Creates and starts a WebSocket server for test automation.
 * This server allows for bidirectional communication with a test runner.
 * @param webviewProvider The webview provider instance to use for message catching.
 * @returns The created HTTP server instance.
 */
export function createTestServer(webviewProvider?: WebviewProvider): http.Server {
	// Try to show the Cline sidebar
	Logger.log("[createTestServer] Opening Cline in sidebar...")
	vscode.commands.executeCommand("workbench.view.claude-dev-ActivityBar")

	// Then ensure the webview is focused/loaded
	vscode.commands.executeCommand("claude-dev.SidebarProvider.focus")

	// Update auto approval settings if webviewProvider is available
	if (webviewProvider?.controller?.context) {
		updateAutoApprovalSettings(webviewProvider.controller.context, webviewProvider)
	}
	const PORT = 9876

	server = http.createServer((req, res) => {
		res.writeHead(404, { "Content-Type": "text/plain" })
		res.end("Not Found")
	})

	wss = new WebSocketServer({ server })

	wss.on("connection", (ws) => {
		Logger.log(chalk.green("[TestServer.ts] Test runner connected."))
		clientSocket = ws

		ws.on("message", async (message) => {
			try {
				const data = JSON.parse(message.toString())
				const { type, payload } = data

				if (type === "startTask") {
					await handleStartTask(payload)
				} else if (type === "askResponse") {
					await handleAskResponse(payload)
				} else if (type === "followUp") {
					await handleFollowUp(payload)
				} else if (type === "shutdown") {
					shutdownTestServer()
				}
			} catch (error) {
				Logger.log(`Error processing message: ${error}`)
				if (clientSocket) {
					clientSocket.send(JSON.stringify({ type: "error", payload: { message: `Invalid message format: ${error}` } }))
				}
			}
		})

		ws.on("close", () => {
			Logger.log(chalk.yellow("[TestServer.ts] Test runner disconnected."))
			clientSocket = undefined
		})
	})

	server.listen(PORT, () => {
		Logger.log(chalk.green(`[TestServer.ts] Test server listening on port ${PORT}`))
	})

	// Set up message catcher for the provided webview instance or try to get the visible one
	if (webviewProvider) {
		messageCatcherDisposable = createMessageCatcher(webviewProvider)
	} else {
		const visibleWebview = WebviewProvider.getVisibleInstance()
		if (visibleWebview) {
			messageCatcherDisposable = createMessageCatcher(visibleWebview)
		} else {
			Logger.log("No visible webview instance found for message catcher")
		}
	}

	return server
}

/**
 * Creates a message catcher that logs all messages sent to the webview
 * and automatically responds to messages that require user intervention
 * @param webviewProvider The webview provider instance
 * @returns A disposable that can be used to clean up the message catcher
 */
export function createMessageCatcher(webviewProvider: WebviewProvider): vscode.Disposable {
	Logger.log("Cline message catcher registered")

	if (webviewProvider && webviewProvider.controller) {
		const originalPostMessageToWebview = webviewProvider.controller.postMessageToWebview

		// Intercept outgoing messages from extension to webview
		webviewProvider.controller.postMessageToWebview = async (message: ExtensionMessage) => {
			// This interceptor is now a no-op, as all relevant events are
			// intercepted in the GrpcHandler to support the test runner.
			// We keep the structure in case we need to intercept other message types in the future.
			return originalPostMessageToWebview.call(webviewProvider.controller, message)
		}
	} else {
		Logger.log("No visible webview instance found for message catcher")
	}

	return new vscode.Disposable(() => {
		// Cleanup function if needed
		Logger.log("Cline message catcher disposed")
	})
}

/**
 * Shuts down the test server if it exists
 */
export function shutdownTestServer() {
	if (server) {
		server.close(() => {
			Logger.log("Test server shut down.")
		})
		server = undefined
		wss = undefined
	}

	// Dispose of the message catcher if it exists
	if (messageCatcherDisposable) {
		messageCatcherDisposable.dispose()
		messageCatcherDisposable = undefined
	}
}

/**
 * Returns the currently connected WebSocket client socket.
 * @returns The WebSocket client, or undefined if no client is connected.
 */
export function getTestClientSocket(): WebSocket | undefined {
	return clientSocket
}

async function handleStartTask(payload: any) {
	const { task, apiKey, model, provider } = payload

	if (!task) {
		if (clientSocket) {
			clientSocket.send(JSON.stringify({ type: "error", payload: { message: "Missing task parameter" } }))
		}
		return
	}

	const visibleWebview = WebviewProvider.getVisibleInstance()
	if (!visibleWebview || !visibleWebview.controller) {
		if (clientSocket) {
			clientSocket.send(JSON.stringify({ type: "error", payload: { message: "No active Cline instance found" } }))
		}
		return
	}

	Logger.log(`Test server initiating task: ${task}`)

	try {
		const workspacePath = await getCwd()
		await validateWorkspacePath(workspacePath)
		// await initializeGitRepository(workspacePath)
		await visibleWebview.controller.clearTask()

		if (apiKey && model && provider) {
			Logger.log(`Updating API configuration for provider: ${provider}, model: ${model}`)
			const typedProvider = provider as ApiProvider
			const providerToSecretKey: Partial<Record<ApiProvider, SecretKey>> = {
				anthropic: "apiKey",
				openrouter: "openRouterApiKey",
				openai: "openAiApiKey",
				gemini: "geminiApiKey",
				"openai-native": "openAiNativeApiKey",
				deepseek: "deepSeekApiKey",
				requesty: "requestyApiKey",
				together: "togetherApiKey",
				fireworks: "fireworksApiKey",
				qwen: "qwenApiKey",
				doubao: "doubaoApiKey",
				mistral: "mistralApiKey",
				litellm: "liteLlmApiKey",
				asksage: "asksageApiKey",
				xai: "xaiApiKey",
				moonshot: "moonshotApiKey",
				huggingface: "huggingFaceApiKey",
				nebius: "nebiusApiKey",
				sambanova: "sambanovaApiKey",
				cerebras: "cerebrasApiKey",
				groq: "groqApiKey",
				bedrock: "awsBedrockApiKey",
				cline: "clineAccountId",
			}
			const secretKey = providerToSecretKey[typedProvider]
			if (secretKey) {
				await storeSecret(visibleWebview.controller.context, secretKey, apiKey)
				await updateGlobalState(visibleWebview.controller.context, "planModeApiProvider", typedProvider)
				await updateGlobalState(visibleWebview.controller.context, "actModeApiProvider", typedProvider)
				await updateGlobalState(visibleWebview.controller.context, "planModeApiModelId", model)
				await updateGlobalState(visibleWebview.controller.context, "actModeApiModelId", model)
				await visibleWebview.controller.postStateToWebview()
				Logger.log("API configuration updated successfully.")
			} else {
				Logger.log(
					`Provider "${typedProvider}" does not have a corresponding secret key defined. Skipping config update.`,
				)
			}
		} else {
			Logger.log("Credentials not provided, using existing configuration.")
		}

		const { chatSettings } = await visibleWebview.controller.getStateToPostToWebview()
		if (chatSettings.mode === "plan") {
			await visibleWebview.controller.togglePlanActModeWithChatSettings({ mode: "act" })
		}

		const taskId = await visibleWebview.controller.initTask(task)

		Logger.log(`Task initiated with ID: ${taskId}`)
		if (clientSocket) {
			clientSocket.send(JSON.stringify({ type: "taskStarted", payload: { taskId } }))
		}
	} catch (error) {
		Logger.log(`Error initiating task: ${error}`)
		if (clientSocket) {
			clientSocket.send(JSON.stringify({ type: "error", payload: { message: `Failed to initiate task: ${error}` } }))
		}
	}
}

async function handleAskResponse(payload: any) {
	const { responseType, text, images } = payload
	try {
		await TaskServiceClient.askResponse(
			AskResponseRequest.create({
				responseType,
				text,
				images,
			}),
		)
		Logger.log(`Forwarded askResponse to Cline: ${responseType}`)
	} catch (error) {
		Logger.log(`Error forwarding askResponse: ${error}`)
	}
}

async function handleFollowUp(payload: any) {
	const { task, taskId } = payload
	if (!taskId) {
		if (clientSocket) {
			clientSocket.send(JSON.stringify({ type: "error", payload: { message: "Missing taskId in followUp message" } }))
		}
		return
	}

	const visibleWebview = WebviewProvider.getVisibleInstance()
	if (!visibleWebview || !visibleWebview.controller) {
		if (clientSocket) {
			clientSocket.send(
				JSON.stringify({ type: "error", payload: { message: "No active Cline instance found for follow-up." } }),
			)
		}
		return
	}

	Logger.log(`Continuing task ${taskId} with follow-up: ${task}`)
	await visibleWebview.controller.followUpTask(task)
}
