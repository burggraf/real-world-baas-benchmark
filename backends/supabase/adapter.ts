import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Backend, AppSession, BackendInfo } from "../../src/backend.js";
import type { Credentials, DatasetProfile } from "../../src/domain.js";
import { BenchmarkOperationError } from "../../src/correctness.js";
import { supabaseProcess } from "./process.js";
export function normalizeSupabaseError(error:unknown,status?:number):BenchmarkOperationError { const e=error as {code?:unknown;status?:unknown}; const s=status??(typeof e.status==="number"?e.status:undefined); const classification=s===401?"authentication":s===403?"authorization":s===408?"timeout":"transport/sdk"; return new BenchmarkOperationError(classification,{status:s,code:typeof e.code==="string"?e.code:"supabase_error"}); }
export function pageRange(page:number,pageSize:number):[number,number] { if(!Number.isInteger(page)||page<0||!Number.isInteger(pageSize)||pageSize<=0) throw new BenchmarkOperationError("invalid_response",{code:"pagination"}); return [page*pageSize,page*pageSize+pageSize-1]; }
export function createSupabaseClient(url:string,key:string,projectId:string):SupabaseClient { return createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false,storageKey:`local-${projectId}-auth`}}); }
const unsupported=async():Promise<never>=>{throw new BenchmarkOperationError("transport/sdk",{code:"supabase_not_started"})};
const session:AppSession=Object.fromEntries(["dashboard","listTasks","getTask","createTask","updateTask","addComment","updateComment","updateMembershipRole","searchTasks","getProfile","updateProfile","refreshSession","signOut","close"].map(k=>[k,unsupported])) as AppSession;
export const backend:Backend={name:"supabase",doctor:async():Promise<BackendInfo>=>supabaseProcess.doctor(),start:()=>supabaseProcess.start(),reset:()=>supabaseProcess.reset(),stop:()=>supabaseProcess.stop(),seed:async(_p:DatasetProfile,_s:number)=>unsupported(),createSession:async(_c:Credentials)=>session};
