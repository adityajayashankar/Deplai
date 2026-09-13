'use client';
import { useEffect, useState } from 'react';
import { RemediationActivityLog } from '@/features/security/RemediationActivityLog';
import { appBtnPaper, secPaper } from '@/features/workspace/theme';
type Archive = { run: {status:string;expire_at:string;usage?:unknown}; events:Array<{type:string;content:string;created_at:string}>; packets:Array<{packet_id:string;result:{changed_files?:Array<{path:string;diff?:string}>}}>;
 billing:{status:string;credits_debited:number|null} };
export function RemediationRunArchive({sessionId}:{sessionId:string}) {
 const [archive,setArchive]=useState<Archive|null>(null); const [error,setError]=useState('');
 useEffect(() => {
   let disposed = false;
   const load = async () => {
     try {
       const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/remediation`, {cache:'no-store'});
       const data = await response.json();
       if (!response.ok) throw new Error(data.error || 'Archive unavailable');
       if (!disposed) { setArchive(data); setError(''); }
     } catch (error) { if (!disposed) setError(error instanceof Error ? error.message : 'Archive unavailable'); }
   };
   void load();
   const timer = setInterval(() => { void load(); }, 30000);
   return () => { disposed = true; clearInterval(timer); };
 }, [sessionId]);
 return <section className={`${secPaper} my-6 p-5`}>
  <h3 className="text-lg font-semibold">Remediation run record</h3>
  {error ? <p role="alert" className="mt-3 text-amber-900">{error}</p> : !archive ? <p className="mt-3">Loading saved run...</p> : <>
   <div className="my-4 flex flex-wrap gap-6 text-sm"><p>Status: <strong>{archive.run.status}</strong></p><p>Remediation credits debited: <strong>{archive.billing.credits_debited === null ? 'Settlement not recorded' : archive.billing.credits_debited.toFixed(2)}</strong></p><p>Retained through: {new Date(archive.run.expire_at).toLocaleDateString()}</p></div>
   <p className="mb-4 text-xs text-zinc-600">This is the recorded remediation settlement, not OpenRouter dollar spend. Missing settlement is not shown as zero. Saved patch candidates are not proof that vulnerabilities were fixed.</p>
   <a className={appBtnPaper} href={`/api/sessions/${encodeURIComponent(sessionId)}/remediation?download=1`}>Download full run record (JSON)</a>
   <div className="mt-4"><RemediationActivityLog messages={archive.events.map(e=>({type:e.type,content:e.content,timestamp:e.created_at}))} active={false}/></div>
   <details className="mt-4"><summary className="cursor-pointer font-semibold">Saved patch candidates ({archive.packets.reduce((n,p)=>n+(p.result.changed_files?.length||0),0)})</summary>
    {archive.packets.map(packet=>(packet.result.changed_files||[]).map((file,index)=><details key={`${packet.packet_id}-${index}`} className="mt-3 border border-black p-3"><summary className="cursor-pointer break-all">{file.path}</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{file.diff||'No diff recorded'}</pre></details>))}
   </details>
  </>}
 </section>;
}
