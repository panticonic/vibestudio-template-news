import {newsRead} from "natlang:services";
import type {NewsReaderEvidence, NewsScheduleEvidence} from "../../types.js";
/** Read the assigned News participant and mission observations. */
export default async function readNewsState():Promise<(NewsReaderEvidence | NewsScheduleEvidence)[]>{
 return newsRead.observe();
}
