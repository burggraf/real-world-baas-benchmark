import type { OperationClass } from "./config.js";
import type { StageMetrics, OperationMetric, ErrorClassification, ErrorExample } from "./result.js";
import { configuredWorkflowNames, type WorkloadSample, type SampleKind } from "./workflows.js";

const kinds: SampleKind[] = ["read", "write"];
const classes: OperationClass[] = ["read", "write", "authSearch"];
const workflows = new Set<string>(configuredWorkflowNames.map(name => name === "signIn" ? "signOutIn" : name));
const safePositive = (n: number, label: string) => { if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${label} must be a positive safe integer`); return n; };
const finiteDivide = (numerator: number, denominator: number, label: string): number => { if (numerator === 0) return 0; const value = numerator / denominator; if (!Number.isFinite(value)) throw new Error(`${label} must be finite`); return value; };
const key = (s: WorkloadSample) => JSON.stringify([s.type,s.name,s.workflow,s.operationClass,s.kind]);
const redactAuthorization = (message: string): string => {
  let output = "", last = 0, i = 0;
  while (i < message.length) {
    const quote = message[i] === "\"" || message[i] === "'" ? message[i] : "";
    const keyStart = quote ? i + 1 : i;
    if (message.slice(keyStart, keyStart + 13).toLowerCase() !== "authorization" || (quote ? message[keyStart + 13] !== quote : (keyStart > 0 && /[A-Za-z0-9_]/.test(message[keyStart - 1]!)) || /[A-Za-z0-9_]/.test(message[keyStart + 13] ?? ""))) { i++; continue; }
    let j = keyStart + 13;
    if (quote) j++;
    while (/\s/.test(message[j] ?? "")) j++;
    if (message[j] !== ":" && message[j] !== "=") { i++; continue; }
    j++; while (/\s/.test(message[j] ?? "")) j++;
    const valueStart = j;
    if (message[j] === "\"" || message[j] === "'") {
      const valueQuote = message[j++]!; let escaped = false;
      while (j < message.length) { if (!escaped && message[j] === valueQuote) break; if (!escaped && message[j] === "\\") escaped = true; else escaped = false; j++; }
      if (last < valueStart) output += message.slice(last, valueStart);
      output += "[REDACTED]"; if (j < message.length) { output += valueQuote; j++; } last = j; i = j; continue;
    }
    while (j < message.length && !/[\\r\\n,;}]/.test(message[j]!)) j++;
    const valueEnd = j;
    if (last < valueStart) output += message.slice(last, valueStart);
    output += "[REDACTED]"; last = valueEnd; i = valueEnd;
  }
  return output + message.slice(last);
};
const redact = (message: string): string => redactAuthorization(message).replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/._=-]+/gi,"$1 [REDACTED]").replace(/(["'])(password|passwd|secret|token|key|api[_-]?key|access[_-]?key)\1\s*:\s*(["'])[^"']*\3/gi,"$1$2$1:$3[REDACTED]$3").replace(/\b(password|passwd|secret|token|key|api[_-]?key|access[_-]?key)\s*[:=]\s*[^\s,;]+/gi,"$1=[REDACTED]").replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,"[REDACTED]").slice(0,500);
const classify = (e: NonNullable<WorkloadSample["error"]>): ErrorClassification => {
  const explicit = (e.classification ?? e.code ?? e.name).toLowerCase();
  if (/expected[_ -]?rejection|application[_ -]?rejection|rejected/.test(explicit)) return "expected_rejection";
  if (/authenticat/.test(explicit)) return "authentication";
  if (/authoriz|forbidden|permission/.test(explicit)) return "authorization";
  if (/timeout|timed.?out|deadline/.test(explicit)) return "timeout";
  if (/transport|network|socket|sdk/.test(explicit)) return "transport/sdk";
  if (/invalid.?response|parse|schema/.test(explicit)) return "invalid_response";
  if (/backend|health|process|server.?error|5\d\d/.test(explicit)) return "backend_health";
  if (/overload|capacity|too.?many|429/.test(explicit)) return "runner_overload";
  const text = `${e.name} ${e.message}`.toLowerCase();
  if (/expected application rejection|application rejected|expected rejection/.test(text)) return "expected_rejection";
  if (/timed.?out|timeout|deadline/.test(text)) return "timeout";
  if (/\b(401|unauthenticated)\b|authentication failed|invalid credentials/.test(text)) return "authentication";
  if (/\b(403|forbidden|not authorized)\b/.test(text)) return "authorization";
  if (/econn|network|socket|fetch failed/.test(text)) return "transport/sdk";
  if (/invalid response|unexpected response|parse error/.test(text)) return "invalid_response";
  if (/overload|too many requests|\b429\b/.test(text)) return "runner_overload";
  if (/backend|service unavailable|\b5\d\d\b/.test(text)) return "backend_health";
  return "application_failure";
};
// ponytail: exact in-memory samples are simplest; replace with HDR histograms when a real run reaches the configured sample ceiling.
interface Bucket { sample: WorkloadSample; attempted: number; completed: number; failed: number; latencies: number[]; errors: Map<ErrorClassification, number>; }
export interface MetricsOptions { maxLatencySamples?: number; maxErrorExamples?: number; }
export class StageMetricsAccumulator {
  private readonly maxLatency: number; private readonly maxExamples: number; private finalized = false; private invalidReason?: string;
  private readonly buckets = new Map<string, Bucket>(); private readonly examples = new Map<string, ErrorExample>(); private retainedLatencies = 0;
  constructor(options: MetricsOptions = {}) { this.maxLatency = safePositive(options.maxLatencySamples ?? 100_000, "maxLatencySamples"); this.maxExamples = safePositive(options.maxErrorExamples ?? 100, "maxErrorExamples"); }
  record(sample: WorkloadSample): void {
    if (this.finalized) throw new Error("Cannot record after finalize");
    if (!sample || (sample.type !== "workflow" && sample.type !== "sdk") || typeof sample.name !== "string" || !sample.name || !workflows.has(sample.workflow) || !classes.includes(sample.operationClass) || !kinds.includes(sample.kind) || typeof sample.success !== "boolean" || !Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0 || (sample.success && sample.error) || (!sample.success && (!sample.error || typeof sample.error !== "object" || typeof sample.error.name !== "string" || !sample.error.name || typeof sample.error.message !== "string" || (sample.error.code !== undefined && typeof sample.error.code !== "string") || (sample.error.classification !== undefined && typeof sample.error.classification !== "string")))) throw new Error("Invalid workload sample");
    const k=key(sample); let b=this.buckets.get(k); if (!b) { b={sample:{...sample},attempted:0,completed:0,failed:0,latencies:[],errors:new Map()}; this.buckets.set(k,b); }
    b.attempted++; if (this.retainedLatencies < this.maxLatency) { b.latencies.push(sample.elapsedMs); this.retainedLatencies++; } else if (!this.invalidReason) this.invalidReason=`Latency sample ceiling exceeded for ${sample.name}`;
    if (sample.success) b.completed++; else { b.failed++; const c=classify(sample.error!); b.errors.set(c,(b.errors.get(c)??0)+1); const safeName=redact(sample.error!.name).slice(0,100); const safeMessage=redact(sample.error!.message); const ek=`${k}|${c}|${safeMessage}`; if (!this.examples.has(ek) && this.examples.size < this.maxExamples) this.examples.set(ek,{type:sample.type,name:sample.name,workflow:sample.workflow,operationClass:sample.operationClass,kind:sample.kind,classification:c,nameOfError:safeName,message:safeMessage,occurrences:1}); else if (this.examples.has(ek)) this.examples.get(ek)!.occurrences++; }
  }
  finalize(elapsedSeconds: number, users: { requestedUsers: number; achievedUsers: number }): StageMetrics {
    if (this.finalized) throw new Error("Stage already finalized"); if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) throw new Error("elapsedSeconds must be finite and positive"); if (!Number.isSafeInteger(users?.requestedUsers) || users.requestedUsers < 0 || !Number.isSafeInteger(users.achievedUsers) || users.achievedUsers < 0 || users.achievedUsers > users.requestedUsers) throw new Error("Invalid stage user counts"); this.finalized=true;
    const operations: Record<string, OperationMetric>={}; let workflowDone=0,sdkDone=0,reads=0,writes=0; const workflowByName:Record<string,number>={}, workflowCounts:Record<string,number>={};
    for(const [k,b] of this.buckets){ const l=[...b.latencies].sort((a,c)=>a-c); const pct=(p:number)=>l.length?l[Math.min(l.length-1,Math.ceil(p*l.length)-1)]!:0; const metric:OperationMetric={type:b.sample.type,name:b.sample.name,workflow:b.sample.workflow,operationClass:b.sample.operationClass,kind:b.sample.kind,attemptedCount:b.attempted,completedCount:b.completed,failedCount:b.failed,errorRate:finiteDivide(b.failed,b.attempted,"operation errorRate"),successRate:finiteDivide(b.completed,b.attempted,"operation successRate"),throughputPerSecond:finiteDivide(b.completed,elapsedSeconds,"operation throughput"),operationCount:b.attempted,errorCount:b.failed,latencyP50Ms:pct(.5),latencyP95Ms:pct(.95),latencyP99Ms:pct(.99),latencyMinMs:l[0]??0,latencyMaxMs:l[l.length-1]??0,errorCounts:Object.fromEntries(b.errors)}; operations[k]=metric; if(b.sample.type==="workflow"){workflowDone+=b.completed;workflowCounts[b.sample.name]=(workflowCounts[b.sample.name]??0)+b.completed;} else {sdkDone+=b.completed;if(b.sample.kind==="read")reads+=b.completed;else writes+=b.completed;} }
    for(const [n,c] of Object.entries(workflowCounts)) workflowByName[n]=finiteDivide(c,elapsedSeconds,"workflow throughput");
    return {requestedUsers:users.requestedUsers,achievedUsers:users.achievedUsers,elapsedSeconds,workflowTransactionsPerSecond:finiteDivide(workflowDone,elapsedSeconds,"workflow aggregate throughput"),workflowTransactionsPerSecondByName:workflowByName,sdkOperationsPerSecond:finiteDivide(sdkDone,elapsedSeconds,"SDK aggregate throughput"),readOperationsPerSecond:finiteDivide(reads,elapsedSeconds,"read throughput"),writeOperationsPerSecond:finiteDivide(writes,elapsedSeconds,"write throughput"),workflowCompletionCountByName:workflowCounts,operations,errorExamples:[...this.examples].map(([,e])=>({...e})),valid:!this.invalidReason,validityReasons:this.invalidReason?[this.invalidReason]:[]};
  }
}
export const createStageMetricsAccumulator = (options?: MetricsOptions) => new StageMetricsAccumulator(options);
