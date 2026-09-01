import type { InfraConsultantDecision } from '@/features/deployment/state';
import { DEFAULT_AWS_REGION } from '@/features/deployment/state';
import { coerceHttpAppPort } from '@/features/deployment/http-ports';

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asRecord(item)).filter((item) => Object.keys(item).length > 0);
}

function asString(value: unknown): string {
  return String(value || '').trim();
}

export function budgetCapFromAnswers(answers: Record<string, string> | null | undefined, fallback = 100): number {
  const raw = String(answers?.q_budget || '').replace('$', '').trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function wantsRedis(answers: Record<string, string> | undefined, dataLayerHasRedis: boolean): boolean {
  const choice = asString(answers?.q_redis);
  if (choice === 'none' || choice === 'false' || choice === 'no') return false;
  if (choice === 'yes' || choice === 'true' || choice === '7.0' || choice === '6.2') return true;
  const legacy = asString(answers?.q_redis_version);
  if (legacy === '7.0' || legacy === '6.2') return true;
  return dataLayerHasRedis;
}

function publicEntryMode(
  answers: Record<string, string> | undefined,
  strategy: string,
): 'alb' | 'elastic_ip' | 'none' {
  const publicApi = asString(answers?.q_public_api) !== 'false';
  if (!publicApi || strategy === 's3_cloudfront') return 'none';

  const explicit = asString(answers?.q_load_balancer).toLowerCase();
  if (explicit === 'alb' || explicit === 'elastic_ip' || explicit === 'none') {
    return explicit;
  }

  const eipAnswer = asString(answers?.q_elastic_ip);
  if (eipAnswer === 'false') return 'alb';
  if (eipAnswer === 'true') return strategy === 'ec2' ? 'elastic_ip' : 'alb';

  if (strategy === 'ecs_fargate') return 'alb';
  return 'elastic_ip';
}

export function decisionFromDeploymentProfile(params: {
  deploymentProfile: Record<string, unknown> | null | undefined;
  answers?: Record<string, string>;
  awsRegion?: string;
}): InfraConsultantDecision {
  const profile = asRecord(params.deploymentProfile);
  const compute = asRecord(profile.compute);
  const networking = asRecord(profile.networking);
  const loadBalancer = asRecord(networking.load_balancer);
  const dataLayer = asRecords(profile.data_layer);
  const services = asRecords(compute.services);
  const web = services.find((item) => asString(item.process_type).toLowerCase() === 'web') || services[0] || {};
  const primary = web;
  const strategy = asString(compute.strategy) || 'ec2';
  const region = asString(params.awsRegion) || DEFAULT_AWS_REGION;
  const appPort = coerceHttpAppPort(web.port, 3000);
  const publicApi = asString(params.answers?.q_public_api) !== 'false';
  const hasRds = dataLayer.some((item) => ['postgresql', 'postgres', 'mysql', 'mariadb'].includes(asString(item.type).toLowerCase()));
  const redisFromLayer = dataLayer.some((item) => asString(item.type).toLowerCase() === 'redis');
  const hasRedis = wantsRedis(params.answers, redisFromLayer);
  const rds = dataLayer.find((item) => ['postgresql', 'postgres', 'mysql', 'mariadb'].includes(asString(item.type).toLowerCase())) || {};
  const entryMode = publicEntryMode(params.answers, strategy);
  const needAlb = entryMode === 'alb';
  const needEip = entryMode === 'elastic_ip';

  const components: string[] = [];
  if (strategy !== 's3_cloudfront') components.push('vpc');
  if (strategy === 's3_cloudfront') components.push('s3_cloudfront');
  if (strategy === 'ecs_fargate') components.push('ecs');
  if (strategy === 'ec2') components.push('ec2');
  if (needAlb) components.push('alb');
  if (needEip) components.push('eip');
  if (hasRds) components.push('rds');
  if (hasRedis) components.push('elasticache');

  const stackConfig: Record<string, unknown> = {
    networking: {
      vpc: asString(networking.vpc) || 'new',
      layout: asString(networking.layout) || 'private_subnets',
      nat_gateway: Boolean(networking.nat_gateway),
      load_balancer: needAlb ? loadBalancer : {},
      elastic_ip: needEip ? { enabled: true, associate_with: 'ec2' } : {},
      ports_exposed: Array.isArray(networking.ports_exposed) ? networking.ports_exposed : [80, 443],
    },
  };

  if (strategy === 'ec2') {
    stackConfig.ec2 = {
      app_port: appPort,
      aws_region: region,
      public_http: !needAlb,
      behind_alb: needAlb,
      associate_eip: needEip,
      desired_count: Number(primary.desired_count) || 1,
      ssh_ingress_cidr_blocks: [],
    };
  }
  if (strategy === 'ecs_fargate') {
    stackConfig.ecs = {
      cpu: Number(primary.cpu) || 512,
      memory: Number(primary.memory) || 1024,
      desired_count: Number(primary.desired_count) || 1,
      app_port: appPort,
    };
  }
  if (strategy === 's3_cloudfront') {
    stackConfig.s3_cloudfront = {
      origin_type: 's3',
      price_class: 'PriceClass_100',
      spa_fallback: true,
    };
  }
  if (needAlb) {
    stackConfig.alb = {
      enabled: true,
      scheme: 'internet-facing',
      listeners: ['http', 'https'],
      health_check_path: '/',
      target_port: appPort,
      need_alb: true,
    };
  }
  if (needEip) {
    stackConfig.eip = { enabled: true, associate_with: 'ec2', need_eip: true };
  }
  if (hasRds) {
    const engineRaw = asString(rds.type).toLowerCase();
    const engine = engineRaw === 'mysql' || engineRaw === 'mariadb' ? engineRaw : 'postgres';
    stackConfig.rds = {
      engine,
      publicly_accessible: false,
    };
  }
  if (hasRedis) {
    stackConfig.elasticache = {
      engine: 'redis',
    };
  }

  const notes = [
    `Planning answers selected ${strategy.replace('_', ' ')} in ${asString(profile.environment) || 'production'}.`,
    needAlb ? 'Public entry uses an application load balancer.' : needEip ? 'Public entry uses an Elastic IP on EC2.' : 'No public load balancer.',
    hasRds ? 'Managed SQL is included from the repository scan.' : 'No managed SQL datastore.',
    hasRedis ? 'Managed Redis is included.' : 'No managed cache.',
  ];

  return {
    provider: 'aws',
    region,
    components,
    deploy_sequence: [...components],
    stack_config: stackConfig,
    need_alb: needAlb,
    need_eip: needEip,
    outputs_to_capture: [
      'app_url',
      ...(needAlb ? ['alb_dns_name', 'load_balancer_dns_name'] : []),
      ...(needEip || strategy === 'ec2' ? ['ec2_instance_id', 'ec2_public_ip', 'elastic_ip'] : []),
      ...(strategy === 's3_cloudfront' ? ['cloudfront_url'] : []),
      ...(hasRds ? ['rds_endpoint'] : []),
      ...(hasRedis ? ['redis_endpoint'] : []),
    ],
    consultant_notes: notes,
    open_questions: [],
    intakes: {
      budget_cap_usd: budgetCapFromAnswers(params.answers),
      compute_strategy: strategy,
    },
  };
}

export function isQuestionAnswered(questionId: string, answers: Record<string, string>): boolean {
  return Object.prototype.hasOwnProperty.call(answers, questionId);
}

export function nextScriptedQuestionIndex(
  questions: Array<{ id: string }>,
  answers: Record<string, string>,
): number {
  const unanswered = questions.findIndex((question) => !isQuestionAnswered(question.id, answers));
  return unanswered >= 0 ? unanswered : questions.length;
}

/** Viewing index for the questionnaire. `questionCount` means "all done". */
export function resolveScriptedQuestionCursor(
  questionCount: number,
  unansweredIndex: number,
  cursor: number | null,
): number {
  const count = Math.max(0, Math.trunc(questionCount) || 0);
  if (count === 0) return 0;
  const unanswered = Math.max(0, Math.min(Math.trunc(unansweredIndex) || 0, count));
  const raw = cursor == null ? unanswered : cursor;
  if (!Number.isFinite(raw)) return unanswered;
  return Math.max(0, Math.min(Math.trunc(raw), count));
}

export function buildScriptedHistory(
  questions: Array<{ id: string; question: string; options?: Array<{ value: string; label: string }> }>,
  answers: Record<string, string>,
  currentIndex: number,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  questions.forEach((question, index) => {
    if (index > currentIndex) return;
    history.push({ role: 'assistant', content: question.question });
    if (!isQuestionAnswered(question.id, answers)) return;
    const raw = String(answers[question.id] || '').trim();
    const option = (question.options || []).find((item) => item.value === raw);
    history.push({
      role: 'user',
      content: option?.label || (raw.length > 0 ? raw : 'Skip'),
    });
  });
  return history;
}
