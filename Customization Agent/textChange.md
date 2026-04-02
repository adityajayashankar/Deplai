## Plan: Tenant Text Migration Expansion

Expand tenant text customization from the currently wired scopes/components (landing, topbar, footer, auth/onBoard, and already migrated pages) to all remaining frontend pages and shared user-facing components, while preserving the working baseline and aligning backend extraction/planning/apply reliability for non-landing intents. Keep getTenantText/getTenantAsset/isTenantSectionVisible as the standard read path and keep manifest extensions in nl_key_value format mapped to companyData.text.<scope>.<key> and companyData.visibility.<scope>.<key>.

**Steps**
1. Phase 1: Confirm and lock current baseline behavior in already working areas (depends on none).
2. Phase 1: Build a complete inventory of remaining hardcoded user-facing strings across all frontend routes/components and define scope/key dictionaries per page family (parallel with step 1).
3. Phase 2 (High impact): Migrate remaining high-impact routes to tenant text accessors using the existing pattern from landing/topbar/footer/onBoard and already migrated pages (depends on 2).
4. Phase 2: Add visibility toggles only where full sections are conditionally meaningful (parallel with step 3 per route).
5. Phase 2: Extend backend prompt/schema guidance for all new scopes/keys so extraction quality is not landing-biased (depends on 2).
6. Phase 2: Add backend guardrails for unsupported style-only targets and better fallback/unresolved-key logging (depends on 5).
7. Phase 3 (Medium impact): Migrate remaining detail/community/support routes and shared component copy with the same scope/key conventions; enforce key-collision governance (depends on 3, 5).
8. Phase 4 (Low impact): Migrate legal/utility/rarely-customized pages and finalize long-tail scope coverage (depends on 7).
9. Final regression sweep: ensure no pages in the covered groups use unplanned hardcoded copy and all keys resolve with safe fallbacks (depends on 8).

**Baseline To Preserve (Do Not Break)**
1. Already working scope/read-path behavior:
- landing, topbar, footer, auth/onBoard access through getTenantText/getTenantAsset/isTenantSectionVisible.
2. Already migrated pages should remain behaviorally unchanged except for intended key additions:
- allSessions/index.jsx, contact.jsx, home/index.jsx, mySchedule/index.jsx, myCommunities/index.jsx, search/index.jsx.
3. Interpreter mode remains LLM-first; do not reintroduce deterministic pre-parse short-circuit in interpret().

**Frontend Coverage Expansion (Remaining Routes)**
1. High-impact routes (Phase 2):
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/browseClasses/index.jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/cart.jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/classDetails/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/communityDetails/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/settings/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/allSessions/liveClasses.jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/allSessions/videos.jsx

2. Medium-impact routes (Phase 3):
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/comHome/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/comThreads/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/comThreads/asks/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/comThreads/polls/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/comThreads/greetings/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/communitySub/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/commerce/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/catchup/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/catSessions/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/playVideo/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/trainorBio/[id].jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/studentRegistration/index.jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/user/index.js
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/session/index.js
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/session/create/index.js
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/session/create/[id].js
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/room/[id].js

3. Low-impact/utility routes (Phase 4):
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/aboutus/index.jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/privacyPolicy/index.jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/termsOfService/index.jsx
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/termsAndConditions/index.jsx

**Relevant files**
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/utils/tenantConfig.js — canonical accessor functions getTenantText, isTenantSectionVisible, getTenantAsset
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/utils/data.js — source of text scopes, keys, visibility defaults
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/landing/index.jsx — primary migration template for scoped copy and visibility toggles
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/topbar/Topbar.jsx — template for nav copy + asset usage
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/footer/index.jsx — template for legal/footer scoped keys and visibility
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/pages/onBoard/index.jsx — template for form/auth copy keys
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/communityList/index.jsx — shared community list copy and empty states
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/courseCard/index.jsx — shared action/status labels
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/guidelines/index.jsx — shared guideline text surfaces
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/common/Paginator.js — pagination labels and controls
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/UI/ErrorFiller.js — reusable empty/error copy wrapper
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/notification/index.jsx — notification list copy
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/sidebar/index.jsx — community navigation labels
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/profile/index.js — profile action labels
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main/frontend/components/commCart/index.jsx — commerce/cart shared labels
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/tenant_builder_app/backend/prompts/manifest_extraction_prompt.txt — extraction guidance and known scope/key hints
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/tenant_builder_app/backend/llm_interpreter.py — ingestion/normalization path, prompt build, LLM-first interpretation
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/tenant_builder_app/backend/services/deterministic_customizer.py — nl_key_value to data.js patching via _iter_text_extensions, _text_key_candidates, _patch_data_file
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/tenant_builder_app/backend/agents/planner_agent.py — target discovery/planning behavior affecting non-landing extraction reliability
- /Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/tenant_builder_app/backend/agents/modifier_agent.py — content mutation/validation flow for non-deterministic edits

**Scope Catalog Strategy (Expanded)**
1. Keep existing scopes unchanged (landing/topbar/footer/auth/all_sessions/contact/home/my_schedule/my_communities/search).
2. Add new page-family scopes as migration lands (example naming):
- browse_classes
- cart_checkout
- course_details
- community_details
- community_settings
- community_home
- community_threads
- session_management
- media_player
- legal
- common
3. Enforce per-scope key registries to prevent collisions and ambiguous generic keys.

**Verification**
1. Static scan: confirm migrated files import getTenantText and no longer contain targeted hardcoded literals.
2. Manifest test: send nl_key_value for at least one key per new scope and verify deterministic_customizer patches companyData.text and visibility correctly.
3. Runtime test: load tenant frontend with NEXT_PUBLIC_SHOW_COPY_KEYS=false and validate rendered values match manifest updates.
4. Fallback test: remove one key intentionally and verify fallback string renders without breaking UI.
5. Logging test: verify backend logs clearly indicate when keys are applied, skipped, or unresolved.
6. Coverage audit: for each phase, compare migrated-route list vs remaining-route list and block phase exit until all targeted files are addressed.
7. Baseline safety test: re-verify existing working pages/scopes after each phase to prevent regressions.

**Decisions**
- Rollout mode: phased rollout (high-impact pages first).
- In scope: text and section visibility customization using scope.key schema.
- Out of scope in this pass: full style/token editing on arbitrary JSX nodes unless explicitly mapped to theme or structured keys.
- Keep LLM-first ingestion path; do not reintroduce deterministic pre-parse short-circuit in interpreter.
- Do not refactor working scope keys unless a compatibility alias is provided.

**Further Considerations**
1. Priority candidates for next migration batch: browseClasses, cart, classDetails/[id], communityDetails/[id], settings/[id], allSessions/liveClasses, allSessions/videos.
2. Key governance: define per-scope key registry to prevent duplicate/ambiguous keys across teams.
3. Add optional diagnostics mode to surface fallback-hit counts so missing keys are visible during QA.
4. Treat API-returned/user-generated content as out-of-scope for direct tenant text substitution; only static UI labels/headings/messages are tenantized.
