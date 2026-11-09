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

const defaultRetry = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

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
      value: "true",
      compensation: { action: "restoreVariable" },
      retry: { ...defaultRetry },
    },
  },
  {
    id: "2",
    type: "task",
    position: { x: 250, y: 180 },
    data: {
      label: "Process Data",
      description: "Execute task",
      action: "noop",
      retry: { ...defaultRetry },
    },
  },
  {
    id: "3",
    type: "task",
    position: { x: 250, y: 320 },
    data: {
      label: "Finish",
      description: "Complete workflow",
      action: "noop",
      retry: { ...defaultRetry },
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

function getStatus(value) {
  return String(value || "UNKNOWN").toUpperCase();
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function formatDuration(value) {
  if (value === undefined || value === null) return "—";

  const ms = Number(value);

  if (!Number.isFinite(ms)) return "—";

  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} sec`;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const responseText = await response.text();
  let data = {};

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = { error: responseText || "Invalid server response." };
  }

  if (!response.ok) {
    throw new Error(
      data.error || data.message || `Request failed (${response.status})`
    );
  }

  return data;
}

function StatusBadge({ status }) {
  const normalized = getStatus(status);

  return (
    <span className={`status-badge status-${normalized.toLowerCase()}`}>
      <span className="status-dot" />
      {normalized.replaceAll("_", " ")}
    </span>
  );
}

/* CUSTOM WORKFLOW NODE */

function TaskNode({ data, selected }) {
  const isCondition = data.action === "condition";

  return (
    <div
      className={`task-node ${selected ? "task-node-selected" : ""
        } ${isCondition ? "task-node-conditional" : ""}`}
    >
      <Handle type="target" position={Position.Top} />

      <div className="task-node-icon">
        {data.label === "Trigger"
          ? "▶️"
          : data.label === "Finish"
            ? "⚑"
            : isCondition
              ? "◇"
              : "⚙"}
      </div>

      <div className="task-node-content">
        <strong>{data.label || "Untitled Task"}</strong>
        <p>{data.description || "No description"}</p>

        {isCondition && (
          <small className="condition-node-label">IF / ELSE</small>
        )}
      </div>

      {isCondition ? (
        <>
          <div className="condition-handle condition-true">
            <span>TRUE</span>
            <Handle
              id="true"
              type="source"
              position={Position.Bottom}
              style={{ left: "50%" }}
            />
          </div>

          <div className="condition-handle condition-false">
            <span>FALSE</span>
            <Handle
              id="false"
              type="source"
              position={Position.Bottom}
              style={{ left: "50%" }}
            />
          </div>
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} />
      )}
    </div>
  );
}

const nodeTypes = { task: TaskNode };

/* MAIN APP */

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

  const [executionHistory, setExecutionHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const [selectedExecutionId, setSelectedExecutionId] = useState("");
  const [executionDetails, setExecutionDetails] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const selectedNode = nodes.find(
    (node) => node.id === selectedNodeId
  );

  /* LOCAL BACKUP */

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

  /* WORKFLOW DATABASE */

  const refreshWorkflows = async () => {
    setError("");

    try {
      const data = await apiRequest("/workflows");
      const list = Array.isArray(data)
        ? data
        : data.workflows ?? [];

      setWorkflows(list);
      setSaveMessage(
        `${list.length} workflow(s) found in database`
      );

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

  useEffect(() => {
    refreshWorkflows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* EXECUTION HISTORY */

  const refreshExecutionHistory = async () => {
    setHistoryLoading(true);
    setHistoryError("");

    try {
      const data = await apiRequest("/workflows/executions");
      const list = Array.isArray(data.executions)
        ? data.executions
        : [];

      setExecutionHistory(list);

      if (
        selectedExecutionId &&
        !list.some(
          (item) => item.executionId === selectedExecutionId
        )
      ) {
        setSelectedExecutionId("");
        setExecutionDetails(null);
      }
    } catch (err) {
      setHistoryError(
        `Could not load execution history: ${err.message}`
      );
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    refreshExecutionHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const viewExecutionDetails = async (executionId) => {
    if (!executionId) return;

    setSelectedExecutionId(executionId);
    setExecutionDetails(null);
    setDetailsLoading(true);
    setHistoryError("");

    try {
      const data = await apiRequest(
        `/workflows/executions/${encodeURIComponent(executionId)}`
      );

      setExecutionDetails(data);
    } catch (err) {
      setHistoryError(
        `Could not load execution details: ${err.message}`
      );
    } finally {
      setDetailsLoading(false);
    }
  };

  const closeDetails = () => {
    setSelectedExecutionId("");
    setExecutionDetails(null);
    setHistoryError("");
  };

  /* CANVAS CONNECTION */

  const onConnect = useCallback(
    (connection) => {
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            animated: true,
          },
          current
        )
      );

      setExecution(null);
    },
    [setEdges]
  );

  /* ADD TASK */

  const addTask = () => {
    const id = crypto.randomUUID();

    const newNode = {
      id,
      type: "task",
      position: {
        x: 100 + Math.random() * 350,
        y: 100 + Math.random() * 300,
      },
      data: {
        label: "New Task",
        description: "Configure this task",
        action: "noop",
        retry: { ...defaultRetry },
      },
    };

    setNodes((current) => [...current, newNode]);
    setSelectedNodeId(id);
    setExecution(null);
    setError("");
  };

  /* UPDATE SELECTED TASK */

  const updateSelectedTask = (field, value) => {
    if (!selectedNodeId) return;

    setNodes((current) =>
      current.map((node) => {
        if (node.id !== selectedNodeId) return node;

        const updatedData = {
          ...node.data,
          [field]: value,
        };

        // Keep legacy uppercase Value compatible with backend.
        if (field === "value") {
          delete updatedData.Value;
        }

        // Initialize required settings when action changes.
        if (field === "action") {
          updatedData.retry = {
            ...defaultRetry,
            ...(node.data.retry || {}),
          };

          if (value === "condition") {
            updatedData.condition = {
              variable: "",
              operator: "equals",
              value: "",
              ...(node.data.condition || {}),
            };
          }

          if (value === "setVariable") {
            updatedData.key = node.data.key ?? "";
            updatedData.value =
              node.data.value ?? node.data.Value ?? "";

            updatedData.compensation = {
              action: "restoreVariable",
              ...(node.data.compensation || {}),
            };
          }

          if (value === "wait") {
            updatedData.durationMs =
              node.data.durationMs ?? 1000;
          }
        }

        if (field === "retry") {
          updatedData.retry = {
            ...defaultRetry,
            ...(node.data.retry || {}),
            ...value,
          };
        }

        if (field === "condition") {
          updatedData.condition = {
            variable: "",
            operator: "equals",
            value: "",
            ...(node.data.condition || {}),
            ...value,
          };
        }

        if (field === "compensation") {
          updatedData.compensation = value;
        }

        return {
          ...node,
          data: updatedData,
        };
      })
    );

    setExecution(null);
  };

  /* DELETE SELECTED TASK */

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

  /* SAVE NEW WORKFLOW */

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

      const data = await apiRequest("/workflows");

      const list = Array.isArray(data)
        ? data
        : data.workflows ?? [];

      setWorkflows(list);

      const newestMatch = list.find(
        (workflow) =>
          workflow.name === workflowName.trim()
      );

      if (newestMatch) {
        setSelectedWorkflowId(
          String(getWorkflowId(newestMatch))
        );
      }

      setSaveMessage(
        "Workflow saved to MongoDB successfully!"
      );
    } catch (err) {
      setError(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  /* LOAD WORKFLOW */

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
        throw new Error(
          "The saved workflow has an invalid format."
        );
      }

      setNodes(workflow.nodes);
      setEdges(workflow.edges);
      setWorkflowName(workflow.name || "My Workflow");
      setSelectedNodeId(null);
      setExecution(null);

      setSaveMessage(
        `Loaded: ${workflow.name || "Workflow"}`
      );
    } catch (err) {
      setError(`Load failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  /* UPDATE WORKFLOW */

  const updateWorkflow = async () => {
    if (!selectedWorkflowId) {
      setError(
        "Select a saved workflow before updating."
      );
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

      setSaveMessage(
        "Workflow updated in MongoDB successfully!"
      );
    } catch (err) {
      setError(`Update failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  /* DELETE WORKFLOW */

  const deleteWorkflow = async () => {
    if (!selectedWorkflowId) {
      setError("Select a saved workflow to delete.");
      return;
    }

    if (
      !window.confirm(
        "Delete this workflow from MongoDB? This cannot be undone."
      )
    ) {
      return;
    }

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

  /* RESET CANVAS */

  const resetWorkflow = () => {
    if (
      !window.confirm(
        "Reset the canvas to the default workflow? This does not delete saved database workflows."
      )
    ) {
      return;
    }

    setNodes(initialNodes);
    setEdges(initialEdges);
    setWorkflowName("My Workflow");
    setSelectedNodeId(null);
    setExecution(null);
    setError("");
    setSaveMessage("Default workflow restored.");
  };

  /* NORMALIZE DATA BEFORE EXECUTION */

  const normalizeNodesForExecution = () =>
    nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        ...(node.data?.value === undefined &&
          node.data?.Value !== undefined
          ? { value: node.data.Value }
          : {}),
        retry: {
          ...defaultRetry,
          ...(node.data?.retry || {}),
        },
      },
    }));

  /* RUN WORKFLOW */

  const runWorkflow = async () => {
    setRunning(true);
    setError("");
    setExecution(null);

    try {
      const data = await apiRequest("/workflows/execute", {
        method: "POST",
        body: JSON.stringify({
          nodes: normalizeNodesForExecution(),
          edges,
        }),
      });

      setExecution(data);
      await refreshExecutionHistory();
    } catch (err) {
      setError(
        `Workflow execution failed: ${err.message}`
      );
    } finally {
      setRunning(false);
    }
  };

  /* DASHBOARD COUNTS */

  const busy = running || saving;

  const totalExecutions = executionHistory.length;

  const successfulExecutions = executionHistory.filter(
    (item) => getStatus(item.status) === "SUCCESS"
  ).length;

  const failedExecutions = executionHistory.filter(
    (item) =>
      ["FAILED", "COMPENSATION_FAILED"].includes(
        getStatus(item.status)
      )
  ).length;

  const otherExecutions =
    totalExecutions -
    successfulExecutions -
    failedExecutions;

  const detailResults = Array.isArray(
    executionDetails?.results
  )
    ? executionDetails.results
    : [];

  const detailCompensations = Array.isArray(
    executionDetails?.compensations
  )
    ? executionDetails.compensations
    : [];

  return (
    <div className="app-shell">
      {/* SIDEBAR */}

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span />
            <span />
            <span />
            <span />
          </div>

          <div>
            <strong>Workflow</strong>
            <strong>Studio</strong>
          </div>
        </div>

        <nav className="side-nav">
          <a className="nav-item active" href="#dashboard">
            <span>⌂</span> Dashboard
          </a>

          <a className="nav-item" href="#workflow-studio">
            <span>▦</span> Workflow Studio
          </a>

          <a className="nav-item" href="#executions">
            <span>▤</span> Executions
          </a>

          <a className="nav-item" href="#analytics">
            <span>▥</span> Analytics
          </a>

          <a className="nav-item" href="#settings">
            <span>⚙</span> Settings
          </a>
        </nav>

        <div className="sidebar-bottom">
          <span className="connection-indicator" />

          <div>
            <strong>MongoDB</strong>
            <small>Database connection</small>
          </div>

          <span className="connected-label">●</span>
        </div>
      </aside>

      {/* MAIN CONTENT */}

      <main className="main-content" id="dashboard">
        <header className="topbar">
          <div className="search-box">
            <span>⌕</span>
            <input
              type="search"
              placeholder="Search workflows, executions..."
              aria-label="Search workflows and executions"
            />
          </div>

          <div className="topbar-actions">
            <span className="notification-icon">♧</span>
            <div className="profile-avatar">WS</div>
          </div>
        </header>

        <div className="page-content">
          {/* PAGE HEADING */}

          <section className="page-heading">
            <div>
              <span className="eyebrow">
                WORKSPACE OVERVIEW
              </span>

              <h1>Workflow Orchestration Dashboard</h1>

              <p>
                Design, manage and execute automated workflows
              </p>
            </div>

            <div className="system-status">
              <span className="connection-indicator" />
              All systems operational
            </div>
          </section>

          {error && (
            <div className="alert alert-error">
              ⚠ {error}
            </div>
          )}

          {/* OVERVIEW CARDS */}

          <section className="overview-grid">
            <div className="overview-card">
              <div className="overview-icon blue-icon">
                ⌘
              </div>

              <div>
                <span>Total Workflows</span>
                <strong>{workflows.length}</strong>
                <small>Saved in database</small>
              </div>
            </div>

            <div className="overview-card">
              <div className="overview-icon purple-icon">
                ▶️
              </div>

              <div>
                <span>Total Executions</span>
                <strong>{totalExecutions}</strong>
                <small>Recorded executions</small>
              </div>
            </div>

            <div className="overview-card">
              <div className="overview-icon green-icon">
                ✓
              </div>

              <div>
                <span>Successful</span>
                <strong>{successfulExecutions}</strong>
                <small>Completed successfully</small>
              </div>
            </div>

            <div className="overview-card">
              <div className="overview-icon red-icon">
                ×
              </div>

              <div>
                <span>Failed</span>
                <strong>{failedExecutions}</strong>
                <small>Requires attention</small>
              </div>
            </div>
          </section>

          {/* WORKFLOW STUDIO */}

          <section
            className="workspace-grid"
            id="workflow-studio"
          >
            <div className="panel workflow-panel">
              <div className="panel-heading">
                <div className="heading-icon">✣</div>

                <div>
                  <h2>Workflow Studio</h2>
                  <p>
                    Design your workflow using the visual editor
                  </p>
                </div>

                <span className="panel-tag">
                  VISUAL EDITOR
                </span>
              </div>

              <div className="workflow-toolbar">
                <button
                  onClick={saveWorkflow}
                  disabled={busy}
                >
                  {saving ? "Saving..." : "Save as New"}
                </button>

                <button
                  className="outline-button"
                  onClick={updateWorkflow}
                  disabled={busy || !selectedWorkflowId}
                >
                  Update
                </button>

                <button
                  className="outline-button"
                  onClick={loadWorkflow}
                  disabled={busy || !selectedWorkflowId}
                >
                  Load
                </button>

                <button
                  className="danger-button"
                  onClick={deleteWorkflow}
                  disabled={busy || !selectedWorkflowId}
                >
                  Delete
                </button>

                <button
                  className="outline-button"
                  onClick={refreshWorkflows}
                  disabled={busy}
                >
                  Refresh
                </button>

                <button
                  className="outline-button"
                  onClick={resetWorkflow}
                  disabled={busy}
                >
                  Reset
                </button>

                <button
                  className="outline-button add-task-button"
                  onClick={addTask}
                  disabled={busy}
                >
                  + Add Task
                </button>

                <button
                  className="run-button"
                  onClick={runWorkflow}
                  disabled={busy}
                >
                  {running ? "Running..." : "▶️ Run Workflow"}
                </button>
              </div>

              <div className="save-status">
                <span className="connection-indicator" />
                {saveMessage}
              </div>

              <div className="flow-container">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onNodeClick={(_, node) =>
                    setSelectedNodeId(node.id)
                  }
                  onPaneClick={() =>
                    setSelectedNodeId(null)
                  }
                  fitView
                >
                  <Background
                    color="#29456c"
                    gap={20}
                    size={1}
                  />

                  <Controls />

                  <MiniMap
                    nodeColor={(node) =>
                      node.selected ? "#38bdf8" : "#2877df"
                    }
                    maskColor="rgba(4, 13, 31, 0.75)"
                  />
                </ReactFlow>
              </div>
            </div>

            {/* RIGHT COLUMN */}

            <div className="right-column">
              {/* WORKFLOW DATABASE */}

              <section className="panel database-panel">
                <div className="panel-heading">
                  <div className="heading-icon">▤</div>

                  <div>
                    <h2>Workflow Database</h2>
                    <p>Saved workflows in MongoDB</p>
                  </div>
                </div>

                <label className="field-label">
                  Workflow Name

                  <input
                    value={workflowName}
                    onChange={(event) =>
                      setWorkflowName(event.target.value)
                    }
                    placeholder="Enter workflow name"
                    disabled={busy}
                  />
                </label>

                <label className="field-label">
                  Saved Workflows

                  <select
                    value={selectedWorkflowId}
                    onChange={(event) => {
                      const id = event.target.value;

                      setSelectedWorkflowId(id);

                      const workflow = workflows.find(
                        (item) =>
                          String(getWorkflowId(item)) === id
                      );

                      if (workflow?.name) {
                        setWorkflowName(workflow.name);
                      }
                    }}
                    disabled={busy}
                  >
                    <option value="">
                      Select a workflow
                    </option>

                    {workflows.map((workflow, index) => {
                      const id = getWorkflowId(workflow);

                      return (
                        <option
                          key={id || index}
                          value={String(id)}
                        >
                          {workflow.name ||
                            `Workflow ${index + 1}`}
                        </option>
                      );
                    })}
                  </select>
                </label>

                <div className="saved-count">
                  Saved workflows:{" "}
                  <strong>{workflows.length}</strong>
                </div>

                <div className="saved-workflow-list">
                  {workflows.slice(0, 5).map(
                    (workflow, index) => (
                      <div
                        className="saved-workflow-item"
                        key={
                          getWorkflowId(workflow) || index
                        }
                      >
                        <div className="saved-workflow-icon">
                          ✣
                        </div>

                        <div className="saved-workflow-info">
                          <strong>
                            {workflow.name ||
                              `Workflow ${index + 1}`}
                          </strong>

                          <small>
                            MongoDB saved workflow
                          </small>
                        </div>

                        <button
                          className="mini-button"
                          onClick={() => {
                            setSelectedWorkflowId(
                              String(getWorkflowId(workflow))
                            );

                            setWorkflowName(
                              workflow.name || "My Workflow"
                            );
                          }}
                        >
                          Select
                        </button>
                      </div>
                    )
                  )}

                  {workflows.length === 0 && (
                    <p className="muted-text">
                      No saved workflows yet.
                    </p>
                  )}
                </div>
              </section>

              {/* TASK SETTINGS */}

              <section
                className="panel task-settings-panel"
                id="settings"
              >
                <div className="panel-heading">
                  <div className="heading-icon">⚙</div>

                  <div>
                    <h2>Task Settings</h2>
                    <p>
                      Configure the selected workflow task
                    </p>
                  </div>
                </div>

                {selectedNode ? (
                  <div className="task-settings">
                    <label className="field-label">
                      Task Name

                      <input
                        value={selectedNode.data.label ?? ""}
                        onChange={(event) =>
                          updateSelectedTask(
                            "label",
                            event.target.value
                          )
                        }
                        disabled={busy}
                      />
                    </label>

                    <label className="field-label">
                      Description

                      <input
                        value={
                          selectedNode.data.description ?? ""
                        }
                        onChange={(event) =>
                          updateSelectedTask(
                            "description",
                            event.target.value
                          )
                        }
                        disabled={busy}
                      />
                    </label>

                    <label className="field-label">
                      Task Action

                      <select
                        value={
                          selectedNode.data.action || "noop"
                        }
                        onChange={(event) =>
                          updateSelectedTask(
                            "action",
                            event.target.value
                          )
                        }
                        disabled={busy}
                      >
                        <option value="noop">
                          No Operation
                        </option>

                        <option value="wait">
                          Wait / Delay
                        </option>

                        <option value="setVariable">
                          Set Variable
                        </option>

                        <option value="condition">
                          Condition (IF / ELSE)
                        </option>

                        <option value="fail">
                          Force Failure (Testing)
                        </option>
                      </select>
                    </label>

                    {/* SET VARIABLE */}

                    {selectedNode.data.action ===
                      "setVariable" && (
                        <>
                          <h3 className="settings-section-title">
                            Variable Settings
                          </h3>

                          <label className="field-label">
                            Variable Name

                            <input
                              value={selectedNode.data.key ?? ""}
                              onChange={(event) =>
                                updateSelectedTask(
                                  "key",
                                  event.target.value
                                )
                              }
                              placeholder="e.g. workflowStarted"
                              disabled={busy}
                            />
                          </label>

                          <label className="field-label">
                            Variable Value

                            <input
                              value={
                                selectedNode.data.value ??
                                selectedNode.data.Value ??
                                ""
                              }
                              onChange={(event) =>
                                updateSelectedTask(
                                  "value",
                                  event.target.value
                                )
                              }
                              placeholder="e.g. true"
                              disabled={busy}
                            />
                          </label>
                        </>
                      )}

                    {/* WAIT SETTINGS */}

                    {selectedNode.data.action === "wait" && (
                      <>
                        <h3 className="settings-section-title">
                          Wait Settings
                        </h3>

                        <label className="field-label">
                          Duration (milliseconds)

                          <input
                            type="number"
                            min="0"
                            max="10000"
                            value={
                              selectedNode.data.durationMs ?? 1000
                            }
                            onChange={(event) =>
                              updateSelectedTask(
                                "durationMs",
                                Math.max(
                                  0,
                                  Math.min(
                                    10000,
                                    Number(event.target.value)
                                  )
                                )
                              )
                            }
                            disabled={busy}
                          />
                        </label>
                      </>
                    )}

                    {/* CONDITION SETTINGS */}

                    {selectedNode.data.action ===
                      "condition" && (
                        <>
                          <h3 className="settings-section-title">
                            Condition Settings
                          </h3>

                          <label className="field-label">
                            Variable to Check

                            <input
                              value={
                                selectedNode.data.condition
                                  ?.variable ?? ""
                              }
                              onChange={(event) =>
                                updateSelectedTask(
                                  "condition",
                                  {
                                    variable: event.target.value,
                                  }
                                )
                              }
                              placeholder="e.g. workflowStarted"
                              disabled={busy}
                            />
                          </label>

                          <label className="field-label">
                            Operator

                            <select
                              value={
                                selectedNode.data.condition
                                  ?.operator ?? "equals"
                              }
                              onChange={(event) =>
                                updateSelectedTask(
                                  "condition",
                                  {
                                    operator: event.target.value,
                                  }
                                )
                              }
                              disabled={busy}
                            >
                              <option value="equals">
                                Equals
                              </option>

                              <option value="notEquals">
                                Not Equals
                              </option>

                              <option value="greaterThan">
                                Greater Than
                              </option>

                              <option value="lessThan">
                                Less Than
                              </option>

                              <option value="contains">
                                Contains
                              </option>

                              <option value="exists">
                                Exists
                              </option>

                              <option value="isTrue">
                                Is True
                              </option>

                              <option value="isFalse">
                                Is False
                              </option>
                            </select>
                          </label>

                          <label className="field-label">
                            Expected Value

                            <input
                              value={
                                selectedNode.data.condition
                                  ?.value ?? ""
                              }
                              onChange={(event) =>
                                updateSelectedTask(
                                  "condition",
                                  {
                                    value: event.target.value,
                                  }
                                )
                              }
                              placeholder="e.g. true"
                              disabled={busy}
                            />
                          </label>

                          <div className="condition-info">
                            <strong>IF / ELSE Branching</strong>
                            <p>
                              Canvas par TRUE aur FALSE handles
                              se alag tasks connect karo.
                            </p>
                          </div>
                        </>
                      )}

                    {/* RETRY SETTINGS */}

                    <h3 className="settings-section-title">
                      Retry Configuration
                    </h3>

                    <label className="field-label">
                      Maximum Attempts

                      <input
                        type="number"
                        min="1"
                        max="10"
                        value={
                          selectedNode.data.retry?.maxAttempts ??
                          defaultRetry.maxAttempts
                        }
                        onChange={(event) =>
                          updateSelectedTask("retry", {
                            maxAttempts: Math.max(
                              1,
                              Math.min(
                                10,
                                Number(event.target.value)
                              )
                            ),
                          })
                        }
                        disabled={busy}
                      />
                    </label>

                    <label className="field-label">
                      Initial Retry Delay (ms)

                      <input
                        type="number"
                        min="0"
                        max="30000"
                        value={
                          selectedNode.data.retry?.initialDelayMs ??
                          defaultRetry.initialDelayMs
                        }
                        onChange={(event) =>
                          updateSelectedTask("retry", {
                            initialDelayMs: Math.max(
                              0,
                              Math.min(
                                30000,
                                Number(event.target.value)
                              )
                            ),
                          })
                        }
                        disabled={busy}
                      />
                    </label>

                    <label className="field-label">
                      Maximum Retry Delay (ms)

                      <input
                        type="number"
                        min="0"
                        max="60000"
                        value={
                          selectedNode.data.retry?.maxDelayMs ??
                          defaultRetry.maxDelayMs
                        }
                        onChange={(event) =>
                          updateSelectedTask("retry", {
                            maxDelayMs: Math.max(
                              0,
                              Math.min(
                                60000,
                                Number(event.target.value)
                              )
                            ),
                          })
                        }
                        disabled={busy}
                      />
                    </label>

                    <label className="field-label">
                      Backoff Multiplier

                      <input
                        type="number"
                        min="1"
                        max="10"
                        step="0.5"
                        value={
                          selectedNode.data.retry
                            ?.backoffMultiplier ??
                          defaultRetry.backoffMultiplier
                        }
                        onChange={(event) =>
                          updateSelectedTask("retry", {
                            backoffMultiplier: Math.max(
                              1,
                              Math.min(
                                10,
                                Number(event.target.value)
                              )
                            ),
                          })
                        }
                        disabled={busy}
                      />
                    </label>

                    {/* FAILURE TESTING */}

                    <label className="field-label checkbox-field">
                      <input
                        type="checkbox"
                        checked={
                          selectedNode.data.simulateFailure === true
                        }
                        onChange={(event) =>
                          updateSelectedTask(
                            "simulateFailure",
                            event.target.checked
                          )
                        }
                        disabled={busy}
                      />

                      <span>Simulate Task Failure</span>
                    </label>

                    {/* SAGA COMPENSATION */}

                    <h3 className="settings-section-title">
                      Saga Compensation
                    </h3>

                    <label className="field-label">
                      Compensation Action

                      <select
                        value={
                          selectedNode.data.compensation?.action ?? ""
                        }
                        onChange={(event) =>
                          updateSelectedTask(
                            "compensation",
                            event.target.value
                              ? { action: event.target.value }
                              : {}
                          )
                        }
                        disabled={busy}
                      >
                        <option value="">
                          No Compensation
                        </option>

                        <option value="restoreVariable">
                          Restore Previous Variable
                        </option>
                      </select>
                    </label>

                    <button
                      className="danger-button full-button"
                      onClick={deleteSelectedTask}
                      disabled={busy}
                    >
                      Delete Selected Task
                    </button>
                  </div>
                ) : (
                  <div className="empty-settings">
                    <span>⚙</span>

                    <p>
                      Settings ke liye canvas par kisi task
                      ko click karo.
                    </p>
                  </div>
                )}
              </section>
            </div>
          </section>

          {/* EXECUTION RESULTS */}

          <section className="panel results-panel">
            <div className="panel-heading">
              <div className="heading-icon">▣</div>

              <div>
                <h2>Execution Results</h2>
                <p>
                  Latest workflow execution output
                </p>
              </div>
            </div>

            {!execution && !error && (
              <div className="empty-results">
                <span>▶️</span>
                <p>
                  Click Run Workflow to execute your tasks.
                </p>
              </div>
            )}

            {execution && (
              <div className="execution-output">
                <div className="execution-output-header">
                  <div>
                    <small>EXECUTION ID</small>
                    <code>{execution.executionId}</code>
                  </div>

                  <div>
                    <small>WORKFLOW STATUS</small>
                    <StatusBadge status={execution.status} />
                  </div>
                </div>

                {(execution.results ?? []).map(
                  (task, index) => (
                    <div
                      className="result-row"
                      key={
                        task.nodeId ??
                        task.taskId ??
                        index
                      }
                    >
                      <span>
                        {task.label ??
                          task.taskName ??
                          task.taskId ??
                          task.nodeId}
                      </span>

                      <span>
                        <StatusBadge status={task.status} />
                        <small>
                          {task.attempts ?? "—"} attempt(s)
                        </small>
                      </span>
                    </div>
                  )
                )}

                {(execution.compensations ?? []).length > 0 && (
                  <>
                    <h3 className="detail-section-title">
                      Compensation Results
                    </h3>

                    {execution.compensations.map(
                      (task, index) => (
                        <div
                          className="result-row"
                          key={
                            task.nodeId ??
                            task.taskId ??
                            index
                          }
                        >
                          <span>
                            {task.label ??
                              task.taskName ??
                              task.taskId}
                          </span>

                          <StatusBadge status={task.status} />
                        </div>
                      )
                    )}
                  </>
                )}
              </div>
            )}
          </section>

          {/* EXECUTION DASHBOARD */}

          <section
            className="panel dashboard-panel"
            id="executions"
          >
            <div className="panel-heading dashboard-heading">
              <div className="heading-icon">▥</div>

              <div>
                <h2>Execution Dashboard</h2>
                <p>
                  Monitor workflow executions stored in MongoDB
                </p>
              </div>

              <button
                className="outline-button refresh-history"
                onClick={refreshExecutionHistory}
                disabled={historyLoading}
              >
                {historyLoading
                  ? "Refreshing..."
                  : "↻ Refresh History"}
              </button>
            </div>

            <div className="stats-grid">
              <div className="stat-card">
                <span className="stat-symbol blue-icon">
                  ▶️
                </span>

                <div>
                  <small>Total Executions</small>
                  <strong>{totalExecutions}</strong>
                </div>
              </div>

              <div className="stat-card success-card">
                <span className="stat-symbol green-icon">
                  ✓
                </span>

                <div>
                  <small>Successful</small>
                  <strong>{successfulExecutions}</strong>
                </div>
              </div>

              <div className="stat-card failed-card">
                <span className="stat-symbol red-icon">
                  ×
                </span>

                <div>
                  <small>Failed</small>
                  <strong>{failedExecutions}</strong>
                </div>
              </div>

              <div className="stat-card">
                <span className="stat-symbol purple-icon">
                  ◉
                </span>

                <div>
                  <small>Other Status</small>
                  <strong>{otherExecutions}</strong>
                </div>
              </div>
            </div>

            {historyError && (
              <div className="alert alert-error">
                {historyError}
              </div>
            )}

            <div className="history-heading">
              <div>
                <h3>Recent Execution History</h3>
                <p>Latest execution activity</p>
              </div>

              <span className="record-count">
                {executionHistory.length} records
              </span>
            </div>

            {historyLoading &&
              executionHistory.length === 0 && (
                <p className="muted-text">
                  Loading execution history...
                </p>
              )}

            {!historyLoading &&
              executionHistory.length === 0 && (
                <p className="muted-text">
                  No execution records found.
                </p>
              )}

            {executionHistory.length > 0 && (
              <div className="table-wrapper">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>Execution ID</th>
                      <th>Status</th>
                      <th>Started At</th>
                      <th>Duration</th>
                      <th>Failed Task</th>
                      <th>Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {executionHistory.map((item) => (
                      <tr
                        key={item.executionId}
                        className={
                          selectedExecutionId ===
                            item.executionId
                            ? "selected-history-row"
                            : ""
                        }
                      >
                        <td className="execution-id-cell">
                          {item.executionId}
                        </td>

                        <td>
                          <StatusBadge status={item.status} />
                        </td>

                        <td>{formatDate(item.startedAt)}</td>

                        <td>
                          {formatDuration(item.durationMs)}
                        </td>

                        <td>
                          {item.failedTask?.taskName ||
                            item.failedTask?.taskId ||
                            "—"}
                        </td>

                        <td>
                          <button
                            className="view-button"
                            onClick={() =>
                              viewExecutionDetails(
                                item.executionId
                              )
                            }
                            disabled={detailsLoading}
                          >
                            View Details
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* EXECUTION DETAILS */}

          {selectedExecutionId && (
            <section className="panel details-panel">
              <div className="panel-heading details-heading">
                <div className="heading-icon">▤</div>

                <div>
                  <h2>Execution Details</h2>
                  <p className="detail-id">
                    {selectedExecutionId}
                  </p>
                </div>

                <button
                  className="outline-button"
                  onClick={closeDetails}
                >
                  Close Details
                </button>
              </div>

              {detailsLoading && (
                <p className="muted-text">
                  Loading execution details...
                </p>
              )}

              {executionDetails && (
                <>
                  <div className="detail-summary">
                    <div>
                      <small>Status</small>
                      <StatusBadge
                        status={executionDetails.status}
                      />
                    </div>

                    <div>
                      <small>Started</small>
                      <strong>
                        {formatDate(executionDetails.startedAt)}
                      </strong>
                    </div>

                    <div>
                      <small>Finished</small>
                      <strong>
                        {formatDate(executionDetails.finishedAt)}
                      </strong>
                    </div>

                    <div>
                      <small>Duration</small>
                      <strong>
                        {formatDuration(
                          executionDetails.durationMs
                        )}
                      </strong>
                    </div>
                  </div>

                  {executionDetails.failedTask && (
                    <div className="failure-box">
                      <h4>Failure Information</h4>

                      <p>
                        <strong>Task:</strong>{" "}
                        {executionDetails.failedTask.taskName ||
                          executionDetails.failedTask.taskId ||
                          "Unknown"}
                      </p>

                      <p>
                        <strong>Error:</strong>{" "}
                        {executionDetails.failedTask.error ||
                          executionDetails.error ||
                          "No error message available."}
                      </p>
                    </div>
                  )}

                  {executionDetails.error &&
                    !executionDetails.failedTask && (
                      <div className="failure-box">
                        <h4>Execution Error</h4>
                        <p>{executionDetails.error}</p>
                      </div>
                    )}

                  <h3 className="detail-section-title">
                    Task Execution Results
                  </h3>

                  {detailResults.length === 0 && (
                    <p className="muted-text">
                      No individual task results were stored.
                    </p>
                  )}

                  {detailResults.map((task, index) => (
                    <div
                      className="detail-task-row"
                      key={
                        task.nodeId ??
                        task.taskId ??
                        index
                      }
                    >
                      <div>
                        <strong>
                          {task.label ??
                            task.taskName ??
                            task.nodeId ??
                            `Task ${index + 1}`}
                        </strong>

                        {task.error && (
                          <p className="task-error">
                            {task.error}
                          </p>
                        )}
                      </div>

                      <div className="task-result-meta">
                        <StatusBadge status={task.status} />

                        <span>
                          Attempts:{" "}
                          {task.attempts ??
                            task.attemptCount ??
                            "—"}
                        </span>
                      </div>
                    </div>
                  ))}

                  <h3 className="detail-section-title">
                    Saga Compensation Results
                  </h3>

                  {detailCompensations.length === 0 && (
                    <p className="muted-text">
                      No compensation records for this execution.
                    </p>
                  )}

                  {detailCompensations.map((item, index) => (
                    <div
                      className="detail-task-row"
                      key={
                        item.nodeId ??
                        item.taskId ??
                        index
                      }
                    >
                      <div>
                        <strong>
                          {item.label ??
                            item.taskName ??
                            item.taskId ??
                            `Task ${index + 1}`}
                        </strong>

                        {item.message && (
                          <p>{item.message}</p>
                        )}

                        {item.error && (
                          <p className="task-error">
                            {item.error}
                          </p>
                        )}
                      </div>

                      <StatusBadge status={item.status} />
                    </div>
                  ))}
                </>
              )}
            </section>
          )}

          {/* FOOTER */}

          <footer className="app-footer">
            <span>Workflow Studio</span>
            <span>
              Distributed Workflow & Saga Orchestration Engine
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}

export default App;