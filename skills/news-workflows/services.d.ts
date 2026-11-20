import type {
  NewsCadenceChange,
  NewsReaderEvidence,
  NewsScheduleEvidence,
} from "./types.js";

declare module "natlang:services" {
  export const newsRead: {
    observe(): Promise<(NewsReaderEvidence | NewsScheduleEvidence)[]>;
    finishCadence(
      change: NewsCadenceChange,
    ): Promise<(NewsReaderEvidence | NewsScheduleEvidence)[]>;
  };
}

declare module "natlang:services" {
  export const newsGoal: {
    observeCadence(): Promise<import("./types.js").NewsCadenceSnapshot>;
    readReader(
      selection: import("./types.js").NewsReaderSelection,
    ): Promise<NewsReaderEvidence>;
    apply(
      observationId: string,
      change: import("./types.js").NewsGoalChange,
    ): Promise<import("./types.js").NewsGoalApply>;
  };
}
