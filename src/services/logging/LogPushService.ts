import axios from "axios"
import { LogEvent } from "./types"
import { LoggingQueue } from "./LoggingQueue"

export class LogPushService {
	private static instance: LogPushService
	private pushUrl = "https://analytics.xyne.juspay.in/cline-logs"
	private isRunning = false
	private timer: NodeJS.Timeout | undefined
	private queue: LoggingQueue

	private constructor(queue: LoggingQueue) {
		this.queue = queue
	}

	public static getInstance(queue: LoggingQueue): LogPushService {
		if (!LogPushService.instance) {
			LogPushService.instance = new LogPushService(queue)
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
		const batch = this.queue.peek(10) // Peek at up to 10 events
		if (batch.length === 0) {
			return
		}

		console.log(`Attempting to push ${batch.length} log events.`)

		try {
			await axios.post(this.pushUrl, batch, {
				headers: { "Content-Type": "application/json" },
			})
			console.log(`Successfully pushed ${batch.length} log events.`)
			// If push is successful, dequeue the batch
			this.queue.dequeue(batch.length)
		} catch (error) {
			console.error("Failed to push log batch:", error)
			// Do not re-queue, the batch is still in the queue because we only peeked
		}
	}
}
