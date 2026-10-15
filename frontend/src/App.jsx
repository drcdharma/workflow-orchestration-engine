import { useCallback, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";
import "./App.css";

const API_BASE = "http://localhost:5000/api";
const STORAGE_KEY = "workflow-studio-saved-workflow";

const initialNodes = [
  {
    id: "1",
    type: "task",
    position: { x: 250, y: 40 },
    data: {
      label: "Trigger",
      description: "Start workflow",
      action: "setVariable",
      key: "workflowStarted",
      Value: "true",
      compensation: { action: "restoreVariable" },
    },
  },
  {
    id: "2",
    type: "task",
    position: { x: 250, y: 180 },
    data: {
      label: "Process Data",
      description: "Execute task",
      simulateFailure: false,
    },
  },
  {
    id: "3",
    type: "task",
    position: { x: 250, y: 320 },
    data: {
      label: "Finish",
      description: "Complete workflow",
    },
  },
];

const initialEdges = [
  { id: "e1-2", source: "1", target: "2", animated: true },
  { id: "e2-3", source: "2", target: "3", animated: true },
];

function getWorkflowId(workflow) {
  return workflow?._id ?? workflow?.id ?? workflow?.workflowId ?? "";
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || "Invalid server response." };
  }

  if (!response.ok) {
    throw new Error(
      data.error || data.message || `Request failed (${response.status})`
    );
  }

  return data;
}

function TaskNode({ data, selected }) {
  return (
    <div
      className="task-node"
      style={{
        border: selected ? "2px solid #2563eb" : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} />
      <strong>{data.label}</strong>
      <p>{data.description}</p>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const [workflowName, setWorkflowName] = useState("My Workflow");
  const [workflows, setWorkflows] = useState([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");

  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [execution, setExecution] = useState(null);
  const [error, setError] = useState("");
  const [saveMessage, setSaveMessage] = useState("Workflow ready");

  const selectedNode = nodes.find(
    (node) => node.id === selectedNodeId
  );

  // Keep a browser backup as well as using MongoDB.
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ nodes, edges })
      );
    } catch (err) {
      console.warn("Browser backup could not be saved.", err);
    }
  }, [nodes, edges]);

  const refreshWorkflows = async () => {
    setError("");

    try {
      const data = await apiRequest("/workflows");
      const list = Array.isArray(data)
        ? data
        : data.workflows ?? [];

      setWorkflows(list);
      setSaveMessage(`${list.length} workflow(s) found in database`);

      if (
        selectedWorkflowId &&
        !list.some(
          (workflow) =>
            String(getWorkflowId(workflow)) ===
            String(selectedWorkflowId)
        )
      ) {
        setSelectedWorkflowId("");
      }
    } catch (err) {
      setError(`Could not fetch workflows: ${err.message}`);
    }
  };

  // Fetch saved workflows when the app opens.
  useEffect(() => {
    refreshWorkflows();
    // Initial fetch only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onConnect = useCallback(
    (connection) => {
      setEdges((current) =>
        addEdge({ ...connection, animated: true }, current)
      );
      setExecution(null);
    },
    [setEdges]
  );

  const addTask = () => {
    const id = crypto.randomUUID();

    setNodes((current) => [
      ...current,
      {
        id,
        type: "task",
        position: {
          x: 100 + Math.random() * 350,
          y: 100 + Math.random() * 300,
        },
        data: {
          label: "New Task",
          description: "Configure this task",
        },
      },
    ]);

    setSelectedNodeId(id);
    setExecution(null);
    setError("");
  };

  const updateSelectedTask = (field, value) => {
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNodeId
          ? {
            ...node,
            data: { ...node.data, [field]: value },
          }
          : node
      )
    );

    setExecution(null);
  };

  const deleteSelectedTask = () => {
    if (!selectedNodeId) return;

    setNodes((current) =>
      current.filter((node) => node.id !== selectedNodeId)
    );

    setEdges((current) =>
      current.filter(
        (edge) =>
          edge.source !== selectedNodeId &&
          edge.target !== selectedNodeId
      )
    );

    setSelectedNodeId(null);
    setExecution(null);
    setError("");
  };

  // Create a new workflow in MongoDB.
  const saveWorkflow = async () => {
    if (!workflowName.trim()) {
      setError("Please enter a workflow name.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      await apiRequest("/workflows", {
        method: "POST",
        body: JSON.stringify({
          name: workflowName.trim(),
          nodes,
          edges,
        }),
      });

      await refreshWorkflows();

      // Select the newly created workflow by its name.
      const data = await apiRequest("/workflows");
      const list = Array.isArray(data)
        ? data
        : data.workflows ?? [];

      setWorkflows(list);

      const matches = list.filter(
        (workflow) => workflow.name === workflowName.trim()
      );
      const newestMatch = matches[matches.length - 1];

      if (newestMatch) {
        setSelectedWorkflowId(String(getWorkflowId(newestMatch)));
      }

      setSaveMessage("Workflow saved to MongoDB successfully!");
    } catch (err) {
      setError(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Load a saved workflow from MongoDB.
  const loadWorkflow = async () => {
    if (!selectedWorkflowId) {
      setError("Please select a saved workflow first.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const data = await apiRequest(
        `/workflows/${encodeURIComponent(selectedWorkflowId)}`
      );

      const workflow = data.workflow ?? data;

      if (
        !Array.isArray(workflow.nodes) ||
        !Array.isArray(workflow.edges)
      ) {
        throw new Error("The saved workflow has an invalid format.");
      }

      setNodes(workflow.nodes);
      setEdges(workflow.edges);
      setWorkflowName(workflow.name || "My Workflow");
      setSelectedNodeId(null);
      setExecution(null);
      setSaveMessage(`Loaded: ${workflow.name || "Workflow"}`);
    } catch (err) {
      setError(`Load failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Update the currently selected database workflow.
  const updateWorkflow = async () => {
    if (!selectedWorkflowId) {
      setError("Select a saved workflow before updating.");
      return;
    }

    if (!workflowName.trim()) {
      setError("Please enter a workflow name.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      await apiRequest(
        `/workflows/${encodeURIComponent(selectedWorkflowId)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            name: workflowName.trim(),
            nodes,
            edges,
          }),
        }
      );

      await refreshWorkflows();
      setSaveMessage("Workflow updated in MongoDB successfully!");
    } catch (err) {
      setError(`Update failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Delete the selected database workflow.
  const deleteWorkflow = async () => {
    if (!selectedWorkflowId) {
      setError("Select a saved workflow to delete.");
      return;
    }

    const confirmed = window.confirm(
      "Delete this workflow from MongoDB? This cannot be undone."
    );

    if (!confirmed) return;

    setSaving(true);
    setError("");

    try {
      await apiRequest(
        `/workflows/${encodeURIComponent(selectedWorkflowId)}`,
        { method: "DELETE" }
      );

      setWorkflows((current) =>
        current.filter(
          (workflow) =>
            String(getWorkflowId(workflow)) !==
            String(selectedWorkflowId)
        )
      );

      setSelectedWorkflowId("");
      setSaveMessage("Workflow deleted from MongoDB.");

    } catch (err) {
      setError(`Delete failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const resetWorkflow = () => {
    const confirmed = window.confirm(
      "Reset the canvas to the default workflow? This does not delete saved database workflows."
    );

    if (!confirmed) return;

    setNodes(initialNodes);
    setEdges(initialEdges);
    setWorkflowName("My Workflow");
    setSelectedNodeId(null);
    setExecution(null);
    setError("");
    setSaveMessage("Default workflow restored.");
  };

  const runWorkflow = async () => {
    setRunning(true);
    setError("");
    setExecution(null);

    try {
      const data = await apiRequest("/workflows/execute", {
        method: "POST",
        body: JSON.stringify({ nodes, edges }),
      });

      setExecution(data);
    } catch (err) {
      setError(`Workflow execution failed: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  const busy = running || saving;

  return (
    <main className="workflow-app">
      <header className="topbar">
        <div>
          <h1>Workflow Studio</h1>
          <p>Design and execute automated workflows</p>
          <small>{saveMessage}</small>
        </div>

        <div className="toolbar">
          <button
            className="secondary"
            onClick={saveWorkflow}
            disabled={busy}
          >
            {saving ? "Saving..." : "Save as New"}
          </button>

          <button
            className="secondary"
            onClick={updateWorkflow}
            disabled={busy || !selectedWorkflowId}
          >
            Update Selected
          </button>

          <button
            className="secondary"
            onClick={loadWorkflow}
            disabled={busy || !selectedWorkflowId}
          >
            Load Selected
          </button>

          <button
            className="secondary"
            onClick={deleteWorkflow}
            disabled={busy || !selectedWorkflowId}
          >
            Delete Selected
          </button>

          <button
            className="secondary"
            onClick={refreshWorkflows}
            disabled={busy}
          >
            Refresh List
          </button>

          <button
            className="secondary"
            onClick={resetWorkflow}
            disabled={busy}
          >
            Reset Canvas
          </button>

          <button
            className="secondary"
            onClick={addTask}
            disabled={busy}
          >
            + Add Task
          </button>

          <button onClick={runWorkflow} disabled={busy}>
            {running ? "Running..." : "▶ Run Workflow"}
          </button>
        </div>
      </header>

      <section className="execution-panel">
        <h2>Workflow Database</h2>

        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "end",
          }}
        >
          <label style={{ flex: "1 1 220px" }}>
            Workflow Name
            <input
              value={workflowName}
              onChange={(event) => setWorkflowName(event.target.value)}
              placeholder="Enter workflow name"
              disabled={busy}
            />
          </label>

          <label style={{ flex: "1 1 220px" }}>
            Saved Workflows
            <select
              value={selectedWorkflowId}
              onChange={(event) => {
                const id = event.target.value;
                setSelectedWorkflowId(id);

                const workflow = workflows.find(
                  (item) => String(getWorkflowId(item)) === id
                );

                if (workflow?.name) {
                  setWorkflowName(workflow.name);
                }
              }}
              disabled={busy}
            >
              <option value="">Select a workflow</option>
              {workflows.map((workflow, index) => {
                const id = getWorkflowId(workflow);

                return (
                  <option key={id || index} value={String(id)}>
                    {workflow.name || `Workflow ${index + 1}`}
                  </option>
                );
              })}
            </select>
          </label>
        </div>

        <p>
          Saved workflows: <strong>{workflows.length}</strong>
        </p>
      </section>

      <section className="editor">
        <div style={{ width: "100%", height: "100%" }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </div>
      </section>

      <section className="execution-panel" style={{ marginBottom: 20 }}>
        <h2>Task Settings</h2>

        {selectedNode ? (
          <div style={{ display: "grid", gap: 12, maxWidth: 450 }}>
            <label>
              Task Name
              <input
                value={selectedNode.data.label ?? ""}
                onChange={(event) =>
                  updateSelectedTask("label", event.target.value)
                }
              />
            </label>

            <label>
              Description
              <input
                value={selectedNode.data.description ?? ""}
                onChange={(event) =>
                  updateSelectedTask("description", event.target.value)
                }
              />
            </label>

            <button
              className="secondary"
              onClick={deleteSelectedTask}
              disabled={busy}
            >
              Delete Selected Task
            </button>
          </div>
        ) : (
          <p>Settings ke liye canvas par kisi task ko click karo.</p>
        )}
      </section>

      <section className="execution-panel">
        <h2>Execution Results</h2>

        {error && <p className="error">{error}</p>}

        {!execution && !error && (
          <p>Click Run Workflow to execute your tasks.</p>
        )}

        {execution && (
          <>
            <p>
              Execution ID: <code>{execution.executionId}</code>
            </p>

            <p>
              Workflow status:{" "}
              <strong
                className={
                  execution.status === "success" ? "success" : "error"
                }
              >
                {String(execution.status).toUpperCase()}
              </strong>
            </p>

            {(execution.results ?? []).map((task) => (
              <div className="result-row" key={task.nodeId}>
                <span>{task.label}</span>
                <span>
                  {String(task.status).toUpperCase()} · {task.attempts} attempt(s)
                </span>
              </div>
            ))}

            {(execution.compensations ?? []).length > 0 && (
              <>
                <h3>Compensation Results</h3>
                {execution.compensations.map((task) => (
                  <div className="result-row" key={task.nodeId}>
                    <span>{task.label}</span>
                    <span>{String(task.status).toUpperCase()}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}

export default App;