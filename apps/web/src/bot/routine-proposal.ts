export interface RoutineProposal {
  schedule: "hourly" | "daily" | "weekdays" | "once";
  hour: number;
  minute: number;
  instruction: string;
  runOn?: string;
}

const ROUTINE_BLOCK = /```xiling-routine\s*([\s\S]*?)```/u;

export function visibleReply(text: string): string {
  return text.replace(ROUTINE_BLOCK, "").replace(/\n{3,}/gu, "\n\n").trim();
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

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

export function localDate(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function instructionFrom(prompt: string): string {
  const stripped = prompt
    .replace(/每个?工作日|每周一到周五|每周|每小时|每个小时|每天|每日|今天|今日|今早|今晚|定时/gu, "")
    .replace(/(?:凌晨|早上|上午|中午|下午|晚上|傍晚)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:[:：]\s*\d{1,2}\s*分?|(?:点|时)(?:\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*分|\s*(?:半|一刻|三刻))?)/gu, "")
    .replace(/^(?:请|帮我|省|分)+/u, "")
    .replace(/请|帮我/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return (stripped || prompt.trim()).slice(0, 2_000);
}

function spokenSchedule(prompt: string, promptClock: { hour: number; minute: number } | null): Pick<RoutineProposal, "schedule" | "runOn"> | null {
  const once = /今天|今日|今早|今晚/u.test(prompt) && !/每天|每日|每小时|每个小时|工作日|每周/u.test(prompt);
  if (once && promptClock) return { schedule: "once", runOn: localDate(new Date()) };
  const repeating = /每小时|每个小时|每天|每日|工作日|定时|每周/u.test(prompt);
  const impliedDaily = Boolean(promptClock) && /打开|提醒|检查|访问/u.test(prompt) && !/现在|马上|立刻/u.test(prompt);
  if (!repeating && !impliedDaily) return null;
  const schedule = /每小时|每个小时/u.test(prompt) ? "hourly" : /工作日|每周/u.test(prompt) ? "weekdays" : "daily";
  if (schedule !== "hourly" && !promptClock) return null;
  return { schedule };
}

export function proposeRoutine(prompt: string, answer: string): RoutineProposal | null {
  const promptClock = clock(prompt);
  const spoken = spokenSchedule(prompt, promptClock);
  const block = answer.match(ROUTINE_BLOCK)?.[1];
  if (block) {
    try {
      const parsed = JSON.parse(block) as Partial<RoutineProposal>;
      if (parsed.schedule === "hourly" || parsed.schedule === "daily" || parsed.schedule === "weekdays" || parsed.schedule === "once" || spoken) {
        const schedule = spoken?.schedule ?? parsed.schedule;
        if (schedule === "hourly" || schedule === "daily" || schedule === "weekdays" || schedule === "once") {
          const proposal: RoutineProposal = {
            schedule,
            hour: schedule === "hourly" ? 0 : (promptClock?.hour ?? bounded(parsed.hour, 0, 23, 8)),
            minute: promptClock?.minute ?? bounded(parsed.minute, 0, 59, 0),
            instruction: instructionFrom(promptClock || spoken ? prompt : String(parsed.instruction || prompt)),
          };
          if (schedule === "once") proposal.runOn = spoken?.runOn ?? localDate(new Date());
          return proposal;
        }
      }
    } catch {
      // The model block was incomplete; fall through to the wording itself.
    }
  }
  if (!spoken) return null;
  const proposal: RoutineProposal = {
    schedule: spoken.schedule,
    hour: spoken.schedule === "hourly" ? 0 : promptClock!.hour,
    minute: promptClock?.minute ?? 0,
    instruction: instructionFrom(prompt),
  };
  if (spoken.runOn) proposal.runOn = spoken.runOn;
  return proposal;
}

export function routineWhen(proposal: Pick<RoutineProposal, "schedule" | "hour" | "minute" | "runOn">): string {
  if (proposal.schedule === "hourly") return `每小时 ${proposal.minute} 分`;
  const clockText = `${proposal.hour}:${String(proposal.minute).padStart(2, "0")}`;
  if (proposal.schedule === "once") return `${proposal.runOn === localDate(new Date()) ? "今天" : proposal.runOn ?? "今天"} ${clockText}`;
  return `${proposal.schedule === "weekdays" ? "工作日" : "每天"} ${clockText}`;
}
