import {newsGoal} from "natlang:services";
import planNewsGoal from "./reviewUserNewsGoal/planNewsGoal.nl";
import reconcileNewsGoal from "./reviewUserNewsGoal/reconcileNewsGoal.js";
import readReader from "./reviewers/readReader.nl";
import reviewSchedule from "./reviewers/reviewSchedule.nl";
import type {NewsUserGoalReport,NewsGoalScheduleFinding} from "./types.js";
export default async function reviewUserNewsGoal(goal:string):Promise<NewsUserGoalReport>{
 const initial=await newsGoal.observeCadence(),plan=await planNewsGoal(goal,initial);
 const change=await reconcileNewsGoal(goal,plan.changes,initial);
 const readers:NewsUserGoalReport["readers"]=[];
 for(const selection of plan.readers)readers.push({selection,review:await readReader(await newsGoal.readReader(selection))});
 const schedule:NewsGoalScheduleFinding[]=[...change.findings];
 for(const intent of plan.checks)schedule.push({intent,review:await reviewSchedule({kind:"schedule",goal,...change.cadence,intent})});
 return {status:change.blocked?"blocked":change.changed?"changed":"reviewed",cadence:change.cadence,readers,schedule};
}
