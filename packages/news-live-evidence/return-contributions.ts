import {isDeepStrictEqual} from "node:util";
import type {ApplicationReturnContribution} from "@workspace-skills/system-testing/observed-application-outcome";
/** Bind the authored concat(step.findings) and explicit schedule-review branches. */
export function scheduleReturnContributions(schedule:readonly unknown[],changedReturns:readonly {value:unknown}[]):ApplicationReturnContribution[]{
 const findings=changedReturns.flatMap(row=>{
  if(!row.value||typeof row.value!=="object"||!("findings" in row.value)||!Array.isArray(row.value.findings))return [];
  return row.value.findings.map((finding,index)=>({finding,index}));
 });
 return schedule.flatMap((entry,index)=>{
  const matches=findings.filter(item=>isDeepStrictEqual(item.finding,entry));
  if(matches.length)return [...new Set(matches.map(item=>item.index))].map(localIndex=>({checks:["groundedScheduleFindings"],rootPath:["schedule",index],producerSourceSuffix:"reviewUserNewsGoal/reconcileNewsGoal/reconcileNewsLane.nl",producerPath:["findings",localIndex]}));
  return [{checks:["groundedScheduleFindings"],rootPath:["schedule",index,"review"],producerSourceSuffix:"reviewers/reviewSchedule.nl",producerPath:[]}];
 });
}
