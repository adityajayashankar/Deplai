export interface RemediationLogMessage { type: string; content: string; timestamp: string }
export function describeRemediationEvent(message: RemediationLogMessage) {
  const raw = String(message.content || '');
  const text = raw.replace(/\*\*/g, '');
  let title = text;
  let detailOnly = ['model_result', 'model_attempt', 'changed_files', 'llm_dispatch'].includes(message.type);
  let tone: 'info' | 'warning' | 'error' | 'success' = ['warning', 'error', 'success'].includes(message.type)
    ? message.type as 'warning' | 'error' | 'success' : 'info';
  const packet = text.match(/(?:Packet|Run) (\d+)\/(\d+):/);
  if (packet) title = `Working on packet ${packet[1]} of ${packet[2]}`;
  else if (/Supervisor batch (\d+): (\d+) patch/.test(text)) {
    const match = text.match(/Supervisor batch (\d+): (\d+) patch/)!;
    title = `Packet ${match[1]}: ${match[2]} patch(es) ready for review.`; tone = 'success';
  }
  else if (/Supervisor batch (\d+): no safe patches/.test(text)) {
    title = `Packet ${text.match(/Supervisor batch (\d+)/)![1]}: no patch passed validation. Findings remain unresolved.`; tone = 'warning';
  }
  else if (/Round \d+ complete:/.test(text)) {
    title = 'Patch generation finished. Open Review to inspect the changes and choose the next step. These are patch candidates, not verified fixes.';
    tone = 'info';
  }
  else if (text.includes('Local reviewer: ACCEPT')) { title = 'Patch passed local checks. Security verification is still pending.'; tone = 'success'; }
  else if (text.includes('Local reviewer: REJECT')) {
    title = 'Patch needs correction: ' + (text.split('Deterministic local review failed: ')[1] || 'local validation did not pass.'); tone = 'warning';
  }
  else if (text.includes('revising the rejected patch')) title = 'Retrying the patch using the validation feedback.';
  else if (text.includes('score below 80')) title = 'Patch did not meet local validation requirements.';
  else if (/workflow_(planner|implementor): model request/.test(text)) {
    title = text.replace('workflow_planner:', 'Planning:').replace('workflow_implementor:', 'Writing patch:').replace('/12', '');
  }
  else if (text.includes('source exploration action')) title = 'Inspecting additional source code before generating the patch.';
  else if (text.includes('Reconnected to the active workflow')) title = 'Live connection restored. Attached to the existing run.';
  else if (text.includes('Live log connection closed')) { title = 'Live connection interrupted. Checking the saved run status.'; tone = 'warning'; }
  else if (text.includes('OpenWiki') || text.startsWith('Multi-agent remediation:') || text.startsWith('Master ') || text.startsWith('Patch review finalized')) detailOnly = true;
  else if (/Planner persisted (\d+) target/.test(text)) title = 'Plan ready. Generating changes for the selected files.';
  else if (text.startsWith('Local reviewer is validating')) title = 'Checking patch applicability, file scope, syntax and safety.';
  else if (text.startsWith('Synthesizer')) detailOnly = true;
  return { title, raw, tone, detailOnly };
}
export function remediationLogSummary(messages: RemediationLogMessage[]) {
  let packet: number | null = null, total: number | null = null;
  const results = new Map<number, { patches: number; rejected: boolean }>();
  for (const message of messages) {
    const progress = message.content.match(/(?:Packet|Run) (\d+)\/(\d+):/);
    if (progress) { packet = Number(progress[1]); total = Number(progress[2]); }
    const ready = message.content.match(/Supervisor batch (\d+): (\d+) patch/);
    const rejected = message.content.match(/Supervisor batch (\d+): no safe patches/);
    if (ready) results.set(Number(ready[1]), { patches: Number(ready[2]), rejected: false });
    if (rejected) results.set(Number(rejected[1]), { patches: 0, rejected: true });
  }
  return { packet, total, reviewed: results.size, patches: [...results.values()].reduce((n, v) => n + v.patches, 0),
    rejectedPackets: [...results.values()].filter(v => v.rejected).length };
}
