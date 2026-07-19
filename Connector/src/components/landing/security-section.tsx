import { SecurityWorkflowExperience } from './SecurityWorkflowExperience';

export function SecuritySection() {
  return (
    <section id="security" className="relative overflow-hidden py-24 lg:py-32">
      <div className="mx-auto max-w-[1400px] px-6 lg:px-12">
        <div className="grid items-end gap-8 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <span className="inline-flex items-center gap-3 font-mono text-sm text-muted-foreground">
              <span className="h-px w-12 bg-foreground/30" />
              Security workflow
            </span>
            <h2 className="mt-7 font-display text-5xl font-semibold leading-[0.92] tracking-[-0.05em] md:text-6xl lg:text-8xl">
              See risk. <span className="text-muted-foreground">Ship the fix.</span>
            </h2>
          </div>
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-violet-200 lg:col-span-4 lg:pb-3">
            Scan → review → remediate → validate
          </p>
        </div>

        <div className="mt-14">
          <SecurityWorkflowExperience />
        </div>
      </div>
    </section>
  );
}
