import { useCallback, useState } from "react";
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

function TaskNode({ data }) {
  return (
    <div className="task-node">
      <Handle type="target" position={Position.Top} />
      <strong>{data.label}</strong>
      <p>{data.description}</p>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

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
      compensation: {
        action: "restoreVariable",
      },
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
    data: { label: "Finish", description: "Complete workflow" },
  },
];

const initialEdges = [
  { id: "e1-2", source: "1", target: "2", animated: true },
  { id: "e2-3", source: "2", target: "3", animated: true },
];

function App() {
  const [nodes, setNodes, onNodesChange] =
    useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] =
    useEdgesState(initialEdges);

  const [running, setRunning] = useState(false);
  const [execution, setExecution] = useState(null);
  const [error, setError] = useState("");

  const onConnect = useCallback(
    (connection) => {
      setEdges((current) => addEdge(connection, current));
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

    setExecution(null);
  };

  const runWorkflow = async () => {
    setRunning(true);
    setError("");
    setExecution(null);

    try {
      const response = await fetch(
        "http://localhost:5000/api/workflows/execute",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nodes, edges }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Workflow failed");
      }

      setExecution(data);
    } catch (err) {
      setError(err.message || "Could not connect to backend.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <main className="workflow-app">
      <header className="topbar">
        <div>
          <h1>Workflow Studio</h1>
          <p>Design and execute automated workflows</p>
        </div>

        <div className="toolbar">
          <button className="secondary" onClick={addTask}>
            + Add Task
          </button>
          <button onClick={runWorkflow} disabled={running}>
            {running ? "Running..." : "▶ Run Workflow"}
          </button>
        </div>
      </header>

      <section className="editor">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
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
                {execution.status.toUpperCase()}
              </strong>
            </p>

            {execution.results.map((task) => (
              <div className="result-row" key={task.nodeId}>
                <span>{task.label}</span>
                <span>
                  {task.status.toUpperCase()} · {task.attempts} attempt(s)
                </span>
              </div>
            ))}

            {execution.compensations.length > 0 && (
              <>
                <h3>Compensation Results</h3>
                {execution.compensations.map((task) => (
                  <div className="result-row" key={task.nodeId}>
                    <span>{task.label}</span>
                    <span>{task.status.toUpperCase()}</span>
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