import {
  forgetSsoUrl,
  listSavedSsoUrls,
  rememberSsoUrl,
  togglePinSsoUrl,
} from './saved-urls';

const KEY = 'ct.sso.startUrls';

describe('saved SSO Start URLs', () => {
  beforeEach(() => localStorage.removeItem(KEY));
  afterEach(() => localStorage.removeItem(KEY));

  it('remembers a URL with its region, most-recent first', () => {
    rememberSsoUrl('https://a.awsapps.com/start', 'us-east-1');
    rememberSsoUrl('https://b.awsapps.com/start', 'eu-west-1');

    const list = listSavedSsoUrls();
    expect(list.map((e) => e.url)).toEqual([
      'https://b.awsapps.com/start',
      'https://a.awsapps.com/start',
    ]);
    expect(list[1].region).toBe('us-east-1');
  });

  it('de-duplicates by URL and refreshes recency', () => {
    rememberSsoUrl('https://a.awsapps.com/start', 'us-east-1');
    rememberSsoUrl('https://b.awsapps.com/start', 'eu-west-1');
    rememberSsoUrl('https://a.awsapps.com/start', 'sa-east-1');

    const list = listSavedSsoUrls();
    expect(list.length).toBe(2);
    expect(list[0].url).toBe('https://a.awsapps.com/start');
    expect(list[0].region).toBe('sa-east-1');
  });

  it('keeps at most 8 unpinned entries', () => {
    for (let i = 0; i < 12; i++) rememberSsoUrl(`https://org${i}.awsapps.com/start`, 'us-east-1');
    expect(listSavedSsoUrls().length).toBe(8);
  });

  it('sorts pinned entries first and never drops them to stay under the cap', () => {
    rememberSsoUrl('https://keep.awsapps.com/start', 'us-east-1');
    togglePinSsoUrl('https://keep.awsapps.com/start');

    for (let i = 0; i < 12; i++) rememberSsoUrl(`https://org${i}.awsapps.com/start`, 'us-east-1');

    const list = listSavedSsoUrls();
    expect(list[0].url).toBe('https://keep.awsapps.com/start');
    expect(list[0].pinned).toBeTrue();
    expect(list.filter((e) => !e.pinned).length).toBe(8);
  });

  it('preserves the pinned flag when the URL is used again', () => {
    rememberSsoUrl('https://a.awsapps.com/start', 'us-east-1');
    togglePinSsoUrl('https://a.awsapps.com/start');
    rememberSsoUrl('https://a.awsapps.com/start', 'eu-west-1');

    const entry = listSavedSsoUrls()[0];
    expect(entry.pinned).toBeTrue();
    expect(entry.region).toBe('eu-west-1');
  });

  it('toggles a pin off again', () => {
    rememberSsoUrl('https://a.awsapps.com/start', 'us-east-1');
    togglePinSsoUrl('https://a.awsapps.com/start');
    togglePinSsoUrl('https://a.awsapps.com/start');
    expect(listSavedSsoUrls()[0].pinned).toBeFalsy();
  });

  it('forgets a single URL, pinned or not', () => {
    rememberSsoUrl('https://a.awsapps.com/start', 'us-east-1');
    rememberSsoUrl('https://b.awsapps.com/start', 'eu-west-1');
    togglePinSsoUrl('https://a.awsapps.com/start');

    forgetSsoUrl('https://a.awsapps.com/start');
    expect(listSavedSsoUrls().map((e) => e.url)).toEqual(['https://b.awsapps.com/start']);
  });

  it('returns an empty list when storage holds junk', () => {
    localStorage.setItem(KEY, '{not json');
    expect(listSavedSsoUrls()).toEqual([]);
  });
});
