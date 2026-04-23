export type NodeType =
  | "page"
  | "component"
  | "jsx_element"
  | "style_rule"
  | "asset"
  | "code_file";

export interface ProjectSnapshot {
  id: string;
  originalPath: string;
  snapshotPath: string;
  packageManager: string;
  frameworkGuess: string;
  devCommand: string;
  createdAt: string;
}

export interface SourceFile {
  path: string;
  kind: "react" | "style" | "code";
  content: string;
}

export interface ProjectNode {
  id: string;
  type: NodeType;
  displayName: string;
  sourceFile: string;
  sourceRange: {
    start: number;
    end: number;
  };
  parentId: string | null;
  childrenIds: string[];
  depth: number;
}

export interface SourceMapping {
  domId: string;
  nodeId: string;
  filePath: string;
  start: number;
  end: number;
}

export interface OpenProjectResponse {
  snapshot: ProjectSnapshot;
  sourceFiles: SourceFile[];
  warnings: string[];
}

export interface PreviewResponse {
  url: string;
  command: string;
  port: number;
}

export interface ChangedFile {
  path: string;
  status: string;
  diff: string;
}

export interface SyncPlan {
  changedFiles: ChangedFile[];
  warnings: string[];
}

export interface ApplySyncResponse {
  appliedFiles: string[];
  backupRoot: string;
}

export interface AnalysisResult {
  nodes: ProjectNode[];
  mappings: SourceMapping[];
  sourceFiles: SourceFile[];
  warnings: string[];
}

export interface StyleUpdate {
  property: string;
  value: string;
}

export type StyleMode = "tailwind" | "inline" | "css";

export type StructureOperation =
  | "move_up"
  | "move_down"
  | "duplicate"
  | "delete"
  | "wrap"
  | "unwrap"
  | "insert_child";

export interface EditOperation {
  operationType:
    | "style_update"
    | "move_node"
    | "duplicate_node"
    | "delete_node"
    | "insert_node"
    | "wrap_node"
    | "code_edit";
  targetNodeId: string;
  payload: Record<string, unknown>;
  timestamp: string;
  resultingFiles: string[];
}
