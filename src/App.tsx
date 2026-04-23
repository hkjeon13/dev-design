import { useEffect, useMemo, useState } from "react";
import { analyzeSourceFiles } from "./lib/analyzer";
import { applyCssRuleUpdate } from "./lib/cssTransforms";
import {
  applyInlineStyleUpdate,
  applyStructureOperation,
  applyTailwindUpdate,
  getClassTarget,
} from "./lib/jsxTransforms";
import {
  applySync,
  createSyncPlan,
  installDependencies,
  openProject,
  pickProjectDirectory,
  startPreview,
  stopPreview,
  writeSnapshotFile,
} from "./lib/tauri";
import type {
  AnalysisResult,
  ChangedFile,
  EditOperation,
  PreviewResponse,
  ProjectNode,
  ProjectSnapshot,
  SourceFile,
  StructureOperation,
  StyleMode,
  StyleUpdate,
  SyncPlan,
} from "./lib/types";

const STYLE_PROPERTIES = [
  "width",
  "height",
  "margin",
  "padding",
  "gap",
  "font-size",
  "font-weight",
  "color",
  "background-color",
  "border",
  "border-radius",
  "display",
  "align-items",
  "justify-content",
  "visibility",
];

type StatusTone = "neutral" | "success" | "warning" | "error";

interface StatusMessage {
  tone: StatusTone;
  text: string;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [sourceFiles, setSourceFiles] = useState<SourceFile[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [styleMode, setStyleMode] = useState<StyleMode>("tailwind");
  const [styleProperty, setStyleProperty] = useState("width");
  const [styleValue, setStyleValue] = useState("320px");
  const [codeDraft, setCodeDraft] = useState("");
  const [syncPlan, setSyncPlan] = useState<SyncPlan | null>(null);
  const [selectedSyncFiles, setSelectedSyncFiles] = useState<Set<string>>(new Set());
  const [editLog, setEditLog] = useState<EditOperation[]>([]);

  const nodeMap = useMemo(() => new Map((analysis?.nodes ?? []).map((node) => [node.id, node])), [analysis]);
  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) ?? null : null;
  const selectedFile = selectedNode ? sourceFiles.find((file) => file.path === selectedNode.sourceFile) ?? null : null;
  const rootNodes = useMemo(
    () => (analysis?.nodes ?? []).filter((node) => node.parentId === null),
    [analysis],
  );

  useEffect(() => {
    if (selectedFile) {
      setCodeDraft(selectedFile.content);
    } else {
      setCodeDraft("");
    }
  }, [selectedFile?.path, selectedFile?.content]);

  useEffect(() => {
    function handlePreviewMessage(event: MessageEvent) {
      if (event.data?.type !== "dev-design-select" || typeof event.data.id !== "string") {
        return;
      }
      if (nodeMap.has(event.data.id)) {
        setSelectedNodeId(event.data.id);
      }
    }
    window.addEventListener("message", handlePreviewMessage);
    return () => window.removeEventListener("message", handlePreviewMessage);
  }, [nodeMap]);

  async function handleOpenProject() {
    const path = await pickProjectDirectory();
    if (!path) {
      return;
    }
    setBusy(true);
    setStatus({ tone: "neutral", text: "Opening project snapshot..." });
    try {
      const response = await openProject(path);
      setSnapshot(response.snapshot);
      await reanalyzeAndPersist(response.snapshot.id, response.sourceFiles);
      setSelectedNodeId(null);
      setPreview(null);
      setSyncPlan(null);
      setStatus({
        tone: response.warnings.length > 0 ? "warning" : "success",
        text: response.warnings[0] ?? `Snapshot created at ${response.snapshot.snapshotPath}`,
      });
    } catch (error) {
      setStatus({ tone: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function reanalyzeAndPersist(snapshotId: string, files: SourceFile[]) {
    const result = analyzeSourceFiles(files);
    const writes = result.sourceFiles
      .filter((file) => files.find((previous) => previous.path === file.path)?.content !== file.content)
      .map((file) => writeSnapshotFile(snapshotId, file.path, file.content));
    if (writes.length > 0) {
      await Promise.all(writes);
    }
    setSourceFiles(result.sourceFiles);
    setAnalysis(result);
    if (result.warnings.length > 0) {
      setStatus({ tone: "warning", text: result.warnings[0] });
    }
  }

  async function handleInstallDependencies() {
    if (!snapshot) {
      return;
    }
    setBusy(true);
    setStatus({ tone: "neutral", text: "Installing snapshot dependencies..." });
    try {
      await installDependencies(snapshot.id);
      setStatus({ tone: "success", text: "Dependencies installed in the internal snapshot." });
    } catch (error) {
      setStatus({ tone: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleStartPreview() {
    if (!snapshot) {
      return;
    }
    setBusy(true);
    setStatus({ tone: "neutral", text: "Starting preview server..." });
    try {
      const nextPreview = await startPreview(snapshot.id);
      setPreview(nextPreview);
      setStatus({ tone: "success", text: `Preview running on ${nextPreview.url}` });
    } catch (error) {
      setStatus({ tone: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleStopPreview() {
    if (!snapshot) {
      return;
    }
    await stopPreview(snapshot.id);
    setPreview(null);
    setStatus({ tone: "neutral", text: "Preview stopped." });
  }

  async function handleApplyStyle() {
    if (!snapshot || !selectedNode || !selectedFile || selectedNode.type !== "jsx_element") {
      return;
    }
    const update: StyleUpdate = { property: styleProperty, value: styleValue };
    setBusy(true);
    try {
      if (styleMode === "css") {
        const className = getClassTarget(selectedFile.content, selectedNode.id);
        if (!className) {
          setStatus({ tone: "warning", text: "No static class target was found for CSS editing." });
          return;
        }
        const result = applyCssRuleUpdate(sourceFiles, className, [update]);
        if (result.warning) {
          setStatus({ tone: "warning", text: result.warning });
          return;
        }
        const changed = result.files.find((file) => file.path === result.changedPath);
        if (changed) {
          await writeSnapshotFile(snapshot.id, changed.path, changed.content);
          await reanalyzeAndPersist(snapshot.id, result.files);
          appendEdit("style_update", selectedNode.id, { mode: styleMode, update }, [changed.path]);
          setStatus({ tone: "success", text: `Updated ${changed.path}` });
        }
        return;
      }

      const nextContent =
        styleMode === "tailwind"
          ? applyTailwindUpdate(selectedFile.content, selectedNode.id, [update])
          : applyInlineStyleUpdate(selectedFile.content, selectedNode.id, [update]);
      const nextFiles = replaceFile(sourceFiles, selectedFile.path, nextContent);
      await writeSnapshotFile(snapshot.id, selectedFile.path, nextContent);
      await reanalyzeAndPersist(snapshot.id, nextFiles);
      appendEdit("style_update", selectedNode.id, { mode: styleMode, update }, [selectedFile.path]);
      setStatus({ tone: "success", text: `Updated ${selectedFile.path}` });
    } catch (error) {
      setStatus({ tone: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleStructureOperation(operation: StructureOperation) {
    if (!snapshot || !selectedNode || !selectedFile || selectedNode.type !== "jsx_element") {
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, string> =
        operation === "wrap" ? { className: "dev-design-wrapper" } : {};
      const nextContent = applyStructureOperation(selectedFile.content, selectedNode.id, operation, payload);
      const nextFiles = replaceFile(sourceFiles, selectedFile.path, nextContent);
      await writeSnapshotFile(snapshot.id, selectedFile.path, nextContent);
      await reanalyzeAndPersist(snapshot.id, nextFiles);
      appendEdit(operationToEditType(operation), selectedNode.id, { operation, payload }, [selectedFile.path]);
      setStatus({ tone: "success", text: `${operation.replace("_", " ")} applied.` });
    } catch (error) {
      setStatus({ tone: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveCode() {
    if (!snapshot || !selectedFile) {
      return;
    }
    setBusy(true);
    try {
      const nextFiles = replaceFile(sourceFiles, selectedFile.path, codeDraft);
      await writeSnapshotFile(snapshot.id, selectedFile.path, codeDraft);
      await reanalyzeAndPersist(snapshot.id, nextFiles);
      appendEdit("code_edit", selectedNode?.id ?? `file:${selectedFile.path}`, {}, [selectedFile.path]);
      setStatus({ tone: "success", text: `Saved snapshot edit for ${selectedFile.path}` });
    } catch (error) {
      setStatus({ tone: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateSyncPlan() {
    if (!snapshot) {
      return;
    }
    setBusy(true);
    try {
      const plan = await createSyncPlan(snapshot.id);
      setSyncPlan(plan);
      setSelectedSyncFiles(new Set(plan.changedFiles.map((file) => file.path)));
      setStatus({
        tone: plan.changedFiles.length > 0 ? "warning" : "neutral",
        text: `${plan.changedFiles.length} changed file(s) ready for review.`,
      });
    } catch (error) {
      setStatus({ tone: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleApplySync() {
    if (!snapshot || !syncPlan) {
      return;
    }
    const files = Array.from(selectedSyncFiles);
    if (files.length === 0) {
      setStatus({ tone: "warning", text: "Select at least one file to sync." });
      return;
    }
    setBusy(true);
    try {
      const response = await applySync(snapshot.id, files);
      setStatus({
        tone: "success",
        text: `Applied ${response.appliedFiles.length} file(s). Backup: ${response.backupRoot}`,
      });
      setSyncPlan(null);
    } catch (error) {
      setStatus({ tone: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  function appendEdit(
    operationType: EditOperation["operationType"],
    targetNodeId: string,
    payload: Record<string, unknown>,
    resultingFiles: string[],
  ) {
    setEditLog((current) => [
      {
        operationType,
        targetNodeId,
        payload,
        resultingFiles,
        timestamp: new Date().toISOString(),
      },
      ...current,
    ]);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">DD</span>
          <div>
            <h1>Dev Design</h1>
            <p>{snapshot ? `${snapshot.frameworkGuess} snapshot` : "Local React UI editor"}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button onClick={handleOpenProject} disabled={busy}>
            Open Project
          </button>
          <button onClick={handleInstallDependencies} disabled={!snapshot || busy}>
            Install
          </button>
          {preview ? (
            <button onClick={handleStopPreview} disabled={!snapshot || busy}>
              Stop Preview
            </button>
          ) : (
            <button onClick={handleStartPreview} disabled={!snapshot || busy}>
              Start Preview
            </button>
          )}
          <button className="primary" onClick={handleCreateSyncPlan} disabled={!snapshot || busy}>
            Sync
          </button>
        </div>
      </header>

      {status && <div className={`status ${status.tone}`}>{status.text}</div>}

      <section className="workspace">
        <aside className="sidebar">
          <div className="panel-header">
            <h2>Project</h2>
            <span>{analysis?.nodes.length ?? 0}</span>
          </div>
          <div className="snapshot-meta">
            {snapshot ? (
              <>
                <strong>{snapshot.packageManager}</strong>
                <span>{snapshot.originalPath}</span>
              </>
            ) : (
              <span>Select a React project directory to create an internal snapshot.</span>
            )}
          </div>
          <div className="tree">
            {rootNodes.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                nodeMap={nodeMap}
                selectedNodeId={selectedNodeId}
                onSelect={setSelectedNodeId}
              />
            ))}
          </div>
        </aside>

        <section className="stage">
          <div className="preview-panel">
            <div className="panel-header">
              <h2>Preview</h2>
              <span>{preview?.url ?? "not running"}</span>
            </div>
            {preview ? (
              <iframe title="Project preview" src={preview.url} />
            ) : (
              <div className="empty-state">
                <h2>Preview is stopped</h2>
                <p>Install dependencies if needed, then start the internal snapshot preview.</p>
              </div>
            )}
          </div>

          <div className="code-panel">
            <div className="panel-header">
              <h2>Code</h2>
              <span>{selectedFile?.path ?? "no selection"}</span>
            </div>
            <textarea
              value={codeDraft}
              onChange={(event) => setCodeDraft(event.target.value)}
              disabled={!selectedFile}
              spellCheck={false}
            />
            <div className="code-actions">
              <button onClick={handleSaveCode} disabled={!selectedFile || busy}>
                Save Snapshot Code
              </button>
            </div>
          </div>
        </section>

        <aside className="inspector">
          <div className="panel-header">
            <h2>Inspector</h2>
            <span>{selectedNode?.type ?? "none"}</span>
          </div>
          {selectedNode ? (
            <>
              <div className="selected-card">
                <strong>{selectedNode.displayName}</strong>
                <span>{selectedNode.sourceFile}</span>
                <small>
                  {selectedNode.sourceRange.start}-{selectedNode.sourceRange.end}
                </small>
              </div>

              <div className="control-group">
                <h3>Style</h3>
                <div className="segmented">
                  {(["tailwind", "inline", "css"] as StyleMode[]).map((mode) => (
                    <button
                      key={mode}
                      className={styleMode === mode ? "active" : ""}
                      onClick={() => setStyleMode(mode)}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <label>
                  Property
                  <select value={styleProperty} onChange={(event) => setStyleProperty(event.target.value)}>
                    {STYLE_PROPERTIES.map((property) => (
                      <option key={property} value={property}>
                        {property}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Value
                  <input value={styleValue} onChange={(event) => setStyleValue(event.target.value)} />
                </label>
                <button onClick={handleApplyStyle} disabled={busy || selectedNode.type !== "jsx_element"}>
                  Apply Style
                </button>
              </div>

              <div className="control-group">
                <h3>Structure</h3>
                <div className="structure-grid">
                  {(["move_up", "move_down", "duplicate", "delete", "wrap", "unwrap", "insert_child"] as StructureOperation[]).map(
                    (operation) => (
                      <button
                        key={operation}
                        onClick={() => handleStructureOperation(operation)}
                        disabled={busy || selectedNode.type !== "jsx_element"}
                      >
                        {operation.replace("_", " ")}
                      </button>
                    ),
                  )}
                </div>
              </div>

              <div className="control-group">
                <h3>Edit Log</h3>
                <div className="edit-log">
                  {editLog.slice(0, 8).map((edit) => (
                    <div key={`${edit.timestamp}-${edit.targetNodeId}`}>
                      <strong>{edit.operationType}</strong>
                      <span>{edit.resultingFiles.join(", ")}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state compact">
              <h2>No node selected</h2>
              <p>Choose an item in the tree or click an instrumented preview element.</p>
            </div>
          )}
        </aside>
      </section>

      {syncPlan && (
        <SyncReview
          plan={syncPlan}
          selectedFiles={selectedSyncFiles}
          onToggle={(path) => {
            setSelectedSyncFiles((current) => {
              const next = new Set(current);
              if (next.has(path)) {
                next.delete(path);
              } else {
                next.add(path);
              }
              return next;
            });
          }}
          onClose={() => setSyncPlan(null)}
          onApply={handleApplySync}
          busy={busy}
        />
      )}
    </main>
  );
}

function TreeNode({
  node,
  nodeMap,
  selectedNodeId,
  onSelect,
}: {
  node: ProjectNode;
  nodeMap: Map<string, ProjectNode>;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
}) {
  const children = node.childrenIds.map((id) => nodeMap.get(id)).filter(Boolean) as ProjectNode[];
  return (
    <div className="tree-node">
      <button
        className={selectedNodeId === node.id ? "selected" : ""}
        style={{ paddingLeft: `${8 + node.depth * 14}px` }}
        onClick={() => onSelect(node.id)}
      >
        <span className={`node-dot ${node.type}`} />
        <span>{node.displayName}</span>
      </button>
      {children.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          nodeMap={nodeMap}
          selectedNodeId={selectedNodeId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function SyncReview({
  plan,
  selectedFiles,
  onToggle,
  onClose,
  onApply,
  busy,
}: {
  plan: SyncPlan;
  selectedFiles: Set<string>;
  onToggle: (path: string) => void;
  onClose: () => void;
  onApply: () => void;
  busy: boolean;
}) {
  const [activeFile, setActiveFile] = useState<ChangedFile | null>(plan.changedFiles[0] ?? null);
  return (
    <div className="modal-backdrop">
      <section className="sync-modal">
        <div className="panel-header">
          <h2>Sync Review</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="sync-warning">
          {plan.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
        <div className="sync-content">
          <div className="sync-files">
            {plan.changedFiles.map((file) => (
              <label key={file.path} className={activeFile?.path === file.path ? "active" : ""}>
                <input
                  type="checkbox"
                  checked={selectedFiles.has(file.path)}
                  onChange={() => onToggle(file.path)}
                />
                <button type="button" onClick={() => setActiveFile(file)}>
                  <strong>{file.path}</strong>
                  <span>{file.status}</span>
                </button>
              </label>
            ))}
          </div>
          <pre className="diff-view">{activeFile?.diff ?? "No changes."}</pre>
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={onApply} disabled={busy || selectedFiles.size === 0}>
            Apply Selected
          </button>
        </div>
      </section>
    </div>
  );
}

function replaceFile(files: SourceFile[], path: string, content: string): SourceFile[] {
  return files.map((file) => (file.path === path ? { ...file, content } : file));
}

function operationToEditType(operation: StructureOperation): EditOperation["operationType"] {
  if (operation === "duplicate") {
    return "duplicate_node";
  }
  if (operation === "delete") {
    return "delete_node";
  }
  if (operation === "insert_child") {
    return "insert_node";
  }
  if (operation === "wrap" || operation === "unwrap") {
    return "wrap_node";
  }
  return "move_node";
}
