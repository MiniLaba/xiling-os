export interface DeferredAssignment {
  schedule: "hourly" | "daily" | "weekdays" | "once";
  hour: number;
  minute: number;
  instruction: string;
  runOn?: string;
  when: string;
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNumber(raw: string): number | null {
  if (/^\d{1,2}$/u.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  const ten = raw.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/u);
  if (ten) return (ten[1] ? CN_DIGIT[ten[1]]! : 1) * 10 + (ten[2] ? CN_DIGIT[ten[2]]! : 0);
  if (raw.length === 1 && raw in CN_DIGIT) return CN_DIGIT[raw]!;
  return null;
}

function applyPeriod(prompt: string, hour: number): number {
  if (/下午|晚上|傍晚/u.test(prompt) && hour < 12) return hour + 12;
  if (/中午/u.test(prompt) && hour > 0 && hour < 11) return hour + 12;
  if (/凌晨/u.test(prompt) && hour === 12) return 0;
  return hour;
}

function clock(prompt: string): { hour: number; minute: number } | null {
  const colon = prompt.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/u);
  if (colon) {
    const hour = applyPeriod(prompt, Number(colon[1]));
    const minute = Number(colon[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  const point = prompt.match(/(?:凌晨|早上|上午|中午|下午|晚上|傍晚)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:点|时)(?:\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*分|\s*(半|一刻|三刻))?/u);
  if (point?.[1]) {
    const parsedHour = cnNumber(point[1]);
    if (parsedHour === null) return null;
    let minute = 0;
    if (point[3] === "半") minute = 30;
    else if (point[3] === "一刻") minute = 15;
    else if (point[3] === "三刻") minute = 45;
    else if (point[2]) {
      const parsedMinute = cnNumber(point[2]);
      if (parsedMinute === null || parsedMinute > 59) return null;
      minute = parsedMinute;
    }
    const hour = applyPeriod(prompt, parsedHour);
    if (hour > 23) return null;
    return { hour, minute };
  }
  const minuteOnly = prompt.match(/(\d{1,2})\s*分/u);
  if (minuteOnly && /每小时|每个小时/u.test(prompt)) {
    const minute = Number(minuteOnly[1]);
    if (minute > 59) return null;
    return { hour: 0, minute };
  }
  return null;
}

function localDay(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function instructionFrom(prompt: string): string {
  return prompt
    .replace(/每个?工作日|每周一到周五|每周|每小时|每个小时|每天|每日|今天|今日|今早|今晚|定时/gu, "")
    .replace(/(?:凌晨|早上|上午|中午|下午|晚上|傍晚)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:[:：]\s*\d{1,2}\s*分?|(?:点|时)(?:\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*分|\s*(?:半|一刻|三刻))?)/gu, "")
    .replace(/^(?:请|帮我|省|分)+/u, "")
    .replace(/请|帮我/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
}

export function deferredAssignment(prompt: string, now = new Date()): DeferredAssignment | null {
  if (/现在|马上|立刻/u.test(prompt)) return null;
  const promptClock = clock(prompt);
  const once = /今天|今日|今早|今晚/u.test(prompt) && !/每天|每日|每小时|每个小时|工作日|每周/u.test(prompt);
  const repeating = /每小时|每个小时|每天|每日|工作日|定时|每周/u.test(prompt);
  const impliedDaily = Boolean(promptClock) && /打开|提醒|检查|访问/u.test(prompt);
  if (once && !promptClock) return null;
  if (!once && !repeating && !impliedDaily) return null;
  const schedule = once ? "once" : /每小时|每个小时/u.test(prompt) ? "hourly" : /工作日|每周/u.test(prompt) ? "weekdays" : "daily";
  if (schedule !== "hourly" && !promptClock) return null;
  const hour = schedule === "hourly" ? 0 : promptClock!.hour;
  const minute = promptClock?.minute ?? 0;
  const runOn = schedule === "once" ? localDay(now) : undefined;
  const clockText = `${hour}:${String(minute).padStart(2, "0")}`;
  const when = schedule === "hourly"
    ? `每小时 ${minute} 分`
    : schedule === "once"
      ? `今天 ${clockText}`
      : `${schedule === "weekdays" ? "工作日" : "每天"} ${clockText}`;
  const instruction = instructionFrom(prompt);
  return { schedule, hour, minute, instruction, ...(runOn ? { runOn } : {}), when };
}

export function deferredAssignmentReply(prompt: string, now = new Date()): string | null {
  const deferred = deferredAssignment(prompt, now);
  if (!deferred) return null;
  return `到${deferred.when} 再执行：${deferred.instruction}。点「加入」后才会到点开始。`;
}
