import json
import unittest
from unittest.mock import patch

from agent import remediation_workflow as workflow
from test_remediation_workflow import _base_state


class IterationTests(unittest.TestCase):
    def setUp(self):
        # Unit fixtures must never write to a configured product journal.
        journal = patch.object(workflow, 'remediation_runs')
        journal.start()
        self.addCleanup(journal.stop)

    def test_failed_planner_never_dispatches_implementor(self):
        with patch.object(workflow, '_llm', return_value=(False, 'capacity unavailable')) as llm:
            result = workflow.build_remediation_graph().invoke(_base_state())
        self.assertIn('capacity unavailable', result['error'])
        self.assertEqual(llm.call_count, 1)

    def test_transport_retry_retains_plan_and_source_without_json_repair_prompt(self):
        state = {**_base_state(), 'plan': {'summary': 'existing plan'},
                 'source_observations': [{'result': {'path': 'helper.py', 'content': 'source evidence'}}]}
        with patch.object(workflow, '_llm', side_effect=[(False, 'timed out'), (True, '{"ok":true}')]) as llm:
            ok, result = workflow._json_contract_call(state, '{"plan":"existing plan"}', 'workflow_implementor',
                max_tokens=8192, validator=lambda v: v)
        self.assertTrue(ok)
        self.assertEqual(result, {'ok': True})
        self.assertEqual(llm.call_args_list[0].args[1], llm.call_args_list[1].args[1])
        self.assertIn('source evidence', llm.call_args_list[1].args[1])
        self.assertEqual(state['plan']['summary'], 'existing plan')

    def test_transport_timeout_retries_once_and_does_not_claim_invalid_json(self):
        with patch.object(workflow, '_llm', return_value=(False, 'timed out')) as llm:
            result = workflow._implementor_node(_base_state())
        self.assertEqual(llm.call_count, 2)
        self.assertIn('could not obtain a model response', result['error'])
        self.assertNotIn('JSON contract', result['error'])

    def test_planner_contract_retry_receives_string_array_schema(self):
        target = {'path': 'app.py', 'findings': [{'id': 'CWE-79'}],
                  'approach': 'Escape output', 'verification': 'Run security check'}
        invalid = {'summary': 'Fix sink', 'targets': [target], 'constraints': []}
        valid = {**invalid, 'targets': [{**target, 'findings': ['CWE-79']}]}
        with patch.object(workflow, '_llm', side_effect=[
            (True, json.dumps(invalid)), (True, json.dumps(valid)),
        ]) as llm:
            result = workflow._planner_node(_base_state())
        self.assertEqual(result['plan'], valid)
        self.assertEqual(llm.call_count, 2)
        prompt = json.loads(llm.call_args_list[0].args[1])
        findings_schema = prompt['output_schema']['properties']['targets']['items']['properties']['findings']
        self.assertEqual(findings_schema['items']['type'], 'string')
        self.assertIn('Planner target findings must be strings', llm.call_args_list[1].args[1])

    def test_invalid_planner_findings_never_reach_implementor_or_reviewer(self):
        invalid = {'summary': 'Fix sink', 'targets': [{'path': 'app.py', 'findings': [{'id': 'CWE-79'}],
                   'approach': 'Escape output', 'verification': 'Run security check'}], 'constraints': []}
        with patch.object(workflow, '_llm', return_value=(True, json.dumps(invalid))) as llm, \
             patch.object(workflow, '_implementor_node') as implementor, \
             patch.object(workflow, '_reviewer_node') as reviewer:
            result = workflow.build_remediation_graph().invoke(_base_state())
        self.assertIn('Planner target findings must be strings', result['error'])
        self.assertEqual(llm.call_count, 2)
        implementor.assert_not_called()
        reviewer.assert_not_called()

    def test_planner_can_read_source_before_returning_plan(self):
        plan = {'summary': 'Fix sink', 'targets': [{'path': 'app.py', 'findings': ['CWE-79'],
                'approach': 'Escape output', 'verification': 'Run security check'}], 'constraints': []}
        responses = [(True, json.dumps({'action': 'read_file', 'path': 'helper.py'})), (True, json.dumps(plan))]
        with patch.object(workflow, '_llm', side_effect=responses) as llm, \
             patch.object(workflow, '_list_candidate_files', return_value=['app.py', 'helper.py']), \
             patch.object(workflow, '_read_context_candidates', return_value={'helper.py': 'def escape(value): pass'}):
            state = workflow._planner_node(_base_state())
        self.assertEqual(state['plan'], plan)
        self.assertIn('def escape(value)', llm.call_args.args[1])
        self.assertEqual(state['allowed_paths'], ['app.py'])

    def test_context_tools_cannot_read_outside_index(self):
        with patch.object(workflow, '_list_candidate_files', return_value=['app.py']), \
             patch.object(workflow, '_read_context_candidates') as read:
            for path in ('../secret', '/etc/passwd', '.env', 'unknown.py'):
                with self.assertRaises(ValueError):
                    workflow._context_action(_base_state(), {'action': 'read_file', 'path': path})
            read.assert_not_called()

    def test_graph_stops_after_one_actionable_repair(self):
        rounds = []
        def implement(state):
            rounds.append(state['round'])
            return state
        def review(state):
            return {**state, 'critique': {'verdict': 'accept' if state['round'] >= 2 else 'reject',
                                         'missing': ['Fix the exact source match']}}
        with patch.object(workflow, '_planner_node', side_effect=lambda state: state), \
             patch.object(workflow, '_implementor_node', side_effect=implement), \
             patch.object(workflow, '_reviewer_node', side_effect=review), \
             patch.object(workflow, '_synthesizer_node', side_effect=lambda state: state):
            result = workflow.build_remediation_graph().invoke(_base_state(), {'recursion_limit': 32})
        self.assertEqual(rounds, [0, 1])
        self.assertEqual(result['critique']['verdict'], 'reject')

    def test_source_evidence_survives_more_than_four_reads_and_stage_handoff(self):
        state = _base_state()
        replies = [(True, json.dumps({'action': 'read_file', 'path': f'helper{i}.py'})) for i in range(6)]
        replies.append((True, json.dumps({'done': True})))
        with patch.object(workflow, '_llm', side_effect=replies) as llm, \
             patch.object(workflow, '_context_action', side_effect=lambda s, a: {'content': a['path']}):
            ok, _ = workflow._json_contract_call(state, '{}', 'planner', max_tokens=100, validator=lambda v: v)
        self.assertTrue(ok)
        self.assertIn('helper0.py', llm.call_args.args[1])
        with patch.object(workflow, '_llm', return_value=(True, '{"done":true}')) as llm:
            workflow._json_contract_call(state, '{}', 'implementor', max_tokens=100, validator=lambda v: v)
        self.assertIn('helper0.py', llm.call_args.args[1])
        self.assertIn('helper5.py', llm.call_args.args[1])
        self.assertEqual(state['allowed_paths'], ['app.py'])

    def test_exploration_budget_is_shared_between_stages(self):
        state = {**_base_state(), 'source_tool_calls': 16}
        with patch.object(workflow, '_llm', return_value=(True, '{"action":"list_files"}')), \
             patch.object(workflow, '_context_action') as tool:
            ok, error = workflow._json_contract_call(state, '{}', 'implementor', max_tokens=100, validator=lambda v: v)
        self.assertFalse(ok)
        self.assertIn('budget exhausted', error)
        tool.assert_not_called()
