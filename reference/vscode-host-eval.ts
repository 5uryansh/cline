#!/usr/bin/env node

/**
 * VSCode Extension Development Host Evaluation
 * Runs evaluation inside real VSCode environment with authentic APIs
 */

import * as path from "path"
import * as fs from "fs/promises"
import { runTests } from "@vscode/test-electron"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

/**
 * Parse disabled tools from multiple arguments
 * Handles both formats:
 * - Single argument with braces: --disabledtools={tool1,tool2}
 * - Multiple arguments from shell expansion: --disabledtools=tool1 --disabledtools=tool2
 */
function parseDisabledToolsArgs(args: string[]): string[] {
	const disabledTools: string[] = []
	const disabledToolsArgs = args.filter((arg) => arg.startsWith("--disabledtools="))

	console.log(`📝 Found ${disabledToolsArgs.length} disabled tools argument(s)`)

	for (const arg of disabledToolsArgs) {
		const value = arg.split("=")[1]

		if (!value) {
			console.warn("⚠️  Skipping empty disabled tools argument")
			continue
		}

		// Handle format: {tool1,tool2,tool3}
		if (value.startsWith("{") && value.endsWith("}")) {
			// Remove curly braces and split by comma
			const toolsString = value.slice(1, -1)
			const tools = toolsString
				.split(",")
				.map((tool) => tool.trim())
				.filter((tool) => tool)
			disabledTools.push(...tools)
			console.log(`📝 Parsed tools from braces format: ${tools.join(", ")}`)
		} else {
			// Handle single tool without braces (from shell expansion)
			const tool = value.trim()
			if (tool) {
				disabledTools.push(tool)
				console.log(`📝 Added single tool: ${tool}`)
			}
		}
	}

	// Remove duplicates
	const uniqueTools = [...new Set(disabledTools)]
	console.log(`✅ Total unique disabled tools: ${uniqueTools.join(", ")}`)

	return uniqueTools
}

async function createDisabledToolsConfig(disabledTools: string[]): Promise<void> {
	try {
		const configPath = path.join(__dirname, "src", "config.json")

		// Ensure src directory exists
		await fs.mkdir(path.dirname(configPath), { recursive: true })

		// Create the config object
		const config = {
			disabledTools: disabledTools,
		}

		// Write the config file
		await fs.writeFile(configPath, JSON.stringify(config, null, 2))

		console.log(`✅ Created config.json with disabled tools: ${disabledTools.join(", ")}`)
		console.log(`📁 Config file location: ${configPath}`)
	} catch (error) {
		console.error("❌ Failed to create config.json:", (error as Error).message)
	}
}

async function handleStartupConfiguration(args: string[]): Promise<void> {
	console.log("🔧 Processing startup configuration...")

	// Parse all arguments including environment variables
	const processArgs = [...args]

	if (process.env.XYNE_EVAL_ARGS) {
		const argString = process.env.XYNE_EVAL_ARGS
		const envArgs: string[] = []
		let currentArg = ""
		let inBraces = false

		for (let i = 0; i < argString.length; i++) {
			const char = argString[i]

			if (char === "{") {
				inBraces = true
				currentArg += char
			} else if (char === "}") {
				inBraces = false
				currentArg += char
			} else if (char === " " && !inBraces) {
				if (currentArg) {
					envArgs.push(currentArg)
					currentArg = ""
				}
			} else {
				currentArg += char
			}
		}

		if (currentArg) {
			envArgs.push(currentArg)
		}

		processArgs.push(...envArgs)
	}

	// Parse disabled tools from all arguments
	const disabledTools = parseDisabledToolsArgs(processArgs)

	// Create config if we have disabled tools
	if (disabledTools.length > 0) {
		await createDisabledToolsConfig(disabledTools)
		console.log("✅ Startup configuration completed")
	} else {
		console.log("ℹ️  No disabled tools configuration found")
	}
}

async function runBuildSteps(): Promise<void> {
	console.log("🔨 Running build steps to ensure latest configuration...")

	try {
		// First build the webview
		console.log("📦 Building webview UI...")
		const webviewResult = await execAsync("npm run build:webview", { cwd: __dirname })
		console.log("✅ Webview build completed")

		// Then build the extension with vite
		console.log("📦 Building extension with vite...")
		const viteResult = await execAsync("npx vite build", { cwd: __dirname })
		console.log("✅ Extension build completed")

		console.log("🎉 All builds completed successfully")
	} catch (buildError) {
		console.error("⚠️  Build warning:", (buildError as Error).message)
		console.log("⚠️  Continuing despite build warnings...")
	}
}

async function main() {
	try {
		console.log("🚀 Starting VSCode Extension Development Host evaluation...")

		// Parse command line arguments
		const args = process.argv.slice(2)
		console.log("📝 Received arguments:", args)

		// Handle startup configuration first (including config.json creation)
		await handleStartupConfiguration(args)

		// Set environment variable to indicate disabled tools are active
		process.env.XYNE_DISABLED_TOOLS_ACTIVE = "true"
		console.log("🔧 Set XYNE_DISABLED_TOOLS_ACTIVE environment variable")

		// Always run build steps to ensure latest configuration is used
		await runBuildSteps()

		// Check for other arguments
		const countArg = args.find((arg) => arg.startsWith("--count="))
		const testIdArg = args.find((arg) => arg.startsWith("--test-id="))

		if (countArg) {
			console.log(`🎯 Count parameter detected: ${countArg}`)
		}

		if (testIdArg) {
			console.log(`🎯 Test ID parameter detected: ${testIdArg}`)
		}

		// Pass args to the test runner
		process.env.XYNE_EVAL_ARGS = args.join(" ")

		// The folder containing the Extension Manifest package.json
		const extensionDevelopmentPath = path.resolve(__dirname)

		// The path to test runner
		const extensionTestsPath = path.resolve(__dirname, "./vscode-eval-runner.js")

		console.log("📁 Extension path:", extensionDevelopmentPath)
		console.log("🧪 Test runner path:", extensionTestsPath)

		// Download VS Code, unzip it and run the integration test
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				"--disable-extensions", // Disable other extensions
				"--disable-workspace-trust", // Skip workspace trust dialog
				process.cwd(), // Open current workspace
			],
			extensionTestsEnv: {
				...process.env,
				XYNE_DISABLED_TOOLS_ACTIVE: "true",
				XYNE_EVAL_ARGS: args.join(" "),
			},
		})

		console.log("✅ VSCode Extension Development Host evaluation completed")
	} catch (err) {
		console.error("❌ Failed to run VSCode Extension Development Host evaluation:", err)
		process.exit(1)
	}
}

if (require.main === module) {
	main()
}
