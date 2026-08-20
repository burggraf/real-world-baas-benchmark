import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve, join } from "node:path";

export const SUPABASE_VERSION = "2.115.0";
export const SUPABASE_PROJECT_ID = "realworldbaasbench";
export const SUPABASE_PORTS = Object.freeze({ api: 55321, db: 55322, studio: 55323, inbucket: 55324, smtp: 55325, pop3: 55326, analytics: 55327, pooler: 55329 });
export const LOCAL_BENCHMARK_PASSWORD = "Benchmark-local-only-supabase!";
export interface SupabaseOptions { repoRoot:string; binary:string; projectId:string; workdir:string; ports:typeof SUPABASE_PORTS; }
export interface SupabaseStatus { API_URL?:string; REST_URL?:string; ANON_KEY?:string; PUBLISHABLE_KEY?:string; SERVICE_ROLE_KEY?:string; SECRET_KEY?:string; [key:string]:unknown }
const root = resolve(new URL("../..", import.meta.url).pathname);
export function resolveSupabaseOptions(env:NodeJS.ProcessEnv=process.env, repoRoot=root):SupabaseOptions {
 const workdir=resolve(repoRoot,"backends/supabase");
 return {repoRoot:resolve(repoRoot), binary:resolve(repoRoot,env.SUPABASE_BIN||"supabase"), projectId:SUPABASE_PROJECT_ID, workdir, ports:SUPABASE_PORTS};
}
export function buildSupabaseArgs(options:SupabaseOptions, args:readonly string[]):string[] { return ["--workdir",options.workdir,...args]; }
export function redactSupabaseOutput(value:string):string { return value.replace(/(SERVICE_ROLE_KEY|SECRET_KEY|JWT_SECRET|ANON_KEY|PUBLISHABLE_KEY|password|token)\s*[:=]\s*[^\s,}]+/gi,"$1=<redacted>"); }
export function parseSupabaseStatus(stdout:string):SupabaseStatus { const parsed=JSON.parse(stdout) as unknown; if (!parsed || typeof parsed!=="object" || Array.isArray(parsed)) throw new Error("invalid Supabase status"); return parsed as SupabaseStatus; }
export function runSupabase(options:SupabaseOptions,args:readonly string[],timeout=120000):Promise<{stdout:string;stderr:string}> { return new Promise((resolveRun,reject)=>{ const child=spawn(options.binary,buildSupabaseArgs(options,args),{cwd:options.repoRoot,shell:false,env:{...process.env,SUPABASE_PROJECT_ID:options.projectId},stdio:["ignore","pipe","pipe"]}); let stdout="",stderr=""; child.stdout?.on("data",d=>{stdout+=d.toString(); if(stdout.length>1_000_000) child.kill();}); child.stderr?.on("data",d=>{stderr+=d.toString().slice(0,10000);}); const timer=setTimeout(()=>{child.kill();reject(new Error("supabase command timeout"));},timeout); child.once("error",e=>{clearTimeout(timer);reject(e)}); child.once("close",code=>{clearTimeout(timer); code===0?resolveRun({stdout,stderr}):reject(new Error(`supabase exited ${code}: ${redactSupabaseOutput(stderr)}`));}); }); }
export async function portAvailable(port:number):Promise<boolean>{return new Promise(r=>{const s=createServer();s.once("error",()=>r(false));s.listen(port,"127.0.0.1",()=>s.close(()=>r(true)));});}
export class SupabaseProcess { constructor(public readonly options=resolveSupabaseOptions()){} async doctor(){ const v=spawnSync(this.options.binary,["--version"],{shell:false,encoding:"utf8"}); if(v.status!==0) throw new Error("Supabase CLI unavailable"); for(const p of Object.values(this.options.ports)) if(!(await portAvailable(p))) throw new Error(`port unavailable: ${p}`); return {name:"supabase" as const,version:SUPABASE_VERSION,endpoint:`http://127.0.0.1:${this.options.ports.api}`}; } async start(){await runSupabase(this.options,["start"])} async status(){return parseSupabaseStatus((await runSupabase(this.options,["status","-o","json"])).stdout)} async reset(){await runSupabase(this.options,["db","reset","--local"])} async stop(){await runSupabase({...this.options},["stop","--project-id",this.options.projectId])} }
export const supabaseProcess=new SupabaseProcess();
