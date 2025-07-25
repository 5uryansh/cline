import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandler, buildApiHandler } from "@api/index"
import { AnthropicHandler } from "@api/providers/anthropic"
import { ClineHandler } from "@api/providers/cline"
import { OpenRouterHandler } from "@api/providers/openrouter"
import { ApiStream } from "@api/transform/stream"
import { DIFF_VIEW_URI_SCHEME } from "@hosts/vscode/VscodeDiffViewProvider"
import CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { formatContentBlockToMarkdown } from "@integrations/misc/export-markdown"
import { showSystemNotification } from "@integrations/notifications"
import { TerminalManager } from "@integrations/terminal/TerminalManager"
import { BrowserSession } from "@services/browser/BrowserSession"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { listFiles } from "@services/glob/list-files"
import { LoggerService } from "@services/logging/LoggerService"
import { telemetryService } from "@services/posthog/telemetry/TelemetryService"
import { ApiConfiguration } from "@shared/api"
import { findLast, findLastIndex } from "@shared/array"
import { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { BrowserSettings } from "@shared/BrowserSettings"
import { ChatSettings } from "@shared/ChatSettings"
import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { ClineApiReqCancelReason, ClineApiReqInfo, ClineAsk, ClineMessage, ClineSay } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { HistoryItem } from "@shared/HistoryItem"
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, LanguageDisplay } from "@shared/Languages"
import { ClineAskResponse, ClineCheckpointRestore } from "@shared/WebviewMessage"
import { getGitRemoteUrls } from "@utils/git"
import { arePathsEqual, getDesktopDir } from "@utils/path"
import cloneDeep from "clone-deep"
import { execa } from "execa"
import fs from "fs/promises"
import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import pTimeout from "p-timeout"
import pWaitFor from "p-wait-for"
import * as path from "path"
import * as vscode from "vscode"

import { HostProvider } from "@/hosts/host-provider"
import { ClineErrorType } from "@/services/error/ClineError"
import { ErrorService } from "@/services/error/ErrorService"
import { parseAssistantMessageV2, parseAssistantMessageV3, ToolUseName } from "@core/assistant-message"
import {
	checkIsAnthropicContextWindowError,
	checkIsOpenRouterContextWindowError,
} from "@core/context/context-management/context-error-handling"
import { getContextWindowInfo } from "@core/context/context-management/context-window-utils"
import { ContextManager } from "@core/context/context-management/ContextManager"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { ModelContextTracker } from "@core/context/context-tracking/ModelContextTracker"
import {
	getGlobalClineRules,
	getLocalClineRules,
	refreshClineRulesToggles,
} from "@core/context/instructions/user-instructions/cline-rules"
import {
	getLocalCursorRules,
	getLocalWindsurfRules,
	refreshExternalRulesToggles,
} from "@core/context/instructions/user-instructions/external-rules"
import { Controller } from "@core/controller"
import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"
import { sendRelinquishControlEvent } from "@core/controller/ui/subscribeToRelinquishControl"
import { ClineIgnoreController } from "@core/ignore/ClineIgnoreController"
import { parseMentions } from "@core/mentions"
import { formatResponse } from "@core/prompts/responses"
import { addUserInstructions, SYSTEM_PROMPT } from "@core/prompts/system"
import { parseSlashCommands } from "@core/slash-commands"
import {
	ensureRulesDirectoryExists,
	ensureTaskDirectoryExists,
	getSavedApiConversationHistory,
	getSavedClineMessages,
	GlobalFileNames,
} from "@core/storage/disk"
import { getGlobalState } from "@core/storage/state"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import WorkspaceTracker from "@integrations/workspace/WorkspaceTracker"
import { McpHub } from "@services/mcp/McpHub"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { isClaude4ModelFamily, isGemini2dot5ModelFamily } from "@utils/model-utils"
import { isInTestMode } from "../../services/test/TestMode"
import { ensureLocalClineDirExists } from "../context/instructions/user-instructions/rule-helpers"
import { refreshWorkflowToggles } from "../context/instructions/user-instructions/workflows"
import { MessageStateHandler } from "./message-state"
import { TaskState } from "./TaskState"
import { ToolExecutor } from "./ToolExecutor"
import { updateApiReqMsg } from "./utils"
export const USE_EXPERIMENTAL_CLAUDE4_FEATURES = false

export type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>
type UserContent = Array<Anthropic.ContentBlockParam>

export class Task {
	// Core task variables
	readonly taskId: string
	private taskIsFavorited?: boolean
	private cwd: string

	taskState: TaskState

	// Task configuration
	private enableCheckpoints: boolean

	// Core dependencies
	private context: vscode.ExtensionContext
	private mcpHub: McpHub
	private workspaceTracker: WorkspaceTracker
	private controller: Controller

	// Service handlers
	api: ApiHandler
	terminalManager: TerminalManager
	private urlContentFetcher: UrlContentFetcher
	browserSession: BrowserSession
	contextManager: ContextManager
	private diffViewProvider: DiffViewProvider
	private checkpointTracker?: CheckpointTracker
	private clineIgnoreController: ClineIgnoreController
	private toolExecutor: ToolExecutor

	// Metadata tracking
	private fileContextTracker: FileContextTracker
	private modelContextTracker: ModelContextTracker

	// Callbacks
	private updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	private postStateToWebview: () => Promise<void>
	private reinitExistingTaskFromId: (taskId: string) => Promise<void>
	private cancelTask: () => Promise<void>

	// User chat state
	autoApprovalSettings: AutoApprovalSettings
	browserSettings: BrowserSettings
	chatSettings: ChatSettings

	// Message and conversation state
	messageStateHandler: MessageStateHandler
	logger: LoggerService
	constructor(
		controller: Controller,
		context: vscode.ExtensionContext,
		mcpHub: McpHub,
		workspaceTracker: WorkspaceTracker,
		updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>,
		postStateToWebview: () => Promise<void>,
		reinitExistingTaskFromId: (taskId: string) => Promise<void>,
		cancelTask: () => Promise<void>,
		apiConfiguration: ApiConfiguration,
		autoApprovalSettings: AutoApprovalSettings,
		browserSettings: BrowserSettings,
		chatSettings: ChatSettings,
		shellIntegrationTimeout: number,
		terminalReuseEnabled: boolean,
		terminalOutputLineLimit: number,
		defaultTerminalProfile: string,
		enableCheckpointsSetting: boolean,
		cwd: string,
		task?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
	) {
		this.taskState = new TaskState()
		this.controller = controller
		this.context = context
		this.mcpHub = mcpHub
		this.workspaceTracker = workspaceTracker
		this.updateTaskHistory = updateTaskHistory
		this.postStateToWebview = postStateToWebview
		this.reinitExistingTaskFromId = reinitExistingTaskFromId
		this.cancelTask = cancelTask
		this.clineIgnoreController = new ClineIgnoreController(cwd)

		if ((global as any).standaloneTerminalManager) {
			console.log("[DEBUG] Using vscode-impls.js terminal manager")
			this.terminalManager = (global as any).standaloneTerminalManager
		} else {
			console.log("[DEBUG] Using built in terminal manager")
			this.terminalManager = new TerminalManager()
		}
		this.terminalManager.setShellIntegrationTimeout(shellIntegrationTimeout)
		this.terminalManager.setTerminalReuseEnabled(terminalReuseEnabled ?? true)
		this.terminalManager.setTerminalOutputLineLimit(terminalOutputLineLimit)
		this.terminalManager.setDefaultTerminalProfile(defaultTerminalProfile)

		this.urlContentFetcher = new UrlContentFetcher(context)
		this.browserSession = new BrowserSession(context, browserSettings)
		this.contextManager = new ContextManager()
		this.diffViewProvider = HostProvider.get().createDiffViewProvider()
		this.autoApprovalSettings = autoApprovalSettings
		this.browserSettings = browserSettings
		this.chatSettings = chatSettings
		this.enableCheckpoints = enableCheckpointsSetting
		this.cwd = cwd
		this.logger = controller.logger

		this.mcpHub.setNotificationCallback(async (serverName: string, level: string, message: string) => {
			await this.say("mcp_notification", `[${serverName}] ${message}`)
		})

		if (historyItem) {
			this.taskId = historyItem.id
			this.taskIsFavorited = historyItem.isFavorited
			this.taskState.conversationHistoryDeletedRange = historyItem.conversationHistoryDeletedRange
			if (historyItem.checkpointTrackerErrorMessage) {
				this.taskState.checkpointTrackerErrorMessage = historyItem.checkpointTrackerErrorMessage
			}
		} else if (task || images || files) {
			this.taskId = Date.now().toString()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		this.messageStateHandler = new MessageStateHandler({
			context,
			taskId: this.taskId,
			taskState: this.taskState,
			taskIsFavorited: this.taskIsFavorited,
			updateTaskHistory: this.updateTaskHistory,
		})

		this.fileContextTracker = new FileContextTracker(context, this.taskId)
		this.modelContextTracker = new ModelContextTracker(context, this.taskId)

		let effectiveApiConfiguration: ApiConfiguration = {
			...apiConfiguration,
			taskId: this.taskId,
			onRetryAttempt: async (attempt: number, maxRetries: number, delay: number, error: any) => {
				const clineMessages = this.messageStateHandler.getClineMessages()
				const lastApiReqStartedIndex = findLastIndex(clineMessages, (m) => m.say === "api_req_started")
				if (lastApiReqStartedIndex !== -1) {
					try {
						const currentApiReqInfo: ClineApiReqInfo = JSON.parse(clineMessages[lastApiReqStartedIndex].text || "{}")
						currentApiReqInfo.retryStatus = {
							attempt: attempt,
							maxAttempts: maxRetries,
							delaySec: Math.round(delay / 1000),
							errorSnippet: error?.message ? `${String(error.message).substring(0, 50)}...` : undefined,
						}
						delete currentApiReqInfo.cancelReason
						delete currentApiReqInfo.streamingFailedMessage
						await this.messageStateHandler.updateClineMessage(lastApiReqStartedIndex, {
							text: JSON.stringify(currentApiReqInfo),
						})

						await this.postStateToWebview().catch((e) =>
							console.error("Error posting state to webview in onRetryAttempt:", e),
						)

						console.log(
							`[Task ${this.taskId}] API Auto-Retry Status Update: Attempt ${attempt}/${maxRetries}, Delay: ${delay}ms`,
						)
					} catch (e) {
						console.error(`[Task ${this.taskId}] Error updating api_req_started with retryStatus:`, e)
					}
				}
			},
		}

		const currentProvider =
			chatSettings.mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider

		if (currentProvider === "openai" || currentProvider === "openai-native") {
			if (chatSettings.mode === "plan") {
				effectiveApiConfiguration.planModeReasoningEffort = chatSettings.openAIReasoningEffort
			} else {
				effectiveApiConfiguration.actModeReasoningEffort = chatSettings.openAIReasoningEffort
			}
		}

		this.api = buildApiHandler(effectiveApiConfiguration, chatSettings.mode)

		this.browserSession.setTaskId(this.taskId)

		if (historyItem) {
			this.resumeTaskFromHistory()
		} else if (task || images || files) {
			this.startTask(task, images, files)
		}

		if (historyItem) {
			telemetryService.captureTaskRestarted(this.taskId, currentProvider)
		} else {
			telemetryService.captureTaskCreated(this.taskId, currentProvider)
		}

		this.toolExecutor = new ToolExecutor(
			this.context,
			this.taskState,
			this.messageStateHandler,
			this.api,
			this.urlContentFetcher,
			this.browserSession,
			this.diffViewProvider,
			this.mcpHub,
			this.fileContextTracker,
			this.clineIgnoreController,
			this.workspaceTracker,
			this.contextManager,
			this.autoApprovalSettings,
			this.browserSettings,
			cwd,
			this.taskId,
			this.chatSettings,
			this.say.bind(this),
			this.ask.bind(this),
			this.saveCheckpoint.bind(this),
			this.sayAndCreateMissingParamError.bind(this),
			this.removeLastPartialMessageIfExistsWithType.bind(this),
			this.executeCommandTool.bind(this),
			this.doesLatestTaskCompletionHaveNewChanges.bind(this),
		)
	}

	private getContext(): vscode.ExtensionContext {
		const context = this.context
		if (!context) {
			throw new Error("Unable to access extension context")
		}
		return context
	}

	public updateAutoApprovalSettings(settings: AutoApprovalSettings): void {
		const maxRequestsChanged = this.autoApprovalSettings.maxRequests !== settings.maxRequests

		this.autoApprovalSettings = settings
		this.toolExecutor.updateAutoApprovalSettings(settings)

		if (maxRequestsChanged) {
			this.taskState.consecutiveAutoApprovedRequestsCount = 0
		}
	}

	async restoreCheckpoint(messageTs: number, restoreType: ClineCheckpointRestore, offset?: number) {
		const clineMessages = this.messageStateHandler.getClineMessages()
		const messageIndex = clineMessages.findIndex((m) => m.ts === messageTs) - (offset || 0)
		const lastHashIndex = findLastIndex(clineMessages.slice(0, messageIndex), (m) => m.lastCheckpointHash !== undefined)
		const message = clineMessages[messageIndex]
		const lastMessageWithHash = clineMessages[lastHashIndex]

		if (!message) {
			console.error("Message not found", clineMessages)
			return
		}

		let didWorkspaceRestoreFail = false

		switch (restoreType) {
			case "task":
				break
			case "taskAndWorkspace":
			case "workspace":
				if (!this.enableCheckpoints) {
					vscode.window.showErrorMessage("Checkpoints are disabled in settings.")
					didWorkspaceRestoreFail = true
					break
				}

				if (!this.checkpointTracker && !this.taskState.checkpointTrackerErrorMessage) {
					try {
						this.checkpointTracker = await CheckpointTracker.create(
							this.taskId,
							this.context.globalStorageUri.fsPath,
							this.enableCheckpoints,
						)
						this.messageStateHandler.setCheckpointTracker(this.checkpointTracker)
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : "Unknown error"
						console.error("Failed to initialize checkpoint tracker:", errorMessage)
						this.taskState.checkpointTrackerErrorMessage = errorMessage
						await this.postStateToWebview()
						vscode.window.showErrorMessage(errorMessage)
						didWorkspaceRestoreFail = true
					}
				}
				if (message.lastCheckpointHash && this.checkpointTracker) {
					try {
						await this.checkpointTracker.resetHead(message.lastCheckpointHash)
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : "Unknown error"
						vscode.window.showErrorMessage("Failed to restore checkpoint: " + errorMessage)
						didWorkspaceRestoreFail = true
					}
				} else if (offset && lastMessageWithHash.lastCheckpointHash && this.checkpointTracker) {
					try {
						await this.checkpointTracker.resetHead(lastMessageWithHash.lastCheckpointHash)
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : "Unknown error"
						vscode.window.showErrorMessage("Failed to restore offsetcheckpoint: " + errorMessage)
						didWorkspaceRestoreFail = true
					}
				} else if (!offset && lastMessageWithHash.lastCheckpointHash && this.checkpointTracker) {
					console.warn(`Message ${messageTs} has no checkpoint hash, falling back to previous checkpoint`)
					try {
						await this.checkpointTracker.resetHead(lastMessageWithHash.lastCheckpointHash)
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : "Unknown error"
						vscode.window.showErrorMessage("Failed to restore checkpoint: " + errorMessage)
						didWorkspaceRestoreFail = true
					}
				} else {
					vscode.window.showErrorMessage("Failed to restore checkpoint")
				}
				break
		}

		if (!didWorkspaceRestoreFail) {
			switch (restoreType) {
				case "task":
				case "taskAndWorkspace":
					this.taskState.conversationHistoryDeletedRange = message.conversationHistoryDeletedRange
					const apiConversationHistory = this.messageStateHandler.getApiConversationHistory()
					const newConversationHistory = apiConversationHistory.slice(0, (message.conversationHistoryIndex || 0) + 2)
					await this.messageStateHandler.overwriteApiConversationHistory(newConversationHistory)

					await this.contextManager.truncateContextHistory(
						message.ts,
						await ensureTaskDirectoryExists(this.getContext(), this.taskId),
					)

					const clineMessages = this.messageStateHandler.getClineMessages()
					const deletedMessages = clineMessages.slice(messageIndex + 1)
					const deletedApiReqsMetrics = getApiMetrics(combineApiRequests(combineCommandSequences(deletedMessages)))

					if (restoreType === "task") {
						const filesEditedAfterMessage = await this.fileContextTracker.detectFilesEditedAfterMessage(
							messageTs,
							deletedMessages,
						)
						if (filesEditedAfterMessage.length > 0) {
							await this.fileContextTracker.storePendingFileContextWarning(filesEditedAfterMessage)
						}
					}

					const newClineMessages = clineMessages.slice(0, messageIndex + 1)
					await this.messageStateHandler.overwriteClineMessages(newClineMessages)

					await this.say(
						"deleted_api_reqs",
						JSON.stringify({
							tokensIn: deletedApiReqsMetrics.totalTokensIn,
							tokensOut: deletedApiReqsMetrics.totalTokensOut,
							cacheWrites: deletedApiReqsMetrics.totalCacheWrites,
							cacheReads: deletedApiReqsMetrics.totalCacheReads,
							cost: deletedApiReqsMetrics.totalCost,
						} satisfies ClineApiReqInfo),
					)
					break
				case "workspace":
					break
			}

			switch (restoreType) {
				case "task":
					vscode.window.showInformationMessage("Task messages have been restored to the checkpoint")
					break
				case "workspace":
					vscode.window.showInformationMessage("Workspace files have been restored to the checkpoint")
					break
				case "taskAndWorkspace":
					vscode.window.showInformationMessage("Task and workspace have been restored to the checkpoint")
					break
			}

			if (restoreType !== "task") {
				const checkpointMessages = this.messageStateHandler
					.getClineMessages()
					.filter((m) => m.say === "checkpoint_created")
				const currentMessageIndex = checkpointMessages.findIndex((m) => m.ts === messageTs)

				checkpointMessages.forEach((m, i) => {
					m.isCheckpointCheckedOut = i === currentMessageIndex
				})
			}

			await this.messageStateHandler.saveClineMessagesAndUpdateHistory()

			this.cancelTask()
		} else {
			sendRelinquishControlEvent()
		}
	}

	async presentMultifileDiff(messageTs: number, seeNewChangesSinceLastTaskCompletion: boolean) {
		const relinquishButton = () => {
			sendRelinquishControlEvent()
		}
		if (!this.enableCheckpoints) {
			vscode.window.showInformationMessage("Checkpoints are disabled in settings. Cannot show diff.")
			relinquishButton()
			return
		}

		console.log("presentMultifileDiff", messageTs)
		const clineMessages = this.messageStateHandler.getClineMessages()
		const messageIndex = clineMessages.findIndex((m) => m.ts === messageTs)
		const message = clineMessages[messageIndex]
		if (!message) {
			console.error("Message not found")
			relinquishButton()
			return
		}
		const hash = message.lastCheckpointHash
		if (!hash) {
			console.error("No checkpoint hash found")
			relinquishButton()
			return
		}

		if (!this.checkpointTracker && this.enableCheckpoints && !this.taskState.checkpointTrackerErrorMessage) {
			try {
				this.checkpointTracker = await CheckpointTracker.create(
					this.taskId,
					this.context.globalStorageUri.fsPath,
					this.enableCheckpoints,
				)
				this.messageStateHandler.setCheckpointTracker(this.checkpointTracker)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error"
				console.error("Failed to initialize checkpoint tracker:", errorMessage)
				this.taskState.checkpointTrackerErrorMessage = errorMessage
				await this.postStateToWebview()
				vscode.window.showErrorMessage(errorMessage)
				relinquishButton()
				return
			}
		}

		let changedFiles:
			| {
					relativePath: string
					absolutePath: string
					before: string
					after: string
			  }[]
			| undefined

		try {
			if (seeNewChangesSinceLastTaskCompletion) {
				const lastTaskCompletedMessageCheckpointHash = findLast(
					this.messageStateHandler.getClineMessages().slice(0, messageIndex),
					(m) => m.say === "completion_result",
				)?.lastCheckpointHash

				const firstCheckpointMessageCheckpointHash = this.messageStateHandler
					.getClineMessages()
					.find((m) => m.say === "checkpoint_created")?.lastCheckpointHash

				const previousCheckpointHash = lastTaskCompletedMessageCheckpointHash || firstCheckpointMessageCheckpointHash

				if (!previousCheckpointHash) {
					vscode.window.showErrorMessage("Unexpected error: No checkpoint hash found")
					relinquishButton()
					return
				}

				changedFiles = await this.checkpointTracker?.getDiffSet(previousCheckpointHash, hash)
				if (!changedFiles?.length) {
					vscode.window.showInformationMessage("No changes found")
					relinquishButton()
					return
				}
			} else {
				changedFiles = await this.checkpointTracker?.getDiffSet(hash)
				if (!changedFiles?.length) {
					vscode.window.showInformationMessage("No changes found")
					relinquishButton()
					return
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			vscode.window.showErrorMessage("Failed to retrieve diff set: " + errorMessage)
			relinquishButton()
			return
		}

		await vscode.commands.executeCommand(
			"vscode.changes",
			seeNewChangesSinceLastTaskCompletion ? "New changes" : "Changes since snapshot",
			changedFiles.map((file) => [
				vscode.Uri.file(file.absolutePath),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${file.relativePath}`).with({
					query: Buffer.from(file.before ?? "").toString("base64"),
				}),
				vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${file.relativePath}`).with({
					query: Buffer.from(file.after ?? "").toString("base64"),
				}),
			]),
		)
		relinquishButton()
	}

	async doesLatestTaskCompletionHaveNewChanges() {
		if (!this.enableCheckpoints) {
			return false
		}

		const clineMessages = this.messageStateHandler.getClineMessages()
		const messageIndex = findLastIndex(clineMessages, (m) => m.say === "completion_result")
		const message = clineMessages[messageIndex]
		if (!message) {
			console.error("Completion message not found")
			return false
		}
		const hash = message.lastCheckpointHash
		if (!hash) {
			console.error("No checkpoint hash found")
			return false
		}

		if (this.enableCheckpoints && !this.checkpointTracker && !this.taskState.checkpointTrackerErrorMessage) {
			try {
				this.checkpointTracker = await CheckpointTracker.create(
					this.taskId,
					this.context.globalStorageUri.fsPath,
					this.enableCheckpoints,
				)
				this.messageStateHandler.setCheckpointTracker(this.checkpointTracker)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error"
				console.error("Failed to initialize checkpoint tracker:", errorMessage)
				return false
			}
		}

		const lastTaskCompletedMessage = findLast(
			this.messageStateHandler.getClineMessages().slice(0, messageIndex),
			(m) => m.say === "completion_result",
		)

		try {
			const lastTaskCompletedMessageCheckpointHash = lastTaskCompletedMessage?.lastCheckpointHash

			const firstCheckpointMessageCheckpointHash = this.messageStateHandler
				.getClineMessages()
				.find((m) => m.say === "checkpoint_created")?.lastCheckpointHash

			const previousCheckpointHash = lastTaskCompletedMessageCheckpointHash || firstCheckpointMessageCheckpointHash

			if (!previousCheckpointHash) {
				return false
			}

			const changedFilesCount = (await this.checkpointTracker?.getDiffCount(previousCheckpointHash, hash)) || 0
			if (changedFilesCount > 0) {
				return true
			}
		} catch (error) {
			console.error("Failed to get diff set:", error)
			return false
		}

		return false
	}

	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
	): Promise<{
		response: ClineAskResponse
		text?: string
		images?: string[]
		files?: string[]
	}> {
		if (this.taskState.abort) {
			throw new Error("Cline instance aborted")
		}
		let askTs: number
		if (partial !== undefined) {
			const clineMessages = this.messageStateHandler.getClineMessages()
			const lastMessage = clineMessages.at(-1)
			const lastMessageIndex = clineMessages.length - 1
			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type
			if (partial) {
				if (isUpdatingPreviousPartial) {
					await this.messageStateHandler.updateClineMessage(lastMessageIndex, {
						text,
						partial,
					})
					const protoMessage = convertClineMessageToProto(lastMessage)
					await sendPartialMessageEvent(protoMessage)
					throw new Error("Current ask promise was ignored 1")
				} else {
					askTs = Date.now()
					this.taskState.lastMessageTs = askTs
					await this.messageStateHandler.addToClineMessages({
						ts: askTs,
						type: "ask",
						ask: type,
						text,
						partial,
					})
					await this.postStateToWebview()
					throw new Error("Current ask promise was ignored 2")
				}
			} else {
				if (isUpdatingPreviousPartial) {
					this.taskState.askResponse = undefined
					this.taskState.askResponseText = undefined
					this.taskState.askResponseImages = undefined
					this.taskState.askResponseFiles = undefined

					askTs = lastMessage.ts
					this.taskState.lastMessageTs = askTs
					await this.messageStateHandler.updateClineMessage(lastMessageIndex, {
						text,
						partial: false,
					})
					const protoMessage = convertClineMessageToProto(lastMessage)
					await sendPartialMessageEvent(protoMessage)
				} else {
					this.taskState.askResponse = undefined
					this.taskState.askResponseText = undefined
					this.taskState.askResponseImages = undefined
					this.taskState.askResponseFiles = undefined
					askTs = Date.now()
					this.taskState.lastMessageTs = askTs
					await this.messageStateHandler.addToClineMessages({
						ts: askTs,
						type: "ask",
						ask: type,
						text,
					})
					await this.postStateToWebview()
				}
			}
		} else {
			this.taskState.askResponse = undefined
			this.taskState.askResponseText = undefined
			this.taskState.askResponseImages = undefined
			this.taskState.askResponseFiles = undefined
			askTs = Date.now()
			this.taskState.lastMessageTs = askTs
			await this.messageStateHandler.addToClineMessages({
				ts: askTs,
				type: "ask",
				ask: type,
				text,
			})
			await this.postStateToWebview()
		}

		await pWaitFor(() => this.taskState.askResponse !== undefined || this.taskState.lastMessageTs !== askTs, {
			interval: 100,
		})
		if (this.taskState.lastMessageTs !== askTs) {
			throw new Error("Current ask promise was ignored")
		}
		const result = {
			response: this.taskState.askResponse!,
			text: this.taskState.askResponseText,
			images: this.taskState.askResponseImages,
			files: this.taskState.askResponseFiles,
		}
		this.taskState.askResponse = undefined
		this.taskState.askResponseText = undefined
		this.taskState.askResponseImages = undefined
		this.taskState.askResponseFiles = undefined
		return result
	}

	async handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[], files?: string[]) {
		this.taskState.askResponse = askResponse
		this.taskState.askResponseText = text
		this.taskState.askResponseImages = images
		this.taskState.askResponseFiles = files
		if (text) {
			this.logMessage(text, "user")
		}
	}

	private logMessage(message: string, type: "user" | "assistant" | "system" | "error" | "terminal" = "system") {
		this.logger.logMessage(this.taskId, {
			conversationId: this.taskId,
			messageId: Date.now().toString(),
			messageType: type,
			content: message,
			metadata: {
				model: this.api.getModel().id,
			},
		})
	}

	async say(type: ClineSay, text?: string, images?: string[], files?: string[], partial?: boolean): Promise<undefined> {
		if (this.taskState.abort) {
			throw new Error("Cline instance aborted")
		}

		if (text && !partial) {
			this.logMessage(text, "assistant")
		}

		if (partial !== undefined) {
			const lastMessage = this.messageStateHandler.getClineMessages().at(-1)
			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type
			if (partial) {
				if (isUpdatingPreviousPartial) {
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.files = files
					lastMessage.partial = partial
					const protoMessage = convertClineMessageToProto(lastMessage)
					await sendPartialMessageEvent(protoMessage)
				} else {
					const sayTs = Date.now()
					this.taskState.lastMessageTs = sayTs
					await this.messageStateHandler.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						files,
						partial,
					})
					await this.postStateToWebview()
				}
			} else {
				if (isUpdatingPreviousPartial) {
					this.taskState.lastMessageTs = lastMessage.ts
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.files = files
					lastMessage.partial = false

					await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
					const protoMessage = convertClineMessageToProto(lastMessage)
					await sendPartialMessageEvent(protoMessage)
				} else {
					const sayTs = Date.now()
					this.taskState.lastMessageTs = sayTs
					await this.messageStateHandler.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						files,
					})
					await this.postStateToWebview()
				}
			}
		} else {
			const sayTs = Date.now()
			this.taskState.lastMessageTs = sayTs
			await this.messageStateHandler.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				files,
			})
			await this.postStateToWebview()
		}
	}

	async sayAndCreateMissingParamError(toolName: ToolUseName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Cline tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	async removeLastPartialMessageIfExistsWithType(type: "ask" | "say", askOrSay: ClineAsk | ClineSay) {
		const clineMessages = this.messageStateHandler.getClineMessages()
		const lastMessage = clineMessages.at(-1)
		if (lastMessage?.partial && lastMessage.type === type && (lastMessage.ask === askOrSay || lastMessage.say === askOrSay)) {
			this.messageStateHandler.setClineMessages(clineMessages.slice(0, -1))
			await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
		}
	}

	private async startTask(task?: string, images?: string[], files?: string[]): Promise<void> {
		try {
			await this.clineIgnoreController.initialize()
		} catch (error) {
			console.error("Failed to initialize ClineIgnoreController:", error)
		}
		this.messageStateHandler.setClineMessages([])
		this.messageStateHandler.setApiConversationHistory([])

		await this.postStateToWebview()

		await this.say("text", task, images, files)

		this.taskState.isInitialized = true

		let imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

		let userContent: UserContent = [
			{
				type: "text",
				text: `<task>\n${task}\n</task>`,
			},
			...imageBlocks,
		]

		if (files && files.length > 0) {
			const fileContentString = await processFilesIntoText(files)
			if (fileContentString) {
				userContent.push({
					type: "text",
					text: fileContentString,
				})
			}
		}

		await this.initiateTaskLoop(userContent)
	}

	private async resumeTaskFromHistory() {
		try {
			await this.clineIgnoreController.initialize()
		} catch (error) {
			console.error("Failed to initialize ClineIgnoreController:", error)
		}

		const savedClineMessages = await getSavedClineMessages(this.getContext(), this.taskId)

		const lastRelevantMessageIndex = findLastIndex(
			savedClineMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)
		if (lastRelevantMessageIndex !== -1) {
			savedClineMessages.splice(lastRelevantMessageIndex + 1)
		}

		const lastApiReqStartedIndex = findLastIndex(savedClineMessages, (m) => m.type === "say" && m.say === "api_req_started")
		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = savedClineMessages[lastApiReqStartedIndex]
			const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")
			if (cost === undefined && cancelReason === undefined) {
				savedClineMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		await this.messageStateHandler.overwriteClineMessages(savedClineMessages)
		this.messageStateHandler.setClineMessages(await getSavedClineMessages(this.getContext(), this.taskId))

		const context = this.getContext()
		const savedApiConversationHistory = await getSavedApiConversationHistory(context, this.taskId)
		this.messageStateHandler.setApiConversationHistory(savedApiConversationHistory)

		const taskDir = await ensureTaskDirectoryExists(context, this.taskId)
		await this.contextManager.initializeContextHistory(await ensureTaskDirectoryExists(this.getContext(), this.taskId))

		const lastClineMessage = this.messageStateHandler
			.getClineMessages()
			.slice()
			.reverse()
			.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"))

		let askType: ClineAsk
		if (lastClineMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		this.taskState.isInitialized = true

		const { response, text, images, files } = await this.ask(askType)
		let responseText: string | undefined
		let responseImages: string[] | undefined
		let responseFiles: string[] | undefined
		if (response === "messageResponse") {
			await this.say("user_feedback", text, images, files)
			if (!this.taskState.checkpointTrackerErrorMessage?.includes("Checkpoints initialization timed out.")) {
				await this.saveCheckpoint()
			}
			responseText = text
			responseImages = images
			responseFiles = files
		}

		const existingApiConversationHistory: Anthropic.Messages.MessageParam[] = await getSavedApiConversationHistory(
			this.getContext(),
			this.taskId,
		)

		let modifiedOldUserContent: UserContent
		let modifiedApiConversationHistory: Anthropic.Messages.MessageParam[]
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]
			if (lastMessage.role === "assistant") {
				modifiedApiConversationHistory = [...existingApiConversationHistory]
				modifiedOldUserContent = []
			} else if (lastMessage.role === "user") {
				const existingUserContent: UserContent = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
				modifiedOldUserContent = [...existingUserContent]
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			throw new Error("Unexpected: No existing API conversation history")
		}

		let newUserContent: UserContent = [...modifiedOldUserContent]

		const agoText = (() => {
			const timestamp = lastClineMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)

			if (days > 0) {
				return `${days} day${days > 1 ? "s" : ""} ago`
			}
			if (hours > 0) {
				return `${hours} hour${hours > 1 ? "s" : ""} ago`
			}
			if (minutes > 0) {
				return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
			}
			return "just now"
		})()

		const wasRecent = lastClineMessage?.ts && Date.now() - lastClineMessage.ts < 30_000

		const pendingContextWarning = await this.fileContextTracker.retrieveAndClearPendingFileContextWarning()
		const hasPendingFileContextWarnings = pendingContextWarning && pendingContextWarning.length > 0

		const [taskResumptionMessage, userResponseMessage] = formatResponse.taskResumption(
			this.chatSettings?.mode === "plan" ? "plan" : "act",
			agoText,
			this.cwd,
			wasRecent,
			responseText,
			hasPendingFileContextWarnings,
		)

		if (taskResumptionMessage !== "") {
			newUserContent.push({
				type: "text",
				text: taskResumptionMessage,
			})
		}

		if (userResponseMessage !== "") {
			newUserContent.push({
				type: "text",
				text: userResponseMessage,
			})
		}

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		if (responseFiles && responseFiles.length > 0) {
			const fileContentString = await processFilesIntoText(responseFiles)
			if (fileContentString) {
				newUserContent.push({
					type: "text",
					text: fileContentString,
				})
			}
		}

		if (pendingContextWarning && pendingContextWarning.length > 0) {
			const fileContextWarning = formatResponse.fileContextWarning(pendingContextWarning)
			newUserContent.push({
				type: "text",
				text: fileContextWarning,
			})
		}

		await this.messageStateHandler.overwriteApiConversationHistory(modifiedApiConversationHistory)
		await this.initiateTaskLoop(newUserContent)
	}

	private async initiateTaskLoop(userContent: UserContent): Promise<void> {
		let nextUserContent = userContent
		let includeFileDetails = true
		while (!this.taskState.abort) {
			const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false

			if (didEndLoop) {
				break
			} else {
				nextUserContent = [
					{
						type: "text",
						text: formatResponse.noToolsUsed(),
					},
				]
				this.taskState.consecutiveMistakeCount++
			}
		}
	}

	async abortTask() {
		this.taskState.abort = true
		this.terminalManager.disposeAll()
		this.urlContentFetcher.closeBrowser()
		await this.browserSession.dispose()
		this.clineIgnoreController.dispose()
		this.fileContextTracker.dispose()
		await this.diffViewProvider.revertChanges()
		this.mcpHub.clearNotificationCallback()
	}

	async saveCheckpoint(isAttemptCompletionMessage: boolean = false) {
		if (
			!this.enableCheckpoints ||
			this.taskState.checkpointTrackerErrorMessage?.includes("Checkpoints initialization timed out.")
		) {
			return
		}
		this.messageStateHandler.getClineMessages().forEach((message) => {
			if (message.say === "checkpoint_created") {
				message.isCheckpointCheckedOut = false
			}
		})

		if (!isAttemptCompletionMessage) {
			const lastMessage = this.messageStateHandler.getClineMessages().at(-1)
			if (lastMessage?.say === "checkpoint_created") {
				return
			}

			if (!this.checkpointTracker && !this.taskState.checkpointTrackerErrorMessage) {
				try {
					this.checkpointTracker = await CheckpointTracker.create(
						this.taskId,
						this.context.globalStorageUri.fsPath,
						this.enableCheckpoints,
					)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error"
					console.error("Failed to initialize checkpoint tracker:", errorMessage)
					this.taskState.checkpointTrackerErrorMessage = errorMessage
					await this.postStateToWebview()
					return
				}
			}

			if (this.checkpointTracker) {
				const commitHash = await this.checkpointTracker.commit()
				if (commitHash) {
					await this.say("checkpoint_created")
					const lastCheckpointMessageIndex = findLastIndex(
						this.messageStateHandler.getClineMessages(),
						(m) => m.say === "checkpoint_created",
					)
					if (lastCheckpointMessageIndex !== -1) {
						await this.messageStateHandler.updateClineMessage(lastCheckpointMessageIndex, {
							lastCheckpointHash: commitHash,
						})
					}
				}
			}
		} else {
			if (
				!this.checkpointTracker &&
				!this.taskState.checkpointTrackerErrorMessage?.includes("Checkpoints initialization timed out.")
			) {
				try {
					this.checkpointTracker = await CheckpointTracker.create(
						this.taskId,
						this.context.globalStorageUri.fsPath,
						this.enableCheckpoints,
					)
					this.messageStateHandler.setCheckpointTracker(this.checkpointTracker)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error"
					console.error("Failed to initialize checkpoint tracker for attempt completion:", errorMessage)
					return
				}
			}

			if (
				this.checkpointTracker &&
				!this.taskState.checkpointTrackerErrorMessage?.includes("Checkpoints initialization timed out.")
			) {
				const commitHash = await this.checkpointTracker.commit()

				const lastCompletionResultMessage = findLast(
					this.messageStateHandler.getClineMessages(),
					(m) => m.say === "completion_result" || m.ask === "completion_result",
				)
				if (lastCompletionResultMessage) {
					lastCompletionResultMessage.lastCheckpointHash = commitHash
					await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
				}
			} else {
				console.error("Checkpoint tracker does not exist and could not be initialized for attempt completion")
			}
		}
	}

	private async executeCommandInNode(command: string): Promise<[boolean, ToolResponse]> {
		try {
			const childProcess = execa(command, {
				shell: true,
				cwd: this.cwd,
				reject: false,
				all: true,
			})

			let output = ""

			if (childProcess.all) {
				childProcess.all.on("data", (data) => {
					output += data.toString()
				})
			}

			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => {
					if (childProcess.pid) {
						childProcess.kill("SIGKILL")
					}
					reject(new Error("Command timeout after 30s"))
				}, 30000)
			})

			const result = await Promise.race([childProcess, timeoutPromise]).catch((error) => {
				console.log(`Command timed out after 30s: ${command}`)
				return {
					stdout: "",
					stderr: "",
					exitCode: 124,
					timedOut: true,
				}
			})

			const wasTerminated = result.timedOut === true

			if (!output) {
				output = result.stdout || result.stderr || ""
			}

			console.log(`Command executed in Node: ${command}\nOutput:\n${output}`)

			if (wasTerminated) {
				output += "\nCommand was taking a while to run so it was auto terminated after 30s"
			}

			return [
				false,
				`Command executed${wasTerminated ? " (terminated after 30s)" : ""} with exit code ${
					result.exitCode
				}.${output.length > 0 ? `\nOutput:\n${output}` : ""}`,
			]
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			return [false, `Error executing command: ${errorMessage}`]
		}
	}

	async executeCommandTool(command: string): Promise<[boolean, ToolResponse]> {
		console.log("IS_TEST: " + isInTestMode())

		if (isInTestMode()) {
			console.log("Executing command in Node: " + command)
			return this.executeCommandInNode(command)
		}
		console.log("Executing command in terminal: " + command)

		const terminalInfo = await this.terminalManager.getOrCreateTerminal(this.cwd)
		terminalInfo.terminal.show()
		const process = this.terminalManager.runCommand(terminalInfo, command)

		let userFeedback: { text?: string; images?: string[]; files?: string[] } | undefined
		let didContinue = false

		const CHUNK_LINE_COUNT = 20
		const CHUNK_BYTE_SIZE = 2048
		const CHUNK_DEBOUNCE_MS = 100

		let outputBuffer: string[] = []
		let outputBufferSize: number = 0
		let chunkTimer: NodeJS.Timeout | null = null
		let chunkEnroute = false

		const flushBuffer = async (force = false) => {
			if (chunkEnroute || outputBuffer.length === 0) {
				if (force && !chunkEnroute && outputBuffer.length > 0) {
				} else {
					return
				}
			}
			const chunk = outputBuffer.join("\n")
			outputBuffer = []
			outputBufferSize = 0
			chunkEnroute = true
			try {
				const { response, text, images, files } = await this.ask("command_output", chunk)
				if (response === "yesButtonClicked") {
					if (text || (images && images.length > 0) || (files && files.length > 0)) {
						userFeedback = { text, images, files }
					}
				} else {
					userFeedback = { text, images, files }
				}
				didContinue = true
				process.continue()
			} catch {
				console.error("Error while asking for command output")
			} finally {
				chunkEnroute = false
				if (outputBuffer.length > 0) {
					await flushBuffer()
				}
			}
		}

		const scheduleFlush = () => {
			if (chunkTimer) {
				clearTimeout(chunkTimer)
			}
			chunkTimer = setTimeout(async () => await flushBuffer(), CHUNK_DEBOUNCE_MS)
		}

		const outputLines: string[] = []
		process.on("line", async (line) => {
			outputLines.push(line)

			if (!didContinue) {
				outputBuffer.push(line)
				outputBufferSize += Buffer.byteLength(line, "utf8")
				if (outputBuffer.length >= CHUNK_LINE_COUNT || outputBufferSize >= CHUNK_BYTE_SIZE) {
					await flushBuffer()
				} else {
					scheduleFlush()
				}
			} else {
				this.say("command_output", line)
			}
		})

		let completed = false
		process.once("completed", async () => {
			completed = true
			if (!didContinue && outputBuffer.length > 0) {
				if (chunkTimer) {
					clearTimeout(chunkTimer)
					chunkTimer = null
				}
				await flushBuffer(true)
			}
		})

		process.once("no_shell_integration", async () => {
			await this.say("shell_integration_warning")
		})

		await process

		await setTimeoutPromise(50)

		let result = this.terminalManager.processOutput(outputLines)

		if (userFeedback) {
			await this.say("user_feedback", userFeedback.text, userFeedback.images, userFeedback.files)
			await this.saveCheckpoint()

			let fileContentString = ""
			if (userFeedback.files && userFeedback.files.length > 0) {
				fileContentString = await processFilesIntoText(userFeedback.files)
			}

			return [
				true,
				formatResponse.toolResult(
					`Command is still running in the user's terminal.${
						result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
					}\n\nThe user provided the following feedback:\n<feedback>\n${userFeedback.text}\n</feedback>`,
					userFeedback.images,
					fileContentString,
				),
			]
		}

		if (completed) {
			return [false, `Command executed.${result.length > 0 ? `\nOutput:\n${result}` : ""}`]
		} else {
			return [
				false,
				`Command is still running in the user's terminal.${
					result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
				}\n\nYou will be updated on the terminal status and new output in the future.`,
			]
		}
	}

	private async migrateDisableBrowserToolSetting(): Promise<void> {
		const config = vscode.workspace.getConfiguration("cline")
		const disableBrowserTool = config.get<boolean>("disableBrowserTool")

		if (disableBrowserTool !== undefined) {
			this.browserSettings.disableToolUse = disableBrowserTool
			await config.update("disableBrowserTool", undefined, true)
		}
	}

	private async migratePreferredLanguageToolSetting(): Promise<void> {
		const config = vscode.workspace.getConfiguration("cline")
		const preferredLanguage = config.get<LanguageDisplay>("preferredLanguage")
		if (preferredLanguage !== undefined) {
			this.chatSettings.preferredLanguage = preferredLanguage
			await config.update("preferredLanguage", undefined, true)
		}
	}

	private async getCurrentProviderInfo(): Promise<{ modelId: string; providerId: string }> {
		const modelId = this.api.getModel()?.id
		const providerId =
			this.chatSettings.mode === "plan"
				? ((await getGlobalState(this.getContext(), "planModeApiProvider")) as string)
				: ((await getGlobalState(this.getContext(), "actModeApiProvider")) as string)
		return { modelId, providerId }
	}

	async *attemptApiRequest(previousApiReqIndex: number): ApiStream {
		await pWaitFor(() => this.mcpHub.isConnecting !== true, { timeout: 10_000 }).catch(() => {
			console.error("MCP servers failed to connect in time")
		})

		await this.migrateDisableBrowserToolSetting()
		const disableBrowserTool = this.browserSettings.disableToolUse ?? false
		const modelInfo = this.api.getModel()
		const modelSupportsBrowserUse = modelInfo.info.supportsImages ?? false

		const supportsBrowserUse = modelSupportsBrowserUse && !disableBrowserTool

		const isNextGenModel = isClaude4ModelFamily(this.api) || isGemini2dot5ModelFamily(this.api)
		let systemPrompt = await SYSTEM_PROMPT(this.cwd, supportsBrowserUse, this.mcpHub, this.browserSettings, isNextGenModel)

		await this.migratePreferredLanguageToolSetting()
		const preferredLanguage = getLanguageKey(this.chatSettings.preferredLanguage as LanguageDisplay)
		const preferredLanguageInstructions =
			preferredLanguage && preferredLanguage !== DEFAULT_LANGUAGE_SETTINGS
				? `# Preferred Language\n\nSpeak in ${preferredLanguage}.`
				: ""

		const { globalToggles, localToggles } = await refreshClineRulesToggles(this.getContext(), this.cwd)
		const { windsurfLocalToggles, cursorLocalToggles } = await refreshExternalRulesToggles(this.getContext(), this.cwd)

		const globalClineRulesFilePath = await ensureRulesDirectoryExists()
		const globalClineRulesFileInstructions = await getGlobalClineRules(globalClineRulesFilePath, globalToggles)

		const localClineRulesFileInstructions = await getLocalClineRules(this.cwd, localToggles)
		const [localCursorRulesFileInstructions, localCursorRulesDirInstructions] = await getLocalCursorRules(
			this.cwd,
			cursorLocalToggles,
		)
		const localWindsurfRulesFileInstructions = await getLocalWindsurfRules(this.cwd, windsurfLocalToggles)

		const clineIgnoreContent = this.clineIgnoreController.clineIgnoreContent
		let clineIgnoreInstructions: string | undefined
		if (clineIgnoreContent) {
			clineIgnoreInstructions = formatResponse.clineIgnoreInstructions(clineIgnoreContent)
		}

		if (
			globalClineRulesFileInstructions ||
			localClineRulesFileInstructions ||
			localCursorRulesFileInstructions ||
			localCursorRulesDirInstructions ||
			localWindsurfRulesFileInstructions ||
			clineIgnoreInstructions ||
			preferredLanguageInstructions
		) {
			const userInstructions = addUserInstructions(
				globalClineRulesFileInstructions,
				localClineRulesFileInstructions,
				localCursorRulesFileInstructions,
				localCursorRulesDirInstructions,
				localWindsurfRulesFileInstructions,
				clineIgnoreInstructions,
				preferredLanguageInstructions,
			)
			systemPrompt += userInstructions
		}
		const contextManagementMetadata = await this.contextManager.getNewContextMessagesAndMetadata(
			this.messageStateHandler.getApiConversationHistory(),
			this.messageStateHandler.getClineMessages(),
			this.api,
			this.taskState.conversationHistoryDeletedRange,
			previousApiReqIndex,
			await ensureTaskDirectoryExists(this.getContext(), this.taskId),
		)

		if (contextManagementMetadata.updatedConversationHistoryDeletedRange) {
			this.taskState.conversationHistoryDeletedRange = contextManagementMetadata.conversationHistoryDeletedRange
			await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
		}

		let stream = this.api.createMessage(systemPrompt, contextManagementMetadata.truncatedConversationHistory)

		const iterator = stream[Symbol.asyncIterator]()

		try {
			this.taskState.isWaitingForFirstChunk = true
			const firstChunk = await iterator.next()
			yield firstChunk.value
			this.taskState.isWaitingForFirstChunk = false
		} catch (error) {
			const isOpenRouter = this.api instanceof OpenRouterHandler || this.api instanceof ClineHandler
			const isAnthropic = this.api instanceof AnthropicHandler
			const isOpenRouterContextWindowError = checkIsOpenRouterContextWindowError(error) && isOpenRouter
			const isAnthropicContextWindowError = checkIsAnthropicContextWindowError(error) && isAnthropic
			const { modelId, providerId } = await this.getCurrentProviderInfo()
			const clineError = ErrorService.toClineError(error, modelId, providerId)

			telemetryService.captureProviderApiError({
				taskId: this.taskId,
				model: modelInfo.id,
				errorMessage: clineError.message,
				errorStatus: clineError._error?.status,
				requestId: clineError._error?.request_id,
			})

			if (isAnthropic && isAnthropicContextWindowError && !this.taskState.didAutomaticallyRetryFailedApiRequest) {
				this.taskState.conversationHistoryDeletedRange = this.contextManager.getNextTruncationRange(
					this.messageStateHandler.getApiConversationHistory(),
					this.taskState.conversationHistoryDeletedRange,
					"quarter",
				)
				await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
				await this.contextManager.triggerApplyStandardContextTruncationNoticeChange(
					Date.now(),
					await ensureTaskDirectoryExists(this.getContext(), this.taskId),
				)

				this.taskState.didAutomaticallyRetryFailedApiRequest = true
			} else if (isOpenRouter && !this.taskState.didAutomaticallyRetryFailedApiRequest) {
				if (isOpenRouterContextWindowError) {
					this.taskState.conversationHistoryDeletedRange = this.contextManager.getNextTruncationRange(
						this.messageStateHandler.getApiConversationHistory(),
						this.taskState.conversationHistoryDeletedRange,
						"quarter",
					)
					await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
					await this.contextManager.triggerApplyStandardContextTruncationNoticeChange(
						Date.now(),
						await ensureTaskDirectoryExists(this.getContext(), this.taskId),
					)
				}

				console.log("first chunk failed, waiting 1 second before retrying")
				await setTimeoutPromise(1000)
				this.taskState.didAutomaticallyRetryFailedApiRequest = true
			} else {
				if (isOpenRouterContextWindowError || isAnthropicContextWindowError) {
					const truncatedConversationHistory = this.contextManager.getTruncatedMessages(
						this.messageStateHandler.getApiConversationHistory(),
						this.taskState.conversationHistoryDeletedRange,
					)

					if (truncatedConversationHistory.length > 3) {
						clineError.message = "Context window exceeded. Click retry to truncate the conversation and try again."
						this.taskState.didAutomaticallyRetryFailedApiRequest = false
					}
				}

				const streamingFailedMessage = clineError.serialize()

				const lastApiReqStartedIndex = findLastIndex(
					this.messageStateHandler.getClineMessages(),
					(m) => m.say === "api_req_started",
				)
				if (lastApiReqStartedIndex !== -1) {
					const clineMessages = this.messageStateHandler.getClineMessages()
					const currentApiReqInfo: ClineApiReqInfo = JSON.parse(clineMessages[lastApiReqStartedIndex].text || "{}")
					delete currentApiReqInfo.retryStatus

					await this.messageStateHandler.updateClineMessage(lastApiReqStartedIndex, {
						text: JSON.stringify({
							...currentApiReqInfo,
							streamingFailedMessage,
						} satisfies ClineApiReqInfo),
					})
				}

				const { response } = await this.ask("api_req_failed", streamingFailedMessage)

				if (response !== "yesButtonClicked") {
					throw new Error("API request failed")
				}

				if (clineError.isErrorType(ClineErrorType.Auth)) {
					return
				}

				await this.say("api_req_retried")
			}
			yield* this.attemptApiRequest(previousApiReqIndex)
			return
		}

		yield* iterator
	}

	async presentAssistantMessage() {
		if (this.taskState.abort) {
			throw new Error("Cline instance aborted")
		}

		if (this.taskState.presentAssistantMessageLocked) {
			this.taskState.presentAssistantMessageHasPendingUpdates = true
			return
		}
		this.taskState.presentAssistantMessageLocked = true
		this.taskState.presentAssistantMessageHasPendingUpdates = false

		if (this.taskState.currentStreamingContentIndex >= this.taskState.assistantMessageContent.length) {
			if (this.taskState.didCompleteReadingStream) {
				this.taskState.userMessageContentReady = true
			}
			this.taskState.presentAssistantMessageLocked = false
			return
		}

		const block = cloneDeep(this.taskState.assistantMessageContent[this.taskState.currentStreamingContentIndex])
		switch (block.type) {
			case "text": {
				if (this.taskState.didRejectTool || this.taskState.didAlreadyUseTool) {
					break
				}
				let content = block.content
				if (content) {
					content = content.replace(/<thinking>\s?/g, "")
					content = content.replace(/\s?<\/thinking>/g, "")

					const lastOpenBracketIndex = content.lastIndexOf("<")
					if (lastOpenBracketIndex !== -1) {
						const possibleTag = content.slice(lastOpenBracketIndex)
						const hasCloseBracket = possibleTag.includes(">")
						if (!hasCloseBracket) {
							let tagContent: string
							if (possibleTag.startsWith("</")) {
								tagContent = possibleTag.slice(2).trim()
							} else {
								tagContent = possibleTag.slice(1).trim()
							}
							const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)
							const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"
							if (isOpeningOrClosing || isLikelyTagName) {
								content = content.slice(0, lastOpenBracketIndex).trim()
							}
						}
					}
				}

				if (!block.partial) {
					const match = content?.trimEnd().match(/```[a-zA-Z0-9_-]+$/)
					if (match) {
						const matchLength = match[0].length
						content = content.trimEnd().slice(0, -matchLength)
					}
				}

				await this.say("text", content, undefined, undefined, block.partial)
				break
			}
			case "tool_use":
				await this.toolExecutor.executeTool(block)
				break
		}

		this.taskState.presentAssistantMessageLocked = false
		if (!block.partial || this.taskState.didRejectTool || this.taskState.didAlreadyUseTool) {
			if (this.taskState.currentStreamingContentIndex === this.taskState.assistantMessageContent.length - 1) {
				this.taskState.userMessageContentReady = true
			}

			this.taskState.currentStreamingContentIndex++

			if (this.taskState.currentStreamingContentIndex < this.taskState.assistantMessageContent.length) {
				this.presentAssistantMessage()
				return
			}
		}
		if (this.taskState.presentAssistantMessageHasPendingUpdates) {
			this.presentAssistantMessage()
		}
	}

	async recursivelyMakeClineRequests(userContent: UserContent, includeFileDetails: boolean = false): Promise<boolean> {
		if (this.taskState.abort) {
			throw new Error("Cline instance aborted")
		}

		const { modelId, providerId } = await this.getCurrentProviderInfo()
		if (providerId && modelId) {
			try {
				await this.modelContextTracker.recordModelUsage(providerId, modelId, this.chatSettings.mode)
			} catch {}
		}

		if (this.taskState.consecutiveMistakeCount >= 3) {
			if (this.autoApprovalSettings.enabled && this.autoApprovalSettings.enableNotifications) {
				showSystemNotification({
					subtitle: "Error",
					message: "Cline is having trouble. Would you like to continue the task?",
				})
			}
			const { response, text, images, files } = await this.ask(
				"mistake_limit_reached",
				this.api.getModel().id.includes("claude")
					? `This may indicate a failure in his thought process or inability to use a tool properly, which can be mitigated with some user guidance (e.g. "Try breaking down the task into smaller steps").`
					: "Cline uses complex prompts and iterative task execution that may be challenging for less capable models. For best results, it's recommended to use Claude 4 Sonnet for its advanced agentic coding capabilities.",
			)
			if (response === "messageResponse") {
				const feedbackUserContent: UserContent = []
				feedbackUserContent.push({
					type: "text",
					text: formatResponse.tooManyMistakes(text),
				})
				if (images && images.length > 0) {
					feedbackUserContent.push(...formatResponse.imageBlocks(images))
				}

				let fileContentString = ""
				if (files && files.length > 0) {
					fileContentString = await processFilesIntoText(files)
				}

				if (fileContentString) {
					feedbackUserContent.push({
						type: "text",
						text: fileContentString,
					})
				}

				userContent = feedbackUserContent
			}
			this.taskState.consecutiveMistakeCount = 0
		}

		if (
			this.autoApprovalSettings.enabled &&
			this.taskState.consecutiveAutoApprovedRequestsCount >= this.autoApprovalSettings.maxRequests
		) {
			if (this.autoApprovalSettings.enableNotifications) {
				showSystemNotification({
					subtitle: "Max Requests Reached",
					message: `Cline has auto-approved ${this.autoApprovalSettings.maxRequests.toString()} API requests.`,
				})
			}
			const { response, text, images, files } = await this.ask(
				"auto_approval_max_req_reached",
				`Cline has auto-approved ${this.autoApprovalSettings.maxRequests.toString()} API requests. Would you like to reset the count and proceed with the task?`,
			)
			this.taskState.consecutiveAutoApprovedRequestsCount = 0

			if (response === "messageResponse") {
				await this.say("user_feedback", text, images, files)

				const feedbackUserContent: UserContent = []
				feedbackUserContent.push({
					type: "text",
					text: formatResponse.autoApprovalMaxReached(text),
				})
				if (images && images.length > 0) {
					feedbackUserContent.push(...formatResponse.imageBlocks(images))
				}

				let fileContentString = ""
				if (files && files.length > 0) {
					fileContentString = await processFilesIntoText(files)
				}

				if (fileContentString) {
					feedbackUserContent.push({
						type: "text",
						text: fileContentString,
					})
				}

				userContent = feedbackUserContent
			}
		}

		const previousApiReqIndex = findLastIndex(this.messageStateHandler.getClineMessages(), (m) => m.say === "api_req_started")

		const isFirstRequest = this.messageStateHandler.getClineMessages().filter((m) => m.say === "api_req_started").length === 0

		await this.say(
			"api_req_started",
			JSON.stringify({
				request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n") + "\n\nLoading...",
			}),
		)

		if (
			isFirstRequest &&
			this.enableCheckpoints &&
			!this.checkpointTracker &&
			!this.taskState.checkpointTrackerErrorMessage
		) {
			try {
				let checkpointsWarningTimer: NodeJS.Timeout | null = null
				let checkpointsWarningShown = false

				checkpointsWarningTimer = setTimeout(async () => {
					if (!checkpointsWarningShown) {
						checkpointsWarningShown = true
						this.taskState.checkpointTrackerErrorMessage =
							"Checkpoints are taking longer than expected to initialize. Working in a large repository? Consider re-opening Cline in a project that uses git, or disabling checkpoints."
						await this.postStateToWebview()
					}
				}, 7_000)

				this.checkpointTracker = await pTimeout(
					CheckpointTracker.create(this.taskId, this.context.globalStorageUri.fsPath, this.enableCheckpoints),
					{
						milliseconds: 15_000,
						message:
							"Checkpoints taking too long to initialize. Consider re-opening Cline in a project that uses git, or disabling checkpoints.",
					},
				)
				if (checkpointsWarningTimer) {
					clearTimeout(checkpointsWarningTimer)
					checkpointsWarningTimer = null
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error"
				console.error("Failed to initialize checkpoint tracker:", errorMessage)

				if (errorMessage.includes("Checkpoints taking too long to initialize")) {
					this.taskState.checkpointTrackerErrorMessage =
						"Checkpoints initialization timed out. Consider re-opening Cline in a project that uses git, or disabling checkpoints."
					await this.postStateToWebview()
				} else {
					this.taskState.checkpointTrackerErrorMessage = errorMessage
				}
			}
		}

		if (isFirstRequest && this.enableCheckpoints && this.checkpointTracker) {
			const commitHash = await this.checkpointTracker.commit()
			await this.say("checkpoint_created")
			const lastCheckpointMessageIndex = findLastIndex(
				this.messageStateHandler.getClineMessages(),
				(m) => m.say === "checkpoint_created",
			)
			if (lastCheckpointMessageIndex !== -1) {
				await this.messageStateHandler.updateClineMessage(lastCheckpointMessageIndex, {
					lastCheckpointHash: commitHash,
				})
			}
		} else if (
			isFirstRequest &&
			this.enableCheckpoints &&
			!this.checkpointTracker &&
			this.taskState.checkpointTrackerErrorMessage
		) {
		}

		const [parsedUserContent, environmentDetails, clinerulesError] = await this.loadContext(userContent, includeFileDetails)

		if (clinerulesError === true) {
			await this.say(
				"error",
				"Issue with processing the /newrule command. Double check that, if '.clinerules' already exists, it's a directory and not a file. Otherwise there was an issue referencing this file/directory.",
			)
		}

		userContent = parsedUserContent
		userContent.push({ type: "text", text: environmentDetails })

		await this.messageStateHandler.addToApiConversationHistory({
			role: "user",
			content: userContent,
		})

		telemetryService.captureConversationTurnEvent(this.taskId, providerId, modelId, "user")

		const lastApiReqIndex = findLastIndex(this.messageStateHandler.getClineMessages(), (m) => m.say === "api_req_started")
		await this.messageStateHandler.updateClineMessage(lastApiReqIndex, {
			text: JSON.stringify({
				request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n"),
			} satisfies ClineApiReqInfo),
		})
		await this.postStateToWebview()

		try {
			let cacheWriteTokens = 0
			let cacheReadTokens = 0
			let inputTokens = 0
			let outputTokens = 0
			let totalCost: number | undefined

			const abortStream = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
				if (this.diffViewProvider.isEditing) {
					await this.diffViewProvider.revertChanges()
				}

				const lastMessage = this.messageStateHandler.getClineMessages().at(-1)
				if (lastMessage && lastMessage.partial) {
					lastMessage.partial = false
					console.log("updating partial message", lastMessage)
				}

				await this.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text:
								assistantMessage +
								`\n\n[${
									cancelReason === "streaming_failed"
										? "Response interrupted by API Error"
										: "Response interrupted by user"
								}]`,
						},
					],
				})

				await updateApiReqMsg({
					messageStateHandler: this.messageStateHandler,
					lastApiReqIndex,
					inputTokens,
					outputTokens,
					cacheWriteTokens,
					cacheReadTokens,
					totalCost,
					api: this.api,
					cancelReason,
					streamingFailedMessage,
				})
				await this.messageStateHandler.saveClineMessagesAndUpdateHistory()

				telemetryService.captureConversationTurnEvent(this.taskId, providerId, this.api.getModel().id, "assistant", {
					tokensIn: inputTokens,
					tokensOut: outputTokens,
					cacheWriteTokens,
					cacheReadTokens,
					totalCost,
				})

				this.taskState.didFinishAbortingStream = true
			}

			this.taskState.currentStreamingContentIndex = 0
			this.taskState.assistantMessageContent = []
			this.taskState.didCompleteReadingStream = false
			this.taskState.userMessageContent = []
			this.taskState.userMessageContentReady = false
			this.taskState.didRejectTool = false
			this.taskState.didAlreadyUseTool = false
			this.taskState.presentAssistantMessageLocked = false
			this.taskState.presentAssistantMessageHasPendingUpdates = false
			this.taskState.didAutomaticallyRetryFailedApiRequest = false
			await this.diffViewProvider.reset()

			const stream = this.attemptApiRequest(previousApiReqIndex)
			let assistantMessage = ""
			let reasoningMessage = ""
			this.taskState.isStreaming = true
			let didReceiveUsageChunk = false
			try {
				for await (const chunk of stream) {
					if (!chunk) {
						continue
					}
					switch (chunk.type) {
						case "usage":
							didReceiveUsageChunk = true
							inputTokens += chunk.inputTokens
							outputTokens += chunk.outputTokens
							cacheWriteTokens += chunk.cacheWriteTokens ?? 0
							cacheReadTokens += chunk.cacheReadTokens ?? 0
							totalCost = chunk.totalCost
							break
						case "reasoning":
							reasoningMessage += chunk.reasoning
							if (!this.taskState.abort) {
								await this.say("reasoning", reasoningMessage, undefined, undefined, true)
							}
							break
						case "text":
							if (reasoningMessage && assistantMessage.length === 0) {
								await this.say("reasoning", reasoningMessage, undefined, undefined, false)
							}
							assistantMessage += chunk.text
							const prevLength = this.taskState.assistantMessageContent.length
							const isNextGenModel = isClaude4ModelFamily(this.api) || isGemini2dot5ModelFamily(this.api)
							if (isNextGenModel && USE_EXPERIMENTAL_CLAUDE4_FEATURES) {
								this.taskState.assistantMessageContent = parseAssistantMessageV3(assistantMessage)
							} else {
								this.taskState.assistantMessageContent = parseAssistantMessageV2(assistantMessage)
							}

							if (this.taskState.assistantMessageContent.length > prevLength) {
								this.taskState.userMessageContentReady = false
							}
							this.presentAssistantMessage()
							break
					}

					if (this.taskState.abort) {
						console.log("aborting stream...")
						if (!this.taskState.abandoned) {
							await abortStream("user_cancelled")
						}
						break
					}

					if (this.taskState.didRejectTool) {
						assistantMessage += "\n\n[Response interrupted by user feedback]"
						break
					}

					if (this.taskState.didAlreadyUseTool) {
						assistantMessage +=
							"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
						break
					}
				}
			} catch (error) {
				if (!this.taskState.abandoned) {
					this.abortTask()
					const clineError = ErrorService.toClineError(error, this.api.getModel().id)
					const errorMessage = clineError.serialize()

					await abortStream("streaming_failed", errorMessage)
					await this.reinitExistingTaskFromId(this.taskId)
				}
			} finally {
				this.taskState.isStreaming = false
			}

			if (!didReceiveUsageChunk) {
				this.api.getApiStreamUsage?.().then(async (apiStreamUsage) => {
					if (apiStreamUsage) {
						inputTokens += apiStreamUsage.inputTokens
						outputTokens += apiStreamUsage.outputTokens
						cacheWriteTokens += apiStreamUsage.cacheWriteTokens ?? 0
						cacheReadTokens += apiStreamUsage.cacheReadTokens ?? 0
						totalCost = apiStreamUsage.totalCost
					}
					await updateApiReqMsg({
						messageStateHandler: this.messageStateHandler,
						lastApiReqIndex,
						inputTokens,
						outputTokens,
						cacheWriteTokens,
						cacheReadTokens,
						api: this.api,
						totalCost,
					})
					await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
					await this.postStateToWebview()
				})
			}

			if (this.taskState.abort) {
				throw new Error("Cline instance aborted")
			}

			this.taskState.didCompleteReadingStream = true

			const partialBlocks = this.taskState.assistantMessageContent.filter((block) => block.partial)
			partialBlocks.forEach((block) => {
				block.partial = false
			})
			if (partialBlocks.length > 0) {
				this.presentAssistantMessage()
			}

			await updateApiReqMsg({
				messageStateHandler: this.messageStateHandler,
				lastApiReqIndex,
				inputTokens,
				outputTokens,
				cacheWriteTokens,
				cacheReadTokens,
				api: this.api,
				totalCost,
			})
			await this.messageStateHandler.saveClineMessagesAndUpdateHistory()
			await this.postStateToWebview()

			let didEndLoop = false
			if (assistantMessage.length > 0) {
				telemetryService.captureConversationTurnEvent(this.taskId, providerId, modelId, "assistant", {
					tokensIn: inputTokens,
					tokensOut: outputTokens,
					cacheWriteTokens,
					cacheReadTokens,
					totalCost,
				})

				await this.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: assistantMessage }],
				})

				await pWaitFor(() => this.taskState.userMessageContentReady)

				const didToolUse = this.taskState.assistantMessageContent.some((block) => block.type === "tool_use")

				if (!didToolUse) {
					this.taskState.userMessageContent.push({
						type: "text",
						text: formatResponse.noToolsUsed(),
					})
					this.taskState.consecutiveMistakeCount++
				}

				const recDidEndLoop = await this.recursivelyMakeClineRequests(this.taskState.userMessageContent)
				didEndLoop = recDidEndLoop
			} else {
				await this.say(
					"error",
					"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
				)
				await this.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Failure: I did not provide a response.",
						},
					],
				})
				return true
			}

			return didEndLoop
		} catch (error) {
			return true
		}
	}

	async loadContext(userContent: UserContent, includeFileDetails: boolean = false): Promise<[UserContent, string, boolean]> {
		let needsClinerulesFileCheck = false

		const { localWorkflowToggles, globalWorkflowToggles } = await refreshWorkflowToggles(this.getContext(), this.cwd)

		const processUserContent = async () => {
			return await Promise.all(
				userContent.map(async (block) => {
					if (block.type === "text") {
						if (
							block.text.includes("<feedback>") ||
							block.text.includes("<answer>") ||
							block.text.includes("<task>") ||
							block.text.includes("<user_message>")
						) {
							const parsedText = await parseMentions(
								block.text,
								this.cwd,
								this.urlContentFetcher,
								this.fileContextTracker,
							)

							const { processedText, needsClinerulesFileCheck: needsCheck } = await parseSlashCommands(
								parsedText,
								localWorkflowToggles,
								globalWorkflowToggles,
							)

							if (needsCheck) {
								needsClinerulesFileCheck = true
							}

							return {
								...block,
								text: processedText,
							}
						}
					}
					return block
				}),
			)
		}

		const [processedUserContent, environmentDetails] = await Promise.all([
			processUserContent(),
			this.getEnvironmentDetails(includeFileDetails),
		])

		let clinerulesError = false
		if (needsClinerulesFileCheck) {
			clinerulesError = await ensureLocalClineDirExists(this.cwd, GlobalFileNames.clineRules)
		}

		return [processedUserContent, environmentDetails, clinerulesError]
	}

	async getEnvironmentDetails(includeFileDetails: boolean = false) {
		let details = ""

		details += "\n\n# VSCode Visible Files"
		const visibleFilePaths = vscode.window.visibleTextEditors
			?.map((editor) => editor.document?.uri?.fsPath)
			.filter(Boolean)
			.map((absolutePath) => path.relative(this.cwd, absolutePath))

		const allowedVisibleFiles = this.clineIgnoreController
			.filterPaths(visibleFilePaths)
			.map((p) => p.toPosix())
			.join("\n")

		if (allowedVisibleFiles) {
			details += `\n${allowedVisibleFiles}`
		} else {
			details += "\n(No visible files)"
		}

		details += "\n\n# VSCode Open Tabs"
		const openTabPaths = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.map((tab) => (tab.input as vscode.TabInputText)?.uri?.fsPath)
			.filter(Boolean)
			.map((absolutePath) => path.relative(this.cwd, absolutePath))

		const allowedOpenTabs = this.clineIgnoreController
			.filterPaths(openTabPaths)
			.map((p) => p.toPosix())
			.join("\n")

		if (allowedOpenTabs) {
			details += `\n${allowedOpenTabs}`
		} else {
			details += "\n(No open tabs)"
		}

		const busyTerminals = this.terminalManager.getTerminals(true)
		const inactiveTerminals = this.terminalManager.getTerminals(false)

		if (busyTerminals.length > 0 && this.taskState.didEditFile) {
			await setTimeoutPromise(300)
		}

		if (busyTerminals.length > 0) {
			await pWaitFor(() => busyTerminals.every((t) => !this.terminalManager.isProcessHot(t.id)), {
				interval: 100,
				timeout: 15_000,
			}).catch(() => {})
		}

		this.taskState.didEditFile = false

		let terminalDetails = ""
		if (busyTerminals.length > 0) {
			terminalDetails += "\n\n# Actively Running Terminals"
			for (const busyTerminal of busyTerminals) {
				terminalDetails += `\n## Original command: \`${busyTerminal.lastCommand}\``
				const newOutput = this.terminalManager.getUnretrievedOutput(busyTerminal.id)
				if (newOutput) {
					terminalDetails += `\n### New Output\n${newOutput}`
				} else {
				}
			}
		}
		if (inactiveTerminals.length > 0) {
			const inactiveTerminalOutputs = new Map<number, string>()
			for (const inactiveTerminal of inactiveTerminals) {
				const newOutput = this.terminalManager.getUnretrievedOutput(inactiveTerminal.id)
				if (newOutput) {
					inactiveTerminalOutputs.set(inactiveTerminal.id, newOutput)
				}
			}
			if (inactiveTerminalOutputs.size > 0) {
				terminalDetails += "\n\n# Inactive Terminals"
				for (const [terminalId, newOutput] of inactiveTerminalOutputs) {
					const inactiveTerminal = inactiveTerminals.find((t) => t.id === terminalId)
					if (inactiveTerminal) {
						terminalDetails += `\n## ${inactiveTerminal.lastCommand}`
						terminalDetails += `\n### New Output\n${newOutput}`
					}
				}
			}
		}

		if (terminalDetails) {
			details += terminalDetails
		}

		const recentlyModifiedFiles = this.fileContextTracker.getAndClearRecentlyModifiedFiles()
		if (recentlyModifiedFiles.length > 0) {
			details +=
				"\n\n# Recently Modified Files\nThese files have been modified since you last accessed them (file was just edited so you may need to re-read it before editing):"
			for (const filePath of recentlyModifiedFiles) {
				details += `\n${filePath}`
			}
		}

		const now = new Date()
		const formatter = new Intl.DateTimeFormat(undefined, {
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			hour12: true,
		})
		const timeZone = formatter.resolvedOptions().timeZone
		const timeZoneOffset = -now.getTimezoneOffset() / 60
		const timeZoneOffsetStr = `${timeZoneOffset >= 0 ? "+" : ""}${timeZoneOffset}:00`
		details += `\n\n# Current Time\n${formatter.format(now)} (${timeZone}, UTC${timeZoneOffsetStr})`

		if (includeFileDetails) {
			details += `\n\n# Current Working Directory (${this.cwd.toPosix()}) Files\n`
			const isDesktop = arePathsEqual(this.cwd, getDesktopDir())
			if (isDesktop) {
				details += "(Desktop files not shown automatically. Use list_files to explore if needed.)"
			} else {
				const [files, didHitLimit] = await listFiles(this.cwd, true, 200)
				const result = formatResponse.formatFilesList(this.cwd, files, didHitLimit, this.clineIgnoreController)
				details += result
			}

			const gitRemotes = await getGitRemoteUrls(this.cwd)
			if (gitRemotes.length > 0) {
				details += `\n\n# Git Remote URLs\n${gitRemotes.join("\n")}`
			}
		}

		const { contextWindow, maxAllowedSize } = getContextWindowInfo(this.api)

		const getTotalTokensFromApiReqMessage = (msg: ClineMessage) => {
			if (!msg.text) {
				return 0
			}
			try {
				const { tokensIn, tokensOut, cacheWrites, cacheReads } = JSON.parse(msg.text)
				return (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
			} catch (e) {
				return 0
			}
		}

		const clineMessages = this.messageStateHandler.getClineMessages()
		const modifiedMessages = combineApiRequests(combineCommandSequences(clineMessages.slice(1)))
		const lastApiReqMessage = findLast(modifiedMessages, (msg) => {
			if (msg.say !== "api_req_started") {
				return false
			}
			return getTotalTokensFromApiReqMessage(msg) > 0
		})

		const lastApiReqTotalTokens = lastApiReqMessage ? getTotalTokensFromApiReqMessage(lastApiReqMessage) : 0
		const usagePercentage = Math.round((lastApiReqTotalTokens / contextWindow) * 100)

		details += "\n\n# Context Window Usage"
		details += `\n${lastApiReqTotalTokens.toLocaleString()} / ${(contextWindow / 1000).toLocaleString()}K tokens used (${usagePercentage}%)`

		details += "\n\n# Current Mode"
		if (this.chatSettings.mode === "plan") {
			details += "\nPLAN MODE\n" + formatResponse.planModeInstructions()
		} else {
			details += "\nACT MODE"
		}

		return `<environment_details>\n${details.trim()}\n</environment_details>`
	}
}
