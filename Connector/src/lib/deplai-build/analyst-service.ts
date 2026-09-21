import { analyzeRepository, type AnalystInput, type AnalystGateway } from './analyst';
import { assertScope, type BuildScope } from './contracts';
import { repositoryMap } from './ingestion';
import type { GatewayContext, NormalizedChatRequest, NormalizedChatResponse } from '../ai-platform/types';

/** Internal adapter. Authorization must check current session/project membership,
 * imported revision/digest and trusted per-run paid consent before dispatch.
 * No public endpoint or client-supplied approval flag is accepted here. */
export function createAnalystService(deps: {
  authorizeRun: (actor: string, scope: BuildScope, evidence: { revision: string; digest: string; model: string }) => Promise<void>;
  executeChat: (context: GatewayContext, request: NormalizedChatRequest) => Promise<Pick<NormalizedChatResponse, 'model' | 'output' | 'toolCalls' | 'finishReason'> & { fallback: Pick<NormalizedChatResponse['fallback'], 'count'> }>;
}) {
  return async (actor: string, requestedScope: BuildScope, requestedInput: AnalystInput) => {
    const scope = { ...requestedScope }; assertScope(scope);
    if (actor !== scope.owner_user_id) throw new Error('Repository analysis access denied');
    repositoryMap(requestedInput.files);
    const input: AnalystInput = { ...requestedInput, selected_paths: [...requestedInput.selected_paths], files: requestedInput.files.map(file => ({ ...file, bytes: Buffer.from(file.bytes) })) };
    const evidence = { revision: input.source_revision, digest: input.expected_content_sha256, model: input.model };
    const authorize = () => deps.authorizeRun(actor, { ...scope }, { ...evidence });
    await authorize();
    const gateway: AnalystGateway = async request => {
      await authorize();
      const result = await deps.executeChat({ userId: actor, organizationId: scope.organization_id, projectId: scope.project_id, source: 'internal' }, {
        model: request.model, messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.context }],
        accessMode: 'platform', routingPolicy: 'default', stream: false, temperature: 0, maxTokens: request.maxOutputTokens,
        responseFormat: { type: 'json_schema', json_schema: { name: 'repository_analysis', strict: true, schema: request.schema } },
        metadata: { product: 'deplai-build', stage: 'repository_analysis', build_session_id: scope.session_id },
      });
      if (result.toolCalls.length || result.fallback.count || result.finishReason !== 'stop') throw new Error('Incomplete or substituted analyst response');
      return { model: result.model, output: result.output };
    };
    const result = await analyzeRepository(input, gateway);
    await authorize();
    return result;
  };
}
