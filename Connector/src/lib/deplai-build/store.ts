import 'server-only';
import { withTransaction } from '../db';
import { requireProjectPermission } from '../organizations/store';
import { createBuildRepository } from './repository';

export const buildSessions = createBuildRepository({
  transaction: withTransaction,
  authorize: (userId, projectId, action) => requireProjectPermission({ userId, projectId, action }),
});
