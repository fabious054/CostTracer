import { errKey } from './detector-section.component';

/** Grouping key for region errors — messages that differ only by region / request id collapse. */
describe('errKey', () => {
  it('collapses messages that differ only by the region code', () => {
    expect(errKey("Service 'logs' is not enabled in us-east-1.")).toBe(
      errKey("Service 'logs' is not enabled in eu-west-1."),
    );
    expect(errKey('DescribeDBSnapshots: not implemented (ap-southeast-2)')).toBe(
      errKey('DescribeDBSnapshots: not implemented (sa-east-1)'),
    );
  });

  it('collapses messages that differ only by a request-id / UUID', () => {
    expect(errKey('call failed 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d')).toBe(
      errKey('call failed 9f8e7d6c-5b4a-3c2d-1e0f-a9b8c7d6e5f4'),
    );
  });

  it('keeps genuinely different messages in separate groups', () => {
    expect(errKey("Service 'logs' is not enabled.")).not.toBe(
      errKey("API for service 'rds' not yet implemented or pro feature."),
    );
  });

  it('normalises whitespace and case', () => {
    expect(errKey('  Access   Denied\n')).toBe(errKey('access denied'));
  });
});
