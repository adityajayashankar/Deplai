# Evaluation & Regression Fixtures

This directory holds regression test fixtures: known repos (or repo snapshots)
plus the expected set of "unsafe" AST nodes the boundary classifier must
never allow the refactorer to touch.

## Structure

```
eval/
  fixtures/
    <fixture-name>/
      source/          # Minimal TSX/CSS files representing the test case
      expected_mask.json  # Expected diff-mask output from boundary_classifier
      expected_index.json # Expected component index from ast_chunker
```

These fixtures are checked into version control and used by CI to catch
regressions in the deterministic tools (Phase 1).
