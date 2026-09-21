import type { CanonicalModel } from './types';

export function buildAnalystModels(models: CanonicalModel[], requested: string): CanonicalModel[] {
  if (!/(?:^|[/:])glm-5\.3$/i.test(requested)) throw new Error('Build analyst requires GLM-5.3');
  const matches = models.filter(model => model.providerModelId === requested);
  if (matches.length !== 1) throw new Error('Build analyst requires one verified catalog model');
  return matches;
}
