/**
 * Architecture rules for MailQueue (checked by `npm run lint:arch`).
 *
 * Layers (each may only call the layer directly below it):
 *
 *     api  ->  services  ->  data  ->  models
 *
 * - models:   entities, DTOs, Zod schemas, domain errors. Depends on nothing in src/.
 * - data:     the ONLY place that talks to PostgreSQL, pg-boss and Resend.
 * - services: business logic. No HTTP, no SQL.
 * - api:      HTTP routes/controllers/validation and queue job handlers. No SQL.
 *
 * src/config and src/lib are small cross-cutting helpers (env config, logger).
 * src/server.ts and src/worker.ts are "composition roots": they create the objects
 * of every layer and connect them, so they are allowed to import from all layers.
 */
const LAYERS_ABOVE_MODELS = '^src/(api|services|data|config|lib)/';

module.exports = {
  forbidden: [
    // ---- Layer direction -------------------------------------------------
    {
      name: 'models-depend-on-nothing',
      comment: 'models must not import from any other layer.',
      severity: 'error',
      from: { path: '^src/models/' },
      to: { path: LAYERS_ABOVE_MODELS },
    },
    {
      name: 'data-must-not-import-upper-layers',
      comment: 'data may only use models (and config/lib).',
      severity: 'error',
      from: { path: '^src/data/' },
      to: { path: '^src/(api|services)/' },
    },
    {
      name: 'services-must-not-import-api',
      comment: 'services must not know about HTTP or the api layer.',
      severity: 'error',
      from: { path: '^src/services/' },
      to: { path: '^src/api/' },
    },
    {
      name: 'api-must-not-skip-services',
      comment: 'api must call services; it may never reach into the data layer directly.',
      severity: 'error',
      from: { path: '^src/api/' },
      to: { path: '^src/data/' },
    },
    {
      name: 'config-and-lib-are-leaf-helpers',
      comment: 'config/lib are shared helpers; they must not depend on the layers.',
      severity: 'error',
      from: { path: '^src/(config|lib)/' },
      to: { path: '^src/(api|services|data)/' },
    },

    // ---- Infrastructure libraries are confined to their layer -------------
    {
      name: 'database-libraries-only-in-data',
      comment: 'pg / pg-boss / node-pg-migrate (all SQL) may only be used in src/data.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/data/' },
      to: { path: '(^|/)node_modules/(pg|pg-boss|node-pg-migrate)/' },
    },
    {
      name: 'resend-only-in-data',
      comment: 'The Resend SDK may only be used in src/data.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/data/' },
      to: { path: '(^|/)node_modules/resend/' },
    },
    {
      name: 'http-libraries-only-in-api',
      comment: 'Express and HTTP middleware may only be used in src/api.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/api/' },
      to: { path: '(^|/)node_modules/(express|pino-http)/' },
    },

    // ---- General hygiene ---------------------------------------------------
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'Every import must resolve to a real file or installed package.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'not-to-dev-dependency',
      comment: 'Production code must not import devDependencies (they are not installed in prod).',
      severity: 'error',
      from: { path: '^src/' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
