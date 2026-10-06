/*
 * Public, non-secret School Cloud settings.
 *
 * The administrator identity below stores only the username, a random salt and
 * the lowercase hex SHA-256 digest of `<salt>:<password>`. The plain password is
 * never written to this file, to source control, or to any other shipped asset —
 * share it with the administrator out of band. Rotate it by generating a fresh
 * salt and recomputing the digest.
 *
 * Never put a GitHub token in this file: the administrator pastes a replacement
 * into Settings, where it remains in memory in that browser tab only.
 */
export const SITE_CONFIG = Object.freeze({
  repository: Object.freeze({
    owner: 'Petgabs',
    name: 'HSC',
    branch: 'main'
  }),
  admin: Object.freeze({
    username: 'hsc-admin',
    salt: '175cdc5b0ca6816f4bd3ace5af69aa6e',
    passwordHash: '2c3c6a87fc12ae957a765902d81307342ecbaad9904a7bf78c768df8a861a277'
  }),
  abacus: Object.freeze({
    baseUrl: 'https://abacus.jasoncameron.dev',
    namespace: 'petgabs-hsc-schoolcloud',
    visitorKey: 'visitors'
  }),
  maxUploadBytes: 50 * 1024 * 1024
});

export const SUBJECTS = Object.freeze([
  'Mathematics', 'EALD/English', 'CAL', 'BS', 'VA', 'PHY', 'MEX', 'Others'
]);

export const YEAR_LEVELS = Object.freeze([9, 10, 11, 12]);

export const SUPPORTED_EXTENSIONS = Object.freeze([
  '.html', '.htm', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
]);
