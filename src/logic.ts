export interface LogicStep {
  n: number;
  title: string;
  body: string;
}
export interface GroupLogic {
  steps: LogicStep[];
}

// The panel explains only when a turn is judged and what context it carries.
// Per-turn evidence stays in the row trace.
export function logicFor(): GroupLogic {
  return {
    steps: [
      {
        n: 1,
        title: "判定时机",
        body: "每次用户发一条新消息（新的一轮）时判一次。同一轮里 agent 的后续请求（工具调用回传等）不再判。",
      },
      {
        n: 2,
        title: "带上一轮",
        body: "判下一轮时，会把上一轮的用户消息、助手回复，以及上一轮的判定结果（如果是本组的 intent）一起发给 Jev。所以像「继续」这样的短回复通常会沿用上一轮的分类。",
      },
    ],
  };
}
