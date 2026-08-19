import type { BenchmarkConfig } from "./config.js";
import type { BackendInfo } from "./backend.js";
import type { DatasetProfile } from "./domain.js";

export interface Environment { runtime: string; runtimeVersion: string; os: string; architecture: string; host?: string; cpu?: string; memoryBytes?: number; }
export interface Correctness { findings: CorrectnessFinding[]; }
export interface CorrectnessFinding { name: string; passed: boolean; message?: string; }
export interface OperationMetric { count: number; errors: number; p50: number; p95: number; p99: number; min: number; max: number; unit: "milliseconds" | "seconds" | "requests"; }
export interface StageMetrics {
  requestedUsers: number; achievedUsers: number; elapsedSeconds: number; workflow: Record<string, number>; sdkReadTps: number; sdkWriteTps: number; readTps: number; writeTps: number;
  operations: Record<string, OperationMetric>;
}
export interface ResourceMetrics { name: string; unit: string; samples: number[]; }
export interface Capacity { users: number; saturation: boolean; reasons: string[]; }
export interface BenchmarkResult {
  schemaVersion: 1; runId: string; startedAt: string; publishable: boolean; backend: BackendInfo; dataset: DatasetProfile["name"]; seed: number;
  environment: Environment; versions: Record<string, string>; config: BenchmarkConfig; correctness: Correctness; stages: StageMetrics[]; resources: ResourceMetrics[];
  capacity: Capacity; failures: string[]; valid: boolean; validityReasons: string[];
}
