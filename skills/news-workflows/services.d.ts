import type { NewsReaderEvidence, NewsScheduleEvidence } from "./types.js";


declare module "natlang:services" {
  export const newsRead: {
    observe(): Promise<(NewsReaderEvidence | NewsScheduleEvidence)[]>;
  };
}
