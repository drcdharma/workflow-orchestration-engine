require("dotenv").config();

require("dotenv").config();

const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const express = require("express");
const cors = require("cors");
const crypto = require("node:crypto");
const { MongoClient, objectId } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

let db;
let workflowsCollection;
let executionsCollection;

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

function clamp(value, min, max) {
    const number = Number(value);

    if (!Number.isFinite(number)) return min;

    return Math.min(max, Math.max(min, number));
}

// Validate the workflow and calculate a topological execution order.
function sortWorkflow(nodes, edges) {
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
        throw new Error("Nodes and edges must be arrays.");
    }

    if (nodes.length === 0 || nodes.length > 100) {
        throw new Error("Workflow must contain between 1 and 100 nodes.");
    }

    if (edges.length > 300) {
        throw new Error("Workflow cannot contain more than 300 edges.");
    }

    const nodeMap = new Map();

    for (const node of nodes) {
        if (
            !node ||
            typeof node.id !== "string" ||
            !node.id.trim() ||
            !node.data ||
            typeof node.data !== "object" ||
            Array.isArray(node.data)
        ) {
            throw new Error("Every node needs a unique ID and a data object.");
        }

        if (nodeMap.has(node.id)) {
            throw new Error(`Duplicate node ID: ${node.id}`);
        }

        nodeMap.set(node.id, node);
    }

    const adjacency = new Map();
    const indegree = new Map();
    const seenEdges = new Set();

    for (const id of nodeMap.keys()) {
        adjacency.set(id, []);
        indegree.set(id, 0);
    }

    for (const edge of edges) {
        if (
            !edge ||
            !nodeMap.has(edge.source) ||
            !nodeMap.has(edge.target)
        ) {
            throw new Error("An edge references a missing node.");
        }

        if (edge.source === edge.target) {
            throw new Error("A node cannot connect to itself.");
        }

        const edgeKey = `${edge.source}->${edge.target}`;

        if (seenEdges.has(edgeKey)) {
            throw new Error(`Duplicate edge: ${edgeKey}`);
        }

        seenEdges.add(edgeKey);
        adjacency.get(edge.source).push(edge.target);
        indegree.set(edge.target, indegree.get(edge.target) + 1);
    }

    const queue = [];

    for (const [id, degree] of indegree) {
        if (degree === 0) queue.push(id);
    }

    const order = [];

    while (queue.length > 0) {
        const id = queue.shift();
        order.push(nodeMap.get(id));

        for (const nextId of adjacency.get(id)) {
            const nextDegree = indegree.get(nextId) - 1;
            indegree.set(nextId, nextDegree);

            if (nextDegree === 0) queue.push(nextId);
        }
    }

    if (order.length !== nodes.length) {
        throw new Error(
            "Workflow contains a cycle. A DAG cannot contain cycles."
        );
    }

    return order;
}

// Example task handlers. External integrations can be added later.
const taskHandlers = {
    async noop(data) {
        await sleep(150);

        return {
            message: data.label || "Task completed",
        };
    },

    async wait(data) {
        const durationMs = clamp(data.durationMs ?? 1000, 0, 10000);
        await sleep(durationMs);

        return {
            message: `Waited ${durationMs} ms`,
        };
    },

    async setVariable(data, context) {
        if (typeof data.key !== "string" || !data.key.trim()) {
            throw new Error("setVariable requires a non-empty key.");
        }

        const key = data.key;
        const existed = Object.prototype.hasOwnProperty.call(
            context.variables,
            key
        );
        const previousValue = context.variables[key];

        context.variables[key] = data.value;

        return {
            message: `Variable "${key}" updated`,
            undo: {
                key,
                existed,
                previousValue,
            },
        };
    },

    async fail() {
        throw new Error("This task was configured to fail.");
    },
};

const compensationHandlers = {
    async restoreVariable(undo, context) {
        if (undo.existed) {
            context.variables[undo.key] = undo.previousValue;
        } else {
            delete context.variables[undo.key];
        }

        return {
            message: `Variable "${undo.key}" restored`,
        };
    },
};

async function executeTask(node, context) {
    const data = node.data || {};
    const action = data.action || "noop";
    const retry = data.retry || {};

    const maxAttempts = clamp(retry.maxAttempts ?? 3, 1, 10);
    const initialDelayMs = clamp(retry.initialDelayMs ?? 500, 0, 30000);
    const maxDelayMs = clamp(retry.maxDelayMs ?? 10000, 0, 60000);
    const multiplier = clamp(retry.backoffMultiplier ?? 2, 1, 10);

    const attemptDetails = [];
    const handler = taskHandlers[action];

    if (!handler) {
        return {
            status: "FAILED",
            action,
            attempts: 0,
            attemptDetails,
            error: `Unknown task action: ${action}`,
        };
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            let result;

            if (data.simulateFailure === true) {
                throw new Error("Simulated failure enabled for this task.");
            }

            result = await handler(data, context);

            attemptDetails.push({
                attempt,
                status: "SUCCESS",
                timestamp: new Date(),
            });

            return {
                status: "SUCCESS",
                action,
                attempts: attempt,
                attemptDetails,
                result,
            };
        } catch (error) {
            attemptDetails.push({
                attempt,
                status: "FAILED",
                error: error.message,
                timestamp: new Date(),
            });

            if (attempt < maxAttempts) {
                const delay = Math.min(
                    initialDelayMs * Math.pow(multiplier, attempt - 1),
                    maxDelayMs
                );

                console.log(
                    `Retrying ${node.id}: attempt ${attempt + 1}/${maxAttempts} ` +
                    `after ${delay}ms`
                );

                await sleep(delay);
            } else {
                return {
                    status: "FAILED",
                    action,
                    attempts: attempt,
                    attemptDetails,
                    error: error.message,
                };
            }
        }
    }
}

async function compensateTasks(completed, context) {
    const compensations = [];

    for (const item of [...completed].reverse()) {
        const node = item.node;
        const action = node.data?.compensation?.action;

        if (!action) {
            compensations.push({
                taskId: node.id,
                taskName: node.data?.label || node.id,
                status: "SKIPPED",
                message: "No compensation action configured.",
            });

            continue;
        }

        const handler = compensationHandlers[action];

        if (!handler) {
            compensations.push({
                taskId: node.id,
                taskName: node.data?.label || node.id,
                status: "FAILED",
                message: `Unknown compensation action: ${action}`,
            });

            continue;
        }

        try {
            const undo = item.result?.result?.undo;
            const result = await handler(undo, context);

            compensations.push({
                taskId: node.id,
                taskName: node.data?.label || node.id,
                status: "COMPENSATED",
                result,
            });
        } catch (error) {
            compensations.push({
                taskId: node.id,
                taskName: node.data?.label || node.id,
                status: "FAILED",
                message: error.message,
            });
        }
    }

    return compensations;
}

// Health check
app.get("/health", async (req, res) => {
    try {
        await db.command({ ping: 1 });

        res.json({
            status: "ok",
            database: "connected",
        });
    } catch {
        res.status(503).json({
            status: "error",
            database: "disconnected",
        });
    }
});

// Save a workflow definition.
app.post("/api/workflows", async (req, res) => {
    try {
        const { name, nodes, edges } = req.body;

        if (typeof name !== "string" || !name.trim()) {
            return res.status(400).json({
                error: "Workflow name is required.",
            });
        }

        sortWorkflow(nodes, edges);

        const workflow = {
            name: name.trim(),
            nodes,
            edges,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const result = await workflowsCollection.insertOne(workflow);

        res.status(201).json({
            message: "Workflow saved successfully.",
            workflowId: result.insertedId,
            workflow,
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// List saved workflow definitions.
app.get("/api/workflows", async (req, res) => {
    try {
        const workflows = await workflowsCollection
            .find({})
            .sort({ updatedAt: -1 })
            .limit(100)
            .toArray();

        res.json({ workflows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
function parseWorkflowId(id) {
    if (!ObjectId.isValid(id)) {
        return null;
    }

    const objectId = new ObjectId(id);

    // Reject IDs that ObjectId would silently normalize.
    if (objectId.toHexString() !== id.toLowerCase()) {
        return null;
    }

    return objectId;
}

// Load one saved workflow by ID.
app.get("/api/workflows/:id", async (req, res) => {
    try {
        const id = parseWorkflowId(req.params.id);

        if (!id) {
            return res.status(400).json({
                error: "Invalid workflow ID.",
            });
        }

        const workflow = await workflowsCollection.findOne({
            _id: id,
        });

        if (!workflow) {
            return res.status(404).json({
                error: "Workflow not found.",
            });
        }

        res.json({ workflow });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update a saved workflow.
app.put("/api/workflows/:id", async (req, res) => {
    try {
        const id = parseWorkflowId(req.params.id);
        const { name, nodes, edges } = req.body;

        if (!id) {
            return res.status(400).json({
                error: "Invalid workflow ID.",
            });
        }

        if (typeof name !== "string" || !name.trim()) {
            return res.status(400).json({
                error: "Workflow name is required.",
            });
        }

        // Validate the DAG before saving.
        sortWorkflow(nodes, edges);

        const result = await workflowsCollection.updateOne(
            { _id: id },
            {
                $set: {
                    name: name.trim(),
                    nodes,
                    edges,
                    updatedAt: new Date(),
                },
            }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({
                error: "Workflow not found.",
            });
        }

        res.json({
            message: "Workflow updated successfully.",
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Delete a saved workflow definition.
app.delete("/api/workflows/:id", async (req, res) => {
    try {
        const id = parseWorkflowId(req.params.id);

        if (!id) {
            return res.status(400).json({
                error: "Invalid workflow ID.",
            });
        }

        const result = await workflowsCollection.deleteOne({
            _id: id,
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({
                error: "Workflow not found.",
            });
        }

        res.json({
            message: "Workflow deleted successfully.",
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Execute a workflow and persist the execution and task results.
app.post("/api/workflows/execute", async (req, res) => {
    let executionId;
    let executionStarted = false;

    try {
        const { nodes, edges } = req.body;
        const order = sortWorkflow(nodes, edges);

        executionId = `run-${crypto.randomUUID()}`;
        executionStarted = true;

        const startedAt = new Date();

        const execution = {
            executionId,
            status: "RUNNING",
            nodes,
            edges,
            order: order.map((node) => node.id),
            results: [],
            failedTask: null,
            compensations: [],
            variables: {},
            startedAt,
            finishedAt: null,
        };

        await executionsCollection.insertOne(execution);

        const context = { variables: {} };
        const completed = [];
        const results = [];
        let failedTask = null;

        for (const node of order) {
            console.log(`Executing: ${node.data.label || node.id}`);
            console.log(`Action: ${node.data.action || "noop"}`);

            const result = await executeTask(node, context);

            results.push({
                taskId: node.id,
                taskName: node.data.label || node.id,
                ...result,
            });

            if (result.status === "FAILED") {
                failedTask = {
                    taskId: node.id,
                    taskName: node.data.label || node.id,
                    error: result.error,
                };
                break;
            }

            completed.push({ node, result });
        }

        let compensations = [];

        if (failedTask) {
            compensations = await compensateTasks(completed, context);
        }

        const compensationFailed = compensations.some(
            (item) => item.status === "FAILED"
        );

        const status = failedTask
            ? compensationFailed
                ? "COMPENSATION_FAILED"
                : "FAILED"
            : "SUCCESS";

        const finishedAt = new Date();

        const finalExecution = {
            status,
            results,
            failedTask,
            compensations,
            variables: context.variables,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
        };

        await executionsCollection.updateOne(
            { executionId },
            { $set: finalExecution }
        );

        res.json({
            executionId,
            ...finalExecution,
            order: order.map((node) => node.id),
        });
    } catch (error) {
        console.error("Workflow execution error:", error);

        if (executionStarted && executionId) {
            await executionsCollection.updateOne(
                { executionId },
                {
                    $set: {
                        status: "ERROR",
                        error: error.message,
                        finishedAt: new Date(),
                    },
                }
            ).catch((dbError) => {
                console.error("Could not save execution error:", dbError.message);
            });
        }

        res.status(400).json({ error: error.message });
    }
});

// List recent execution history.
app.get("/api/workflows/executions", async (req, res) => {
    try {
        const executions = await executionsCollection
            .find(
                {},
                {
                    projection: {
                        _id: 0,
                        executionId: 1,
                        status: 1,
                        order: 1,
                        failedTask: 1,
                        startedAt: 1,
                        finishedAt: 1,
                        durationMs: 1,
                    },
                }
            )
            .sort({ startedAt: -1 })
            .limit(50)
            .toArray();

        res.json({ executions });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// View one execution, including its results and retries.
app.get("/api/workflows/executions/:executionId", async (req, res) => {
    try {
        const execution = await executionsCollection.findOne(
            { executionId: req.params.executionId },
            { projection: { _id: 0 } }
        );

        if (!execution) {
            return res.status(404).json({
                error: "Execution not found.",
            });
        }

        res.json(execution);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function startServer() {
    const uri = process.env.MONGODB_URI;
    const dbName = process.env.DB_NAME || "workflow_orchestration";

    if (!uri) {
        throw new Error("MONGODB_URI is missing from backend/.env");
    }

    const client = new MongoClient(uri);

    await client.connect();

    db = client.db(dbName);

    await db.command({ ping: 1 });

    workflowsCollection = db.collection("workflows");
    executionsCollection = db.collection("executions");

    await executionsCollection.createIndex(
        { executionId: 1 },
        { unique: true }
    );

    await executionsCollection.createIndex({ startedAt: -1 });

    console.log(`MongoDB connected: ${dbName}`);

    app.listen(PORT, () => {
        console.log(`Backend running at http://localhost:${PORT}`);
    });
}

startServer().catch((error) => {
    console.error("Backend startup failed:", error.message);
    process.exit(1);
});