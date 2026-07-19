"use client";

import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  CloudCog,
  Menu,
  PanelLeftClose,
  Rocket,
  Search,
  Settings2,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Table = {
  headers: string[];
  rows: string[][];
};

type DocSection = {
  id: string;
  title: string;
  paragraphs?: string[];
  steps?: string[];
  bullets?: string[];
  table?: Table;
  note?: string;
};

type DocPage = {
  id: string;
  groupId: string;
  label: string;
  eyebrow: string;
  title: string;
  summary: string;
  sections: DocSection[];
};

type NavGroup = {
  id: string;
  label: string;
  icon: LucideIcon;
  pages: string[];
};

const DOC_PAGES: DocPage[] = [
  {
    id: "getting-started",
    groupId: "start",
    label: "Get started",
    eyebrow: "Start here",
    title: "Start building with DeplAI.",
    summary: "Use DeplAI to bring in a project, understand its security posture, make informed changes, and prepare a deployment from one workspace.",
    sections: [
      {
        id: "before-you-begin",
        title: "Before you begin",
        bullets: [
          "Sign in with the GitHub account you want to use for this session.",
          "Have a repository you can access, or a ZIP file containing the project you want to work with.",
          "For deployment work, make sure you have permission to use the selected cloud account and to create resources.",
        ],
      },
      {
        id: "choose-a-source",
        title: "Choose a project source",
        table: {
          headers: ["Source", "Best for"],
          rows: [
            ["GitHub repository", "Ongoing work where you want to review repository changes and pull requests."],
            ["Local ZIP file", "A project on your computer that is not yet connected to GitHub."],
          ],
        },
      },
      {
        id: "first-workflow",
        title: "Your first workflow",
        steps: [
          "Add or select a project from the workspace.",
          "Run a security scan to understand the project before making changes.",
          "Review the results, then move on to remediation, planning, or deployment when you are ready.",
        ],
      },
    ],
  },
  {
    id: "connect-github",
    groupId: "start",
    label: "Connect GitHub",
    eyebrow: "Start here",
    title: "Connect the right GitHub account.",
    summary: "DeplAI asks you to choose a GitHub account when you sign in so you can work with the correct repositories, especially when you use more than one account.",
    sections: [
      {
        id: "sign-in",
        title: "Sign in",
        steps: [
          "Select Sign in from the DeplAI landing page.",
          "Choose the GitHub account you want to continue with.",
          "Approve access when GitHub asks you to do so, then return to your workspace.",
        ],
      },
      {
        id: "repository-access",
        title: "Allow repository access",
        paragraphs: [
          "When you add a GitHub project, choose the organisation or personal account that owns the repository. You can grant access to selected repositories or all repositories you manage, depending on your organisation's policy.",
          "Only repositories that you have authorised will appear for selection in DeplAI.",
        ],
      },
      {
        id: "switch-account",
        title: "Use a different account",
        paragraphs: [
          "Log out of DeplAI, then sign in again. GitHub will present an account choice instead of automatically using the account from your previous DeplAI session.",
        ],
        note: "If the account you need is not listed, sign out of that account in GitHub first and then return to DeplAI.",
      },
    ],
  },
  {
    id: "choose-project",
    groupId: "start",
    label: "Choose a project",
    eyebrow: "Start here",
    title: "Add a project to your workspace.",
    summary: "A project keeps scans, changes, plans, and deployments organised around one source codebase.",
    sections: [
      {
        id: "add-project",
        title: "Add a project",
        steps: [
          "Open the project picker in your workspace.",
          "Choose a GitHub repository or upload a ZIP file.",
          "Give the project a clear name so it is easy to recognise later.",
          "Wait for the project to finish loading before starting a workflow.",
        ],
      },
      {
        id: "project-choice",
        title: "Choose the right project",
        bullets: [
          "Use a separate project for each application or infrastructure codebase.",
          "Start with a non-production project while you become familiar with the workflow.",
          "Select the project again whenever you return to the workspace; all actions apply to the currently selected project.",
        ],
      },
    ],
  },
  {
    id: "security-scan",
    groupId: "workflows",
    label: "Run a security scan",
    eyebrow: "Use DeplAI",
    title: "Understand security findings before you change or deploy.",
    summary: "A scan reviews your selected project and presents findings in one place, so you can decide what needs attention.",
    sections: [
      {
        id: "start-scan",
        title: "Start a scan",
        steps: [
          "Select the project you want to check.",
          "Open Security and choose the scan coverage that matches your goal.",
          "Start the scan and keep the workspace open while progress is displayed.",
          "Open the results when the scan is complete.",
        ],
      },
      {
        id: "scan-coverage",
        title: "Choose scan coverage",
        table: {
          headers: ["Option", "What it checks"],
          rows: [
            ["Code", "Potential security issues in the application code."],
            ["Dependencies", "Known risks in the project dependencies."],
            ["Full scan", "Both code and dependency checks. Use this when you are unsure."],
          ],
        },
      },
      {
        id: "read-results",
        title: "Read the results",
        paragraphs: [
          "Review the severity, location, and suggested next step for each finding. Prioritise issues that are exposed to users or affect sensitive data, then decide whether to remediate them in DeplAI or handle them in your normal development process.",
        ],
      },
    ],
  },
  {
    id: "remediate-findings",
    groupId: "workflows",
    label: "Fix findings",
    eyebrow: "Use DeplAI",
    title: "Review suggested fixes before applying them.",
    summary: "DeplAI helps turn selected security findings into proposed source changes. You remain in control of what is accepted and merged.",
    sections: [
      {
        id: "choose-findings",
        title: "Choose what to fix",
        steps: [
          "Open the completed scan results.",
          "Select the findings you want to address, starting with the most important ones.",
          "Start remediation and review the proposed changes when they are ready.",
        ],
      },
      {
        id: "review-changes",
        title: "Review every change",
        bullets: [
          "Read the explanation and diff for each proposed change.",
          "Check that the change matches your application's behaviour and team standards.",
          "Keep any change that needs further investigation out of production until it has been reviewed by the right people.",
        ],
      },
      {
        id: "github-handoff",
        title: "Finish in GitHub",
        paragraphs: [
          "For connected GitHub projects, you can hand reviewed changes to a pull request. Use your usual code-review process before merging it into a shared branch.",
        ],
      },
    ],
  },
  {
    id: "plan-and-deploy",
    groupId: "workflows",
    label: "Plan and deploy",
    eyebrow: "Use DeplAI",
    title: "Plan carefully before creating cloud resources.",
    summary: "DeplAI guides you from a project review to an architecture and deployment plan. The final deployment always requires your confirmation.",
    sections: [
      {
        id: "build-plan",
        title: "Build a deployment plan",
        steps: [
          "Select your project and open the deployment workflow.",
          "Answer the questions about your application's needs, such as traffic, data, and environment preferences.",
          "Review the proposed architecture and the cost estimate.",
          "Adjust the plan if needed, then continue only when it matches your expectations.",
        ],
      },
      {
        id: "confirm-deployment",
        title: "Confirm before deployment",
        paragraphs: [
          "DeplAI shows the planned infrastructure before it creates resources. Review the resources, region, estimated cost, and any warnings. Confirm the plan only when you understand the impact.",
        ],
        note: "Creating cloud resources can incur charges. Use an approved account, set a budget, and do not deploy a plan you have not reviewed.",
      },
      {
        id: "follow-progress",
        title: "Follow progress",
        paragraphs: [
          "The deployment view shows progress, results, and any errors. If something fails, read the message before trying again; repeated attempts can create unexpected cost or duplicate work.",
        ],
      },
    ],
  },
  {
    id: "manage-deployment",
    groupId: "workflows",
    label: "Manage a deployment",
    eyebrow: "Use DeplAI",
    title: "Check and manage a running deployment.",
    summary: "After deployment, use the workspace to inspect availability and take supported actions on the resources associated with your project.",
    sections: [
      {
        id: "check-status",
        title: "Check the current status",
        bullets: [
          "Open the deployment details for the selected project.",
          "Check the endpoint, current status, and recent messages.",
          "Verify that the application responds as expected before sharing it with users.",
        ],
      },
      {
        id: "runtime-actions",
        title: "Available actions",
        table: {
          headers: ["Action", "When to use it"],
          rows: [
            ["Start", "Bring a stopped deployment back online."],
            ["Stop", "Pause a deployment when it is safe to do so."],
            ["Restart", "Try to recover a running service after you have checked its status."],
            ["Destroy", "Remove a deployment you no longer need."],
          ],
        },
      },
      {
        id: "destroy-warning",
        title: "Destroy with care",
        paragraphs: [
          "Destroying a deployment is intended to remove the project resources managed by DeplAI. Save anything you need first and confirm the project is the correct one before continuing.",
        ],
        note: "This action can permanently remove cloud resources and data. It cannot be undone from DeplAI.",
      },
    ],
  },
  {
    id: "customize-workspace",
    groupId: "customize",
    label: "Customize a workspace",
    eyebrow: "Customize",
    title: "Request changes, review them, then confirm.",
    summary: "Use the customization workspace to make controlled changes to a project experience while keeping each request tied to the selected project.",
    sections: [
      {
        id: "make-request",
        title: "Make a change request",
        steps: [
          "Select the project you want to customise.",
          "Describe the text, branding, layout, or experience change you need.",
          "Review the proposed change summary before you confirm it.",
        ],
      },
      {
        id: "review-and-confirm",
        title: "Review and confirm",
        paragraphs: [
          "Confirmation is your checkpoint before changes are applied. Read the summary, make corrections if needed, and confirm only when the requested outcome is clear.",
        ],
      },
      {
        id: "preview",
        title: "Preview the result",
        paragraphs: [
          "When a preview is available, use it to check the result before sharing or publishing the changes. If the result does not match your request, return to the request and describe the correction.",
        ],
      },
    ],
  },
  {
    id: "help",
    groupId: "help",
    label: "Common questions",
    eyebrow: "Help",
    title: "Get unstuck in the workspace.",
    summary: "Use these checks first when a project, scan, change, or deployment does not behave as expected.",
    sections: [
      {
        id: "project-not-visible",
        title: "My project is not visible",
        bullets: [
          "Make sure you signed in with the GitHub account that can access the repository.",
          "Check that you selected the correct organisation or personal account when connecting GitHub.",
          "For local projects, confirm that the ZIP upload finished successfully.",
        ],
      },
      {
        id: "workflow-not-complete",
        title: "A workflow did not complete",
        bullets: [
          "Keep the project selected and read the latest status message in the workspace.",
          "Refresh the page and check whether the workflow has completed before starting another one.",
          "If the problem continues, capture the project name and the displayed message for your platform administrator or support contact.",
        ],
      },
      {
        id: "placeholder-support",
        title: "Need more help?",
        paragraphs: [
          "Placeholder: add your team's support channel, service hours, and escalation process here.",
        ],
      },
    ],
  },
];

const NAV_GROUPS: NavGroup[] = [
  { id: "start", label: "Get started", icon: Rocket, pages: ["getting-started", "connect-github", "choose-project"] },
  { id: "workflows", label: "Use DeplAI", icon: CloudCog, pages: ["security-scan", "remediate-findings", "plan-and-deploy", "manage-deployment"] },
  { id: "customize", label: "Customize", icon: Sparkles, pages: ["customize-workspace"] },
  { id: "help", label: "Help", icon: Settings2, pages: ["help"] },
];

function DetailTable({ table }: { table: Table }) {
  return (
    <div className="my-5 overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full min-w-[580px] border-collapse text-left text-sm">
        <thead className="bg-white/[0.035]">
          <tr>
            {table.headers.map((header) => <th key={header} className="border-b border-white/10 px-4 py-3 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">{header}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.07]">
          {table.rows.map((row, rowIndex) => (
            <tr key={`${row[0]}-${rowIndex}`} className="transition-colors hover:bg-white/[0.025]">
              {row.map((cell, cellIndex) => <td key={`${cell}-${cellIndex}`} className={`px-4 py-3.5 align-top leading-6 ${cellIndex === 0 ? "font-medium text-zinc-200" : "text-zinc-400"}`}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ section, number }: { section: DocSection; number: number }) {
  return (
    <section id={section.id} className="scroll-mt-10 border-t border-white/[0.08] py-10 first:border-t-0 first:pt-0">
      <div className="mb-4 flex items-center gap-3">
        <span className="font-mono text-xs text-white">{String(number).padStart(2, "0")}</span>
        <h2 className="text-2xl font-semibold tracking-[-0.025em] text-white">{section.title}</h2>
      </div>
      <div className="max-w-3xl space-y-4 text-[15px] leading-7 text-zinc-400">
        {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        {section.steps && (
          <ol className="space-y-3 pt-1">
            {section.steps.map((step, index) => (
              <li key={step} className="grid grid-cols-[auto_1fr] gap-3">
                <span className="mt-1 flex h-5 w-5 items-center justify-center rounded-full border border-white/25 bg-white/[0.08] font-mono text-[10px] text-white">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        )}
        {section.bullets && (
          <ul className="space-y-2.5 pt-1">
            {section.bullets.map((bullet) => (
              <li key={bullet} className="flex gap-3"><span className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-white" /><span>{bullet}</span></li>
            ))}
          </ul>
        )}
      </div>
      {section.table && <DetailTable table={section.table} />}
      {section.note && (
        <div className="mt-5 flex gap-3 rounded-xl border border-white/15 bg-white/[0.05] p-4 text-sm leading-6 text-zinc-300">
          <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-white" />
          <p>{section.note}</p>
        </div>
      )}
    </section>
  );
}

export default function DocumentationApp() {
  const router = useRouter();
  const [activePageId, setActivePageId] = useState("getting-started");
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLElement>(null);

  const activePage = DOC_PAGES.find((page) => page.id === activePageId) || DOC_PAGES[0];
  const pagesById = useMemo(() => new Map(DOC_PAGES.map((page) => [page.id, page])), []);
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [activePageId]);

  const toggleGroup = (groupId: string) => {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const selectPage = (page: DocPage) => {
    setActivePageId(page.id);
    setOpenGroups(new Set([page.groupId]));
  };

  const matchingGroups = NAV_GROUPS.map((group) => ({
    ...group,
    pages: group.pages.filter((pageId) => {
      const page = pagesById.get(pageId);
      if (!page) return false;
      if (!normalizedQuery) return true;
      const searchable = [page.label, page.title, page.summary, ...page.sections.flatMap((section) => [section.title, ...(section.paragraphs || []), ...(section.bullets || [])])].join(" ").toLowerCase();
      return searchable.includes(normalizedQuery);
    }),
  })).filter((group) => group.pages.length > 0);

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-black font-sans text-zinc-200">
      <aside className={`${sidebarOpen ? "flex" : "hidden"} w-[300px] shrink-0 flex-col border-r border-white/[0.07] bg-[#111111] lg:flex`}>
        <div className="flex h-[72px] items-center justify-between border-b border-white/[0.07] px-5">
          <button type="button" onClick={() => router.push("/dashboard")} className="flex items-center gap-3 text-left transition hover:opacity-80">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-white text-black"><BookOpen className="h-4 w-4" strokeWidth={2.5} /></span>
            <span><span className="block text-sm font-semibold tracking-tight text-white">DeplAI Docs</span><span className="block font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">User guide</span></span>
          </button>
          <button type="button" onClick={() => setSidebarOpen(false)} className="rounded-md p-2 text-zinc-500 transition hover:bg-white/[0.06] hover:text-white lg:hidden" aria-label="Hide documentation navigation"><PanelLeftClose className="h-4 w-4" /></button>
        </div>

        <div className="border-b border-white/[0.07] p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search documentation" className="h-11 w-full rounded-lg border border-white/[0.07] bg-white/[0.045] pl-10 pr-16 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-white/40 focus:bg-white/[0.06]" />
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-white/10 bg-black px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">Ctrl K</kbd>
          </div>
        </div>

        <nav className="docs-scrollbar flex-1 overflow-y-auto px-3 py-4" aria-label="Documentation navigation">
          {matchingGroups.map((group) => {
            const Icon = group.icon;
            const isOpen = openGroups.has(group.id) || Boolean(normalizedQuery);
            return (
              <div key={group.id} className="mb-2">
                <button type="button" onClick={() => toggleGroup(group.id)} aria-expanded={isOpen} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${isOpen ? "bg-white/[0.1] text-white" : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"}`}>
                  <Icon className="h-4 w-4" />
                  <span className="flex-1 text-left">{group.label}</span>
                  <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? "rotate-0" : "-rotate-90"}`} />
                </button>
                {isOpen && (
                  <div className="ml-5 mt-1 border-l border-white/[0.08] py-1 pl-3">
                    {group.pages.map((pageId) => {
                      const page = pagesById.get(pageId);
                      if (!page) return null;
                      const isActive = page.id === activePage.id;
                      return (
                        <button key={page.id} type="button" onClick={() => selectPage(page)} className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] transition ${isActive ? "bg-white/[0.12] text-white" : "text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200"}`}>
                          {isActive && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                          <span className={isActive ? "" : "pl-3.5"}>{page.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {matchingGroups.length === 0 && <p className="px-3 py-8 text-center text-sm text-zinc-500">No documentation matched “{query}”.</p>}
        </nav>

        <div className="border-t border-white/[0.07] p-4">
          <button type="button" onClick={() => router.push("/dashboard")} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-500 transition hover:bg-white/[0.05] hover:text-white"><ArrowLeft className="h-4 w-4" /> Back to workspace</button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-white/[0.07] bg-[#111111]/90 px-5 backdrop-blur lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            {!sidebarOpen && <button type="button" onClick={() => setSidebarOpen(true)} className="rounded-md p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-white" aria-label="Show documentation navigation"><Menu className="h-4 w-4" /></button>}
            <div className="min-w-0"><p className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">{activePage.eyebrow}</p><p className="truncate text-sm font-medium text-zinc-200">{activePage.label}</p></div>
          </div>
          <button type="button" onClick={() => router.push("/dashboard")} className="hidden items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-zinc-400 transition hover:border-white/20 hover:bg-white/[0.05] hover:text-white sm:inline-flex"><ArrowLeft className="h-3.5 w-3.5" /> Workspace</button>
        </header>

        <main ref={contentRef} className="docs-scrollbar flex-1 overflow-y-auto">
          <div className="mx-auto grid max-w-[1440px] grid-cols-1 gap-12 px-6 py-12 lg:px-12 xl:grid-cols-[minmax(0,1fr)_220px]">
            <article className="min-w-0 max-w-4xl">
              <div className="mb-12 border-b border-white/[0.08] pb-10">
                <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-200"><Sparkles className="h-3 w-3" /> DeplAI user guide</div>
                <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-[-0.045em] text-white md:text-5xl">{activePage.title}</h1>
                <p className="mt-6 max-w-3xl text-lg leading-8 text-zinc-400">{activePage.summary}</p>
              </div>

              {activePage.sections.map((section, index) => <Section key={section.id} section={section} number={index + 1} />)}

              <div className="mt-2 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/[0.08] bg-white/[0.025] p-5">
                <div><p className="text-sm font-medium text-white">Ready to continue?</p><p className="mt-1 text-sm text-zinc-500">Return to the workspace to use the selected project.</p></div>
                <button type="button" onClick={() => router.push("/dashboard")} className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-black transition hover:bg-zinc-200"><Rocket className="h-4 w-4" /> Open workspace</button>
              </div>
            </article>

            <aside className="hidden border-l border-white/[0.08] pl-6 xl:block">
              <div className="sticky top-0 py-1">
                <p className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">On this page</p>
                <div className="space-y-1 border-l border-white/[0.08]">
                  {activePage.sections.map((section) => <a key={section.id} href={`#${section.id}`} className="block border-l border-transparent py-1.5 pl-3 text-sm text-zinc-500 transition hover:border-white hover:text-white">{section.title}</a>)}
                </div>
                <div className="mt-8 border-t border-white/[0.08] pt-5"><p className="text-xs leading-5 text-zinc-600">This guide covers the actions available in the workspace. Contact your platform administrator for account or policy questions.</p></div>
              </div>
            </aside>
          </div>
        </main>
      </div>

      <style jsx global>{`
        .docs-scrollbar::-webkit-scrollbar { width: 8px; }
        .docs-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .docs-scrollbar::-webkit-scrollbar-thumb { background: rgba(161, 161, 170, .24); border-radius: 999px; }
        .docs-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(161, 161, 170, .42); }
      `}</style>
    </div>
  );
}
