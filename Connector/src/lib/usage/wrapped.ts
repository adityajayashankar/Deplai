export type WrappedStackItem = {
  label: string;
  percent: number;
  initial: string;
};

export type WrappedView = {
  year: number;
  displayName: string;
  shortName: string;
  possessiveLabel: string;
  avatarUrl: string;
  headline: string;
  primaryCountLabel: string;
  primaryCount: string;
  secondaryCountLabel: string;
  secondaryCount: string;
  growthLabel: string;
  personaBadge: string;
  personaLines: [string, string];
  personaBlurb: string;
  stackCaption: string;
  stack: WrappedStackItem[];
  categoryValue: string;
  peakTime: string;
  peakBlurb: string;
  heatmap: boolean[];
  shareTitle: string;
  shareSubtitle: string;
  shareText: string;
};

export type WrappedLanguage = {
  name: string;
  bytes: number;
};

export type WrappedRaw = {
  year: number;
  displayName: string;
  avatarUrl: string;
  projectsThisYear: number;
  projectsLastYear: number;
  chatMessagesThisYear: number;
  aiRequestsThisYear: number;
  aiTokensThisYear: number;
  creditsConsumedThisYear: number;
  languages: WrappedLanguage[];
  hourCounts: number[];
  weekdayCounts: number[];
  heatmapCounts: number[];
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const LANGUAGE_INITIALS: Record<string, string> = {
  typescript: 'TS',
  javascript: 'JS',
  python: 'PY',
  golang: 'GO',
  go: 'GO',
  rust: 'RS',
  ruby: 'RB',
  java: 'JV',
  php: 'PHP',
  csharp: 'C#',
  'c#': 'C#',
  cpp: 'C++',
  'c++': 'C++',
  kotlin: 'KT',
  swift: 'SW',
  terraform: 'TF',
  hcl: 'HCL',
  shell: 'SH',
  dockerfile: 'DK',
};

export function formatCompactCount(value: number): string {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n >= 1_000_000) {
    const scaled = n / 1_000_000;
    return `${scaled >= 10 || Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}M`;
  }
  if (n >= 10_000) {
    const scaled = n / 1_000;
    return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}k`;
  }
  return n.toLocaleString('en-US');
}

export function firstNameFrom(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) return 'You';
  return trimmed.split(/\s+/)[0];
}

export function possessiveFrom(name: string): string {
  const short = firstNameFrom(name);
  return /s$/i.test(short) ? `${short}'` : `${short}'s`;
}

export function stackInitial(name: string): string {
  const key = name.trim().toLowerCase();
  if (LANGUAGE_INITIALS[key]) return LANGUAGE_INITIALS[key];
  const compact = name.replace(/[^A-Za-z0-9]/g, '');
  if (compact.length >= 2 && compact === compact.toUpperCase()) return compact.slice(0, 2);
  return (compact.slice(0, 1) || '?').toUpperCase();
}

function emptyHourCounts(): number[] {
  return Array.from({ length: 24 }, () => 0);
}

function emptyWeekdayCounts(): number[] {
  return Array.from({ length: 7 }, () => 0);
}

function emptyHeatmap(): number[] {
  return Array.from({ length: 28 }, () => 0);
}

export function emptyWrappedRaw(input?: Partial<WrappedRaw>): WrappedRaw {
  return {
    year: input?.year || new Date().getFullYear(),
    displayName: input?.displayName || 'DeplAI user',
    avatarUrl: input?.avatarUrl || '',
    projectsThisYear: 0,
    projectsLastYear: 0,
    chatMessagesThisYear: 0,
    aiRequestsThisYear: 0,
    aiTokensThisYear: 0,
    creditsConsumedThisYear: 0,
    languages: [],
    hourCounts: emptyHourCounts(),
    weekdayCounts: emptyWeekdayCounts(),
    heatmapCounts: emptyHeatmap(),
    ...input,
  };
}

function percentsFromWeights(weights: number[], size: number): number[] {
  const values = weights.slice(0, size);
  while (values.length < size) values.push(0);
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) {
    const even = Math.floor(100 / size);
    const leftover = 100 - even * size;
    return values.map((_, index) => even + (index === 0 ? leftover : 0));
  }
  const raw = values.map((value) => (Math.max(0, value) / total) * 100);
  const rounded = raw.map((value) => Math.round(value));
  const drift = 100 - rounded.reduce((sum, value) => sum + value, 0);
  rounded[0] = Math.max(0, rounded[0] + drift);
  return rounded;
}

function buildStack(raw: WrappedRaw): { items: WrappedStackItem[]; caption: string } {
  const ranked = [...raw.languages]
    .filter((item) => item.bytes > 0 && item.name.trim())
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3);

  if (ranked.length > 0) {
    const percents = percentsFromWeights(ranked.map((item) => item.bytes), 3);
    const fallbacks = ['IaC', 'Security', 'Chat'];
    const items = [0, 1, 2].map((index) => {
      const language = ranked[index];
      const label = language?.name || fallbacks[index - ranked.length] || fallbacks[index];
      return {
        label,
        percent: percents[index],
        initial: stackInitial(label),
      };
    });
    return { items, caption: 'Based on repos' };
  }

  const percents = percentsFromWeights(
    [raw.projectsThisYear, raw.aiRequestsThisYear + raw.aiTokensThisYear, raw.chatMessagesThisYear],
    3,
  );
  return {
    items: [
      { label: 'Projects', percent: percents[0], initial: 'P' },
      { label: 'AI agents', percent: percents[1], initial: 'AI' },
      { label: 'Agent chat', percent: percents[2], initial: 'C' },
    ],
    caption: 'Based on activity',
  };
}

function pickCategory(raw: WrappedRaw): string {
  const scores: Array<[string, number]> = [
    ['Agent chat', raw.chatMessagesThisYear],
    ['AI requests', raw.aiRequestsThisYear],
    ['Projects', raw.projectsThisYear],
    ['Credits spent', raw.creditsConsumedThisYear],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  if (scores[0][1] <= 0) return 'Getting started';
  return scores[0][0];
}

function pickPersona(raw: WrappedRaw): { lines: [string, string]; blurb: string } {
  const total =
    raw.projectsThisYear +
    raw.chatMessagesThisYear +
    raw.aiRequestsThisYear +
    raw.aiTokensThisYear +
    raw.creditsConsumedThisYear;
  if (total <= 0) {
    return {
      lines: ['New', 'Operator'],
      blurb: 'You just walked onto the floor. This wrapped fills in as you scan, chat, and deploy.',
    };
  }

  const scores = [
    { id: 'projects', value: raw.projectsThisYear * 8 },
    { id: 'chat', value: raw.chatMessagesThisYear },
    { id: 'ai', value: raw.aiRequestsThisYear * 4 + Math.round(raw.aiTokensThisYear / 1000) },
    { id: 'credits', value: raw.creditsConsumedThisYear * 3 },
  ].sort((a, b) => b.value - a.value);

  const mixed = scores.filter((item) => item.value > 0).length >= 3;
  if (mixed) {
    return {
      lines: ['System', 'Architect'],
      blurb: 'You move work across scan, chat, and ship. Consistency is how DeplAI remembers you.',
    };
  }

  switch (scores[0].id) {
    case 'chat':
      return {
        lines: ['Conversation', 'Captain'],
        blurb: 'You steer the agent in chat more than you click around the console.',
      };
    case 'ai':
      return {
        lines: ['Agent', 'Orchestrator'],
        blurb: 'Tokens are your raw material. You let models do the heavy lifting, then you decide.',
      };
    case 'credits':
      return {
        lines: ['Ship', 'Captain'],
        blurb: 'You spend credits to move work forward — scans, plans, and deploys that actually land.',
      };
    default:
      return {
        lines: ['Repo', 'Collector'],
        blurb: 'You brought the work in. The next chapter is scanning it and shipping it.',
      };
  }
}

function pickHeadline(raw: WrappedRaw, category: string): string {
  const total =
    raw.projectsThisYear +
    raw.chatMessagesThisYear +
    raw.aiRequestsThisYear +
    raw.creditsConsumedThisYear;
  if (total <= 0) {
    return "Your DeplAI year is just getting started. Scan a repo, talk to the agent, then ship.";
  }
  if (category === 'AI requests') {
    return "You didn't just design infrastructure. You let agents draft it, then you shipped.";
  }
  if (category === 'Agent chat') {
    return 'You lived in the agent this year. Every thread was another pass at the same system.';
  }
  if (category === 'Projects') {
    return "You brought the repos in. DeplAI's job was to turn them into something that can run.";
  }
  return "You didn't just plan on DeplAI this year. You used it.";
}

function pickGrowth(raw: WrappedRaw): string {
  if (raw.projectsLastYear > 0) {
    const delta = Math.round(((raw.projectsThisYear - raw.projectsLastYear) / raw.projectsLastYear) * 100);
    const sign = delta > 0 ? '+' : '';
    return `${sign}${delta}% vs ${raw.year - 1}`;
  }
  if (raw.projectsThisYear + raw.chatMessagesThisYear + raw.aiRequestsThisYear > 0) {
    return `Year one on DeplAI`;
  }
  return 'Ready when you are';
}

function argMax(values: number[]): number {
  let bestIndex = 0;
  let bestValue = -1;
  values.forEach((value, index) => {
    if (value > bestValue) {
      bestIndex = index;
      bestValue = value;
    }
  });
  return bestIndex;
}

function formatHour(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  const suffix = normalized >= 12 ? 'PM' : 'AM';
  const twelve = normalized % 12 === 0 ? 12 : normalized % 12;
  return `${twelve} ${suffix}`;
}

function pickPeak(raw: WrappedRaw): { time: string; blurb: string } {
  const hourTotal = raw.hourCounts.reduce((sum, value) => sum + value, 0);
  const dayTotal = raw.weekdayCounts.reduce((sum, value) => sum + value, 0);
  if (hourTotal <= 0 && dayTotal <= 0) {
    return { time: 'Anytime', blurb: 'No peak yet — the floor is yours.' };
  }
  const hour = hourTotal > 0 ? argMax(raw.hourCounts) : 10;
  const weekday = dayTotal > 0 ? argMax(raw.weekdayCounts) : 2;
  const time = `${WEEKDAYS[weekday]}, ${formatHour(hour)}`;
  if (hour >= 22 || hour <= 5) return { time, blurb: 'You are a night owl.' };
  if (hour < 9) return { time, blurb: 'You are an early bird.' };
  return { time, blurb: 'You ship in working hours.' };
}

export function buildWrappedView(raw: WrappedRaw): WrappedView {
  const year = raw.year;
  const displayName = raw.displayName.trim() || 'DeplAI user';
  const shortName = firstNameFrom(displayName);
  const possessive = possessiveFrom(displayName);
  const stack = buildStack(raw);
  const category = pickCategory(raw);
  const persona = pickPersona(raw);
  const peak = pickPeak(raw);
  const heatmap = (raw.heatmapCounts.length ? raw.heatmapCounts : emptyHeatmap())
    .slice(0, 28)
    .map((count) => count > 0);
  while (heatmap.length < 28) heatmap.push(false);

  return {
    year,
    displayName,
    shortName,
    possessiveLabel: `${possessive} ${year}`,
    avatarUrl: raw.avatarUrl.trim(),
    headline: pickHeadline(raw, category),
    primaryCountLabel: 'Projects on DeplAI',
    primaryCount: formatCompactCount(raw.projectsThisYear),
    secondaryCountLabel: 'Agent tokens used',
    secondaryCount: formatCompactCount(raw.aiTokensThisYear),
    growthLabel: pickGrowth(raw),
    personaBadge: 'Builder Persona',
    personaLines: persona.lines,
    personaBlurb: persona.blurb,
    stackCaption: stack.caption,
    stack: stack.items,
    categoryValue: category,
    peakTime: peak.time,
    peakBlurb: peak.blurb,
    heatmap,
    shareTitle: `Share your ${year} Wrapped`,
    shareSubtitle: "Show the world what you've shipped with DeplAI",
    shareText: `My ${year} DeplAI Wrapped: ${formatCompactCount(raw.projectsThisYear)} projects, ${formatCompactCount(raw.aiTokensThisYear)} agent tokens. ${persona.lines.join(' ')}.`,
  };
}
