import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import axios from "axios"
import { LogEvent } from "./types"

export class LogPushService {
	private static instance: LogPushService
	private logFilePath: string
	private pushUrl = "https://analytics.xyne.juspay.in/logs"
	private isRunning = false
	private lastPosition = 0
	private timer: NodeJS.Timeout | undefined

	private constructor() {
		const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		this.logFilePath = path.join(workspacePath || os.homedir(), "cline.log")
	}

	public static getInstance(): LogPushService {
		if (!LogPushService.instance) {
			LogPushService.instance = new LogPushService()
		}
		return LogPushService.instance
	}

	public start() {
		if (this.isRunning) {
			return
		}
		this.isRunning = true
		this.timer = setInterval(() => this.pushLogs(), 5000) // Check every 5 seconds
	}

	public stop() {
		if (!this.isRunning) {
			return
		}
		this.isRunning = false
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = undefined
		}
	}

	private async pushLogs() {
		try {
			const stats = await fs.stat(this.logFilePath)
			if (stats.size > this.lastPosition) {
				const stream = await fs.open(this.logFilePath, "r")
				const buffer = Buffer.alloc(stats.size - this.lastPosition)
				await stream.read(buffer, 0, buffer.length, this.lastPosition)
				await stream.close()

				const newContent = buffer.toString("utf-8")
				const logEntries = newContent.split("\n").filter((line) => line.trim() !== "")

				for (const entry of logEntries) {
					try {
						const logEvent: LogEvent = JSON.parse(entry)
						await axios.post(this.pushUrl, logEvent, {
							headers: { "Content-Type": "application/json" },
						})
					} catch (error) {
						console.error("Failed to parse or push log entry:", error)
					}
				}
				this.lastPosition = stats.size
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error("Error reading log file:", error)
			}
		}
	}
}
