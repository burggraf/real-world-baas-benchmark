import type { BenchmarkConfig } from "./config.js";
import type { BackendInfo } from "./backend.js";
import type { DatasetProfile } from "./domain.js";

export interface Environment { runtime: string; runtimeVersion: string; os: string; architecture: string; host?: string; cpu?: string; memoryBytes?: number; }
export interface Correctness { findings: CorrectnessFinding[]; }
export interface CorrectnessFinding { name: string; passed: boolean; message?: string; }
export interface OperationMetric {
  operationCount: number; errorCount: number;
  latencyP50Ms: number; latencyP95Ms: number; latencyP99Ms: number; latencyMinMs: number; latencyMaxMs: number;
}
export interface StageMetrics {
  requestedUsers: number; achievedUsers: number; elapsedSeconds: number;
  workflowTransactionsPerSecond: number; workflowTransactionsPerSecondByName: Record<string, number>;
  sdkOperationsPerSecond: number; readOperationsPerSecond: number; writeOperationsPerSecond: number;
  workflowCompletionCountByName?: Record<string, number>;
  operations: Record<string, OperationMetric>;
}
export interface ResourceMetrics { name: string; unit: string; samples: number[]; }
export interface Capacity { users: number; saturation: boolean; reasons: string[]; }
export interface BenchmarkResult {
  schemaVersion: 1; runId: string; startedAt: string; publishable: boolean; backend: BackendInfo; dataset: DatasetProfile["name"]; seed: number;
  environment: Environment; versions: Record<string, string>; config: BenchmarkConfig; correctness: Correctness; stages: StageMetrics[]; resources: ResourceMetrics[];
  capacity: Capacity; failures: string[]; valid: boolean; validityReasons: string[];
}
