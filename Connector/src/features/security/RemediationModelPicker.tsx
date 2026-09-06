'use client';

/** The free router picks an available upstream; remediation has no model choice. */
export function RemediationModelPicker() {
  return (
    <div className="border-[3px] border-black bg-[#F6F4EE] px-4 py-3 text-sm text-neutral-800">
      <span className="font-semibold text-black">OpenRouter Free Router</span>
      <p className="mt-1 text-xs text-neutral-600">
        DeplAI sends remediation directly to <code>openrouter/free</code>. OpenRouter selects an available free upstream and paid or BYOK inference is never used for this run.
      </p>
    </div>
  );
}
