import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
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
  discardSnapshotChanges,
  installDependencies,
  loadRecentSnapshot,
  openProject,
  pickProjectDirectory,
  recordBaseline,
  refreshFromOriginal,
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
  "border-style",
  "border-color",
  "border-width",
  "border-radius",
  "box-shadow",
  "display",
  "align-items",
  "justify-content",
  "opacity",
  "transform",
  "visibility",
];

const COLOR_PRESETS = ["#ef4444", "#f97316", "#facc15", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#111827", "#ffffff"];
const OPACITY_PRESETS = ["25%", "55%", "75%", "100%"];
const SHADOW_PRESETS = [
  { label: "None", value: "none" },
  { label: "Drop shadow", value: "0 12px 30px rgba(15, 23, 42, 0.18)" },
  { label: "Soft", value: "0 8px 18px rgba(15, 23, 42, 0.12)" },
];

type StatusTone = "neutral" | "success" | "warning" | "error";
type ViewMode = "preview" | "code";
type BaselineStatus = "idle" | "recording" | "ready" | "error";

interface StatusMessage {
  tone: StatusTone;
  text: string;
}

interface LoadingState {
  detail: string;
  progress: number;
}

interface SelectedElementMetrics {
  nodeId: string;
  width: number;
  height: number;
}

type PanelContextTarget = "project" | "inspector";

interface PanelContextMenuState {
  target: PanelContextTarget;
  x: number;
  y: number;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [sourceFiles, setSourceFiles] = useState<SourceFile[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewStarting, setPreviewStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [loading, setLoading] = useState<LoadingState | null>(null);
  const [styleMode, setStyleMode] = useState<StyleMode>("tailwind");
  const [styleProperty, setStyleProperty] = useState("width");
  const [styleValue, setStyleValue] = useState("320px");
  const [codeDraft, setCodeDraft] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [selectionToolActive, setSelectionToolActive] = useState(false);
  const [openColorPalette, setOpenColorPalette] = useState<"color" | "background-color" | "stroke" | null>(null);
  const [selectedTextColor, setSelectedTextColor] = useState("#111827");
  const [selectedBackgroundColor, setSelectedBackgroundColor] = useState("#ffffff");
  const [toolX, setToolX] = useState("0");
  const [toolY, setToolY] = useState("0");
  const [toolRotation, setToolRotation] = useState("0");
  const [toolWidth, setToolWidth] = useState("292");
  const [toolHeight, setToolHeight] = useState("292");
  const [toolPadding, setToolPadding] = useState("0");
  const [toolGap, setToolGap] = useState("0");
  const [toolFontSize, setToolFontSize] = useState("16");
  const [toolFontWeight, setToolFontWeight] = useState("400");
  const [toolOpacity, setToolOpacity] = useState("100");
  const [toolRadius, setToolRadius] = useState("0");
  const [strokeColor, setStrokeColor] = useState("#dcdcdc");
  const [strokeWeight, setStrokeWeight] = useState("1");
  const [shadowValue, setShadowValue] = useState(SHADOW_PRESETS[1].value);
  const [isProjectSidebarCollapsed, setProjectSidebarCollapsed] = useState(false);
  const [isInspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [panelMenu, setPanelMenu] = useState<PanelContextMenuState | null>(null);
  const [baselineStatus, setBaselineStatus] = useState<BaselineStatus>("idle");
  const [syncPlan, setSyncPlan] = useState<SyncPlan | null>(null);
  const [selectedSyncFiles, setSelectedSyncFiles] = useState<Set<string>>(new Set());
  const [editLog, setEditLog] = useState<EditOperation[]>([]);
  const [selectedElementMetrics, setSelectedElementMetrics] = useState<SelectedElementMetrics | null>(null);
  const didRestoreRecent = useRef(false);
  const baselineTaskId = useRef(0);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);

  const nodeMap = useMemo(() => new Map((analysis?.nodes ?? []).map((node) => [node.id, node])), [analysis]);
  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) ?? null : null;
  const selectedFile = selectedNode ? sourceFiles.find((file) => file.path === selectedNode.sourceFile) ?? null : null;
  const rootNodes = useMemo(
    () => (analysis?.nodes ?? []).filter((node) => node.parentId === null),
    [analysis],
  );
  const baselineUnavailable = snapshot !== null && baselineStatus !== "ready";
  const baselineRecording = baselineStatus === "recording";
  const snapshotEditingDisabled = busy || baselineUnavailable;
  const selectedNodeCanEdit = selectedNode?.type === "jsx_element";
  const previewControlActive = preview !== null || previewStarting;
  const previewLabel = preview?.url ?? (previewStarting ? "starting" : "not running");
  const hasCodeDraftChanges = selectedFile !== null && codeDraft !== selectedFile.content;

  useEffect(() => {
    if (selectedFile) {
      setCodeDraft(selectedFile.content);
      if (selectedFile.kind !== "react") {
        setViewMode("code");
      }
    } else {
      setCodeDraft("");
    }
  }, [selectedFile?.path, selectedFile?.content]);

  useEffect(() => {
    if (didRestoreRecent.current) {
      return;
    }
    didRestoreRecent.current = true;

    async function restoreRecentSnapshot() {
      setBusy(true);
      setLoading({
        detail: "Checking for the most recent workspace.",
        progress: 18,
      });
      try {
        const response = await loadRecentSnapshot();
        if (!response) {
          return;
        }
        setLoading({
          detail: "Restoring the recent internal snapshot.",
          progress: 58,
        });
        await waitForPaint();
        setSnapshot(response.snapshot);
        await reanalyzeAndPersist(response.snapshot.id, response.sourceFiles);
        baselineTaskId.current += 1;
        setBaselineStatus(
          response.warnings.some((warning) => warning.includes("Baseline manifest is missing"))
            ? "error"
            : "ready",
        );
        setSelectedNodeId(null);
        setPreview(null);
        setPreviewStarting(false);
        setSelectionToolActive(false);
        setSyncPlan(null);
        setLoading({
          detail: "Rebuilding the project tree and source mappings.",
          progress: 88,
        });
        setStatus({
          tone: response.warnings.length > 0 ? "warning" : "success",
          text: response.warnings[0] ?? `Restored recent snapshot: ${response.snapshot.originalPath}`,
        });
      } catch (error) {
        setStatus({ tone: "warning", text: `Could not restore recent snapshot: ${String(error)}` });
      } finally {
        setLoading(null);
        setBusy(false);
      }
    }

    restoreRecentSnapshot();
  }, []);

  useEffect(() => {
    function handlePreviewMessage(event: MessageEvent) {
      if (event.data?.type !== "dev-design-select" || typeof event.data.id !== "string") {
        return;
      }
      if (selectionToolActive && nodeMap.has(event.data.id)) {
        setSelectedNodeId(event.data.id);
        const bounds = event.data.bounds;
        if (bounds && typeof bounds.width === "number" && typeof bounds.height === "number") {
          const width = roundMetric(bounds.width);
          const height = roundMetric(bounds.height);
          setSelectedElementMetrics({ nodeId: event.data.id, width, height });
          setToolWidth(formatMetricInput(width));
          setToolHeight(formatMetricInput(height));
        } else {
          setSelectedElementMetrics(null);
        }
      }
    }
    window.addEventListener("message", handlePreviewMessage);
    return () => window.removeEventListener("message", handlePreviewMessage);
  }, [nodeMap, selectionToolActive]);

  useEffect(() => {
    if (!selectedNodeId || selectedElementMetrics?.nodeId === selectedNodeId) {
      return;
    }
    setSelectedElementMetrics(null);
  }, [selectedElementMetrics?.nodeId, selectedNodeId]);

  useEffect(() => {
    sendSelectionModeToPreview();
  }, [selectionToolActive, preview?.url]);

  useEffect(() => {
    function closePanelMenu() {
      setPanelMenu(null);
    }
    function handlePointerDown(event: PointerEvent) {
      if (event.button === 0) {
        closePanelMenu();
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closePanelMenu();
      }
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  function openPanelMenu(event: ReactMouseEvent<HTMLElement>, target: PanelContextTarget) {
    event.preventDefault();
    event.stopPropagation();
    setPanelMenu({
      target,
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 76),
    });
  }

  function togglePanelFromMenu(target: PanelContextTarget) {
    if (target === "project") {
      setProjectSidebarCollapsed((current) => !current);
    } else {
      setInspectorCollapsed((current) => !current);
    }
    setPanelMenu(null);
  }

  function toggleSelectionTool() {
    setSelectionToolActive((current) => {
      const next = !current;
      setStatus({
        tone: "neutral",
        text: next
          ? "Selection tool enabled. Click an instrumented preview element to edit it."
          : "Selection tool disabled.",
      });
      return next;
    });
  }

  function sendSelectionModeToPreview() {
    previewFrameRef.current?.contentWindow?.postMessage(
      {
        type: "dev-design-selection-mode",
        enabled: selectionToolActive,
      },
      "*",
    );
  }

  function recordBaselineInBackground(snapshotId: string) {
    const taskId = baselineTaskId.current + 1;
    baselineTaskId.current = taskId;
    setBaselineStatus("recording");
    void recordBaseline(snapshotId)
      .then(() => {
        if (baselineTaskId.current !== taskId) {
          return;
        }
        setBaselineStatus("ready");
      })
      .catch((error) => {
        if (baselineTaskId.current !== taskId) {
          return;
        }
        setBaselineStatus("error");
        setStatus({ tone: "warning", text: `Baseline hashing failed: ${String(error)}` });
      });
  }

  async function handleOpenProject() {
    setBusy(true);
    setLoading({
      detail: "Selecting project directory.",
      progress: 8,
    });
    await waitForPaint();
    const path = await pickProjectDirectory();
    if (!path) {
      setLoading(null);
      setBusy(false);
      return;
    }
    setStatus({ tone: "neutral", text: "Opening project snapshot..." });
    setLoading({
      detail: "Creating an internal snapshot from the selected directory.",
      progress: 18,
    });
    await waitForPaint();
    try {
      const response = await openProject(path);
      setLoading({
        detail: "Analyzing React files, routes, and style assets.",
        progress: 62,
      });
      await waitForPaint();
      setSnapshot(response.snapshot);
      await reanalyzeAndPersist(response.snapshot.id, response.sourceFiles);
      recordBaselineInBackground(response.snapshot.id);
      setLoading({
        detail: "Building the project tree and source mappings.",
        progress: 88,
      });
      setSelectedNodeId(null);
      setPreview(null);
      setPreviewStarting(false);
      setSelectionToolActive(false);
      setSyncPlan(null);
      setStatus({
        tone: response.warnings.length > 0 ? "warning" : "success",
        text: response.warnings[0] ?? `Snapshot created at ${response.snapshot.snapshotPath}`,
      });
    } catch (error) {
      setStatus({ tone: "error", text: String(error) });
    } finally {
      setLoading(null);
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
    setPreviewStarting(true);
    setStatus({ tone: "neutral", text: "Preparing snapshot dependencies and starting preview..." });
    try {
      const nextPreview = await startPreview(snapshot.id);
      setPreview(nextPreview);
      setPreviewStarting(false);
      setStatus({ tone: "success", text: `Preview running on ${nextPreview.url}` });
    } catch (error) {
      setPreviewStarting(false);
      setStatus({ tone: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleStopPreview() {
    if (!snapshot) {
      return;
    }
    setPreviewStarting(false);
    await stopPreview(snapshot.id);
    setPreview(null);
    setStatus({ tone: "neutral", text: "Preview stopped." });
  }

  async function handleApplyStyle() {
    await applyStyleUpdates([{ property: styleProperty, value: styleValue }]);
  }

  async function handleQuickStyle(property: string, value: string) {
    setStyleProperty(property);
    setStyleValue(value);
    await applyStyleUpdates([{ property, value }], "inline");
  }

  async function handleAlignment(justifyContent?: string, alignItems?: string) {
    const updates: StyleUpdate[] = [{ property: "display", value: "flex" }];
    if (justifyContent) {
      updates.push({ property: "justify-content", value: justifyContent });
    }
    if (alignItems) {
      updates.push({ property: "align-items", value: alignItems });
    }
    await applyStyleUpdates(updates, "inline");
  }

  async function handleTransformChange(x = toolX, y = toolY, rotation = toolRotation) {
    setToolX(x);
    setToolY(y);
    setToolRotation(rotation);
    await handleQuickStyle("transform", `translate(${toCssPx(x)}, ${toCssPx(y)}) rotate(${rotation || "0"}deg)`);
  }

  async function handleDimensionsChange(width = toolWidth, height = toolHeight) {
    setToolWidth(width);
    setToolHeight(height);
    setSelectedElementMetrics((current) =>
      current && current.nodeId === selectedNodeId
        ? {
            ...current,
            width: roundMetric(parseCssNumber(width) ?? current.width),
            height: roundMetric(parseCssNumber(height) ?? current.height),
          }
        : current,
    );
    await applyStyleUpdates(
      [
        { property: "width", value: toCssPx(width) },
        { property: "height", value: toCssPx(height) },
      ],
      "inline",
    );
  }

  async function handleLayoutSpacingChange(padding = toolPadding, gap = toolGap) {
    setToolPadding(padding);
    setToolGap(gap);
    await applyStyleUpdates(
      [
        { property: "padding", value: toCssPx(padding) },
        { property: "gap", value: toCssPx(gap) },
      ],
      "inline",
    );
  }

  async function handleTypographyChange(fontSize = toolFontSize, fontWeight = toolFontWeight) {
    setToolFontSize(fontSize);
    setToolFontWeight(fontWeight);
    await applyStyleUpdates(
      [
        { property: "font-size", value: toCssPx(fontSize) },
        { property: "font-weight", value: fontWeight },
      ],
      "inline",
    );
  }

  async function handleOpacityChange(value: string) {
    setToolOpacity(value.replace("%", ""));
    await handleQuickStyle("opacity", String(parseFloat(value) / 100));
  }

  async function handleRadiusChange(value: string) {
    setToolRadius(value.replace("px", ""));
    await handleQuickStyle("border-radius", toCssPx(value));
  }

  async function handleStrokeChange(color = strokeColor, weight = strokeWeight) {
    setStrokeColor(color);
    setStrokeWeight(weight);
    await applyStyleUpdates(
      [
        { property: "border-style", value: "solid" },
        { property: "border-color", value: color },
        { property: "border-width", value: toCssPx(weight) },
      ],
      "inline",
    );
  }

  async function handleColorStyle(property: "color" | "background-color", value: string) {
    if (property === "color") {
      setSelectedTextColor(value);
    } else {
      setSelectedBackgroundColor(value);
    }
    setOpenColorPalette(null);
    await handleQuickStyle(property, value);
  }

  async function applyStyleUpdates(updates: StyleUpdate[], mode: StyleMode = styleMode) {
    if (baselineUnavailable) {
      setStatus({ tone: "warning", text: "Snapshot baseline is still being prepared. Try again shortly." });
      return;
    }
    if (!snapshot || !selectedNode || !selectedFile || selectedNode.type !== "jsx_element") {
      return;
    }
    setBusy(true);
    try {
      if (mode === "css") {
        const className = getClassTarget(selectedFile.content, selectedNode.id);
        if (!className) {
          setStatus({ tone: "warning", text: "No static class target was found for CSS editing." });
          return;
        }
        const result = applyCssRuleUpdate(sourceFiles, className, updates);
        if (result.warning) {
          setStatus({ tone: "warning", text: result.warning });
          return;
        }
        const changed = result.files.find((file) => file.path === result.changedPath);
        if (changed) {
          await writeSnapshotFile(snapshot.id, changed.path, changed.content);
          await reanalyzeAndPersist(snapshot.id, result.files);
          appendEdit("style_update", selectedNode.id, { mode, updates }, [changed.path]);
          setStatus({ tone: "success", text: `Updated ${changed.path}` });
        }
        return;
      }

      const nextContent =
        mode === "tailwind"
          ? applyTailwindUpdate(selectedFile.content, selectedNode.id, updates)
          : applyInlineStyleUpdate(selectedFile.content, selectedNode.id, updates);
      const nextFiles = replaceFile(sourceFiles, selectedFile.path, nextContent);
      await writeSnapshotFile(snapshot.id, selectedFile.path, nextContent);
      await reanalyzeAndPersist(snapshot.id, nextFiles);
      appendEdit("style_update", selectedNode.id, { mode, updates }, [selectedFile.path]);
      setStatus({ tone: "success", text: `Updated ${selectedFile.path}` });
    } catch (error) {
      setStatus({ tone: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleStructureOperation(operation: StructureOperation) {
    if (baselineUnavailable) {
      setStatus({ tone: "warning", text: "Snapshot baseline is still being prepared. Try again shortly." });
      return;
    }
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
    if (baselineUnavailable) {
      setStatus({ tone: "warning", text: "Snapshot baseline is still being prepared. Try again shortly." });
      return;
    }
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

  function handleDiscardCodeDraft() {
    if (!selectedFile) {
      return;
    }
    setCodeDraft(selectedFile.content);
    setStatus({ tone: "neutral", text: `Discarded unsaved edits for ${selectedFile.path}` });
  }

  async function handleCreateSyncPlan() {
    if (baselineUnavailable) {
      setStatus({ tone: "warning", text: "Snapshot baseline is still being prepared. Try again shortly." });
      return;
    }
    if (!snapshot) {
      return;
    }
    setBusy(true);
    try {
      const plan = await createSyncPlan(snapshot.id);
      setSyncPlan(plan);
      setSelectedSyncFiles(new Set(plan.changedFiles.filter((file) => file.canApply).map((file) => file.path)));
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
    const unsafe = syncPlan.changedFiles.filter((file) => selectedSyncFiles.has(file.path) && !file.canApply);
    if (unsafe.length > 0) {
      setStatus({ tone: "warning", text: "Selected files include original changes or conflicts. Refresh the sync plan first." });
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

  async function handleRefreshFromOriginal(files: string[]) {
    if (!snapshot || files.length === 0) {
      return;
    }
    setBusy(true);
    try {
      const refreshedFiles = await refreshFromOriginal(snapshot.id, files);
      await reanalyzeAndPersist(snapshot.id, refreshedFiles);
      const plan = await createSyncPlan(snapshot.id);
      setSyncPlan(plan);
      setSelectedSyncFiles(new Set(plan.changedFiles.filter((file) => file.canApply).map((file) => file.path)));
      setStatus({ tone: "success", text: `Refreshed ${files.length} file(s) from the original project.` });
    } catch (error) {
      setStatus({ tone: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscardSnapshotChanges(files: string[]) {
    if (!snapshot || files.length === 0) {
      return;
    }
    const accepted = window.confirm(
      `Discard snapshot changes for ${files.length} file(s) and restore them from the original project?`,
    );
    if (!accepted) {
      return;
    }
    setBusy(true);
    try {
      const refreshedFiles = await discardSnapshotChanges(snapshot.id, files);
      await reanalyzeAndPersist(snapshot.id, refreshedFiles);
      const selectedFileStillExists =
        selectedFile === null || refreshedFiles.some((file) => file.path === selectedFile.path);
      if (!selectedFileStillExists) {
        setSelectedNodeId(null);
        setSelectedElementMetrics(null);
      }
      if (syncPlan) {
        const plan = await createSyncPlan(snapshot.id);
        setSyncPlan(plan);
        setSelectedSyncFiles(new Set(plan.changedFiles.filter((file) => file.canApply).map((file) => file.path)));
      }
      setStatus({ tone: "success", text: `Discarded snapshot changes for ${files.length} file(s).` });
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
          <div className="brand-copy">
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
          {previewControlActive ? (
            <button
              className="icon-button"
              onClick={handleStopPreview}
              disabled={!snapshot || busy}
              title={previewStarting ? "Starting Preview" : "Stop Preview"}
              aria-label={previewStarting ? "Starting Preview" : "Stop Preview"}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              className="icon-button"
              onClick={handleStartPreview}
              disabled={!snapshot || busy}
              title="Start Preview"
              aria-label="Start Preview"
            >
              <PlayIcon />
            </button>
          )}
          <button
            className="icon-button primary"
            onClick={handleCreateSyncPlan}
            disabled={!snapshot || busy || baselineUnavailable}
            title="Sync"
            aria-label="Sync"
          >
            <SyncIcon />
          </button>
        </div>
      </header>

      {loading && <TopProgress loading={loading} />}
      {status && <div className={`status ${status.tone}`}>{status.text}</div>}

      <section
        className={`workspace ${isProjectSidebarCollapsed ? "sidebar-collapsed" : ""} ${
          isInspectorCollapsed ? "inspector-collapsed" : ""
        }`}
      >
        <aside
          className={`sidebar ${isProjectSidebarCollapsed ? "collapsed" : ""}`}
          onContextMenu={(event) => openPanelMenu(event, "project")}
        >
          <div className="panel-header">
            <h2>{isProjectSidebarCollapsed ? "P" : "Project"}</h2>
            <div className="sidebar-header-actions">
              {!isProjectSidebarCollapsed && <span>{analysis?.nodes.length ?? 0}</span>}
            </div>
          </div>
          {!isProjectSidebarCollapsed && (
            <>
              <div className="snapshot-meta">
                {snapshot ? (
                  <>
                    <strong>{snapshot.packageManager}</strong>
                    <span>
                      {snapshot.originalPath}
                      {snapshot.appRootRelativePath ? `/${snapshot.appRootRelativePath}` : ""}
                    </span>
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
            </>
          )}
        </aside>

        <section className="stage">
          <div className="work-panel">
            <div className="panel-header">
              <div className="view-title">
                <h2>{viewMode === "preview" ? "Preview" : "Code"}</h2>
                <span>{viewMode === "preview" ? previewLabel : selectedFile?.path ?? "no selection"}</span>
              </div>
              <ViewToggle mode={viewMode} onChange={setViewMode} />
            </div>
            {viewMode === "preview" ? (
              preview ? (
                <iframe
                  ref={previewFrameRef}
                  title="Project preview"
                  src={preview.url}
                  onLoad={sendSelectionModeToPreview}
                />
              ) : (
                <div className="empty-state">
                  <h2>{previewStarting ? "Preview is starting" : "Preview is stopped"}</h2>
                  <p>
                    {previewStarting
                      ? "Installing dependencies if needed, then starting the internal snapshot preview."
                      : "Install dependencies if needed, then start the internal snapshot preview."}
                  </p>
                </div>
              )
            ) : (
              <div className="code-panel">
                <textarea
                  value={codeDraft}
                  onChange={(event) => setCodeDraft(event.target.value)}
                  disabled={!selectedFile}
                  spellCheck={false}
                />
                <div className="code-actions">
                  <button onClick={handleDiscardCodeDraft} disabled={!selectedFile || !hasCodeDraftChanges || busy}>
                    Discard Draft
                  </button>
                  <button onClick={handleSaveCode} disabled={!selectedFile || snapshotEditingDisabled}>
                    Save Snapshot Code
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        <aside
          className={`inspector ${isInspectorCollapsed ? "collapsed" : ""}`}
          onContextMenu={(event) => openPanelMenu(event, "inspector")}
        >
          <div className="panel-header">
            <h2>{isInspectorCollapsed ? "T" : "Tools"}</h2>
            <div className="sidebar-header-actions">
              {!isInspectorCollapsed && <span>{selectedNode?.type ?? "none"}</span>}
            </div>
          </div>
          {!isInspectorCollapsed && (
            <>
              <div className="tool-palette">
                <button
                  className={`tool-button ${selectionToolActive ? "active" : ""}`}
                  onClick={toggleSelectionTool}
                  aria-pressed={selectionToolActive}
                  title="Select preview element"
                  aria-label="Select preview element"
                >
                  <CursorIcon />
                </button>
              </div>
              {selectedNode ? (
              <>
                <div className="selected-card">
                  <div className="selected-card-heading">
                    <strong>{selectedNode.displayName}</strong>
                    <button
                      className="icon-button"
                      onClick={() => selectedFile && handleDiscardSnapshotChanges([selectedFile.path])}
                      disabled={!selectedFile || snapshotEditingDisabled}
                      title="Reset selected file from original"
                      aria-label="Reset selected file from original"
                    >
                      <ResetIcon />
                    </button>
                  </div>
                  <span>{selectedNode.sourceFile}</span>
                  <small>
                    {selectedNode.sourceRange.start}-{selectedNode.sourceRange.end}
                  </small>
                  {selectedElementMetrics?.nodeId === selectedNode.id && (
                    <div className="element-metrics" aria-label="Selected element size">
                      <span>W {formatMetricDisplay(selectedElementMetrics.width)}px</span>
                      <span>H {formatMetricDisplay(selectedElementMetrics.height)}px</span>
                    </div>
                  )}
                </div>

                <div className="control-group">
                  <div className="control-heading">
                    <h3>Alignment</h3>
                  </div>
                  <div className="icon-grid six">
                    <button onClick={() => handleAlignment("flex-start")} disabled={snapshotEditingDisabled || !selectedNodeCanEdit}>L</button>
                    <button onClick={() => handleAlignment("center")} disabled={snapshotEditingDisabled || !selectedNodeCanEdit}>C</button>
                    <button onClick={() => handleAlignment("flex-end")} disabled={snapshotEditingDisabled || !selectedNodeCanEdit}>R</button>
                    <button onClick={() => handleAlignment(undefined, "flex-start")} disabled={snapshotEditingDisabled || !selectedNodeCanEdit}>T</button>
                    <button onClick={() => handleAlignment(undefined, "center")} disabled={snapshotEditingDisabled || !selectedNodeCanEdit}>M</button>
                    <button onClick={() => handleAlignment(undefined, "flex-end")} disabled={snapshotEditingDisabled || !selectedNodeCanEdit}>B</button>
                  </div>
                  <div className="control-heading">
                    <h3>Position</h3>
                  </div>
                  <div className="two-col">
                    <label>
                      X
                      <input
                        value={toolX}
                        onChange={(event) => setToolX(event.target.value)}
                        onBlur={() => handleTransformChange()}
                        disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                      />
                    </label>
                    <label>
                      Y
                      <input
                        value={toolY}
                        onChange={(event) => setToolY(event.target.value)}
                        onBlur={() => handleTransformChange()}
                        disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                      />
                    </label>
                  </div>
                  <label>
                    Rotation
                    <input
                      value={toolRotation}
                      onChange={(event) => setToolRotation(event.target.value)}
                      onBlur={() => handleTransformChange()}
                      disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                    />
                  </label>
                </div>

                <div className="control-group">
                  <div className="control-heading">
                    <h3>Layout</h3>
                  </div>
                  <div className="two-col">
                    <label>
                      W
                      <input
                        value={toolWidth}
                        onChange={(event) => setToolWidth(event.target.value)}
                        onBlur={() => handleDimensionsChange()}
                        disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                      />
                    </label>
                    <label>
                      H
                      <input
                        value={toolHeight}
                        onChange={(event) => setToolHeight(event.target.value)}
                        onBlur={() => handleDimensionsChange()}
                        disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                      />
                    </label>
                  </div>
                  <div className="two-col">
                    <label>
                      Padding
                      <input
                        value={toolPadding}
                        onChange={(event) => setToolPadding(event.target.value)}
                        onBlur={() => handleLayoutSpacingChange()}
                        disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                      />
                    </label>
                    <label>
                      Gap
                      <input
                        value={toolGap}
                        onChange={(event) => setToolGap(event.target.value)}
                        onBlur={() => handleLayoutSpacingChange()}
                        disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                      />
                    </label>
                  </div>
                </div>

                <div className="control-group">
                  <div className="control-heading">
                    <h3>Typography</h3>
                  </div>
                  <div className="two-col">
                    <label>
                      Size
                      <input
                        value={toolFontSize}
                        onChange={(event) => setToolFontSize(event.target.value)}
                        onBlur={() => handleTypographyChange()}
                        disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                      />
                    </label>
                    <label>
                      Weight
                      <select
                        value={toolFontWeight}
                        onChange={(event) => handleTypographyChange(toolFontSize, event.target.value)}
                        disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                      >
                        <option value="300">Light</option>
                        <option value="400">Regular</option>
                        <option value="500">Medium</option>
                        <option value="600">Semibold</option>
                        <option value="700">Bold</option>
                      </select>
                    </label>
                  </div>
                  <div className="color-picker">
                    <button
                      className="selected-color-button"
                      onClick={() => setOpenColorPalette((current) => (current === "color" ? null : "color"))}
                      disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                    >
                      <span className="selected-color-swatch" style={{ background: selectedTextColor }} />
                      <span>{selectedTextColor}</span>
                    </button>
                    {openColorPalette === "color" && (
                      <div className="color-map">
                        {COLOR_PRESETS.map((value) => (
                          <button
                            key={`text-${value}`}
                            className="color-swatch"
                            style={{ background: value }}
                            onClick={() => handleColorStyle("color", value)}
                            disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                            title={`Text ${value}`}
                            aria-label={`Text ${value}`}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="control-group">
                  <div className="control-heading">
                    <h3>Appearance</h3>
                  </div>
                  <div className="two-col">
                    <label>
                      Opacity
                      <input
                        value={toolOpacity}
                        onChange={(event) => setToolOpacity(event.target.value)}
                        onBlur={() => handleOpacityChange(toolOpacity)}
                        disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                      />
                    </label>
                    <label>
                      Corner radius
                      <input
                        value={toolRadius}
                        onChange={(event) => setToolRadius(event.target.value)}
                        onBlur={() => handleRadiusChange(toolRadius)}
                        disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                      />
                    </label>
                  </div>
                  <div className="preset-grid">
                    {OPACITY_PRESETS.map((value) => (
                      <button key={`opacity-${value}`} onClick={() => handleOpacityChange(value)} disabled={snapshotEditingDisabled || !selectedNodeCanEdit}>
                        {value}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="control-group">
                  <div className="control-heading">
                    <h3>Fill</h3>
                  </div>
                  <div className="color-picker">
                    <button
                      className="selected-color-button"
                      onClick={() =>
                        setOpenColorPalette((current) =>
                          current === "background-color" ? null : "background-color",
                        )
                      }
                      disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                    >
                      <span className="selected-color-swatch" style={{ background: selectedBackgroundColor }} />
                      <span>{selectedBackgroundColor}</span>
                    </button>
                    {openColorPalette === "background-color" && (
                      <div className="color-map">
                        {COLOR_PRESETS.map((value) => (
                          <button
                            key={`fill-${value}`}
                            className="color-swatch"
                            style={{ background: value }}
                            onClick={() => handleColorStyle("background-color", value)}
                            disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                            title={`Fill ${value}`}
                            aria-label={`Fill ${value}`}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="control-group">
                  <div className="control-heading">
                    <h3>Stroke</h3>
                  </div>
                  <div className="color-picker">
                    <button
                      className="selected-color-button"
                      onClick={() => setOpenColorPalette((current) => (current === "stroke" ? null : "stroke"))}
                      disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                    >
                      <span className="selected-color-swatch" style={{ background: strokeColor }} />
                      <span>{strokeColor}</span>
                    </button>
                    {openColorPalette === "stroke" && (
                      <div className="color-map">
                        {COLOR_PRESETS.map((value) => (
                          <button
                            key={`stroke-${value}`}
                            className="color-swatch"
                            style={{ background: value }}
                            onClick={() => handleStrokeChange(value, strokeWeight)}
                            disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                            title={`Stroke ${value}`}
                            aria-label={`Stroke ${value}`}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <label>
                    Weight
                    <input
                      value={strokeWeight}
                      onChange={(event) => setStrokeWeight(event.target.value)}
                      onBlur={() => handleStrokeChange(strokeColor, strokeWeight)}
                      disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                    />
                  </label>
                </div>

                <div className="control-group">
                  <div className="control-heading">
                    <h3>Effects</h3>
                  </div>
                  <div className="effect-row">
                    <input
                      type="checkbox"
                      checked={shadowValue !== "none"}
                      disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                      onChange={(event) => {
                        const next = event.target.checked ? SHADOW_PRESETS[1].value : "none";
                        setShadowValue(next);
                        handleQuickStyle("box-shadow", next);
                      }}
                    />
                    <select
                      value={shadowValue}
                      disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
                      onChange={(event) => {
                        setShadowValue(event.target.value);
                        handleQuickStyle("box-shadow", event.target.value);
                      }}
                    >
                      {SHADOW_PRESETS.map((preset) => (
                        <option key={preset.value} value={preset.value}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="control-group">
                  <h3>Advanced Style</h3>
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
                  <button onClick={handleApplyStyle} disabled={snapshotEditingDisabled || !selectedNodeCanEdit}>
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
                          disabled={snapshotEditingDisabled || !selectedNodeCanEdit}
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
                <p>Enable the selection tool, then click a preview element.</p>
              </div>
            )}
            </>
          )}
        </aside>
      </section>

      {panelMenu && (
        <PanelContextMenu
          menu={panelMenu}
          isCollapsed={
            panelMenu.target === "project" ? isProjectSidebarCollapsed : isInspectorCollapsed
          }
          onSelect={() => togglePanelFromMenu(panelMenu.target)}
        />
      )}

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
          onRefresh={handleRefreshFromOriginal}
          onDiscard={handleDiscardSnapshotChanges}
          busy={busy}
        />
      )}
    </main>
  );
}

function TopProgress({ loading }: { loading: LoadingState }) {
  return (
    <div className="top-progress" role="progressbar" aria-label={loading.detail} aria-valuenow={loading.progress}>
      <div className="progress-track" aria-label={`${loading.progress}% complete`}>
        <div className="progress-fill" style={{ width: `${loading.progress}%` }} />
        <div className="progress-shine" />
      </div>
    </div>
  );
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div className="view-toggle" role="tablist" aria-label="Preview or code view">
      <button
        className={mode === "preview" ? "active" : ""}
        onClick={() => onChange("preview")}
        aria-label="Preview view"
        title="Preview"
      >
        <EyeIcon />
      </button>
      <button
        className={mode === "code" ? "active" : ""}
        onClick={() => onChange("code")}
        aria-label="Code view"
        title="Code"
      >
        <CodeIcon />
      </button>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.4 12s3.5-6 9.6-6 9.6 6 9.6 6-3.5 6-9.6 6-9.6-6-9.6-6Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 7-5 5 5 5" />
      <path d="m15 7 5 5-5 5" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7-11-7Z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function SyncIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 7h-5.5a6.5 6.5 0 0 0-10.2 2" />
      <path d="M20 7l-3-3" />
      <path d="M20 7l-3 3" />
      <path d="M4 17h5.5a6.5 6.5 0 0 0 10.2-2" />
      <path d="M4 17l3 3" />
      <path d="M4 17l3-3" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7v5h5" />
      <path d="M5.2 12a7 7 0 1 0 2-5" />
    </svg>
  );
}

function CursorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.6 2.8c-.7-.5-1.7 0-1.7.9l.7 17c0 1.1 1.4 1.6 2.1.8l4.1-5.1c.5-.6 1.2-.9 2-.9h6c1.1 0 1.6-1.4.8-2.1L5.6 2.8Z" />
    </svg>
  );
}

function PanelContextMenu({
  menu,
  isCollapsed,
  onSelect,
}: {
  menu: PanelContextMenuState;
  isCollapsed: boolean;
  onSelect: () => void;
}) {
  const panelName = menu.target === "project" ? "Project" : "Tools";
  return (
    <div
      className="panel-context-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button role="menuitem" onClick={onSelect}>
        {isCollapsed ? `Expand ${panelName}` : `Collapse ${panelName}`}
      </button>
    </div>
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
  onRefresh,
  onDiscard,
  busy,
}: {
  plan: SyncPlan;
  selectedFiles: Set<string>;
  onToggle: (path: string) => void;
  onClose: () => void;
  onApply: () => void;
  onRefresh: (files: string[]) => void;
  onDiscard: (files: string[]) => void;
  busy: boolean;
}) {
  const [activeFile, setActiveFile] = useState<ChangedFile | null>(plan.changedFiles[0] ?? null);
  useEffect(() => {
    if (!activeFile || !plan.changedFiles.some((file) => file.path === activeFile.path)) {
      setActiveFile(plan.changedFiles[0] ?? null);
    }
  }, [activeFile, plan.changedFiles]);
  const selectedChangedFiles = plan.changedFiles.filter((file) => selectedFiles.has(file.path));
  const hasUnsafeSelection = selectedChangedFiles.some((file) => !file.canApply);
  const refreshableFiles = selectedChangedFiles
    .filter((file) => file.originalChangedSinceOpen && !file.snapshotChangedSinceOpen)
    .map((file) => file.path);
  const discardableFiles = selectedChangedFiles
    .filter((file) => file.snapshotChangedSinceOpen)
    .map((file) => file.path);
  const hasConflicts = plan.changedFiles.some(
    (file) => file.originalChangedSinceOpen && file.snapshotChangedSinceOpen,
  );
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
          {hasConflicts && <p>Conflict files are blocked from direct apply because both sides changed.</p>}
        </div>
        <div className="sync-content">
          <div className="sync-files">
            {plan.changedFiles.map((file) => (
              <label key={file.path} className={activeFile?.path === file.path ? "active" : ""}>
                <input
                  type="checkbox"
                  checked={selectedFiles.has(file.path)}
                  disabled={busy || (!file.canApply && file.snapshotChangedSinceOpen)}
                  onChange={() => onToggle(file.path)}
                />
                <button type="button" onClick={() => setActiveFile(file)}>
                  <strong>{file.path}</strong>
                  <span className="file-badges">
                    <FileBadge file={file} />
                    <span>{file.status}</span>
                  </span>
                </button>
              </label>
            ))}
          </div>
          <div className="diff-panel">
            {activeFile?.warning && <div className="conflict-note">{activeFile.warning}</div>}
            <pre className="diff-view">{activeFile?.diff ?? "No changes."}</pre>
          </div>
        </div>
        <div className="modal-actions">
          <button onClick={() => onRefresh(refreshableFiles)} disabled={busy || refreshableFiles.length === 0}>
            Refresh From Original
          </button>
          <button onClick={() => onDiscard(discardableFiles)} disabled={busy || discardableFiles.length === 0}>
            Discard Snapshot Changes
          </button>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={onApply} disabled={busy || selectedFiles.size === 0 || hasUnsafeSelection}>
            Apply Selected
          </button>
        </div>
      </section>
    </div>
  );
}

function FileBadge({ file }: { file: ChangedFile }) {
  if (file.originalChangedSinceOpen && file.snapshotChangedSinceOpen) {
    return <span className="badge conflict">Conflict</span>;
  }
  if (file.originalChangedSinceOpen) {
    return <span className="badge original">Original</span>;
  }
  if (file.snapshotChangedSinceOpen) {
    return <span className="badge snapshot">Snapshot</span>;
  }
  return <span className="badge">Changed</span>;
}

function replaceFile(files: SourceFile[], path: string, content: string): SourceFile[] {
  return files.map((file) => (file.path === path ? { ...file, content } : file));
}

function toCssPx(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "0px";
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return `${trimmed}px`;
  }
  return trimmed;
}

function roundMetric(value: number) {
  return Math.round(value * 10) / 10;
}

function formatMetricInput(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatMetricDisplay(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function parseCssNumber(value: string) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
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
