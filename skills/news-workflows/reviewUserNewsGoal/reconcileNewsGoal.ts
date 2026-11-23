import reconcileNewsLane from "./reconcileNewsGoal/reconcileNewsLane.nl";
import type {NewsCadenceSnapshot,NewsScheduleIntent,NewsGoalCadenceResult} from "../types.js";
export default async function reconcileNewsGoal(goal:string,changes:NewsScheduleIntent[],cadence:NewsCadenceSnapshot):Promise<NewsGoalCadenceResult>{
 const result:NewsGoalCadenceResult={cadence,blocked:false,changed:false,findings:[]};
 for(const intent of changes){
  const step=await reconcileNewsLane(goal,intent,result.cadence);
  result.cadence=step.cadence;result.findings.push(...step.findings);
  result.changed ||= step.changed;result.blocked=step.blocked;
  if(result.blocked)break;
 }
 return result;
}
