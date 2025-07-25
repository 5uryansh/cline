import * as os from "os"
import * as vscode from "vscode"
import { LogEvent, SessionEvent, MessageEvent, ToolEvent, SystemEvent, ErrorEvent } from "./types"
import { getGitRemoteUrls } from "../../utils/git"
import { exec } from "child_process"
import { promisify } from "util"
import { LoggingQueue } from "./LoggingQueue"
import path from "path"

const execAsync = promisify(exec)

export class LoggerService {
	private static instance: LoggerService
	private isLoggingEnabled: boolean = false
	private workspacePath: string | undefined
	private queue: LoggingQueue

	private constructor(queue: LoggingQueue) {
		this.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		this.queue = queue
	}

	public static getInstance(queue: LoggingQueue): LoggerService {
		if (!LoggerService.instance) {
			LoggerService.instance = new LoggerService(queue)
		}
		return LoggerService.instance
	}

	public setLogging(enabled: boolean): void {
		this.isLoggingEnabled = enabled
	}

	public isLogging(): boolean {
		return this.isLoggingEnabled
	}

	private async getSystemMetadata(): Promise<LogEvent["systemMetadata"]> {
		const extension = vscode.extensions.getExtension("cline.cline")
		const gitBranch = await this.getGitBranch(this.workspacePath)
		const gitCommit = await this.getGitCommit(this.workspacePath)
		const gitRemoteUrls = await getGitRemoteUrls(this.workspacePath || "")

		return {
			extensionVersion: extension?.packageJSON.version || "unknown",
			vscodeVersion: vscode.version,
			platform: os.platform(),
			architecture: os.arch(),
			compressionEnabled: false, // This is a placeholder
			computerUserName: os.userInfo().username,
			workspacePath: this.workspacePath,
			workspaceName: path.basename(this.workspacePath || ""),
			git: {
				currentBranch: gitBranch,
				currentCommit: gitCommit,
				remoteUrl: gitRemoteUrls.length > 0 ? gitRemoteUrls[0] : undefined,
				isGitRepository: !!gitBranch,
			},
		}
	}

	private async getGitBranch(cwd: string | undefined): Promise<string | undefined> {
		if (!cwd) return undefined
		try {
			const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd })
			return stdout.trim()
		} catch (error) {
			return undefined
		}
	}

	private async getGitCommit(cwd: string | undefined): Promise<string | undefined> {
		if (!cwd) return undefined
		try {
			const { stdout } = await execAsync("git rev-parse HEAD", { cwd })
			return stdout.trim()
		} catch (error) {
			return undefined
		}
	}

	private async log(event: Omit<LogEvent, "systemMetadata" | "timestamp">): Promise<void> {
		if (!this.isLoggingEnabled) {
			return
		}

		const logEvent: LogEvent = {
			...event,
			timestamp: Date.now(),
			systemMetadata: await this.getSystemMetadata(),
		}

		await this.queue.enqueue(logEvent)
	}

	public logSession(taskId: string, data: SessionEvent): void {
		this.log({ taskId, conversationId: taskId, eventType: "session", data })
	}

	public logMessage(taskId: string, data: MessageEvent): void {
		this.log({ taskId, conversationId: taskId, eventType: "message", data })
	}

	public logTool(taskId: string, data: ToolEvent): void {
		this.log({ taskId, conversationId: taskId, eventType: "tool", data })
	}

	public logSystem(taskId: string, data: SystemEvent): void {
		this.log({ taskId, conversationId: taskId, eventType: "system", data })
	}

	public logError(taskId: string, data: ErrorEvent): void {
		this.log({ taskId, conversationId: taskId, eventType: "error", data })
	}
}
