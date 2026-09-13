"""Combine independently generated patches without overwriting other edits."""
from difflib import SequenceMatcher
import json


def _merge_json(base, left, right):
    if left == right or right == base:
        return left
    if left == base:
        return right
    if all(isinstance(value, dict) for value in (base, left, right)):
        missing = object()
        result = {}
        for key in dict.fromkeys([*base, *left, *right]):
            value = _merge_json(base.get(key, missing), left.get(key, missing), right.get(key, missing))
            if value is not missing:
                result[key] = value
        return result
    raise ValueError('Conflicting JSON values require a combined patch; no value was selected automatically')


def assemble_patches(source: str, diffs: list[str], apply_diff) -> str:
    source = source.replace("\r\n", "\n")
    baseline = source.splitlines(keepends=True)
    edits = []
    seen = set()
    for diff in diffs:
        if diff in seen:
            continue
        seen.add(diff)
        try:
            candidate = apply_diff(source, diff).splitlines(keepends=True)
        except ValueError:
            # Later user-approved rounds may target the already combined state.
            current = list(baseline)
            for start, end, replacement in sorted(edits, key=lambda item: item[0], reverse=True):
                current[start:end] = replacement
            candidate = apply_diff(''.join(current), diff).splitlines(keepends=True)
            edits = []

        for tag, start, end, new_start, new_end in SequenceMatcher(None, baseline, candidate, autojunk=False).get_opcodes():
            if tag == 'equal':
                continue
            replacement = candidate[new_start:new_end]
            edit = (start, end, replacement)
            if edit in edits:
                continue
            for old_start, old_end, _ in edits:
                overlap = max(start, old_start) < min(end, old_end)
                insertion_overlap = (start == end and old_start <= start <= old_end) or (old_start == old_end and start <= old_start <= end)
                if overlap or insertion_overlap:
                    current = list(baseline)
                    for a, b, lines in sorted(edits, key=lambda item: item[0], reverse=True):
                        current[a:b] = lines
                    try:
                        merged = _merge_json(json.loads(source), json.loads(''.join(current)), json.loads(''.join(candidate)))
                    except (json.JSONDecodeError, ValueError) as exc:
                        raise ValueError('Conflicting patches change the same source lines or JSON values; regenerate a combined patch before approval') from exc
                    # Re-run assembly with a consolidated baseline diff so every
                    # subsequent patch is still checked against the original.
                    import difflib
                    merged_source = json.dumps(merged, indent=2, ensure_ascii=False) + '\n'
                    merged_diff = ''.join(difflib.unified_diff(baseline, merged_source.splitlines(keepends=True), fromfile='a/file', tofile='b/file'))
                    remaining = [item for item in diffs if item not in seen]
                    return assemble_patches(source, [merged_diff, *remaining], apply_diff)
            edits.append(edit)
    combined = list(baseline)
    for start, end, replacement in sorted(edits, key=lambda item: item[0], reverse=True):
        combined[start:end] = replacement
    return ''.join(combined)
