import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPersistableDeploySnapshot, clearDownloadedDeploySecrets, type DeployStateSnapshot } from './state';

function bulkySnapshot(): DeployStateSnapshot {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  const logs = Array.from({ length: 200 }, (_, index) => ({
    text: `apply line ${index} ${'x'.repeat(4000)}`,
    ts: new Date().toISOString(),
    type: 'info' as const,
  }));
  return {
    status: 'running',
    progress: 40,
    logs,
    deployResult: {
      success: true,
      app_url: 'http://1.2.3.4',
      generated_ec2_private_key_pem: pem,
      keypair: { key_name: 'demo-key', private_key_pem: pem },
      one_time_credentials: {
        private_key_pem: pem,
        key_name: 'demo-key',
        instance_id: 'i-abc',
        key_file_name: 'demo-key-i-abc.pem',
        database_env: 'PGPASSWORD=secret\n',
        database_file_name: 'demo-key-i-abc-database.env',
        download_once: true,
      },
      outputs: { ec2_instance_id: 'i-abc', generated_ec2_private_key_pem: pem },
      raw_outputs: { generated_ec2_private_key_pem: pem },
      details: {
        apply_log_tail: 'x'.repeat(50000),
        init_log_tail: 'y'.repeat(50000),
        live_runtime_details: { instance: { instance_id: 'i-abc' } },
      },
    },
    deploymentHistory: Array.from({ length: 20 }, (_, index) => ({
      id: `run-${index}`,
      createdAt: new Date().toISOString(),
      status: 'done' as const,
      region: 'eu-north-1',
      cloudfrontUrl: 'n/a',
      instanceId: 'i-abc',
      deployResult: {
        details: { apply_log_tail: 'z'.repeat(20000) },
        generated_ec2_private_key_pem: pem,
      },
    })),
    updatedAt: new Date().toISOString(),
  };
}

test('persistable snapshot drops PEM and terraform log tails', () => {
  const slim = buildPersistableDeploySnapshot(bulkySnapshot(), 0);
  assert.equal(slim.deployResult?.generated_ec2_private_key_pem, null);
  assert.equal(slim.deployResult?.keypair?.private_key_pem, null);
  assert.equal(slim.deployResult?.one_time_credentials?.private_key_pem, null);
  assert.equal(slim.deployResult?.one_time_credentials?.database_env, null);
  assert.equal(slim.deployResult?.one_time_credentials?.key_file_name, 'demo-key-i-abc.pem');
  assert.equal(slim.deployResult?.one_time_credentials?.key_name, 'demo-key');
  assert.equal(slim.deployResult?.raw_outputs, undefined);
  assert.equal(slim.deployResult?.outputs?.ec2_instance_id, 'i-abc');
  assert.equal(slim.deployResult?.outputs?.generated_ec2_private_key_pem, undefined);
  assert.equal(slim.deployResult?.details?.apply_log_tail, undefined);
  assert.deepEqual(slim.deployResult?.details?.live_runtime_details, { instance: { instance_id: 'i-abc' } });
  assert.ok(slim.logs.length <= 80);
  assert.ok((slim.logs[0]?.text.length || 0) <= 2100);
  assert.ok(slim.deploymentHistory.length <= 8);
  assert.ok(JSON.stringify(slim).length < JSON.stringify(bulkySnapshot()).length / 5);
});

test('level 2 snapshot is small enough for a full localStorage origin', () => {
  const slim = buildPersistableDeploySnapshot(bulkySnapshot(), 2);
  assert.ok(slim.logs.length <= 8);
  assert.equal(slim.deployResult?.details, null);
  assert.equal(slim.deploymentHistory[0]?.deployResult, null);
  assert.ok(JSON.stringify(slim).length < 80_000);
});

test('clearDownloadedDeploySecrets wipes PEM and database password after download', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----';
  const cleared = clearDownloadedDeploySecrets('proj-1', {
    generated_ec2_private_key_pem: pem,
    keypair: { key_name: 'ifca-prod-abcd-key', private_key_pem: pem },
    one_time_credentials: {
      private_key_pem: pem,
      database_env: 'PGPASSWORD=secret\n',
      key_file_name: 'ifca-prod-abcd-key-i-abc.pem',
      download_once: true,
    },
  });
  assert.equal(cleared?.generated_ec2_private_key_pem, null);
  assert.equal(cleared?.keypair?.private_key_pem, null);
  assert.equal(cleared?.one_time_credentials?.private_key_pem, null);
  assert.equal(cleared?.one_time_credentials?.database_env, null);
  assert.equal(cleared?.one_time_credentials?.credentials_downloaded, true);
  assert.equal(cleared?.one_time_credentials?.key_file_name, 'ifca-prod-abcd-key-i-abc.pem');
});
