/*
 * Public, non-secret School Cloud settings.
 *
 * The old checkout does not contain its former configuration/credential file.
 * Leave the administrator identity blank until the existing (unchanged)
 * username, salt and SHA-256 digest are restored here. Never put a GitHub token
 * in this file: the administrator pastes a replacement into Settings, where it
 * remains in memory in that browser tab only.
 */
export const SITE_CONFIG = Object.freeze({
  repository: Object.freeze({
    owner: 'Petgabs',
    name: 'HSC',
    branch: 'main'
  }),
  admin: Object.freeze({
    username: '',
    salt: '',
    passwordHash: ''
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
