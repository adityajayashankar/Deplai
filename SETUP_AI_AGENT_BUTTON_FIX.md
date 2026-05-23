# Setup AI Agent Button Missing - Debugging Guide

## Issue Description

The "Setup AI Agent" button is not appearing on the Vulnerability Results page even though vulnerabilities have been detected (2 Critical findings visible in the UI).

## Root Cause Analysis

The button is conditionally rendered based on the `canLaunchRemediation` variable, which requires ALL of the following conditions to be true:

```typescript
const canLaunchRemediation = 
  hasVulnerabilities &&           // Must have vulnerabilities detected
  scanState !== 'running' &&      // Scan must be complete
  remediationState === 'idle' &&  // Remediation hasn't started yet
  !isAnyRemediating;              // No other project is being remediated
```

## Debug Fix Applied

Added console logging to help identify which condition is failing:

**Location:** `Connector/src/app/dashboard/security-analysis/[projectId]/page.tsx` (around line 1274)

```typescript
// Debug log to help identify why button is not showing
useEffect(() => {
  console.log('[DEBUG] canLaunchRemediation conditions:', {
    hasVulnerabilities,
    scanState,
    remediationState,
    isAnyRemediating,
    canLaunchRemediation,
    results: results ? { 
      supply_chain: results.supply_chain?.length, 
      code_security: results.code_security?.length 
    } : null,
    vulnStatus,
  });
}, [hasVulnerabilities, scanState, remediationState, isAnyRemediating, canLaunchRemediation, results, vulnStatus]);
```

## How to Debug

1. **Open Browser DevTools** (F12 or Right-click → Inspect)
2. **Go to Console tab**
3. **Refresh the Vulnerability Results page**
4. **Look for the debug log** that starts with `[DEBUG] canLaunchRemediation conditions:`

The log will show you which condition is `false`:

### Expected Values (Button Should Show)
```javascript
{
  hasVulnerabilities: true,      // ✓ You have 2 critical findings
  scanState: "completed",         // ✓ Scan should be done
  remediationState: "idle",       // ✓ Not started yet
  isAnyRemediating: false,        // ✓ No other projects remediating
  canLaunchRemediation: true,     // ✓ Button should appear
  results: { 
    supply_chain: 2,              // Your 2 findings
    code_security: 0 
  },
  vulnStatus: "found"
}
```

### Common Issues

#### Issue 1: `hasVulnerabilities` is `false`
**Cause:** Results not loaded or parsed incorrectly
**Fix:** 
- Click the "Refresh" button on the page
- Check if `results` object is null or empty
- Verify scan actually completed successfully

#### Issue 2: `scanState` is `"running"`
**Cause:** Scan is still in progress or stuck
**Fix:**
- Wait for scan to complete (check progress indicator)
- If stuck, refresh the page
- Check backend logs for scan errors

#### Issue 3: `remediationState` is not `"idle"`
**Cause:** Remediation was already started or is in a different state
**Fix:**
- Check if remediation is already running (`remediationState === "running"`)
- Check if remediation already completed (`remediationState === "completed"`)
- May need to reset state or start fresh

#### Issue 4: `isAnyRemediating` is `true`
**Cause:** Another project is currently being remediated
**Fix:**
- Wait for other remediation to complete
- Check other open tabs/projects
- Backend may have a stuck remediation process

## Quick Fix Options

### Option 1: Force Show Button (Temporary)
If you need to proceed immediately for testing, you can temporarily force the button to show:

```typescript
// Change line 1674 from:
{canLaunchRemediation ? (

// To:
{(canLaunchRemediation || true) ? (
```

**⚠️ Warning:** This bypasses safety checks. Only use for debugging.

### Option 2: Reset Remediation State
If remediation state is stuck, you can reset it:

1. Open Browser DevTools Console
2. Run:
```javascript
localStorage.removeItem('deplai.remediation.state');
location.reload();
```

### Option 3: Check Backend Status
The issue might be on the backend. Check:

1. **Scan Status API:**
```bash
curl http://localhost:3000/api/scan/status/<PROJECT_ID> \
  --cookie "session=<YOUR_SESSION>"
```

2. **Scan Results API:**
```bash
curl http://localhost:3000/api/scan/results/<PROJECT_ID> \
  --cookie "session=<YOUR_SESSION>"
```

## Alternative Navigation

If the button still doesn't appear, you can manually navigate to the next stage:

1. **Open Browser DevTools Console**
2. **Run this command:**
```javascript
// Replace <PROJECT_ID> with your actual project ID
window.location.href = '/dashboard/security-analysis/<PROJECT_ID>?stage=remediate_setup';
```

Or click on the sidebar navigation:
- Look for "AI Remediation" in the left sidebar
- Click it to manually advance to that stage

## Permanent Fix

Once you identify which condition is failing from the debug log, we can implement a proper fix. Common fixes include:

1. **Results not loading:** Fix the API call or data parsing
2. **State stuck:** Add state reset logic or timeout handling
3. **Race condition:** Add proper loading states and guards
4. **Backend issue:** Fix the scan completion detection

## Next Steps

1. ✅ Debug log added to the code
2. ⏳ Rebuild the Connector frontend
3. ⏳ Refresh the page and check console
4. ⏳ Share the debug log output
5. ⏳ Implement permanent fix based on findings

## Testing After Fix

Once fixed, verify:
- [ ] Button appears when scan completes with vulnerabilities
- [ ] Button does NOT appear when scan is running
- [ ] Button does NOT appear when no vulnerabilities found
- [ ] Button does NOT appear when remediation already started
- [ ] Clicking button opens the AI Remediation setup modal

---

**Status:** Debug logging added, awaiting console output to identify root cause.
