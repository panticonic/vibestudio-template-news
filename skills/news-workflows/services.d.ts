declare module "natlang:services" {
  export const newsRead: {
    observe(): Promise<(import("./types.js").NewsReaderEvidence | import("./types.js").NewsScheduleEvidence)[]>;
    finishCadence(
      change: import("./types.js").NewsCadenceChange,
    ): Promise<(import("./types.js").NewsReaderEvidence | import("./types.js").NewsScheduleEvidence)[]>;
  };
}

declare module "natlang:services" {
  export const newsGoal: {
    observeCadence(): Promise<import("./types.js").NewsCadenceSnapshot>;
    readReader(
      selection: import("./types.js").NewsReaderSelection,
    ): Promise<import("./types.js").NewsReaderEvidence>;
    apply(
      observationId: string,
      change: import("./types.js").NewsGoalChange,
    ): Promise<import("./types.js").NewsGoalApply>;
  };
}
