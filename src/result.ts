import type { BenchmarkConfig, OperationClass } from "./config.js";
import type { BackendInfo } from "./backend.js";
import type { DatasetProfile } from "./domain.js";
import type { ResourceSnapshot } from "./system.js";

export interface Environment { runtime: string; runtimeVersion: string; os: string; architecture: string; host?: string; cpu?: string; memoryBytes?: number; release?: string; logicalCores?: number; gitCommit?: string | null; gitDirty?: boolean | null; sdkVersion?: string | null; cpuModel?: string | null; npmVersion?: string | null; dockerVersion?: string | null; supabaseVersion?: string | null; unavailable?: Record<string, string>; }
export type FindingClassification = "authentication" | "authorization" | "timeout" | "transport/sdk" | "invalid_response" | "application" | "backend_health";
export type ErrorClassification = "expected_rejection" | "authentication" | "authorization" | "timeout" | "transport/sdk" | "invalid_response" | "backend_health" | "runner_overload" | "application_failure";
export interface ErrorExample { type: "workflow" | "sdk"; name: string; workflow: string; operationClass: string; kind: "read" | "write"; classification: ErrorClassification; nameOfError: string; message: string; occurrences: number; }
export interface Correctness { findings: CorrectnessFinding[]; aborted?: boolean; abortReason?: string; }
export interface CorrectnessFinding { name: string; passed: boolean; classification: FindingClassification; message?: string; evidence?: string; }
export interface OperationMetric {
  operationCount: number; errorCount: number;
  latencyP50Ms: number; latencyP95Ms: number; latencyP99Ms: number; latencyMinMs: number; latencyMaxMs: number;
  type: "workflow" | "sdk"; name: string; workflow: string; operationClass: string; kind: "read" | "write";
  attemptedCount: number; completedCount: number; failedCount: number; errorRate: number; successRate?: number; throughputPerSecond: number; errorCounts: Record<string, number>;
}
export interface OperationClassMetric {
  attempted: number; completed: number; failed: number; errorRate: number;
  latencyP50Ms: number; latencyP95Ms: number; latencyP99Ms: number; latencyMinMs: number; latencyMaxMs: number;
}
export interface StageMetrics {
  requestedUsers: number; achievedUsers: number; elapsedSeconds: number;
  workflowTransactionsPerSecond: number; workflowTransactionsPerSecondByName: Record<string, number>;
  sdkOperationsPerSecond: number; readOperationsPerSecond: number; writeOperationsPerSecond: number;
  workflowCompletionCountByName?: Record<string, number>;
  operationClassMetrics: Record<OperationClass, OperationClassMetric>;
  operations: Record<string, OperationMetric>;
  errorExamples: ErrorExample[]; valid: boolean; validityReasons: string[];
}
export interface ResourceMetrics { name: string; unit: string; samples: number[]; reasons?: (string | null)[]; snapshots?: ResourceSnapshot[]; reason?: string; }
export interface Capacity { users: number; saturation: boolean; reasons: string[]; }
export interface BenchmarkResult {
  schemaVersion: 1; runId: string; startedAt: string; publishable: boolean; backend: BackendInfo; dataset: DatasetProfile["name"]; seed: number;
  environment: Environment; versions: Record<string, string>; config: BenchmarkConfig; correctness: Correctness; stages: StageMetrics[]; resources: ResourceMetrics[];
  capacity: Capacity; failures: string[]; valid: boolean; validityReasons: string[];
}
