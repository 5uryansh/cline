export interface LogEvent {
	taskId: string
	timestamp: number
	conversationId: string
	eventType: "session" | "message" | "tool" | "system" | "error"
	data: SessionEvent | MessageEvent | ToolEvent | SystemEvent | ErrorEvent
	// System metadata at event level
	systemMetadata: {
		extensionVersion: string
		vscodeVersion: string
		platform: string
		architecture: string
		compressionEnabled: boolean
		computerUserName?: string
		workspacePath?: string
		workspaceName?: string
		git?: {
			currentBranch?: string
			currentCommit?: string
			remoteUrl?: string
			upstreamBranch?: string
			isGitRepository?: boolean
		}
	}
}

export interface SessionEvent {
	conversationId: string
	action: "started" | "ended" | "switched_to" | "switched_from"
	conversationTitle?: string
	metadata?: {
		messageCount?: number
		duration?: number // in milliseconds
		totalCost?: number
		model?: string
		provider?: string
	}
}

// Message events (user and AI interactions)
export interface MessageEvent {
	conversationId: string
	messageId: string
	messageType: "user" | "assistant" | "system" | "error" | "terminal"
	content?: string // Optional for privacy
	contentHash?: string // SHA-256 hash for pattern analysis without content
	metadata: {
		model?: string
		tokens?: number
		cost?: number
		responseTime?: number
		toolExecutions?: ToolExecutionSummary[]
		attachedFiles?: AttachedFileInfo[]
		customInstructions?: boolean
		structuredContent?: boolean
		// Enhanced conversation flow metadata
		stage?:
			| "user_input"
			| "assistant_request"
			| "raw_assistant_request"
			| "raw_assistant_response"
			| "parsed_assistant_response"
			| "response_shown_to_user"
	}
}

export interface ToolExecutionSummary {
	toolName: string
	toolInput: any
}

export interface AttachedFileInfo {
	fileName: string
	fileType: string
	fileSize: number
}

// Tool execution events
export interface ToolEvent {
	conversationId: string
	messageId?: string // Associated message if applicable
	toolName: string
	action: "called" | "completed" | "failed"
	parameters?: Record<string, any>
	metadata: {
		stage?: "tool_called" | "tool_responded"
	}
	result?: {
		success: boolean
		error?: string
		outputSize?: number // bytes
		duration: number // milliseconds
		linesRead?: number // For read operations
		linesWritten?: number // For write operations
		linesModified?: number // For edit operations
		totalLinesInFile?: number // Context for operations
	}
	duration: number
}

// System events (extension lifecycle, errors, performance)
export interface SystemEvent {
	action:
		| "extension_activated"
		| "extension_deactivated"
		| "extension_first_installed"
		| "provider_changed"
		| "settings_changed"
		| "indexing_started"
		| "indexing_completed"
		| "mcp_server_added"
		| "mcp_server_removed"
		| "streaming_started"
		| "streaming_ended"
		| "git_state_changed"
		| "code_change_accepted"
		| "code_change_rejected"
		| "structured_streaming_ended"
		| "system_prompt_constructed"
		| "model_request_prepared"
		| "response_parsed"
		| "response_sent_to_user"
		| "follow_up_model_request"
	metadata?: {
		provider?: string
		model?: string
		setting?: string
		indexingDuration?: number
		mcpServerName?: string
		performanceMetrics?: any
		// Git state change metadata
		workspacePath?: string
		workspaceName?: string
		repositoryRoot?: string
		changes?: Record<string, { previous: any; current: any }>
		unchanged?: Record<string, any>
		changeCount?: number
		changeTypes?: string[]
		// Code acceptance/rejection metadata
		filePath?: string
		changeId?: string
		linesModified?: number
		totalLinesInFile?: number
		toolType?: string
		// Conversation flow metadata
		messageId?: string
		totalTokens?: number
		toolExecutionsCount?: number
	}
}

// Error events
export interface ErrorEvent {
	conversationId?: string
	error: {
		type: "ai_request_failed" | "tool_execution_failed" | "storage_error" | "network_error" | "system_error"
		message: string
		stack?: string
		code?: string
		provider?: string
		toolName?: string
	}
	context?: {
		userAction?: string
		systemState?: Record<string, any>
	}
}
