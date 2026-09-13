import json
import unittest
from unittest.mock import patch

from architecture_decision.llm import converse, personalize_questions, recommend_answers
from deployment_planning_contract import ArchitectureQuestion, QuestionOption, RepositoryContextDocument


class DeploymentGlmPlanningTests(unittest.TestCase):
    def setUp(self):
        self.context = RepositoryContextDocument(project_root='/repo', workspace='tenant-project', project_name='app', project_type='github')
        self.questions = [ArchitectureQuestion(id='q_compute', category='compute', question='Which runtime?', options=[QuestionOption(value='ec2', label='EC2'), QuestionOption(value='ecs', label='ECS')])]

    @patch('architecture_decision.llm.chat_text')
    def test_conversation_maps_free_text_and_preserves_transcript(self, call):
        messages = [{'role': 'user', 'content': 'Use an EC2 server please.'}]
        call.return_value = (True, json.dumps({'assistant_message': 'What is your monthly budget?', 'answer_updates': {'q_compute': 'ec2'}, 'ready': False}))
        result = converse(self.context, self.questions, {}, messages)
        self.assertEqual(result['answers'], {'q_compute': 'ec2'})
        self.assertEqual(result['conversation'][:-1], messages)
        self.assertFalse(result['conversation_ready'])
        self.assertEqual(call.call_args.kwargs['model'], 'z-ai/glm-5.3-flash')

    @patch('architecture_decision.llm.chat_text')
    def test_conversation_clarification_preserves_requirements(self, call):
        call.return_value = (True, json.dumps({'assistant_message': 'EC2 runs your application on a virtual server.', 'answer_updates': {}, 'ready': False}))
        result = converse(self.context, self.questions, {'q_compute': 'ec2'}, [{'role': 'user', 'content': 'What does that mean?'}])
        self.assertEqual(result['answers'], {'q_compute': 'ec2'})

    @patch('architecture_decision.llm.chat_text')
    def test_conversation_rejects_unsupported_choice_and_invented_preferences(self, call):
        for value, messages in [('azure', [{'role': 'user', 'content': 'Help me deploy'}]), ('ec2', [])]:
            call.return_value = (True, json.dumps({'assistant_message': 'Ready', 'answer_updates': {'q_compute': value}, 'ready': True}))
            with self.assertRaises(ValueError):
                converse(self.context, self.questions, {}, messages)

    @patch('architecture_decision.llm.chat_text')
    def test_conversation_first_turn_cannot_be_ready(self, call):
        call.return_value = (True, json.dumps({'assistant_message': 'Who will use this app?', 'answer_updates': {}, 'ready': True}))
        self.assertFalse(converse(self.context, self.questions, {}, [])['conversation_ready'])

    @patch('architecture_decision.llm.chat_text')
    def test_questions_preserve_options_and_use_only_glm(self, call):
        call.return_value = (True, json.dumps({'questions': [{'id': 'q_compute', 'question': 'Where should this app run?'}]}))
        result = personalize_questions(self.context, self.questions)
        self.assertEqual(result[0].options, self.questions[0].options)
        self.assertEqual(call.call_args.kwargs['model'], 'z-ai/glm-5.3-flash')
        self.assertEqual(call.call_args.kwargs['access_mode'], 'platform')
        self.assertNotIn('response_format', call.call_args.kwargs)

    @patch('architecture_decision.llm.chat_text')
    def test_followup_uses_answers_and_keeps_answered_questions_first(self, call):
        traffic = ArchitectureQuestion(id='q_traffic', category='scale', question='Traffic?')
        call.return_value = (True, json.dumps({'questions': [
            {'id': 'q_traffic', 'question': 'How many people will use your EC2 app?'},
        ]}))
        result = personalize_questions(self.context, [traffic, *self.questions], {'q_compute': 'ec2'})
        self.assertEqual([q.id for q in result], ['q_compute', 'q_traffic'])
        evidence = json.loads(call.call_args.kwargs['messages'][1]['content'])
        self.assertEqual(evidence['answers_so_far'], {'q_compute': 'ec2'})
        self.assertIn('frameworks', evidence['repository'])

    @patch('architecture_decision.llm.chat_text')
    def test_explicit_answer_cannot_be_overridden(self, call):
        call.return_value = (True, json.dumps({'recommendations': {'q_compute': 'ecs'}}))
        with self.assertRaisesRegex(ValueError, 'user answer'):
            recommend_answers(self.context, self.questions, {'q_compute': 'ec2'})

    @patch('architecture_decision.llm.chat_text')
    def test_supported_recommendation_fills_unanswered_choice(self, call):
        call.return_value = (True, json.dumps({'recommendations': {'q_compute': 'ec2'}, 'service_plan': 'EC2 hosts the application.'}))
        self.assertEqual(recommend_answers(self.context, self.questions, {'q_compute': ''}), ({'q_compute': 'ec2'}, 'EC2 hosts the application.'))

    @patch('architecture_decision.llm.chat_text')
    def test_failure_does_not_return_deterministic_success(self, call):
        call.return_value = (False, 'private provider diagnostic')
        with self.assertRaisesRegex(RuntimeError, 'answers are retained') as raised:
            personalize_questions(self.context, self.questions)
        self.assertNotIn('private provider', str(raised.exception))

    @patch('architecture_decision.llm.chat_text')
    def test_missing_question_rejected(self, call):
        call.return_value = (True, '{"questions": []}')
        with self.assertRaisesRegex(ValueError, 'omitted'):
            personalize_questions(self.context, self.questions)


if __name__ == '__main__':
    unittest.main()
