import { GitService } from './git.service';

describe('GitService.buildBranchName', () => {
  let service: GitService;
  const originalStrategy = process.env.GIT_PUSH_STRATEGY;

  beforeEach(() => {
    service = new GitService();
    delete process.env.GIT_PUSH_STRATEGY;
  });

  afterAll(() => {
    if (originalStrategy === undefined) delete process.env.GIT_PUSH_STRATEGY;
    else process.env.GIT_PUSH_STRATEGY = originalStrategy;
  });

  it('uses the fix- prefix by default', () => {
    expect(service.buildBranchName(142, 'Payment timeout')).toBe(
      'lazydev/fix-142-payment-timeout',
    );
  });

  it('uses the feat- prefix for features', () => {
    expect(
      service.buildBranchName(501, 'Add a health endpoint', 'feature'),
    ).toBe('lazydev/feat-501-add-a-health-endpoint');
  });

  // Feature issues are titled "Feature: X" by implement_new_feature, which
  // would otherwise produce lazydev/feat-501-feature-x.
  it('strips a leading kind prefix from the title before slugging', () => {
    expect(
      service.buildBranchName(501, 'Feature: Add a health endpoint', 'feature'),
    ).toBe('lazydev/feat-501-add-a-health-endpoint');

    expect(service.buildBranchName(7, 'Fix: Broken login')).toBe(
      'lazydev/fix-7-broken-login',
    );
  });

  it('strips punctuation and collapses whitespace', () => {
    expect(service.buildBranchName(9, 'Crash in /api/users (500!)')).toBe(
      'lazydev/fix-9-crash-in-apiusers-500',
    );
  });

  it('truncates long titles without leaving a trailing dash', () => {
    const branch = service.buildBranchName(
      1,
      'a'.repeat(20) + ' ' + 'b'.repeat(40),
      'feature',
    );

    expect(branch.startsWith('lazydev/feat-1-')).toBe(true);
    expect(branch).not.toMatch(/-$/);
    expect(branch.length).toBeLessThanOrEqual('lazydev/feat-1-'.length + 40);
  });

  it('appends a timestamp under the unique_branch push strategy', () => {
    process.env.GIT_PUSH_STRATEGY = 'unique_branch';

    expect(service.buildBranchName(142, 'Payment timeout')).toMatch(
      /^lazydev\/fix-142-payment-timeout-\d+$/,
    );
  });
});
