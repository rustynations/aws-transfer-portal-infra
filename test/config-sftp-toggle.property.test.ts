/**
 * Property-Based Tests: Config sftp.enabled toggle
 * Feature: sftp-toggle
 *
 * Tests Properties 1–4 and 8 for the sftp.enabled configuration field.
 */

import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { ConfigLoader } from '../src/config/loader';
import { TransferPortalConfig } from '../src/config/types';

/**
 * Helper: write a config object to a temp YAML file, load it via ConfigLoader,
 * and clean up.
 */
function loadFromYaml(configObj: Record<string, any>): TransferPortalConfig {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-toggle-'));
  const tmpFile = path.join(tmpDir, 'config.yml');
  try {
    fs.writeFileSync(tmpFile, yaml.dump(configObj), 'utf8');
    return ConfigLoader.load(tmpFile);
  } finally {
    fs.unlinkSync(tmpFile);
    fs.rmdirSync(tmpDir);
  }
}

/**
 * Arbitrary: generates a valid project name (alphanumeric + hyphens/underscores).
 */
const projectNameArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s: string) => /^[a-zA-Z0-9_-]+$/.test(s));

/**
 * Arbitrary: generates a valid protocol array (non-empty subset of SFTP/FTPS).
 */
const validProtocolsArb = fc.subarray(['SFTP', 'FTPS'] as const, { minLength: 1 });

/**
 * Arbitrary: generates a minimal valid base config (without sftp.enabled).
 * The sftp section is omitted so applyDefaults can fill it in.
 */
const baseConfigWithoutSftpEnabledArb = projectNameArb.map((name: string) => ({
  projectName: name,
  sftp: {
    protocols: ['SFTP'],
  },
}));

/**
 * Arbitrary: generates a full valid TransferPortalConfig object for validation.
 */
const validConfigArb = fc
  .tuple(projectNameArb, validProtocolsArb, fc.boolean())
  .map(([name, protocols, enabled]) => ({
    projectName: name,
    storage: {},
    sftp: {
      enabled,
      protocols,
    },
  })) as fc.Arbitrary<TransferPortalConfig>;


/**
 * Arbitrary: generates a non-boolean value (string, number, object, array, null).
 */
const nonBooleanArb = fc.oneof(
  fc.string({ minLength: 0, maxLength: 20 }),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.constant(null),
  fc.array(fc.anything(), { maxLength: 3 }),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), fc.string({ maxLength: 10 })),
);

/**
 * Arbitrary: generates arbitrary strings for sftp sub-fields when disabled.
 */
const arbitrarySftpFieldsArb = fc.record({
  protocols: fc.oneof(
    fc.constant(undefined),
    fc.constant([]),
    fc.array(fc.string({ maxLength: 10 }), { maxLength: 3 }),
  ),
  customDomain: fc.oneof(fc.constant(undefined), fc.string({ maxLength: 30 })),
  certificateArn: fc.oneof(fc.constant(undefined), fc.string({ maxLength: 50 })),
});

// ---------------------------------------------------------------------------
// Property 1: Config default — sftp.enabled defaults to true
// ---------------------------------------------------------------------------
describe('Feature: sftp-toggle, Property 1: Config default — sftp.enabled defaults to true', () => {
  /**
   * **Validates: Requirements 1.1**
   *
   * For any valid config YAML that omits the sftp.enabled field, loading it
   * through ConfigLoader and applying defaults SHALL produce a config object
   * where sftp.enabled is true.
   */
  it('should default sftp.enabled to true when the field is omitted', () => {
    fc.assert(
      fc.property(baseConfigWithoutSftpEnabledArb, (rawConfig: Record<string, any>) => {
        const loaded = loadFromYaml(rawConfig);
        expect(loaded.sftp.enabled).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Enabled config requires protocols
// ---------------------------------------------------------------------------
describe('Feature: sftp-toggle, Property 2: Enabled requires protocols', () => {
  /**
   * **Validates: Requirements 1.2**
   *
   * For any config with sftp.enabled set to true and sftp.protocols set to an
   * empty array or omitted, validating through ConfigLoader SHALL produce at
   * least one validation error referencing sftp.protocols.
   */
  it('should produce a validation error for sftp.protocols when enabled with empty/missing protocols', () => {
    const emptyOrMissingProtocolsArb = fc.oneof(
      fc.constant([] as string[]),
      fc.constant(undefined as unknown as string[]),
    );

    fc.assert(
      fc.property(projectNameArb, emptyOrMissingProtocolsArb, (name: string, protocols: any) => {
        const config: TransferPortalConfig = {
          projectName: name,
          storage: {},
          sftp: {
            enabled: true,
            protocols: protocols as any,
          },
        };

        const errors = ConfigLoader.validate(config);
        const protocolErrors = errors.filter((e) => e.field === 'sftp.protocols');
        expect(protocolErrors.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Disabled config skips SFTP validation
// ---------------------------------------------------------------------------
describe('Feature: sftp-toggle, Property 3: Disabled skips SFTP validation', () => {
  /**
   * **Validates: Requirements 1.3**
   *
   * For any config with sftp.enabled set to false and arbitrary values for
   * sftp.protocols, sftp.customDomain, and sftp.certificateArn, validating
   * through ConfigLoader SHALL produce zero validation errors for those
   * SFTP-specific fields.
   */
  it('should produce zero SFTP-specific validation errors when sftp.enabled is false', () => {
    fc.assert(
      fc.property(projectNameArb, arbitrarySftpFieldsArb, (name: string, sftpFields: any) => {
        const config = {
          projectName: name,
          storage: {},
          sftp: {
            enabled: false,
            protocols: sftpFields.protocols ?? [],
            customDomain: sftpFields.customDomain,
            certificateArn: sftpFields.certificateArn,
          },
        } as TransferPortalConfig;

        const errors = ConfigLoader.validate(config);
        const sftpFieldErrors = errors.filter(
          (e) =>
            e.field === 'sftp.protocols' ||
            e.field === 'sftp.customDomain' ||
            e.field === 'sftp.certificateArn',
        );
        expect(sftpFieldErrors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 4: Non-boolean sftp.enabled is rejected
// ---------------------------------------------------------------------------
describe('Feature: sftp-toggle, Property 4: Non-boolean rejected', () => {
  /**
   * **Validates: Requirements 1.4**
   *
   * For any config where sftp.enabled is set to a non-boolean value (string,
   * number, object, array), validating through ConfigLoader SHALL produce a
   * validation error for the sftp.enabled field.
   */
  it('should produce a validation error when sftp.enabled is a non-boolean value', () => {
    fc.assert(
      fc.property(projectNameArb, nonBooleanArb, (name: string, nonBoolVal: unknown) => {
        const config = {
          projectName: name,
          storage: {},
          sftp: {
            enabled: nonBoolVal as any,
            protocols: ['SFTP'],
          },
        } as TransferPortalConfig;

        const errors = ConfigLoader.validate(config);
        const enabledErrors = errors.filter((e) => e.field === 'sftp.enabled');
        expect(enabledErrors.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: Config sftp.enabled round-trip
// ---------------------------------------------------------------------------
describe('Feature: sftp-toggle, Property 8: Config round-trip', () => {
  /**
   * **Validates: Requirements 7.1**
   *
   * For any valid config object with sftp.enabled set to either true or false,
   * serializing to YAML and loading back through ConfigLoader SHALL produce a
   * config whose sftp.enabled value equals the original.
   */
  it('should round-trip sftp.enabled through YAML serialization and ConfigLoader.load', () => {
    fc.assert(
      fc.property(
        projectNameArb,
        validProtocolsArb,
        fc.boolean(),
        (name: string, protocols: string[], enabled: boolean) => {
          const original = {
            projectName: name,
            sftp: {
              enabled,
              protocols,
            },
          };

          const loaded = loadFromYaml(original);
          expect(loaded.sftp.enabled).toBe(enabled);
        },
      ),
      { numRuns: 100 },
    );
  });
});
