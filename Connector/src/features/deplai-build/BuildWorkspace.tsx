import { Bot, FolderGit2, Plus } from 'lucide-react';
import Link from 'next/link';
import { appPaper } from '@/features/workspace/theme';

export default function BuildWorkspace() {
  return (
    <main className="h-full overflow-y-auto p-5 text-black md:p-10">
      <div className="mx-auto max-w-5xl">
        <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">DeplAI Agent / Build</p>
        <h1 className="mt-4 font-display text-4xl font-semibold">Your next application starts here.</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-neutral-600">
          Create a full-stack web application or continue building an existing repository.
          DeplAI Build is being introduced in phases. Builds and live previews are not available yet.
        </p>
        <section aria-label="Build entry modes" className="mt-8 grid gap-6 md:grid-cols-2">
          <article className={`${appPaper} p-6`}>
            <Plus aria-hidden="true" className="h-6 w-6" />
            <h2 className="mt-4 text-xl font-semibold">Create New</h2>
            <p className="mt-3 text-sm leading-6 text-neutral-600">Describe your product, its users, and what they need to accomplish.</p>
            <p id="new-build-unavailable" className="mt-5 text-xs text-neutral-500">Available after secure build sessions and the build workflow are implemented.</p>
            <button type="button" disabled aria-describedby="new-build-unavailable" className="mt-3 border-2 border-black px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">Create project</button>
          </article>
          <article className={`${appPaper} p-6`}>
            <FolderGit2 aria-hidden="true" className="h-6 w-6" />
            <h2 className="mt-4 text-xl font-semibold">Import Existing Repository</h2>
            <p className="mt-3 text-sm leading-6 text-neutral-600">Understand and extend your application while preserving its existing architecture.</p>
            <p id="import-build-unavailable" className="mt-5 text-xs text-neutral-500">Available after secure repository ingestion and runtime validation are implemented.</p>
            <button type="button" disabled aria-describedby="import-build-unavailable" className="mt-3 border-2 border-black px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">Import repository</button>
          </article>
        </section>
        <section className={`${appPaper} mt-6 p-6`} aria-labelledby="agents-heading">
          <Link href="/dashboard/agents/secrets" className="mb-4 inline-block text-sm underline">Build secrets</Link>
          <div className="flex items-center gap-3"><Bot aria-hidden="true" className="h-5 w-5" /><h2 id="agents-heading" className="text-xl font-semibold">Agents</h2></div>
          <p className="mt-3 text-sm leading-6 text-neutral-600">No agents are running. Agent activity, application preview, and verification results will appear here as the build workflow becomes available.</p>
          <p className="mt-3 text-sm leading-6 text-neutral-600">A deployment handoff becomes available only after the exact application revision passes readiness verification and user review.</p>
        </section>
      </div>
    </main>
  );
}
