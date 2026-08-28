import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildWrappedView,
  emptyWrappedRaw,
  firstNameFrom,
  formatCompactCount,
  possessiveFrom,
  stackInitial,
} from './wrapped';

describe('usage wrapped mapping', () => {
  it('formats compact counts the way the retro cards expect', () => {
    assert.equal(formatCompactCount(0), '0');
    assert.equal(formatCompactCount(1492), '1,492');
    assert.equal(formatCompactCount(84500), '84.5k');
    assert.equal(formatCompactCount(1000000), '1M');
  });

  it('builds possessives for the user chip', () => {
    assert.equal(firstNameFrom('Aditya J'), 'Aditya');
    assert.equal(possessiveFrom('Aditya J'), "Aditya's");
    assert.equal(possessiveFrom('Jess'), "Jess'");
    assert.equal(stackInitial('TypeScript'), 'TS');
    assert.equal(stackInitial('React'), 'R');
  });

  it('uses a new-operator persona when the account is empty', () => {
    const view = buildWrappedView(emptyWrappedRaw({ year: 2026, displayName: 'Aditya J' }));
    assert.equal(view.possessiveLabel, "Aditya's 2026");
    assert.equal(view.primaryCount, '0');
    assert.equal(view.secondaryCount, '0');
    assert.deepEqual(view.personaLines, ['New', 'Operator']);
    assert.equal(view.categoryValue, 'Getting started');
    assert.equal(view.peakTime, 'Anytime');
    assert.equal(view.growthLabel, 'Ready when you are');
    assert.equal(view.stack.length, 3);
    assert.equal(view.heatmap.length, 28);
    assert.match(view.headline, /just getting started/i);
    assert.match(view.shareText, /DeplAI Wrapped/);
  });

  it('maps repo-heavy activity onto collector copy and language bars', () => {
    const view = buildWrappedView(emptyWrappedRaw({
      year: 2026,
      displayName: 'Aditya J',
      projectsThisYear: 12,
      projectsLastYear: 4,
      languages: [
        { name: 'TypeScript', bytes: 8000 },
        { name: 'Python', bytes: 1500 },
        { name: 'Go', bytes: 500 },
      ],
      hourCounts: Array.from({ length: 24 }, (_, hour) => (hour === 22 ? 9 : 0)),
      weekdayCounts: [0, 0, 8, 0, 0, 0, 0],
      heatmapCounts: Array.from({ length: 28 }, (_, index) => (index % 3 === 0 ? 1 : 0)),
    }));
    assert.deepEqual(view.personaLines, ['Repo', 'Collector']);
    assert.equal(view.categoryValue, 'Projects');
    assert.equal(view.primaryCount, '12');
    assert.equal(view.growthLabel, '+200% vs 2025');
    assert.equal(view.stack[0].label, 'TypeScript');
    assert.equal(view.stack[0].initial, 'TS');
    assert.equal(view.stackCaption, 'Based on repos');
    assert.equal(view.peakTime, 'Tuesday, 10 PM');
    assert.equal(view.peakBlurb, 'You are a night owl.');
    assert.equal(view.heatmap.filter(Boolean).length, 10);
  });

  it('maps mixed platform work onto the system-architect persona', () => {
    const view = buildWrappedView(emptyWrappedRaw({
      year: 2026,
      displayName: 'Jess',
      projectsThisYear: 6,
      chatMessagesThisYear: 40,
      aiRequestsThisYear: 18,
      aiTokensThisYear: 84500,
      creditsConsumedThisYear: 20,
    }));
    assert.deepEqual(view.personaLines, ['System', 'Architect']);
    assert.equal(view.possessiveLabel, "Jess' 2026");
    assert.equal(view.secondaryCount, '84.5k');
    assert.equal(view.personaBadge, 'Builder Persona');
    assert.equal(view.shareTitle, 'Share your 2026 Wrapped');
  });
});
