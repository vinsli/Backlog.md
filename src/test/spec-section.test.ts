import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { parseTask } from "../markdown/parser.ts";
import { serializeTask } from "../markdown/serializer.ts";
import { extractStructuredSection } from "../markdown/structured-sections.ts";
import { McpServer } from "../mcp/server.ts";
import { registerTaskTools } from "../mcp/tools/tasks/index.ts";
import type { JsonSchema } from "../mcp/validation/validators.ts";
import { getTestCliPath } from "./test-cli.ts";
import { createUniqueTestDir, initializeFilesystemTestProject, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;
const CLI_PATH = getTestCliPath();

describe("Spec section", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-spec-section");
		await mkdir(TEST_DIR, { recursive: true });
		const core = new Core(TEST_DIR);
		await initializeFilesystemTestProject(core, "Spec Section Test");
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR);
	});

	it("creates a task with a Spec section from --spec", async () => {
		const res = await $`bun ${CLI_PATH} task create "Spec at create" --spec "Must support batches up to 10k."`
			.cwd(TEST_DIR)
			.quiet()
			.nothrow();
		expect(res.exitCode).toBe(0);

		const core = new Core(TEST_DIR);
		const content = (await core.getTaskContent("task-1")) ?? "";
		expect(content).toContain("## Spec");
		expect(content).toContain("<!-- SECTION:SPEC:BEGIN -->");
		expect(content).toContain("<!-- SECTION:SPEC:END -->");
		expect(extractStructuredSection(content, "spec")).toBe("Must support batches up to 10k.");

		const task = await core.getTask("task-1");
		expect(task?.spec).toBe("Must support batches up to 10k.");
	});

	it("sets and appends spec through task edit --spec and --append-spec", async () => {
		const core = new Core(TEST_DIR);
		await core.createTask(
			{
				id: "task-1",
				title: "No spec yet",
				status: "To Do",
				assignee: [],
				createdDate: "2025-09-10 00:00",
				labels: [],
				dependencies: [],
				description: "Desc",
			},
			false,
		);

		const set = await $`bun ${CLI_PATH} task edit 1 --spec "Must deliver X"`.cwd(TEST_DIR).quiet().nothrow();
		expect(set.exitCode).toBe(0);
		expect(extractStructuredSection((await core.getTaskContent("task-1")) ?? "", "spec")).toBe("Must deliver X");

		const append =
			await $`bun ${CLI_PATH} task edit 1 --append-spec "Must also handle errors per item" --append-spec "No batch-wide failure"`
				.cwd(TEST_DIR)
				.quiet()
				.nothrow();
		expect(append.exitCode).toBe(0);
		expect(extractStructuredSection((await core.getTaskContent("task-1")) ?? "", "spec")).toBe(
			"Must deliver X\n\nMust also handle errors per item\n\nNo batch-wide failure",
		);
	});

	it("round-trips a legacy task without a spec unchanged", async () => {
		const core = new Core(TEST_DIR);
		await core.createTask(
			{
				id: "task-1",
				title: "Legacy task",
				status: "To Do",
				assignee: [],
				createdDate: "2025-09-10 00:00",
				labels: [],
				dependencies: [],
				description: "Old description",
				implementationPlan: "Old plan",
			},
			false,
		);

		const originalContent = await core.getTaskContent("task-1");
		expect(originalContent).not.toBeNull();
		const original = originalContent as string;
		expect(original).not.toContain("## Spec");
		expect(original).not.toContain("<!-- SECTION:SPEC:BEGIN -->");

		const parsed = parseTask(original);
		expect(parsed.spec).toBeUndefined();

		const serialized = serializeTask(parsed, original);
		expect(serialized).toBe(original);
	});

	it("keeps Spec before Implementation Plan when both are present", async () => {
		const core = new Core(TEST_DIR);
		await core.createTask(
			{
				id: "task-1",
				title: "Both sections",
				status: "In Progress",
				assignee: [],
				createdDate: "2025-09-10 00:00",
				labels: [],
				dependencies: [],
				description: "Desc",
				implementationPlan: "1. Approach",
			},
			false,
		);

		const edit = await $`bun ${CLI_PATH} task edit 1 --spec "Delivers the batch API"`.cwd(TEST_DIR).quiet().nothrow();
		expect(edit.exitCode).toBe(0);

		const content = (await core.getTaskContent("task-1")) ?? "";
		const specIndex = content.indexOf("## Spec");
		const planIndex = content.indexOf("## Implementation Plan");
		expect(specIndex).toBeGreaterThanOrEqual(0);
		expect(planIndex).toBeGreaterThanOrEqual(0);
		expect(specIndex).toBeLessThan(planIndex);

		// Rewriting the plan afterwards must not displace the spec.
		const planEdit = await $`bun ${CLI_PATH} task edit 1 --plan "1. Revised approach"`.cwd(TEST_DIR).quiet().nothrow();
		expect(planEdit.exitCode).toBe(0);
		const rewritten = (await core.getTaskContent("task-1")) ?? "";
		expect(rewritten.indexOf("## Spec")).toBeLessThan(rewritten.indexOf("## Implementation Plan"));
		expect(extractStructuredSection(rewritten, "spec")).toBe("Delivers the batch API");
		expect(extractStructuredSection(rewritten, "implementationPlan")).toBe("1. Revised approach");
	});

	it("rejects marker lines in --spec payloads", async () => {
		const create = await $`bun ${CLI_PATH} task create "Marker target"`.cwd(TEST_DIR).quiet().nothrow();
		expect(create.exitCode).toBe(0);

		const payload = "<!-- SECTION:SPEC:BEGIN -->\ninjected";
		const edit = await $`bun ${CLI_PATH} task edit 1 --spec ${payload}`.cwd(TEST_DIR).quiet().nothrow();
		expect(edit.exitCode).not.toBe(0);
		expect(`${edit.stderr}${edit.stdout}`).toContain(
			'Spec content cannot contain the reserved marker line "<!-- SECTION:SPEC:BEGIN -->".',
		);

		const core = new Core(TEST_DIR);
		const content = (await core.getTaskContent("task-1")) ?? "";
		expect(content).not.toContain("## Spec");
	});
});

describe("Spec through MCP task tools", () => {
	let mcpServer: McpServer;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-spec-section-mcp");
		await mkdir(TEST_DIR, { recursive: true });
		mcpServer = new McpServer(TEST_DIR, "Test instructions");
		await mcpServer.filesystem.ensureBacklogStructure();
		await initializeFilesystemTestProject(mcpServer, "Spec MCP Test");
		const config = await mcpServer.filesystem.loadConfig();
		if (!config) throw new Error("Failed to load backlog configuration for tests");
		registerTaskTools(mcpServer, config);
	});

	afterEach(async () => {
		await Promise.allSettled([mcpServer.stop()]);
		await safeCleanup(TEST_DIR);
	});

	it("exposes spec fields on task_edit and not on task_create, mirroring plan", async () => {
		const tools = await mcpServer.testInterface.listTools();
		const toolByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
		const editSchema = toolByName.get("task_edit")?.inputSchema as JsonSchema | undefined;
		const createSchema = toolByName.get("task_create")?.inputSchema as JsonSchema | undefined;

		expect(editSchema?.properties?.spec).toMatchObject({ type: "string" });
		expect(editSchema?.properties?.specSet).toMatchObject({ type: "string" });
		expect(editSchema?.properties?.specAppend).toMatchObject({ type: "array" });
		expect(editSchema?.properties?.specClear).toMatchObject({ type: "boolean" });

		// The plan is intentionally absent from task_create; the spec follows that pattern.
		expect(createSchema?.properties?.spec).toBeUndefined();
		expect(createSchema?.properties?.planSet).toBeUndefined();
	});

	it("sets, appends, and clears spec through task_edit", async () => {
		await mcpServer.testInterface.callTool({
			params: { name: "task_create", arguments: { title: "MCP spec task" } },
		});

		const set = await mcpServer.testInterface.callTool({
			params: { name: "task_edit", arguments: { id: "TASK-1", specSet: "Must deliver the API" } },
		});
		expect(set.isError).toBeFalsy();
		expect((await mcpServer.getTask("task-1"))?.spec).toBe("Must deliver the API");

		const append = await mcpServer.testInterface.callTool({
			params: { name: "task_edit", arguments: { id: "TASK-1", specAppend: ["Per-item errors are not fatal"] } },
		});
		expect(append.isError).toBeFalsy();
		expect((await mcpServer.getTask("task-1"))?.spec).toBe("Must deliver the API\n\nPer-item errors are not fatal");

		const clear = await mcpServer.testInterface.callTool({
			params: { name: "task_edit", arguments: { id: "TASK-1", specClear: true } },
		});
		expect(clear.isError).toBeFalsy();
		// Clearing removes the section entirely, exactly like clearing the plan does.
		expect((await mcpServer.getTask("task-1"))?.spec).toBeUndefined();
		const core = new Core(TEST_DIR);
		expect((await core.getTaskContent("task-1")) ?? "").not.toContain("## Spec");
	});

	it("rejects a wrongly typed spec payload", async () => {
		await mcpServer.testInterface.callTool({
			params: { name: "task_create", arguments: { title: "Type check task" } },
		});

		const edit = await mcpServer.testInterface.callTool({
			params: { name: "task_edit", arguments: { id: "TASK-1", specSet: 12345 } },
		});
		expect(edit.isError).toBe(true);

		const task = await mcpServer.getTask("task-1");
		expect(task?.spec).toBeUndefined();
	});
});
