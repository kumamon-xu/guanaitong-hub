import { randomUUID } from 'node:crypto';
import type { SyncResult } from '../src/shared/types';
import type { SyncTask, SyncPhase } from '../src/shared/operations';
import { classifyFailure,OfficialFailure } from './official-client';

export interface SyncContext { signal: AbortSignal; progress(phase: SyncPhase, page?: number, completed?: number, total?: number | null): void; }
interface Job { task: SyncTask; controller: AbortController; run(context: SyncContext): Promise<SyncResult>; resolve(result: SyncResult): void; promise: Promise<SyncResult>; }
export class SyncManager {
  private jobs = new Map<string, Job>();
  private queued: Job[] = [];
  private active = 0;
  private history: SyncTask[];
  constructor(private readonly options: { concurrency(): number; persist(task: SyncTask): void; changed(tasks: SyncTask[]): void; initial?: SyncTask[] }) { this.history=options.initial??[]; }
  list(): SyncTask[] { return structuredClone(this.history.slice(0,100)); }
  get running(): boolean { return this.jobs.size>0; }
  private publish(task: SyncTask): void {
    this.history=[structuredClone(task),...this.history.filter(item=>item.id!==task.id)].slice(0,100);
    this.options.persist(task);this.options.changed(this.list());
  }
  run(cardId: string, run: Job['run'], batchId=randomUUID()): Promise<SyncResult> {
    const existing=this.jobs.get(cardId); if(existing)return existing.promise;
    let resolve!:Job['resolve'];const promise=new Promise<SyncResult>(done=>{resolve=done;});
    const job:Job={task:{id:randomUUID(),batchId,cardId,status:'queued',phase:'queued',page:0,completed:0,total:null,message:'等待同步',errorKind:null,startedAt:new Date().toISOString(),finishedAt:null},controller:new AbortController(),run,resolve,promise};
    this.publish(job.task);this.jobs.set(cardId,job);this.queued.push(job);this.pump();return promise;
  }
  cancel(cardId?: string): void {
    for(const job of this.jobs.values())if(!cardId||job.task.cardId===cardId)job.controller.abort(new DOMException('用户取消同步','AbortError'));
    const cancelled=this.queued.filter(job=>job.controller.signal.aborted);
    this.queued=this.queued.filter(job=>!job.controller.signal.aborted);
    for(const job of cancelled)this.finish(job,{cardId:job.task.cardId,ok:false,cancelled:true,message:'已取消排队同步'});
    this.pump();
  }
  private pump():void {
    const maximum=Math.max(1,Math.min(3,this.options.concurrency()));
    while(this.active<maximum&&this.queued.length){
      const job=this.queued.shift()!;
      if(job.controller.signal.aborted){this.finish(job,{cardId:job.task.cardId,ok:false,cancelled:true,message:'已取消同步'});continue;}
      this.active++;job.task.status='running';
      this.publish(job.task);
      const context:SyncContext={signal:job.controller.signal,progress:(phase,page=0,completed=0,total=null)=>{
        job.controller.signal.throwIfAborted();Object.assign(job.task,{phase,page,completed,total,message:'正在同步'});this.publish(job.task);
      }};
      void job.run(context).then(result=>this.finish(job,result),error=>{
        job.task.errorKind=classifyFailure(error);
        if(error instanceof OfficialFailure)job.task.endpoint=error.endpoint;
        this.finish(job,{cardId:job.task.cardId,ok:false,cancelled:job.controller.signal.aborted,message:job.controller.signal.aborted?'已取消同步':error instanceof Error?error.message:'同步失败'});
      }).finally(()=>{this.active--;this.pump();});
    }
  }
  private finish(job:Job,result:SyncResult):void {
    Object.assign(job.task,{status:result.cancelled?'cancelled':result.ok?'succeeded':'failed',phase:result.ok?'complete':job.task.phase,message:result.message,errorKind:result.cancelled?'cancelled':result.ok?null:job.task.errorKind??'unknown',finishedAt:new Date().toISOString()});
    try{this.publish(job.task);}finally{this.jobs.delete(job.task.cardId);job.resolve(result);}
  }
  async all(cardIds:string[],run:(cardId:string,context:SyncContext)=>Promise<SyncResult>):Promise<SyncResult[]>{
    const batch=randomUUID();return Promise.all(cardIds.map(id=>this.run(id,context=>run(id,context),batch)));
  }
}
