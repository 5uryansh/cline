import * as vscode from "vscode"
import * as fs from "fs"
import * as path from "path"
import { LogEvent } from "./types"

const QUEUE_PERSISTENCE_KEY = "loggingQueue"

export class LoggingQueue {
	private queue: LogEvent[] = []
	private context: vscode.ExtensionContext
	private logFilePath: string

	constructor(context: vscode.ExtensionContext) {
		this.context = context
		this.logFilePath = path.join(this.context.globalStorageUri.fsPath, "cline.log")
		this.ensureLogFileExists()
	}

	private ensureLogFileExists(): void {
		try {
			if (!fs.existsSync(this.context.globalStorageUri.fsPath)) {
				fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true })
			}
			if (!fs.existsSync(this.logFilePath)) {
				fs.writeFileSync(this.logFilePath, "")
			}
		} catch (error) {
			console.error("Failed to create log file:", error)
		}
	}

	async initialize(): Promise<void> {
		await this.loadPersistedEvents()
	}

	async enqueue(event: LogEvent): Promise<void> {
		console.log("Enqueueing log event:", event)
		this.queue.push(event)
		await this.writeEventToLogFile(event)
		await this.persistEvents()
	}

	peek(batchSize: number): LogEvent[] {
		return this.queue.slice(0, batchSize)
	}

	dequeue(batchSize: number): LogEvent[] {
		const batch = this.queue.splice(0, batchSize)
		this.persistEvents()
		return batch
	}

	async persistEvents(): Promise<void> {
		try {
			await this.context.globalState.update(QUEUE_PERSISTENCE_KEY, this.queue)
		} catch (error) {
			console.error("Failed to persist log queue:", error)
		}
	}

	private async writeEventToLogFile(event: LogEvent): Promise<void> {
		try {
			const logEntry = JSON.stringify(event) + "\n"
			await fs.promises.appendFile(this.logFilePath, logEntry)
			console.log(`Successfully wrote event to ${this.logFilePath}`)
		} catch (error) {
			console.error("Failed to write to cline.log:", error)
		}
	}

	private async loadPersistedEvents(): Promise<void> {
		try {
			const persistedData = this.context.globalState.get<LogEvent[]>(QUEUE_PERSISTENCE_KEY, [])
			if (Array.isArray(persistedData)) {
				this.queue = persistedData
			}
		} catch (error) {
			console.error("Failed to load persisted log queue:", error)
			this.queue = []
		}
	}
}
