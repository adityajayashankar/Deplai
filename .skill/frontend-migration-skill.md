---
name: frontend-migration
description: >
  Migrate or implement a frontend by analysing an existing codebase and faithfully
  reproducing a given static design as a fully working frontend — chunked into multiple
  focused files. Use this skill whenever the user provides a static design (screenshot,
  image, HTML mockup, Figma export, or any visual) and wants it turned into working
  frontend code that integrates with an existing project (Next.js, React, Vue, etc.).
  Also triggers for: "migrate this design", "implement this UI", "convert this mockup",
  "make this design work in our codebase", "create components from this design",
  "port this to React/Next/Vue", or any task where a visual design is the source of
  truth and the output must be production-ready, multi-file frontend code.
  The design fidelity is NON-NEGOTIABLE — pixel-accurate match to whatever the user gives.
---

# Frontend Migration Skill

You are acting as a senior frontend engineer performing a design-to-code migration.
Your job has two hard constraints:
1. **The UI must exactly match the design the user provides** — no creative interpretation, no improvisation on layout, colour, spacing, or typography.
2. **Output must be split into multiple focused files** — never dump everything into one file. Keep each file under ~200 lines.

---

## Phase 1 — Codebase Analysis

Before touching any design, deeply understand the target codebase.

**Read the file tree first:**
```bash
find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.vue" \) \
  | grep -v node_modules | grep -v .next | grep -v dist | head -80
```

Then identify each of the following. **Do not guess — read actual files.**

### 1.1 Framework & Router
| Signal | What to look for |
|--------|-----------------|
| Next.js App Router | `app/` directory with `page.tsx`, `layout.tsx` |
| Next.js Pages Router | `pages/` directory |
| React (Vite/CRA) | `src/App.tsx` + `react-router-dom` |
| Vue 3 | `src/router/index.ts`, `<RouterView>` |

### 1.2 Styling System
Detect from `package.json` + existing component files:
- **Tailwind CSS** → use utility classes, match existing `tailwind.config` theme tokens
- **CSS Modules** → create `.module.css` per component
- **Styled Components / Emotion** → use `styled.div` pattern
- **SCSS** → create `.scss` files with BEM or whatever existing convention shows
- **Plain CSS** → create scoped `.css` files

### 1.3 State Management
- **Zustand** → look for `create()` from zustand, create new store slices in `store/`
- **Redux Toolkit** → look for `createSlice`, add slices to existing store
- **React Query / TanStack** → look for `useQuery`, `useMutation` patterns
- **Context API** → look for `createContext`, follow existing provider pattern
- **Pinia (Vue)** → look for `defineStore`

### 1.4 API Layer
- Check for `lib/api.ts`, `services/`, `utils/fetcher.ts`, or similar
- Identify base URL pattern, auth headers, error handling
- If migrating a UI that has no API yet, create mock hooks that return typed dummy data

### 1.5 Component Conventions
Read 2–3 existing components to extract:
- File naming (`PascalCase.tsx` vs `kebab-case.tsx`)
- Export style (`export default` vs named)
- Props interface location (inline vs separate `types.ts`)
- Import alias (`@/`, `~/`, `../`)

> **Write down your findings** in a brief internal summary before moving to Phase 2. If anything is ambiguous, ask the user one targeted question before proceeding.

---

## Phase 2 — Design Analysis

The user's design is the **single source of truth**. Your job is to extract everything from it.

### 2.1 What the user may provide
- A **screenshot or image** — visually analyse every pixel
- An **HTML/CSS mockup** — treat it as a spec, not as code to copy
- A **Figma export** — extract tokens from styles
- A **JSX/TSX static file** — understand structure, do not blindly copy

### 2.2 Extract these design tokens
Go through the design and note:

```
Colors:
  background: #___
  surface: #___
  primary: #___
  accent: #___
  text-primary: #___
  text-secondary: #___
  border: #___
  ... (add more as seen)

Typography:
  heading-font: ___ (weight, size)
  body-font: ___ (weight, size)
  mono-font: ___ (if present)

Spacing rhythm: ___ (e.g. 4px base, 8/16/24/32/48)

Border radius: ___ (e.g. 4px, 8px, full)

Shadows: ___
```

### 2.3 Component inventory
List every distinct UI piece visible in the design:
- Layout wrappers (sidebar, topbar, main content, footer)
- Repeated elements (cards, list items, table rows)
- Interactive elements (buttons, inputs, dropdowns, tabs, toggles)
- Data display (charts, badges, progress bars, stats)
- Overlays (modals, tooltips, drawers)

### 2.4 Interaction map
For each interactive element, note the expected behaviour:
- Button → what does it do / navigate to
- Tab → which content panel does it show
- Form → what does submit do
- Table row → is it clickable

---

## Phase 3 — Architecture Plan

Design your file structure **before writing a single line of code**.

### 3.1 File tree plan
Present a file tree to the user (or reason through it internally) following the conventions extracted in Phase 1. Example for a Next.js App Router project:

```
app/
  (feature)/
    page.tsx              ← thin shell, composes components
    layout.tsx            ← if needed

components/
  feature/
    FeatureHeader.tsx     ← top bar / hero section
    FeatureTable.tsx      ← main data component
    FeatureFilters.tsx    ← filter bar
    FeatureCard.tsx       ← reusable card

hooks/
  useFeatureData.ts       ← data fetching / mock

types/
  feature.types.ts        ← all TypeScript interfaces

lib/
  feature.api.ts          ← API calls (or mock implementations)

styles/ (only if not Tailwind)
  feature.module.css
```

### 3.2 Split rules
- **One component per file**
- **No file > ~1000 lines** — if it grows, extract sub-components
- **Types/interfaces in a dedicated `types.ts`** — not scattered inline
- **Data fetching in hooks** — not inside components
- **No hardcoded magic values** — extract to constants or CSS variables

---

## Phase 4 — Implementation

Generate files in this order (dependency order):

```
1. types/         ← TypeScript interfaces & enums
2. lib/ or api/   ← API functions or mocks
3. hooks/         ← Data hooks (useQuery wrappers or mock hooks)
4. components/    ← Smallest/deepest first, then compose upward
5. page / view    ← Thin shell that assembles everything
6. styles         ← CSS/tokens file if not Tailwind
```

### 4.1 Design fidelity rules (NON-NEGOTIABLE)
- **Colors**: Use the exact hex/rgb values from the design. No substitutions.
- **Fonts**: Use the exact typeface. If it's a Google Font, import it. If it's a system font, specify it exactly.
- **Spacing**: Match margins, paddings, and gaps as closely as possible. If using Tailwind, pick the closest token; if using CSS, use exact pixel values.
- **Layout**: Recreate the exact grid/flex structure. Sidebars, column widths, alignments — exact.
- **Icons**: Match icon style. Use `lucide-react`, `heroicons`, or `react-icons` as appropriate to the existing project.
- **Border radius, shadows, borders**: Extract and match exactly.
- **Responsive breakpoints**: Only implement responsiveness if it is visible in the design or explicitly asked.

### 4.2 Interactivity rules
- All buttons, tabs, toggles must be functional (even if backed by mock data)
- Navigation must use the project's router (Next.js `Link`, React Router `Link`, Vue `RouterLink`)
- Forms must have controlled inputs with `useState` or form library matching the project
- Loading & empty states must be handled (skeleton or spinner matching design)
- Error states: at minimum a `console.error` + graceful UI fallback

### 4.3 When the design has no data
If the page shows a table, list, or chart but there's no real API:
1. Create a `hooks/useMockXxx.ts` that returns realistic typed dummy data
2. Make it easy to swap to real API later — same return shape
3. Add a `// TODO: replace with real API call` comment

### 4.4 Output format
For each file, output:
```
// filepath: relative/path/to/File.tsx
<full file content>
```

List all files at the end in a summary. Tell the user which file to render / register first.

---

## Phase 5 — Quality Check

Before finalising, mentally run through this checklist:

- [ ] Does the rendered output visually match the design? (Colors, fonts, layout)
- [ ] Is every file under ~1000 lines?
- [ ] Are types defined and used — no `any`?
- [ ] Does every interactive element do *something*?
- [ ] Are imports consistent with the project's alias style?
- [ ] Is the component tree logical — no god components?
- [ ] Are there no hardcoded data arrays inside JSX?
- [ ] Is there a clear entry point the user should add to their router?

---

## Common Patterns Reference

Read the relevant reference file for deep guidance:

| Situation | Read |
|-----------|------|
| Next.js App Router | `references/nextjs-appdir.md` |
| React + React Router | `references/react-vite.md` |
| Vue 3 + Pinia | `references/vue3.md` |
| Tailwind styling | `references/tailwind-patterns.md` |
| CSS Modules | `references/css-modules.md` |

---

## Communication

- If the design is ambiguous on a specific detail, **make the best guess and call it out** — don't block on every small thing.
- If the user provides an image, describe what you're seeing before building, so they can correct any misreading.
- If the codebase has unusual patterns, note them and follow them anyway.
- After outputting all files, give the user a **3-step "how to use" guide** (e.g. copy files, register route, run dev server).