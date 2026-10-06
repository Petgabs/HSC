/*
 * Public, non-secret School Cloud settings.
 *
 * The administrator identity below stores only the username, a random salt and
 * the lowercase hex SHA-256 digest of `<salt>:<password>`. The plain password is
 * never written to this file, to source control, or to any other shipped asset —
 * share it with the administrator out of band. Rotate it by generating a fresh
 * salt and recomputing the digest.
 *
 * The `master` block is the master password required to open Cloud Settings.
 * It is stored exactly the same way — a salt and a digest, never the plain
 * password — and its shipped default is shared with the administrator out of
 * band. Rotating either credential from Cloud Settings commits a new salt and
 * digest into this file on GitHub, so the change reaches every device when
 * GitHub Pages finishes deploying.
 *
 * Never put a GitHub token in this file. The administrator pastes a token in
 * Settings; the site encrypts it for a one-time GitHub Actions repository
 * secret, and remembers it in this browser's storage on that device so the
 * dashboard reconnects without asking for it again. GitHub's write-only secret
 * store is not readable by this static website.
 *
 * So that the token also works on a different computer, the same save
 * encrypts it with the administrator and master passwords and commits the
 * ciphertext to `assets/data/publish-token.json` (see lib/tokenVault.js).
 * Signing in anywhere unlocks that copy in the browser. The passwords below
 * are therefore what protect the publishing token as well: keep them long and
 * unique, and re-save the token after any rotation.
 */
export const SITE_CONFIG = Object.freeze({
  repository: Object.freeze({
    owner: 'Petgabs',
    name: 'HSC',
    branch: 'main'
  }),
  // `admin` and `master` are deliberately not frozen: Cloud Settings replaces
  // these three values (and the two below) in memory the moment a rotation is
  // committed, so the new credential works on this device immediately instead
  // of only after the next GitHub Pages deployment.
  admin: {
    username: 'hsc-admin',
    salt: '38db6ef217b6b8073322397c4b77028d',
    passwordHash: 'da1e5613d14c67441a073860fe92ff653ba9f6bba38954534afb5218c60e6822'
  },
  master: {
    salt: '23fd392e297167dd7efb39cc345c4808',
    passwordHash: 'e5286ed75095b3ae3e8dd2fbed216e20e2e575cb69b31bd4270b7d544db37986'
  },
  abacus: Object.freeze({
    baseUrl: 'https://abacus.jasoncameron.dev',
    namespace: 'petgabs-hsc-schoolcloud',
    visitorKey: 'visitors'
  }),
  maxUploadBytes: 50 * 1024 * 1024,
  // The cloud storage allowance the admin dashboard measures the published
  // files against. GitHub Pages serves a published site of up to 1 GB, and
  // GitHub recommends keeping a repository under 1 GB, so that is the default.
  // Change `quotaBytes` if the school moves to a different hosting plan; a
  // value of 0 tells the dashboard to report the remaining space as unknown.
  storage: Object.freeze({
    quotaBytes: 1_000_000_000,
    label: 'GitHub Pages allowance',
    note: 'GitHub Pages publishes a site of up to 1 GB. Files live in the apps/ folder of this repository.'
  })
});

function copyGate(gate) {
  return {
    username: typeof gate?.username === 'string' ? gate.username : '',
    salt: typeof gate?.salt === 'string' ? gate.salt : '',
    passwordHash: typeof gate?.passwordHash === 'string' ? gate.passwordHash.toLowerCase() : ''
  };
}

/** Read the administrator sign-in gate the site is currently enforcing. */
export function readAdminGate() {
  return copyGate(SITE_CONFIG.admin);
}

/** Read the master-password gate protecting Cloud Settings. */
export function readMasterGate() {
  return copyGate(SITE_CONFIG.master);
}

/**
 * Apply a rotated administrator credential for the rest of this page visit.
 * Only a username plus a salt/digest pair is ever held; the plain password is
 * hashed by the caller and never stored anywhere.
 */
export function applyAdminGate(credentials = {}) {
  const next = copyGate({ ...SITE_CONFIG.admin, ...credentials });
  if (next.username) SITE_CONFIG.admin.username = next.username;
  if (next.salt) SITE_CONFIG.admin.salt = next.salt;
  if (next.passwordHash) SITE_CONFIG.admin.passwordHash = next.passwordHash;
  return readAdminGate();
}

/** Apply a rotated master password for the rest of this page visit. */
export function applyMasterGate(credentials = {}) {
  const next = copyGate({ ...SITE_CONFIG.master, ...credentials });
  if (next.salt) SITE_CONFIG.master.salt = next.salt;
  if (next.passwordHash) SITE_CONFIG.master.passwordHash = next.passwordHash;
  return readMasterGate();
}

/**
 * A fingerprint of both shipped gates. A device that just rotated a credential
 * compares this against the signature it recorded before the change: while the
 * two still match, GitHub Pages has not deployed the new config yet and the
 * device keeps using its own copy; once the deployed file changes, the shipped
 * config wins again and the local copy is dropped.
 */
export function gateSignature() {
  const admin = readAdminGate();
  const master = readMasterGate();
  return [admin.username, admin.salt, admin.passwordHash, master.salt, master.passwordHash].join('|');
}

export const SUBJECTS = Object.freeze([
  'Mathematics', 'EALD/English', 'CAL', 'BS', 'VA', 'PHY', 'MEX', 'Others'
]);

export const YEAR_LEVELS = Object.freeze([9, 10, 11, 12]);

export const SUPPORTED_EXTENSIONS = Object.freeze([
  '.html', '.htm', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
]);
